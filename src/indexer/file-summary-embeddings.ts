import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_FILE_SUMMARY_EMBEDDING_BATCH_SIZE,
  DEFAULT_FILE_SUMMARY_EMBEDDING_MAX_CHARS,
  FILE_SUMMARY_VECTOR_REBUILD_MIN_ROWS,
  MAX_EMBEDDING_BATCH_SIZE,
  MAX_EMBEDDING_CONCURRENCY,
  MAX_FILE_SUMMARY_EMBEDDING_BATCH_SIZE,
  VECTOR_REBUILD_THRESHOLD,
} from "../config/constants.js";
import {
  getLadybugConn,
  runWalCheckpoint,
  withWriteConn,
} from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { IndexError } from "../domain/errors.js";
import {
  createVectorIndex,
  dropVectorIndex,
  FILESUMMARY_VECTOR_INDEX_NAMES,
} from "../retrieval/index-lifecycle.js";
import {
  EMBEDDING_MODELS,
  getVecPropertyName,
} from "../retrieval/model-mapping.js";
import { hashContent } from "../util/hashing.js";
import { logger } from "../util/logger.js";
import type { IndexProgress } from "./indexer.js";
import {
  getEmbeddingProvider,
  toFloat16Blob,
  type EmbeddingProvider,
} from "./embeddings.js";
import { applyDocumentPrefix } from "./model-registry.js";

export interface FileSummaryEmbeddingRefreshResult {
  embedded: number;
  skipped: number;
  missing: number;
  degraded: boolean;
  /**
   * Uncached rows intentionally left for a later rebuild cycle. Set only when
   * the HNSW rebuild debounce defers the write (see
   * FILE_SUMMARY_VECTOR_REBUILD_MIN_ROWS).
   */
  deferred?: number;
}

