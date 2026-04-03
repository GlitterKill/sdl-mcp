import { join } from "path";

import { withWriteConn } from "../../db/ladybug.js";
import { readFileAsync } from "../../util/asyncFs.js";
import { hashContent } from "../../util/hashing.js";
import { logger } from "../../util/logger.js";
import { normalizePath } from "../../util/paths.js";
import { getAdapterForExtension } from "../adapter/registry.js";
import type { FileMetadata } from "../fileScanner.js";
import { createEmptyProcessFileResult, persistSkippedFile } from "./helpers.js";
import type { EarlyExitOutcome } from "./types.js";

/**
 * Phases 1-2: Read the file, compute hash, check all early-exit conditions
 * (mtime, binary, content-hash-unchanged, language, adapter), and return
 * either a skip result or the resolved file data + adapter.
 */
export async function resolveFileForIndexing(params: {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  languages: string[];
  mode: "full" | "incremental";
  existingFile?: {
    fileId: string;
    contentHash: string;
    lastIndexedAt: string | null;
  };
}): Promise<EarlyExitOutcome> {
  const { repoId, repoRoot, fileMeta, languages, mode, existingFile } = params;

  // ── Incremental mtime check ──────────────────────────────────────
  if (mode === "incremental" && existingFile?.lastIndexedAt) {
    const lastIndexedMs = new Date(existingFile.lastIndexedAt).getTime();
    if (fileMeta.mtime <= lastIndexedMs) {
      logger.debug("Skipping file (mtime not newer than lastIndexedAt)", {
        file: fileMeta.path,
        fileMtime: fileMeta.mtime,
        lastIndexedMs,
      });
      return { status: "skip", result: createEmptyProcessFileResult(false) };
    }
  }

  // ── Read file content ────────────────────────────────────────────
  const filePath = join(repoRoot, fileMeta.path);
  let content: string;
  try {
    content = await readFileAsync(filePath, "utf-8");
  } catch (readError: unknown) {
    const code = (readError as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EPERM") {
      logger.warn(`File disappeared before indexing: ${fileMeta.path}`, {
        code,
      });
      return { status: "skip", result: createEmptyProcessFileResult(false) };
    }
    throw readError;
  }

  const contentHash = hashContent(content);
  const ext = fileMeta.path.split(".").pop() || "";
  const extWithDot = `.${ext}`;
  const relPath = normalizePath(fileMeta.path);
  const fileId = existingFile?.fileId ?? `${repoId}:${relPath}`;

  // ── Binary file check ────────────────────────────────────────────
  if (content.includes("\0")) {
    logger.debug(`Skipping binary file: ${fileMeta.path}`);
    await withWriteConn(async (wConn) => {
      await persistSkippedFile({
        conn: wConn,
        existingFileId: existingFile?.fileId,
        fileId,
        repoId,
        relPath,
        contentHash,
        language: ext,
        byteSize: fileMeta.size,
      });
    });
    return {
      status: "skip",
      result: createEmptyProcessFileResult(true, {
        fileId,
        relPath,
        symbols: [],
      }),
    };
  }

  // ── Content hash unchanged ───────────────────────────────────────
  if (
    mode === "incremental" &&
    existingFile &&
    existingFile.contentHash === contentHash
  ) {
    logger.debug("Skipping file (content hash unchanged)", {
      file: fileMeta.path,
      contentHash,
    });
    return { status: "skip", result: createEmptyProcessFileResult(false) };
  }

  // ── Language check ───────────────────────────────────────────────
  if (!languages.includes(ext)) {
    logger.debug(
      `Language ${ext} not in enabled languages, skipping ${fileMeta.path}`,
    );
    await withWriteConn(async (wConn) => {
      await persistSkippedFile({
        conn: wConn,
        existingFileId: existingFile?.fileId,
        fileId,
        repoId,
        relPath,
        contentHash,
        language: ext,
        byteSize: fileMeta.size,
      });
    });
    return {
      status: "skip",
      result: createEmptyProcessFileResult(true, {
        fileId,
        relPath,
        symbols: [],
      }),
    };
  }

  // ── Adapter lookup ───────────────────────────────────────────────
  const adapter = getAdapterForExtension(extWithDot);

  if (!adapter) {
    logger.debug(
      `No adapter found for ${extWithDot}, skipping ${fileMeta.path}`,
    );
    await withWriteConn(async (wConn) => {
      await persistSkippedFile({
        conn: wConn,
        existingFileId: existingFile?.fileId,
        fileId,
        repoId,
        relPath,
        contentHash,
        language: ext,
        byteSize: fileMeta.size,
      });
    });
    return {
      status: "skip",
      result: createEmptyProcessFileResult(true, {
        fileId,
        relPath,
        symbols: [],
      }),
    };
  }

  return {
    status: "ready",
    data: { filePath, content, contentHash, ext, extWithDot, relPath, fileId },
    adapter,
  };
}
