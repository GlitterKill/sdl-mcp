/**
 * Planner for `sdl.search.edit` — enumerates candidate files, verifies
 * matches, and computes deterministic new-content for each file.
 *
 * Scope for v1:
 *  - `targeting: "text"`: glob-filtered file enumeration + regex match
 *  - `targeting: "symbol"`: resolveSymbolRef + match symbol name in
 *    its home file(s)
 *  - `editMode` supported: `replacePattern`, `overwrite`,
 *    `replaceLines`, `insertAt`, `append`
 *    (`jsonPath` intentionally excluded)
 *  - Binary / notebook / archive files are filtered via
 *    `FILE_WRITE_DENY_EXTENSIONS`
 *  - Missing/unreadable files are surfaced in `filesSkipped`
 */

import { readdir, readFile, stat } from "fs/promises";
import { realpathSync } from "fs";
import { resolve, join, relative } from "path";
import { createHash } from "crypto";

import { getLadybugConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import { normalizePath, validatePathWithinRoot } from "../../../util/paths.js";
import { NotFoundError, ValidationError } from "../../../domain/errors.js";
import { resolveSymbolRef } from "../../../util/resolve-symbol-ref.js";
import { narrowFilesForQuery } from "../../../retrieval/orchestrator.js";
import type { RetrievalEvidence } from "../../../retrieval/types.js";

import {
  FILE_WRITE_DENY_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  isIndexedSource,
  prepareNewContent,
  validateExactlyOneMode,
} from "../file-write-internals.js";
import type { FileWriteRequest, FileWriteResponse } from "../../tools.js";
import type { PlannedFileEdit, PlanPrecondition } from "./plan-store.js";

export interface SearchEditQueryInput {
  literal?: string;
  regex?: string;
  replacement?: string;
  global?: boolean;
  symbolRef?: { name: string; file?: string; kind?: string };
  symbolIds?: string[];
  /** For editMode=replaceLines: the replacement line range payload. */
  replaceLines?: { start: number; end: number; content: string };
  /** For editMode=insertAt. */
  insertAt?: { line: number; content: string };
  /** For editMode=overwrite / append. */
  content?: string;
  append?: string;
}

export interface SearchEditFilters {
  include?: string[];
  exclude?: string[];
  extensions?: string[];
}

export interface SearchEditPreviewRequest {
  repoId: string;
  targeting: "text" | "symbol";
  query: SearchEditQueryInput;
  filters?: SearchEditFilters;
  editMode: FileWriteResponse["mode"];
  previewContextLines?: number;
  maxFiles?: number;
  maxMatchesPerFile?: number;
  maxTotalMatches?: number;
  createBackup?: boolean;
}

export interface PreviewFileSkip {
  path: string;
  reason: string;
}

export interface PreviewFileEntry {
  file: string;
  matchCount: number;
  editMode: FileWriteResponse["mode"];
  snippets: { before: string; after: string };
  indexedSource: boolean;
}

export interface PreviewResult {
  edits: PlannedFileEdit[];
  preconditions: PlanPrecondition[];
  retrievalEvidence?: RetrievalEvidence;
  summary: {
    filesMatched: number;
    matchesFound: number;
    filesEligible: number;
    filesSkipped: PreviewFileSkip[];
    fileEntries: PreviewFileEntry[];
    partial?: boolean;
  };
}

const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_MATCHES_PER_FILE = 100;
const DEFAULT_MAX_TOTAL_MATCHES = 500;
const MAX_PLAN_BYTES = 10 * 1024 * 1024; // 10MB aggregate cap per plan
const DEFAULT_PREVIEW_CONTEXT_LINES = 2;

/** Directory names that are never descended into. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".nyc_output",
]);
const MATCH_TIME_BUDGET_MS = 500;

/**
 * Compile a regex from user query. Exactly one of `literal` / `regex`
 * must be set.
 */
export function compileSearchRegex(
  query: SearchEditQueryInput,
  global: boolean,
): RegExp {
  const hasLiteral = query.literal !== undefined;
  const hasRegex = query.regex !== undefined;
  if (hasLiteral === hasRegex) {
    throw new ValidationError(
      "query must set exactly one of `literal` or `regex`",
    );
  }
  const REDOS_NESTED_QUANTIFIER =
    /\([^)]*([+*]|\{[0-9]+,[0-9]*\})[^)]*\)([+*?]|\{[0-9]+,[0-9]*\})/;
  if (hasRegex) {
    const pattern = query.regex as string;
    if (REDOS_NESTED_QUANTIFIER.test(pattern)) {
      throw new ValidationError(
        "Regex contains nested quantifiers that may cause catastrophic backtracking",
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
    try {
      return new RegExp(pattern, global ? "g" : "");
    } catch {
      throw new ValidationError(`Invalid regex pattern: ${pattern}`);
    }
  }
  const escaped = (query.literal as string).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  return new RegExp(escaped, global ? "g" : "");
}

const MAX_GLOB_WILDCARDS = 6;

function globToRegex(glob: string): RegExp {
  const wildcardCount = (glob.match(/\*/g) || []).length;
  if (wildcardCount > MAX_GLOB_WILDCARDS) {
    throw new ValidationError(
      `Glob pattern has too many wildcards (${wildcardCount}, max ${MAX_GLOB_WILDCARDS})`,
    );
  }
  const special = /[.+^${}()|[\]\\]/;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      const close = glob.indexOf("}", i + 1);
      if (close === -1) {
        re += "\\{";
      } else {
        const alts = glob.slice(i + 1, close).split(",");
        re += "(?:" + alts.map((a) => a.replace(/[.+^${}()|[\]\\*?]/g, "\\$&")).join("|") + ")";
        i = close;
      }
    } else if (special.test(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  // Collapse consecutive .* sequences (from ** patterns) to prevent
  // catastrophic backtracking on non-matching paths.
  re = re.replace(/(\.\*)+/g, ".*");
  return new RegExp(`^${re}$`);
}

function matchesAnyGlob(relPath: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  return globs.some((g) => globToRegex(g).test(relPath));
}

const DOTFILE_DENYLIST = new Set([
  ".npmrc", ".netrc", ".pgpass", ".my.cnf", ".boto",
]);
const SECRET_FILENAME_RE = /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$|^\.(htpasswd|htaccess)$/;

export function isPathAllowed(
  relPath: string,
  filters: SearchEditFilters | undefined,
): { allowed: boolean; reason?: string } {
  const basename = relPath.includes("/") ? relPath.slice(relPath.lastIndexOf("/") + 1) : relPath;
  const dotIdx = basename.lastIndexOf(".");
  const ext = dotIdx >= 0 ? basename.slice(dotIdx).toLowerCase() : "";
  // Check each extension segment in basename to prevent double-extension bypass (e.g. foo.dll.txt)
  const extParts = basename.split(".");
  for (let i = 1; i < extParts.length; i++) {
    const subExt = ("." + extParts[i]).toLowerCase();
    if (FILE_WRITE_DENY_EXTENSIONS.has(subExt)) {
      return { allowed: false, reason: `denied-extension:${subExt}` };
    }
  }
  // Block files under hidden directories (e.g. .hidden/foo.ts reached via symbol targeting)
  const dirSegments = relPath.split("/");
  for (let i = 0; i < dirSegments.length - 1; i++) {
    if (dirSegments[i].startsWith(".")) {
      return { allowed: false, reason: `denied-dotdir:${dirSegments[i]}` };
    }
  }
  // Block dotfiles that commonly contain secrets
  if (basename === ".env" || basename.startsWith(".env.")) {
    return { allowed: false, reason: `denied-dotfile:${basename}` };
  }
  if (DOTFILE_DENYLIST.has(basename)) {
    return { allowed: false, reason: `denied-dotfile:${basename}` };
  }
  if (SECRET_FILENAME_RE.test(basename)) {
    return { allowed: false, reason: `denied-secret:${basename}` };
  }
  if (!filters) return { allowed: true };
  if (filters.extensions && filters.extensions.length > 0) {
    if (!filters.extensions.map((e) => e.toLowerCase()).includes(ext)) {
      return { allowed: false, reason: "extension-not-in-filter" };
    }
  }
  if (filters.include && filters.include.length > 0) {
    if (!matchesAnyGlob(relPath, filters.include)) {
      return { allowed: false, reason: "include-miss" };
    }
  }
  if (filters.exclude && filters.exclude.length > 0) {
    if (matchesAnyGlob(relPath, filters.exclude)) {
      return { allowed: false, reason: "excluded" };
    }
  }
  return { allowed: true };
}

export async function enumerateRepoFiles(
  rootPath: string,
  filters: SearchEditFilters | undefined,
  maxFiles: number,
): Promise<{ candidates: string[]; skipped: PreviewFileSkip[] }> {
  const candidates: string[] = [];
  const skipped: PreviewFileSkip[] = [];

  const visitedRealpaths = new Set<string>();
  // Seed with the root's realpath so a symlink loop back to root is
  // caught on the very first recursive descent.
  try {
    visitedRealpaths.add(realpathSync(rootPath));
  } catch {
    // Root unreadable — walk() will handle by returning early.
  }
  const MAX_WALK_DEPTH = 30;
  async function walk(dirAbs: string, depth = 0): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return;
    if (candidates.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (candidates.length >= maxFiles) return;
      if (entry.name.startsWith(".")) continue;  // Skip all dotfiles/dotdirs
      const abs = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // Track visited realpaths to prevent symlink cycles
        try {
          const realDir = realpathSync(abs);
          if (visitedRealpaths.has(realDir)) continue;
          validatePathWithinRoot(rootPath, realDir);
          visitedRealpaths.add(realDir);
        } catch { continue; }
        await walk(abs, depth + 1);
      } else if (entry.isFile()) {
        const rel = normalizePath(relative(rootPath, abs));
        const { allowed, reason } = isPathAllowed(rel, filters);
        if (!allowed) {
          skipped.push({ path: rel, reason: reason ?? "skipped" });
          continue;
        }
        candidates.push(rel);
      }
    }
  }

  await walk(rootPath);
  return { candidates, skipped };
}

