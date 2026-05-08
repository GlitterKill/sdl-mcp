import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative } from "node:path";

import type { RepoId } from "../../../domain/types.js";
import { getRelativePath, normalizePath } from "../../../util/paths.js";
import type {
  SemanticEdge,
  SemanticIndex,
  SemanticRange,
  SemanticSymbol,
} from "../../types.js";
import { filterSemanticIndexByLanguages } from "../../index-utils.js";

const DEFAULT_MAX_LSIF_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_LSIF_ELEMENTS = 500_000;

interface LsifBaseElement {
  id: string;
  type: "vertex" | "edge";
  label: string;
}

interface LsifVertex extends LsifBaseElement {
  type: "vertex";
  uri?: string;
  start?: LsifPosition;
  end?: LsifPosition;
  result?: unknown;
}

interface LsifEdge extends LsifBaseElement {
  type: "edge";
  outV?: string;
  inV?: string;
  inVs?: string[];
  property?: string;
}

interface LsifPosition {
  line: number;
  character: number;
}

type LsifElement = LsifVertex | LsifEdge;

export interface ReadLsifIndexOptions {
  repoId: RepoId;
  repoRoot: string;
  indexPath: string;
  runId: string;
  providerId?: string;
  providerVersion?: string;
  confidence?: number;
  languages?: readonly string[];
  maxFileBytes?: number;
  maxElements?: number;
}

export async function readLsifIndex(
  options: ReadLsifIndexOptions,
): Promise<SemanticIndex> {
  const stats = await stat(options.indexPath);
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_LSIF_FILE_BYTES;
  if (stats.size > maxBytes) {
    throw new Error(
      `LSIF index exceeds maximum size: ${stats.size} bytes > ${maxBytes} bytes`,
    );
  }
  const raw = await readFile(options.indexPath, "utf8");
  const elements = parseLsifElements(raw, {
    maxElements: options.maxElements ?? DEFAULT_MAX_LSIF_ELEMENTS,
  });
  return filterSemanticIndexByLanguages(
    normalizeLsifElements(elements, options),
    options.languages,
  );
}

export function parseLsifElements(
  raw: string,
  options: { maxElements?: number } = {},
): LsifElement[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const maxElements = options.maxElements ?? DEFAULT_MAX_LSIF_ELEMENTS;

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    enforceElementLimit(values.length, maxElements);
    return values.filter(isLsifElement).map(normalizeLsifElement);
  }

  const elements: LsifElement[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    enforceElementLimit(elements.length + 1, maxElements);
    const parsed = JSON.parse(line);
    if (isLsifElement(parsed)) {
      elements.push(normalizeLsifElement(parsed));
    }
  }
  return elements;
}

function normalizeLsifElement(element: LsifElement): LsifElement {
  if (element.type === "vertex") {
    return {
      ...element,
      id: String(element.id),
    };
  }

  return {
    ...element,
    id: String(element.id),
    outV: "outV" in element ? String(element.outV) : undefined,
    inV:
      "inV" in element && element.inV !== undefined
        ? String(element.inV)
        : undefined,
    inVs:
      "inVs" in element && Array.isArray(element.inVs)
        ? element.inVs.map((id) => String(id))
        : undefined,
  };
}

function enforceElementLimit(count: number, maxElements: number): void {
  if (count > maxElements) {
    throw new Error(
      `LSIF index exceeds maximum element count: ${count} > ${maxElements}`,
    );
  }
}

