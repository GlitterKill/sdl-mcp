/**
 * model-registry.ts — Model metadata, path resolution, and cache directory management
 * for the semantic embedding pipeline.
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { loadConfig } from "../config/loadConfig.js";
import { logger } from "../util/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * One ONNX model file variant (e.g. fp32, fp16, int8). Each model can ship
 * several variants on HuggingFace; this struct captures the per-variant
 * filename, primary download URL, and an optional fallback mirror.
 */
export interface ModelVariantInfo {
  /** ONNX filename inside the model's directory (e.g. "model_int8.onnx"). */
  modelFile: string;
  /** Primary download URL (typically HuggingFace `resolve/main/onnx/<file>`). */
  downloadUrl: string;
  /**
   * Optional fallback mirror, tried when the primary fails (HF outage,
   * geoblock, rate limit). Points at a project-owned mirror.
   */
  fallbackDownloadUrl?: string;
  /**
   * Maximum download size in bytes for this specific variant. Defense
   * against oversized payloads when a mirror returns the wrong file.
   */
  maxDownloadBytes?: number;
}

export interface ModelInfo {
  name: string;
  dimension: number;
  maxSequenceLength: number;
  bundled: boolean;
  /**
   * Default variant name used when the caller does not specify one. Picked
   * to balance speed and quality; for current models this is the int8
   * `model_quantized.onnx` produced by HF's quantization pipeline.
   */
  defaultVariant: string;
  /**
   * All ONNX variants available for this model. Variant names are stable
   * identifiers: "default", "fp32", "fp16", "int8", "uint8", "q4",
   * "q4f16", "bnb4". Not every model ships every variant — `defaultVariant`
   * MUST be present in this map.
   */
  variants: Record<string, ModelVariantInfo>;
  tokenizerFile: string;
  configFile: string;
  description: string;
  /**
   * Tokenizer + config download URLs are shared across variants. Variant-
   * specific model URLs live in `variants[name].downloadUrl`.
   */
  downloadUrls?: {
    tokenizer: string;
    config: string;
  };
  /**
   * Fallback URLs for the shared (tokenizer/config) files.
   */
  fallbackDownloadUrls?: {
    tokenizer: string;
    config: string;
  };
  /** Prefix prepended to text at index time (e.g. nomic "search_document: "). */
  documentPrefix?: string;
  /** Prefix prepended to text at search/query time (e.g. nomic "search_query: "). */
  queryPrefix?: string;
}

const HF_JINA = "https://huggingface.co/jinaai/jina-embeddings-v2-base-code";
const HF_NOMIC = "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5";
const GH_RELEASES =
  "https://github.com/GlitterKill/sdl-mcp/releases/download/models-v1";