function buildSnippets(
  content: string,
  newContent: string,
  contextLines: number,
  regex: RegExp | null,
): { before: string; after: string } {
  if (!regex) {
    return {
      before: content
        .split("\n")
        .slice(0, contextLines * 2)
        .join("\n"),
      after: newContent
        .split("\n")
        .slice(0, contextLines * 2)
        .join("\n"),
    };
  }
  const beforeLines = content.split("\n");
  const afterLines = newContent.split("\n");
  const snippetRegex = new RegExp(regex.source);
  const deadline = Date.now() + 100;
  const matchLine = beforeLines.findIndex((line) => {
    if (Date.now() > deadline) return false;
    return snippetRegex.test(line);
  });
  if (matchLine < 0) {
    const top = Math.max(0, contextLines * 2);
    return {
      before: beforeLines.slice(0, top).join("\n"),
      after: afterLines.slice(0, top).join("\n"),
    };
  }
  const s = Math.max(0, matchLine - contextLines);
  const e = Math.min(beforeLines.length, matchLine + contextLines + 1);
  const afterDeadline = Date.now() + 100;
  const afterMatchLine = afterLines.findIndex((line) => {
    if (Date.now() > afterDeadline) return false;
    return snippetRegex.test(line);
  });
  const sAfter = afterMatchLine >= 0 ? Math.max(0, afterMatchLine - contextLines) : s;
  const eAfter = afterMatchLine >= 0
    ? Math.min(afterLines.length, afterMatchLine + contextLines + 1)
    : Math.min(afterLines.length, s + (e - s));
  return {
    before: beforeLines.slice(s, e).join("\n"),
    after: afterLines.slice(sAfter, eAfter).join("\n"),
  };
}

