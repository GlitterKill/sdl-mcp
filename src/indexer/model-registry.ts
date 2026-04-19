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

export interface ModelInfo {
  name: string;
  dimension: number;
  maxSequenceLength: number;
  bundled: boolean;
  modelFile: string;
  tokenizerFile: string;
  configFile: string;
  description: string;
  downloadUrls?: {
    model: string;
    tokenizer: string;
    config: string;
  };
  /**
   * Fallback URLs tried when the primary `downloadUrls` host fails (e.g.
   * HuggingFace outage, geoblock, rate limit). Typically points at a mirror
   * under the project's own GitHub Releases or CDN.
   */
  fallbackDownloadUrls?: {
    model: string;
    tokenizer: string;
    config: string;
  };
  /** Prefix prepended to text at index time (e.g. nomic "search_document: "). */
  documentPrefix?: string;
  /** Prefix prepended to text at search/query time (e.g. nomic "search_query: "). */
  queryPrefix?: string;
  /** Maximum download size in bytes per file (defense against oversized payloads). */
  maxDownloadBytes?: number;
}

const MODEL_REGISTRY: Record<string, ModelInfo> = {
  "jina-embeddings-v2-base-code": {
    name: "jina-embeddings-v2-base-code",
    dimension: 768,
    maxSequenceLength: 8192,
    bundled: false,
    modelFile: "model_quantized.onnx",
    tokenizerFile: "tokenizer.json",
    configFile: "config.json",
    description:
      "Code-specialized embedding model for 30+ programming languages (768-dim, ~162MB quantized, fetched on postinstall)",
    downloadUrls: {
      model:
        "https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/main/onnx/model_quantized.onnx",
      tokenizer:
        "https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/main/tokenizer.json",
      config:
        "https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/main/config.json",
    },
    fallbackDownloadUrls: {
      model:
        "https://github.com/GlitterKill/sdl-mcp/releases/download/models-v1/jina-embeddings-v2-base-code-model_quantized.onnx",
      tokenizer:
        "https://github.com/GlitterKill/sdl-mcp/releases/download/models-v1/jina-embeddings-v2-base-code-tokenizer.json",
      config:
        "https://github.com/GlitterKill/sdl-mcp/releases/download/models-v1/jina-embeddings-v2-base-code-config.json",
    },
    maxDownloadBytes: 200_000_000, // ~162MB model + tokenizer + config
  },
  "nomic-embed-text-v1.5": {
    name: "nomic-embed-text-v1.5",
    dimension: 768,
    maxSequenceLength: 8192,
    bundled: false,
    modelFile: "model_quantized.onnx",
    tokenizerFile: "tokenizer.json",
    configFile: "config.json",
    description:
      "High-quality text embedding model with Matryoshka support (768-dim, ~138MB quantized, ungated, fetched on postinstall)",
    downloadUrls: {
      model:
        "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model_quantized.onnx",
      tokenizer:
        "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/tokenizer.json",
      config:
        "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/config.json",
    },
    fallbackDownloadUrls: {
      model:
        "https://github.com/GlitterKill/sdl-mcp/releases/download/models-v1/nomic-embed-text-v1.5-model_quantized.onnx",
      tokenizer:
        "https://github.com/GlitterKill/sdl-mcp/releases/download/models-v1/nomic-embed-text-v1.5-tokenizer.json",
      config:
        "https://github.com/GlitterKill/sdl-mcp/releases/download/models-v1/nomic-embed-text-v1.5-config.json",
    },
    documentPrefix: "search_document: ",
    queryPrefix: "search_query: ",
    maxDownloadBytes: 200_000_000, // ~138MB model + tokenizer + config
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
 * Resolve the full path to a model's ONNX file.
 */
export function resolveModelPath(name: string): string {
  const info = getModelInfo(name);
  return join(resolveModelDir(name), info.modelFile);
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
 */
export function isModelAvailable(name: string): boolean {
  const info = getModelInfo(name);
  const dir = resolveModelDir(name);
  return (
    existsSync(join(dir, info.modelFile)) &&
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
