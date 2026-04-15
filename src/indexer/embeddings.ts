import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { hashContent } from "../util/hashing.js";
import { logger } from "../util/logger.js";
import {
  createOnnxSession,
  type OnnxEmbeddingSession,
} from "./embeddings-local.js";
import { getModelInfo, applyDocumentPrefix, isModelAvailable } from "./model-registry.js";
import type { IndexProgress } from "./indexer.js";
import {
  getSymbolEmbeddingsFromNodes,
  setSymbolEmbeddingOnNode,
} from "../db/ladybug-symbol-embeddings.js";
import { prepareSymbolEmbeddingInputs } from "./symbol-embedding-context.js";
import { buildSymbolEmbeddingText } from "./symbol-embedding-text.js";


/** Legacy dimension constant — only used by MockEmbeddingProvider */
export const EMBEDDING_DIMENSION = 64;

/**
 * Batch size for refresh operations. Matches the ONNX inference batch width
 * used by LocalEmbeddingProvider. Changing provider batch width should update
 * this value in lockstep.
 */
export const REFRESH_BATCH_SIZE = 32;

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
      return new LocalEmbeddingProvider(model ?? "jina-embeddings-v2-base-code");
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

  // Resolve concurrency: clamp to [1, MAX_EMBEDDING_CONCURRENCY].
  const maxConcurrency = Math.max(
    1,
    Math.min(params.concurrency ?? 1, 4),
  );

  // Progress: fire at start
  params.onProgress?.({ stage: "embeddings", current: 0, total: symbols.length });

  // Split uncached items into batches of REFRESH_BATCH_SIZE.
  type UncachedBatch = Array<{ symbol: ladybugDb.SymbolRow; prefixedText: string; cardHash: string }>;
  const batches: UncachedBatch[] = [];
  for (let i = 0; i < uncachedItems.length; i += REFRESH_BATCH_SIZE) {
    batches.push(uncachedItems.slice(i, i + REFRESH_BATCH_SIZE));
  }

  // Shared mutable counters — updated inside processBatch results (not inside
  // concurrent closures directly) so there are no data races.
  type BatchResult = { embedded: number; skipped: number; terminal: boolean };

  const processBatch = async (
    batch: UncachedBatch,
  ): Promise<BatchResult> => {
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
      if (errorMsg.includes("SessionClosed") || errorMsg.includes("ECONNRESET")) {
        logger.error("Terminal provider error, aborting refresh", { error: errorMsg });
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

    // Post-embed cache recheck for race avoidance
    const batchSymbolIds = batch.map((item) => item.symbol.symbolId);
    const postEmbedExisting = await getSymbolEmbeddingsFromNodes(
      conn,
      batchSymbolIds,
      storageModel,
    );

    let batchEmbedded = 0;
    let batchSkipped = 0;

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const vector = batchVectors[i];
      const postExisting = postEmbedExisting.get(item.symbol.symbolId);

      if (postExisting && postExisting.cardHash === item.cardHash) {
        batchSkipped += 1;
        continue;
      }

      await withWriteConn(async (wConn) => {
        await setSymbolEmbeddingOnNode(
          wConn,
          item.symbol.symbolId,
          storageModel,
          toFloat16Blob(vector),
          item.cardHash,
          vector,
        );
      });
      batchEmbedded += 1;
    }

    return { embedded: batchEmbedded, skipped: batchSkipped, terminal: false };
  };

  // Process batches with bounded concurrency using a sliding window.
  // Each "chunk" is at most maxConcurrency batches run in parallel.
  let aborted = false;
  for (let chunkStart = 0; chunkStart < batches.length && !aborted; chunkStart += maxConcurrency) {
    const chunk = batches.slice(chunkStart, chunkStart + maxConcurrency);
    const results = await Promise.allSettled(chunk.map((b) => processBatch(b)));

    for (const result of results) {
      if (result.status === "fulfilled") {
        embedded += result.value.embedded;
        skipped += result.value.skipped;
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

    // Progress: fire after each chunk
    const progressCurrent = Math.min(skipped + embedded, symbols.length);
    params.onProgress?.({ stage: "embeddings", current: progressCurrent, total: symbols.length });
  }

  // Progress: fire at end
  params.onProgress?.({ stage: "embeddings", current: symbols.length, total: symbols.length });
  return { embedded, skipped };
}
