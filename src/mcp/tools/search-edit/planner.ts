/**
 * Planner for `sdl.search.edit` — enumerates candidate files, verifies
 * matches, and computes deterministic new-content for each file.
 *
 * Scope for v1:
 *  - `targeting: "text"`: glob-filtered file enumeration + regex match
 *  - `targeting: "symbol"`: resolveSymbolRef + match symbol name in
 *    its home file(s)
 *  - `targeting: "identifier"` / `"structural"`: tree-sitter-backed
 *    source ranges for AST-aware replacement in registered structural languages
 *  - `editMode` supported: `replacePattern`, `overwrite`,
 *    `replaceLines`, `insertAt`, `append`
 *    (`jsonPath` intentionally excluded)
 *  - Binary / notebook / archive files are filtered via
 *    `FILE_WRITE_DENY_EXTENSIONS`
 *  - Missing/unreadable files are surfaced in `filesSkipped`
 */

import { lstat, open, readdir, stat } from "fs/promises";
import { constants, realpathSync, type Stats } from "fs";
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
import {
  collectIdentifierSourceEdits,
  collectStructuralSourceEdits,
  createStructuralQueryCache,
  getStructuralExtensions,
  getStructuralLanguageForPath,
  isStructuralLanguageSupported,
  STRUCTURAL_QUERY_TIME_BUDGET_ERROR,
  structuralLanguageMismatchReason,
  type StructuralQueryCache,
  type StructuralQueryInput,
  type StructuralSourceEdit,
} from "./structural.js";

export interface SearchEditQueryInput {
  literal?: string;
  regex?: string;
  replacement?: string;
  global?: boolean;
  structural?: StructuralQueryInput;
  symbolRef?: { name: string; file?: string; kind?: string };
  symbolIds?: string[];
  rename?: {
    newName: string;
    minConfidence?: number;
    includeTextOnlyMatches?: boolean;
  };
  signature?: SignatureOps;
  /** For editMode=replaceLines: the replacement line range payload. */
  replaceLines?: { start: number; end: number; content: string };
  /** For editMode=insertAt. */
  insertAt?: { line: number; content: string };
  /** For editMode=overwrite / append. */
  content?: string;
  append?: string;
}

export interface SignatureOps {
  add?: Array<{
    name: string;
    typeText?: string;
    defaultText?: string;
    index?: number;
    argText?: string;
  }>;
  remove?: Array<{ name: string }>;
  renameParam?: Array<{ from: string; to: string }>;
}

export interface SearchEditFilters {
  include?: string[];
  exclude?: string[];
  extensions?: string[];
  /** Internal candidate hint used to preserve structural mismatch diagnostics. */
  structuralLanguage?: string;
}

export interface SearchEditBatchOperation {
  id?: string;
  targeting: "text" | "symbol" | "identifier" | "structural";
  query: SearchEditQueryInput;
  filters?: SearchEditFilters;
  editMode: FileWriteResponse["mode"];
  maxFiles?: number;
  maxMatchesPerFile?: number;
  maxTotalMatches?: number;
}

export interface SearchEditPreviewRequest {
  repoId: string;
  targeting?: "text" | "symbol" | "identifier" | "structural" | "rename" | "signature";
  query?: SearchEditQueryInput;
  filters?: SearchEditFilters;
  editMode?: FileWriteResponse["mode"];
  operations?: SearchEditBatchOperation[];
  previewContextLines?: number;
  maxFiles?: number;
  maxMatchesPerFile?: number;
  maxTotalMatches?: number;
  maxPlanBytes?: number;
  createBackup?: boolean;
}

interface SearchEditSingleOperationRequest extends SearchEditPreviewRequest {
  targeting: "text" | "symbol" | "identifier" | "structural" | "rename" | "signature";
  query: SearchEditQueryInput;
  editMode: FileWriteResponse["mode"];
  operations?: undefined;
  renameCollisionFiles?: Set<string>;
  structuralLanguage?: string;
  structuralQueryCache?: StructuralQueryCache;
  structuralDeadlineMs?: number;
}

export interface PreviewFileSkip {
  path: string;
  reason: string;
  operationId?: string;
}

export interface PreviewSnippets {
  before: string;
  after: string;
  beforeStartLine: number;
  beforeEndLine: number;
  afterStartLine: number;
  afterEndLine: number;
}

export interface PreviewFileEntry {
  file: string;
  matchCount: number;
  editMode: FileWriteResponse["mode"];
  snippets: PreviewSnippets;
  indexedSource: boolean;
  astMatches?: PreviewAstMatch[];
  operationIds?: string[];
  operations?: Array<{
    id: string;
    matchCount: number;
    editMode: FileWriteResponse["mode"];
  }>;
}

export interface PreviewAstCapture {
  name: string;
  nodeType: string;
  text: string;
  startByte: number;
  endByte: number;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
}

export interface PreviewAstMatch {
  target: PreviewAstCapture;
  captures: PreviewAstCapture[];
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
const MAX_PREVIEW_SNIPPET_LINES = 80;
const MAX_AST_MATCH_DETAILS_PER_FILE = 5;
const MAX_AST_CAPTURE_DETAILS_PER_MATCH = 8;
const MAX_AST_CAPTURE_TEXT_CHARS = 120;
const STRUCTURAL_PREVIEW_REQUEST_BUDGET_MS = 10_000;
const STRUCTURAL_QUERY_TIME_BUDGET_SKIP_REASON =
  STRUCTURAL_QUERY_TIME_BUDGET_ERROR;

function maxFilesReachedReason(maxFiles: number): string {
  return `maxFiles-reached:${maxFiles}; raise maxFiles or narrow filters/query`;
}

function maxTotalMatchesReachedReason(maxTotalMatches: number): string {
  return `maxTotalMatches-reached:${maxTotalMatches}; raise maxTotalMatches or narrow filters/query`;
}

function matchesExceedTotalCapReason(maxTotalMatches: number): string {
  return `matches-exceed-total-cap:${maxTotalMatches}; raise maxTotalMatches or narrow filters/query`;
}

function aggregateByteCapExceededReason(maxPlanBytes: number): string {
  return `aggregate-byte-cap-exceeded:${maxPlanBytes}; raise maxPlanBytes or narrow filters/query`;
}

function isPartialSkipReason(reason: string): boolean {
  return (
    reason.startsWith("maxFiles-reached:") ||
    reason.startsWith("maxTotalMatches-reached:") ||
    reason === STRUCTURAL_QUERY_TIME_BUDGET_SKIP_REASON ||
    reason.startsWith("matches-exceed-") ||
    reason.startsWith("aggregate-byte-cap-exceeded:")
  );
}

const NO_AST_AWARE_SOURCE_EXTENSION = ".__sdl_no_ast_source__";

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
        re +=
          "(?:" +
          alts.map((a) => a.replace(/[.+^${}()|[\]\\*?]/g, "\\$&")).join("|") +
          ")";
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

const GLOB_META_RE = /[*?[\]{}]/;

function isLiteralIncludePattern(pattern: string): boolean {
  return pattern.length > 0 && !GLOB_META_RE.test(pattern);
}

function relPathExtension(relPath: string): string {
  const basename = relPath.includes("/")
    ? relPath.slice(relPath.lastIndexOf("/") + 1)
    : relPath;
  const dotIdx = basename.lastIndexOf(".");
  return dotIdx >= 0 ? basename.slice(dotIdx).toLowerCase() : "";
}

function filterSelectionReason(
  relPath: string,
  filters: SearchEditFilters | undefined,
): string | undefined {
  if (!filters) return undefined;
  const ext = relPathExtension(relPath);
  if (filters.extensions && filters.extensions.length > 0) {
    if (!filters.extensions.map((e) => e.toLowerCase()).includes(ext)) {
      return "extension-not-in-filter";
    }
  }
  if (filters.include && filters.include.length > 0) {
    if (!matchesAnyGlob(relPath, filters.include)) {
      return "include-miss";
    }
  }
  if (filters.exclude && filters.exclude.length > 0) {
    if (matchesAnyGlob(relPath, filters.exclude)) {
      return "excluded";
    }
  }
  const structuralMismatch = structuralLanguageMismatchReason(
    relPath,
    filters.structuralLanguage,
  );
  if (structuralMismatch) return structuralMismatch;
  return undefined;
}

const DOTFILE_DENYLIST = new Set([
  ".npmrc",
  ".netrc",
  ".pgpass",
  ".my.cnf",
  ".boto",
]);
const SECRET_FILENAME_RE =
  /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$|^\.(htpasswd|htaccess)$/;

export function isPathAllowed(
  relPath: string,
  filters: SearchEditFilters | undefined,
): { allowed: boolean; reason?: string } {
  const basename = relPath.includes("/")
    ? relPath.slice(relPath.lastIndexOf("/") + 1)
    : relPath;
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
  const filterReason = filterSelectionReason(relPath, filters);
  if (filterReason) {
    return { allowed: false, reason: filterReason };
  }
  return { allowed: true };
}

const SILENT_FILTER_SKIP_REASONS = new Set([
  "extension-not-in-filter",
  "include-miss",
  "excluded",
]);

export function shouldReportSkippedFile(reason?: string): boolean {
  return reason === undefined || !SILENT_FILTER_SKIP_REASONS.has(reason);
}

export async function enumerateExplicitIncludeFiles(
  rootPath: string,
  filters: SearchEditFilters | undefined,
  maxFiles: number,
): Promise<
  | { candidates: string[]; skipped: PreviewFileSkip[]; capped: boolean }
  | undefined
> {
  const includes = filters?.include;
  if (
    !includes ||
    includes.length === 0 ||
    !includes.every(isLiteralIncludePattern)
  ) {
    return undefined;
  }

  const candidates: string[] = [];
  const skipped: PreviewFileSkip[] = [];
  const seen = new Set<string>();
  let capped = false;

  for (const include of includes) {
    if (candidates.length >= maxFiles) {
      capped = true;
      break;
    }
    const rel = normalizePath(include).replace(/^\.\//, "");
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);

    let abs: string;
    try {
      abs = resolve(rootPath, rel);
      validatePathWithinRoot(rootPath, abs);
      const info = await stat(abs);
      if (!info.isFile()) {
        skipped.push({ path: rel, reason: "not-file" });
        continue;
      }
    } catch {
      skipped.push({ path: rel, reason: "not-found" });
      continue;
    }

    const structuralMismatch = structuralLanguageMismatchReason(
      rel,
      filters?.structuralLanguage,
    );
    if (structuralMismatch) {
      skipped.push({ path: rel, reason: structuralMismatch });
      continue;
    }

    const { allowed, reason } = isPathAllowed(rel, filters);
    if (!allowed) {
      if (shouldReportSkippedFile(reason)) {
        skipped.push({ path: rel, reason: reason ?? "skipped" });
      }
      continue;
    }
    candidates.push(rel);
  }

  return { candidates, skipped, capped };
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
    // Root unreadable - walk() will handle by returning early.
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
      if (entry.name.startsWith(".")) continue; // Skip all dotfiles/dotdirs
      const abs = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // Track visited realpaths to prevent symlink cycles
        try {
          const realDir = realpathSync(abs);
          if (visitedRealpaths.has(realDir)) continue;
          validatePathWithinRoot(rootPath, realDir);
          visitedRealpaths.add(realDir);
        } catch {
          continue;
        }
        await walk(abs, depth + 1);
      } else if (entry.isFile()) {
        const rel = normalizePath(relative(rootPath, abs));
        // Selection filters shape broad enumeration; policy checks still run
        // for files that are actually inside the requested candidate set.
        const filterReason = filterSelectionReason(rel, filters);
        if (filterReason) {
          if (shouldReportSkippedFile(filterReason)) {
            skipped.push({ path: rel, reason: filterReason });
          }
          continue;
        }
        const { allowed, reason } = isPathAllowed(rel, filters);
        if (!allowed) {
          if (shouldReportSkippedFile(reason)) {
            skipped.push({ path: rel, reason: reason ?? "skipped" });
          }
          continue;
        }
        candidates.push(rel);
      }
    }
  }

  await walk(rootPath);
  return { candidates, skipped };
}