function buildFileWriteRequestForMode(
  repoId: string,
  relPath: string,
  editMode: FileWriteResponse["mode"],
  query: SearchEditQueryInput,
): FileWriteRequest {
  const base = {
    repoId,
    filePath: relPath,
    createBackup: false as const,
    createIfMissing: false as const,
  };
  switch (editMode) {
    case "replacePattern": {
      if (query.regex === undefined && query.literal === undefined) {
        throw new ValidationError(
          "replacePattern editMode requires query.literal or query.regex",
        );
      }
      if (query.replacement === undefined) {
        throw new ValidationError(
          "replacePattern editMode requires query.replacement",
        );
      }
      const pattern =
        query.regex !== undefined
          ? query.regex
          : (query.literal as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return {
        ...base,
        replacePattern: {
          pattern,
          replacement: query.replacement,
          global: query.global ?? true,
        },
      } satisfies FileWriteRequest;
    }
    case "overwrite": {
      if (query.content === undefined) {
        throw new ValidationError("overwrite editMode requires query.content");
      }
      return { ...base, content: query.content } satisfies FileWriteRequest;
    }
    case "append": {
      if (query.append === undefined) {
        throw new ValidationError("append editMode requires query.append");
      }
      return { ...base, append: query.append } satisfies FileWriteRequest;
    }
    case "insertAt": {
      if (query.insertAt === undefined) {
        throw new ValidationError("insertAt editMode requires query.insertAt");
      }
      return { ...base, insertAt: query.insertAt } satisfies FileWriteRequest;
    }
    case "replaceLines": {
      if (query.replaceLines === undefined) {
        throw new ValidationError(
          "replaceLines editMode requires query.replaceLines",
        );
      }
      return {
        ...base,
        replaceLines: query.replaceLines,
      } satisfies FileWriteRequest;
    }
    case "jsonPath": {
      throw new ValidationError(
        "jsonPath editMode is not supported in search.edit v1",
      );
    }
    default: {
      throw new ValidationError(`Unsupported editMode: ${editMode}`);
    }
  }
}

/**
 * Build the preview plan for a request. Caller stores the result.
 */
export async function planSearchEditPreview(
  request: SearchEditPreviewRequest,
): Promise<PreviewResult> {
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, request.repoId);
  if (!repo) {
    throw new NotFoundError(`Repository ${request.repoId} not found`);
  }

  const rootPath = repo.rootPath;
  const maxFiles = request.maxFiles ?? DEFAULT_MAX_FILES;
  const maxMatchesPerFile =
    request.maxMatchesPerFile ?? DEFAULT_MAX_MATCHES_PER_FILE;
  const maxTotalMatches = request.maxTotalMatches ?? DEFAULT_MAX_TOTAL_MATCHES;
  const contextLines =
    request.previewContextLines ?? DEFAULT_PREVIEW_CONTEXT_LINES;
  const createBackup = request.createBackup ?? true;

  let candidates: string[];
  let skipped: PreviewFileSkip[];
  let regex: RegExp | null = null;
  let candidatesCapped = false;

  let retrievalEvidence: RetrievalEvidence | undefined;
  if (request.targeting === "text") {
    regex = compileSearchRegex(request.query, true);
    skipped = [];
    candidates = [];

    let narrowQuery: string | null = null;
    if (request.query.literal !== undefined && request.query.literal.length > 0) {
      narrowQuery = request.query.literal;
    } else if (request.query.regex !== undefined) {
      const KEYWORD_STOPWORDS = new Set([
        "if", "else", "for", "while", "do", "switch", "case", "break",
        "return", "throw", "try", "catch", "finally", "new", "delete",
        "typeof", "instanceof", "void", "this", "super", "class",
        "extends", "implements", "interface", "enum", "const", "let",
        "var", "function", "async", "await", "import", "export",
        "from", "default", "static", "public", "private", "protected",
        "abstract", "override", "readonly", "type", "namespace",
      ]);
      const tokens = (
        request.query.regex.match(/[A-Za-z_][A-Za-z0-9_]{1,}/g) ?? []
      ).filter((t) => !KEYWORD_STOPWORDS.has(t.toLowerCase()));
      narrowQuery = tokens.length > 0 ? tokens.join(" ") : null;
    }

    if (narrowQuery) {
      const narrowed = await narrowFilesForQuery({
        repoId: request.repoId,
        query: narrowQuery,
        limit: Math.max(maxFiles, 32),
        includeEvidence: true,
      });
      retrievalEvidence = narrowed.evidence;
      if (narrowed.paths.length > 0) {
        const seen = new Set<string>();
        for (const p of narrowed.paths) {
          const rel = normalizePath(p);
          if (seen.has(rel)) continue;
          seen.add(rel);
          const { allowed, reason } = isPathAllowed(rel, request.filters);
          if (!allowed) {
            skipped.push({ path: rel, reason: reason ?? "skipped" });
            continue;
          }
          candidates.push(rel);
        }
        if (candidates.length < maxFiles) {
          const enumerated = await enumerateRepoFiles(
            rootPath,
            request.filters,
            maxFiles,
          );
          const retrievalSet = new Set(candidates);
          for (const ec of enumerated.candidates) {
            if (retrievalSet.has(ec)) continue;
            if (candidates.length >= maxFiles) {
              candidatesCapped = true;
              break;
            }
            candidates.push(ec);
          }
          skipped.push(...enumerated.skipped);
        } else {
          candidatesCapped = true;
        }
      }
    }
    if (candidates.length === 0) {
      const enumerated = await enumerateRepoFiles(
        rootPath,
        request.filters,
        maxFiles,
      );
      candidates = enumerated.candidates;
      skipped.push(...enumerated.skipped);
      if (enumerated.candidates.length >= maxFiles) {
        candidatesCapped = true;
      }
    }
  } else {
    // symbol targeting
    const symbolRefs: Array<{ symbolId: string; fileId: string; file?: string }> = [];
    skipped = [];
    if (request.query.symbolIds && request.query.symbolIds.length > 0) {
      const byId = await ladybugDb.getSymbolsByIds(
        conn,
        request.query.symbolIds,
      );
      const fileIds: string[] = [];
      for (const id of request.query.symbolIds) {
        const sym = byId.get(id);
        if (!sym || sym.repoId !== request.repoId) {
          skipped.push({ path: id, reason: "symbol-not-found" });
          continue;
        }
        fileIds.push(sym.fileId);
        symbolRefs.push({ symbolId: id, fileId: sym.fileId });
      }
      if (fileIds.length > 0) {
        const fileRows = await ladybugDb.getFilesByIds(conn, fileIds);
        for (const ref of symbolRefs) {
          const fileRow = fileRows.get(ref.fileId);
          if (fileRow) ref.file = fileRow.relPath;
        }
      }
    } else if (request.query.symbolRef) {
      const resolved = await resolveSymbolRef(
        conn,
        request.repoId,
        request.query.symbolRef,
      );
      if (resolved.status !== "resolved") {
        skipped.push({
          path: request.query.symbolRef.name,
          reason: `symbolRef:${resolved.status}`,
        });
      } else {
        const sym = await ladybugDb
          .getSymbolsByIds(conn, [resolved.symbolId])
          .then((m) => m.get(resolved.symbolId));
        if (sym) {
          const fileRow = (await ladybugDb.getFilesByIds(conn, [sym.fileId])).get(sym.fileId);
          symbolRefs.push({
            symbolId: resolved.symbolId,
            fileId: sym.fileId,
            file: fileRow?.relPath,
          });
        }
      }
    } else {
      throw new ValidationError(
        "symbol targeting requires query.symbolRef or query.symbolIds",
      );
    }
    const uniqueFiles = new Set<string>();
    for (const r of symbolRefs) { if (r.file) uniqueFiles.add(normalizePath(r.file)); }
    candidates = Array.from(uniqueFiles);
    // Build a regex from the symbol name if using symbolRef literal match.
    if (request.query.symbolRef) {
      const escaped = request.query.symbolRef.name.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      regex = new RegExp(`\\b${escaped}\\b`, "g");
    }
  }

  // Evaluate each candidate.
  candidates.sort((a, b) => a.localeCompare(b));
  const edits: PlannedFileEdit[] = [];
  const preconditions: PlanPrecondition[] = [];
  const fileEntries: PreviewFileEntry[] = [];
  let totalMatches = 0;

  let aggregateBytes = 0;
  for (const rel of candidates) {
    if (edits.length >= maxFiles) {
      skipped.push({ path: rel, reason: "maxFiles-reached" });
      continue;
    }
    if (totalMatches >= maxTotalMatches) {
      skipped.push({ path: rel, reason: "maxTotalMatches-reached" });
      continue;
    }
    const { allowed: pathAllowed, reason: pathReason } = isPathAllowed(rel, request.filters);
    if (!pathAllowed) {
      skipped.push({ path: rel, reason: pathReason ?? "skipped" });
      continue;
    }
    const abs = resolve(rootPath, rel);
    try {
      validatePathWithinRoot(rootPath, abs);
    } catch (err) {
      skipped.push({
        path: rel,
        reason: `path-denied:${err instanceof Error ? err.message : "unknown"}`,
      });
      continue;
    }
    let stats;
    try {
      stats = await stat(abs);
    } catch {
      skipped.push({ path: rel, reason: "file-missing" });
      continue;
    }
    try {
      const resolved = realpathSync(abs);
      validatePathWithinRoot(rootPath, resolved);
    } catch (err) {
      skipped.push({
        path: rel,
        reason: `path-denied:${err instanceof Error ? err.message : "unknown"}`,
      });
      continue;
    }
    if (!stats.isFile()) {
      skipped.push({ path: rel, reason: "not-a-file" });
      continue;
    }
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      skipped.push({ path: rel, reason: "file-too-large" });
      continue;
    }

    let content: string;
    let contentSha: string;
    try {
      const buf = await readFile(abs);
      if (buf.includes(0)) {
        skipped.push({ path: rel, reason: "binary-content" });
        continue;
      }
      content = buf.toString("utf-8");
      // Derive sha256 from the same buffer used for content so the
      // precondition attests to exactly what we planned against.
      contentSha = createHash("sha256").update(buf).digest("hex");
    } catch (err) {
      skipped.push({
        path: rel,
        reason: `read-error:${err instanceof Error ? err.message : "unknown"}`,
      });
      continue;
    }

    let matchCount = 0;
    if (regex) {
      const countRegex = new RegExp(regex.source, "g");
      const matchDeadline = Date.now() + MATCH_TIME_BUDGET_MS;
      let m;
      while ((m = countRegex.exec(content)) !== null) {
        matchCount++;
        if (matchCount >= maxMatchesPerFile) break;
        if (Date.now() > matchDeadline) {
          throw new ValidationError("Regex match counting exceeded time budget");
        }
        if (m[0].length === 0) countRegex.lastIndex++;
      }
      // Cap only applies to text targeting; symbol-targeted edits already
      // filtered the candidate list and the regex is just informational.
      if (
        request.targeting === "text" &&
        matchCount >= maxMatchesPerFile &&
        countRegex.exec(content) !== null
      ) {
        skipped.push({ path: rel, reason: `matches-exceed-per-file-cap:${maxMatchesPerFile}` });
        continue;
      }
      if (matchCount === 0 && request.targeting === "text") {
        // no match in this candidate; skip silently
        continue;
      }
    }

    const fileWriteRequest = buildFileWriteRequestForMode(
      request.repoId,
      rel,
      request.editMode,
      request.query,
    );
    validateExactlyOneMode(fileWriteRequest);

    let result;
    try {
      result = prepareNewContent({
        prepared: {
          repoId: request.repoId,
          rootPath,
          relPath: rel,
          absPath: abs,
          fileExists: true,
        },
        request: fileWriteRequest,
        existingContent: content,
        existingBytes: stats.size,
      });
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      skipped.push({
        path: rel,
        reason: `prepare-failed:${
          err instanceof Error ? err.message : "unknown"
        }`,
      });
      continue;
    }

    if (result.newContent === content) {
      skipped.push({ path: rel, reason: "no-change" });
      continue;
    }

    // Enforce aggregate byte cap BEFORE committing precondition + edit
    // so a capped file does not leave an orphaned precondition behind.
    const editBytes = Buffer.byteLength(result.newContent, "utf-8");
    aggregateBytes += editBytes;
    if (aggregateBytes > MAX_PLAN_BYTES) {
      aggregateBytes -= editBytes;
      skipped.push({ path: rel, reason: "aggregate-byte-cap-exceeded" });
      continue;
    }
    const indexedSource = isIndexedSource(rel);
    preconditions.push({
      relPath: rel,
      absPath: abs,
      sha256: contentSha,
      mtimeMs: stats.mtimeMs,
    });
    edits.push({
      relPath: rel,
      absPath: abs,
      newContent: result.newContent,
      createBackup,
      fileExists: true,
      indexedSource,
      matchCount: (result.replacementCount ?? matchCount) || 1,
      editMode: result.mode,
    });
    fileEntries.push({
      file: rel,
      matchCount: (result.replacementCount ?? matchCount) || 1,
      editMode: result.mode,
      snippets: buildSnippets(content, result.newContent, contextLines, regex),
      indexedSource,
    });
    totalMatches += (result.replacementCount ?? matchCount) || 1;
  }

  return {
    edits,
    preconditions,
    ...(retrievalEvidence ? { retrievalEvidence } : {}),
    summary: {
      filesMatched: edits.length,
      matchesFound: totalMatches,
      filesEligible: candidates.length,
      filesSkipped: skipped,
      fileEntries,
      ...(candidatesCapped ||
        skipped.some(
          (s) =>
            s.reason === "maxFiles-reached" ||
            s.reason === "maxTotalMatches-reached",
        )
        ? { partial: true }
        : {}),
    },
  };
}
