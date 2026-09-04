import { freemem, totalmem } from "node:os";

import { emitPerRepoSymbolVectorEvent } from "../benchmark/per-repo-symbol-vector-observer.js";

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
} from "./model-registry.js";
import type { IndexProgress } from "./indexer.js";
import {
  countCompleteRepoSymbolVectors,
  deleteRepoSymbolVectorEmbeddingsBySymbolIds,
  getRepoSymbolVectorEmbeddings,
  getRepoSymbolVectorProbe,
  inspectRepoSymbolVectorTable,
  resolveSymbolVectorPhysicalIdentity,
  setRepoSymbolVectorEmbeddingBatch,
  validateRepoSymbolVectorOwnership,
  type SymbolVectorEmbeddingBatchItem,
} from "../db/ladybug-symbol-embeddings.js";
import {
  createVectorIndex,
  dropVectorIndex,
  queryVectorIndexProbe,
  showIndexesStrict,
  type IndexInfo,
} from "../retrieval/index-lifecycle.js";
import { EMBEDDING_MODELS } from "../retrieval/model-mapping.js";
import { SYMBOL_HNSW_MIN_ROWS } from "../retrieval/health.js";
import {
  getEligibleRepoSymbolIds,
  getRepoSymbolVectorHealthRows,
} from "../db/ladybug-retrieval-health.js";
import type { SemanticConfig } from "../config/types.js";
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

// A single 50-row delete/reinsert write was verified against a live 26k-row
// LadybugDB HNSW and survived close/reopen. The production failure began on
// the second 32-row write, so larger changes stay on the rebuild safety lane.
// ponytail: keep this measured ceiling fixed until upstream live-HNSW writes
// are proven safe at a larger boundary.
const SYMBOL_VECTOR_RETAINED_HNSW_MAX_ROWS = 50;

export type RepositorySymbolVectorIndexMode = "exact" | "hnsw";

export function resolveRepositorySymbolVectorIndexMode(
  actualCompleteCount: number,
): RepositorySymbolVectorIndexMode {
  return actualCompleteCount >= SYMBOL_HNSW_MIN_ROWS ? "hnsw" : "exact";
}

export interface RepositorySymbolVectorReconciliationPlanInput {
  actualPreCount: number;
  actualPostCount: number;
  mutationCount: number;
  expectedIndexHealthy: boolean;
  expectedIndexPresent?: boolean;
  /** Diagnostic only. Durable counts, never provider targets, drive DDL. */
  providerTargetCount?: number;
}

export interface RepositorySymbolVectorReconciliationPlan {
  retainExpectedIndex: boolean;
  dropExpectedBeforeMutation: boolean;
  requireExpectedIndexAfterMutation: boolean;
}