interface PreviewLineRange {
  startIndex: number;
  endIndex: number;
}

function splitPreviewLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.length === 0) return [];
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

interface ChangedLineSpan {
  beforeStartIndex: number;
  beforeEndIndex: number;
  afterStartIndex: number;
  afterEndIndex: number;
}

function findChangedLineSpan(
  beforeLines: string[],
  afterLines: string[],
): ChangedLineSpan {
  const sharedLength = Math.min(beforeLines.length, afterLines.length);
  let prefix = 0;
  while (prefix < sharedLength && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }

  let beforeSuffix = beforeLines.length;
  let afterSuffix = afterLines.length;
  while (
    beforeSuffix > prefix &&
    afterSuffix > prefix &&
    beforeLines[beforeSuffix - 1] === afterLines[afterSuffix - 1]
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }

  return {
    beforeStartIndex: prefix,
    beforeEndIndex: beforeSuffix,
    afterStartIndex: prefix,
    afterEndIndex: afterSuffix,
  };
}

function findRegexLine(lines: string[], regex: RegExp): number {
  const flags = regex.flags.replace(/g/g, "");
  const lineRegex = new RegExp(regex.source, flags);
  const deadline = Date.now() + 100;
  for (let index = 0; index < lines.length; index += 1) {
    if (Date.now() > deadline) return -1;
    lineRegex.lastIndex = 0;
    if (lineRegex.test(lines[index])) return index;
  }
  return -1;
}

function nonEmptyDisplaySpan(
  lines: string[],
  startIndex: number,
  endIndex: number,
  fallbackIndex: number,
): PreviewLineRange {
  if (lines.length === 0) {
    return { startIndex: 0, endIndex: 0 };
  }
  if (endIndex > startIndex) {
    return {
      startIndex: Math.max(0, Math.min(startIndex, lines.length - 1)),
      endIndex: Math.max(0, Math.min(endIndex, lines.length)),
    };
  }
  const boundedFallback = Math.max(
    0,
    Math.min(fallbackIndex, lines.length - 1),
  );
  return { startIndex: boundedFallback, endIndex: boundedFallback + 1 };
}

function buildLineRange(
  lines: string[],
  changedSpan: PreviewLineRange,
  contextLines: number,
): PreviewLineRange {
  if (lines.length === 0) {
    return { startIndex: 0, endIndex: 0 };
  }
  return {
    startIndex: Math.max(0, changedSpan.startIndex - contextLines),
    endIndex: Math.min(lines.length, changedSpan.endIndex + contextLines),
  };
}

function boundPreviewChangedSpan(
  lines: string[],
  changedSpan: PreviewLineRange,
  fallbackIndex: number,
  contextLines: number,
): PreviewLineRange {
  const fullRange = buildLineRange(lines, changedSpan, contextLines);
  if (fullRange.endIndex - fullRange.startIndex <= MAX_PREVIEW_SNIPPET_LINES) {
    return changedSpan;
  }

  return nonEmptyDisplaySpan(
    lines,
    fallbackIndex,
    fallbackIndex,
    fallbackIndex,
  );
}

function formatNumberedLines(
  lines: string[],
  range: PreviewLineRange,
  changedSpan: PreviewLineRange,
): string {
  if (range.endIndex <= range.startIndex) return "";
  const width = String(range.endIndex).length;
  return lines
    .slice(range.startIndex, range.endIndex)
    .map((line, offset) => {
      const lineIndex = range.startIndex + offset;
      const lineNumber = lineIndex + 1;
      const marker =
        lineIndex >= changedSpan.startIndex && lineIndex < changedSpan.endIndex
          ? ">"
          : " ";
      return `${marker}${String(lineNumber).padStart(width)} | ${line}`;
    })
    .join("\n");
}

function startLine(range: PreviewLineRange): number {
  return range.endIndex > range.startIndex ? range.startIndex + 1 : 0;
}

