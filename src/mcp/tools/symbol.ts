import {
  type SymbolSearchRequest,
  SymbolSearchResponse,
  type SymbolGetCardRequest,
  SymbolGetCardResponse,
  type SymbolGetCardsRequest,
  SymbolGetCardsResponse,
  type SymbolRef,
} from "../tools.js";
import { SYMBOL_SEARCH_DEFAULT_LIMIT } from "../../config/constants.js";
import type { SymbolKind } from "../../domain/types.js";
import type { NotModifiedResponse } from "../types.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import {
  consumePrefetchedKey,
  prefetchCardsForSymbols,
  prefetchSliceFrontier,
} from "../../graph/prefetch.js";
import { recordToolTrace } from "../../graph/prefetch-model.js";
import { loadConfig } from "../../config/loadConfig.js";
import { logSemanticSearchTelemetry } from "../telemetry.js";
import { attachRawContext } from "../token-usage.js";
import {
  searchSymbolsWithOverlay,
  searchSymbolsHybridWithOverlay,
} from "../../live-index/overlay-reader.js";
import { checkRetrievalHealth, shouldFallbackToLegacy } from "../../retrieval/index.js";
import type { RetrievalEvidence } from "../../retrieval/types.js";
import { logger } from "../../util/logger.js";
import { buildCardForSymbol } from "../../services/card-builder.js";
import { resolveSymbolId } from "../../util/resolve-symbol-id.js";
import {
  resolveSymbolRef,
  type SymbolRefResolution,
} from "../../util/resolve-symbol-ref.js";
import { DatabaseError, NotFoundError, ValidationError } from "../errors.js";

/**
 * Sort search results by exact match priority: exact name > starts-with > other.
 * Exported for testability.
 */
export function sortByExactMatch<T extends { name: string }>(
  results: T[],
  query: string,
): T[] {
  const queryLower = query.toLowerCase();
  return [...results].sort((a, b) => {
    const aExact = a.name.toLowerCase() === queryLower ? 1 : 0;
    const bExact = b.name.toLowerCase() === queryLower ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    // Secondary: prefer starts-with matches
    const aPrefix = a.name.toLowerCase().startsWith(queryLower) ? 1 : 0;
    const bPrefix = b.name.toLowerCase().startsWith(queryLower) ? 1 : 0;
    return bPrefix - aPrefix;
  });
}

/**
 * Compute a relevance score (0-1) for how well a result name matches the query.
 * Used to filter out spurious fuzzy matches.
 */
function computeRelevance(name: string, query: string): number {
  const nl = name.toLowerCase();
  const ql = query.toLowerCase();
  if (nl === ql) return 1;
  // Support glob wildcards: build*Slice matches buildSlice, buildGraphSlice
  if (ql.includes("*") || ql.includes("?")) {
    const escaped = ql.replace(/[.+^{}()|[\]]/g, "\\" + "&");
    const pattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
    try {
      if (new RegExp("^" + pattern + "$", "i").test(nl)) return 0.9;
      if (new RegExp(pattern, "i").test(nl)) return 0.75;
    } catch { /* invalid pattern, fall through */ }
  }
  if (nl.startsWith(ql)) return 0.85;
  if (nl.includes(ql)) return 0.7;
  // CamelCase-aware: split both query and name into constituent parts
  const splitCamel = (s: string) => {
    // Improved: handles digit-embedded acronyms (E2E, B2B), uppercase runs, digits
    const words = s.match(/[A-Z]+\d+[A-Z]+(?=[A-Z][a-z]|[^a-zA-Z0-9]|$)|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+|[A-Z]+|\d+/g);
    return (words ?? [s]).map(w => w.toLowerCase()).filter(w => w.length >= 2);
  };
  const queryParts = splitCamel(query);
  const nameParts = splitCamel(name);
  if (queryParts.length >= 2 && nameParts.length >= 2) {
    const matchCount = queryParts.filter(qp => nameParts.some(np => np.includes(qp) || qp.includes(np))).length;
    if (matchCount === queryParts.length) return 0.8;
    if (matchCount > 0) return 0.3 + 0.3 * (matchCount / queryParts.length);
  }
  // Check if query words appear in the name (multi-word queries)
  const queryWords = ql.split(/[\s_]+/).filter(w => w.length >= 3);
  if (queryWords.length > 1) {
    const matchCount = queryWords.filter(w => nl.includes(w)).length;
    if (matchCount > 0) return 0.3 + 0.3 * (matchCount / queryWords.length);
  }
  // Check if name appears in query
  if (nl.length >= 3 && ql.includes(nl)) return 0.5;
  // Weak: individual word overlap
  const nameWords = (nl.match(/[A-Z]+\d+[A-Z]+(?=[A-Z][a-z]|[^a-zA-Z0-9]|$)|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+|[A-Z]+|\d+/gi) ?? [nl]).map(w => w.toLowerCase()).filter(w => w.length >= 3);
  const overlap = nameWords.filter(w => ql.includes(w)).length;
  if (overlap > 0) return 0.1 + 0.15 * (overlap / Math.max(nameWords.length, 1));
  return 0.05;
}

