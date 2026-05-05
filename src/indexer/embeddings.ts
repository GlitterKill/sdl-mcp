import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { hashContent } from "../util/hashing.js";
import { logger } from "../util/logger.js";
import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  MAX_EMBEDDING_BATCH_SIZE,
  MAX_EMBEDDING_CONCURRENCY,
  VECTOR_REBUILD_THRESHOLD,
} from "../config/constants.js";
import {
  createOnnxSession,
  type OnnxEmbeddingSession,
} from "./embeddings-local.js";
import {
  getModelInfo,
  applyDocumentPrefix,
  isModelAvailable,
} from "./model-registry.js";
import type { IndexProgress } from "./indexer.js";
import {
  getSymbolEmbeddingsFromNodes,
  setSymbolEmbeddingBatchOnNode,
  type SymbolEmbeddingBatchItem,
} from "../db/ladybug-symbol-embeddings.js";
import {
  createVectorIndex,
  dropVectorIndex,
} from "../retrieval/index-lifecycle.js";
import {
  EMBEDDING_MODELS,
  getVecPropertyName,
  getVectorIndexName,
} from "../retrieval/model-mapping.js";
import { prepareSymbolEmbeddingInputs } from "./symbol-embedding-context.js";
import { buildSymbolEmbeddingText } from "./symbol-embedding-text.js";

/** Legacy dimension constant — only used by MockEmbeddingProvider */
export const EMBEDDING_DIMENSION = 64;

/**
 * Batch size for refresh operations. Matches the ONNX inference batch width
 * used by LocalEmbeddingProvider. Acts as the **default** when the caller
 * does not pass an explicit `batchSize` — the indexer wires
 * `semantic.embeddingBatchSize` from config, so production callers normally
 * override this. Kept exported so tests and ad-hoc scripts have a stable
 * reference value.
 */
export const REFRESH_BATCH_SIZE = DEFAULT_EMBEDDING_BATCH_SIZE;

export interface EmbeddingScoredSymbol {
  symbol: ladybugDb.SymbolRow;
  lexicalScore: number;
  semanticScore: number;
  finalScore: number;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  getDimension(): number;
  isMockFallback?(): boolean;
}

class MockEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => embedTextDeterministic(text));
  }

  getDimension(): number {
    return EMBEDDING_DIMENSION;
  }

  isMockFallback(): boolean {
    return true;
  }
}

class LocalEmbeddingProvider implements EmbeddingProvider {
  private session: OnnxEmbeddingSession | null = null;
  private modelName: string;
  private fallbackToMock = false;

