/**
 * embeddings-local.ts — ONNX inference engine for local embedding generation.
 *
 * Creates ONNX sessions backed by real sentence-transformer models (jina-embeddings-v2-base-code or
 * nomic-embed-text-v1.5). Handles tokenization, batched inference, mean pooling, and
 * L2-normalization.
 *
 * Falls back gracefully when onnxruntime-node or tokenizers packages are unavailable.
 */
import { availableParallelism } from "node:os";
import { loadConfig } from "../config/loadConfig.js";
import { logger } from "../util/logger.js";
import {
  getModelInfo,
  resolveModelPath,
  resolveTokenizerPath,
} from "./model-registry.js";
import { ensureModelAvailable } from "./model-downloader.js";

// ── Minimal type interfaces for optional dependencies ────────────────────────
// These avoid importing from optional packages at the type level.

/** Subset of onnxruntime-node's InferenceSession we use */
interface OrtSession {
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
  inputNames: readonly string[];
}

/** Subset of the tokenizers Encoding we use */
interface TokenizerEncoding {
  getIds(): number[];
  getAttentionMask(): number[];
  getTypeIds(): number[];
}

/** Subset of the tokenizers Tokenizer we use */
interface HfTokenizer {
  encodeBatch(
    sentences: string[],
    options?: { addSpecialTokens?: boolean },
  ): Promise<TokenizerEncoding[]>;
  setPadding(options?: { padId?: number; padToken?: string }): void;
  setTruncation(maxLength: number): void;
}

