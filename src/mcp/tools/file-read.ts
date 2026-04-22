import { resolve } from "path";
import { open, readFile, stat } from "fs/promises";
import { existsSync, realpathSync } from "fs";
import { FileReadRequestSchema, type FileReadResponse } from "../tools.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { normalizePath, validatePathWithinRoot } from "../../util/paths.js";
import { logger } from "../../util/logger.js";
import { NotFoundError, ValidationError } from "../../domain/errors.js";
import { attachRawContext } from "../token-usage.js";

export const SDL_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyw",
  ".go",
  ".java",
  ".cs",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cxx",
  ".hxx",
  ".php",
  ".phtml",
  ".rs",
  ".kt",
  ".kts",
  ".sh",
  ".bash",
  ".zsh",
]);

const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512KB
const BYTES_PER_TOKEN = 4;

/**
 * Extract a value from a parsed object using a dot-separated key path.
 * Supports array indexing via numeric segments (e.g. "items.0.name").
 */
const BLOCKED_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function extractByPath(obj: unknown, keyPath: string): unknown {
  const segments = keyPath.split(".");
  let current: unknown = obj;
  for (const seg of segments) {
    if (BLOCKED_PATH_SEGMENTS.has(seg)) return undefined;
    if (current == null || typeof current !== "object") return undefined;
    const asRecord = current as Record<string, unknown>;
    // Support numeric array indexing
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isFinite(idx)) return undefined;
      current = current[idx];
    } else {
      current = asRecord[seg];
    }
  }
  return current;
}

/**
 * Apply regex search with context lines. Returns matching line ranges
 * merged to avoid overlap.
 */
const REDOS_NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*?]/;
const SEARCH_TIME_BUDGET_MS = 500;
const SEARCH_MAX_LINE_CHARS = 10_000;
const MAX_SEARCH_MATCHES = 50;

function searchLines(
  lines: string[],
  pattern: string,
  contextLines: number,
): {
  content: string;
  matchCount: number;
  returnedLines: number;
  matchesTruncated: boolean;
} {
  if (pattern.length > 500) {
    throw new ValidationError("Search pattern too long (max 500 characters)");
  }
  // ReDoS heuristic: reject patterns with nested quantifiers on a group
  // (e.g. `(a+)+`, `(x*)*`) — the classic catastrophic-backtracking shape.
  // Not exhaustive, but catches the worst offenders without needing a
  // timeout-capable regex engine.
  if (REDOS_NESTED_QUANTIFIER.test(pattern)) {
    throw new ValidationError(
      "Search pattern contains nested quantifiers that may cause catastrophic backtracking",
    );
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    throw new ValidationError(`Invalid search pattern: ${pattern}`);
  }

  const matchIndices: number[] = [];
  let totalMatchCount = 0;
  const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
  for (let i = 0; i < lines.length; i++) {
    // Wall-clock budget check every 1024 lines — bounded worst case even if
    // the regex engine manages to start backtracking on a pathological line.
    if ((i & 1023) === 0 && Date.now() > deadline) {
      throw new ValidationError(
        `Search exceeded ${SEARCH_TIME_BUDGET_MS}ms time budget — narrow the pattern or use offset/limit`,
      );
    }
    // Per-line length cap: test only the first N chars of very long lines so
    // the regex engine cannot be handed an unbounded haystack.
    const line =
      lines[i].length > SEARCH_MAX_LINE_CHARS
        ? lines[i].slice(0, SEARCH_MAX_LINE_CHARS)
        : lines[i];
    if (regex.test(line)) {
      totalMatchCount++;
      if (matchIndices.length < MAX_SEARCH_MATCHES) {
        matchIndices.push(i);
      }
    }
  }

  if (matchIndices.length === 0) {
    return {
      content: "",
      matchCount: 0,
      returnedLines: 0,
      matchesTruncated: false,
    };
  }

  // Build ranges with context, merge overlaps
  const ranges: Array<[number, number]> = [];
  for (const idx of matchIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(lines.length - 1, idx + contextLines);
    if (ranges.length > 0 && start <= ranges[ranges.length - 1][1] + 1) {
      ranges[ranges.length - 1][1] = end;
    } else {
      ranges.push([start, end]);
    }
  }

  const matchSet = new Set(matchIndices);
  const outputParts: string[] = [];
  let returnedLines = 0;
  for (let r = 0; r < ranges.length; r++) {
    const [start, end] = ranges[r];
    for (let i = start; i <= end; i++) {
      const prefix = matchSet.has(i) ? ">" : " ";
      outputParts.push(`${prefix}${i + 1}: ${lines[i]}`);
      returnedLines++;
    }
    if (r < ranges.length - 1) {
      outputParts.push("  ...");
    }
  }

  return {
    content: outputParts.join("\n"),
    matchCount: totalMatchCount,
    returnedLines,
    matchesTruncated: totalMatchCount > matchIndices.length,
  };
}

