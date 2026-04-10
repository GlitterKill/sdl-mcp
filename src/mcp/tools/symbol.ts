import {
  type SymbolSearchRequest,
  SymbolSearchResponse,
  type SymbolGetCardRequest,
  SymbolGetCardRequestSchema,
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
import {
  checkRetrievalHealth,
  shouldFallbackToLegacy,
} from "../../retrieval/index.js";
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
    if (aPrefix !== bPrefix) return bPrefix - aPrefix;
    // Tiebreaker: prefer source files over test/fixture files
    const aFile = (a as Record<string, unknown>).file as string | undefined;
    const bFile = (b as Record<string, unknown>).file as string | undefined;
    const sourceScore = (f: string | undefined) => {
      if (!f) return 0;
      if (f.startsWith("tests/fixtures/")) return -2;
      if (f.startsWith("tests/")) return -1;
      if (f.startsWith("src/")) return 1;
      return 0;
    };
    return sourceScore(bFile) - sourceScore(aFile);
  });
}

/** Common stop words filtered from search suggestions to improve quality. */
const SUGGESTION_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "not",
  "no",
  "nor",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "for",
  "from",
  "to",
  "in",
  "on",
  "at",
  "by",
  "of",
  "with",
  "as",
  "get",
  "set",
]);

/**
 * `splitCamelSubwords` and `computeRelevance` were moved to
 * `src/util/symbol-relevance.ts` to break a circular import with
 * `src/util/resolve-symbol-ref.ts`. They are still imported here so the rest
 * of this file can use them locally, and re-exported so existing consumers
 * (including `dist/mcp/tools/symbol.js` test imports) keep working unchanged.
 */
import {
  splitCamelSubwords,
  computeRelevance,
} from "../../util/symbol-relevance.js";
export { splitCamelSubwords, computeRelevance };

const MIN_RELEVANCE_THRESHOLD = 0.3;