const MODEL_REGISTRY: Record<string, ModelInfo> = {
  "jina-embeddings-v2-base-code": {
    name: "jina-embeddings-v2-base-code",
    dimension: 768,
    maxSequenceLength: 8192,
    bundled: false,
    defaultVariant: "default",
    variants: {
      // `default` and `int8` map to the same file — HF's quantized variant
      // is dynamic int8. Keep both keys as aliases so users can pick either
      // name without surprise.
      default: {
        modelFile: "model_quantized.onnx",
        downloadUrl: `${HF_JINA}/resolve/main/onnx/model_quantized.onnx`,
        fallbackDownloadUrl: `${GH_RELEASES}/jina-embeddings-v2-base-code-model_quantized.onnx`,
        maxDownloadBytes: 200_000_000,
      },
      int8: {
        modelFile: "model_quantized.onnx",
        downloadUrl: `${HF_JINA}/resolve/main/onnx/model_quantized.onnx`,
        fallbackDownloadUrl: `${GH_RELEASES}/jina-embeddings-v2-base-code-model_quantized.onnx`,
        maxDownloadBytes: 200_000_000,
      },
      fp16: {
        modelFile: "model_fp16.onnx",
        downloadUrl: `${HF_JINA}/resolve/main/onnx/model_fp16.onnx`,
        maxDownloadBytes: 400_000_000,
      },
      fp32: {
        modelFile: "model.onnx",
        downloadUrl: `${HF_JINA}/resolve/main/onnx/model.onnx`,
        maxDownloadBytes: 800_000_000,
      },
    },
    tokenizerFile: "tokenizer.json",
    configFile: "config.json",
    description:
      "Code-specialized embedding model for 30+ programming languages (768-dim). Variants: default/int8 (~162MB), fp16 (~321MB), fp32 (~642MB). Fetched on postinstall.",
    downloadUrls: {
      tokenizer: `${HF_JINA}/resolve/main/tokenizer.json`,
      config: `${HF_JINA}/resolve/main/config.json`,
    },
    fallbackDownloadUrls: {
      tokenizer: `${GH_RELEASES}/jina-embeddings-v2-base-code-tokenizer.json`,
      config: `${GH_RELEASES}/jina-embeddings-v2-base-code-config.json`,
    },
  },
  "nomic-embed-text-v1.5": {
    name: "nomic-embed-text-v1.5",
    dimension: 768,
    maxSequenceLength: 8192,
    bundled: false,
    defaultVariant: "default",
    variants: {
      // Nomic ships every common quantization. `default` and `int8` are
      // aliases for the same dynamic-int8 file.
      default: {
        modelFile: "model_quantized.onnx",
        downloadUrl: `${HF_NOMIC}/resolve/main/onnx/model_quantized.onnx`,
        fallbackDownloadUrl: `${GH_RELEASES}/nomic-embed-text-v1.5-model_quantized.onnx`,
        maxDownloadBytes: 200_000_000,
      },
      int8: {
        modelFile: "model_int8.onnx",
        downloadUrl: `${HF_NOMIC}/resolve/main/onnx/model_int8.onnx`,
        maxDownloadBytes: 200_000_000,
      },
      uint8: {
        modelFile: "model_uint8.onnx",
        downloadUrl: `${HF_NOMIC}/resolve/main/onnx/model_uint8.onnx`,
        maxDownloadBytes: 200_000_000,
      },
      q4: {
        modelFile: "model_q4.onnx",
        downloadUrl: `${HF_NOMIC}/resolve/main/onnx/model_q4.onnx`,
        maxDownloadBytes: 200_000_000,
      },
      q4f16: {
        modelFile: "model_q4f16.onnx",
        downloadUrl: `${HF_NOMIC}/resolve/main/onnx/model_q4f16.onnx`,
        maxDownloadBytes: 150_000_000,
      },
      bnb4: {
        modelFile: "model_bnb4.onnx",
        downloadUrl: `${HF_NOMIC}/resolve/main/onnx/model_bnb4.onnx`,
        maxDownloadBytes: 200_000_000,
      },
      fp16: {
        modelFile: "model_fp16.onnx",
        downloadUrl: `${HF_NOMIC}/resolve/main/onnx/model_fp16.onnx`,
        maxDownloadBytes: 350_000_000,
      },
      fp32: {
        modelFile: "model.onnx",
        downloadUrl: `${HF_NOMIC}/resolve/main/onnx/model.onnx`,
        maxDownloadBytes: 700_000_000,
      },
    },
    tokenizerFile: "tokenizer.json",
    configFile: "config.json",
    description:
      "High-quality text embedding model with Matryoshka support (768-dim). Variants: default/int8/uint8/quantized (~137MB), q4 (~165MB), q4f16 (~111MB), bnb4 (~158MB), fp16 (~274MB), fp32 (~547MB). Fetched on postinstall.",
    downloadUrls: {
      tokenizer: `${HF_NOMIC}/resolve/main/tokenizer.json`,
      config: `${HF_NOMIC}/resolve/main/config.json`,
    },
    fallbackDownloadUrls: {
      tokenizer: `${GH_RELEASES}/nomic-embed-text-v1.5-tokenizer.json`,
      config: `${GH_RELEASES}/nomic-embed-text-v1.5-config.json`,
    },
    documentPrefix: "search_document: ",
    queryPrefix: "search_query: ",
  },
};

/**
 * Get model metadata by name. Throws if model is unknown.
 */
export function getModelInfo(name: string): ModelInfo {
  if (!Object.hasOwn(MODEL_REGISTRY, name)) {
    const known = Object.keys(MODEL_REGISTRY).join(", ");
    throw new Error(
      `Unknown embedding model "${name}". Available models: ${known}`,
    );
  }
  return MODEL_REGISTRY[name];
}

/**
 * List all registered model names.
 */
export function listModels(): string[] {
  return Object.keys(MODEL_REGISTRY);
}