export function buildSearchEditPreviewSnippets(
  content: string,
  newContent: string,
  contextLines: number,
  regex: RegExp | null,
): PreviewSnippets {
  const beforeLines = splitPreviewLines(content);
  const afterLines = splitPreviewLines(newContent);
  const changedSpan = findChangedLineSpan(beforeLines, afterLines);
  const regexLine = regex ? findRegexLine(beforeLines, regex) : -1;
  const beforeFallback =
    regexLine >= 0 ? regexLine : changedSpan.beforeStartIndex;
  const beforeChangedSpan = boundPreviewChangedSpan(
    beforeLines,
    nonEmptyDisplaySpan(
      beforeLines,
      changedSpan.beforeStartIndex,
      changedSpan.beforeEndIndex,
      beforeFallback,
    ),
    beforeFallback,
    contextLines,
  );
  const afterChangedSpan = boundPreviewChangedSpan(
    afterLines,
    nonEmptyDisplaySpan(
      afterLines,
      changedSpan.afterStartIndex,
      changedSpan.afterEndIndex,
      changedSpan.afterStartIndex,
    ),
    changedSpan.afterStartIndex,
    contextLines,
  );
  const beforeRange = buildLineRange(
    beforeLines,
    beforeChangedSpan,
    contextLines,
  );
  const afterRange = buildLineRange(afterLines, afterChangedSpan, contextLines);

  return {
    before: formatNumberedLines(beforeLines, beforeRange, beforeChangedSpan),
    after: formatNumberedLines(afterLines, afterRange, afterChangedSpan),
    beforeStartLine: startLine(beforeRange),
    beforeEndLine: beforeRange.endIndex,
    afterStartLine: startLine(afterRange),
    afterEndLine: afterRange.endIndex,
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

interface OperationPreview {
  operationId: string;
  request: SearchEditSingleOperationRequest;
  preview: PreviewResult;
}

interface OperationFilePlan {
  operationId: string;
  request: SearchEditSingleOperationRequest;
  edit: PlannedFileEdit;
  astMatches?: PreviewAstMatch[];
}

interface SourceRange {
  operationId: string;
  start: number;
  end: number;
}

interface SourceEdit extends SourceRange {
  replacement: string;
}

function coerceSingleSearchEditRequest(
  request: SearchEditPreviewRequest,
): SearchEditSingleOperationRequest {
  if (!request.targeting || !request.query || !request.editMode) {
    throw new ValidationError(
      "search.edit preview requires targeting, query, and editMode unless operations[] is provided",
    );
  }
  return {
    ...request,
    targeting: request.targeting,
    query: request.query,
    editMode: request.editMode,
    operations: undefined,
  };
}

function operationIdFor(
  operation: SearchEditBatchOperation,
  index: number,
): string {
  const trimmed = operation.id?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `op-${index + 1}`;
}

function assertUniqueOperationIds(
  operations: SearchEditBatchOperation[],
): void {
  const seen = new Map<string, number>();
  for (let index = 0; index < operations.length; index += 1) {
    const operationId = operationIdFor(operations[index], index);
    const firstIndex = seen.get(operationId);
    if (firstIndex !== undefined) {
      throw new ValidationError(
        `Duplicate search.edit operation id "${operationId}" at operations[${index}] (first used at operations[${firstIndex}]).`,
      );
    }
    seen.set(operationId, index);
  }
}

function buildOperationRequest(
  base: SearchEditPreviewRequest,
  operation: SearchEditBatchOperation,
  structuralDeadlineMs?: number,
): SearchEditSingleOperationRequest {
  return {
    repoId: base.repoId,
    targeting: operation.targeting,
    query: operation.query,
    filters: operation.filters ?? base.filters,
    editMode: operation.editMode,
    previewContextLines: base.previewContextLines,
    maxFiles: operation.maxFiles ?? base.maxFiles,
    maxMatchesPerFile: operation.maxMatchesPerFile ?? base.maxMatchesPerFile,
    maxTotalMatches: operation.maxTotalMatches ?? base.maxTotalMatches,
    maxPlanBytes: base.maxPlanBytes,
    createBackup: base.createBackup,
    operations: undefined,
    ...(structuralDeadlineMs !== undefined ? { structuralDeadlineMs } : {}),
  };
}

function changedSourceEdits(
  before: string,
  after: string,
): Array<Omit<SourceEdit, "operationId">> {
  if (before === after) return [];
  const sharedLength = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < sharedLength && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > prefix &&
    afterEnd > prefix &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return [
    {
      start: prefix,
      end: beforeEnd,
      replacement: after.slice(prefix, afterEnd),
    },
  ];
}

function applySourceEdits(content: string, edits: SourceEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const chunks: string[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor) {
      throw new ValidationError(
        `search.edit operation ${edit.operationId} overlaps an earlier planned range`,
      );
    }
    chunks.push(content.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  chunks.push(content.slice(cursor));
  return chunks.join("");
}

function isAstAwareTargeting(
  request: SearchEditSingleOperationRequest,
): boolean {
  return (
    request.targeting === "identifier" ||
    request.targeting === "structural" ||
    request.targeting === "rename"
  );
}

function validateAstAwareRequest(
  request: SearchEditSingleOperationRequest,
): void {
  if (!isAstAwareTargeting(request)) return;
  if (request.editMode !== "replacePattern") {
    throw new ValidationError(
      `${request.targeting} targeting currently supports editMode="replacePattern" only`,
    );
  }
  if (request.targeting === "rename") {
    if (request.editMode !== "replacePattern") {
      throw new ValidationError('rename targeting currently supports editMode="replacePattern" only');
    }
    if (request.query.rename === undefined) {
      throw new ValidationError("rename targeting requires query.rename");
    }
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(request.query.rename.newName)) {
      throw new ValidationError("rename.newName must be a valid identifier");
    }
    const hasOneSymbolId = request.query.symbolIds?.length === 1;
    const hasSymbolRef = request.query.symbolRef !== undefined;
    if (hasOneSymbolId === hasSymbolRef) {
      throw new ValidationError("rename targeting requires exactly one of query.symbolIds[0] or query.symbolRef");
    }
    return;
  }
  if (request.targeting === "identifier") {
    if (request.query.literal === undefined) {
      throw new ValidationError("identifier targeting requires query.literal");
    }
    if (request.query.regex !== undefined) {
      throw new ValidationError(
        "identifier targeting uses AST node text and does not accept query.regex",
      );
    }
    if (request.query.replacement === undefined) {
      throw new ValidationError(
        "identifier targeting requires query.replacement",
      );
    }
    return;
  }

  if (request.query.structural === undefined) {
    throw new ValidationError("structural targeting requires query.structural");
  }
  if (
    request.query.replacement === undefined &&
    request.query.structural.replacement === undefined
  ) {
    throw new ValidationError(
      "structural targeting requires query.replacement or query.structural.replacement",
    );
  }
}

function structuralSourceExtension(extension: string): string | null {
  if (!extension) return null;
  const normalized = normalizeExtensionFilter(extension);
  return getStructuralLanguageForPath(`file${normalized}`) ? normalized : null;
}

function addStructuralLanguageForExtension(
  languages: Set<string>,
  extension: string,
): void {
  const normalized = structuralSourceExtension(extension);
  if (!normalized) return;
  const languageId = getStructuralLanguageForPath(`file${normalized}`);
  if (languageId) languages.add(languageId);
}

function addStructuralExtensionsForIncludePattern(
  extensions: Set<string>,
  include: string,
): boolean {
  const extension = relPathExtension(include);
  if (!extension || extension.includes("*") || extension.includes("?")) {
    return false;
  }

  if (extension.startsWith(".{") && extension.endsWith("}")) {
    for (const part of extension.slice(2, -1).split(",")) {
      const expandedExtension = part.trim();
      if (expandedExtension && !GLOB_META_RE.test(expandedExtension)) {
        const normalized = structuralSourceExtension(expandedExtension);
        if (normalized) extensions.add(normalized);
      }
    }
    return true;
  }

  if (!GLOB_META_RE.test(extension)) {
    const normalized = structuralSourceExtension(extension);
    if (normalized) extensions.add(normalized);
    return true;
  }
  return false;
}

function addStructuralLanguagesForIncludePattern(
  languages: Set<string>,
  include: string,
): void {
  const extensions = new Set<string>();
  addStructuralExtensionsForIncludePattern(extensions, include);
  for (const extension of extensions) {
    addStructuralLanguageForExtension(languages, extension);
  }
}

function inferStructuralLanguageFromFilters(
  filters: SearchEditFilters | undefined,
): string | null {
  const languages = new Set<string>();
  for (const extension of filters?.extensions ?? []) {
    addStructuralLanguageForExtension(languages, extension);
  }
  for (const include of filters?.include ?? []) {
    addStructuralLanguagesForIncludePattern(languages, include);
  }

  if (languages.size === 1) {
    return Array.from(languages)[0];
  }
  if (languages.size > 1) {
    throw new ValidationError(
      `structural targeting spans multiple languages (${Array.from(languages).sort().join(", ")}); use query.structural.language or operations[] with one operation per language`,
    );
  }
  return null;
}

function resolveStructuralLanguageForRequest(
  request: SearchEditSingleOperationRequest,
): string {
  const explicit = request.query.structural?.language;
  if (explicit !== undefined) {
    if (!isStructuralLanguageSupported(explicit)) {
      throw new ValidationError(`Unsupported structural language: ${explicit}`);
    }
    return explicit;
  }

  const inferred = inferStructuralLanguageFromFilters(request.filters);
  if (inferred) return inferred;

  throw new ValidationError(
    "structural targeting requires query.structural.language or filters.include/filters.extensions resolving to exactly one structural language; use operations[] for multi-language structural batches",
  );
}

function prepareAstAwareRequest(
  request: SearchEditSingleOperationRequest,
): SearchEditSingleOperationRequest {
  validateAstAwareRequest(request);
  if (request.targeting !== "structural") return request;
  if (
    request.structuralLanguage !== undefined &&
    request.structuralQueryCache !== undefined
  ) {
    return request;
  }

  const structuralLanguage = resolveStructuralLanguageForRequest(request);
  return {
    ...request,
    structuralLanguage,
    structuralQueryCache: createStructuralQueryCache(
      request.query.structural as StructuralQueryInput,
      structuralLanguage,
    ),
  };
}

function collectAstAwareStructuralEdits(
  content: string,
  relPath: string,
  request: SearchEditSingleOperationRequest,
  maxMatches?: number,
): StructuralSourceEdit[] {
  if (request.targeting === "identifier" || request.targeting === "rename") {
    return collectIdentifierSourceEdits({
      content,
      relPath,
      literal: request.query.literal as string,
      replacement: request.query.replacement as string,
      global: request.query.global ?? true,
      ...(maxMatches !== undefined ? { maxMatches } : {}),
    });
  }
  if (request.targeting === "structural") {
    return collectStructuralSourceEdits({
      content,
      relPath,
      structural: request.query.structural as StructuralQueryInput,
      replacement: request.query.replacement,
      global: request.query.global ?? true,
      ...(maxMatches !== undefined ? { maxMatches } : {}),
      ...(request.structuralDeadlineMs !== undefined
        ? { deadlineMs: request.structuralDeadlineMs }
        : {}),
      ...(request.structuralLanguage !== undefined
        ? { languageIdOverride: request.structuralLanguage }
        : {}),
      ...(request.structuralQueryCache !== undefined
        ? { queryCache: request.structuralQueryCache }
        : {}),
    });
  }
  return [];
}

function toSourceEdits(
  edits: StructuralSourceEdit[],
  operationId: string,
): SourceEdit[] {
  return edits.map((edit) => ({
    operationId,
    start: edit.start,
    end: edit.end,
    replacement: edit.replacement,
  }));
}

function collectAstAwareSourceEdits(
  content: string,
  relPath: string,
  request: SearchEditSingleOperationRequest,
  operationId: string,
  maxMatches?: number,
): SourceEdit[] {
  return toSourceEdits(
    collectAstAwareStructuralEdits(content, relPath, request, maxMatches),
    operationId,
  );
}

function wordRegexForIdentifier(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "g");
}

async function prepareRenameRequest(
  conn: Awaited<ReturnType<typeof getLadybugConn>>,
  request: SearchEditSingleOperationRequest,
): Promise<{
  request: SearchEditSingleOperationRequest;
  candidates: string[];
  skipped: PreviewFileSkip[];
  regex: RegExp;
}> {
  const rename = request.query.rename;
  if (rename === undefined) {
    throw new ValidationError("rename targeting requires query.rename");
  }

  let targetSymbolId = request.query.symbolIds?.[0];
  if (targetSymbolId === undefined && request.query.symbolRef) {
    const resolved = await resolveSymbolRef(
      conn,
      request.repoId,
      request.query.symbolRef,
    );
    if (resolved.status !== "resolved") {
      throw new ValidationError(`rename symbolRef ${resolved.status}`);
    }
    targetSymbolId = resolved.symbolId;
  }
  if (targetSymbolId === undefined) {
    throw new ValidationError("rename targeting requires query.symbolIds[0] or query.symbolRef");
  }

  const target = (await ladybugDb.getSymbolsByIds(conn, [targetSymbolId])).get(targetSymbolId);
  if (!target || target.repoId !== request.repoId) {
    throw new ValidationError(`rename target symbol not found: ${targetSymbolId}`);
  }

  const candidateSet = new Set<string>();
  const targetFile = (await ladybugDb.getFilesByIds(conn, [target.fileId])).get(target.fileId);
  if (targetFile) candidateSet.add(normalizePath(targetFile.relPath));

  const references = await ladybugDb.getReferencingSymbolsForTarget(
    conn,
    request.repoId,
    targetSymbolId,
    rename.minConfidence ?? 0.5,
  );
  for (const ref of references) candidateSet.add(normalizePath(ref.relPath));

  const skipped: PreviewFileSkip[] = [];
  if (rename.includeTextOnlyMatches === true) {
    const rootPath =
      (await ladybugDb.getRepo(conn, request.repoId))?.rootPath ?? "";
    const textCandidates = await enumerateRepoFiles(
      rootPath,
      request.filters,
      request.maxFiles ?? DEFAULT_MAX_FILES,
    );
    // No g flag — .test() must be stateless across the file loop.
    const oldNameRegex = new RegExp(`\\b${escapeRegExp(target.name)}\\b`);
    for (const rel of textCandidates.candidates) {
      if (candidateSet.has(rel)) continue;
      try {
        const abs = resolve(rootPath, rel);
        const readResult = await readSearchEditCandidateFile(rootPath, abs);
        if (readResult.ok && oldNameRegex.test(readResult.value.content)) {
          skipped.push({ path: rel, reason: "text-only-match" });
        }
      } catch {
        // text-only recall hints are best-effort diagnostics.
      }
    }
  }

  const renameCollisionFiles = new Set<string>();
  for (const rel of candidateSet) {
    const fileSymbols = await ladybugDb.getSymbolsForFile(conn, request.repoId, rel);
    if (fileSymbols.some((sym) => sym.name === rename.newName && sym.symbolId !== targetSymbolId)) {
      renameCollisionFiles.add(rel);
    }
  }

  return {
    request: {
      ...request,
      query: {
        ...request.query,
        literal: target.name,
        replacement: rename.newName,
        global: true,
      },
      renameCollisionFiles,
    },
    candidates: [...candidateSet],
    skipped,
    regex: wordRegexForIdentifier(target.name),
  };
}

function truncateCaptureText(text: string): string {
  return text.length > MAX_AST_CAPTURE_TEXT_CHARS
    ? `${text.slice(0, MAX_AST_CAPTURE_TEXT_CHARS)}...`
    : text;
}

function toPreviewAstCapture(
  capture: StructuralSourceEdit["captures"][number],
): PreviewAstCapture {
  return {
    name: capture.name,
    nodeType: capture.nodeType,
    text: truncateCaptureText(capture.text),
    startByte: capture.startByte,
    endByte: capture.endByte,
    range: capture.range,
  };
}

function buildPreviewAstMatches(
  edits: StructuralSourceEdit[],
): PreviewAstMatch[] | undefined {
  if (edits.length === 0) return undefined;
  return edits.slice(0, MAX_AST_MATCH_DETAILS_PER_FILE).map((edit) => {
    const captures = edit.captures
      .slice(0, MAX_AST_CAPTURE_DETAILS_PER_MATCH)
      .map(toPreviewAstCapture);
    const targetCapture =
      edit.captures.find(
        (capture) => capture.start === edit.start && capture.end === edit.end,
      ) ?? edit.captures[0];
    return {
      target: toPreviewAstCapture(targetCapture),
      captures,
    };
  });
}

function narrowQueryForAstAwareTargeting(
  request: SearchEditSingleOperationRequest,
): string | null {
  if (request.targeting === "identifier") {
    return request.query.literal ?? null;
  }
  if (request.targeting !== "structural") {
    return null;
  }
  if (request.query.literal !== undefined && request.query.literal.length > 0) {
    return request.query.literal;
  }
  const required = request.query.structural?.requiredCaptures;
  if (!required) return null;
  const values = Object.values(required)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length > 0 ? values.join(" ") : null;
}

function isAstAwareSourcePath(relPath: string): boolean {
  return getStructuralLanguageForPath(relPath) !== null;
}

function normalizeExtensionFilter(extension: string): string {
  const normalized = extension.toLowerCase();
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

function requestedStructuralExtensions(
  filters: SearchEditFilters | undefined,
): { extensions: string[]; hasExtensionHints: boolean } {
  const extensions = new Set<string>();
  let hasExtensionHints = false;
  for (const extension of filters?.extensions ?? []) {
    hasExtensionHints = true;
    const normalized = structuralSourceExtension(extension);
    if (normalized) extensions.add(normalized);
  }
  for (const include of filters?.include ?? []) {
    hasExtensionHints =
      addStructuralExtensionsForIncludePattern(extensions, include) ||
      hasExtensionHints;
  }
  return { extensions: Array.from(extensions), hasExtensionHints };
}

function filtersForAstAwareCandidates(
  filters: SearchEditFilters | undefined,
  structuralLanguage?: string,
): SearchEditFilters {
  const structuralExtensions = getStructuralExtensions(structuralLanguage);
  const requested = requestedStructuralExtensions(filters);
  const extensions = requested.hasExtensionHints
    ? requested.extensions
    : structuralExtensions;
  return {
    ...filters,
    ...(structuralLanguage ? { structuralLanguage } : {}),
    extensions:
      extensions.length > 0 ? extensions : [NO_AST_AWARE_SOURCE_EXTENSION],
  };
}

function dominantEol(content: string): "\r\n" | "\n" {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/(?<!\r)\n/g) || []).length;
  return crlfCount > lfCount ? "\r\n" : "\n";
}

