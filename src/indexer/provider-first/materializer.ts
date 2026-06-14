import type { Connection } from "kuzu";

import type { EdgeRow, FileRow, SymbolRow } from "../../db/ladybug-queries.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { EdgeType, SymbolKind } from "../../domain/types.js";
import { generateFileId, hashValue } from "../../util/hashing.js";
import { normalizePath } from "../../util/paths.js";
import { canonicalizeLanguageId } from "../language.js";
import { resolveSymbolEnrichment } from "../symbol-enrichment.js";
import type { IndexProgress, IndexProgressSubstage } from "../indexer-init.js";
import type {
  EdgeFact,
  ExternalSymbolFact,
  FileFact,
  ProviderFactSet,
  SymbolFact,
} from "./types.js";
import { validateProviderFirstGraphRows } from "./graph-validation.js";

const PROVIDER_MINIMAL_DOCUMENTATION_SUMMARY_QUALITY = 0.4;
const PROVIDER_STANDARD_DOCUMENTATION_SUMMARY_QUALITY = 0.6;
const PROVIDER_RICH_DOCUMENTATION_SUMMARY_QUALITY = 0.8;
const PROVIDER_STANDARD_DOCUMENTATION_CHAR_THRESHOLD = 80;
const PROVIDER_RICH_DOCUMENTATION_CHAR_THRESHOLD = 160;

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
  onProgress?: (progress: {
    stage: IndexProgress["stage"];
    current: number;
    total: number;
    substage?: IndexProgressSubstage;
    stageCurrent?: number;
    stageTotal?: number;
    message?: string;
  }) => void;
}

export interface MaterializeProviderFactsOptions {
  /**
   * Full provider-first refreshes replace the symbol graph for provider-owned
   * files before writing new rows. This keeps stale tree-sitter symbols from
   * surviving beside compiler-owned SCIP symbols.
   */
  replaceFileSymbols?: boolean;
  /**
   * Controls only the stale-row delete pre-pass. Defaults to replaceFileSymbols.
   * Fresh DBs can skip this while still using provider-owned fast writers.
   */
  deleteExistingFileSymbols?: boolean;
  /**
   * Use COPY-based symbol and edge writers that require the active graph to
   * have no existing rows for the same provider-owned symbols/relationships.
   * Safe for fresh databases or after deleteExistingFileSymbols ran.
   */
  useKnownFreshWriters?: boolean;
  /**
   * Controls provider edge writes independently from symbol updates. Large
   * repeat runs may skip edge replacement when stale cleanup was intentionally
   * bypassed, avoiding duplicate relationship COPYs and the slow generic path.
   */
  writeEdges?: boolean;
  /**
   * Repo-wide SCIP external pruning is safe only when rows.externalSymbols is
   * the full provider truth set. Scoped benchmark runs retain a subset of SCIP
   * documents, so they must not prune out-of-scope externals.
   */
  pruneExternalSymbols?: boolean;
  /**
   * Optional instrumentation hook used by the provider-first orchestrator to
   * expose the individual LadybugDB write buckets without changing transaction
   * ownership or write ordering.
   */
  measurePhase?: <T>(
    phaseName: MaterializeProviderFactsPhaseName,
    fn: () => Promise<T>,
  ) => Promise<T>;
}

export type MaterializeProviderFactsPhaseName =
  | "deleteFileSymbols"
  | "upsertFiles"
  | "upsertSymbols"
  | "upsertSymbols.nodeAndRelCreate"
  | "upsertSymbols.nodeUpsert"
  | "upsertSymbols.fileRelCreate"
  | "upsertSymbols.repoRelCreate"
  | "pruneExternalSymbols"
  | "mergeExternalSymbols"
  | "insertEdges"
  | `insertEdges.${ladybugDb.InsertEdgesPhaseName}`;

const PROVIDER_FIRST_DELETE_SYMBOL_FILE_CHUNK_SIZE = 256;

