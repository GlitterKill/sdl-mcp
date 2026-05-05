/**
 * Reusable internals for single-file and cross-file writes.
 *
 * `handleFileWrite` in file-write.ts composes these helpers; the
 * batch executor in search-edit/ reuses them so both paths share
 * path validation, backup, mode dispatch, and live-index sync.
 */

import { resolve, dirname } from "path";
import {
  readFile,
  stat,
  lstat,
  writeFile,
  copyFile,
  mkdir,
  rename,
  unlink,
} from "fs/promises";
import { existsSync, realpathSync } from "fs";
import { createHash, randomBytes } from "crypto";

import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { normalizePath, validatePathWithinRoot } from "../../util/paths.js";
import { logger } from "../../util/logger.js";
import { NotFoundError, ValidationError } from "../../domain/errors.js";
import { patchSavedFile } from "../../live-index/file-patcher.js";
import type { FileWriteRequest, FileWriteResponse } from "../tools.js";
import { SDL_SOURCE_EXTENSIONS } from "./file-read.js";

export const MAX_FILE_SIZE_BYTES = 512 * 1024;
export const REPLACE_TIME_BUDGET_MS = 500;
export const BYTES_PER_TOKEN = 4;

const BLOCKED_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/**
 * File extensions that are never writable via this path (notebooks,
 * archives, binaries). `search.edit` and `file.write` both honor this
 * list.
 */
export const FILE_WRITE_DENY_EXTENSIONS = new Set([
  // Script formats that some shells/file-managers auto-execute
  ".lnk", ".url", ".scf", ".desktop", ".command", ".app",
  ".bat", ".cmd", ".ps1", ".psm1", ".psd1",
  ".vbs", ".vbe", ".wsh", ".wsf", ".jse",
  ".htaccess",
  ".ipynb",
  ".zip",
  ".tar",
  ".tgz",
  ".gz",
  ".xz",
  ".7z",
  ".bin",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".class",
  ".jar",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".mp3",
  ".mp4",
  ".mov",
  ".webm",
  ".wasm",
  ".pdf",
]);

export interface PreparedPath {
  repoId: string;
  rootPath: string;
  relPath: string;
  absPath: string;
  fileExists: boolean;
}

/**
 * Resolve and validate a relative repo path. Throws on repo-miss,
 * path escape, or denied extension.
 */
export async function preparePath(
  repoId: string,
  filePath: string,
): Promise<PreparedPath> {
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new NotFoundError(`Repository ${repoId} not found`);
  }

  const rootPath = repo.rootPath;
  const relPath = normalizePath(filePath);
  const absPath = resolve(rootPath, relPath);

  validatePathWithinRoot(rootPath, absPath);

  const fileExists = existsSync(absPath);
  if (fileExists) {
    const resolved = realpathSync(absPath);
    if (resolved !== absPath) {
      validatePathWithinRoot(rootPath, resolved);
    }
  }

  const basename = relPath.includes("/") ? relPath.slice(relPath.lastIndexOf("/") + 1) : relPath;
  const extParts = basename.split(".");
  for (let i = 1; i < extParts.length; i++) {
    const subExt = ("." + extParts[i]).toLowerCase();
    if (FILE_WRITE_DENY_EXTENSIONS.has(subExt)) {
      throw new ValidationError(
        `Write denied for extension "${subExt}" (binary/archive/notebook)`,
      );
    }
  }

  return {
    repoId,
    rootPath,
    relPath,
    absPath,
    fileExists,
  };
}

/**
 * Count how many mutually-exclusive write modes are set on a request.
 * Throws if zero or more than one.
 */
export function validateExactlyOneMode(request: FileWriteRequest): void {
  const modes = [
    request.content !== undefined,
    request.replaceLines !== undefined,
    request.replacePattern !== undefined,
    request.jsonPath !== undefined,
    request.insertAt !== undefined,
    request.append !== undefined,
  ].filter(Boolean);

  if (modes.length === 0) {
    throw new ValidationError(
      "Must specify exactly one write mode: content, replaceLines, replacePattern, jsonPath, insertAt, or append",
    );
  }
  if (modes.length > 1) {
    throw new ValidationError("Only one write mode allowed per request");
  }
  if (request.jsonPath !== undefined && request.jsonValue === undefined) {
    throw new ValidationError(
      "jsonValue is required when jsonPath is specified",
    );
  }
}