function expandReplacementString(
  replacement: string,
  match: RegExpExecArray,
  input: string,
): string {
  return replacement.replace(
    /\$(\$|&|`|'|[1-9][0-9]?|<[^>]+>)/g,
    (token, marker: string) => {
      if (marker === "$") return "$";
      if (marker === "&") return match[0];
      if (marker === "`") return input.slice(0, match.index);
      if (marker === "'") return input.slice(match.index + match[0].length);
      if (marker.startsWith("<") && marker.endsWith(">")) {
        const groupName = marker.slice(1, -1);
        return match.groups?.[groupName] ?? "";
      }
      const groupIndex = Number(marker);
      if (Number.isInteger(groupIndex) && groupIndex < match.length) {
        return match[groupIndex] ?? "";
      }
      if (marker.length === 2) {
        const firstGroupIndex = Number(marker[0]);
        if (firstGroupIndex < match.length) {
          return `${match[firstGroupIndex] ?? ""}${marker[1]}`;
        }
      }
      return token;
    },
  );
}

function collectReplacePatternSourceEdits(
  content: string,
  request: SearchEditSingleOperationRequest,
  operationId: string,
): SourceEdit[] {
  if (request.query.replacement === undefined) {
    throw new ValidationError(
      "replacePattern editMode requires query.replacement",
    );
  }
  const regex = compileSearchRegex(request.query, request.query.global ?? true);
  const normalizeReplacementEol = dominantEol(content) === "\r\n";
  const edits: SourceEdit[] = [];
  const matchDeadline = Date.now() + MATCH_TIME_BUDGET_MS;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (Date.now() > matchDeadline) {
      throw new ValidationError("Regex match collection exceeded time budget");
    }
    let replacement = expandReplacementString(
      request.query.replacement,
      match,
      content,
    );
    if (normalizeReplacementEol) {
      replacement = replacement.replace(/(?<!\r)\n/g, "\r\n");
    }
    edits.push({
      operationId,
      start: match.index,
      end: match.index + match[0].length,
      replacement,
    });
    if (!regex.global) break;
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return edits;
}

function sourceEditsForPlan(
  rootPath: string,
  content: string,
  plan: OperationFilePlan,
): SourceEdit[] {
  if (isAstAwareTargeting(plan.request)) {
    return collectAstAwareSourceEdits(
      content,
      plan.edit.relPath,
      plan.request,
      plan.operationId,
    );
  }
  if (plan.request.editMode === "replacePattern") {
    return collectReplacePatternSourceEdits(
      content,
      plan.request,
      plan.operationId,
    );
  }

  const fileWriteRequest = buildFileWriteRequestForMode(
    plan.request.repoId,
    plan.edit.relPath,
    plan.request.editMode,
    plan.request.query,
  );
  validateExactlyOneMode(fileWriteRequest);
  const result = prepareNewContent({
    prepared: {
      repoId: plan.request.repoId,
      rootPath,
      relPath: plan.edit.relPath,
      absPath: plan.edit.absPath,
      fileExists: true,
    },
    request: fileWriteRequest,
    existingContent: content,
    existingBytes: Buffer.byteLength(content, "utf-8"),
  });
  return changedSourceEdits(content, result.newContent).map((range) => ({
    ...range,
    operationId: plan.operationId,
  }));
}

function rangesOverlap(left: SourceRange, right: SourceRange): boolean {
  const leftZeroWidth = left.start === left.end;
  const rightZeroWidth = right.start === right.end;
  if (leftZeroWidth && rightZeroWidth) {
    return left.start === right.start;
  }
  if (leftZeroWidth) {
    return left.start >= right.start && left.start < right.end;
  }
  if (rightZeroWidth) {
    return right.start >= left.start && right.start < left.end;
  }
  return left.start < right.end && right.start < left.end;
}

function describeRange(range: SourceRange): string {
  return `${range.start}-${range.end}`;
}

function isStructuralBudgetError(error: unknown): boolean {
  return (
    error instanceof ValidationError &&
    error.message === STRUCTURAL_QUERY_TIME_BUDGET_ERROR
  );
}

interface SafeReadCandidateResult {
  content: string;
  contentSha: string;
  stats: Stats;
}

async function readSearchEditCandidateFile(
  rootPath: string,
  abs: string,
): Promise<
  { ok: true; value: SafeReadCandidateResult } | { ok: false; reason: string }
