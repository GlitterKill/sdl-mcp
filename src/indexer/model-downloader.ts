/**
 * model-downloader.ts — On-demand model download for non-bundled models (e.g., nomic-embed-text-v1.5).
 * Downloads model files from HuggingFace and caches them in the platform-specific cache directory.
 */
import { existsSync, mkdirSync, createWriteStream, statSync } from "fs";
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

  logger.info(
    `Downloading model "${name}" (~${info.dimension === 768 ? "138MB" : "22MB"})...`,
  );
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
      await downloadFile(file.url, destPath);
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

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("Response body is null");
  }

  const fileStream = createWriteStream(destPath);
  // Node 20+ fetch returns a web ReadableStream
  await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);
}