export async function refreshFileSummaryEmbeddings(params: {
  repoId: string;
  provider: "api" | "local" | "mock";
  model: string;
  fileIds?: string[];
  onProgress?: (progress: IndexProgress) => void;
  concurrency?: number;
  batchSize?: number;
  maxChars?: number;
  /**
   * Minimum uncached rows before the HNSW drop -> write -> create cycle runs.
   * Defaults to FILE_SUMMARY_VECTOR_REBUILD_MIN_ROWS; tests pass 1 to force
   * immediate rebuilds.
   */
  rebuildMinUncachedRows?: number;
  /** @internal Allows tests to exercise refresh semantics without ONNX files. */
  embeddingProvider?: EmbeddingProvider;
}): Promise<FileSummaryEmbeddingRefreshResult> {
  const provider =
    params.embeddingProvider ??
    getEmbeddingProvider(params.provider, params.model);
  const conn = await getLadybugConn();

  const summaries =
    params.fileIds && params.fileIds.length > 0
      ? [
          ...(
            await ladybugDb.getFileSummariesByFileIds(conn, params.fileIds)
          ).values(),
        ]
      : await ladybugDb.getFileSummariesForRepo(conn, params.repoId);

  const storageModel = params.model;
  if (!EMBEDDING_MODELS[storageModel]) {
    return {
      embedded: 0,
      skipped: 0,
      missing: summaries.length,
      degraded: true,
    };
  }

  if (provider.isMockFallback?.()) {
    return {
      embedded: 0,
      skipped: 0,
      missing: summaries.length,
      degraded: true,
    };
  }

  const inspectSummaries = (rows: typeof summaries) => {
    const candidates = rows.map((summary) => {
      const text = buildFileSummaryEmbeddingText(summary, params.maxChars);
      const hasPayload = text.trim().length > 0;
      const prefixedText = applyDocumentPrefix(storageModel, text);
      const cardHash = hashContent([summary.fileId, prefixedText].join("|"));
      const existingHash =
        storageModel === "jina-embeddings-v2-base-code"
          ? summary.embeddingJinaCodeCardHash
          : summary.embeddingNomicCardHash;
      return {
        summary,
        prefixedText,
        cardHash,
        cached: existingHash === cardHash,
        hasPayload,
      };
    });
    return {
      candidates,
      missingPayloads: candidates.filter((item) => !item.hasPayload).length,
      skipped: candidates.filter((item) => item.hasPayload && item.cached)
        .length,
      uncached: candidates
        .filter((item) => item.hasPayload && !item.cached)
        .sort((a, b) => a.prefixedText.length - b.prefixedText.length),
    };
  };

  const rebuildMinUncachedRows =
    params.rebuildMinUncachedRows ?? FILE_SUMMARY_VECTOR_REBUILD_MIN_ROWS;
  let assessment = inspectSummaries(summaries);

  // Small incremental scopes also inspect repository-wide hashes so rows
  // deferred by earlier runs accumulate toward the safe HNSW rebuild batch.
  if (
    params.fileIds &&
    params.fileIds.length > 0 &&
    assessment.uncached.length < rebuildMinUncachedRows
  ) {
    assessment = inspectSummaries(
      await ladybugDb.getFileSummariesForRepo(conn, params.repoId),
    );
  }

  const { candidates, missingPayloads, skipped, uncached } = assessment;

  if (uncached.length === 0) {
    return { embedded: 0, skipped, missing: missingPayloads, degraded: false };
  }

  const vecProp = getVecPropertyName(storageModel);
  const indexName = getFileSummaryVectorIndexName(storageModel);

  // Debounce the HNSW rebuild cycle. VECTOR_REBUILD_THRESHOLD is pinned to 0
  // (LADYBUG#377), so every write takes the drop -> bulk write -> create
  // path below; that native cycle silently crashed the server twice on
  // 2026-07-07 (see FILE_SUMMARY_VECTOR_REBUILD_MIN_ROWS in constants.ts).
  // Defer small refreshes until enough uncached rows accumulate. Full-scope
  // refreshes where nothing is cached yet (bootstrap / full
  // re-summarization) always rebuild so small repositories still get
  // vectors. Deferred rows stay hash-uncached in the DB, so a later refresh
  // naturally picks them up; FTS/searchText freshness is unaffected.
  const payloadBearing = candidates.filter((item) => item.hasPayload).length;
  const bootstrapRebuild =
    params.fileIds === undefined && uncached.length === payloadBearing;
  if (
    vecProp !== null &&
    indexName !== null &&
    uncached.length < rebuildMinUncachedRows &&
    !bootstrapRebuild
  ) {
    logger.info("[file-summary-embeddings] Vector rebuild deferred", {
      model: storageModel,
      uncached: uncached.length,
      threshold: rebuildMinUncachedRows,
    });
    params.onProgress?.({
      stage: "embeddings",
      substage: "fileSummaryEmbeddings",
      current: 0,
      total: uncached.length,
      model: storageModel,
      message: `${uncached.length} deferred`,
    });
    return {
      embedded: 0,
      skipped,
      missing: missingPayloads,
      degraded: false,
      deferred: uncached.length,
    };
  }

  // Mirrors the Symbol embedding workaround: with the current LadybugDB HNSW
  // behavior, enough is currently any non-cached vector row.
  const useRebuildPath =
    vecProp !== null &&
    indexName !== null &&
    uncached.length >= VECTOR_REBUILD_THRESHOLD;
  let indexDropped = false;
  if (useRebuildPath && indexName !== null) {
    // Bound WAL loss if the native rebuild kills the process (recurring
    // LadybugDB 0.16.x failure mode: silent access violation between the
    // index drop and recreate, leaving a torn WAL). Checkpointing committed
    // state first means a crash here can only tear this rebuild's writes,
    // not hours of unrelated committed work. Best-effort by design.
    await runWalCheckpoint("filesummary-vector-rebuild-pre-drop");
    const dropResult = await withWriteConn((wConn) =>
      dropVectorIndex(wConn, "FileSummary", indexName),
    );
    indexDropped = dropResult.status !== "failed";
  }

  const batchSize = resolveFileSummaryEmbeddingBatchSize(
    params.batchSize,
    DEFAULT_EMBEDDING_BATCH_SIZE,
  );
  const maxConcurrency = Math.max(
    1,
    Math.min(params.concurrency ?? 1, MAX_EMBEDDING_CONCURRENCY),
  );
  const batches: (typeof uncached)[] = [];
  for (let i = 0; i < uncached.length; i += batchSize) {
    batches.push(uncached.slice(i, i + batchSize));
  }

  let embedded = 0;
  let failed = 0;
  const pendingWrites: ladybugDb.FileSummaryEmbeddingBatchItem[] = [];
  const flush = async (): Promise<void> => {
    if (pendingWrites.length === 0) return;
    const rows = pendingWrites.splice(0);
    await withWriteConn((wConn) =>
      ladybugDb.setFileSummaryEmbeddingBatch(wConn, storageModel, rows, {
        hnswIndexDropped: indexDropped,
      }),
    );
  };

  try {
    for (let i = 0; i < batches.length; i += maxConcurrency) {
      const chunk = batches.slice(i, i + maxConcurrency);
      const results = await Promise.allSettled(
        chunk.map((batch) => embedBatch(provider, batch)),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          failed++;
          logger.warn("FileSummary embedding batch failed", {
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          });
          continue;
        }
        pendingWrites.push(...result.value);
        embedded += result.value.length;
        params.onProgress?.({
          stage: "embeddings",
          substage: "fileSummaryEmbeddings",
          current: embedded,
          total: uncached.length,
          model: storageModel,
        });
      }
      await flush();
      if (failed > 0 && failed / batches.length > 0.5) {
        throw new IndexError("FileSummary embedding failure rate exceeds 50%");
      }
    }
  } finally {
    await flush();
    if (indexDropped && vecProp !== null && indexName !== null) {
      const modelInfo = EMBEDDING_MODELS[storageModel];
      if (modelInfo) {
        await withWriteConn((wConn) =>
          createVectorIndex(
            wConn,
            "FileSummary",
            vecProp,
            indexName,
            modelInfo.dimension,
          ),
        );
        // Persist the rebuilt index + embeddings immediately instead of
        // leaving them WAL-only until the size-based auto checkpoint; a
        // later crash then cannot roll this rebuild back. Best-effort.
        await runWalCheckpoint("filesummary-vector-rebuild-post-create");
      }
    }
  }

  return {
    embedded,
    skipped,
    missing: missingPayloads + uncached.length - embedded,
    degraded: failed > 0,
  };
}