> {
  try {
    validatePathWithinRoot(rootPath, abs);
  } catch (err) {
    return {
      ok: false,
      reason: `path-denied:${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  try {
    const linkStats = await lstat(abs);
    if (linkStats.isSymbolicLink()) {
      return { ok: false, reason: "symlink-denied" };
    }
    if (!linkStats.isFile()) {
      return { ok: false, reason: "not-a-file" };
    }
  } catch {
    return { ok: false, reason: "file-missing" };
  }

  const openFlags =
    constants.O_RDONLY |
    (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  let handle;
  try {
    handle = await open(abs, openFlags);
  } catch (err) {
    return {
      ok: false,
      reason: `read-error:${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return { ok: false, reason: "not-a-file" };
    }
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      return { ok: false, reason: "file-too-large" };
    }

    const resolved = realpathSync(abs);
    validatePathWithinRoot(rootPath, resolved);
    const pathStats = await stat(resolved);
    if (
      (stats.dev !== 0 ||
        stats.ino !== 0 ||
        pathStats.dev !== 0 ||
        pathStats.ino !== 0) &&
      (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino)
    ) {
      return { ok: false, reason: "path-changed-during-read" };
    }

    const buf = await handle.readFile();
    if (buf.length > MAX_FILE_SIZE_BYTES) {
      return { ok: false, reason: "file-too-large" };
    }

    const afterRead = realpathSync(abs);
    validatePathWithinRoot(rootPath, afterRead);
    const afterReadStats = await stat(afterRead);
    if (
      (stats.dev !== 0 ||
        stats.ino !== 0 ||
        afterReadStats.dev !== 0 ||
        afterReadStats.ino !== 0) &&
      (stats.dev !== afterReadStats.dev || stats.ino !== afterReadStats.ino)
    ) {
      return { ok: false, reason: "path-changed-during-read" };
    }

    if (buf.includes(0)) {
      return { ok: false, reason: "binary-content" };
    }

    return {
      ok: true,
      value: {
        content: buf.toString("utf-8"),
        contentSha: createHash("sha256").update(buf).digest("hex"),
        stats,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `path-denied:${err instanceof Error ? err.message : "unknown"}`,
    };
  } finally {
    await handle.close();
  }
}

async function planSearchEditBatchPreview(
  request: SearchEditPreviewRequest,
  operations: SearchEditBatchOperation[],
): Promise<PreviewResult> {
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, request.repoId);
  if (!repo) {
    throw new NotFoundError(`Repository ${request.repoId} not found`);
  }
  const rootPath = repo.rootPath;
  assertUniqueOperationIds(operations);
  const structuralDeadlineMs =
    Date.now() + STRUCTURAL_PREVIEW_REQUEST_BUDGET_MS;
  const maxPlanBytes = request.maxPlanBytes ?? MAX_PLAN_BYTES;
  const previewBytesByFile = new Map<string, number>();
  let estimatedPreviewBytes = 0;
  const operationPreviews: OperationPreview[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const operationRequest = prepareAstAwareRequest({
      ...buildOperationRequest(request, operation, structuralDeadlineMs),
      maxPlanBytes,
    });
    const preview = await planSingleSearchEditPreview(operationRequest);
    for (const edit of preview.edits) {
      const previewBytes = Buffer.byteLength(edit.newContent, "utf-8");
      const previousBytes = previewBytesByFile.get(edit.relPath) ?? 0;
      if (previewBytes > previousBytes) {
        estimatedPreviewBytes += previewBytes - previousBytes;
        previewBytesByFile.set(edit.relPath, previewBytes);
      }
    }
    if (estimatedPreviewBytes > maxPlanBytes) {
      throw new ValidationError(aggregateByteCapExceededReason(maxPlanBytes));
    }
    operationPreviews.push({
      operationId: operationIdFor(operation, index),
      request: operationRequest,
      preview,
    });
  }

  const filePlans = new Map<string, OperationFilePlan[]>();
  const filesSkipped: PreviewFileSkip[] = [];
  let retrievalEvidence: RetrievalEvidence | undefined;
  let partial = false;
  for (const operationPreview of operationPreviews) {
    retrievalEvidence ??= operationPreview.preview.retrievalEvidence;
    partial = partial || operationPreview.preview.summary.partial === true;
    for (const skipped of operationPreview.preview.summary.filesSkipped) {
      filesSkipped.push({
        ...skipped,
        operationId: operationPreview.operationId,
      });
    }
    for (const edit of operationPreview.preview.edits) {
      const previewEntry = operationPreview.preview.summary.fileEntries.find(
        (entry) => entry.file === edit.relPath,
      );
      const plans = filePlans.get(edit.relPath) ?? [];
      plans.push({
        operationId: operationPreview.operationId,
        request: operationPreview.request,
        edit,
        astMatches: previewEntry?.astMatches,
      });
      filePlans.set(edit.relPath, plans);
    }
  }

  const edits: PlannedFileEdit[] = [];
  const preconditions: PlanPrecondition[] = [];
  const fileEntries: PreviewFileEntry[] = [];
  const maxFiles = request.maxFiles ?? DEFAULT_MAX_FILES;
  const maxMatchesPerFile =
    request.maxMatchesPerFile ?? DEFAULT_MAX_MATCHES_PER_FILE;
  const maxTotalMatches = request.maxTotalMatches ?? DEFAULT_MAX_TOTAL_MATCHES;
  const contextLines =
    request.previewContextLines ?? DEFAULT_PREVIEW_CONTEXT_LINES;
  const createBackup = request.createBackup ?? true;
  let aggregateBytes = 0;
  let totalMatches = 0;
  let structuralBudgetExhausted = false;

  for (const [rel, plans] of Array.from(filePlans).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (structuralBudgetExhausted) {
      partial = true;
      break;
    }
    if (edits.length >= maxFiles) {
      filesSkipped.push({ path: rel, reason: maxFilesReachedReason(maxFiles) });
      partial = true;
      continue;
    }
    if (totalMatches >= maxTotalMatches) {
      filesSkipped.push({
        path: rel,
        reason: maxTotalMatchesReachedReason(maxTotalMatches),
      });
      partial = true;
      continue;
    }

    const firstEdit = plans[0].edit;
    const abs = firstEdit.absPath;
    const readResult = await readSearchEditCandidateFile(rootPath, abs);
    if (!readResult.ok) {
      filesSkipped.push({ path: rel, reason: readResult.reason });
      partial = true;
      continue;
    }
    const { content, contentSha, stats } = readResult.value;
    const sourceEdits: SourceEdit[] = [];
    const recomputedMatchCounts = new Map<string, number>();
    let skipFileReason: PreviewFileSkip | undefined;

    for (const plan of plans) {
      let ranges: SourceEdit[];
      try {
        ranges = sourceEditsForPlan(rootPath, content, plan);
      } catch (err) {
        if (isStructuralBudgetError(err)) {
          skipFileReason = {
            path: rel,
            reason: STRUCTURAL_QUERY_TIME_BUDGET_SKIP_REASON,
            operationId: plan.operationId,
          };
          structuralBudgetExhausted = true;
          break;
        }
        throw err;
      }
      recomputedMatchCounts.set(plan.operationId, ranges.length);
      for (const range of ranges) {
        const overlap = sourceEdits.find((candidate) =>
          rangesOverlap(candidate, range),
        );
        if (overlap) {
          throw new ValidationError(
            `search.edit operations ${overlap.operationId} and ${range.operationId} in ${rel} overlap: ranges ${describeRange(overlap)} and ${describeRange(range)}`,
          );
        }
        sourceEdits.push(range);
      }
    }
    if (skipFileReason) {
      filesSkipped.push(skipFileReason);
      partial = true;
      continue;
    }

    sourceEdits.sort((a, b) => a.start - b.start || a.end - b.end);
    const newContent = applySourceEdits(content, sourceEdits);
    let matchCount = 0;
    const operationSummaries: NonNullable<PreviewFileEntry["operations"]> = [];
    const operationIds: string[] = [];
    const astMatches = plans
      .flatMap((plan) => plan.astMatches ?? [])
      .slice(0, MAX_AST_MATCH_DETAILS_PER_FILE);
    for (const plan of plans) {
      const planMatchCount =
        recomputedMatchCounts.get(plan.operationId) ?? plan.edit.matchCount;
      matchCount += planMatchCount;
      operationIds.push(plan.operationId);
      operationSummaries.push({
        id: plan.operationId,
        matchCount: planMatchCount,
        editMode: plan.edit.editMode,
      });
    }
    if (matchCount > maxMatchesPerFile) {
      filesSkipped.push({
        path: rel,
        reason: `matches-exceed-per-file-cap:${maxMatchesPerFile}; raise maxMatchesPerFile or narrow filters/query`,
      });
      partial = true;
      continue;
    }
    if (totalMatches + matchCount > maxTotalMatches) {
      filesSkipped.push({
        path: rel,
        reason: matchesExceedTotalCapReason(maxTotalMatches),
      });
      partial = true;
      continue;
    }

    if (newContent === content) {
      filesSkipped.push({ path: rel, reason: "no-change" });
      continue;
    }

    const editBytes = Buffer.byteLength(newContent, "utf-8");
    aggregateBytes += editBytes;
    if (aggregateBytes > maxPlanBytes) {
      aggregateBytes -= editBytes;
      filesSkipped.push({
        path: rel,
        reason: aggregateByteCapExceededReason(maxPlanBytes),
      });
      partial = true;
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
      newContent,
      createBackup,
      fileExists: true,
      indexedSource,
      matchCount,
      editMode: plans.length === 1 ? plans[0].edit.editMode : "overwrite",
      operationIds,
    });
    fileEntries.push({
      file: rel,
      matchCount,
      editMode: plans.length === 1 ? plans[0].edit.editMode : "overwrite",
      snippets: buildSearchEditPreviewSnippets(
        content,
        newContent,
        contextLines,
        null,
      ),
      indexedSource,
      ...(astMatches.length > 0 ? { astMatches } : {}),
      operationIds,
      operations: operationSummaries,
    });
    totalMatches += matchCount;
  }

  return {
    edits,
    preconditions,
    ...(retrievalEvidence ? { retrievalEvidence } : {}),
    summary: {
      filesMatched: edits.length,
      matchesFound: totalMatches,
      filesEligible: filePlans.size,
      filesSkipped,
      fileEntries,
      ...(partial ? { partial: true } : {}),
    },
  };
}

