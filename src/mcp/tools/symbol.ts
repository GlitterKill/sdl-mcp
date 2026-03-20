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
import type { SymbolKind } from "../../db/schema.js";
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
  getOverlaySnapshot,
  searchSymbolsWithOverlay,
} from "../../live-index/overlay-reader.js";
import { logger } from "../../util/logger.js";
import { rerankByEmbeddings } from "../../indexer/embeddings.js";
import { buildCardForSymbol } from "../../services/card-builder.js";
import { resolveSymbolId } from "../../util/resolve-symbol-id.js";
import {
  resolveSymbolRef,
  type SymbolRefResolution,
} from "../../util/resolve-symbol-ref.js";
import { DatabaseError, NotFoundError, ValidationError } from "../errors.js";

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
  const rows = await searchSymbolsWithOverlay(
    conn,
    request.repoId,
    request.query,
    limit,
  );

  let results = rows.map((row) => ({
    symbolId: row.symbolId,
    name: row.name,
    file: row.filePath,
    kind: row.kind as SymbolKind,
  }));

  // Semantic reranking: when requested, enabled in config, and embeddings exist
  let semanticEnabled = false;
  if (
    semanticRequested &&
    semanticConfig?.enabled === true &&
    rows.length > 0
  ) {
    try {
      const overlaySnapshot = getOverlaySnapshot(request.repoId);
      const symbolIds = rows.map((row) => row.symbolId);
      const symbolMap = await ladybugDb.getSymbolsByIds(conn, symbolIds);

      // Separate into rerank-able (found in durable DB from untouched files)
      // and non-rerank-able (overlay-only OR from overlay-touched files with stale durable data)
      const lexicalCandidates: {
        symbol: ladybugDb.SymbolRow;
        lexicalScore: number;
      }[] = [];
      const nonRerankableResults: typeof results = [];
      const rerankableSymbolIds = new Set<string>();

      rows.forEach((row, index) => {
        const symbol = symbolMap.get(row.symbolId);
        const isOverlayBacked = overlaySnapshot.touchedFileIds.has(row.fileId);
        if (symbol && !isOverlayBacked) {
          rerankableSymbolIds.add(row.symbolId);
          lexicalCandidates.push({
            symbol,
            lexicalScore: 1.0 - index / rows.length,
          });
        } else {
          // Overlay-backed or overlay-only symbols: preserve in original lexical order
          nonRerankableResults.push({
            symbolId: row.symbolId,
            name: row.name,
            file: row.filePath,
            kind: row.kind as SymbolKind,
          });
        }
      });

      if (lexicalCandidates.length > 0) {
        const alpha = semanticConfig?.alpha ?? 0.6;
        const provider = semanticConfig?.provider ?? "local";
        const model = semanticConfig?.model ?? "all-MiniLM-L6-v2";

        const reranked = await rerankByEmbeddings({
          query: request.query,
          symbols: lexicalCandidates,
          provider,
          alpha,
          model,
        });

        // Rebuild: reranked symbols first, then non-rerank-able in original order
        const filePathMap = new Map(
          rows.map((row) => [row.symbolId, row.filePath]),
        );
        const rerankedResults = reranked.map((item) => ({
          symbolId: item.symbol.symbolId,
          name: item.symbol.name,
          file: filePathMap.get(item.symbol.symbolId) ?? "",
          kind: item.symbol.kind as SymbolKind,
        }));
        const nonRerankableById = new Map(
          nonRerankableResults.map((row) => [row.symbolId, row]),
        );

        // Reranked symbols first (in semantic relevance order),
        // then non-rerankable symbols (in original lexical order)
        const mergedResults: typeof results = [
          ...rerankedResults,
          ...rows
            .filter((row) => !rerankableSymbolIds.has(row.symbolId))
            .map((row) => nonRerankableById.get(row.symbolId))
            .filter((r): r is NonNullable<typeof r> => r != null),
        ];

        results = mergedResults.slice(0, limit);
        semanticEnabled = true;
      }
    } catch (error) {
      // Graceful degradation: if semantic reranking fails, return lexical results
      logger.warn(
        `Semantic reranking failed, returning lexical results: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
  });

  const response = { results };
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