/** ort module subset */
interface OrtModule {
  InferenceSession: {
    create(
      path: string,
      options?: {
        executionProviders?: string[];
        intraOpNumThreads?: number;
        interOpNumThreads?: number;
        executionMode?: "sequential" | "parallel";
        graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
        logSeverityLevel?: 0 | 1 | 2 | 3 | 4;
      },
    ): Promise<OrtSession>;
  };
  Tensor: new (
    type: string,
    data: BigInt64Array,
    dims: readonly number[],
  ) => unknown;
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface LocalEmbeddingRuntime {
  available: boolean;
  reason?: string;
}

export interface OnnxEmbeddingSession {
  embed(texts: string[]): Promise<number[][]>;
  dimension: number;
  modelName: string;
  dispose(): void;
}

// ── Runtime detection ────────────────────────────────────────────────────────

let cachedRuntime: LocalEmbeddingRuntime | null = null;

/**
 * Check if local embedding runtime dependencies (onnxruntime-node + tokenizers)
 * are available.
 */
export async function ensureLocalEmbeddingRuntime(): Promise<LocalEmbeddingRuntime> {
  if (cachedRuntime) {
    return cachedRuntime;
  }

  try {
    await import(/* @vite-ignore */ "onnxruntime-node");
  } catch (error) {
    cachedRuntime = {
      available: false,
      reason: `onnxruntime-node not available: ${error instanceof Error ? error.message : String(error)}`,
    };
    return cachedRuntime;
  }

  try {
    await import(/* @vite-ignore */ "tokenizers");
  } catch (error) {
    cachedRuntime = {
      available: false,
      reason: `tokenizers package not available: ${error instanceof Error ? error.message : String(error)}`,
    };
    return cachedRuntime;
  }

  cachedRuntime = { available: true };
  return cachedRuntime;
}

/** Reset cached runtime state (for testing) */
export async function resetLocalEmbeddingRuntime(): Promise<void> {
  cachedRuntime = null;
  const disposePromises = Array.from(sessionCache.values(), async (sessionPromise) => {
    try {
      const session = await sessionPromise;
      session.dispose();
    } catch (error) {
      logger.debug("Failed to dispose cached embedding session during reset", {
        error,
      });
    }
  });
  await Promise.allSettled(disposePromises);
  sessionCache.clear();
}

// ── Session management ───────────────────────────────────────────────────────

/** Singleton session cache — load each model once, reuse across all embedding calls. */
const sessionCache = new Map<string, Promise<OnnxEmbeddingSession>>();

/** Maximum texts per ONNX inference call */
const INFERENCE_BATCH_SIZE = 32;

/**
 * Create (or retrieve cached) ONNX embedding session for the given model.
 *
 * 1. Resolves model path via model-registry (bundled or cache dir)
 * 2. For non-bundled models, downloads from HuggingFace if missing
 * 3. Loads ONNX InferenceSession and HuggingFace tokenizer
 * 4. Returns session object with `embed()` method
 */
export async function createOnnxSession(
  modelName: string,
): Promise<OnnxEmbeddingSession> {
  const existing = sessionCache.get(modelName);
  if (existing) {
    return existing;
  }

  const sessionPromise = createOnnxSessionInternal(modelName);
  sessionCache.set(modelName, sessionPromise);

  try {
    return await sessionPromise;
  } catch (error) {
    sessionCache.delete(modelName);
    throw error;
  }
}

/**
 * Per-platform allow-list of execution providers shipped with the default
 * `onnxruntime-node` npm package (no separate build required):
 *
 *   - Windows x64: `cpu`, `dml` (DirectML — any DX12 GPU: NVIDIA, AMD
 *     Radeon, Intel Arc, integrated GPUs), `webgpu`.
 *   - macOS x64 / arm64: `cpu`, `coreml` (Apple Silicon ANE/GPU + Intel
 *     Mac GPU).
 *   - Linux x64: `cpu`, `cuda`, `tensorrt`. CUDA EP requires NVIDIA GPU
 *     plus CUDA 12 driver + cuDNN installed on the host system; the
 *     binaries ship in the package but won't initialise without the
 *     runtime libraries.
 *   - Linux arm64: `cpu` only.
 *
 * Out of scope (require building ORT from source or vendor-specific
 * forks): ROCm (AMD on Linux), OpenVINO (Intel CPU/GPU/NPU), QNN
 * (Qualcomm), MIGraphX. Users wanting these can swap `onnxruntime-node`
 * for a custom build at the package level — sdl-mcp will pick up the
 * additional providers automatically since this filter only drops
 * KNOWN-bad entries on each platform.
 */
/** @internal exported for tests; do not consume from product code. */
export function platformAllowedProviders(): readonly string[] {
  if (process.platform === "win32") {
    return ["cpu", "dml", "webgpu"];
  }
  if (process.platform === "darwin") {
    return ["cpu", "coreml"];
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return ["cpu", "cuda", "tensorrt"];
  }
  // Linux arm64, freebsd, etc. — CPU only in the default package.
  return ["cpu"];
}

/**
 * Resolve the user's requested execution-provider list against the
 * platform's bundled providers. Drops unsupported entries with a one-time
 * warning, and appends `"cpu"` as the final fallback so session creation
 * always has at least one viable provider.
 */
/**
 * @internal exported for tests. Resolves the user's requested execution-
 * provider list against the platform's bundled providers. Drops
 * unsupported entries with a one-time warning, and appends `"cpu"` as
 * the final fallback so session creation always has at least one viable
 * provider.
 *
 * The optional `platformOverride` parameter lets tests simulate
 * different platforms without spawning a child process. Production
 * callers always omit it.
 */
export function resolveExecutionProviders(
  requested: readonly string[] | undefined,
  platformOverride?: readonly string[],
): string[] {
  const allowed = new Set(platformOverride ?? platformAllowedProviders());
  const result: string[] = [];
  const dropped: string[] = [];
  for (const provider of requested ?? ["cpu"]) {
    const normalised = provider.toLowerCase();
    if (allowed.has(normalised)) {
      if (!result.includes(normalised)) result.push(normalised);
    } else if (!dropped.includes(normalised)) {
      dropped.push(normalised);
    }
  }
  if (dropped.length > 0) {
    logger.warn(
      `[embeddings-local] Dropping unsupported execution providers on ${process.platform}: [${dropped.join(", ")}]. Bundled providers: [${[...allowed].join(", ")}]. Install a separate onnxruntime-node build for CUDA / ROCm / TensorRT.`,
    );
  }
  if (!result.includes("cpu")) result.push("cpu");
  return result;
}

async function createOnnxSessionInternal(
  modelName: string,
): Promise<OnnxEmbeddingSession> {
  const runtime = await ensureLocalEmbeddingRuntime();
  if (!runtime.available) {
    throw new Error(`Local embedding runtime unavailable: ${runtime.reason}`);
  }

  const modelInfo = getModelInfo(modelName);
  const appConfig = loadConfig();
  const onnxConfig = appConfig.semantic?.onnx;
  const requestedVariant = appConfig.semantic?.modelVariant;

  // Ensure model files are available (downloads if needed for non-bundled models)
  await ensureModelAvailable(modelName, requestedVariant);

  const modelPath = resolveModelPath(modelName, requestedVariant);
  const tokenizerPath = resolveTokenizerPath(modelName);

  logger.info(
    `Loading ONNX model "${modelName}" (${modelInfo.dimension}-dim, variant="${requestedVariant ?? modelInfo.defaultVariant}")...`,
  );

  // Dynamic imports — these are optional dependencies
  const ort = (await import(
    /* @vite-ignore */ "onnxruntime-node"
  )) as unknown as OrtModule;
  const tokenizersMod = (await import(
    /* @vite-ignore */ "tokenizers"
  )) as unknown as {
    Tokenizer: { fromFile(path: string): HfTokenizer };
  };

  // Resolve ORT thread-pool sizing from semantic.onnx config. Default 0
  // (== "auto") resolves to the visible logical-thread count via
  // `os.availableParallelism()`. ORT's own default is physical cores, which
  // leaves SMT lanes idle; on the AMD 9000 X3D series this halves further
  // because the Provider Driver pins single-process workloads to one CCD.
  const autoThreads = availableParallelism();
  const intraOpNumThreads =
    onnxConfig?.intraOpNumThreads && onnxConfig.intraOpNumThreads > 0
      ? onnxConfig.intraOpNumThreads
      : autoThreads;
  const interOpNumThreads =
    onnxConfig?.interOpNumThreads && onnxConfig.interOpNumThreads > 0
      ? onnxConfig.interOpNumThreads
      : 1;
  const executionMode = onnxConfig?.executionMode ?? "sequential";

  // Resolve execution providers: filter user list against the platform's
  // bundled `onnxruntime-node` build, append `"cpu"` as final fallback so
  // a missing GPU provider can never strand session creation.
  const executionProviders = resolveExecutionProviders(
    appConfig.semantic?.executionProviders,
  );

  logger.info(
    `ONNX session "${modelName}" thread config: intra=${intraOpNumThreads}, inter=${interOpNumThreads}, mode=${executionMode}, providers=[${executionProviders.join(", ")}]`,
  );

  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders,
    intraOpNumThreads,
    interOpNumThreads,
    executionMode,
    logSeverityLevel: 3,
  });

  // Tokenizer.fromFile() is synchronous (napi-rs binding)
  const tokenizer = tokenizersMod.Tokenizer.fromFile(tokenizerPath);
  tokenizer.setPadding({ padId: 0, padToken: "[PAD]" });
  tokenizer.setTruncation(modelInfo.maxSequenceLength);

  const dimension = modelInfo.dimension;

  logger.info(
    `ONNX model "${modelName}" loaded (dim=${dimension}, maxSeqLen=${modelInfo.maxSequenceLength})`,
  );

  const onnxSession: OnnxEmbeddingSession = {
    dimension,
    modelName,

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }

      const allEmbeddings: number[][] = [];

      // Process in batches of INFERENCE_BATCH_SIZE
      for (let i = 0; i < texts.length; i += INFERENCE_BATCH_SIZE) {
        const batch = texts.slice(i, i + INFERENCE_BATCH_SIZE);
        const batchEmbeddings = await runBatchInference(
          session,
          tokenizer,
          batch,
          dimension,
          ort,
        );
        allEmbeddings.push(...batchEmbeddings);
      }

      return allEmbeddings;
    },

    dispose(): void {
      sessionCache.delete(modelName);
    },
  };

  return onnxSession;
}