export async function planSearchEditPreview(
  request: SearchEditPreviewRequest,
): Promise<PreviewResult> {
  if (request.operations && request.operations.length > 0) {
    return planSearchEditBatchPreview(request, request.operations);
  }
  const single = coerceSingleSearchEditRequest(request);
  if (single.targeting === "signature") {
    return planSignatureSearchEditPreview(single);
  }
  return planSingleSearchEditPreview(single);
}

function splitCommaList(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let quote: string | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const prev = text[index - 1];
    if (quote !== null) {
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "<") angleDepth += 1;
    else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (
      ch === "," &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0
    ) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  const tail = text.slice(start).trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

const IDENTIFIER_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function parameterName(param: string): string {
  return (
    param
      .trim()
      .match(/^(?:\.\.\.)?\s*(?:(?:public|private|protected|readonly|override)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)/)?.[1] ?? ""
  );
}
function formatAddedParam(add: NonNullable<SignatureOps["add"]>[number]): string {
  return add.name + (add.typeText ? ": " + add.typeText : "") + (add.defaultText ? " = " + add.defaultText : "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertSignatureOpsValid(signature: SignatureOps): void {
  const hasOps =
    (signature.add?.length ?? 0) > 0 ||
    (signature.remove?.length ?? 0) > 0 ||
    (signature.renameParam?.length ?? 0) > 0;
  if (!hasOps) {
    throw new ValidationError("signature targeting requires at least one signature operation");
  }
  for (const add of signature.add ?? []) {
    if (!IDENTIFIER_NAME_RE.test(add.name)) {
      throw new ValidationError("signature.add.name must be a valid identifier");
    }
    if (add.index !== undefined && (!Number.isInteger(add.index) || add.index < 0)) {
      throw new ValidationError("signature.add.index must be a non-negative integer");
    }
  }
  for (const remove of signature.remove ?? []) {
    if (!IDENTIFIER_NAME_RE.test(remove.name)) {
      throw new ValidationError("signature.remove.name must be a valid identifier");
    }
  }
  for (const rename of signature.renameParam ?? []) {
    if (!IDENTIFIER_NAME_RE.test(rename.from) || !IDENTIFIER_NAME_RE.test(rename.to)) {
      throw new ValidationError("signature.renameParam names must be valid identifiers");
    }
  }
}

function applySignatureOpsToParams(paramsText: string, signature: SignatureOps): { paramsText: string; originalNames: string[] } {
  const params = splitCommaList(paramsText);
  const originalNames = params.map(parameterName);
  for (const remove of signature.remove ?? []) {
    const index = params.findIndex((param) => parameterName(param) === remove.name);
    if (index === -1) throw new ValidationError("signature remove param not found: " + remove.name);
    params.splice(index, 1);
  }
  for (const rename of signature.renameParam ?? []) {
    const index = params.findIndex((param) => parameterName(param) === rename.from);
    if (index === -1) throw new ValidationError("signature rename param not found: " + rename.from);
    params[index] = params[index].replace(new RegExp("^" + escapeRegExp(rename.from) + "\\b"), rename.to);
  }
  for (const add of signature.add ?? []) {
    const insertAt = Math.min(Math.max(add.index ?? params.length, 0), params.length);
    params.splice(insertAt, 0, formatAddedParam(add));
  }
  return { paramsText: params.join(", "), originalNames };
}

function skipWhitespace(content: string, index: number): number {
  let cursor = index;
  while (cursor < content.length && /\s/.test(content[cursor] ?? "")) cursor += 1;
  return cursor;
}

function findMatchingDelimiter(content: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openIndex; index < content.length; index += 1) {
    const ch = content[index];
    const next = content[index + 1];
    const prev = content[index - 1];
    if (quote !== null) {
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      const newline = content.indexOf("\n", index + 2);
      if (newline === -1) return -1;
      index = newline;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = content.indexOf("*/", index + 2);
      if (close === -1) return -1;
      index = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function skipReturnType(content: string, index: number): number {
  let cursor = skipWhitespace(content, index);
  if (content[cursor] !== ":") return cursor;
  cursor += 1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  while (cursor < content.length) {
    const ch = content[cursor];
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "{") {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) break;
      braceDepth += 1;
    } else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "<") angleDepth += 1;
    else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if ((ch === ";" || ch === "=" || ch === "\n") && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
      break;
    }
    cursor += 1;
  }
  return skipWhitespace(content, cursor);
}

interface SignatureDeclaration {
  paramsStart: number;
  paramsEnd: number;
  bodyStart?: number;
  bodyEnd?: number;
  overload: boolean;
}

function declarationAfterParams(content: string, closeParen: number): SignatureDeclaration | null {
  const cursor = skipReturnType(content, closeParen + 1);
  if (content[cursor] === ";") {
    return { paramsStart: 0, paramsEnd: 0, overload: true };
  }
  if (content[cursor] === "{") {
    const closeBrace = findMatchingDelimiter(content, cursor, "{", "}");
    if (closeBrace === -1) return null;
    return { paramsStart: 0, paramsEnd: 0, bodyStart: cursor + 1, bodyEnd: closeBrace, overload: false };
  }
  if (content.slice(cursor, cursor + 2) === "=>") {
    const bodyStart = skipWhitespace(content, cursor + 2);
    if (content[bodyStart] === "{") {
      const closeBrace = findMatchingDelimiter(content, bodyStart, "{", "}");
      if (closeBrace === -1) return null;
      return { paramsStart: 0, paramsEnd: 0, bodyStart: bodyStart + 1, bodyEnd: closeBrace, overload: false };
    }
    let bodyEnd = content.indexOf(";", bodyStart);
    const newline = content.indexOf("\n", bodyStart);
    if (bodyEnd === -1 || (newline !== -1 && newline < bodyEnd)) bodyEnd = newline;
    if (bodyEnd === -1) bodyEnd = content.length;
    return { paramsStart: 0, paramsEnd: 0, bodyStart, bodyEnd, overload: false };
  }
  return null;
}

function pushSignatureDeclaration(
  declarations: SignatureDeclaration[],
  seenParamStarts: Set<number>,
  content: string,
  openParen: number,
): void {
  if (openParen < 0 || seenParamStarts.has(openParen + 1)) return;
  const closeParen = findMatchingDelimiter(content, openParen, "(", ")");
  if (closeParen === -1) return;
  const tail = declarationAfterParams(content, closeParen);
  if (!tail) return;
  seenParamStarts.add(openParen + 1);
  declarations.push({
    ...tail,
    paramsStart: openParen + 1,
    paramsEnd: closeParen,
  });
}

function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

function previousNonWhitespace(content: string, index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(content[cursor] ?? "")) return content[cursor];
  }
  return undefined;
}

function declarationPrefixStart(content: string, nameStart: number): number {
  const lineStart = content.lastIndexOf("\n", nameStart - 1) + 1;
  const blockStart = content.lastIndexOf("{", nameStart - 1) + 1;
  const semicolonStart = content.lastIndexOf(";", nameStart - 1) + 1;
  return Math.max(lineStart, blockStart, semicolonStart, 0);
}

function hasSignatureDeclarationPrefix(content: string, nameStart: number): boolean {
  const previous = previousNonWhitespace(content, nameStart);
  if (previous === "." || previous === ")" || previous === "]") {
    return false;
  }
  const prefix = content.slice(declarationPrefixStart(content, nameStart), nameStart).trimStart();
  return (
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+$/.test(prefix) ||
    /^(?:export\s+)?(?:const|let|var)\s+$/.test(prefix) ||
    /^(?:(?:public|private|protected|static|async|override|readonly)\s+)*$/.test(prefix)
  );
}

function hasVariableDeclarationPrefix(content: string, nameStart: number): boolean {
  const prefix = content.slice(declarationPrefixStart(content, nameStart), nameStart).trimStart();
  return /^(?:export\s+)?(?:const|let|var)\s+$/.test(prefix);
}

function arrowOpenParenAfterName(content: string, nameEnd: number): number {
  let cursor = skipWhitespace(content, nameEnd);
  if (content[cursor] === ":") {
    cursor += 1;
    while (cursor < content.length && content[cursor] !== "=" && content[cursor] !== "\n" && content[cursor] !== ";") {
      cursor += 1;
    }
  }
  if (content[cursor] !== "=") return -1;
  cursor = skipWhitespace(content, cursor + 1);
  if (content.slice(cursor, cursor + 5) === "async" && !isIdentifierChar(content[cursor + 5])) {
    cursor = skipWhitespace(content, cursor + 5);
  }
  return content[cursor] === "(" ? cursor : -1;
}

function findSignatureDeclarations(content: string, name: string): SignatureDeclaration[] {
  const declarations: SignatureDeclaration[] = [];
  const seenParamStarts = new Set<number>();
  let nameStart = content.indexOf(name);
  while (nameStart !== -1) {
    const nameEnd = nameStart + name.length;
    if (
      !isIdentifierChar(content[nameStart - 1]) &&
      !isIdentifierChar(content[nameEnd]) &&
      hasSignatureDeclarationPrefix(content, nameStart)
    ) {
      let openParen = skipWhitespace(content, nameEnd);
      if (content[openParen] !== "(" && hasVariableDeclarationPrefix(content, nameStart)) {
        openParen = arrowOpenParenAfterName(content, nameEnd);
      }
      if (content[openParen] === "(") {
        pushSignatureDeclaration(declarations, seenParamStarts, content, openParen);
      }
    }
    nameStart = content.indexOf(name, nameEnd);
  }
  return declarations.sort((a, b) => a.paramsStart - b.paramsStart);
}

function isTypeScriptOrJavaScriptPath(relPath: string): boolean {
  return /[.][cm]?[jt]sx?$/.test(relPath);
}

