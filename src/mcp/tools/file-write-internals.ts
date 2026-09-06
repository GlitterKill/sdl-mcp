/**
 * Reusable internals for single-file and cross-file writes.
 *
 * `handleFileWrite` in file-write.ts composes these helpers; the
 * batch executor in search-edit/ reuses them so both paths share
 * path validation, backup, mode dispatch, and live-index sync.
 */

import { resolve, dirname, relative } from "path";
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
import { constants, existsSync, realpathSync } from "fs";
import { createHash, randomBytes } from "crypto";

import { RepoConfigSchema } from "../../config/types.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { compilePatterns, shouldIgnorePath } from "../../indexer/fileWalker.js";
import {
  getRelativePath,
  normalizePath,
  validatePathWithinRoot,
} from "../../util/paths.js";
import {
  detectDominantEol,
  normalizeToLf,
  restoreEol,
} from "../../util/eol.js";
import { logger } from "../../util/logger.js";
import {
  IndexError,
  NotFoundError,
  ValidationError,
} from "../../domain/errors.js";
import { getDefaultLiveIndexCoordinator } from "../../live-index/coordinator.js";
import type {
  LiveIndexCoordinator,
  SavedFileMutationInput,
} from "../../live-index/types.js";
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
  ".lnk",
  ".url",
  ".scf",
  ".desktop",
  ".command",
  ".app",
  ".bat",
  ".cmd",
  ".ps1",
  ".psm1",
  ".psd1",
  ".vbs",
  ".vbe",
  ".wsh",
  ".wsf",
  ".jse",
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
  canonicalRootPath: string;
  relPath: string;
  canonicalRelPath: string;
  absPath: string;
  canonicalAbsPath: string;
  fileExists: boolean;
}