  constructor(modelName: string) {
    this.modelName = modelName;
    // Eagerly detect missing model files so isMockFallback() is accurate
    // before the first embed() call.  This lets callers (e.g. the retrieval
    // orchestrator) skip unavailable models without triggering a warn log.
    if (!isModelAvailable(modelName)) {
      this.fallbackToMock = true;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.fallbackToMock) {
      return texts.map((text) => embedTextDeterministic(text));
    }

    try {
      if (!this.session) {
        this.session = await createOnnxSession(this.modelName);
      }
      return await this.session.embed(texts);
    } catch (error) {
      // Graceful degradation: fall back to mock if ONNX/tokenizers unavailable
      logger.warn(
        `Local embedding provider falling back to mock: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.fallbackToMock = true;
      return texts.map((text) => embedTextDeterministic(text));
    }
  }

  getDimension(): number {
    if (this.session) {
      return this.session.dimension;
    }
    if (this.fallbackToMock) {
      return EMBEDDING_DIMENSION;
    }
    try {
      return getModelInfo(this.modelName).dimension;
    } catch (err) {
      logger.debug("Failed to get model dimension, using default", {
        modelName: this.modelName,
        fallbackDimension: EMBEDDING_DIMENSION,
        error: err instanceof Error ? err.message : String(err),
      });
      return EMBEDDING_DIMENSION;
    }
  }

  isMockFallback(): boolean {
    return this.fallbackToMock;
  }
}

class ApiEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    // API mode is intentionally deterministic for testability in OSS builds.
    return texts.map((text) => embedTextDeterministic(text));
  }

  getDimension(): number {
    return EMBEDDING_DIMENSION;
  }

  isMockFallback(): boolean {
    // API provider currently uses the same deterministic mock vectors.
    // Mark as mock so embeddings are stored under "mock-fallback" rather
    // than the configured model name, preventing dimension-mismatch if
    // the user later switches to a real local provider.
    return true;
  }
}

function embedTextDeterministic(text: string): number[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    tokens.push(text.toLowerCase());
  }

  const vec = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  for (const token of tokens) {
    const seedHex = hashContent(token);
    for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
      const offset = (i * 2) % Math.max(2, seedHex.length - 1);
      const b = Number.parseInt(seedHex.slice(offset, offset + 2), 16) || 0;
      const signed = (b / 255) * 2 - 1;
      vec[i] += signed;
    }
  }
  return normalizeVector(vec);
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((acc, value) => acc + value * value, 0));
  if (norm <= 1e-9) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom <= 1e-9) {
    return 0;
  }
  return dot / denom;
}

function toFloat16Blob(vector: number[]): string {
  const ints = new Int16Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    ints[i] = Math.max(-32767, Math.min(32767, Math.round(vector[i] * 10000)));
  }
  return Buffer.from(ints.buffer).toString("base64");
}

function buildCardHash(
  symbol: ladybugDb.SymbolRow,
  extraContext?: string,
): string {
  return hashContent(
    [
      symbol.symbolId,
      symbol.name,
      symbol.kind,
      symbol.astFingerprint,
      // Phase 4: Removed symbol.summary - extraContext carries summary state
      symbol.signatureJson ?? "",
      extraContext ?? "",
    ].join("|"),
  );
}

function parseSignatureText(signatureJson: string | null): string | null {
  if (!signatureJson) return null;
  try {
    const parsed = JSON.parse(signatureJson) as { text?: string } | string;
    return typeof parsed === "string"
      ? parsed
      : (parsed?.text ?? signatureJson);
  } catch (err) {
    logger.debug("Failed to parse signature JSON, using raw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return signatureJson;
  }
}

export function getEmbeddingProvider(
  provider: "api" | "local" | "mock",
  model?: string,
): EmbeddingProvider {
  switch (provider) {
    case "local":
      return new LocalEmbeddingProvider(
        model ?? "jina-embeddings-v2-base-code",
      );
    case "api":
      return new ApiEmbeddingProvider();
    case "mock":
    default:
      return new MockEmbeddingProvider();
  }
}

/**
 * For Jina (code-specialized model): name + kind + signature + summary.
 * Optimized for code understanding.
 */
export function buildRawEmbeddingText(symbol: ladybugDb.SymbolRow): string {
  const parts = [`${symbol.name} (${symbol.kind})`];
  const signatureText = parseSignatureText(symbol.signatureJson);
  if (signatureText) {
    parts.push(signatureText);
  }
  if (symbol.summary) parts.push(symbol.summary);
  return parts.join("\n");
}

export async function refreshSymbolEmbeddings(params: {
  repoId: string;
  provider: "api" | "local" | "mock";
  model?: string;
  symbols?: ladybugDb.SymbolRow[];
  onProgress?: (progress: IndexProgress) => void;
  /** Number of batches to process concurrently. Defaults to 1 (sequential). */
  concurrency?: number;
  /**
   * ONNX inference batch width. Defaults to `DEFAULT_EMBEDDING_BATCH_SIZE`
   * (32). Clamped to `[1, MAX_EMBEDDING_BATCH_SIZE]` so a misconfigured
   * value can't OOM the tokenizer or break ONNX session shape contracts.
   */
  batchSize?: number;
}): Promise<{ embedded: number; skipped: number }> {
  const modelName = params.model ?? "jina-embeddings-v2-base-code";
  const provider = getEmbeddingProvider(params.provider, modelName);
  const conn = await getLadybugConn();
  const symbols =
    params.symbols ?? (await ladybugDb.getSymbolsByRepo(conn, params.repoId));

  // Phase 4: Pin storageModel once at start. If mock-fallback, return immediately.
  const storageModel = provider.isMockFallback?.()
    ? "mock-fallback"
    : modelName;

  if (storageModel === "mock-fallback") {
    // Mock-fallback vectors must not be persisted. Skip all symbols.
    return { embedded: 0, skipped: symbols.length };
  }

  let embedded = 0;
  let skipped = 0;

  // Load summary cache once for all symbols (used by prepareSymbolEmbeddingInputs).
  const summaryCacheMap = await ladybugDb.getSummaryCaches(
    conn,
    symbols.map((s) => s.symbolId),
  );

  // Phase 4: Pre-pass - batch load existing embeddings for all symbols.
  const allSymbolIds = symbols.map((s) => s.symbolId);
  const existingEmbeddings = await getSymbolEmbeddingsFromNodes(
    conn,
    allSymbolIds,
    storageModel,
  );

  // Prepare inputs using model-aware payload builder (Phase 1-3).
  const preparedInputs = await prepareSymbolEmbeddingInputs(conn, symbols, {
    summaryCacheMap,
  });

  // Build text payloads and card hashes, filter out cached symbols.
  const uncachedItems: Array<{
    symbol: ladybugDb.SymbolRow;
    prefixedText: string;
    cardHash: string;
  }> = [];

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const prepared = preparedInputs[i];
    const text = buildSymbolEmbeddingText(modelName, prepared);
    const prefixedText = applyDocumentPrefix(modelName, text);
    const cardHash = buildCardHash(symbol, prefixedText);

    const existing = existingEmbeddings.get(symbol.symbolId);
    if (existing && existing.cardHash === cardHash) {
      skipped += 1;
      continue;
    }

    uncachedItems.push({ symbol, prefixedText, cardHash });
  }

  // P4: sort uncached items by prefixed-text length so each batch contains
  // similarly sized inputs. Tokenizer padding pads every row in a batch to
  // the longest sequence, so mixing one outlier with 31 short symbols
  // multiplies the ONNX work for the whole batch. Bucketing by length
  // typically cuts inference wall time 30–50% on heterogeneous corpora.
  // Note: callers must not depend on write order — sort is purely a
  // throughput optimisation.
  uncachedItems.sort((a, b) => a.prefixedText.length - b.prefixedText.length);

  // Resolve concurrency: clamp to [1, MAX_EMBEDDING_CONCURRENCY].
  const maxConcurrency = Math.max(
    1,
    Math.min(params.concurrency ?? 1, MAX_EMBEDDING_CONCURRENCY),
  );

  // P6: helper to fire smooth per-batch progress. We keep firing at the
  // batch boundary instead of waiting for the whole chunk to finish so
  // observers see a steady tick stream rather than a 0→56% jump. Under
  // concurrency >1 the counters are mutated from concurrent closures —
  // JS guarantees no torn writes, but two batches finishing near the
  // same tick can both observe the same `current`. The monotonic clamp
  // keeps the reported value non-decreasing so consumers don't see
  // duplicate or backwards ticks.
  let lastReported = -1;
  const fireProgress = (): void => {
    const current = Math.min(skipped + embedded, symbols.length);
    if (current <= lastReported) return;
    lastReported = current;
    params.onProgress?.({
      stage: "embeddings",
      current,
      total: symbols.length,
      // Model tag lets the CLI keep per-model state. Two models run in
      // parallel from metrics-updater.ts and previously interleaved into a
      // single shared progress line, causing the displayed count to flicker
      // between each model's value.
      model: storageModel,
    });
  };

  // Progress: fire at start (already includes the cache-hit skip count
  // accumulated above, so the very first tick is non-zero whenever the
  // pre-pass found cached embeddings — no surprise jump on first chunk).
  fireProgress();

  // P2: HNSW drop+rebuild for bulk runs. When the uncached count exceeds
  // VECTOR_REBUILD_THRESHOLD, dropping the vector index for the duration
  // of the writes is much cheaper than per-row HNSW maintenance:
  // O(N · log N · M · efc) becomes O(rebuild) ≈ a single pass at the end.
  const vecProp = getVecPropertyName(modelName);
  const indexName = getVectorIndexName(modelName);
  const useRebuildPath =
    vecProp !== null &&
    indexName !== null &&
    uncachedItems.length >= VECTOR_REBUILD_THRESHOLD;
  let indexDropped = false;
  if (useRebuildPath) {
    indexDropped = await withWriteConn((wConn) =>
      dropVectorIndex(wConn, "Symbol", indexName),
    );
    if (indexDropped) {
      logger.info(
        `[embeddings] Bulk path: dropped vector index '${indexName}' for ${uncachedItems.length} writes (rebuild after)`,
      );
    } else {
      logger.warn(
        `[embeddings] Vector index '${indexName}' drop failed; falling back to per-row HNSW maintenance`,
      );
    }
  }

  // Resolve effective batch size: clamp caller-supplied value to a sane
  // window so a misconfigured `embeddingBatchSize` cannot OOM tokenizer
  // padding or violate the ONNX session's expected input shape.
  const batchSize = Math.max(
    1,
    Math.min(
      params.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE,
      MAX_EMBEDDING_BATCH_SIZE,
    ),
  );

  // Split uncached items into batches of `batchSize`.
  type UncachedBatch = Array<{
    symbol: ladybugDb.SymbolRow;
    prefixedText: string;
    cardHash: string;
  }>;
  const batches: UncachedBatch[] = [];
  for (let i = 0; i < uncachedItems.length; i += batchSize) {
    batches.push(uncachedItems.slice(i, i + batchSize));
  }

  // Shared mutable counters — updated inside processBatch results (not inside
  // concurrent closures directly) so there are no data races.
  type BatchResult = { embedded: number; skipped: number; terminal: boolean };

  // P2.b: write-coalescing buffer for the rebuild path. When the HNSW index is
  // dropped, every per-ONNX-batch DB write is just an INSERT into a plain
  // FLOAT[] column (no HNSW maintenance), so the per-write overhead is mostly
  // writeLimiter handshake + tx round-trip. Batching ~8 ONNX batches into one
  // DB write cuts those handshakes ~8x without any correctness risk: the items
  // are independent SET ops on disjoint Symbol nodes. Buffer is mutated only
  // from non-concurrent code paths (inside processBatch's single tick of
  // pendingWriteItems.push, and the chunk-boundary flush after allSettled),
  // so no lock is required.
  const COALESCE_WRITE_BUFFER_SIZE = 256;
  const pendingWriteItems: SymbolEmbeddingBatchItem[] = [];

  const flushPendingWrites = async (force: boolean): Promise<void> => {
    if (pendingWriteItems.length === 0) return;
    if (!force && pendingWriteItems.length < COALESCE_WRITE_BUFFER_SIZE) return;
    const toWrite = pendingWriteItems.splice(0);
    await withWriteConn(async (wConn) => {
      await setSymbolEmbeddingBatchOnNode(wConn, storageModel, toWrite, {
        hnswIndexDropped: indexDropped,
      });
    });
  };

  const processBatch = async (batch: UncachedBatch): Promise<BatchResult> => {
    const batchTexts = batch.map((item) => item.prefixedText);
    let batchVectors: number[][];
    try {
      batchVectors = await provider.embed(batchTexts);
    } catch (error) {
      logger.warn("Batch embedding failed, continuing to next batch", {
        batchSize: batch.length,
        firstSymbolId: batch[0]?.symbol.symbolId,
        error: error instanceof Error ? error.message : String(error),
      });
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (
        errorMsg.includes("SessionClosed") ||
        errorMsg.includes("ECONNRESET")
      ) {
        logger.error("Terminal provider error, aborting refresh", {
          error: errorMsg,
        });
        return { embedded: 0, skipped: 0, terminal: true };
      }
      return { embedded: 0, skipped: 0, terminal: false };
    }

    // Guard: validate provider returned correct vector count
    if (batchVectors.length !== batch.length) {
      logger.error("Provider returned wrong vector count", {
        expected: batch.length,
        received: batchVectors.length,
        firstSymbolId: batch[0]?.symbol.symbolId,
      });
      return { embedded: 0, skipped: 0, terminal: false };
    }

    // Check if provider degraded to mock mid-refresh
    if (provider.isMockFallback?.()) {
      logger.debug("Provider degraded to mock, skipping batch persistence", {
        batchSize: batch.length,
      });
      return { embedded: 0, skipped: batch.length, terminal: false };
    }

    // P5: post-embed recheck for race avoidance is now an in-memory lookup
    // against the pre-pass snapshot rather than a fresh DB round-trip per
    // batch. Authoritative reasoning: parallel calls in metrics-updater.ts
    // each pass a distinct `model`, and each model writes to disjoint
    // Symbol properties (embeddingJinaCode* vs embeddingNomic*), so the
    // per-model snapshots cannot race each other. If a future change adds
    // a same-model parallel writer, this in-memory shortcut must be
    // re-evaluated — writeLimiter serializes connections, not the in-
    // memory snapshot, and two refreshes of the same model could write
    // duplicate work. Cross-process races degrade to rare duplicate
    // identical writes (harmless).
    const postEmbedExisting = existingEmbeddings;
    const batchItems: SymbolEmbeddingBatchItem[] = [];
    for (let i = 0; i < batch.length; i++) {
      const postExisting = postEmbedExisting.get(batch[i].symbol.symbolId);
      if (postExisting && postExisting.cardHash === batch[i].cardHash) {
        continue;
      }

      batchItems.push({
        symbolId: batch[i].symbol.symbolId,
        vector: toFloat16Blob(batchVectors[i]),
        cardHash: batch[i].cardHash,
        vectorArray: batchVectors[i],
      });
    }

    if (batchItems.length > 0) {
      if (indexDropped) {
        // Coalesced path: append to shared buffer; flush is driven by the
        // chunk-boundary in the dispatch loop (and the force-flush in
        // `finally` before HNSW rebuild).
        pendingWriteItems.push(...batchItems);
      } else {
        // Per-batch immediate write: the index drop failed, so we are on
        // the legacy per-row HNSW maintenance path that LADYBUG#377 likely
        // rejects anyway. Preserved for parity with the pre-coalescing
        // behaviour so a future upstream fix re-enables it cleanly.
        await withWriteConn(async (wConn) => {
          await setSymbolEmbeddingBatchOnNode(wConn, storageModel, batchItems, {
            hnswIndexDropped: indexDropped,
          });
        });
      }
    }

    return {
      embedded: batchItems.length,
      skipped: batch.length - batchItems.length,
      terminal: false,
    };
  };

  // Process batches with bounded concurrency using a sliding window.
  // Each "chunk" is at most maxConcurrency batches run in parallel.
  let aborted = false;
  try {
    for (
      let chunkStart = 0;
      chunkStart < batches.length && !aborted;
      chunkStart += maxConcurrency
    ) {
      const chunk = batches.slice(chunkStart, chunkStart + maxConcurrency);
      // P6: fire progress as each batch settles, not after the chunk wraps.
      const settled = await Promise.allSettled(
        chunk.map(async (b) => {
          const res = await processBatch(b);
          embedded += res.embedded;
          skipped += res.skipped;
          fireProgress();
          return res;
        }),
      );

      for (const result of settled) {
        if (result.status === "fulfilled") {
          if (result.value.terminal) {
            aborted = true;
          }
        } else {
          // processBatch should not throw (all errors handled internally),
          // but guard defensively.
          logger.warn("Unexpected processBatch rejection", {
            reason: String(result.reason),
          });
        }
      }

      // P2.b: chunk-boundary opportunistic flush. Only flushes when the
      // pending buffer has reached COALESCE_WRITE_BUFFER_SIZE so concurrency
      // > 1 still amortises the writeLimiter handshake across the whole
      // chunk. A flush failure is logged but does not abort the loop —
      // the items remain in the buffer and the force-flush in `finally`
      // will retry once.
      if (indexDropped) {
        try {
          await flushPendingWrites(false);
        } catch (err) {
          logger.warn(
            "[embeddings] Coalesced write flush failed (will retry at end)",
            {
              error: err instanceof Error ? err.message : String(err),
              pending: pendingWriteItems.length,
            },
          );
        }
      }
    }
  } finally {
    // P2.b: drain any remaining coalesced writes BEFORE rebuilding the
    // index. The rebuild scans Symbol.<vecProp>, so unflushed items would
    // not appear in HNSW until the next refresh. Failures here are logged
    // and counted toward `embedded` only after successful flush.
    if (indexDropped && pendingWriteItems.length > 0) {
      try {
        await flushPendingWrites(true);
      } catch (err) {
        logger.error(
          `[embeddings] Final coalesced write flush failed — ${pendingWriteItems.length} vectors will not be persisted; vector retrieval may be stale`,
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    // P2: rebuild the dropped index regardless of write outcome so search
    // remains operational even if the bulk write aborted partway. Failure
    // to recreate is non-fatal but logged loudly — vector retrieval will
    // degrade until the next index.refresh.
    if (indexDropped && vecProp !== null && indexName !== null) {
      const modelInfo = EMBEDDING_MODELS[modelName];
      if (modelInfo) {
        const ok = await withWriteConn((wConn) =>
          createVectorIndex(
            wConn,
            "Symbol",
            vecProp,
            indexName,
            modelInfo.dimension,
          ),
        );
        if (ok) {
          logger.info(
            `[embeddings] Vector index '${indexName}' rebuilt after bulk write`,
          );
        } else {
          logger.error(
            `[embeddings] Vector index '${indexName}' rebuild FAILED — vector retrieval for ${modelName} will degrade until next refresh`,
          );
        }
      }
    }
  }

  // Progress: fire at end through fireProgress() so the monotonic clamp
  // covers this final tick too — without it, a 0-symbol refresh would
  // emit a duplicate {current:0, total:0} after the start tick. The
  // clamp guarantees the final emit only fires when real progress was
  // made beyond the last tick; for partial/aborted runs that means
  // honest "current < total" rather than a dishonest forced-to-total.
  fireProgress();
  return { embedded, skipped };
}
