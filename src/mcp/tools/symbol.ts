import {
  SymbolSearchRequestSchema,
  SymbolSearchResponse,
  SymbolGetCardRequestSchema,
  SymbolGetCardResponse,
  SymbolGetCardsRequestSchema,
  SymbolGetCardsResponse,
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

export async function handleSymbolSearch(
  args: unknown,
): Promise<SymbolSearchResponse> {
  const startedAt = Date.now();
  const request = SymbolSearchRequestSchema.parse(args);
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
        const mergedResults: typeof results = [];
        let rerankedIndex = 0;
        for (const row of rows) {
          if (rerankableSymbolIds.has(row.symbolId)) {
            const rerankedRow = rerankedResults[rerankedIndex];
            rerankedIndex += 1;
            if (rerankedRow) {
              mergedResults.push(rerankedRow);
            }
            continue;
          }
          const nonRerankableRow = nonRerankableById.get(row.symbolId);
          if (nonRerankableRow) {
            mergedResults.push(nonRerankableRow);
          }
        }

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

export async function handleSymbolGetCard(
  args: unknown,
): Promise<SymbolGetCardResponse | NotModifiedResponse> {
  const request = SymbolGetCardRequestSchema.parse(args);
  const {
    repoId,
    symbolId,
    ifNoneMatch,
    minCallConfidence,
    includeResolutionMetadata,
  } = request;

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
  const conn = await getLadybugConn();
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
    knownEtags,
    minCallConfidence,
    includeResolutionMetadata,
  } = SymbolGetCardsRequestSchema.parse(args);

  for (const symbolId of symbolIds) {
    consumePrefetchedKey(repoId, `card:${symbolId}`);
  }

  // Cap parallelism to avoid overwhelming DB with concurrent queries
  const BATCH_SIZE = 10;
  const cards: Awaited<ReturnType<typeof buildCardForSymbol>>[] = [];
  for (let i = 0; i < symbolIds.length; i += BATCH_SIZE) {
    const batch = symbolIds.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((id) =>
        buildCardForSymbol(repoId, id, knownEtags?.[id], {
          minCallConfidence,
          includeResolutionMetadata,
        }),
      ),
    );
    cards.push(...batchResults);
  }

  const conn = await getLadybugConn();
  const symbolMap = await ladybugDb.getSymbolsByIds(conn, symbolIds);
  const fileIds = [
    ...new Set(Array.from(symbolMap.values()).map((s) => s.fileId)),
  ];

  const response = { cards };
  attachRawContext(response, { fileIds });
  return response;
}