/** Fail closed if a write target resolves to a different canonical identity. */
export function assertStableCanonicalIdentity(
  preparedPath: string,
  currentPath: string,
): void {
  const preparedIdentity = normalizePath(preparedPath);
  const currentIdentity = normalizePath(currentPath);

  if (preparedIdentity !== currentIdentity) {
    throw new ValidationError(
      "Write target identity changed after validation; refusing write",
    );
  }
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
  const canonicalRootPath = realpathSync.native(rootPath);

  const fileExists = existsSync(absPath);
  let canonicalAbsPath = absPath;
  let canonicalRelPath = relPath;
  if (fileExists) {
    canonicalAbsPath = realpathSync.native(absPath);
    validatePathWithinRoot(canonicalRootPath, canonicalAbsPath);
    canonicalRelPath = getRelativePath(canonicalRootPath, canonicalAbsPath);
  } else {
    let existingAncestor = absPath;
    while (!existsSync(existingAncestor)) {
      existingAncestor = dirname(existingAncestor);
    }
    const canonicalAncestor = realpathSync.native(existingAncestor);
    validatePathWithinRoot(canonicalRootPath, canonicalAncestor);
    canonicalAbsPath = resolve(
      canonicalAncestor,
      relative(existingAncestor, absPath),
    );
    canonicalRelPath = getRelativePath(canonicalRootPath, canonicalAbsPath);
  }

  const basename = canonicalRelPath.includes("/")
    ? canonicalRelPath.slice(canonicalRelPath.lastIndexOf("/") + 1)
    : canonicalRelPath;
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
    canonicalRootPath,
    relPath,
    canonicalRelPath,
    absPath,
    canonicalAbsPath,
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
  prepared: Pick<PreparedPath, "relPath" | "fileExists">;
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
  const targetEol = detectDominantEol(existingContent);

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
    const normalizedContent = hasBom
      ? existingContent.slice(1)
      : existingContent;
    const lines = normalizeToLf(normalizedContent).split("\n");
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
    const newLines = normalizeToLf(content).split("\n");
    lines.splice(start, end - start, ...newLines);
    let newContent = restoreEol(lines.join("\n"), targetEol);
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
    newContent = restoreEol(newContent, targetEol);
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
    const normalizedInsert = hasBom
      ? existingContent.slice(1)
      : existingContent;
    const lines = normalizeToLf(normalizedInsert).split("\n");
    if (line > lines.length) {
      throw new ValidationError(
        `Insert line ${line} exceeds file length (${lines.length} lines)`,
      );
    }
    const newLines = normalizeToLf(content).split("\n");
    lines.splice(line, 0, ...newLines);
    let insertResult = restoreEol(lines.join("\n"), targetEol);
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
      newContent:
        existingContent + (needsNewline ? targetEol : "") + request.append,
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
 * it in their response or remove it in rollback. `writePath` is the
 * validated canonical target for backup and replacement I/O; `absPath` remains the
 * lexical safety check.
 */
export async function writeWithBackup(
  absPath: string,
  newContent: string,
  createBackup: boolean,
  fileExists: boolean,
  backupSuffix?: string,
  writePath = absPath,
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
      throw new ValidationError(
        "Symlink detected at write target; refusing write",
      );
    }
  }
  if (fileExists && createBackup) {
    backupPath = `${writePath}${backupSuffix ?? ".bak"}`;
    // Refuse pre-created backup destinations, including hardlinks to outside files.
    try {
      await copyFile(writePath, backupPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ValidationError(
          "Backup destination already exists; remove or move the retained .bak file, or retry with createBackup: false",
        );
      }
      throw error;
    }
    logger.debug(`file.write created backup: ${backupPath}`);
  }

  const tmpPath = `${writePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmpPath, newContent, "utf-8");
    await rename(tmpPath, writePath);
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
  writePath: string,
  backupPath: string,
): Promise<void> {
  if (!existsSync(backupPath)) return;
  await rename(backupPath, writePath);
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

/** Prepare eligibility before the shared disk-save/publication fence. */
export async function runLiveIndexMutation<T>(
  repoId: string,
  relPath: string,
  operation: (canonicalPath: string) => Promise<T>,
  liveIndex: LiveIndexCoordinator = getDefaultLiveIndexCoordinator(),
  ownership: Pick<
    SavedFileMutationInput,
    "captureOwnership" | "expectedOwnership"
  > = {},
): Promise<{ value: T; indexUpdate: FileWriteResponse["indexUpdate"] }> {
  const prepared = await preparePath(repoId, relPath);
  const repo = await ladybugDb.getRepo(await getLadybugConn(), repoId);
  if (!repo) throw new NotFoundError(`Repository ${repoId} not found`);
  let ignore: string[];
  try {
    ({ ignore } = RepoConfigSchema.pick({ ignore: true }).parse(
      JSON.parse(repo.configJson),
    ));
  } catch (error) {
    throw new IndexError(
      `Repository configuration invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const pathSegments = prepared.canonicalRelPath.split("/");
  const ignorePatterns = compilePatterns(ignore);
  const ignored = pathSegments.some((_segment, i) =>
    shouldIgnorePath(
      pathSegments.slice(0, i + 1).join("/"),
      ignorePatterns,
      i + 1 < pathSegments.length,
    ),
  );
  // Canonical identity also expands Windows 8.3 extensions before eligibility checks.
  const indexed = isIndexedSource(prepared.canonicalRelPath) && !ignored;
  const result = await liveIndex.runSavedFileMutation(
    {
      repoId,
      filePath: prepared.canonicalRelPath,
      reconcile: indexed,
      ...ownership,
    },
    operation,
  );
  return {
    value: result.value,
    indexUpdate: indexed
      ? result.pending
        ? { applied: false, pending: true }
        : { applied: false, error: "Saved source was not queued" }
      : undefined,
  };
}

/** Compatibility admission for callers whose disk write has already completed. */
export async function syncLiveIndex(
  repoId: string,
  relPath: string,
  newContent: string,
  liveIndex: LiveIndexCoordinator = getDefaultLiveIndexCoordinator(),
): Promise<FileWriteResponse["indexUpdate"] | undefined> {
  const windowsAlias =
    process.platform === "win32" &&
    [...SDL_SOURCE_EXTENSIONS].some(
      (extension) =>
        extension.length > 4 &&
        relPath.toLowerCase().endsWith(extension.slice(0, 4)),
    );
  if (!isIndexedSource(relPath) && !windowsAlias) return undefined;
  try {
    return (
      await runLiveIndexMutation(
        repoId,
        relPath,
        async (path) => {
          if ((await readExistingContent(path)).content !== newContent)
            throw new ValidationError(
              "Saved content changed before reconciliation admission",
            );
        },
        liveIndex,
      )
    ).indexUpdate;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`live-index admission failed for ${relPath}: ${message}`);
    return { applied: false, error: message };
  }
}

export function isIndexedSource(relPath: string): boolean {
  const dotIdx = relPath.lastIndexOf(".");
  const fileExt = dotIdx >= 0 ? relPath.slice(dotIdx).toLowerCase() : "";
  return SDL_SOURCE_EXTENSIONS.has(fileExt);
}
