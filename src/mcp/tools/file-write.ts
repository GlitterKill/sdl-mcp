import { resolve, dirname, relative } from "path";
import { readFile, writeFile, copyFile, mkdir } from "fs/promises";
import { existsSync, realpathSync } from "fs";

import { FileWriteRequestSchema, type FileWriteResponse } from "../tools.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { normalizePath, validatePathWithinRoot } from "../../util/paths.js";
import { logger } from "../../util/logger.js";
import { NotFoundError, ValidationError } from "../../domain/errors.js";
import { attachRawContext } from "../token-usage.js";
import { SDL_SOURCE_EXTENSIONS } from "./file-read.js";
import { patchSavedFile } from "../../live-index/file-patcher.js";

const MAX_FILE_SIZE_BYTES = 512 * 1024;
const REPLACE_TIME_BUDGET_MS = 500; // 512KB
const BYTES_PER_TOKEN = 4;

// Blocked path segments for JSON path traversal
const BLOCKED_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Set a value at a dot-separated key path in an object.
 * Creates intermediate objects/arrays as needed.
 */
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
      // Create intermediate structure
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
 * Compute raw token baseline for write operations.
 * For targeted writes, raw equivalent is what a full file write would cost.
 */
function withRawTokenBaseline(
  response: FileWriteResponse,
  rawBytes: number,
): FileWriteResponse {
  return attachRawContext(response, {
    rawTokens: Math.ceil(rawBytes / BYTES_PER_TOKEN),
  }) as FileWriteResponse;
}

