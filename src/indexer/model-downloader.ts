/**
 * model-downloader.ts — On-demand model download for non-bundled models (e.g., nomic-embed-text-v1.5).
 * Downloads model files from HuggingFace and caches them in the platform-specific cache directory.
 */
import {
  existsSync,
  mkdirSync,
  createWriteStream,
  statSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { pipeline } from "stream/promises";
import { logger } from "../util/logger.js";
import {
  getModelInfo,
  resolveModelDir,
  isModelAvailable,
} from "./model-registry.js";

/**
 * Ensure a model's files are available locally.
 * - For bundled models: verifies files exist, throws if missing.
 * - For downloadable models: downloads from HuggingFace if not cached.
 * Returns the directory path where the model files live.
 */
export async function ensureModelAvailable(name: string): Promise<string> {
  const info = getModelInfo(name);
  const modelDir = resolveModelDir(name);

  if (isModelAvailable(name)) {
    return modelDir;
  }

  if (info.bundled) {
    throw new Error(
      `Bundled model "${name}" files not found at ${modelDir}. ` +
        `Run "node scripts/download-models.mjs" to fetch them.`,
    );
  }

  if (!info.downloadUrls) {
    throw new Error(
      `Model "${name}" is not bundled and has no download URLs configured.`,
    );
  }

  const sizeHint =
    name === "nomic-embed-text-v1.5"
        ? "138MB"
        : name === "jina-embeddings-v2-base-code"
          ? "110MB"
          : "unknown size";
  logger.info(`Downloading model "${name}" (~${sizeHint})...`);
  mkdirSync(modelDir, { recursive: true });

  const filesToDownload = [
    { name: info.modelFile, url: info.downloadUrls.model },
    { name: info.tokenizerFile, url: info.downloadUrls.tokenizer },
    { name: info.configFile, url: info.downloadUrls.config },
  ];

  for (const file of filesToDownload) {
    const destPath = join(modelDir, file.name);
    if (existsSync(destPath)) {
      logger.debug(`  [skip] ${file.name} already exists`);
      continue;
    }

    logger.info(`  Downloading ${file.name}...`);
    try {
      await downloadFile(file.url, destPath, {
        maxBytes: info.maxDownloadBytes,
      });
      const stats = statSync(destPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
      logger.info(`  Downloaded ${file.name} (${sizeMB} MB)`);
    } catch (error) {
      throw new Error(
        `Failed to download ${file.name} for model "${name}": ${error instanceof Error ? error.message : String(error)}. ` +
          `You can try downloading manually with: node scripts/download-models.mjs ${name}`,
      );
    }
  }

  logger.info(`Model "${name}" ready at ${modelDir}`);
  return modelDir;
}

async function downloadFile(
  url: string,
  destPath: string,
  opts?: { maxBytes?: number },
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("Response body is null");
  }

  // Enforce size cap from Content-Length header when available.
  const maxBytes = opts?.maxBytes ?? 500_000_000; // 500 MB default cap
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 0 && contentLength > maxBytes) {
    throw new Error(
      `Download too large: Content-Length ${contentLength} exceeds limit ${maxBytes}`,
    );
  }

  const fileStream = createWriteStream(destPath);
  try {
    // Node 20+ fetch returns a web ReadableStream
    await pipeline(
      response.body as unknown as NodeJS.ReadableStream,
      fileStream,
    );
  } catch (err) {
    // Remove partial file so the next run will retry instead of skipping
    // via the existsSync check in ensureModelAvailable.
    try {
      unlinkSync(destPath);
    } catch {
      // Best-effort cleanup
    }
    throw err;
  }

  // Post-download size check (guards against missing/incorrect Content-Length).
  const stats = statSync(destPath);
  if (stats.size > maxBytes) {
    unlinkSync(destPath);
    throw new Error(
      `Downloaded file ${stats.size} bytes exceeds limit ${maxBytes}`,
    );
  }
}