/**
 * Check if a model name is known to the registry.
 */
export function isKnownModel(name: string): boolean {
  return Object.hasOwn(MODEL_REGISTRY, name);
}

/**
 * Get the platform-specific cache directory for downloaded models.
 * Order of resolution:
 *   1. `semantic.modelCacheDir` from config (if set)
 *   2. `%LOCALAPPDATA%/sdl-mcp/models/` (Windows)
 *   3. `~/.cache/sdl-mcp/models/` (Linux/Mac)
 */
export function getModelCacheDir(): string {
  try {
    const config = loadConfig();
    const configCacheDir = config.semantic?.modelCacheDir;
    if (configCacheDir) {
      return configCacheDir;
    }
  } catch (err) {
    logger.warn("Config not available for model registry, using defaults", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      return join(localAppData, "sdl-mcp", "models");
    }
  }

  return join(homedir(), ".cache", "sdl-mcp", "models");
}

/**
 * Resolve the directory path where a model's files should live.
 * - Bundled models: `<package-root>/models/<model-name>/`
 * - Downloaded models: `<cache-dir>/<model-name>/`
 */
export function resolveModelDir(name: string): string {
  const info = getModelInfo(name);
  if (info.bundled) {
    // Walk up from src/indexer/ → package root, then into models/
    return join(__dirname, "..", "..", "models", name);
  }
  return join(getModelCacheDir(), name);
}

/**
 * Resolve which model variant to use for `name`. If `requested` is
 * undefined or unknown to this model, falls back to the model's
 * `defaultVariant` (with a warning when the user's choice was not honoured).
 *
 * Variant resolution is its own concern so callers can resolve once and
 * reuse the variant info across `resolveModelPath`, `isModelAvailable`,
 * and `ensureModelAvailable` without re-doing the lookup.
 */
export function resolveVariant(
  name: string,
  requested?: string,
): { variantName: string; variant: ModelVariantInfo } {
  const info = getModelInfo(name);
  if (requested && requested in info.variants) {
    return { variantName: requested, variant: info.variants[requested] };
  }
  if (requested && requested !== info.defaultVariant) {
    const supported = Object.keys(info.variants).join(", ");
    logger.warn(
      `Model "${name}" does not provide variant "${requested}"; falling back to "${info.defaultVariant}". Supported variants: ${supported}`,
    );
  }
  return {
    variantName: info.defaultVariant,
    variant: info.variants[info.defaultVariant],
  };
}

/**
 * Resolve the full path to a model's ONNX file. When `variant` is omitted,
 * returns the path to the default variant for the model.
 */
export function resolveModelPath(name: string, variant?: string): string {
  const { variant: v } = resolveVariant(name, variant);
  return join(resolveModelDir(name), v.modelFile);
}

/**
 * Resolve the full path to a model's tokenizer.json file.
 */
export function resolveTokenizerPath(name: string): string {
  const info = getModelInfo(name);
  return join(resolveModelDir(name), info.tokenizerFile);
}

/**
 * Check whether all required model files exist at the resolved path.
 * `variant` controls which variant's ONNX file is checked; defaults to the
 * model's `defaultVariant`. Tokenizer/config are shared across variants.
 */
export function isModelAvailable(name: string, variant?: string): boolean {
  const info = getModelInfo(name);
  const { variant: v } = resolveVariant(name, variant);
  const dir = resolveModelDir(name);
  return (
    existsSync(join(dir, v.modelFile)) &&
    existsSync(join(dir, info.tokenizerFile))
  );
}

/**
 * Apply the model's document prefix to text at index/embedding time.
 * Returns text unchanged for models without a document prefix.
 */
export function applyDocumentPrefix(model: string, text: string): string {
  if (!Object.hasOwn(MODEL_REGISTRY, model)) return text;
  const info = MODEL_REGISTRY[model];
  return info?.documentPrefix ? `${info.documentPrefix}${text}` : text;
}

/**
 * Apply the model's query prefix to text at search/retrieval time.
 * Returns text unchanged for models without a query prefix.
 */
export function applyQueryPrefix(model: string, text: string): string {
  if (!Object.hasOwn(MODEL_REGISTRY, model)) return text;
  const info = MODEL_REGISTRY[model];
  return info?.queryPrefix ? `${info.queryPrefix}${text}` : text;
}