export function normalizeLsifElements(
  elements: readonly LsifElement[],
  options: ReadLsifIndexOptions,
): SemanticIndex {
  const providerId = options.providerId ?? "lsif";
  const confidence = options.confidence ?? 0.9;
  const documents = new Map<string, LsifVertex>();
  const ranges = new Map<string, LsifVertex>();
  const rangeToDocument = new Map<string, string>();
  const rangeToResultSet = new Map<string, string>();
  const resultSetToRanges = new Map<string, Set<string>>();
  const resultSetToResults = new Map<string, Map<string, string>>();
  const resultToRanges = new Map<string, Set<string>>();

  for (const element of elements) {
    if (element.type === "vertex") {
      if (element.label === "document") documents.set(element.id, element);
      if (element.label === "range") ranges.set(element.id, element);
      continue;
    }

    if (element.label === "contains" && element.outV && element.inVs) {
      for (const rangeId of element.inVs) {
        rangeToDocument.set(rangeId, element.outV);
      }
      continue;
    }

    if (element.label === "next" && element.outV && element.inV) {
      if (ranges.has(element.outV)) {
        rangeToResultSet.set(element.outV, element.inV);
        addToSet(resultSetToRanges, element.inV, element.outV);
      } else if (ranges.has(element.inV)) {
        rangeToResultSet.set(element.inV, element.outV);
        addToSet(resultSetToRanges, element.outV, element.inV);
      }
      continue;
    }

    if (
      element.outV &&
      element.inV &&
      element.label.startsWith("textDocument/")
    ) {
      const capability = element.label.slice("textDocument/".length);
      const byCapability =
        resultSetToResults.get(element.outV) ?? new Map<string, string>();
      byCapability.set(capability, element.inV);
      resultSetToResults.set(element.outV, byCapability);
      continue;
    }

    if (element.label === "item" && element.outV) {
      const targets = element.inVs ?? (element.inV ? [element.inV] : []);
      for (const target of targets) {
        addToSet(resultToRanges, element.outV, target);
      }
    }
  }

  const semanticSymbols: SemanticSymbol[] = [];
  const semanticEdges: SemanticEdge[] = [];

  for (const [rangeId, rangeVertex] of ranges) {
    const doc = documents.get(rangeToDocument.get(rangeId) ?? "");
    if (!doc?.uri || !rangeVertex.start || !rangeVertex.end) continue;
    const sourcePath = uriToRepoPath(doc.uri, options.repoRoot);
    semanticSymbols.push({
      providerSymbolId: rangeSymbolId(sourcePath, rangeId),
      name: rangeSymbolId(sourcePath, rangeId),
      languageId: inferLanguageId(sourcePath),
      sourcePath,
      range: positionToRange(rangeVertex.start, rangeVertex.end),
    });
  }

  for (const [rangeId, resultSetId] of rangeToResultSet) {
    const sourceDoc = documents.get(rangeToDocument.get(rangeId) ?? "");
    if (!sourceDoc?.uri) continue;
    const sourcePath = uriToRepoPath(sourceDoc.uri, options.repoRoot);
    const resultMap = resultSetToResults.get(resultSetId);
    if (!resultMap) continue;

    for (const [capability, resultId] of resultMap) {
      const targetRanges = resultToRanges.get(resultId);
      if (!targetRanges) continue;
      for (const targetRangeId of targetRanges) {
        const targetDoc = documents.get(
          rangeToDocument.get(targetRangeId) ?? "",
        );
        if (!targetDoc?.uri || targetRangeId === rangeId) continue;
        const targetPath = uriToRepoPath(targetDoc.uri, options.repoRoot);
        const semanticCapability = lsifCapability(capability);
        semanticEdges.push({
          sourceProviderSymbolId: rangeSymbolId(sourcePath, rangeId),
          targetProviderSymbolId: rangeSymbolId(targetPath, targetRangeId),
          edgeType:
            semanticCapability === "implementation" ? "implements" : "call",
          confidence,
          resolution: "exact",
          resolverId: `lsif:${providerId}`,
          resolutionPhase: "lsif",
          capability: semanticCapability,
          provenance: {
            providerType: "lsif",
            providerId,
            capability: semanticCapability,
            confidence,
            runId: options.runId,
            sourceIndexPath: normalizePath(options.indexPath),
            resolutionPhase: "lsif",
          },
        });
      }
    }
  }

  const semanticDocuments = [...documents.values()]
    .filter((document) => document.uri)
    .map((document) => {
      const sourcePath = uriToRepoPath(document.uri ?? "", options.repoRoot);
      return {
        languageId: inferLanguageId(sourcePath),
        sourcePath,
        occurrences: [],
        diagnostics: [],
      };
    });

  const index: SemanticIndex = {
    repoId: options.repoId,
    runId: options.runId,
    providerType: "lsif",
    providerId,
    providerVersion: options.providerVersion,
    sourceIndexPath: normalizePath(options.indexPath),
    generatedAt: new Date().toISOString(),
    documents: semanticDocuments,
    symbols: semanticSymbols,
    edges: semanticEdges,
    diagnostics: [],
  };
  return filterSemanticIndexByLanguages(index, options.languages);
}

function isLsifElement(value: unknown): value is LsifElement {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.type === "vertex" || record.type === "edge") &&
    typeof record.label === "string" &&
    record.id !== undefined
  );
}

function addToSet(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

function uriToRepoPath(uri: string, repoRoot: string): string {
  try {
    if (uri.startsWith("file:")) {
      const filePath = normalizePath(fileURLToPath(uri));
      const normalizedRoot = normalizePath(repoRoot);
      return filePath.startsWith(normalizedRoot)
        ? normalizePath(getRelativePath(normalizedRoot, filePath))
        : normalizePath(relative(normalizedRoot, filePath));
    }
  } catch {
    // Fall through to URI-shaped path normalization below.
  }

  if (isAbsolute(uri)) {
    return normalizePath(relative(repoRoot, uri));
  }
  return normalizePath(uri.replace(/^[a-zA-Z]+:\/\//, ""));
}

function rangeSymbolId(sourcePath: string, rangeId: string): string {
  return `lsif:${sourcePath}#${rangeId}`;
}

function positionToRange(
  start: LsifPosition,
  end: LsifPosition,
): SemanticRange {
  return {
    startLine: start.line,
    startCol: start.character,
    endLine: end.line,
    endCol: end.character,
  };
}

function inferLanguageId(sourcePath: string): string {
  const lower = sourcePath.toLowerCase();
  if (lower.endsWith(".py") || lower.endsWith(".pyw")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".php") || lower.endsWith(".phtml")) return "php";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".c") || lower.endsWith(".h")) return "c";
  if (
    lower.endsWith(".cpp") ||
    lower.endsWith(".cc") ||
    lower.endsWith(".cxx") ||
    lower.endsWith(".hpp") ||
    lower.endsWith(".hh") ||
    lower.endsWith(".hxx")
  ) {
    return "cpp";
  }
  if (
    lower.endsWith(".sh") ||
    lower.endsWith(".bash") ||
    lower.endsWith(".zsh")
  ) {
    return "shell";
  }
  return "typescript";
}

function lsifCapability(
  capability: string,
): "definition" | "reference" | "implementation" | "typeDefinition" {
  if (capability === "implementation") return "implementation";
  if (capability === "typeDefinition") return "typeDefinition";
  if (capability === "references") return "reference";
  return "definition";
}
