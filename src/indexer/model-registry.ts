/**
 * model-registry.ts — Model metadata, path resolution, and cache directory management
 * for the semantic embedding pipeline.
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { loadConfig } from "../config/loadConfig.js";

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
}

const MODEL_REGISTRY: Record<string, ModelInfo> = {
  "all-MiniLM-L6-v2": {
    name: "all-MiniLM-L6-v2",
    dimension: 384,
    maxSequenceLength: 256,
    bundled: true,
    modelFile: "model_quantized.onnx",
    tokenizerFile: "tokenizer.json",
    configFile: "config.json",
    description:
      "General-purpose sentence embedding model (384-dim, ~22MB INT8 quantized)",
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
      "High-quality text embedding model with Matryoshka support (768-dim, ~138MB quantized, ungated)",
    downloadUrls: {
      model:
        "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model_quantized.onnx",
      tokenizer:
        "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/tokenizer.json",
      config:
        "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/config.json",
    },
  },
};

/**
 * Get model metadata by name. Throws if model is unknown.
 */
export function getModelInfo(name: string): ModelInfo {
  const info = MODEL_REGISTRY[name];
  if (!info) {
    const known = Object.keys(MODEL_REGISTRY).join(", ");
    throw new Error(
      `Unknown embedding model "${name}". Available models: ${known}`,
    );
  }
  return info;
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
  return name in MODEL_REGISTRY;
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
  } catch {
    // Config may not be available yet (e.g., during init).
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
