/**
 * `sdl.symbol.edit` entry point.
 *
 * This is an intent layer over the existing search-edit plan/apply store:
 * preview computes exact file content, stores symbol/file/draft
 * preconditions, and apply reuses the safe file write executor unless the
 * plan targets a live draft overlay.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { extname, resolve } from "node:path";

import { getLadybugConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import type { FileRow, SymbolRow } from "../../../db/ladybug-queries.js";
import { NotFoundError, ValidationError } from "../../../domain/errors.js";
import type { Range } from "../../../domain/types.js";
import { getAdapterForExtension } from "../../../indexer/adapter/registry.js";
import {
  getDefaultLiveIndexCoordinator,
  getDefaultOverlayStore,
  waitForDefaultLiveIndexIdle,
} from "../../../live-index/coordinator.js";
import {
  getOverlaySnapshot,
  getOverlaySymbol,
} from "../../../live-index/overlay-reader.js";
import type { DraftOverlayEntry } from "../../../live-index/overlay-store.js";
import { normalizePath, validatePathWithinRoot } from "../../../util/paths.js";
import { resolveSymbolId } from "../../../util/resolve-symbol-id.js";
import { resolveSymbolRef } from "../../../util/resolve-symbol-ref.js";
import type { ToolContext } from "../../../server.js";
import {
  FILE_WRITE_DENY_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  isIndexedSource,
} from "../file-write-internals.js";
import { applyBatch } from "../search-edit/batch-executor.js";
import { buildSearchEditPreviewSnippets } from "../search-edit/planner.js";
import {
  getSearchEditPlanStore,
  type PlannedFileEdit,
  type PlanPrecondition,
  type StoredPlan,
  type SymbolEditStoredMetadata,
} from "../search-edit/plan-store.js";
import {
  SymbolEditRequestSchema,
  type SymbolEditApplyResponse,
  type SymbolEditOperation,
  type SymbolEditPreviewResponse,
  type SymbolEditRequest,
  type SymbolEditResponse,
  type SymbolEditValidationSummary,
} from "../../tools.js";
import {
  planTypeScriptSymbolEdit,
  type SymbolEditAstPlan,
  type SymbolEditSymbolSnapshot,
} from "./ast.js";

interface ResolvedSymbolTarget {
  symbol: SymbolRow;
  file: FileRow;
  rootPath: string;
  absPath: string;
  relPath: string;
  content: string;
  contentSha256: string;
  savedFileSha256: string;
  mtimeMs: number | null;
  writeTarget: "file" | "draft";
  draft?: DraftOverlayEntry;
}

interface PreviewBuild {
  plan: StoredPlan;
  response: SymbolEditPreviewResponse;
}

const RANGE_ONLY_OPERATIONS = new Set<SymbolEditOperation["kind"]>([
  "replaceSymbol",
  "insertBefore",
  "insertAfter",
]);

function sha256(textOrBuffer: string | Buffer): string {
  return createHash("sha256").update(textOrBuffer).digest("hex");
}

function toSnapshot(symbol: SymbolRow): SymbolEditSymbolSnapshot {
  return {
    symbolId: symbol.symbolId,
    name: symbol.name,
    kind: symbol.kind,
    language: symbol.language,
    range: {
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
      endLine: symbol.rangeEndLine,
      endCol: symbol.rangeEndCol,
    },
    astFingerprint: symbol.astFingerprint,
  };
}

function rangesEqual(a: Range, b: Range): boolean {
  return (
    a.startLine === b.startLine &&
    a.startCol === b.startCol &&
    a.endLine === b.endLine &&
    a.endCol === b.endCol
  );
}

function assertExpectedSnapshot(
  symbol: SymbolEditSymbolSnapshot,
  expectedAstFingerprint: string,
  expectedRange: Range,
): void {
  if (symbol.astFingerprint !== expectedAstFingerprint) {
    throw new ValidationError(
      "symbol.edit applyNow expectedAstFingerprint is stale; re-run preview with the current symbol card.",
    );
  }
  if (!rangesEqual(symbol.range, expectedRange)) {
    throw new ValidationError(
      "symbol.edit applyNow expectedRange is stale; re-run preview with the current symbol card.",
    );
  }
}

function isTypeScriptFamily(language: string): boolean {
  const normalized = language.toLowerCase();
  return (
    normalized === "typescript" ||
    normalized === "tsx" ||
    normalized === "javascript" ||
    normalized === "jsx"
  );
}

function parseAndResolveRangeOnlySymbol(input: {
  content: string;
  filePath: string;
  symbol: SymbolEditSymbolSnapshot;
  expectedOffsets: { start: number; end: number };
  expectTargetSymbol: boolean;
}): boolean {
  const adapter = getAdapterForExtension(extname(input.filePath));
  if (!adapter) {
    throw new ValidationError(
      `symbol.edit cannot parse ${input.filePath}; range-only edits require a registered language adapter.`,
    );
  }
  const tree = adapter.parse(input.content, input.filePath);
  if (!tree || tree.rootNode.hasError) {
    throw new ValidationError(`Parse validation failed for ${input.filePath}`);
  }
  const symbols = adapter.extractSymbols(tree, input.content, input.filePath);
  const resolved = symbols.some(
    (candidate) =>
      candidate.name === input.symbol.name &&
      candidate.kind === input.symbol.kind &&
      offsetRangesOverlap(
        offsetsForRange(input.content, candidate.range),
        input.expectedOffsets,
      ),
  );
  if (!resolved && input.expectTargetSymbol) {
    throw new ValidationError(
      "Target symbol did not resolve after symbol edit; use replaceSymbol for intentional symbol identity changes.",
    );
  }
  return resolved;
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetAt(content: string, point: { line: number; col: number }): number {
  const starts = lineStarts(content);
  const lineIndex = point.line - 1;
  if (lineIndex < 0 || lineIndex >= starts.length) {
    throw new ValidationError(`Range line ${point.line} is outside file content`);
  }
  return Math.min(starts[lineIndex] + point.col, content.length);
}

function offsetsForRange(content: string, range: Range): { start: number; end: number } {
  return {
    start: offsetAt(content, { line: range.startLine, col: range.startCol }),
    end: offsetAt(content, { line: range.endLine, col: range.endCol }),
  };
}

function offsetRangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

function skipFollowingNewline(content: string, offset: number): number {
  if (content[offset] === "\r" && content[offset + 1] === "\n") return offset + 2;
  if (content[offset] === "\n") return offset + 1;
  return offset;
}

function normalizeAdjacentInsert(content: string, insertOffset: number, raw: string): string {
  if (raw.length === 0) return raw;
  const previous = insertOffset > 0 ? content[insertOffset - 1] : "";
  const next = insertOffset < content.length ? content[insertOffset] : "";
  let text = raw;
  if (previous && previous !== "\n" && previous !== "\r" && !text.startsWith("\n")) {
    text = "\n" + text;
  }
  if (next && next !== "\n" && next !== "\r" && !text.endsWith("\n")) {
    text += "\n";
  }
  return text;
}

function planRangeOnlySymbolEdit(input: {
  content: string;
  filePath: string;
  symbol: SymbolEditSymbolSnapshot;
  operation: SymbolEditOperation;
}): SymbolEditAstPlan {
  if (!RANGE_ONLY_OPERATIONS.has(input.operation.kind)) {
    throw new ValidationError(
      `symbol.edit ${input.operation.kind} is only supported for TypeScript/JavaScript-family symbols in v1.`,
    );
  }
  const range = offsetsForRange(input.content, input.symbol.range);
  parseAndResolveRangeOnlySymbol({
    content: input.content,
    filePath: input.filePath,
    symbol: input.symbol,
    expectedOffsets: range,
    expectTargetSymbol: true,
  });
  let newContent: string;
  let changedRange = input.symbol.range;
  let expectedTargetOffsets = range;
  switch (input.operation.kind) {
    case "replaceSymbol":
      newContent =
        input.content.slice(0, range.start) +
        input.operation.content +
        input.content.slice(range.end);
      expectedTargetOffsets = {
        start: range.start,
        end: range.start + input.operation.content.length,
      };
      break;
    case "insertBefore": {
      const insert = normalizeAdjacentInsert(
        input.content,
        range.start,
        input.operation.content,
      );
      newContent =
        input.content.slice(0, range.start) +
        insert +
        input.content.slice(range.start);
      expectedTargetOffsets = {
        start: range.start + insert.length,
        end: range.end + insert.length,
      };
      changedRange = {
        startLine: input.symbol.range.startLine,
        startCol: input.symbol.range.startCol,
        endLine: input.symbol.range.startLine,
        endCol: input.symbol.range.startCol + insert.length,
      };
      break;
    }
    case "insertAfter": {
      const insertOffset = skipFollowingNewline(input.content, range.end);
      const insert = normalizeAdjacentInsert(input.content, insertOffset, input.operation.content);
      newContent =
        input.content.slice(0, insertOffset) +
        insert +
        input.content.slice(insertOffset);
      expectedTargetOffsets = range;
      changedRange = {
        startLine: input.symbol.range.endLine,
        startCol: input.symbol.range.endCol,
        endLine: input.symbol.range.endLine,
        endCol: input.symbol.range.endCol + insert.length,
      };
      break;
    }
    default:
      throw new ValidationError(`Unsupported symbol.edit operation ${input.operation.kind}`);
  }
  const targetSymbolResolved = parseAndResolveRangeOnlySymbol({
    content: newContent,
    filePath: input.filePath,
    symbol: input.symbol,
    expectedOffsets: expectedTargetOffsets,
    expectTargetSymbol: input.operation.kind !== "replaceSymbol",
  });
  return {
    newContent,
    editMode: input.operation.kind,
    changedRange,
    validation: {
      parseBefore: true,
      parseAfter: true,
      targetSymbolResolved,
      ...(targetSymbolResolved
        ? {}
        : { warnings: ["replaceSymbol changed or removed the original symbol identity"] }),
    },
  };
}

function ensureEditablePath(relPath: string): void {
  const dot = relPath.lastIndexOf(".");
  const ext = dot === -1 ? "" : relPath.slice(dot).toLowerCase();
  if (FILE_WRITE_DENY_EXTENSIONS.has(ext)) {
    throw new ValidationError(`Refusing symbol.edit for denied file extension: ${ext}`);
  }
}

async function resolveTargetSymbol(
  request: Extract<SymbolEditRequest, { mode: "preview" }> | Extract<SymbolEditRequest, { mode: "applyNow" }>,
): Promise<{ symbol: SymbolRow; file: FileRow; rootPath: string }> {
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, request.repoId);
  if (!repo) {
    throw new NotFoundError(`Repository not found: ${request.repoId}`);
  }

  let symbolId: string;
  if ("symbolId" in request && request.symbolId) {
    symbolId = (await resolveSymbolId(conn, request.repoId, request.symbolId)).symbolId;
  } else if ("symbolRef" in request && request.symbolRef) {
    const resolved = await resolveSymbolRef(conn, request.repoId, request.symbolRef);
    if (resolved.status !== "resolved") {
      throw new ValidationError(resolved.message);
    }
    symbolId = resolved.symbolId;
  } else {
    throw new ValidationError("symbol.edit requires symbolId or symbolRef");
  }

  const overlaySymbol = getOverlaySymbol(getOverlaySnapshot(request.repoId), symbolId);
  if (overlaySymbol) {
    return {
      symbol: overlaySymbol.symbol,
      file: overlaySymbol.file,
      rootPath: repo.rootPath,
    };
  }

  const symbols = await ladybugDb.getSymbolsByIds(conn, [symbolId]);
  const symbol = symbols.get(symbolId);
  if (!symbol || symbol.repoId !== request.repoId) {
    throw new NotFoundError(`Symbol not found: ${symbolId}`);
  }
  const files = await ladybugDb.getFilesByIds(conn, [symbol.fileId]);
  const file = files.get(symbol.fileId);
  if (!file) {
    throw new NotFoundError(
      `File record missing for symbol ${symbol.name} (${symbolId}). Try re-indexing.`,
    );
  }
  return { symbol, file, rootPath: repo.rootPath };
}

function resolveDraftSymbol(
  durableOrOverlaySymbol: SymbolRow,
  draft: DraftOverlayEntry,
): { symbol: SymbolRow; file: FileRow } {
  const parseResult = draft.parseResult;
  if (!parseResult) {
    throw new ValidationError(
      `Live draft ${draft.filePath} has not parsed yet; wait for live-index idle and retry symbol.edit.`,
    );
  }
  const exact = parseResult.symbols.find(
    (candidate) => candidate.symbolId === durableOrOverlaySymbol.symbolId,
  );
  if (exact) {
    return { symbol: exact, file: parseResult.file };
  }
  const byNameAndKind = parseResult.symbols.filter(
    (candidate) =>
      candidate.name === durableOrOverlaySymbol.name &&
      candidate.kind === durableOrOverlaySymbol.kind,
  );
  if (byNameAndKind.length === 1 && byNameAndKind[0]) {
    return { symbol: byNameAndKind[0], file: parseResult.file };
  }
  throw new ValidationError(
    `Live draft ${draft.filePath} no longer contains an unambiguous ${durableOrOverlaySymbol.kind} named ${durableOrOverlaySymbol.name}; re-run symbol search.`,
  );
}

async function loadResolvedTarget(
  request: Extract<SymbolEditRequest, { mode: "preview" }> | Extract<SymbolEditRequest, { mode: "applyNow" }>,
): Promise<ResolvedSymbolTarget> {
  const resolved = await resolveTargetSymbol(request);
  const relPath = normalizePath(resolved.file.relPath);
  ensureEditablePath(relPath);
  const absPath = resolve(resolved.rootPath, relPath);
  validatePathWithinRoot(resolved.rootPath, absPath);

  let realPath: string;
  try {
    realPath = realpathSync(absPath);
  } catch (error) {
    throw new NotFoundError(
      `File not found for symbol ${resolved.symbol.name}: ${relPath} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  validatePathWithinRoot(resolved.rootPath, realPath);

  const stats = await stat(absPath);
  if (!stats.isFile()) {
    throw new ValidationError(`Symbol edit target is not a file: ${relPath}`);
  }
  if (stats.size > MAX_FILE_SIZE_BYTES) {
    throw new ValidationError(
      `File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE_BYTES})`,
    );
  }
  const buffer = await readFile(absPath);
  if (buffer.includes(0)) {
    throw new ValidationError(`Refusing symbol.edit for binary content: ${relPath}`);
  }
  const savedContent = buffer.toString("utf-8");
  const savedSha = sha256(buffer);

  const draft = getDefaultOverlayStore().getDraft(request.repoId, relPath);
  if (draft) {
    const draftResolved = resolveDraftSymbol(resolved.symbol, draft);
    return {
      symbol: draftResolved.symbol,
      file: draftResolved.file,
      rootPath: resolved.rootPath,
      absPath,
      relPath,
      content: draft.content,
      contentSha256: sha256(draft.content),
      savedFileSha256: savedSha,
      mtimeMs: stats.mtimeMs,
      writeTarget: "draft",
      draft,
    };
  }

  return {
    symbol: resolved.symbol,
    file: resolved.file,
    rootPath: resolved.rootPath,
    absPath,
    relPath,
    content: savedContent,
    contentSha256: savedSha,
    savedFileSha256: savedSha,
    mtimeMs: stats.mtimeMs,
    writeTarget: "file",
  };
}

function planOperation(target: ResolvedSymbolTarget, operation: SymbolEditOperation): {
  newContent: string;
  changedRange: Range;
  validation: SymbolEditValidationSummary;
} {
  const snapshot = toSnapshot(target.symbol);
  if (isTypeScriptFamily(target.symbol.language)) {
    const planned = planTypeScriptSymbolEdit({
      content: target.content,
      filePath: target.relPath,
      symbol: snapshot,
      operation,
    });
    return {
      newContent: planned.newContent,
      changedRange: planned.changedRange,
      validation: planned.validation,
    };
  }
  return planRangeOnlySymbolEdit({
    content: target.content,
    filePath: target.relPath,
    symbol: snapshot,
    operation,
  });
}

async function buildPreview(
  request: Extract<SymbolEditRequest, { mode: "preview" }> | Extract<SymbolEditRequest, { mode: "applyNow" }>,
): Promise<PreviewBuild> {
  const target = await loadResolvedTarget(request);
  const snapshot = toSnapshot(target.symbol);
  if (request.mode === "applyNow") {
    assertExpectedSnapshot(
      snapshot,
      request.expectedAstFingerprint,
      request.expectedRange,
    );
  }

  const planned = planOperation(target, request.operation);
  if (planned.newContent === target.content) {
    throw new ValidationError("symbol.edit produced no content change");
  }

  const createBackup = request.createBackup ?? true;
  const precondition: PlanPrecondition = {
    relPath: target.relPath,
    absPath: target.absPath,
    sha256: target.savedFileSha256,
    mtimeMs: target.mtimeMs,
  };
  const edit: PlannedFileEdit = {
    relPath: target.relPath,
    absPath: target.absPath,
    newContent: planned.newContent,
    createBackup,
    fileExists: true,
    indexedSource: isIndexedSource(target.relPath),
    matchCount: 1,
    editMode: "replaceLines",
  };
  const preconditions = {
    symbol: {
      symbolId: snapshot.symbolId,
      astFingerprint: snapshot.astFingerprint,
      range: snapshot.range,
    },
    file: {
      path: target.relPath,
      sha256: precondition.sha256,
      mtimeMs: precondition.mtimeMs,
    },
    ...(target.draft
      ? {
          draft: {
            version: target.draft.version,
            sha256: target.contentSha256,
          },
        }
      : {}),
  };
  const fileEntries = [{
    file: target.relPath,
    matchCount: 1,
    editMode: edit.editMode,
    snippets: buildSearchEditPreviewSnippets(target.content, planned.newContent, 2, null),
    indexedSource: edit.indexedSource,
  }];
  const metadata: SymbolEditStoredMetadata = {
    tool: "symbol.edit",
    symbolId: snapshot.symbolId,
    symbolName: snapshot.name,
    symbolKind: snapshot.kind,
    language: snapshot.language,
    operation: request.operation.kind,
    file: target.relPath,
    writeTarget: target.writeTarget,
    preconditions,
    validation: planned.validation,
  };
  const store = getSearchEditPlanStore();
  const plan = store.create(
    request.repoId,
    [edit],
    [precondition],
    {
      fileEntries,
      symbolEdit: {
        symbolId: snapshot.symbolId,
        symbolName: snapshot.name,
        operation: request.operation.kind,
        file: target.relPath,
        writeTarget: target.writeTarget,
      },
    },
    createBackup,
    metadata,
  );
  const response: SymbolEditPreviewResponse = {
    mode: "preview",
    planHandle: plan.planHandle,
    symbolId: snapshot.symbolId,
    symbolName: snapshot.name,
    operation: request.operation.kind,
    file: target.relPath,
    writeTarget: target.writeTarget,
    requiresApply: true,
    expiresAt: new Date(plan.expiresAt).toISOString(),
    preconditions,
    validation: planned.validation,
    fileEntries,
  };
  return { plan, response };
}

function getSymbolMetadata(plan: StoredPlan): SymbolEditStoredMetadata {
  if (!plan.symbolEdit) {
    throw new ValidationError(
      `symbol.edit planHandle expected a symbol edit plan, but ${plan.planHandle} came from another edit tool.`,
    );
  }
  return plan.symbolEdit;
}

async function validatePlanSnapshot(
  repoId: string,
  metadata: SymbolEditStoredMetadata,
): Promise<void> {
  const fakeRequest = {
    mode: "preview" as const,
    repoId,
    symbolId: metadata.symbolId,
    operation: { kind: "replaceSymbol" as const, content: "" },
  };
  const target = await loadResolvedTarget(fakeRequest);
  const current = toSnapshot(target.symbol);
  if (target.writeTarget !== metadata.writeTarget) {
    throw new ValidationError(
      `symbol.edit apply aborted: write target changed from ${metadata.writeTarget} to ${target.writeTarget}; re-run preview.`,
    );
  }
  if (target.relPath !== metadata.preconditions.file.path) {
    throw new ValidationError(
      "symbol.edit apply aborted: target file changed; re-run preview.",
    );
  }
  if (target.savedFileSha256 !== metadata.preconditions.file.sha256) {
    throw new ValidationError(
      "symbol.edit apply aborted: saved file sha drifted; re-run preview.",
    );
  }
  const expectedMtime = metadata.preconditions.file.mtimeMs;
  if (
    target.mtimeMs !== null &&
    expectedMtime !== null &&
    Math.abs(target.mtimeMs - expectedMtime) > 1
  ) {
    throw new ValidationError(
      "symbol.edit apply aborted: saved file mtime drifted; re-run preview.",
    );
  }
  if (current.symbolId !== metadata.preconditions.symbol.symbolId) {
    throw new ValidationError(
      "symbol.edit apply aborted: target symbol changed; re-run preview.",
    );
  }
  if (current.astFingerprint !== metadata.preconditions.symbol.astFingerprint) {
    throw new ValidationError(
      "symbol.edit apply aborted: astFingerprint drifted; re-run preview.",
    );
  }
  if (!rangesEqual(current.range, metadata.preconditions.symbol.range)) {
    throw new ValidationError(
      "symbol.edit apply aborted: symbol range drifted; re-run preview.",
    );
  }
  if (metadata.writeTarget === "draft") {
    const draft = getDefaultOverlayStore().getDraft(repoId, metadata.file);
    if (!draft) {
      throw new ValidationError(
        "symbol.edit apply aborted: live draft is missing; re-run preview.",
      );
    }
    const expected = metadata.preconditions.draft;
    if (!expected) {
      throw new ValidationError(
        "symbol.edit apply aborted: draft precondition is missing; re-run preview.",
      );
    }
    if (draft.version !== expected.version || sha256(draft.content) !== expected.sha256) {
      throw new ValidationError(
        "symbol.edit apply aborted: live draft changed; re-run preview.",
      );
    }
  }
}

async function applyDraftPlan(
  plan: StoredPlan,
  metadata: SymbolEditStoredMetadata,
): Promise<SymbolEditApplyResponse> {
  const edit = plan.edits[0];
  if (!edit) {
    throw new ValidationError("symbol.edit draft plan has no edit payload");
  }
  const expected = metadata.preconditions.draft;
  if (!expected) {
    throw new ValidationError("symbol.edit draft plan is missing draft preconditions");
  }
  const draft = getDefaultOverlayStore().getDraft(plan.repoId, metadata.file);
  if (!draft) {
    throw new ValidationError("symbol.edit draft is missing; re-run preview.");
  }
  const updateResult = await getDefaultLiveIndexCoordinator().pushBufferUpdate({
    repoId: plan.repoId,
    eventType: "change",
    filePath: metadata.file,
    content: edit.newContent,
    language: metadata.language,
    version: expected.version + 1,
    dirty: true,
    timestamp: new Date().toISOString(),
  });
  await waitForDefaultLiveIndexIdle();
  return {
    mode: "apply",
    planHandle: plan.planHandle,
    symbolId: metadata.symbolId,
    symbolName: metadata.symbolName,
    operation: metadata.operation as SymbolEditOperation["kind"],
    file: metadata.file,
    writeTarget: "draft",
    validation: metadata.validation,
    filesAttempted: 1,
    filesWritten: updateResult.accepted ? 1 : 0,
    filesSkipped: updateResult.accepted ? 0 : 1,
    filesFailed: 0,
    results: [{
      file: metadata.file,
      status: updateResult.accepted ? "written" : "skipped",
      bytes: updateResult.accepted
        ? Buffer.byteLength(edit.newContent, "utf-8")
        : undefined,
      reason: updateResult.accepted
        ? undefined
        : updateResult.warnings.join("; ") || "draft-update-rejected",
    }],
    rollback: {
      triggered: false,
      restoredFiles: [],
    },
    draftUpdate: {
      accepted: updateResult.accepted,
      overlayVersion: updateResult.overlayVersion,
      parseScheduled: updateResult.parseScheduled,
      warnings: updateResult.warnings,
    },
  };
}

async function handleApply(
  request: Extract<SymbolEditRequest, { mode: "apply" }>,
): Promise<SymbolEditApplyResponse> {
  const store = getSearchEditPlanStore();
  const plan = store.get(request.planHandle);
  if (!plan) {
    throw new ValidationError(
      `symbol.edit planHandle missing or expired: ${request.planHandle}`,
    );
  }
  if (plan.repoId !== request.repoId) {
    throw new ValidationError(
      `symbol.edit planHandle was created for repoId "${plan.repoId}", not "${request.repoId}"`,
    );
  }
  if (
    request.createBackup !== undefined &&
    request.createBackup !== plan.defaultCreateBackup
  ) {
    throw new ValidationError(
      `symbol.edit apply createBackup=${request.createBackup} does not match preview assumption createBackup=${plan.defaultCreateBackup}. Re-run preview with the desired value.`,
    );
  }

  const metadata = getSymbolMetadata(plan);
  await validatePlanSnapshot(request.repoId, metadata);

  if (!store.markConsumed(plan.planHandle)) {
    throw new ValidationError(
      `symbol.edit planHandle is already being applied: ${plan.planHandle}`,
    );
  }

  try {
    const response =
      metadata.writeTarget === "draft"
        ? await applyDraftPlan(plan, metadata)
        : await applyFilePlan(plan, metadata, request.createBackup);
    store.remove(plan.planHandle);
    return response;
  } catch (error) {
    store.remove(plan.planHandle);
    throw error;
  }
}

async function applyFilePlan(
  plan: StoredPlan,
  metadata: SymbolEditStoredMetadata,
  createBackup: boolean | undefined,
): Promise<SymbolEditApplyResponse> {
  const batch = await applyBatch(plan, createBackup);
  return {
    mode: "apply",
    planHandle: plan.planHandle,
    symbolId: metadata.symbolId,
    symbolName: metadata.symbolName,
    operation: metadata.operation as SymbolEditOperation["kind"],
    file: metadata.file,
    writeTarget: "file",
    validation: metadata.validation,
    filesAttempted: batch.filesAttempted,
    filesWritten: batch.filesWritten,
    filesSkipped: batch.filesSkipped,
    filesFailed: batch.filesFailed,
    results: batch.results,
    rollback: batch.rollback,
  };
}

export async function handleSymbolEdit(
  args: unknown,
  _context?: ToolContext,
): Promise<SymbolEditResponse> {
  const request = SymbolEditRequestSchema.parse(args);
  if (request.mode === "preview") {
    const { response } = await buildPreview(request);
    return response;
  }
  if (request.mode === "apply") {
    return handleApply(request);
  }
  const { response } = await buildPreview(request);
  return handleApply({
    mode: "apply",
    repoId: request.repoId,
    planHandle: response.planHandle,
    createBackup: request.createBackup,
  });
}
