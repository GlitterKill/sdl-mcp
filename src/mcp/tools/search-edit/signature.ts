/**
 * Signature planner for `sdl.search.edit` `targeting: "signature"`.
 *
 * Applies parameter add/remove/rename operations to a TS/JS function
 * declaration and propagates positional argument changes to graph-scoped
 * callsite files.
 */

import { resolve } from "path";

import type { SyntaxNode } from "tree-sitter";

import { getLadybugConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import { normalizePath } from "../../../util/paths.js";
import { NotFoundError, ValidationError } from "../../../domain/errors.js";
import { resolveSymbolRef } from "../../../util/resolve-symbol-ref.js";

import { isIndexedSource } from "../file-write-internals.js";
import type { PlannedFileEdit, PlanPrecondition } from "./plan-store.js";
import { collectIdentifierSourceEdits, parseTreeForPath } from "./structural.js";
import { wordRegexForIdentifier } from "./rename.js";
import {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_TOTAL_MATCHES,
  DEFAULT_PREVIEW_CONTEXT_LINES,
  MAX_PLAN_BYTES,
  aggregateByteCapExceededReason,
  applySourceEdits,
  buildSearchEditPreviewSnippets,
  isPartialSkipReason,
  matchesExceedTotalCapReason,
  maxFilesReachedReason,
  maxTotalMatchesReachedReason,
  readSearchEditCandidateFile,
  toSourceEdits,
  type PreviewFileEntry,
  type PreviewFileSkip,
  type PreviewResult,
  type SearchEditSingleOperationRequest,
  type SourceEdit,
} from "./planner.js";
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

const IDENTIFIER_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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

function applySignatureOpsToParts(
  parts: string[],
  names: string[],
  signature: SignatureOps,
): { paramsText: string; originalNames: string[] } {
  const params = [...parts];
  const paramNames = [...names];
  const originalNames = [...names];
  for (const remove of signature.remove ?? []) {
    const index = paramNames.indexOf(remove.name);
    if (index === -1) throw new ValidationError("signature remove param not found: " + remove.name);
    params.splice(index, 1);
    paramNames.splice(index, 1);
  }
  for (const rename of signature.renameParam ?? []) {
    const index = paramNames.indexOf(rename.from);
    if (index === -1) throw new ValidationError("signature rename param not found: " + rename.from);
    params[index] = params[index].replace(new RegExp("^" + escapeRegExp(rename.from) + "\\b"), rename.to);
    paramNames[index] = rename.to;
  }
  for (const add of signature.add ?? []) {
    const insertAt = Math.min(Math.max(add.index ?? params.length, 0), params.length);
    params.splice(insertAt, 0, formatAddedParam(add));
    paramNames.splice(insertAt, 0, add.name);
  }
  return { paramsText: params.join(", "), originalNames };
}

interface DeclarationMatch {
  /** Function-shaped node owning `parameters`/`parameter` + `body` fields. */
  fnNode: SyntaxNode;
  overload: boolean;
}

/** Collect nodes that declare `name` as a function-shaped symbol. */
function findDeclarationNodes(root: SyntaxNode, name: string): DeclarationMatch[] {
  const matches: DeclarationMatch[] = [];
  const visit = (node: SyntaxNode): void => {
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration":
      case "function_signature": {
        if (node.childForFieldName("name")?.text === name) {
          matches.push({ fnNode: node, overload: node.type === "function_signature" });
        }
        break;
      }
      case "method_definition":
      case "method_signature": {
        if (node.childForFieldName("name")?.text === name) {
          matches.push({ fnNode: node, overload: node.type === "method_signature" });
        }
        break;
      }
      case "variable_declarator": {
        const nameNode = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        if (
          nameNode?.text === name &&
          value !== null &&
          (value.type === "arrow_function" ||
            value.type === "function_expression" ||
            value.type === "generator_function")
        ) {
          matches.push({ fnNode: value, overload: false });
        }
        break;
      }
      default:
        break;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return matches;
}

function paramNameFromNode(paramNode: SyntaxNode): string {
  const target = paramNode.childForFieldName("pattern") ?? paramNode;
  if (target.type === "identifier") return target.text;
  if (target.type === "rest_pattern") {
    const inner = target.namedChildren.find((child) => child.type === "identifier");
    return inner?.text ?? "";
  }
  // Destructuring patterns have no positional name (matches legacy behavior).
  return "";
}

interface ParamListInfo {
  parts: string[];
  names: string[];
  editStart: number;
  editEnd: number;
  /** True for bare-parameter arrows (`x => ...`) whose replacement needs parens. */
  wrapInParens: boolean;
}

function extractParams(fnNode: SyntaxNode): ParamListInfo {
  const paramsNode = fnNode.childForFieldName("parameters");
  if (paramsNode) {
    const paramNodes = paramsNode.namedChildren.filter(
      (child) => child.type !== "comment",
    );
    return {
      parts: paramNodes.map((child) => child.text),
      names: paramNodes.map(paramNameFromNode),
      editStart: paramsNode.startIndex + 1,
      editEnd: paramsNode.endIndex - 1,
      wrapInParens: false,
    };
  }
  const bare = fnNode.childForFieldName("parameter");
  if (bare) {
    return {
      parts: [bare.text],
      names: [bare.text],
      editStart: bare.startIndex,
      editEnd: bare.endIndex,
      wrapInParens: true,
    };
  }
  throw new ValidationError("signature target declaration not found");
}

function isTypeScriptOrJavaScriptPath(relPath: string): boolean {
  return /[.][cm]?[jt]sx?$/.test(relPath);
}

function buildSignatureDeclarationEdits(content: string, relPath: string, name: string, signature: SignatureOps): { edits: SourceEdit[]; originalNames: string[] } {
  const tree = parseTreeForPath(relPath, content);
  if (!tree) throw new ValidationError("signature target declaration not found");
  const matches = findDeclarationNodes(tree.rootNode, name);
  if (matches.length === 0) throw new ValidationError("signature target declaration not found");
  if (matches.length > 1 || matches.some((match) => match.overload)) {
    throw new ValidationError("overloads-not-supported");
  }
  const fnNode = matches[0].fnNode;
  const info = extractParams(fnNode);
  const transformed = applySignatureOpsToParts(info.parts, info.names, signature);
  const replacement = info.wrapInParens
    ? `(${transformed.paramsText})`
    : transformed.paramsText;
  const edits: SourceEdit[] = [
    {
      operationId: "signature",
      start: info.editStart,
      end: info.editEnd,
      replacement,
    },
  ];
  const body = fnNode.childForFieldName("body");
  if (body) {
    for (const rename of signature.renameParam ?? []) {
      const identifierEdits = collectIdentifierSourceEdits({
        content,
        relPath,
        literal: rename.from,
        replacement: rename.to,
        global: true,
      }).filter((edit) => edit.start >= body.startIndex && edit.end <= body.endIndex);
      edits.push(...toSourceEdits(identifierEdits, "signature"));
    }
  }
  return { edits, originalNames: transformed.originalNames };
}

function callsiteOpsRequested(signature: SignatureOps): boolean {
  return (signature.add?.length ?? 0) > 0 || (signature.remove?.length ?? 0) > 0;
}

/** True when `node` is a call/new whose callee resolves to `name`. */
function calleeMatchesName(callee: SyntaxNode, name: string): boolean {
  if (callee.type === "identifier") return callee.text === name;
  if (callee.type === "member_expression") {
    return callee.childForFieldName("property")?.text === name;
  }
  return false;
}

function buildSignatureCallsiteEdits(content: string, relPath: string, name: string, signature: SignatureOps, originalNames: string[]): { edits: SourceEdit[]; skipReason?: string } {
  if (!callsiteOpsRequested(signature)) return { edits: [] };
  if ((signature.add ?? []).some((add) => add.argText === undefined)) return { edits: [], skipReason: "needs-arg-value" };
  const tree = parseTreeForPath(relPath, content);
  if (!tree) return { edits: [], skipReason: "manual-review" };

  const edits: SourceEdit[] = [];
  let sawManualReview = false;
  let sawArityMismatch = false;
  let sawCall = false;

  const visit = (node: SyntaxNode): void => {
    if (sawManualReview || sawArityMismatch) return;
    if (node.type === "call_expression" || node.type === "new_expression") {
      const callee =
        node.childForFieldName("function") ??
        node.childForFieldName("constructor");
      if (callee?.type === "member_expression") {
        const property = callee.childForFieldName("property")?.text;
        const objectText = callee.childForFieldName("object")?.text;
        if (
          (property === "apply" || property === "call") &&
          objectText === name
        ) {
          // Indirect invocation shifts positional args — leave for review.
          sawManualReview = true;
          return;
        }
      }
      const args = node.childForFieldName("arguments");
      if (callee && args && calleeMatchesName(callee, name)) {
        const argNodes = args.namedChildren.filter(
          (child) => child.type !== "comment",
        );
        if (argNodes.some((child) => child.type === "spread_element")) {
          sawManualReview = true;
          return;
        }
        sawCall = true;
        const argTexts = argNodes.map((child) => child.text);
        for (const remove of signature.remove ?? []) {
          const index = originalNames.indexOf(remove.name);
          if (index >= 0) {
            if (argTexts.length <= index) {
              sawArityMismatch = true;
              return;
            }
            argTexts.splice(index, 1);
          }
        }
        for (const add of signature.add ?? []) {
          const insertAt = Math.min(Math.max(add.index ?? argTexts.length, 0), argTexts.length);
          argTexts.splice(insertAt, 0, add.argText as string);
        }
        edits.push({
          operationId: "signature",
          start: args.startIndex + 1,
          end: args.endIndex - 1,
          replacement: argTexts.join(", "),
        });
        // Do not descend into an edited call — nested edits would overlap
        // the enclosing argument span (the joined arg texts carry them).
        return;
      }
    }
    for (const child of node.namedChildren) {
      visit(child);
      if (sawManualReview || sawArityMismatch) return;
    }
  };
  visit(tree.rootNode);

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

export async function planSignatureSearchEditPreview(request: SearchEditSingleOperationRequest): Promise<PreviewResult> {
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
      const result = buildSignatureCallsiteEdits(content, rel, target.name, signature, originalNames);
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