export async function handleSymbolSearch(
  args: unknown,
): Promise<SymbolSearchResponse> {
  const startedAt = Date.now();
  const request = args as SymbolSearchRequest;
  const requestedLimit = request.limit ?? SYMBOL_SEARCH_DEFAULT_LIMIT;
  const limit =
    request.kinds && request.kinds.length > 0
      ? requestedLimit * 10
      : requestedLimit;
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
        fallbackReason = caps.degradationReasons
          ?.map((r) => r.message)
          .join("; ") ?? (!caps.fts
          ? "FTS extension unavailable"
          : "Retrieval health check failed");
      }
    } catch (err) {
      fallbackReason = `Health check error: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn(
        `[symbol.search] Hybrid health check failed, using legacy: ${fallbackReason}`,
      );
    }
  }

  let rows: Awaited<ReturnType<typeof searchSymbolsWithOverlay>>;
  let semanticEnabled = false;

  if (useHybrid) {
    // --- HYBRID PATH: FTS + vector + RRF fusion for durable, lexical for overlay ---
    try {
      const { rows: hybridRows, evidence } =
        await searchSymbolsHybridWithOverlay(
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
      rows = await searchSymbolsWithOverlay(
        conn,
        request.repoId,
        request.query,
        limit,
        request.kinds,
        request.excludeExternal,
      );
    }
  } else {
    // --- LEGACY PATH: lexical search + optional semantic reranking ---
    rows = await searchSymbolsWithOverlay(
      conn,
      request.repoId,
      request.query,
      limit,
      request.kinds,
      request.excludeExternal,
    );
  }

  let results = rows.map((row) => ({
    symbolId: row.symbolId,
    name: row.name,
    file: row.filePath,
    kind: row.kind as SymbolKind,
  }));

  // Prioritize exact name matches over fuzzy/partial matches
  // CamelCase fallback: when no results and query is a camelCase compound,
  // decompose into subwords and re-search with joined terms (multi-term query)
  let camelFallbackUsed = false;
  let camelFallbackTerms: string[] = [];
  if (
    results.length === 0 &&
    !request.query.includes("*") &&
    !request.query.includes("?")
  ) {
    const subwords = splitCamelSubwords(request.query);
    if (subwords.length >= 2) {
      camelFallbackTerms = subwords;
      const joinedQuery = subwords.join(" ");
      const fallbackRows = await searchSymbolsWithOverlay(
        conn,
        request.repoId,
        joinedQuery,
        limit,
        request.kinds,
        request.excludeExternal,
      );
      const existingIds = new Set(results.map((r) => r.symbolId));
      for (const row of fallbackRows) {
        if (!existingIds.has(row.symbolId)) {
          results.push({
            symbolId: row.symbolId,
            name: row.name,
            file: row.filePath,
            kind: row.kind as SymbolKind,
          });
          existingIds.add(row.symbolId);
        }
      }
      // If joined multi-term query still found nothing, try individual subwords
      // e.g. "buildGraphSlice" → joined "build graph slice" matches nothing,
      // but "build*" finds buildSlice, "slice*" finds sliceBuild, etc.
      if (results.length === 0) {
        const significantSubwords = subwords.filter((w) => w.length >= 3);
        if (significantSubwords.length > 0) {
          const perTermLimit = Math.max(
            3,
            Math.ceil(limit / significantSubwords.length),
          );
          for (const subword of significantSubwords) {
            const subRows = await searchSymbolsWithOverlay(
              conn,
              request.repoId,
              subword + "*",
              perTermLimit,
              request.kinds,
              request.excludeExternal,
            );
            for (const row of subRows) {
              if (!existingIds.has(row.symbolId)) {
                results.push({
                  symbolId: row.symbolId,
                  name: row.name,
                  file: row.filePath,
                  kind: row.kind as SymbolKind,
                });
                existingIds.add(row.symbolId);
              }
            }
          }
        }
      }
      if (results.length > requestedLimit)
        results = results.slice(0, requestedLimit);
      if (results.length > 0) {
        camelFallbackUsed = true;
      }
    }
  }

  results = sortByExactMatch(results, request.query);

  // FP-5: For wildcard queries or when no exact match, sort by importance metrics
  // This ensures "*" queries return the most important symbols rather than arbitrary order
  const isWildcard =
    request.query === "*" ||
    request.query.includes("*") ||
    request.query.includes("?");
  if (isWildcard && results.length > 1) {
    // Fetch metrics for top results to sort by importance
    const topIds = results
      .slice(0, Math.min(results.length, 100))
      .map((r) => r.symbolId);
    try {
      const metrics = await ladybugDb.getMetricsBySymbolIds(conn, topIds);
      const symbols = await ladybugDb.getSymbolsByIds(conn, topIds);
      results.sort((a, b) => {
        const aMetrics = metrics.get(a.symbolId);
        const bMetrics = metrics.get(b.symbolId);
        const aSym = symbols.get(a.symbolId);
        const bSym = symbols.get(b.symbolId);
        // Exported symbols first
        const aExported = aSym?.exported ? 1 : 0;
        const bExported = bSym?.exported ? 1 : 0;
        if (aExported !== bExported) return bExported - aExported;
        // Then by fan-in (higher = more important)
        const aFanIn = aMetrics?.fanIn ?? 0;
        const bFanIn = bMetrics?.fanIn ?? 0;
        if (aFanIn !== bFanIn) return bFanIn - aFanIn;
        // Then by test coverage
        const aTests = aMetrics?.churn30d ?? 0;
        const bTests = bMetrics?.churn30d ?? 0;
        return bTests - aTests;
      });
    } catch (sortErr) {
      // Graceful degradation: keep original order if metrics unavailable
      logger.debug(
        "wildcard sort: metrics fetch failed, keeping original order",
        {
          repoId: request.repoId,
          error: sortErr instanceof Error ? sortErr.message : String(sortErr),
        },
      );
    }
  }

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
    ...(semanticRequested &&
      retrievalConfig?.mode === "hybrid" && {
        ftsAvailable: retrievalEvidence?.sources?.includes("fts") ?? false,
        vectorAvailable:
          retrievalEvidence?.sources?.some((s) => s.startsWith("vector:")) ??
          false,
      }),
  });

  // FP2: Add relevance scoring and filter out spurious matches
  const scoredResults = results.map((r, idx) => ({
    ...r,
    relevance:
      Math.round(
        Math.min(
          1,
          computeRelevance(r.name, request.query) +
            // Boost semantic results: top-ranked results from semantic search
            // are likely relevant even if the name doesn't match the query text
            (request.semantic && semanticEnabled
              ? Math.max(0, 0.3 * (1 - idx / Math.max(results.length, 1)))
              : 0),
        ) * 100,
      ) / 100,
  }));
  // Apply a higher relevance floor for explicit semantic search to
  // prevent very low-scoring results from polluting the output.
  const effectiveThreshold = semanticEnabled && semanticRequested
    ? Math.max(MIN_RELEVANCE_THRESHOLD, 0.4)
    : MIN_RELEVANCE_THRESHOLD;
  const relevant = scoredResults.filter(
    (r) => r.relevance >= effectiveThreshold,
  );
  const hasExactMatch = relevant.some(
    (r) => r.name.toLowerCase() === request.query.toLowerCase(),
  );
  // symbols alias removed — use results (symbols was an exact duplicate wasting tokens)
  // Add suggestion when no relevant results or all results are weak
  const bestRelevance =
    relevant.length > 0 ? Math.max(...relevant.map((r) => r.relevance)) : 0;
  const suggestion =
    relevant.length === 0
      ? semanticRequested && !semanticEnabled
        ? `Semantic search unavailable (${fallbackReason || "embedding model not loaded"}). Lexical search returned no matches. Try exact symbol names or broader terms.`
        : (() => {
            const tokens = splitCamelSubwords(request.query).filter(
              (t) => t.length >= 3 && !SUGGESTION_STOP_WORDS.has(t),
            );
            return tokens.length >= 2
              ? `No close matches found. Try individual terms: ${tokens.map((t) => `"${t}"`).join(", ")}`
              : tokens.length === 1
                ? `No close matches found. Try: "${tokens[0]}" or use a wildcard like "${tokens[0]}*".`
                : "No close matches found. Try broader terms or use kinds filter.";
          })()
      : camelFallbackUsed
        ? `No exact match for '${request.query}'. Showing results for decomposed terms: ${camelFallbackTerms.join(", ")}`
        : bestRelevance < 0.5
          ? "Results may not be relevant. Try more specific terms, use kinds filter, or try sdl.symbol.search with a wildcard pattern."
          : undefined;
  const response: SymbolSearchResponse = {
    results: relevant,
    exactMatchFound: hasExactMatch,
    ...(suggestion !== undefined && { suggestion }),
  };
  if (request.includeRetrievalEvidence) {
    if (useHybrid && retrievalEvidence) {
      (response as Record<string, unknown>).retrievalEvidence = relevant.map(
        (r) => ({
          symbolId: r.symbolId,
          retrievalSource: "hybrid" as const,
        }),
      );
    } else if (fallbackReason) {
      (response as Record<string, unknown>).retrievalEvidence = relevant.map(
        (r) => ({
          symbolId: r.symbolId,
          retrievalSource: "legacy" as const,
        }),
      );
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
    const { symbolId } = await resolveSymbolId(
      conn,
      request.repoId,
      request.symbolId,
    );
    return symbolId;
  }

  if (!request.symbolRef) {
    const error = new ValidationError(
      "Provide exactly one of symbolId or symbolRef.",
    );
    throw Object.assign(error, {
      classification: "invalid_input",
      retryable: false,
    });
  }

  const resolution = await resolveSymbolRef(
    conn,
    request.repoId,
    request.symbolRef,
  );
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
      fallbackRationale:
        "Use sdl.symbol.search or provide file/kind hints to disambiguate.",
      candidates: candidatePayload,
    });
  }

  const error = new NotFoundError(resolution.message);
  return Object.assign(error, {
    classification: "not_found",
    retryable: false,
    fallbackTools,
    fallbackRationale:
      "Use sdl.symbol.search to discover the canonical symbol identifier.",
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
    includeProcesses?: boolean;
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
    const symbol =
      symbolMap.get(symbolId) ?? (await ladybugDb.getSymbol(conn, symbolId));
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
          // MCP callers must opt in explicitly; undefined collapses to false
          includeProcesses: input.includeProcesses === true,
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
  const request = SymbolGetCardRequestSchema.parse(args);
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
    includeProcesses,
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
    // MCP callers must opt in explicitly; undefined collapses to false
    includeProcesses: includeProcesses === true,
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
    const fileIds = [
      ...new Set(Array.from(symbolMap.values()).map((symbol) => symbol.fileId)),
    ];
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

    failures.push(
      toBatchFailure(symbolRef, createSymbolResolutionError(resolution)),
    );
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
    fileIds = [
      ...new Set(
        Array.from(built.symbolMap.values()).map((symbol) => symbol.fileId),
      ),
    ];
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