export function providerFactsToGraphRows(
  options: ProviderFactsToGraphRowsOptions,
): ProviderFirstGraphRows {
  const indexedAt = options.indexedAt ?? new Date().toISOString();
  const totalRows = providerFirstGraphRowTotal(options.facts);
  let shapedRows = 0;
  emitProviderRowsProgress(options, shapedRows, totalRows, "starting");
  const fileByPath = new Map(
    options.facts.files.map((fact) => [normalizePath(fact.relPath), fact]),
  );

  const files = options.facts.files.map((fact) =>
    fileFactToRow(fact, indexedAt),
  );
  shapedRows += files.length;
  emitProviderRowsProgress(options, shapedRows, totalRows, "files shaped");
  const symbols = options.facts.symbols.map((fact) =>
    symbolFactToRow(fact, fileByPath, indexedAt),
  );
  shapedRows += symbols.length;
  emitProviderRowsProgress(options, shapedRows, totalRows, "symbols shaped");
  const externalSymbols = options.facts.externalSymbols.map((fact) =>
    externalSymbolFactToRow(fact, indexedAt),
  );
  shapedRows += externalSymbols.length;
  emitProviderRowsProgress(
    options,
    shapedRows,
    totalRows,
    "external symbols shaped",
  );
  const edges = options.facts.edges.map((fact) => edgeFactToRow(fact));
  shapedRows += edges.length;
  emitProviderRowsProgress(options, shapedRows, totalRows, "edges shaped");

  return {
    files,
    symbols,
    externalSymbols,
    edges,
    changedFileIds: new Set(files.map((file) => file.fileId)),
  };
}

export function providerFirstGraphRowTotal(rows: {
  files: readonly unknown[];
  symbols: readonly unknown[];
  externalSymbols: readonly unknown[];
  edges: readonly unknown[];
}): number {
  return (
    rows.files.length +
    rows.symbols.length +
    rows.externalSymbols.length +
    rows.edges.length
  );
}

function emitProviderRowsProgress(
  options: ProviderFactsToGraphRowsOptions,
  current: number,
  total: number,
  message: string,
): void {
  options.onProgress?.({
    stage: "providerFirst",
    current,
    total,
    substage: "providerCollection.rows",
    stageCurrent: current,
    stageTotal: total,
    message,
  });
}

export async function materializeProviderFacts(
  conn: Connection,
  rows: ProviderFirstGraphRows,
  options: MaterializeProviderFactsOptions = {},
): Promise<void> {
  validateProviderFirstGraphRows(rows, {
    context: "Provider-first materialize",
  });
  // Active materialization still owns the live graph before shadow activation,
  // but provider-owned replacement rows use known-fresh COPY paths for symbols
  // and edges while legacy fallback keeps the broader merge-safe writers.
  const repoId = resolveRowsRepoId(rows);
  const measurePhase =
    options.measurePhase ??
    (async <T>(
      _phaseName: MaterializeProviderFactsPhaseName,
      fn: () => Promise<T>,
    ): Promise<T> => await fn());
  const deleteExistingFileSymbols =
    options.deleteExistingFileSymbols ?? options.replaceFileSymbols;
  const useKnownFreshWriters =
    options.useKnownFreshWriters ?? options.replaceFileSymbols;
  const writeEdges = options.writeEdges ?? true;
  const pruneExternalSymbols = options.pruneExternalSymbols ?? true;
  if (deleteExistingFileSymbols) {
    await measurePhase("deleteFileSymbols", async () => {
      await deleteProviderReplacementSymbolsInChunks(
        conn,
        repoId,
        [...rows.changedFileIds],
        rows.symbols.map((symbol) => symbol.symbolId),
      );
    });
  }
  await ladybugDb.withTransaction(conn, async (txConn) => {
    await measurePhase("upsertFiles", async () => {
      await ladybugDb.upsertFileBatch(txConn, rows.files);
    });
    await measurePhase("upsertSymbols", async () => {
      if (useKnownFreshWriters) {
        await ladybugDb.upsertKnownFileSymbols(txConn, rows.symbols, {
          measurePhase: async (phaseName, fn) =>
            await measurePhase(`upsertSymbols.${phaseName}`, fn),
        });
      } else {
        await ladybugDb.upsertSymbolBatch(txConn, rows.symbols);
      }
    });
    if (pruneExternalSymbols) {
      await measurePhase("pruneExternalSymbols", async () => {
        await ladybugDb.pruneStaleScipExternalSymbols(
          txConn,
          repoId,
          rows.externalSymbols.map((symbol) => symbol.symbolId),
        );
      });
    }
    if (rows.externalSymbols.length > 0) {
      await measurePhase("mergeExternalSymbols", async () => {
        await ladybugDb.batchMergeExternalSymbols(
          txConn,
          repoId,
          rows.externalSymbols,
        );
      });
    }
    await measurePhase("insertEdges", async () => {
      if (!writeEdges) return;
      await ladybugDb.insertEdges(txConn, rows.edges, {
        ...(useKnownFreshWriters
          ? {
              skipSourceRepoLink: true,
              skipExistingRelationshipProbe: true,
              skipExistingRelationshipUpdate: true,
              skipEndpointMetadata: true,
              skipTargetMetadata: true,
            }
          : {}),
        useExistingTransaction: true,
        measurePhase: async (phaseName, fn) =>
          await measurePhase(`insertEdges.${phaseName}`, async () => await fn()),
      });
    });
  });
}

