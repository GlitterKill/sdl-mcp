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

export async function handleSymbolSearch(
  args: unknown,
): Promise<SymbolSearchResponse> {
  const startedAt = Date.now();
  const request = args as SymbolSearchRequest;
  const limit = request.limit ?? SYMBOL_SEARCH_DEFAULT_LIMIT;
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
      rows = await searchSymbolsWithOverlay(conn, request.repoId, request.query, limit);
    }
  } else {
    // --- LEGACY PATH: lexical search + optional semantic reranking ---
    rows = await searchSymbolsWithOverlay(conn, request.repoId, request.query, limit);
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

  const response: SymbolSearchResponse = { results, symbols: results };
  if (request.includeRetrievalEvidence) {
    if (useHybrid && retrievalEvidence) {
      (response as Record<string, unknown>).retrievalEvidence = results.map((r) => ({
        symbolId: r.symbolId,
        retrievalSource: "hybrid" as const,
      }));
    } else if (fallbackReason) {
      (response as Record<string, unknown>).retrievalEvidence = results.map((r) => ({
        symbolId: r.symbolId,
        retrievalSource: "legacy" as const,
      }));
    }
  }
  attachRawContext(response, {
    fileIds: [...new Set(rows.map((row) => row.fileId))],
  });
  return response;
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
  if (symbol) {
    attachRawContext(response, { fileIds: [symbol.fileId] });
  }
  return response;
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
    attachRawContext(response, { fileIds });
    return response;
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
  attachRawContext(response, { fileIds });
  return response;
}