function buildSignatureDeclarationEdits(content: string, relPath: string, name: string, signature: SignatureOps): { edits: SourceEdit[]; originalNames: string[] } {
  const declarations = findSignatureDeclarations(content, name);
  if (declarations.length === 0) throw new ValidationError("signature target declaration not found");
  if (declarations.length > 1 || declarations.some((declaration) => declaration.overload)) {
    throw new ValidationError("overloads-not-supported");
  }
  const declaration = declarations[0];
  const transformed = applySignatureOpsToParams(content.slice(declaration.paramsStart, declaration.paramsEnd), signature);
  const edits: SourceEdit[] = [
    {
      operationId: "signature",
      start: declaration.paramsStart,
      end: declaration.paramsEnd,
      replacement: transformed.paramsText,
    },
  ];
  for (const rename of signature.renameParam ?? []) {
    if (declaration.bodyStart === undefined || declaration.bodyEnd === undefined) continue;
    const identifierEdits = collectIdentifierSourceEdits({
      content,
      relPath,
      literal: rename.from,
      replacement: rename.to,
      global: true,
    }).filter((edit) => edit.start >= declaration.bodyStart! && edit.end <= declaration.bodyEnd!);
    edits.push(...toSourceEdits(identifierEdits, "signature"));
  }
  return { edits, originalNames: transformed.originalNames };
}

function callsiteOpsRequested(signature: SignatureOps): boolean {
  return (signature.add?.length ?? 0) > 0 || (signature.remove?.length ?? 0) > 0;
}

function buildSignatureCallsiteEdits(content: string, name: string, signature: SignatureOps, originalNames: string[]): { edits: SourceEdit[]; skipReason?: string } {
  if (!callsiteOpsRequested(signature)) return { edits: [] };
  if ((signature.add ?? []).some((add) => add.argText === undefined)) return { edits: [], skipReason: "needs-arg-value" };
  if (new RegExp("\\b" + escapeRegExp(name) + "\\s*\\.\\s*(?:apply|call)\\s*\\(").test(content)) {
    return { edits: [], skipReason: "manual-review" };
  }

  const edits: SourceEdit[] = [];
  const call = new RegExp("\\b" + escapeRegExp(name) + "\\s*\\(", "g");
  let sawManualReview = false;
  let sawArityMismatch = false;
  let sawCall = false;
  let match: RegExpExecArray | null;
  while ((match = call.exec(content)) !== null) {
    const openParen = content.indexOf("(", match.index);
    const closeParen = findMatchingDelimiter(content, openParen, "(", ")");
    if (closeParen === -1) {
      sawManualReview = true;
      break;
    }
    const prefix = content.slice(Math.max(0, match.index - 24), match.index);
    if (/function\s+$/.test(prefix)) {
      call.lastIndex = closeParen + 1;
      continue;
    }
    if (hasSignatureDeclarationPrefix(content, match.index) && declarationAfterParams(content, closeParen)) {
      call.lastIndex = closeParen + 1;
      continue;
    }

    sawCall = true;
    const argsStart = openParen + 1;
    const argsEnd = closeParen;
    const args = splitCommaList(content.slice(argsStart, argsEnd));
    if (args.some((arg) => arg.trim().startsWith("..."))) {
      sawManualReview = true;
      break;
    }
    for (const remove of signature.remove ?? []) {
      const index = originalNames.indexOf(remove.name);
      if (index >= 0) {
        if (args.length <= index) {
          sawArityMismatch = true;
          break;
        }
        args.splice(index, 1);
      }
    }
    if (sawArityMismatch) break;
    for (const add of signature.add ?? []) {
      const insertAt = Math.min(Math.max(add.index ?? args.length, 0), args.length);
      args.splice(insertAt, 0, add.argText as string);
    }
    edits.push({ operationId: "signature", start: argsStart, end: argsEnd, replacement: args.join(", ") });
    call.lastIndex = closeParen + 1;
  }
  if (sawManualReview) return { edits: [], skipReason: "manual-review" };
  if (sawArityMismatch) return { edits: [], skipReason: "arity-mismatch" };
  if (edits.length === 0 && !sawCall) return { edits: [], skipReason: "no-signature-match" };
  return { edits };
}

async function resolveTargetSymbolForRefactor(
  conn: Awaited<ReturnType<typeof getLadybugConn>>,
  request: SearchEditSingleOperationRequest,
): Promise<{ symbolId: string; name: string; fileId: string }> {
  let targetSymbolId = request.query.symbolIds?.[0];
  if (targetSymbolId === undefined && request.query.symbolRef) {
    const resolved = await resolveSymbolRef(conn, request.repoId, request.query.symbolRef);
    if (resolved.status !== "resolved") throw new ValidationError("symbolRef " + resolved.status);
    targetSymbolId = resolved.symbolId;
  }
  if (targetSymbolId === undefined) throw new ValidationError("signature targeting requires query.symbolIds[0] or query.symbolRef");
  const target = (await ladybugDb.getSymbolsByIds(conn, [targetSymbolId])).get(targetSymbolId);
  if (!target || target.repoId !== request.repoId) throw new ValidationError("signature target symbol not found: " + targetSymbolId);
  return { symbolId: target.symbolId, name: target.name, fileId: target.fileId };
}

async function planSignatureSearchEditPreview(request: SearchEditSingleOperationRequest): Promise<PreviewResult> {
  const signature = request.query.signature;
  if (signature === undefined) throw new ValidationError("signature targeting requires query.signature");
  assertSignatureOpsValid(signature);
  if (request.editMode !== "replacePattern") throw new ValidationError("signature targeting currently supports editMode=replacePattern only");
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, request.repoId);
  if (!repo) throw new NotFoundError("Repository " + request.repoId + " not found");
  const rootPath = repo.rootPath;
  const createBackup = request.createBackup ?? true;
  const contextLines = request.previewContextLines ?? DEFAULT_PREVIEW_CONTEXT_LINES;
  const target = await resolveTargetSymbolForRefactor(conn, request);
  const targetFile = (await ladybugDb.getFilesByIds(conn, [target.fileId])).get(target.fileId);
  if (!targetFile) throw new ValidationError("signature target file not found");
  const declarationRel = normalizePath(targetFile.relPath);
  if (!isTypeScriptOrJavaScriptPath(declarationRel)) {
    throw new ValidationError("signature targeting is only supported for TypeScript/JavaScript files");
  }

  const candidates = new Map<string, "declaration" | "callsite">();
  candidates.set(declarationRel, "declaration");
  if (callsiteOpsRequested(signature)) {
    const refs = await ladybugDb.getReferencingSymbolsForTarget(conn, request.repoId, target.symbolId, 0.5);
    for (const ref of refs) {
      if (ref.edgeType !== "calls") continue;
      const rel = normalizePath(ref.relPath);
      if (!candidates.has(rel)) candidates.set(rel, "callsite");
    }
  }

  const edits: PlannedFileEdit[] = [];
  const preconditions: PlanPrecondition[] = [];
  const fileEntries: PreviewFileEntry[] = [];
  const filesSkipped: PreviewFileSkip[] = [];
  const regex = wordRegexForIdentifier(target.name);
  let totalMatches = 0;
  let originalNames: string[] = [];
  let aggregateBytes = 0;
  const maxFiles = request.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalMatches = request.maxTotalMatches ?? DEFAULT_MAX_TOTAL_MATCHES;
  const maxPlanBytes = request.maxPlanBytes ?? MAX_PLAN_BYTES;
  const orderedCandidates = [
    [declarationRel, "declaration"] as const,
    ...[...candidates.entries()]
      .filter(([rel]) => rel !== declarationRel)
      .sort((a, b) => a[0].localeCompare(b[0])),
  ];

  for (const [rel, role] of orderedCandidates) {
    if (edits.length >= maxFiles) {
      filesSkipped.push({ path: rel, reason: maxFilesReachedReason(maxFiles) });
      continue;
    }
    if (totalMatches >= maxTotalMatches) {
      filesSkipped.push({ path: rel, reason: maxTotalMatchesReachedReason(maxTotalMatches) });
      continue;
    }
    if (!isTypeScriptOrJavaScriptPath(rel)) {
      filesSkipped.push({ path: rel, reason: "unsupported-language" });
      continue;
    }
    const abs = resolve(rootPath, rel);
    const readResult = await readSearchEditCandidateFile(rootPath, abs);
    if (!readResult.ok) {
      filesSkipped.push({ path: rel, reason: readResult.reason });
      continue;
    }
    const { content, contentSha, stats } = readResult.value;
    let sourceEdits: SourceEdit[] = [];
    let skipReason: string | undefined;
    if (role === "declaration") {
      const result = buildSignatureDeclarationEdits(content, rel, target.name, signature);
      sourceEdits = result.edits;
      originalNames = result.originalNames;
    } else {
      const result = buildSignatureCallsiteEdits(content, target.name, signature, originalNames);
      sourceEdits = result.edits;
      skipReason = result.skipReason;
    }
    if (sourceEdits.length === 0) {
      // Always record a reason — silently dropping a candidate hides
      // callsite files the agent expected to see in the summary.
      filesSkipped.push({ path: rel, reason: skipReason ?? "no-signature-match" });
      continue;
    }
    if (totalMatches + sourceEdits.length > maxTotalMatches) {
      filesSkipped.push({ path: rel, reason: matchesExceedTotalCapReason(maxTotalMatches) });
      continue;
    }
    const newContent = applySourceEdits(content, sourceEdits);
    if (newContent === content) {
      filesSkipped.push({ path: rel, reason: "no-change" });
      continue;
    }
    const editBytes = Buffer.byteLength(newContent, "utf-8");
    aggregateBytes += editBytes;
    if (aggregateBytes > maxPlanBytes) {
      aggregateBytes -= editBytes;
      filesSkipped.push({ path: rel, reason: aggregateByteCapExceededReason(maxPlanBytes) });
      continue;
    }
    preconditions.push({ relPath: rel, absPath: abs, sha256: contentSha, mtimeMs: stats.mtimeMs });
    edits.push({ relPath: rel, absPath: abs, newContent, createBackup, fileExists: true, indexedSource: isIndexedSource(rel), matchCount: sourceEdits.length, editMode: "replacePattern" });
    fileEntries.push({ file: rel, matchCount: sourceEdits.length, editMode: "replacePattern", snippets: buildSearchEditPreviewSnippets(content, newContent, contextLines, regex), indexedSource: isIndexedSource(rel) });
    totalMatches += sourceEdits.length;
  }

  return {
    edits,
    preconditions,
    summary: {
      filesMatched: edits.length,
      matchesFound: totalMatches,
      filesEligible: candidates.size,
      filesSkipped,
      fileEntries,
      ...(filesSkipped.some((s) => isPartialSkipReason(s.reason)) ? { partial: true } : {}),
    },
  };
}