async function deleteProviderReplacementSymbolsInChunks(
  conn: Connection,
  repoId: string,
  fileIds: string[],
  incomingSymbolIds: string[],
): Promise<void> {
  // Delete fan-out is much larger than file upsert fan-out: one file chunk can
  // expand into tens of thousands of Symbol ids plus every dependent edge and
  // enrichment row. Keep this deliberately below the generic file-write chunk.
  const fileChunkSize = Math.min(
    ladybugDb.resolveLadybugWriteChunkSize("files"),
    PROVIDER_FIRST_DELETE_SYMBOL_FILE_CHUNK_SIZE,
  );
  const symbolIds = new Set<string>();
  for (let i = 0; i < fileIds.length; i += fileChunkSize) {
    const chunk = fileIds.slice(i, i + fileChunkSize);
    const rows = await ladybugDb.queryAll<{ symbolId: string }>(
      conn,
      `MATCH (:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)
       WHERE f.fileId IN $fileIds
       RETURN s.symbolId AS symbolId`,
      { repoId, fileIds: chunk },
    );
    for (const row of rows) symbolIds.add(row.symbolId);
  }

  const uniqueIncomingSymbolIds = [...new Set(incomingSymbolIds)];
  const symbolChunkSize = Math.min(
    ladybugDb.resolveLadybugWriteChunkSize("symbols"),
    PROVIDER_FIRST_DELETE_SYMBOL_FILE_CHUNK_SIZE * 4,
  );
  for (let i = 0; i < uniqueIncomingSymbolIds.length; i += symbolChunkSize) {
    const chunk = uniqueIncomingSymbolIds.slice(i, i + symbolChunkSize);
    const rows = await ladybugDb.queryAll<{ symbolId: string }>(
      conn,
      `MATCH (s:Symbol {repoId: $repoId})
       WHERE s.symbolId IN $symbolIds
       RETURN s.symbolId AS symbolId`,
      { repoId, symbolIds: chunk },
    );
    for (const row of rows) symbolIds.add(row.symbolId);
  }

  const uniqueSymbolIds = [...symbolIds];
  if (uniqueSymbolIds.length === 0) return;
  for (let i = 0; i < uniqueSymbolIds.length; i += symbolChunkSize) {
    const chunk = uniqueSymbolIds.slice(i, i + symbolChunkSize);
    const fileCleanupIds = i === 0 ? fileIds : [];
    await ladybugDb.withTransaction(conn, async (txConn) => {
      await retireProviderSymbolsByIds(txConn, repoId, chunk, fileCleanupIds);
    });
  }
}

