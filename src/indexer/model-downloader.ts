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
import { Transform } from "stream";
import { logger } from "../util/logger.js";
import {
  getModelInfo,
  resolveModelDir,
  resolveVariant,
  isModelAvailable,
} from "./model-registry.js";

/**
 * Ensure a model's files are available locally.
 * - For bundled models: verifies files exist, throws if missing.
 * - For downloadable models: downloads the requested variant from
 *   HuggingFace if not cached. Tokenizer + config are shared across
 *   variants and only downloaded once per model.
 * Returns the directory path where the model files live.
 */
export async function ensureModelAvailable(
  name: string,
  variant?: string,
): Promise<string> {
  const info = getModelInfo(name);
  const modelDir = resolveModelDir(name);
  const { variantName, variant: variantInfo } = resolveVariant(name, variant);

  if (isModelAvailable(name, variantName)) {
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
    `Downloading model "${name}" variant "${variantName}" (${variantInfo.modelFile})...`,
  );
  mkdirSync(modelDir, { recursive: true });

  const filesToDownload = [
    {
      name: variantInfo.modelFile,
      url: variantInfo.downloadUrl,
      fallbackUrl: variantInfo.fallbackDownloadUrl,
      maxBytes: variantInfo.maxDownloadBytes,
    },
    {
      name: info.tokenizerFile,
      url: info.downloadUrls.tokenizer,
      fallbackUrl: info.fallbackDownloadUrls?.tokenizer,
      maxBytes: undefined,
    },
    {
      name: info.configFile,
      url: info.downloadUrls.config,
      fallbackUrl: info.fallbackDownloadUrls?.config,
      maxBytes: undefined,
    },
  ];

  for (const file of filesToDownload) {
    const destPath = join(modelDir, file.name);
    if (existsSync(destPath)) {
      logger.debug(`  [skip] ${file.name} already exists`);
      continue;
    }

    logger.info(`  Downloading ${file.name}...`);
    let primaryErr: unknown = null;
    try {
      await downloadFile(file.url, destPath, {
        maxBytes: file.maxBytes,
      });
      const stats = statSync(destPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
      logger.info(`  Downloaded ${file.name} (${sizeMB} MB)`);
      continue;
    } catch (error) {
      primaryErr = error;
    }

    if (file.fallbackUrl) {
      logger.warn(
        `  Primary download failed for ${file.name} (${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}); trying fallback ${file.fallbackUrl}`,
      );
      try {
        await downloadFile(file.fallbackUrl, destPath, {
          maxBytes: file.maxBytes,
        });
        const stats = statSync(destPath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
        logger.info(`  Downloaded ${file.name} from fallback (${sizeMB} MB)`);
        continue;
      } catch (fallbackErr) {
        throw new Error(
          `Failed to download ${file.name} for model "${name}" from both primary and fallback URLs. ` +
            `Primary: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}. ` +
            `Fallback: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}. ` +
            `You can try downloading manually with: node scripts/download-models.mjs ${name}`,
        );
      }
    }

    throw new Error(
      `Failed to download ${file.name} for model "${name}": ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}. ` +
        `You can try downloading manually with: node scripts/download-models.mjs ${name}`,
    );
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
    // Node 20+ fetch returns a web ReadableStream.
    // Insert a counting limiter so the pipeline rejects mid-stream once we
    // exceed maxBytes. Without this, a server returning chunked encoding
    // with no/lying Content-Length could write unbounded bytes to disk
    // before the post-stream stat check ever runs.
    let writtenBytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer | string, _enc, cb) {
        const len = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        writtenBytes += len;
        if (writtenBytes > maxBytes) {
          cb(new Error(`Download exceeded limit: wrote ${writtenBytes} bytes, max ${maxBytes}`));
          return;
        }
        cb(null, chunk);
      },
    });
    await pipeline(
      response.body as unknown as NodeJS.ReadableStream,
      limiter,
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