export interface PrepareContentInput {
  prepared: PreparedPath;
  request: FileWriteRequest;
  existingContent: string;
  existingBytes: number;
}

export interface PrepareContentResult {
  newContent: string;
  mode: FileWriteResponse["mode"];
  replacementCount?: number;
}

/**
 * Apply the write-mode dispatch to produce the new file content.
 * Pure: no I/O.
 */
export function prepareNewContent(
  input: PrepareContentInput,
): PrepareContentResult {
  const { prepared, request, existingContent } = input;
  const { relPath, fileExists } = prepared;

  // Detect dominant EOL and BOM for preservation
  const hasBom = existingContent.startsWith("\uFEFF");
  const crlfCount = (existingContent.match(/\r\n/g) || []).length;
  const lfCount = (existingContent.match(/(?<!\r)\n/g) || []).length;
  const dominantEol = crlfCount > lfCount ? "\r\n" : "\n";

  // === Mode: Full content ===
  if (request.content !== undefined) {
    return {
      newContent: request.content,
      mode: fileExists ? "overwrite" : "create",
    };
  }

  // === Mode: Replace lines ===
  if (request.replaceLines !== undefined) {
    const { start, end, content } = request.replaceLines;
    const normalizedContent = hasBom ? existingContent.slice(1) : existingContent;
    const lines = normalizedContent.split(/\r?\n/);
    if (start > lines.length) {
      throw new ValidationError(
        `Start line ${start} exceeds file length (${lines.length} lines)`,
      );
    }
    if (end > lines.length) {
      throw new ValidationError(
        `End line ${end} exceeds file length (${lines.length} lines)`,
      );
    }
    if (end < start) {
      throw new ValidationError(
        `End line ${end} must be >= start line ${start}`,
      );
    }
    const newLines = content.split(/\r?\n/);
    lines.splice(start, end - start, ...newLines);
    let newContent = lines.join(dominantEol);
    if (hasBom) newContent = "\uFEFF" + newContent;
    return {
      newContent,
      mode: "replaceLines",
    };
  }

  // === Mode: Replace pattern ===
  if (request.replacePattern !== undefined) {
    const { pattern, replacement, global } = request.replacePattern;

    const REDOS_NESTED_QUANTIFIER =
      /\([^)]*([+*]|\{[0-9]+,[0-9]*\})[^)]*\)([+*?]|\{[0-9]+,[0-9]*\})/;
    if (REDOS_NESTED_QUANTIFIER.test(pattern)) {
      throw new ValidationError(
        "Pattern contains nested quantifiers that may cause catastrophic backtracking",
      );
    }

    const REDOS_ALTERNATION_QUANTIFIER =
      /\(([^)]*\|[^)]*)\)([+*]|\{[0-9]+,[0-9]*\})/;
    if (REDOS_ALTERNATION_QUANTIFIER.test(pattern)) {
      throw new ValidationError(
        "Regex contains quantified alternation that may cause catastrophic backtracking",
      );
    }
    const REDOS_OVERLAPPING_QUANTIFIERS =
      /(\\[dDwWsS]|\[[^\]]+\])[+*]\s*\1[+*]/;
    if (REDOS_OVERLAPPING_QUANTIFIERS.test(pattern)) {
      throw new ValidationError(
        "Regex contains overlapping quantified atoms that may cause catastrophic backtracking",
      );
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, global ? "g" : "");
    } catch {
      throw new ValidationError(`Invalid regex pattern: ${pattern}`);
    }

    let replacementCount = 0;

    let newContent: string;
    if (global) {
      // Count matches first with time budget to detect ReDoS, then use
      // native .replace() for correct capture-group expansion ($1, $&, etc.)
      const singleRegex = new RegExp(pattern);
      const deadline = Date.now() + REPLACE_TIME_BUDGET_MS;
      let m;
      let searchPos = 0;
      const tempContent = existingContent;
      while ((m = singleRegex.exec(tempContent.slice(searchPos))) !== null) {
        if (Date.now() > deadline) {
          throw new ValidationError(
            `Pattern replacement exceeded ${REPLACE_TIME_BUDGET_MS}ms time budget`,
          );
        }
        replacementCount++;
        const matchLen = m[0].length;
        searchPos += m.index + matchLen + (matchLen === 0 ? 1 : 0);
        if (searchPos >= tempContent.length) break;
      }
      newContent = existingContent.replace(regex, replacement);
    } else {
      newContent = existingContent.replace(regex, replacement);
      if (newContent !== existingContent) replacementCount = 1;
    }
    // Preserve dominant EOL: if file uses CRLF, normalize any bare LF
    // introduced by the replacement string back to CRLF.
    if (dominantEol === "\r\n") {
      newContent = newContent.replace(/(?<!\r)\n/g, "\r\n");
    }
    return {
      newContent,
      mode: "replacePattern",
      replacementCount,
    };
  }

  // === Mode: JSON path ===
  if (request.jsonPath !== undefined) {
    const ext = relPath.toLowerCase();
    if (!ext.endsWith(".json")) {
      throw new ValidationError("jsonPath mode only supports .json files");
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(existingContent || "{}");
    } catch (e) {
      throw new ValidationError(
        `Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new ValidationError("File must contain an object to use jsonPath");
    }
    setByPath(parsed, request.jsonPath, request.jsonValue);
    return {
      newContent: JSON.stringify(parsed, null, 2) + "\n",
      mode: "jsonPath",
    };
  }

  // === Mode: Insert at ===
  if (request.insertAt !== undefined) {
    const { line, content } = request.insertAt;
    const normalizedInsert = hasBom ? existingContent.slice(1) : existingContent;
    const lines = normalizedInsert.split(/\r?\n/);
    if (line > lines.length) {
      throw new ValidationError(
        `Insert line ${line} exceeds file length (${lines.length} lines)`,
      );
    }
    const newLines = content.split(/\r?\n/);
    lines.splice(line, 0, ...newLines);
    let insertResult = lines.join(dominantEol);
    if (hasBom) insertResult = "\uFEFF" + insertResult;
    return {
      newContent: insertResult,
      mode: "insertAt",
    };
  }

  // === Mode: Append ===
  if (request.append !== undefined) {
    const needsNewline =
      existingContent.length > 0 && !existingContent.endsWith("\n");
    return {
      newContent: existingContent + (needsNewline ? dominantEol : "") + request.append,
      mode: "append",
    };
  }

  throw new ValidationError("No write mode specified");
}

function setByPath(
  obj: Record<string, unknown>,
  keyPath: string,
  value: unknown,
): void {
  const segments = keyPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (BLOCKED_PATH_SEGMENTS.has(seg)) {
      throw new ValidationError(`Blocked path segment: ${seg}`);
    }
    const nextSeg = segments[i + 1];
    const nextIsArrayIndex = /^\d+$/.test(nextSeg);
    if (current[seg] === undefined || current[seg] === null) {
      current[seg] = nextIsArrayIndex ? [] : {};
    }
    if (typeof current[seg] !== "object") {
      throw new ValidationError(
        `Cannot traverse through non-object at path segment: ${seg}`,
      );
    }
    current = current[seg] as Record<string, unknown>;
  }
  const lastSeg = segments[segments.length - 1];
  if (BLOCKED_PATH_SEGMENTS.has(lastSeg)) {
    throw new ValidationError(`Blocked path segment: ${lastSeg}`);
  }
  current[lastSeg] = value;
}

/**
 * Read an existing file's bytes into UTF-8. Enforces MAX_FILE_SIZE_BYTES.
 */
export async function readExistingContent(
  absPath: string,
): Promise<{ content: string; bytes: number }> {
  const s = await stat(absPath);
  if (s.size > MAX_FILE_SIZE_BYTES) {
    throw new ValidationError(
      `File too large: ${s.size} bytes (max ${MAX_FILE_SIZE_BYTES})`,
    );
  }
  const buffer = await readFile(absPath);
  const bytes = buffer.length;
  if (bytes > MAX_FILE_SIZE_BYTES) {
    throw new ValidationError(
      `File too large: ${bytes} bytes (max ${MAX_FILE_SIZE_BYTES})`,
    );
  }
  return { content: buffer.toString("utf-8"), bytes };
}

/**
 * Compute sha256 of the current file on disk. Missing file → null.
 */
export async function hashFileIfExists(
  absPath: string,
): Promise<string | null> {
  let fileSize: number;
  try {
    const s = await stat(absPath);
    fileSize = s.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (fileSize > MAX_FILE_SIZE_BYTES) {
    throw new ValidationError(
      `File too large for hash: ${fileSize} bytes (max ${MAX_FILE_SIZE_BYTES})`,
    );
  }
  let buf: Buffer;
  try {
    buf = await readFile(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (buf.length > MAX_FILE_SIZE_BYTES) {
    throw new ValidationError(
      `File too large for hash: ${buf.length} bytes (max ${MAX_FILE_SIZE_BYTES})`,
    );
  }
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Write the file, creating parent dir on demand and producing a `.bak`
 * backup copy first when `createBackup` is true and the file existed.
 * Returns the absolute backup path (if created) so callers can expose
 * it in their response or remove it in rollback.
 */
export async function writeWithBackup(
  absPath: string,
  newContent: string,
  createBackup: boolean,
  fileExists: boolean,
  backupSuffix?: string,
): Promise<string | undefined> {
  if (!fileExists) {
    const parent = dirname(absPath);
    if (!existsSync(parent)) {
      await mkdir(parent, { recursive: true });
    }
  }

  let backupPath: string | undefined;
  if (fileExists) {
    const lstats = await lstat(absPath);
    if (lstats.isSymbolicLink()) {
      throw new ValidationError("Symlink detected at write target; refusing write");
    }
  }
  if (fileExists && createBackup) {
    backupPath = `${absPath}${backupSuffix ?? ".bak"}`;
    await copyFile(absPath, backupPath);
    logger.debug(`file.write created backup: ${backupPath}`);
  }

  const tmpPath = `${absPath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmpPath, newContent, "utf-8");
    await rename(tmpPath, absPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
  return backupPath;
}

/**
 * Restore a backup to its original path (used on batch rollback).
 * If the backup is missing, leaves the target untouched.
 */
export async function restoreBackup(
  absPath: string,
  backupPath: string,
): Promise<void> {
  if (!existsSync(backupPath)) return;
  await rename(backupPath, absPath);
}

/**
 * Delete a backup file (called after successful batch apply).
 * Swallows ENOENT.
 */
export async function removeBackup(backupPath: string): Promise<void> {
  try {
    await unlink(backupPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * If the file extension is an indexed-source extension, push the new
 * content through `patchSavedFile` so the symbol graph reflects the
 * change. Returns the `indexUpdate` shape surfaced by file.write /
 * search.edit responses. Never throws — live-index failures are best
 * effort.
 */
export async function syncLiveIndex(
  repoId: string,
  relPath: string,
  newContent: string,
): Promise<FileWriteResponse["indexUpdate"] | undefined> {
  if (!isIndexedSource(relPath)) {
    return undefined;
  }

  try {
    const patchResult = await patchSavedFile({
      repoId,
      filePath: relPath,
      content: newContent,
    });
    const symbolsMatched =
      patchResult.symbolsUpserted - patchResult.symbolsAdded;
    logger.debug(
      `live-index synced ${relPath}: +${patchResult.symbolsAdded} -${patchResult.symbolsRemoved} ~${symbolsMatched} symbols`,
    );
    return {
      applied: true,
      symbolsMatched,
      symbolsAdded: patchResult.symbolsAdded,
      symbolsRemoved: patchResult.symbolsRemoved,
      edgesUpserted: patchResult.edgesUpserted,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`live-index sync failed for ${relPath}: ${message}`);
    return { applied: false, error: message };
  }
}

export function isIndexedSource(relPath: string): boolean {
  const dotIdx = relPath.lastIndexOf(".");
  const fileExt = dotIdx >= 0 ? relPath.slice(dotIdx).toLowerCase() : "";
  return SDL_SOURCE_EXTENSIONS.has(fileExt);
}