/**
 * Build the preview plan for a request. Caller stores the result.
 */
async function planSingleSearchEditPreview(
  request: SearchEditSingleOperationRequest,
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
  request = prepareAstAwareRequest(request);
  if (
    isAstAwareTargeting(request) &&
    request.structuralDeadlineMs === undefined
  ) {
    request = {
      ...request,
      structuralDeadlineMs: Date.now() + STRUCTURAL_PREVIEW_REQUEST_BUDGET_MS,
    };
  }

  let candidates: string[];
  let skipped: PreviewFileSkip[];
  let regex: RegExp | null = null;
  let candidatesCapped = false;

  let retrievalEvidence: RetrievalEvidence | undefined;
  if (request.targeting === "rename") {
    const renamePlan = await prepareRenameRequest(conn, request);
    request = renamePlan.request;
    candidates = renamePlan.candidates;
    skipped = renamePlan.skipped;
    regex = renamePlan.regex;
  } else if (request.targeting === "text" || isAstAwareTargeting(request)) {
    if (request.targeting === "text") {
      regex = compileSearchRegex(request.query, true);
    }
    skipped = [];
    candidates = [];
    const candidateFilters = isAstAwareTargeting(request)
      ? filtersForAstAwareCandidates(
          request.filters,
          request.targeting === "structural"
            ? request.structuralLanguage
            : undefined,
        )
      : request.filters;

    const explicitIncludes = await enumerateExplicitIncludeFiles(
      rootPath,
      candidateFilters,
      maxFiles,
    );
    if (explicitIncludes) {
      candidates = explicitIncludes.candidates;
      skipped.push(...explicitIncludes.skipped);
      candidatesCapped = explicitIncludes.capped;
    }

    let narrowQuery: string | null = narrowQueryForAstAwareTargeting(request);
    if (
      narrowQuery === null &&
      request.query.literal !== undefined &&
      request.query.literal.length > 0
    ) {
      narrowQuery = request.query.literal;
    } else if (narrowQuery === null && request.query.regex !== undefined) {
      const KEYWORD_STOPWORDS = new Set([
        "if",
        "else",
        "for",
        "while",
        "do",
        "switch",
        "case",
        "break",
        "return",
        "throw",
        "try",
        "catch",
        "finally",
        "new",
        "delete",
        "typeof",
        "instanceof",
        "void",
        "this",
        "super",
        "class",
        "extends",
        "implements",
        "interface",
        "enum",
        "const",
        "let",
        "var",
        "function",
        "async",
        "await",
        "import",
        "export",
        "from",
        "default",
        "static",
        "public",
        "private",
        "protected",
        "abstract",
        "override",
        "readonly",
        "type",
        "namespace",
      ]);
      const tokens = (
        request.query.regex.match(/[A-Za-z_][A-Za-z0-9_]{1,}/g) ?? []
      ).filter((t) => !KEYWORD_STOPWORDS.has(t.toLowerCase()));
      narrowQuery = tokens.length > 0 ? tokens.join(" ") : null;
    }

    if (!explicitIncludes && narrowQuery) {
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
          const { allowed, reason } = isPathAllowed(rel, candidateFilters);
          if (!allowed) {
            if (shouldReportSkippedFile(reason)) {
              skipped.push({ path: rel, reason: reason ?? "skipped" });
            }
            continue;
          }
          candidates.push(rel);
        }
        if (candidates.length < maxFiles) {
          const enumerated = await enumerateRepoFiles(
            rootPath,
            candidateFilters,
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
    if (!explicitIncludes && candidates.length === 0) {
      const enumerated = await enumerateRepoFiles(
        rootPath,
        candidateFilters,
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
    const symbolRefs: Array<{
      symbolId: string;
      fileId: string;
      file?: string;
    }> = [];
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
          const fileRow = (
            await ladybugDb.getFilesByIds(conn, [sym.fileId])
          ).get(sym.fileId);
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
    for (const r of symbolRefs) {
      if (r.file) uniqueFiles.add(normalizePath(r.file));
    }
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
  const maxPlanBytes = request.maxPlanBytes ?? MAX_PLAN_BYTES;
  for (const rel of candidates) {
    if (edits.length >= maxFiles) {
      skipped.push({ path: rel, reason: maxFilesReachedReason(maxFiles) });
      continue;
    }
    if (totalMatches >= maxTotalMatches) {
      skipped.push({
        path: rel,
        reason: maxTotalMatchesReachedReason(maxTotalMatches),
      });
      continue;
    }
    const { allowed: pathAllowed, reason: pathReason } = isPathAllowed(
      rel,
      request.filters,
    );
    if (!pathAllowed) {
      if (shouldReportSkippedFile(pathReason)) {
        skipped.push({ path: rel, reason: pathReason ?? "skipped" });
      }
      continue;
    }
    if (isAstAwareTargeting(request) && !isAstAwareSourcePath(rel)) {
      skipped.push({
        path: rel,
        reason:
          request.targeting === "rename"
            ? "unsupported-language"
            : "structural-unsupported-extension",
      });
      continue;
    }
    if (request.targeting === "rename" && request.renameCollisionFiles?.has(rel)) {
      skipped.push({ path: rel, reason: "name-collision" });
      continue;
    }
    if (request.targeting === "structural") {
      const mismatchReason = structuralLanguageMismatchReason(
        rel,
        request.structuralLanguage,
      );
      if (mismatchReason) {
        skipped.push({ path: rel, reason: mismatchReason });
        continue;
      }
    }
    const abs = resolve(rootPath, rel);
    const readResult = await readSearchEditCandidateFile(rootPath, abs);
    if (!readResult.ok) {
      skipped.push({ path: rel, reason: readResult.reason });
      continue;
    }
    const { content, contentSha, stats } = readResult.value;

    let matchCount = 0;
    if (regex) {
      const countRegex = new RegExp(regex.source, "g");
      const matchDeadline = Date.now() + MATCH_TIME_BUDGET_MS;
      let m;
      while ((m = countRegex.exec(content)) !== null) {
        matchCount++;
        if (matchCount >= maxMatchesPerFile) break;
        if (Date.now() > matchDeadline) {
          throw new ValidationError(
            "Regex match counting exceeded time budget",
          );
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
        skipped.push({
          path: rel,
          reason: `matches-exceed-per-file-cap:${maxMatchesPerFile}; raise maxMatchesPerFile or narrow filters/query`,
        });
        continue;
      }
      if (matchCount === 0 && request.targeting === "text") {
        // no match in this candidate; skip silently
        continue;
      }
    }

    let result: {
      newContent: string;
      replacementCount?: number;
      mode: FileWriteResponse["mode"];
    };
    let astMatches: PreviewAstMatch[] | undefined;
    if (isAstAwareTargeting(request)) {
      let structuralEdits: StructuralSourceEdit[];
      try {
        structuralEdits = collectAstAwareStructuralEdits(
          content,
          rel,
          request,
          maxMatchesPerFile + 1,
        );
      } catch (err) {
        if (isStructuralBudgetError(err)) {
          skipped.push({
            path: rel,
            reason: STRUCTURAL_QUERY_TIME_BUDGET_SKIP_REASON,
          });
          break;
        }
        throw err;
      }
      if (structuralEdits.length > maxMatchesPerFile) {
        skipped.push({
          path: rel,
          reason: `matches-exceed-per-file-cap:${maxMatchesPerFile}; raise maxMatchesPerFile or narrow filters/query`,
        });
        continue;
      }
      if (structuralEdits.length === 0) {
        if (request.targeting === "rename") {
          skipped.push({ path: rel, reason: "no-identifier-match" });
        }
        continue;
      }
      const sourceEdits = toSourceEdits(structuralEdits, "preview");
      astMatches = buildPreviewAstMatches(structuralEdits);
      result = {
        newContent: applySourceEdits(content, sourceEdits),
        replacementCount: structuralEdits.length,
        mode: "replacePattern",
      };
    } else {
      const fileWriteRequest = buildFileWriteRequestForMode(
        request.repoId,
        rel,
        request.editMode,
        request.query,
      );
      validateExactlyOneMode(fileWriteRequest);

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
    }

    if (result.newContent === content) {
      skipped.push({ path: rel, reason: "no-change" });
      continue;
    }
    const plannedMatchCount = (result.replacementCount ?? matchCount) || 1;
    if (totalMatches + plannedMatchCount > maxTotalMatches) {
      skipped.push({
        path: rel,
        reason: matchesExceedTotalCapReason(maxTotalMatches),
      });
      continue;
    }

    // Enforce aggregate byte cap BEFORE committing precondition + edit
    // so a capped file does not leave an orphaned precondition behind.
    const editBytes = Buffer.byteLength(result.newContent, "utf-8");
    aggregateBytes += editBytes;
    if (aggregateBytes > maxPlanBytes) {
      aggregateBytes -= editBytes;
      skipped.push({
        path: rel,
        reason: aggregateByteCapExceededReason(maxPlanBytes),
      });
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
      matchCount: plannedMatchCount,
      editMode: result.mode,
    });
    fileEntries.push({
      file: rel,
      matchCount: plannedMatchCount,
      editMode: result.mode,
      snippets: buildSearchEditPreviewSnippets(
        content,
        result.newContent,
        contextLines,
        regex,
      ),
      indexedSource,
      ...(astMatches ? { astMatches } : {}),
    });
    totalMatches += plannedMatchCount;
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
      ...(candidatesCapped || skipped.some((s) => isPartialSkipReason(s.reason))
        ? { partial: true }
        : {}),
    },
  };
}