/** @internal Pure threshold planner shared by refresh and focused tests. */
export function planRepositorySymbolVectorReconciliation(
  input: RepositorySymbolVectorReconciliationPlanInput,
): RepositorySymbolVectorReconciliationPlan {
  const retainExpectedIndex =
    input.expectedIndexHealthy &&
    input.actualPreCount >= SYMBOL_HNSW_MIN_ROWS &&
    input.mutationCount <= SYMBOL_VECTOR_RETAINED_HNSW_MAX_ROWS;
  return {
    retainExpectedIndex,
    dropExpectedBeforeMutation:
      input.mutationCount > 0 &&
      (input.expectedIndexPresent ?? input.expectedIndexHealthy) &&
      !retainExpectedIndex,
    requireExpectedIndexAfterMutation:
      resolveRepositorySymbolVectorIndexMode(input.actualPostCount) === "hnsw",
  };
}

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
  initialize?(): Promise<void>;
  getCacheCompatibilityKey?(): string | undefined;
  getDiagnosticIdentity?():
    | {
        modelName: string;
        variantName: string;
        executionProviders: readonly string[];
      }
    | undefined;
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
  private initialization: Promise<void> | null = null;
  private modelName: string;
  private sessionOptions: OnnxEmbeddingSessionOptions;
  private fallbackToMock = false;
  private cacheCompatibilityKey: string | undefined;
  private diagnosticIdentity:
    | {
        modelName: string;
        variantName: string;
        executionProviders: readonly string[];
      }
    | undefined;

  constructor(
    modelName: string,
    sessionOptions: OnnxEmbeddingSessionOptions,
  ) {
    this.modelName = modelName;
    this.sessionOptions = sessionOptions;
  }

  initialize(): Promise<void> {
    this.initialization ??= this.initializeSession();
    return this.initialization;
  }

  private async initializeSession(): Promise<void> {
    try {
      this.session = await createOnnxSession(this.modelName, this.sessionOptions);
      this.cacheCompatibilityKey = this.session.cacheCompatibilityKey;
      this.diagnosticIdentity = {
        modelName: this.session.modelName,
        variantName: this.session.variantName,
        executionProviders: this.session.executionProviders,
      };
    } catch (error) {
      logger.warn(
        `Local embedding provider falling back to mock: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.fallbackToMock = true;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.initialize();
    if (this.fallbackToMock || !this.session) {
      return texts.map((text) => embedTextDeterministic(text));
    }

    try {
      return await this.session.embed(texts);
    } catch (error) {
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

  getCacheCompatibilityKey(): string | undefined {
    return this.cacheCompatibilityKey;
  }

  getDiagnosticIdentity():
    | {
        modelName: string;
        variantName: string;
        executionProviders: readonly string[];
      }
    | undefined {
    return this.diagnosticIdentity;
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

export function hashEmbeddingPayload(
  parts: readonly string[],
  cacheCompatibilityKey?: string,
): string {
  return hashContent(
    (cacheCompatibilityKey ? [...parts, cacheCompatibilityKey] : parts).join(
      "|",
    ),
  );
}

function buildCardHash(
  symbol: ladybugDb.SymbolRow,
  extraContext?: string,
  cacheCompatibilityKey?: string,
): string {
  return hashEmbeddingPayload(
    [
      symbol.symbolId,
      symbol.name,
      symbol.kind,
      symbol.astFingerprint,
      // Phase 4: Removed symbol.summary - extraContext carries summary state
      symbol.signatureJson ?? "",
      extraContext ?? "",
    ],
    cacheCompatibilityKey,
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
  concurrency?: number;
  batchSize?: number;
  vectorEfc?: number;
  semanticConfig?: SemanticConfig;
  postIndexSessionTimeoutMs?: number;
  embeddingProvider?: EmbeddingProvider;
  recordTiming?: (phaseName: string, durationMs: number) => void;
  recordMemorySnapshot?: (
    phaseName: string,
    snapshot: EmbeddingMemorySnapshot,
  ) => void;
  /** @internal Fault seam for focused reconciliation boundary tests. */
  onReconciliationStep?: (
    step:
      | "catalog-classified"
      | "before-vector-mutation"
      | "after-index-drop"
      | "after-vector-delete"
      | "after-vector-merge"
      | "after-vector-create"
      | "after-index-create"
      | "after-vector-mutation"
      | "after-index-reconcile"
      | "after-validation",
  ) => Promise<void> | void;
  /** @internal Runs before exclusive admission reopens after cycle failure. */
  onFailureInsideGate?: (error: unknown) => Promise<void>;
}): Promise<{
  embedded: number;
  skipped: number;
  deferred?: number;
  degraded?: boolean;
}> {
  const modelName = params.model ?? "jina-embeddings-v2-base-code";
  const modelInfo = EMBEDDING_MODELS[modelName];
  if (!modelInfo) {
    throw new IndexError(`Unsupported embedding model "${modelName}"`);
  }

  const provider =
    params.embeddingProvider ?? getEmbeddingProvider(params.provider, modelName);
  await provider.initialize?.();
  if (provider.isMockFallback?.()) {
    // Mock vectors are never durable input and must not create repository tables.
    return { embedded: 0, skipped: 0, degraded: true };
  }

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
  const recordMemorySnapshot = (phaseName: string): void => {
    params.recordMemorySnapshot?.(
      phaseName,
      captureEmbeddingMemorySnapshot(),
    );
  };

  const conn = await getLadybugConn();
  const eligibleSymbolIds = await getEligibleRepoSymbolIds(conn, params.repoId);
  const eligibleSymbolIdSet = new Set(eligibleSymbolIds);
  const existingEmbeddings = await getRepoSymbolVectorEmbeddings(
    conn,
    params.repoId,
    eligibleSymbolIds,
    modelName,
  );
  const suppliedSymbols =
    params.symbols ?? (await ladybugDb.getSymbolsByRepo(conn, params.repoId));
  const symbolsById = new Map(
    suppliedSymbols
      .filter(
        (symbol) =>
          symbol.repoId === params.repoId &&
          eligibleSymbolIdSet.has(symbol.symbolId),
      )
      .map((symbol) => [symbol.symbolId, symbol]),
  );
  const missingSymbolIds = eligibleSymbolIds.filter(
    (symbolId) =>
      !existingEmbeddings.has(symbolId) && !symbolsById.has(symbolId),
  );
  if (missingSymbolIds.length > 0) {
    const missingSymbols = await ladybugDb.getSymbolsByIds(
      conn,
      missingSymbolIds,
    );
    for (const [symbolId, symbol] of missingSymbols) {
      if (
        symbol.repoId === params.repoId &&
        eligibleSymbolIdSet.has(symbolId)
      ) {
        symbolsById.set(symbolId, symbol);
      }
    }
  }
  const symbols = [...symbolsById.values()];

  const summaryCacheMap = await ladybugDb.getSummaryCaches(
    conn,
    symbols.map((symbol) => symbol.symbolId),
  );
  const preparedInputs = await prepareSymbolEmbeddingInputs(conn, symbols, {
    summaryCacheMap,
  });
  const jinaCacheCompatibilityKey =
    modelName === "jina-embeddings-v2-base-code"
      ? provider.getCacheCompatibilityKey?.()
      : undefined;
  const uncachedItems: Array<{
    symbol: ladybugDb.SymbolRow;
    prefixedText: string;
    cardHash: string;
  }> = [];
  let skipped = 0;
  for (let index = 0; index < symbols.length; index += 1) {
    const symbol = symbols[index];
    const text = buildSymbolEmbeddingText(modelName, preparedInputs[index]);
    const prefixedText = applyDocumentPrefix(modelName, text);
    const cardHash = buildCardHash(
      symbol,
      prefixedText,
      jinaCacheCompatibilityKey,
    );
    const existing = existingEmbeddings.get(symbol.symbolId);
    if (existing?.cardHash === cardHash) {
      skipped += 1;
    } else {
      uncachedItems.push({ symbol, prefixedText, cardHash });
    }
  }
  uncachedItems.sort((left, right) => {
    const lengthOrder = left.prefixedText.length - right.prefixedText.length;
    return lengthOrder || left.symbol.symbolId.localeCompare(right.symbol.symbolId);
  });

  const batchSize = Math.max(
    1,
    Math.min(
      params.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE,
      MAX_EMBEDDING_BATCH_SIZE,
    ),
  );
  const maxConcurrency = Math.max(
    1,
    Math.min(params.concurrency ?? 1, MAX_EMBEDDING_CONCURRENCY),
  );
  const batches: Array<typeof uncachedItems> = [];
  for (let index = 0; index < uncachedItems.length; index += batchSize) {
    batches.push(uncachedItems.slice(index, index + batchSize));
  }

  const replacementItems: SymbolVectorEmbeddingBatchItem[] = [];
  recordMemorySnapshot("beforeInference");
  try {
    for (
      let chunkStart = 0;
      chunkStart < batches.length;
      chunkStart += maxConcurrency
    ) {
      const chunk = batches.slice(chunkStart, chunkStart + maxConcurrency);
      const chunkItems = await Promise.all(
        chunk.map(async (batch) => {
          let vectors: number[][];
          try {
            vectors = await measure("inference", () =>
              provider.embed(batch.map((item) => item.prefixedText)),
            );
          } catch (error) {
            recordEmbeddingFailure();
            throw new IndexError(
              `Symbol embedding provider failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (provider.isMockFallback?.()) {
            throw new IndexError(
              "Symbol embedding provider degraded to mock during refresh",
            );
          }
          if (vectors.length !== batch.length) {
            recordEmbeddingFailure();
            throw new IndexError(
              `Symbol embedding provider returned ${vectors.length} vectors for ${batch.length} inputs`,
            );
          }
          return batch.map((item, index) => {
            const vectorArray = vectors[index];
            if (vectorArray.length !== modelInfo.dimension) {
              throw new IndexError(
                `Symbol embedding dimension ${vectorArray.length} does not match ${modelInfo.dimension} for ${modelName}`,
              );
            }
            return {
              symbolId: item.symbol.symbolId,
              vector: toFloat16Blob(vectorArray),
              cardHash: item.cardHash,
              vectorArray,
            };
          });
        }),
      );
      for (const items of chunkItems) replacementItems.push(...items);
      params.onProgress?.({
        stage: "embeddings",
        current: Math.min(
          skipped + replacementItems.length,
          symbols.length,
        ),
        total: symbols.length,
        model: modelName,
      });
    }
  } finally {
    recordMemorySnapshot("afterInference");
  }

  const identity = resolveSymbolVectorPhysicalIdentity(
    params.repoId,
    modelName,
    params.semanticConfig,
  );
  let embedded = 0;
  let completeCount = 0;

  await runHnswRebuildCycle({
    preCheckpointPhase: "symbol-vector-reconcile-pre-write",
    postCheckpointPhase: "symbol-vector-reconcile-post-write",
    timeoutMs: params.postIndexSessionTimeoutMs,
    recordTiming: params.recordTiming,
    repoId: params.repoId,
    onFailureInsideGate: params.onFailureInsideGate,
    body: () =>
      withWriteConn(async (writeConn) => {
        const inspection = await inspectRepoSymbolVectorTable(
          writeConn,
          params.repoId,
        );
        const indexes = await showIndexesStrict(writeConn);
        const relevantIndexes = indexes.filter(
          (index) =>
            index.name === identity.indexName ||
            (index.tableName === identity.tableName &&
              index.property === identity.propertyName),
        );
        if (relevantIndexes.length > 1) {
          throw new IndexError(
            `Repository Symbol vector index identity for ${params.repoId}/${modelName} is ambiguous`,
          );
        }
        const expectedIndex = relevantIndexes[0];
        if (
          expectedIndex &&
          !isExpectedRepositoryVectorIndexIdentity(expectedIndex, identity)
        ) {
          throw new IndexError(
            `Repository Symbol vector index identity for ${params.repoId}/${modelName} is incompatible`,
          );
        }
        if (inspection.state === "absent" && expectedIndex) {
          throw new IndexError(
            `Repository Symbol vector index "${identity.indexName}" exists without its expected table`,
          );
        }
        await validateRepoSymbolVectorOwnership(
          writeConn,
          params.repoId,
          modelName,
        );
        await params.onReconciliationStep?.("catalog-classified");

        const preCount = await countCompleteRepoSymbolVectors(
          writeConn,
          params.repoId,
          modelName,
        );
        const healthRows = await getRepoSymbolVectorHealthRows(
          writeConn,
          params.repoId,
        );
        const staleSymbolIds = [
          ...new Set(
            healthRows.rows
              .filter(
                (row) =>
                  row.model === modelName &&
                  row.symbolId !== null &&
                  !eligibleSymbolIdSet.has(row.symbolId),
              )
              .map((row) => row.symbolId)
              .filter((symbolId): symbolId is string => symbolId !== null),
          ),
        ].sort((left, right) => left.localeCompare(right));
        const mutationCount = staleSymbolIds.length + replacementItems.length;
        const expectedIndexHealthy =
          expectedIndex !== undefined &&
          expectedIndex.status === "healthy" &&
          expectedIndex.extensionLoaded === true;
        const plan = planRepositorySymbolVectorReconciliation({
          actualPreCount: preCount,
          actualPostCount: preCount,
          mutationCount,
          expectedIndexHealthy,
          expectedIndexPresent: expectedIndex !== undefined,
        });
        let expectedIndexPresent = expectedIndex !== undefined;

        await params.onReconciliationStep?.("before-vector-mutation");
        if (plan.dropExpectedBeforeMutation) {
          await dropExpectedRepositoryVectorIndex(
            writeConn,
            identity.tableName,
            identity.indexName,
          );
          await params.onReconciliationStep?.("after-index-drop");
          expectedIndexPresent = false;
        }
        if (staleSymbolIds.length > 0) {
          await deleteRepoSymbolVectorEmbeddingsBySymbolIds(
            writeConn,
            params.repoId,
            modelName,
            staleSymbolIds,
          );
          await params.onReconciliationStep?.("after-vector-delete");
        }
        if (replacementItems.length > 0) {
          await setRepoSymbolVectorEmbeddingBatch(
            writeConn,
            params.repoId,
            modelName,
            replacementItems,
            {
              liveHnsw: plan.retainExpectedIndex,
              onOperation: params.onReconciliationStep,
            },
          );
        }
        embedded = replacementItems.length;
        await params.onReconciliationStep?.("after-vector-mutation");

        const postCount = await countCompleteRepoSymbolVectors(
          writeConn,
          params.repoId,
          modelName,
        );
        completeCount = postCount;
        const requiredMode = resolveRepositorySymbolVectorIndexMode(postCount);
        if (requiredMode === "exact" && expectedIndexPresent) {
          await dropExpectedRepositoryVectorIndex(
            writeConn,
            identity.tableName,
            identity.indexName,
          );
          await params.onReconciliationStep?.("after-index-drop");
          expectedIndexPresent = false;
        } else if (
          requiredMode === "hnsw" &&
          (!expectedIndexPresent || !expectedIndexHealthy)
        ) {
          if (expectedIndexPresent) {
            await dropExpectedRepositoryVectorIndex(
              writeConn,
              identity.tableName,
              identity.indexName,
            );
            await params.onReconciliationStep?.("after-index-drop");
          }
          recordMemorySnapshot("beforeHnsw");
          const hnswEventScope = {
            repoId: params.repoId,
            model: modelName,
            tableName: identity.tableName,
            propertyName: identity.propertyName,
            indexName: identity.indexName,
            completeCount: postCount,
          };
          emitPerRepoSymbolVectorEvent({
            type: "hnsw-start",
            ...hnswEventScope,
          });
          let created = false;
          try {
            created = await measure("hnsw.create", () =>
              createVectorIndex(
                writeConn,
                identity.tableName,
                identity.propertyName,
                identity.indexName,
                modelInfo.dimension,
                params.vectorEfc,
              ),
            );
          } finally {
            emitPerRepoSymbolVectorEvent({
              type: "hnsw-end",
              ...hnswEventScope,
              success: created,
            });
            recordMemorySnapshot("afterHnsw");
          }
          if (!created) {
            throw new IndexError(
              `Failed to create required repository vector index "${identity.indexName}"`,
            );
          }
          await params.onReconciliationStep?.("after-index-create");
          expectedIndexPresent = true;
        }
        await params.onReconciliationStep?.("after-index-reconcile");

        await validateRepoSymbolVectorOwnership(
          writeConn,
          params.repoId,
          modelName,
        );
        const finalRows = await getRepoSymbolVectorHealthRows(
          writeConn,
          params.repoId,
        );
        const finalIndexes = await showIndexesStrict(writeConn);
        assertCompleteRepositoryVectorCoverage({
          repoId: params.repoId,
          model: modelName,
          identity,
          eligibleSymbolIds,
          rows: finalRows.rows,
          indexes: finalIndexes,
          requireHnsw: requiredMode === "hnsw",
        });
        if (requiredMode === "hnsw") {
          const probe = await getRepoSymbolVectorProbe(
            writeConn,
            identity,
            params.repoId,
            modelName,
          );
          if (!probe) {
            throw new IndexError(
              `Repository vector index "${identity.indexName}" has no probe row`,
            );
          }
          await queryVectorIndexProbe(
            writeConn,
            identity,
            params.repoId,
            modelName,
            probe.vectorArray,
          );
        }
        await params.onReconciliationStep?.("after-validation");
      }),
  });

  emitPerRepoSymbolVectorEvent({
    type: "embedding-complete",
    repoId: params.repoId,
    model: modelName,
    tableName: identity.tableName,
    propertyName: identity.propertyName,
    indexName: identity.indexName,
    completeCount,
  });

  params.onProgress?.({
    stage: "embeddings",
    current: Math.min(skipped + embedded, symbols.length),
    total: symbols.length,
    model: modelName,
  });
  return { embedded, skipped };
}