// ── Inference internals ──────────────────────────────────────────────────────

async function runBatchInference(
  session: OrtSession,
  tokenizer: HfTokenizer,
  texts: string[],
  dimension: number,
  ort: OrtModule,
): Promise<number[][]> {
  const batchSize = texts.length;

  // 1. Tokenize batch (async) — setPadding ensures all sequences padded to batch-max
  const encodings = await tokenizer.encodeBatch(texts, {
    addSpecialTokens: true,
  });

  // 2. Get sequence length (all same after padding)
  const seqLen = encodings[0].getIds().length;

  // 3. Build padded int64 tensors for ONNX
  const inputIds = new BigInt64Array(batchSize * seqLen);
  const attentionMask = new BigInt64Array(batchSize * seqLen);
  const tokenTypeIds = new BigInt64Array(batchSize * seqLen);

  for (let b = 0; b < batchSize; b++) {
    const ids = encodings[b].getIds();
    const masks = encodings[b].getAttentionMask();
    const types = encodings[b].getTypeIds();
    const offset = b * seqLen;

    for (let s = 0; s < seqLen; s++) {
      inputIds[offset + s] = BigInt(ids[s] ?? 0);
      attentionMask[offset + s] = BigInt(masks[s] ?? 0);
      tokenTypeIds[offset + s] = BigInt(types[s] ?? 0);
    }
  }

  // 4. Create ONNX tensor feeds
  const dims = [batchSize, seqLen] as const;
  const feeds: Record<string, unknown> = {
    input_ids: new ort.Tensor("int64", inputIds, dims),
    attention_mask: new ort.Tensor("int64", attentionMask, dims),
  };

  // Some models (Jina) expect token_type_ids; nomic may not
  if (session.inputNames.includes("token_type_ids")) {
    feeds.token_type_ids = new ort.Tensor("int64", tokenTypeIds, dims);
  }

  // 5. Run inference
  const output = await session.run(feeds);

  // 6. Extract hidden states — output key varies by model export
  const outputKey =
    "last_hidden_state" in output
      ? "last_hidden_state"
      : "token_embeddings" in output
        ? "token_embeddings"
        : Object.keys(output)[0];
  const outputTensor = output[outputKey];
  const outputData = outputTensor.data;
  const embedDim = outputTensor.dims[2] ?? dimension;

  // 7. Mean pool + L2-normalize for each sequence
  const embeddings: number[][] = [];
  for (let b = 0; b < batchSize; b++) {
    const vec = new Array<number>(embedDim).fill(0);
    let tokenCount = 0;

    for (let s = 0; s < seqLen; s++) {
      // Only pool over non-padding tokens (attention_mask == 1)
      if (attentionMask[b * seqLen + s] === 1n) {
        const hsOffset = (b * seqLen + s) * embedDim;
        for (let d = 0; d < embedDim; d++) {
          vec[d] += outputData[hsOffset + d];
        }
        tokenCount++;
      }
    }

    // Average
    if (tokenCount > 0) {
      for (let d = 0; d < embedDim; d++) {
        vec[d] /= tokenCount;
      }
    }

    // L2-normalize
    embeddings.push(normalizeVector(vec));
  }

  return embeddings;
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
  if (norm <= 1e-9) {
    return vector;
  }
  return vector.map((v) => v / norm);
}
