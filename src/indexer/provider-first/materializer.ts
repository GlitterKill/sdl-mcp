import type { Connection } from "kuzu";

import type {
  EdgeRow,
  FileRow,
  SymbolRow,
} from "../../db/ladybug-queries.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { EdgeType, SymbolKind } from "../../domain/types.js";
import { generateFileId, hashValue } from "../../util/hashing.js";
import { normalizePath } from "../../util/paths.js";
import { resolveSymbolEnrichment } from "../symbol-enrichment.js";
import type {
  EdgeFact,
  ExternalSymbolFact,
  FileFact,
  ProviderFactSet,
  SymbolFact,
} from "./types.js";

export interface ProviderFirstExternalSymbolRow {
  symbolId: string;
  repoId: string;
  kind: string;
  name: string;
  exported: boolean;
  language?: string;
  rangeStartLine?: number;
  rangeStartCol?: number;
  rangeEndLine?: number;
  rangeEndCol?: number;
  external: boolean;
  scipSymbol: string;
  source: "scip";
  packageName?: string;
  packageVersion?: string;
  updatedAt: string;
}

export interface ProviderFirstGraphRows {
  files: Array<Omit<FileRow, "directory">>;
  symbols: SymbolRow[];
  externalSymbols: ProviderFirstExternalSymbolRow[];
  edges: EdgeRow[];
  changedFileIds: Set<string>;
}

export interface ProviderFactsToGraphRowsOptions {
  facts: ProviderFactSet;
  indexedAt?: string;
}

export function providerFactsToGraphRows(
  options: ProviderFactsToGraphRowsOptions,
): ProviderFirstGraphRows {
  const indexedAt = options.indexedAt ?? new Date().toISOString();
  const fileByPath = new Map(
    options.facts.files.map((fact) => [normalizePath(fact.relPath), fact]),
  );

  const files = options.facts.files.map((fact) =>
    fileFactToRow(fact, indexedAt),
  );
  const symbols = options.facts.symbols.map((fact) =>
    symbolFactToRow(fact, fileByPath, indexedAt),
  );
  const externalSymbols = options.facts.externalSymbols.map((fact) =>
    externalSymbolFactToRow(fact, indexedAt),
  );
  const edges = options.facts.edges.map((fact) => edgeFactToRow(fact));

  return {
    files,
    symbols,
    externalSymbols,
    edges,
    changedFileIds: new Set(files.map((file) => file.fileId)),
  };
}

export async function materializeProviderFacts(
  conn: Connection,
  rows: ProviderFirstGraphRows,
): Promise<void> {
  // Keep provider-first materialization on the established graph row APIs so
  // LadybugDB batching, relationship workarounds, and placeholder repair stay
  // identical to the legacy writer until the COPY-based shadow loader lands.
  const repoId = resolveRowsRepoId(rows);
  await ladybugDb.withTransaction(conn, async (txConn) => {
    await ladybugDb.upsertFileBatch(txConn, rows.files);
    await ladybugDb.upsertSymbolBatch(txConn, rows.symbols);
    await ladybugDb.pruneStaleScipExternalSymbols(
      txConn,
      repoId,
      rows.externalSymbols.map((symbol) => symbol.symbolId),
    );
    if (rows.externalSymbols.length > 0) {
      await ladybugDb.batchMergeExternalSymbols(
        txConn,
        repoId,
        rows.externalSymbols,
      );
    }
    await ladybugDb.insertEdges(txConn, rows.edges);
  });
}

function fileFactToRow(
  fact: FileFact,
  indexedAt: string,
): Omit<FileRow, "directory"> {
  const relPath = normalizePath(fact.relPath);
  return {
    fileId: fact.fileId,
    repoId: fact.repoId,
    relPath,
    contentHash:
      fact.contentHash ??
      hashValue({
        providerType: fact.providerType,
        providerId: fact.providerId,
        relPath,
      }),
    language: fact.languageId ?? inferLanguage(relPath),
    byteSize: 0,
    lastIndexedAt: indexedAt,
  };
}

