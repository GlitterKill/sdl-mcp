import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_FILE_SUMMARY_EMBEDDING_BATCH_SIZE,
  DEFAULT_FILE_SUMMARY_EMBEDDING_MAX_CHARS,
  MAX_EMBEDDING_BATCH_SIZE,
  MAX_EMBEDDING_CONCURRENCY,
  MAX_FILE_SUMMARY_EMBEDDING_BATCH_SIZE,
  VECTOR_REBUILD_THRESHOLD,
} from "../config/constants.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
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
}): Promise<FileSummaryEmbeddingRefreshResult> {
  const provider = getEmbeddingProvider(params.provider, params.model);
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

  const uncached = summaries
    .map((summary) => {
      const text = buildFileSummaryEmbeddingText(summary, params.maxChars);
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
      };
    })
    .filter((item) => !item.cached && item.prefixedText.trim().length > 0)
    .sort((a, b) => a.prefixedText.length - b.prefixedText.length);

  const skipped = summaries.length - uncached.length;
  if (uncached.length === 0) {
    return { embedded: 0, skipped, missing: 0, degraded: false };
  }

  const vecProp = getVecPropertyName(storageModel);
  const indexName = getFileSummaryVectorIndexName(storageModel);
  const useRebuildPath =
    vecProp !== null &&
    indexName !== null &&
    uncached.length >= VECTOR_REBUILD_THRESHOLD;
  let indexDropped = false;
  if (useRebuildPath && indexName !== null) {
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
      }
    }
  }

  return {
    embedded,
    skipped,
    missing: uncached.length - embedded,
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
