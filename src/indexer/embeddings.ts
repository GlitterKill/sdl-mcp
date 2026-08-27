import { freemem, totalmem } from "node:os";

import {
  getLadybugConn,
  withWriteConn,
} from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { hashContent } from "../util/hashing.js";
import { logger } from "../util/logger.js";
import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  MAX_EMBEDDING_BATCH_SIZE,
  MAX_EMBEDDING_CONCURRENCY,
} from "../config/constants.js";
import {
  createOnnxSession,
  type OnnxEmbeddingSession,
  type OnnxEmbeddingSessionOptions,
} from "./embeddings-local.js";
import {
  getModelInfo,
  applyDocumentPrefix,
  isModelAvailable,
} from "./model-registry.js";
import type { IndexProgress } from "./indexer.js";
import {
  getSymbolVectorEmbeddings,
  hasCompleteSymbolVectorEmbedding,
  setSymbolVectorEmbeddingBatch,
  type SymbolVectorEmbeddingBatchItem,
} from "../db/ladybug-symbol-embeddings.js";
import {
  createVectorIndex,
  showIndexesStrict,
} from "../retrieval/index-lifecycle.js";
import {
  EMBEDDING_MODELS,
  getVecPropertyName,
  getVectorIndexName,
  SYMBOL_VECTOR_EMBEDDING_TABLE,
} from "../retrieval/model-mapping.js";
import { prepareSymbolEmbeddingInputs } from "./symbol-embedding-context.js";
import { buildSymbolEmbeddingText } from "./symbol-embedding-text.js";
import { IndexError } from "../domain/errors.js";
import { runHnswRebuildCycle } from "./hnsw-rebuild-cycle.js";

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

let embeddingFailureCount = 0;

export function getEmbeddingFailureCount(): number {
  return embeddingFailureCount;
}

function recordEmbeddingFailure(): void {
  embeddingFailureCount++;
}

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

export interface EmbeddingMemorySnapshot {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  systemFreeBytes: number;
  systemTotalBytes: number;
}

