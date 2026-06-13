import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";

import type { Connection } from "kuzu";

import {
  getSemanticLspCallEdgeCandidates,
  type SemanticLspCallEdgeCandidateRow,
} from "../../../db/ladybug-queries.js";
import { parseUnresolvedCallTarget } from "../../../db/symbol-placeholders.js";
import type { LanguageAdapter } from "../../../indexer/adapter/LanguageAdapter.js";
import { getAdapterForExtension } from "../../../indexer/adapter/registry.js";
import type {
  ExtractedCall,
  ExtractedSymbol,
} from "../../../indexer/treesitter/extractCalls.js";
import {
  getAbsolutePathFromRepoRoot,
  normalizePath,
} from "../../../util/paths.js";

export type LspCandidateSkipReason =
  | "unsupported-language"
  | "resolved-edge"
  | "target-name-missing"
  | "adapter-unavailable"
  | "parse-failed"
  | "source-symbol-not-found"
  | "call-not-found"
  | "candidate-limit"
  | "definition-unavailable"
  | "definition-failed"
  | "definition-not-found"
  | "definition-outside-repo";

export interface LspCandidateSkip {
  reason: LspCandidateSkipReason;
  languageId: string;
  sourcePath?: string;
  sourceSymbolId?: string;
  targetSymbolId?: string;
  targetName?: string;
}

export interface LspCandidateDocument {
  uri: string;
  sourcePath: string;
  languageId: string;
  text: string;
  version: number;
  sourceHash?: string;
}

export interface LspCallDefinitionCandidate {
  repoId: string;
  languageId: string;
  sourceSymbolId: string;
  sourceProviderSymbolId: string;
  sourcePath: string;
  sourceUri: string;
  sourceName: string;
  targetSymbolId: string;
  targetName: string;
  existingEdgeConfidence: number;
  position: { line: number; character: number };
  callRange: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
}

export interface LspCandidatePlan {
  repoId: string;
  languageId: string;
  documents: LspCandidateDocument[];
  candidates: LspCallDefinitionCandidate[];
  skipped: LspCandidateSkip[];
}

export interface PlanLspCallDefinitionCandidatesOptions {
  conn: Connection;
  repoId: string;
  repoRoot: string;
  languageId: string;
  candidateLimit: number;
}

export interface PlanLspCallDefinitionCandidatesFromRowsOptions {
  repoId: string;
  repoRoot: string;
  languageId: string;
  candidateLimit: number;
  rows: readonly SemanticLspCallEdgeCandidateRow[];
  readFileText?: (absolutePath: string) => Promise<string>;
  resolveAdapter?: (sourcePath: string) => LanguageAdapter | null;
}

interface ParsedFile {
  document: LspCandidateDocument;
  symbols: ExtractedSymbol[];
  calls: ExtractedCall[];
}

export async function planLspCallDefinitionCandidates(
  options: PlanLspCallDefinitionCandidatesOptions,
): Promise<LspCandidatePlan> {
  const candidateLimit = Math.max(0, options.candidateLimit);
  const rows = await getSemanticLspCallEdgeCandidates(
    options.conn,
    options.repoId,
    options.languageId,
    candidateLimit,
  );
  return planLspCallDefinitionCandidatesFromRows({
    ...options,
    candidateLimit,
    rows,
  });
}

export async function planLspCallDefinitionCandidatesFromRows(
  options: PlanLspCallDefinitionCandidatesFromRowsOptions,
): Promise<LspCandidatePlan> {
  const skipped: LspCandidateSkip[] = [];
  const readFileText = options.readFileText ?? readFileUtf8;
  const resolveAdapter = options.resolveAdapter ?? defaultResolveAdapter;
  const parsedByPath = new Map<string, ParsedFile | null>();
  const documents = new Map<string, LspCandidateDocument>();
  const candidates: LspCallDefinitionCandidate[] = [];
  const limit = Math.max(0, options.candidateLimit);

  for (const row of options.rows) {
    if (
      row.edgeResolution !== "heuristic" &&
      row.edgeResolution !== "unresolved"
    ) {
      skipped.push(skipForRow(row, "resolved-edge", options.languageId));
      continue;
    }

    const targetName = targetNameForRow(row);
    if (!targetName) {
      skipped.push(skipForRow(row, "target-name-missing", options.languageId));
      continue;
    }

    if (!parsedByPath.has(row.sourcePath)) {
      parsedByPath.set(
        row.sourcePath,
        await parseCandidateFile({
          row,
          repoRoot: options.repoRoot,
          languageId: options.languageId,
          readFileText,
          resolveAdapter,
          skipped,
        }),
      );
    }
    const parsed = parsedByPath.get(row.sourcePath) ?? null;
    if (!parsed) continue;
    documents.set(parsed.document.uri, parsed.document);

    const sourceSymbol = parsed.symbols.find((symbol) =>
      symbolMatchesRow(symbol, row),
    );
    if (!sourceSymbol) {
      skipped.push(
        skipForRow(
          row,
          "source-symbol-not-found",
          options.languageId,
          targetName,
        ),
      );
      continue;
    }

    const matchingCall = parsed.calls.find((call) => {
      if (call.callerNodeId !== sourceSymbol.nodeId) return false;
      return extractCallTargetName(call.calleeIdentifier) === targetName;
    });
    if (!matchingCall) {
      skipped.push(
        skipForRow(row, "call-not-found", options.languageId, targetName),
      );
      continue;
    }

    if (candidates.length >= limit) {
      skipped.push(
        skipForRow(row, "candidate-limit", options.languageId, targetName),
      );
      continue;
    }

    candidates.push({
      repoId: options.repoId,
      languageId: options.languageId,
      sourceSymbolId: row.sourceSymbolId,
      sourceProviderSymbolId: `lsp-source:${row.sourceSymbolId}`,
      sourcePath: row.sourcePath,
      sourceUri: parsed.document.uri,
      sourceName: row.sourceName,
      targetSymbolId: row.targetSymbolId,
      targetName,
      existingEdgeConfidence: row.edgeConfidence,
      position: callPosition(matchingCall, parsed.document.text, targetName),
      callRange: matchingCall.range,
    });
  }

  return {
    repoId: options.repoId,
    languageId: options.languageId,
    documents: [...documents.values()],
    candidates,
    skipped,
  };
}