function symbolFactToRow(
  fact: SymbolFact,
  fileByPath: ReadonlyMap<string, FileFact>,
  indexedAt: string,
): SymbolRow {
  const relPath = normalizePath(fact.relPath);
  const range = fact.range ?? {
    startLine: 0,
    startCol: 0,
    endLine: 0,
    endCol: 0,
  };
  const signatureJson = buildProviderSignatureJson(
    fact.symbolKind,
    fact.name,
    fact.signature,
  );
  const summary = firstDocumentationLine(fact.documentation);
  const language = fileByPath.get(relPath)?.languageId ?? inferLanguage(relPath);
  const enrichment = resolveSymbolEnrichment({
    kind: fact.symbolKind,
    name: fact.name,
    relPath,
    summary,
  });

  return {
    symbolId: fact.symbolId,
    repoId: fact.repoId,
    fileId: fileByPath.get(relPath)?.fileId ?? generateFileId(fact.repoId, relPath),
    kind: fact.symbolKind,
    name: fact.name,
    exported: true,
    visibility: "public",
    language,
    rangeStartLine: range.startLine,
    rangeStartCol: range.startCol,
    rangeEndLine: range.endLine,
    rangeEndCol: range.endCol,
    astFingerprint: hashValue({
      providerSymbolId: fact.providerSymbolId,
      relPath,
      range,
      signature: fact.signature ?? null,
    }),
    signatureJson,
    summary,
    invariantsJson: null,
    sideEffectsJson: null,
    summaryQuality: summary ? 0.6 : 0.0,
    summarySource: `provider:${fact.providerType}`,
    roleTagsJson: enrichment.roleTagsJson,
    searchText: enrichment.searchText,
    external: false,
    scipSymbol: fact.providerType === "scip" ? fact.providerSymbolId : null,
    source: fact.providerType,
    updatedAt: indexedAt,
  };
}

function externalSymbolFactToRow(
  fact: ExternalSymbolFact,
  indexedAt: string,
): ProviderFirstExternalSymbolRow {
  return {
    symbolId: fact.symbolId,
    repoId: fact.repoId,
    kind: fact.symbolKind ?? "variable",
    name: fact.name,
    exported: true,
    language: "external",
    rangeStartLine: 0,
    rangeStartCol: 0,
    rangeEndLine: 0,
    rangeEndCol: 0,
    external: true,
    scipSymbol: fact.providerSymbolId,
    source: "scip",
    packageName: fact.packageName,
    packageVersion: fact.packageVersion,
    updatedAt: indexedAt,
  };
}

function edgeFactToRow(fact: EdgeFact): EdgeRow {
  return {
    repoId: fact.repoId,
    fromSymbolId: fact.sourceSymbolId,
    toSymbolId: fact.targetSymbolId,
    edgeType: fact.edgeType,
    weight: providerEdgeWeight(fact.edgeType),
    confidence: fact.confidence,
    resolution: fact.resolution,
    resolverId: `provider-first:${fact.providerId}`,
    resolutionPhase: "provider-first",
    provenance: fact.dedupeKey,
    createdAt: fact.emittedAt,
  };
}

function buildProviderSignatureJson(
  kind: SymbolKind,
  name: string,
  signature: string | undefined,
): string {
  if (signature && signature.trim().length > 0) {
    return JSON.stringify({ text: signature.trim() });
  }
  return JSON.stringify({ text: `${kind} ${name}` });
}

function firstDocumentationLine(documentation: readonly string[]): string | null {
  for (const entry of documentation) {
    const line = entry.trim().split(/\r?\n/, 1)[0]?.trim();
    if (line && line.length > 0) return line;
  }
  return null;
}

function providerEdgeWeight(edgeType: EdgeType): number {
  switch (edgeType) {
    case "call":
      return 1.0;
    case "implements":
      return 0.9;
    case "config":
      return 0.8;
    case "import":
      return 0.6;
    default:
      return 0.5;
  }
}

function inferLanguage(relPath: string): string {
  const normalized = normalizePath(relPath).toLowerCase();
  if (normalized.endsWith(".ts") || normalized.endsWith(".tsx")) {
    return "typescript";
  }
  if (normalized.endsWith(".js") || normalized.endsWith(".jsx")) {
    return "javascript";
  }
  if (normalized.endsWith(".py")) return "python";
  if (normalized.endsWith(".go")) return "go";
  if (normalized.endsWith(".rs")) return "rust";
  if (normalized.endsWith(".java")) return "java";
  if (normalized.endsWith(".cs")) return "csharp";
  if (normalized.endsWith(".cpp") || normalized.endsWith(".cc")) return "cpp";
  if (normalized.endsWith(".c")) return "c";
  if (normalized.endsWith(".kt")) return "kotlin";
  if (normalized.endsWith(".php")) return "php";
  if (normalized.endsWith(".sh")) return "shell";
  return "unknown";
}

function resolveRowsRepoId(rows: ProviderFirstGraphRows): string {
  const repoId =
    rows.files[0]?.repoId ??
    rows.symbols[0]?.repoId ??
    rows.externalSymbols[0]?.repoId;
  if (!repoId) {
    throw new Error("Provider-first materialization requires a repoId");
  }
  return repoId;
}