export function buildFileSummaryEmbeddingText(
  summary: Pick<ladybugDb.FileSummaryRow, "summary" | "searchText">,
  maxChars = DEFAULT_FILE_SUMMARY_EMBEDDING_MAX_CHARS,
): string {
  const text = (summary.summary ?? summary.searchText ?? "").trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trimEnd();
}

export function resolveFileSummaryEmbeddingBatchSize(
  fileSummaryBatchSize: number | undefined,
  symbolBatchSize: number | undefined,
): number {
  const requested =
    fileSummaryBatchSize ??
    Math.min(
      symbolBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE,
      DEFAULT_FILE_SUMMARY_EMBEDDING_BATCH_SIZE,
    );
  return Math.max(
    1,
    Math.min(
      requested,
      MAX_FILE_SUMMARY_EMBEDDING_BATCH_SIZE,
      MAX_EMBEDDING_BATCH_SIZE,
    ),
  );
}

async function embedBatch(
  provider: EmbeddingProvider,
  batch: Array<{
    summary: ladybugDb.FileSummaryRow;
    prefixedText: string;
    cardHash: string;
  }>,
): Promise<ladybugDb.FileSummaryEmbeddingBatchItem[]> {
  const vectors = await provider.embed(batch.map((item) => item.prefixedText));
  if (vectors.length !== batch.length) {
    throw new IndexError(
      "FileSummary embedding provider returned wrong vector count",
    );
  }

  if (provider.isMockFallback?.()) {
    return [];
  }

  return batch.map((item, index) => ({
    fileId: item.summary.fileId,
    vector: toFloat16Blob(vectors[index]),
    cardHash: item.cardHash,
    vectorArray: vectors[index],
  }));
}

function getFileSummaryVectorIndexName(model: string): string | null {
  if (model === "jina-embeddings-v2-base-code") {
    return FILESUMMARY_VECTOR_INDEX_NAMES.jinaCode;
  }
  if (model === "nomic-embed-text-v1.5") {
    return FILESUMMARY_VECTOR_INDEX_NAMES.nomic;
  }
  return null;
}