async function parseCandidateFile(params: {
  row: SemanticLspCallEdgeCandidateRow;
  repoRoot: string;
  languageId: string;
  readFileText: (absolutePath: string) => Promise<string>;
  resolveAdapter: (sourcePath: string) => LanguageAdapter | null;
  skipped: LspCandidateSkip[];
}): Promise<ParsedFile | null> {
  const adapter = params.resolveAdapter(params.row.sourcePath);
  if (!adapter) {
    params.skipped.push(
      skipForRow(params.row, "adapter-unavailable", params.languageId),
    );
    return null;
  }

  const absolutePath = getAbsolutePathFromRepoRoot(
    params.repoRoot,
    params.row.sourcePath,
  );
  let text: string;
  try {
    text = await params.readFileText(absolutePath);
  } catch {
    params.skipped.push(
      skipForRow(params.row, "parse-failed", params.languageId),
    );
    return null;
  }
  const extracted = adapter.extractAll
    ? await adapter.extractAll(text, absolutePath)
    : await extractWithAdapter(adapter, text, absolutePath);
  if (!extracted.tree) {
    params.skipped.push(
      skipForRow(params.row, "parse-failed", params.languageId),
    );
    return null;
  }

  const sourcePath = normalizePath(params.row.sourcePath);
  const document: LspCandidateDocument = {
    uri: pathToFileURL(absolutePath).toString(),
    sourcePath,
    languageId: lspDocumentLanguageIdForPath(sourcePath, params.languageId),
    text,
    version: 1,
    sourceHash: params.row.fileContentHash,
  };
  return {
    document,
    symbols: extracted.symbols,
    calls: extracted.calls,
  };
}

async function extractWithAdapter(
  adapter: LanguageAdapter,
  text: string,
  absolutePath: string,
): Promise<{
  tree: ReturnType<LanguageAdapter["parse"]>;
  symbols: ExtractedSymbol[];
  calls: ExtractedCall[];
}> {
  const tree = adapter.parse(text, absolutePath);
  if (!tree) return { tree, symbols: [], calls: [] };
  const symbols = adapter.extractSymbols(tree, text, absolutePath);
  return {
    tree,
    symbols,
    calls: adapter.extractCalls(tree, text, absolutePath, symbols),
  };
}

function defaultResolveAdapter(sourcePath: string): LanguageAdapter | null {
  return getAdapterForExtension(extname(sourcePath));
}

async function readFileUtf8(absolutePath: string): Promise<string> {
  return readFile(absolutePath, "utf8");
}

function symbolMatchesRow(
  symbol: ExtractedSymbol,
  row: SemanticLspCallEdgeCandidateRow,
): boolean {
  return (
    symbol.name === row.sourceName &&
    symbol.kind === row.sourceKind &&
    symbol.range.startLine === row.sourceRangeStartLine &&
    symbol.range.startCol === row.sourceRangeStartCol &&
    symbol.range.endLine === row.sourceRangeEndLine &&
    symbol.range.endCol === row.sourceRangeEndCol
  );
}

export function extractCallTargetName(calleeIdentifier: string): string | null {
  const cleaned = calleeIdentifier.replace(/^new\s+/, "").trim();
  if (!cleaned) return null;
  const parts = cleaned.split(".");
  return parts[parts.length - 1]?.trim() || null;
}

function targetNameForRow(row: SemanticLspCallEdgeCandidateRow): string | null {
  if (row.targetSymbolId.startsWith("unresolved:call:")) {
    const name = parseUnresolvedCallTarget(row.targetSymbolId);
    return name || null;
  }
  return row.targetName?.trim() || null;
}

function callPosition(
  call: ExtractedCall,
  text: string,
  targetName: string,
): { line: number; character: number } {
  const zeroBasedLine = Math.max(0, call.range.startLine - 1);
  const line = text.split(/\r?\n/)[zeroBasedLine] ?? "";
  const targetIndex = line.indexOf(targetName, call.range.startCol);
  const withinCall =
    targetIndex >= call.range.startCol &&
    (call.range.startLine !== call.range.endLine ||
      targetIndex <= call.range.endCol);
  return {
    line: zeroBasedLine,
    character: withinCall ? targetIndex : call.range.startCol,
  };
}

function lspDocumentLanguageIdForPath(
  sourcePath: string,
  fallback: string,
): string {
  switch (extname(sourcePath).toLowerCase()) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "javascriptreact";
    case ".tsx":
      return "typescriptreact";
    case ".ts":
      return "typescript";
    default:
      return fallback;
  }
}

function skipForRow(
  row: SemanticLspCallEdgeCandidateRow,
  reason: LspCandidateSkipReason,
  languageId: string,
  targetName = targetNameForRow(row) ?? undefined,
): LspCandidateSkip {
  return {
    reason,
    languageId,
    sourcePath: row.sourcePath,
    sourceSymbolId: row.sourceSymbolId,
    targetSymbolId: row.targetSymbolId,
    targetName,
  };
}