function captureEmbeddingMemorySnapshot(): EmbeddingMemorySnapshot {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    systemFreeBytes: freemem(),
    systemTotalBytes: totalmem(),
  };
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
  private sessionOptions: OnnxEmbeddingSessionOptions;
  private fallbackToMock = false;

  constructor(
    modelName: string,
    sessionOptions: OnnxEmbeddingSessionOptions,
  ) {
    this.modelName = modelName;
    this.sessionOptions = sessionOptions;
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
        this.session = await createOnnxSession(
          this.modelName,
          this.sessionOptions,
        );
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

export function toFloat16Blob(vector: number[]): string {
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
  sessionOptions: OnnxEmbeddingSessionOptions = {},
): EmbeddingProvider {
  switch (provider) {
    case "local":
      return new LocalEmbeddingProvider(
        model ?? "jina-embeddings-v2-base-code",
        sessionOptions,
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
  vectorIndexName?: string;
  vectorEfc?: number;
  /** Preserve the repo-specific timeout for destructive rebuild sessions. */
  postIndexSessionTimeoutMs?: number;
  /** @internal Allows tests to exercise provider degradation deterministically. */
  embeddingProvider?: EmbeddingProvider;
  /** Records internal phase durations for opt-in indexing diagnostics. */
  recordTiming?: (phaseName: string, durationMs: number) => void;
  /** Records read-only process/system memory at semantic phase boundaries. */
  recordMemorySnapshot?: (
    phaseName: string,
    snapshot: EmbeddingMemorySnapshot,
  ) => void;
}): Promise<{
  embedded: number;
  skipped: number;
  deferred?: number;
  degraded?: boolean;
}> {
  const modelName = params.model ?? "jina-embeddings-v2-base-code";
  const provider =
    params.embeddingProvider ?? getEmbeddingProvider(params.provider, modelName);
  const measure = async <T>(
    phaseName: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      params.recordTiming?.(phaseName, Date.now() - startedAt);
    }
  };
  // Record the union of overlapping calls so concurrency still reports wall time.
  let activeInferenceCalls = 0;
  let inferenceStartedAt = 0;
  const measureInference = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (activeInferenceCalls++ === 0) inferenceStartedAt = Date.now();
    try {
      return await fn();
    } finally {
      activeInferenceCalls--;
      if (activeInferenceCalls === 0) {
        params.recordTiming?.("inference", Date.now() - inferenceStartedAt);
      }
    }
  };
  const recordMemorySnapshot = (phaseName: string): void => {
    params.recordMemorySnapshot?.(
      phaseName,
      captureEmbeddingMemorySnapshot(),
    );
  };
  const conn = await getLadybugConn();
  const symbols =
    params.symbols ?? (await ladybugDb.getSymbolsByRepo(conn, params.repoId));

  // Phase 4: Pin storageModel once at start.
  const storageModel = provider.isMockFallback?.()
    ? "mock-fallback"
    : modelName;
  let embedded = 0;
  let skipped = 0;

  const vecProp = getVecPropertyName(modelName);
  const indexName = params.vectorIndexName ?? getVectorIndexName(modelName);
  const modelInfo = EMBEDDING_MODELS[modelName];
  let shouldBootstrapIndex = false;
  if (vecProp !== null && indexName !== null && modelInfo) {
    const configuredIndex = (await showIndexesStrict(conn)).find(
      ({ tableName, name }) =>
        tableName === SYMBOL_VECTOR_EMBEDDING_TABLE && name === indexName,
    );
    if (
      configuredIndex &&
      (configuredIndex.type !== "vector" ||
        configuredIndex.property !== vecProp)
    ) {
      throw new IndexError(
        `Configured vector index '${indexName}' belongs to ${SYMBOL_VECTOR_EMBEDDING_TABLE}.${configuredIndex.property} (${configuredIndex.type}), not ${SYMBOL_VECTOR_EMBEDDING_TABLE}.${vecProp}`,
      );
    }
    shouldBootstrapIndex = configuredIndex === undefined;
  }

  const bootstrapVectorIndex = async (): Promise<void> => {
    if (
      !shouldBootstrapIndex ||
      vecProp === null ||
      indexName === null ||
      !modelInfo
    ) {
      return;
    }
    if (!(await hasCompleteSymbolVectorEmbedding(conn, modelName))) return;
    await runHnswRebuildCycle(
      "symbol-vector-bootstrap-pre-create",
      "symbol-vector-bootstrap-post-create",
      async () => {
        recordMemorySnapshot("beforeHnsw");
        params.onProgress?.({
          stage: "embeddings",
          substage: "symbolVectorIndex",
          current: Math.min(skipped + embedded, symbols.length),
          total: symbols.length,
          model: storageModel,
          message: "building HNSW",
        });
        let ok: boolean;
        try {
          ok = await measure("hnsw.create", () =>
            withWriteConn((wConn) =>
              createVectorIndex(
                wConn,
                SYMBOL_VECTOR_EMBEDDING_TABLE,
                vecProp,
                indexName,
                modelInfo.dimension,
                params.vectorEfc,
              ),
            ),
          );
        } finally {
          recordMemorySnapshot("afterHnsw");
        }
        params.onProgress?.({
          stage: "embeddings",
          substage: "symbolVectorIndex",
          current: Math.min(skipped + embedded, symbols.length),
          total: symbols.length,
          model: storageModel,
          message: ok ? "ready" : "creation failed",
        });
        if (!ok) {
          throw new IndexError(
            `Failed to create required vector index '${indexName}' on ${SYMBOL_VECTOR_EMBEDDING_TABLE}.${vecProp}`,
          );
        }
        logger.info(
          `[embeddings] Vector index '${indexName}' created on ${SYMBOL_VECTOR_EMBEDDING_TABLE}`,
        );
      },
      params.postIndexSessionTimeoutMs,
      params.recordTiming,
      params.repoId,
    );
  };

  if (storageModel === "mock-fallback") {
    // Mock-fallback vectors must not be persisted or reported as cache hits.
    await bootstrapVectorIndex();
    return { embedded: 0, skipped: 0, degraded: true };
  }

  // Load summary cache once for all symbols (used by prepareSymbolEmbeddingInputs).
  const summaryCacheMap = await ladybugDb.getSummaryCaches(
    conn,
    symbols.map((s) => s.symbolId),
  );

  // Phase 4: Pre-pass - batch load existing embeddings for all symbols.
  const allSymbolIds = symbols.map((s) => s.symbolId);
  const existingEmbeddings = await getSymbolVectorEmbeddings(
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

  const runPersistenceCycle = async () => {
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
    type BatchResult = {
      embedded: number;
      skipped: number;
      terminal: boolean;
      failed: boolean;
      degraded?: boolean;
    };

    const processBatch = async (batch: UncachedBatch): Promise<BatchResult> => {
      const batchTexts = batch.map((item) => item.prefixedText);
      let batchVectors: number[][];
      try {
        batchVectors = await measureInference(() => provider.embed(batchTexts));
      } catch (error) {
        recordEmbeddingFailure();
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
          return { embedded: 0, skipped: 0, terminal: true, failed: true };
        }
        return { embedded: 0, skipped: 0, terminal: false, failed: true };
      }

      // Guard: validate provider returned correct vector count
      if (batchVectors.length !== batch.length) {
        logger.error("Provider returned wrong vector count", {
          expected: batch.length,
          received: batchVectors.length,
          firstSymbolId: batch[0]?.symbol.symbolId,
        });
        recordEmbeddingFailure();
        return { embedded: 0, skipped: 0, terminal: false, failed: true };
      }

      // Check if provider degraded to mock mid-refresh
      if (provider.isMockFallback?.()) {
        logger.debug("Provider degraded to mock, skipping batch persistence", {
          batchSize: batch.length,
        });
        return {
          embedded: 0,
          skipped: 0,
          terminal: true,
          failed: false,
          degraded: true,
        };
      }

      // P5: post-embed recheck for race avoidance is now an in-memory lookup
      // against the pre-pass snapshot rather than a fresh DB round-trip per
      // batch. Authoritative reasoning: parallel calls in metrics-updater.ts
      // each pass a distinct `model`, and each model writes to disjoint rows,
      // so the per-model snapshots cannot race each other. If a future change
      // adds a same-model parallel writer, this in-memory shortcut must be
      // re-evaluated — writeLimiter serializes connections, not the in-memory
      // snapshot, and two refreshes of the same model could write
      // duplicate work. Cross-process races degrade to rare duplicate
      // identical writes (harmless).
      const postEmbedExisting = existingEmbeddings;
      const batchItems: SymbolVectorEmbeddingBatchItem[] = [];
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
        await withWriteConn(async (wConn) => {
          await setSymbolVectorEmbeddingBatch(
            wConn,
            params.repoId,
            storageModel,
            batchItems,
          );
        });
      }

      return {
        embedded: batchItems.length,
        skipped: batch.length - batchItems.length,
        terminal: false,
        failed: false,
      };
    };

    // Process batches with bounded concurrency using a sliding window.
    // Each "chunk" is at most maxConcurrency batches run in parallel.
    let aborted = false;
    let degraded = false;
    let failedBatches = 0;
    let processedBatches = 0;
    recordMemorySnapshot("beforeInference");
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
            processedBatches++;
            if (res.failed) failedBatches++;
            if (res.degraded) degraded = true;
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
            recordEmbeddingFailure();
            const reason =
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason);
            throw new IndexError(
              `Symbol embedding persistence failed: ${reason}`,
            );
          }
        }

        if (processedBatches > 0 && failedBatches / processedBatches > 0.5) {
          throw new IndexError("Embedding failure rate exceeds 50%");
        }
      }
      recordMemorySnapshot("afterInference");
    } finally {
      await bootstrapVectorIndex();
    }

    // Progress: fire at end through fireProgress() so the monotonic clamp
    // covers this final tick too — without it, a 0-symbol refresh would
    // emit a duplicate {current:0, total:0} after the start tick. The
    // clamp guarantees the final emit only fires when real progress was
    // made beyond the last tick; for partial/aborted runs that means
    // honest "current < total" rather than a dishonest forced-to-total.
    fireProgress();
    return degraded
      ? { embedded, skipped, degraded: true }
      : { embedded, skipped };
  };
  return runPersistenceCycle();
}