const MIN_RELEVANCE_THRESHOLD = 0.15;

export async function handleSymbolSearch(
  args: unknown,
): Promise<SymbolSearchResponse> {
  const startedAt = Date.now();
  const request = args as SymbolSearchRequest;
  const requestedLimit = request.limit ?? SYMBOL_SEARCH_DEFAULT_LIMIT;
  const limit = (request.kinds && request.kinds.length > 0) ? requestedLimit * 10 : requestedLimit;
  const config = loadConfig();
  const semanticConfig = config.semantic;
  const semanticRequested = request.semantic === true;

  recordToolTrace({
    repoId: request.repoId,
    taskType: "search",
    tool: "symbol.search",
  });

  const conn = await getLadybugConn();

  const repo = await ladybugDb.getRepo(conn, request.repoId);
  if (!repo) {
    throw new NotFoundError(`Repository not found: ${request.repoId}`);
  }

  // Determine retrieval mode
  const retrievalConfig = semanticConfig?.retrieval;
  let useHybrid = false;
  let retrievalEvidence: RetrievalEvidence | undefined;
  let fallbackReason: string | undefined;

  if (
    semanticRequested &&
    semanticConfig?.enabled === true &&
    retrievalConfig?.mode === "hybrid"
  ) {
    try {
      // NOTE: checkRetrievalHealth is also called inside hybridSearch().
      // A future optimisation could pass pre-resolved caps via options.
      const caps = await checkRetrievalHealth(request.repoId);
      if (!shouldFallbackToLegacy(caps, retrievalConfig)) {
        useHybrid = true;
      } else {
        fallbackReason = !caps.fts
          ? "FTS extension unavailable"
          : "Retrieval health check failed";
      }
    } catch (err) {
      fallbackReason = `Health check error: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn(`[symbol.search] Hybrid health check failed, using legacy: ${fallbackReason}`);
    }
  }

  let rows: Awaited<ReturnType<typeof searchSymbolsWithOverlay>>;
  let semanticEnabled = false;

  if (useHybrid) {
    // --- HYBRID PATH: FTS + vector + RRF fusion for durable, lexical for overlay ---
    try {
      const { rows: hybridRows, evidence } = await searchSymbolsHybridWithOverlay(
        conn,
        request.repoId,
        request.query,
        limit,
        {
          ftsTopK: retrievalConfig?.fts?.topK,
          vectorTopK: retrievalConfig?.vector?.topK,
          rrfK: retrievalConfig?.fusion?.rrfK,
          candidateLimit: retrievalConfig?.candidateLimit,
          includeEvidence: request.includeRetrievalEvidence === true,
        },
      );
      rows = hybridRows;
      retrievalEvidence = evidence;
      semanticEnabled = true;
    } catch (err) {
      // Graceful degradation: fall back to legacy search
      logger.warn(
        `[symbol.search] Hybrid search failed, falling back to legacy: ${err instanceof Error ? err.message : String(err)}`,
      );
      fallbackReason = `Hybrid search error: ${err instanceof Error ? err.message : String(err)}`;
      rows = await searchSymbolsWithOverlay(conn, request.repoId, request.query, limit, request.kinds);
    }
  } else {
    // --- LEGACY PATH: lexical search + optional semantic reranking ---
    rows = await searchSymbolsWithOverlay(conn, request.repoId, request.query, limit, request.kinds);
  }

  let results = rows.map((row) => ({
    symbolId: row.symbolId,
    name: row.name,
    file: row.filePath,
    kind: row.kind as SymbolKind,
  }));

  // Prioritize exact name matches over fuzzy/partial matches
  results = sortByExactMatch(results, request.query);

  // Filter by kinds if specified (after semantic reranking, so it applies to both paths)
  if (request.kinds && request.kinds.length > 0) {
    const kindsSet = new Set(request.kinds);
    results = results.filter((r) => kindsSet.has(r.kind));
    // Trim back to requested limit after kind filtering
    results = results.slice(0, requestedLimit);
  }

  // Prefetch cards for top search results (anticipating getCard calls)
  const topSymbolIds = results.slice(0, 5).map((r) => r.symbolId);
  if (topSymbolIds.length > 0) {
    prefetchCardsForSymbols(request.repoId, topSymbolIds);
  }

  logSemanticSearchTelemetry({
    repoId: request.repoId,
    semanticEnabled,
    latencyMs: Date.now() - startedAt,
    candidateCount: rows.length,
    alpha: semanticConfig?.alpha ?? 0.6,
    retrievalMode: useHybrid ? "hybrid" : "legacy",
    retrievalType: useHybrid
      ? "hybrid"
      : semanticEnabled
        ? "legacy-rerank"
        : "lexical-only",
    ...(retrievalEvidence?.candidateCountPerSource && {
      candidateCountPerSource: retrievalEvidence.candidateCountPerSource,
    }),
    ...(retrievalEvidence?.fusionLatencyMs != null && {
      fusionLatencyMs: retrievalEvidence.fusionLatencyMs,
    }),
    ...(fallbackReason && { fallbackReason }),
    finalResultCount: results.length,
    ...(semanticRequested && retrievalConfig?.mode === "hybrid" && {
      ftsAvailable: retrievalEvidence?.sources?.includes("fts") ?? false,
      vectorAvailable: (retrievalEvidence?.sources?.some((s) => s.startsWith("vector:")) ?? false),
    }),
  });

  // FP2: Add relevance scoring and filter out spurious matches
  const scoredResults = results.map(r => ({
    ...r,
    relevance: Math.round(computeRelevance(r.name, request.query) * 100) / 100,
  }));
  const relevant = scoredResults.filter(r => r.relevance >= MIN_RELEVANCE_THRESHOLD);
  const hasExactMatch = relevant.some(r => r.name.toLowerCase() === request.query.toLowerCase());
  // symbols alias removed — use results (symbols was an exact duplicate wasting tokens)
  const response: SymbolSearchResponse = { results: relevant, exactMatchFound: hasExactMatch };
  if (request.includeRetrievalEvidence) {
    if (useHybrid && retrievalEvidence) {
      (response as Record<string, unknown>).retrievalEvidence = relevant.map((r) => ({
        symbolId: r.symbolId,
        retrievalSource: "hybrid" as const,
      }));
    } else if (fallbackReason) {
      (response as Record<string, unknown>).retrievalEvidence = relevant.map((r) => ({
        symbolId: r.symbolId,
        retrievalSource: "legacy" as const,
      }));
    }
  }
  return attachRawContext(response, {
    fileIds: [...new Set(rows.map((row) => row.fileId))],
  });
}

interface SymbolResolutionFailure {
  input: string;
  message: string;
  code: string;
  classification: string;
  retryable: boolean;
  fallbackTools: string[];
  fallbackRationale?: string;
  candidates: Array<Record<string, unknown>>;
}

async function resolveRequestedSymbolId(
  conn: Awaited<ReturnType<typeof getLadybugConn>>,
  request: SymbolGetCardRequest,
): Promise<string> {
  if (request.symbolId) {
    const { symbolId } = await resolveSymbolId(conn, request.repoId, request.symbolId);
    return symbolId;
  }

  if (!request.symbolRef) {
    const error = new ValidationError("Provide exactly one of symbolId or symbolRef.");
    throw Object.assign(error, {
      classification: "invalid_input",
      retryable: false,
    });
  }

  const resolution = await resolveSymbolRef(conn, request.repoId, request.symbolRef);
  if (resolution.status === "resolved") {
    return resolution.symbolId;
  }

  throw createSymbolResolutionError(resolution);
}

function createSymbolResolutionError(
  resolution: Exclude<SymbolRefResolution, { status: "resolved" }>,
): Error {
  const fallbackTools = ["sdl.symbol.search", "sdl.action.search"];
  const candidatePayload = resolution.candidates.map((candidate) => ({
    symbolId: candidate.symbolId,
    name: candidate.name,
    file: candidate.file,
    kind: candidate.kind,
    score: candidate.score,
  }));

  if (resolution.status === "ambiguous") {
    const error = new ValidationError(resolution.message);
    return Object.assign(error, {
      classification: "ambiguous_input",
      retryable: false,
      fallbackTools,
      fallbackRationale: "Use sdl.symbol.search or provide file/kind hints to disambiguate.",
      candidates: candidatePayload,
    });
  }

  const error = new NotFoundError(resolution.message);
  return Object.assign(error, {
    classification: "not_found",
    retryable: false,
    fallbackTools,
    fallbackRationale: "Use sdl.symbol.search to discover the canonical symbol identifier.",
    candidates: candidatePayload,
  });
}

function toBatchFailure(
  symbolRef: SymbolRef,
  error: Error,
): SymbolResolutionFailure {
  const detail = error as {
    code?: string;
    classification?: string;
    retryable?: boolean;
    fallbackTools?: string[];
    fallbackRationale?: string;
    candidates?: Array<Record<string, unknown>>;
  };
  return {
    input: symbolRef.name,
    message: error.message,
    code: detail.code ?? "NOT_FOUND",
    classification: detail.classification ?? "not_found",
    retryable: detail.retryable ?? false,
    fallbackTools: detail.fallbackTools ?? ["sdl.symbol.search"],
    fallbackRationale: detail.fallbackRationale,
    candidates: detail.candidates ?? [],
  };
}

async function buildCardsForSymbolIds(
  conn: Awaited<ReturnType<typeof getLadybugConn>>,
  input: {
    repoId: string;
    symbolIds: string[];
    knownEtags?: Record<string, string>;
    minCallConfidence?: number;
    includeResolutionMetadata?: boolean;
  },
): Promise<{
  cards: Awaited<ReturnType<typeof buildCardForSymbol>>[];
  symbolMap: Map<string, ladybugDb.SymbolRow>;
}> {
  for (const symbolId of input.symbolIds) {
    consumePrefetchedKey(input.repoId, `card:${symbolId}`);
  }

  const symbolMap = await ladybugDb.getSymbolsByIds(conn, input.symbolIds);
  for (const symbolId of input.symbolIds) {
    const symbol = symbolMap.get(symbolId) ?? await ladybugDb.getSymbol(conn, symbolId);
    if (symbol && symbol.repoId !== input.repoId) {
      throw new DatabaseError(
        `Symbol ${symbolId} belongs to repo "${symbol.repoId}", not "${input.repoId}"`,
      );
    }
  }

  const BATCH_SIZE = 10;
  const cards: Awaited<ReturnType<typeof buildCardForSymbol>>[] = [];
  for (let i = 0; i < input.symbolIds.length; i += BATCH_SIZE) {
    const batch = input.symbolIds.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((id) =>
        buildCardForSymbol(input.repoId, id, input.knownEtags?.[id], {
          minCallConfidence: input.minCallConfidence,
          includeResolutionMetadata: input.includeResolutionMetadata,
        }),
      ),
    );
    cards.push(...batchResults);
  }

  return { cards, symbolMap };
}

export async function handleSymbolGetCard(
  args: unknown,
): Promise<SymbolGetCardResponse | NotModifiedResponse> {
  const request = args as SymbolGetCardRequest;
  const conn = await getLadybugConn();

  const repo = await ladybugDb.getRepo(conn, request.repoId);
  if (!repo) {
    throw new NotFoundError(`Repository not found: ${request.repoId}`);
  }

  const {
    repoId,
    ifNoneMatch,
    minCallConfidence,
    includeResolutionMetadata,
  } = request;
  const symbolId = await resolveRequestedSymbolId(conn, request);

  recordToolTrace({
    repoId,
    taskType: "card",
    tool: "symbol.getCard",
    symbolId,
  });
  consumePrefetchedKey(repoId, `card:${symbolId}`);

  const result = await buildCardForSymbol(repoId, symbolId, ifNoneMatch, {
    minCallConfidence,
    includeResolutionMetadata,
  });
  if ("notModified" in result) {
    return result;
  }

  // Prefetch edge targets for anticipated slice.build
  prefetchSliceFrontier(repoId, [symbolId]);

  const response = { card: result };
  const symbol = await ladybugDb.getSymbol(conn, symbolId);
  return symbol
    ? attachRawContext(response, { fileIds: [symbol.fileId] })
    : response;
}

export async function handleSymbolGetCards(
  args: unknown,
): Promise<SymbolGetCardsResponse> {
  const {
    repoId,
    symbolIds,
    symbolRefs,
    knownEtags,
    minCallConfidence,
    includeResolutionMetadata,
  } = args as SymbolGetCardsRequest;
  const conn = await getLadybugConn();

  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new NotFoundError(`Repository not found: ${repoId}`);
  }

  if (symbolIds) {
    const { cards, symbolMap } = await buildCardsForSymbolIds(conn, {
      repoId,
      symbolIds,
      knownEtags,
      minCallConfidence,
      includeResolutionMetadata,
    });
    const fileIds = [...new Set(Array.from(symbolMap.values()).map((symbol) => symbol.fileId))];
    const response = { cards };
    return attachRawContext(response, { fileIds });
  }

  const resolvedSymbolIds: string[] = [];
  const failures: SymbolResolutionFailure[] = [];
  for (const symbolRef of symbolRefs ?? []) {
    const resolution = await resolveSymbolRef(conn, repoId, symbolRef);
    if (resolution.status === "resolved") {
      resolvedSymbolIds.push(resolution.symbolId);
      continue;
    }

    failures.push(toBatchFailure(symbolRef, createSymbolResolutionError(resolution)));
  }

  let cards: Awaited<ReturnType<typeof buildCardForSymbol>>[] = [];
  let fileIds: string[] = [];
  if (resolvedSymbolIds.length > 0) {
    const built = await buildCardsForSymbolIds(conn, {
      repoId,
      symbolIds: resolvedSymbolIds,
      knownEtags,
      minCallConfidence,
      includeResolutionMetadata,
    });

    cards = built.cards;
    fileIds = [...new Set(Array.from(built.symbolMap.values()).map((symbol) => symbol.fileId))];
  }

  const response: SymbolGetCardsResponse = { cards };
  if (failures.length > 0) {
    response.partial = resolvedSymbolIds.length > 0;
    response.succeeded = resolvedSymbolIds;
    response.failed = failures.map((failure) => failure.input);
    response.failures = failures;
  }
  return attachRawContext(response, { fileIds });
}