function isExpectedRepositoryVectorIndexIdentity(
  index: IndexInfo,
  identity: ReturnType<typeof resolveSymbolVectorPhysicalIdentity>,
): boolean {
  return (
    index.name === identity.indexName &&
    index.tableName === identity.tableName &&
    index.type === "vector" &&
    index.property === identity.propertyName
  );
}

async function dropExpectedRepositoryVectorIndex(
  conn: Awaited<ReturnType<typeof getLadybugConn>>,
  tableName: string,
  indexName: string,
): Promise<void> {
  const result = await dropVectorIndex(conn, tableName, indexName);
  if (result.status === "failed") {
    throw new IndexError(
      `Failed to drop repository vector index "${indexName}": ${result.error}`,
    );
  }
}

function assertCompleteRepositoryVectorCoverage(params: {
  repoId: string;
  model: string;
  identity: ReturnType<typeof resolveSymbolVectorPhysicalIdentity>;
  eligibleSymbolIds: readonly string[];
  rows: Awaited<ReturnType<typeof getRepoSymbolVectorHealthRows>>["rows"];
  indexes: readonly IndexInfo[];
  requireHnsw: boolean;
}): void {
  const completeIds: string[] = [];
  for (const row of params.rows) {
    const mappedVectorPresent =
      params.identity.propertyName === "embeddingJinaCodeVec"
        ? row.embeddingJinaCodeVecPresent
        : row.embeddingNomicVecPresent;
    if (row.model !== params.model && !mappedVectorPresent) continue;
    if (
      row.repoId !== params.repoId ||
      row.model !== params.model ||
      !row.symbolId ||
      row.embeddingId !== `${params.model}:${row.symbolId}` ||
      !row.embeddingVectorPresent ||
      !row.cardHashPresent ||
      !mappedVectorPresent
    ) {
      throw new IndexError(
        `Repository vector row identity is invalid for ${params.repoId}/${params.model}`,
      );
    }
    completeIds.push(row.symbolId);
  }

  const eligible = [...params.eligibleSymbolIds].sort((left, right) =>
    left.localeCompare(right),
  );
  completeIds.sort((left, right) => left.localeCompare(right));
  if (
    eligible.length !== completeIds.length ||
    eligible.some((symbolId, index) => completeIds[index] !== symbolId)
  ) {
    throw new IndexError(
      `Repository vector coverage is incomplete for ${params.repoId}/${params.model}`,
    );
  }

  const relevant = params.indexes.filter(
    (index) =>
      index.name === params.identity.indexName ||
      (index.tableName === params.identity.tableName &&
        index.property === params.identity.propertyName),
  );
  const healthyExpected =
    relevant.length === 1 &&
    isExpectedRepositoryVectorIndexIdentity(relevant[0], params.identity) &&
    relevant[0].status === "healthy" &&
    relevant[0].extensionLoaded === true;
  if (
    (params.requireHnsw && !healthyExpected) ||
    (!params.requireHnsw && relevant.length !== 0)
  ) {
    throw new IndexError(
      `Repository vector catalog is not reconciled for ${params.repoId}/${params.model}`,
    );
  }
}