function withRawTokenBaseline(
  response: FileReadResponse,
  totalBytes: number,
): FileReadResponse {
  // Measure every file.read variant against the full underlying file read.
  return attachRawContext(response, {
    rawTokens: Math.ceil(totalBytes / BYTES_PER_TOKEN),
  });
}

export async function handleFileRead(args: unknown): Promise<FileReadResponse> {
  const request = FileReadRequestSchema.parse(args);
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, request.repoId);
  if (!repo) {
    throw new NotFoundError(`Repository ${request.repoId} not found`);
  }

  const rootPath = repo.rootPath;
  const filePath = normalizePath(request.filePath);
  const absPath = resolve(rootPath, filePath);

  // Security: ensure path is within repo root
  validatePathWithinRoot(rootPath, absPath);

  // Security: resolve symlinks and re-validate to prevent symlink escape
  if (existsSync(absPath)) {
    const realAbsPath = realpathSync(absPath);
    validatePathWithinRoot(rootPath, realAbsPath);
  }

  // Check extension — block indexed source files
  const dotIndex = filePath.lastIndexOf(".");
  const ext = dotIndex >= 0 ? filePath.slice(dotIndex).toLowerCase() : "";
  if (SDL_SOURCE_EXTENSIONS.has(ext)) {
    throw new ValidationError(
      `file.read is for non-indexed files only. Use sdl.context for task-scoped retrieval, or sdl.code.getSkeleton / sdl.code.getHotPath for targeted lookups on ${ext} files.`,
    );
  }

  if (!existsSync(absPath)) {
    throw new NotFoundError(`File not found: ${filePath}`);
  }

  const maxBytes = request.maxBytes ?? MAX_FILE_SIZE_BYTES;
  const fileStat = await stat(absPath);

  // Read only what we need: cap at maxBytes to prevent memory exhaustion.
  // For files larger than maxBytes, read exactly maxBytes and truncate.
  // This avoids the previous 64KB headroom that could overread into memory.
  const needsFullFile = request.jsonPath !== undefined; // JSON/YAML parsing needs full content
  const readLimit = needsFullFile
    ? fileStat.size
    : Math.min(fileStat.size, maxBytes);

  if (needsFullFile && fileStat.size > maxBytes) {
    throw new ValidationError(
      `File size ${fileStat.size} bytes exceeds maxBytes ${maxBytes} for JSON/YAML extraction. Use a smaller file or increase maxBytes.`,
    );
  }

  let rawContent: string;
  if (readLimit < fileStat.size) {
    // Read limited bytes to avoid full allocation
    const fh = await open(absPath, "r");
    try {
      const buf = Buffer.alloc(readLimit);
      await fh.read(buf, 0, readLimit, 0);
      rawContent = buf.toString("utf-8");
    } finally {
      await fh.close();
    }
  } else {
    rawContent = await readFile(absPath, "utf-8");
  }
  const totalBytes = fileStat.size;
  const lines = rawContent.split(/\r?\n/);
  const totalLines = lines.length;

  // === Feature 3: JSON/YAML path extraction ===
  if (request.jsonPath) {
    const lowerPath = filePath.toLowerCase();
    const isJson = lowerPath.endsWith(".json");
    const isYaml = lowerPath.endsWith(".yaml") || lowerPath.endsWith(".yml");

    if (!isJson && !isYaml) {
      throw new ValidationError(
        `jsonPath is only supported for .json, .yaml, and .yml files. Got: ${filePath}`,
      );
    }

    let parsed: unknown;
    if (isJson) {
      try {
        parsed = JSON.parse(rawContent);
      } catch (err) {
        throw new ValidationError(
          `Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // Simple YAML: parse as JSON if it looks like JSON, otherwise return raw with guidance
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        // For YAML files that aren't JSON-compatible, fall back to search
        throw new ValidationError(
          `jsonPath requires JSON-compatible YAML. Use \"search\" parameter instead for complex YAML files.`,
        );
      }
    }

    const extracted = extractByPath(parsed, request.jsonPath);
    if (extracted === undefined) {
      return withRawTokenBaseline(
        {
          filePath,
          content: "",
          bytes: 0,
          totalLines,
          returnedLines: 0,
          truncated: false,
          extractedPath: request.jsonPath,
        },
        totalBytes,
      );
    }

    const serialized =
      typeof extracted === "string"
        ? extracted
        : JSON.stringify(extracted, null, 2);
    const extractedBytes = Buffer.byteLength(serialized, "utf-8");

    return withRawTokenBaseline(
      {
        filePath,
        content: serialized,
        bytes: extractedBytes,
        totalLines,
        returnedLines: serialized.split("\n").length,
        truncated: false,
        extractedPath: request.jsonPath,
      },
      totalBytes,
    );
  }

  // === Feature 2: Search with context ===
  if (request.search) {
    // Apply line range first if specified
    const searchOffset = request.offset ?? 0;
    const searchLimit = request.limit ?? lines.length;
    const rangedLines = lines.slice(searchOffset, searchOffset + searchLimit);

    const result = searchLines(
      rangedLines,
      request.search,
      Math.min(request.searchContext ?? 2, 50),
    );
    const finalContent = result.matchesTruncated
      ? `// WARNING: ${result.matchCount} total matches, showing first ${MAX_SEARCH_MATCHES}. Narrow the pattern.\n${result.content}`
      : result.content;
    return withRawTokenBaseline(
      {
        filePath,
        content: finalContent,
        bytes: Buffer.byteLength(finalContent, "utf-8"),
        totalLines,
        returnedLines: result.returnedLines,
        truncated: result.matchesTruncated,
        matchCount: result.matchCount,
      },
      totalBytes,
    );
  }

  // === Feature 1: Line range ===
  const offset = request.offset ?? 0;
  const limit = request.limit;

  if (offset > 0 || limit !== undefined) {
    const endIdx = limit !== undefined ? offset + limit : lines.length;
    const sliced = lines.slice(offset, endIdx);
    const numberedContent = sliced
      .map((l, i) => `${offset + i + 1}: ${l}`)
      .join("\n");
    const slicedBytes = Buffer.byteLength(numberedContent, "utf-8");

    // Apply maxBytes truncation
    if (slicedBytes > maxBytes) {
      const truncated = numberedContent.slice(0, maxBytes);
      return withRawTokenBaseline(
        {
          filePath,
          content: truncated,
          bytes: slicedBytes,
          totalLines,
          returnedLines: sliced.length,
          truncated: true,
          truncatedAt: maxBytes,
        },
        slicedBytes,
      ); // Compare against sliced range, not full file
    }

    return withRawTokenBaseline(
      {
        filePath,
        content: numberedContent,
        bytes: slicedBytes,
        totalLines,
        returnedLines: sliced.length,
        truncated: false,
      },
      slicedBytes,
    ); // Compare against sliced range, not full file
  }

  // === Default: full file read with maxBytes truncation ===
  if (totalBytes > maxBytes) {
    const truncated = rawContent.slice(0, maxBytes);
    logger.debug(
      `file.read truncated ${filePath}: ${totalBytes} -> ${maxBytes} bytes`,
    );
    return withRawTokenBaseline(
      {
        filePath,
        content: truncated,
        bytes: totalBytes,
        totalLines,
        returnedLines: truncated.split("\n").length,
        truncated: true,
        truncatedAt: maxBytes,
      },
      totalBytes,
    );
  }

  return withRawTokenBaseline(
    {
      filePath,
      content: rawContent,
      bytes: totalBytes,
      totalLines,
      returnedLines: totalLines,
      truncated: false,
    },
    totalBytes,
  );
}