async function retireProviderSymbolsByIds(
  conn: Connection,
  repoId: string,
  symbolIds: string[],
  fileIds: string[] = [],
): Promise<void> {
  if (symbolIds.length === 0) return;
  for (const [query, params] of [
    [
      `MATCH (s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    ],
    [
      `MATCH (:Symbol)-[d:DEPENDS_ON]->(s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    ],
    [
      `MATCH (s:Symbol)-[r:SYMBOL_IN_REPO]->(:Repo)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    ],
    [
      `MATCH (s:Symbol)-[r:SYMBOL_IN_FILE]->(:File)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    ],
    [
      `MATCH (s:Symbol)-[r:BELONGS_TO_CLUSTER]->(:Cluster)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    ],
    [
      `MATCH (s:Symbol)-[r:BELONGS_TO_SHADOW_CLUSTER]->(:ShadowCluster)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    ],
    [
      `MATCH (s:Symbol)-[r:PARTICIPATES_IN]->(:Process)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    ],
    [
      `MATCH (m:Metrics)
       WHERE m.symbolId IN $symbolIds
       DELETE m`,
      { symbolIds },
    ],
    [
      `MATCH (e:SymbolEmbedding)
       WHERE e.symbolId IN $symbolIds
       DELETE e`,
      { symbolIds },
    ],
    [
      `MATCH (sc:SummaryCache)
       WHERE sc.symbolId IN $symbolIds
       DELETE sc`,
      { symbolIds },
    ],
    [
      `MATCH (sr:SymbolReference)
       WHERE sr.fileId IN $fileIds
       DELETE sr`,
      { fileIds },
    ],
    [
      `MATCH (mem:Memory)-[r:MEMORY_OF]->(s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    ],
    [
      `MATCH (mem:Memory)-[r:MEMORY_OF_FILE]->(f:File)
       WHERE f.fileId IN $fileIds
       DELETE r`,
      { fileIds },
    ],
    [
      `MATCH (s:Symbol {repoId: $repoId})
       WHERE s.symbolId IN $symbolIds
       DELETE s`,
      { repoId, symbolIds },
    ],
  ] as const) {
    if ("fileIds" in params && params.fileIds.length === 0) continue;
    await ladybugDb.exec(conn, query, params);
  }
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
    contentHash: fact.contentHash ?? "",
    language: canonicalizeLanguageId(fact.languageId, relPath),
    byteSize: fact.byteSize ?? -1,
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
  const symbolStatus = fact.symbolStatus ?? "real";
  const signatureJson = buildProviderSignatureJson(
    fact.symbolKind,
    fact.name,
    fact.signature,
  );
  const summary = firstDocumentationLine(fact.documentation);
  const language = canonicalizeLanguageId(
    fileByPath.get(relPath)?.languageId,
    relPath,
  );
  const enrichment = resolveSymbolEnrichment({
    kind: fact.symbolKind,
    name: fact.name,
    relPath,
    summary,
  });

  return {
    symbolId: fact.symbolId,
    repoId: fact.repoId,
    fileId:
      fileByPath.get(relPath)?.fileId ?? generateFileId(fact.repoId, relPath),
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
    summaryQuality: providerDocumentationSummaryQuality(
      fact.documentation,
      summary,
    ),
    summarySource: `provider:${fact.providerType}`,
    roleTagsJson: enrichment.roleTagsJson,
    searchText: enrichment.searchText,
    external: false,
    scipSymbol: fact.providerType === "scip" ? fact.providerSymbolId : null,
    source: fact.providerType,
    symbolStatus,
    placeholderKind: fact.placeholderKind,
    placeholderTarget: fact.placeholderTarget,
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
    provenance: providerEdgeProvenance(fact),
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

function firstDocumentationLine(
  documentation: readonly string[],
): string | null {
  for (const entry of documentation) {
    const line = entry.trim().split(/\r?\n/, 1)[0]?.trim();
    if (line && line.length > 0) return line;
  }
  return null;
}

function providerDocumentationSummaryQuality(
  documentation: readonly string[],
  summary: string | null,
): number {
  if (!summary) return 0.0;
  const documentationLines = documentation
    .flatMap((entry) => entry.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const documentationTextLength = documentationLines.join(" ").length;

  if (
    documentationLines.length >= 3 ||
    documentationTextLength >= PROVIDER_RICH_DOCUMENTATION_CHAR_THRESHOLD
  ) {
    return PROVIDER_RICH_DOCUMENTATION_SUMMARY_QUALITY;
  }
  if (
    documentationLines.length >= 2 ||
    documentationTextLength >= PROVIDER_STANDARD_DOCUMENTATION_CHAR_THRESHOLD
  ) {
    return PROVIDER_STANDARD_DOCUMENTATION_SUMMARY_QUALITY;
  }
  return PROVIDER_MINIMAL_DOCUMENTATION_SUMMARY_QUALITY;
}

function providerEdgeProvenance(fact: EdgeFact): string {
  return JSON.stringify({
    providerId: fact.providerId,
    providerType: fact.providerType,
    ...(fact.providerVersion ? { providerVersion: fact.providerVersion } : {}),
    ...(fact.sourceIndexPath
      ? { sourceIndexPath: normalizePath(fact.sourceIndexPath) }
      : {}),
    ...(fact.relPath ? { relPath: normalizePath(fact.relPath) } : {}),
    dedupeKey: fact.dedupeKey,
  });
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