export async function handleFileWrite(
  args: unknown,
): Promise<FileWriteResponse> {
  const request = FileWriteRequestSchema.parse(args);
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, request.repoId);
  if (!repo) {
    throw new NotFoundError(`Repository ${request.repoId} not found`);
  }

  const rootPath = repo.rootPath;
  const filePath = normalizePath(request.filePath);
  const absPath = resolve(rootPath, filePath);

  // Security: validate path is within repo root
  validatePathWithinRoot(rootPath, absPath);

  // Security: follow symlinks and re-validate resolved path
  if (existsSync(absPath)) {
    const resolvedPath = realpathSync(absPath);
    if (resolvedPath !== absPath) {
      validatePathWithinRoot(rootPath, resolvedPath);
    }
  }

  // Count how many write modes are specified
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

  // Validate jsonPath requires jsonValue
  if (request.jsonPath !== undefined && request.jsonValue === undefined) {
    throw new ValidationError(
      "jsonValue is required when jsonPath is specified",
    );
  }

  const fileExists = existsSync(absPath);

  // Handle file creation
  if (!fileExists) {
    if (!request.createIfMissing && request.content === undefined) {
      throw new NotFoundError(
        `File not found: ${filePath}. Set createIfMissing: true to create it.`,
      );
    }

    // Ensure parent directory exists
    const parentDir = dirname(absPath);
    if (!existsSync(parentDir)) {
      await mkdir(parentDir, { recursive: true });
    }
  }

  // Create backup if file exists and backup is enabled
  let backupPath: string | undefined;
  if (fileExists && (request.createBackup ?? true)) {
    backupPath = `${absPath}.bak`;
    await copyFile(absPath, backupPath);
    logger.debug(`file.write created backup: ${backupPath}`);
  }

  // Read existing content for modification modes
  let existingContent = "";
  let existingBytes = 0;
  if (fileExists && request.content === undefined) {
    const buffer = await readFile(absPath);
    existingBytes = buffer.length;
    if (existingBytes > MAX_FILE_SIZE_BYTES) {
      throw new ValidationError(
        `File too large: ${existingBytes} bytes (max ${MAX_FILE_SIZE_BYTES})`,
      );
    }
    existingContent = buffer.toString("utf-8");
  }

  let newContent: string;
  let mode: FileWriteResponse["mode"];
  let replacementCount: number | undefined;

  // === Mode: Full content write ===
  if (request.content !== undefined) {
    newContent = request.content;
    mode = fileExists ? "overwrite" : "create";
  }
  // === Mode: Replace lines ===
  else if (request.replaceLines !== undefined) {
    const { start, end, content } = request.replaceLines;
    const lines = existingContent.split("\n");

    if (start > lines.length) {
      throw new ValidationError(
        `Start line ${start} exceeds file length (${lines.length} lines)`,
      );
    }
    if (end > lines.length) {
      throw new ValidationError(`End line ${end} exceeds file length (${lines.length} lines)`);
    }
    if (end < start) {
      throw new ValidationError(
        `End line ${end} must be >= start line ${start}`,
      );
    }

    const newLines = content.split("\n");
    lines.splice(start, end - start, ...newLines);
    newContent = lines.join("\n");
    mode = "replaceLines";
  }
  // === Mode: Replace pattern ===
  else if (request.replacePattern !== undefined) {
    const { pattern, replacement, global } = request.replacePattern;

    // ReDoS protection
    const REDOS_NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*?]/;
    if (REDOS_NESTED_QUANTIFIER.test(pattern)) {
      throw new ValidationError(
        "Pattern contains nested quantifiers that may cause catastrophic backtracking",
      );
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, global ? "g" : "");
    } catch {
      throw new ValidationError(`Invalid regex pattern: ${pattern}`);
    }

    // Count replacements
    const matches = existingContent.match(new RegExp(pattern, "g"));
    replacementCount = global ? (matches?.length ?? 0) : matches ? 1 : 0;

    // Time-bounded replacement
    const deadline = Date.now() + REPLACE_TIME_BUDGET_MS;
    if (global) {
      // For global replace, do it in chunks with deadline checks
      let result = existingContent;
      let match;
      const singleRegex = new RegExp(pattern);
      while ((match = singleRegex.exec(result)) !== null) {
        if (Date.now() > deadline) {
          throw new ValidationError(`Pattern replacement exceeded ${REPLACE_TIME_BUDGET_MS}ms time budget`);
        }
        result = result.slice(0, match.index) + replacement + result.slice(match.index + match[0].length);
      }
      newContent = result;
    } else {
      newContent = existingContent.replace(regex, replacement);
    }
    mode = "replacePattern";
  }
  // === Mode: JSON path update ===
  else if (request.jsonPath !== undefined) {
    const ext = filePath.toLowerCase();
    if (!ext.endsWith(".json")) {
      throw new ValidationError("jsonPath mode only supports .json files");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(existingContent || "{}");
    } catch (e) {
      throw new ValidationError(`Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new ValidationError("File must contain an object to use jsonPath");
    }

    setByPath(parsed, request.jsonPath, request.jsonValue);
    newContent = JSON.stringify(parsed, null, 2) + "\n";
    mode = "jsonPath";
  }
  // === Mode: Insert at line ===
  else if (request.insertAt !== undefined) {
    const { line, content } = request.insertAt;
    const lines = existingContent.split("\n");

    if (line > lines.length) {
      throw new ValidationError(
        `Insert line ${line} exceeds file length (${lines.length} lines)`,
      );
    }

    const newLines = content.split("\n");
    lines.splice(line, 0, ...newLines);
    newContent = lines.join("\n");
    mode = "insertAt";
  }
  // === Mode: Append ===
  else if (request.append !== undefined) {
    // Add newline before append if file doesn't end with one
    const needsNewline =
      existingContent.length > 0 && !existingContent.endsWith("\n");
    newContent = existingContent + (needsNewline ? "\n" : "") + request.append;
    mode = "append";
  } else {
    throw new ValidationError("No write mode specified");
  }

  // Write the file
  await writeFile(absPath, newContent, "utf-8");

  const bytesWritten = Buffer.byteLength(newContent, "utf-8");
  const linesWritten = newContent.split("\n").length;

  logger.debug(
    `file.write completed: ${filePath} (${mode}, ${bytesWritten} bytes)`,
  );

  // Live-index sync: if the file is indexed source, push the new content
  // through patchSavedFile so the symbol graph reflects the write before we
  // return. Failures are logged but do not fail the write (file is already on
  // disk and chokidar/index.refresh can still reconcile later).
  let indexUpdate: FileWriteResponse["indexUpdate"] | undefined;
  const dotIdx = filePath.lastIndexOf(".");
  const fileExt = dotIdx >= 0 ? filePath.slice(dotIdx).toLowerCase() : "";
  if (SDL_SOURCE_EXTENSIONS.has(fileExt)) {
    try {
      const patchResult = await patchSavedFile({
        repoId: request.repoId,
        filePath,
        content: newContent,
      });
      const symbolsMatched = patchResult.symbolsUpserted - patchResult.symbolsAdded;
      indexUpdate = {
        applied: true,
        symbolsMatched,
        symbolsAdded: patchResult.symbolsAdded,
        symbolsRemoved: patchResult.symbolsRemoved,
        edgesUpserted: patchResult.edgesUpserted,
      };
      logger.debug(
        `file.write indexed ${filePath}: +${patchResult.symbolsAdded} -${patchResult.symbolsRemoved} ~${symbolsMatched} symbols`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `file.write live-index sync failed for ${filePath}: ${message}`,
      );
      indexUpdate = { applied: false, error: message };
    }
  }

  // For targeted writes, raw equivalent is the full file content that would need to be sent
  // For full writes, raw equivalent is the same as what we wrote
  const rawBytes =
    mode === "create" || mode === "overwrite"
      ? bytesWritten
      : Math.max(existingBytes, bytesWritten);

  const response: FileWriteResponse = {
    filePath,
    bytesWritten,
    linesWritten,
    mode,
    ...(backupPath && {
      backupPath: normalizePath(relative(rootPath, backupPath)),
    }),
    ...(replacementCount !== undefined && { replacementCount }),
    ...(indexUpdate !== undefined && { indexUpdate }),
  };

  return withRawTokenBaseline(response, rawBytes);
}
