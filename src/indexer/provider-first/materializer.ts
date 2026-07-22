import type { Connection } from "kuzu";

import type { EdgeRow, FileRow, SymbolRow } from "../../db/ladybug-queries.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { deleteProviderReplacementSymbols } from "../../db/ladybug-provider-first.js";
import type { EdgeType, SymbolKind } from "../../domain/types.js";
import {
  dropFtsIndex,
  ensureFtsIndexForNonEmptyTable,
} from "../../retrieval/index-lifecycle.js";
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
  ProviderSourceType,
  SymbolFact,
} from "./types.js";
import { validateProviderFirstGraphRows } from "./graph-validation.js";

const PROVIDER_MINIMAL_DOCUMENTATION_SUMMARY_QUALITY = 0.4;
const PROVIDER_STANDARD_DOCUMENTATION_SUMMARY_QUALITY = 0.6;
const PROVIDER_RICH_DOCUMENTATION_SUMMARY_QUALITY = 0.8;
const PROVIDER_STANDARD_DOCUMENTATION_CHAR_THRESHOLD = 80;
const PROVIDER_RICH_DOCUMENTATION_CHAR_THRESHOLD = 160;
const DEFAULT_SYMBOL_FTS_INDEX_NAME = "symbol_search_text_v1";

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
  source: Exclude<ProviderSourceType, "legacy">;
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
  /** The owning index session has independently built expectations for this write. */
  graphIntegrityExpectationsTracked?: boolean;
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
   * Use the COPY-based Symbol writer only when later Symbol mutations are safe.
   */
  useKnownFreshWriters?: boolean;
  /**
   * Use the known-fresh edge path independently from the Symbol writer. This
   * defaults to useKnownFreshWriters for existing callers.
   */
  useKnownFreshEdgeWriter?: boolean;
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
   * Configured Symbol.searchText FTS index name. Provider replacement drops it
   * around bulk Symbol writes because LadybugDB maintains FTS indexes eagerly.
   */
  symbolFtsIndexName?: string;
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

export function filterProviderRowsByExcludedPaths(
  rows: ProviderFirstGraphRows,
  excludedPaths: ReadonlySet<string>,
): ProviderFirstGraphRows {
  if (excludedPaths.size === 0) return rows;

  const files = rows.files.filter((file) => !excludedPaths.has(file.relPath));
  const keptFileIds = new Set(files.map((file) => file.fileId));
  const symbols = rows.symbols.filter((symbol) =>
    keptFileIds.has(symbol.fileId),
  );
  const internalSymbolIds = new Set(symbols.map((symbol) => symbol.symbolId));
  const externalSymbolIds = new Set(
    rows.externalSymbols.map((symbol) => symbol.symbolId),
  );
  const allowedSymbolIds = new Set([
    ...internalSymbolIds,
    ...externalSymbolIds,
  ]);
  const edges = rows.edges.filter(
    (edge) =>
      allowedSymbolIds.has(edge.fromSymbolId) &&
      allowedSymbolIds.has(edge.toSymbolId) &&
      (internalSymbolIds.has(edge.fromSymbolId) ||
        internalSymbolIds.has(edge.toSymbolId)),
  );
  const referencedExternalSymbolIds = new Set<string>();
  for (const edge of edges) {
    if (externalSymbolIds.has(edge.fromSymbolId)) {
      referencedExternalSymbolIds.add(edge.fromSymbolId);
    }
    if (externalSymbolIds.has(edge.toSymbolId)) {
      referencedExternalSymbolIds.add(edge.toSymbolId);
    }
  }
  const externalSymbols = rows.externalSymbols.filter((symbol) =>
    referencedExternalSymbolIds.has(symbol.symbolId),
  );

  return {
    files,
    symbols,
    externalSymbols,
    edges,
    changedFileIds: new Set(files.map((file) => file.fileId)),
  };
}

export function filterProviderFactsByExcludedPaths(
  facts: ProviderFactSet,
  excludedPaths: ReadonlySet<string>,
): ProviderFactSet {
  const filePathAllowed = (relPath: string): boolean =>
    !excludedPaths.has(normalizePath(relPath));
  const files = facts.files.filter((fact) => filePathAllowed(fact.relPath));
  const symbols = facts.symbols.filter((fact) => filePathAllowed(fact.relPath));
  const internalSymbolIds = new Set(symbols.map((symbol) => symbol.symbolId));
  const externalSymbolIds = new Set(
    facts.externalSymbols.map((symbol) => symbol.symbolId),
  );
  const allowedSymbolIds = new Set([
    ...internalSymbolIds,
    ...externalSymbolIds,
  ]);
  const edges = facts.edges.filter(
    (edge) =>
      allowedSymbolIds.has(edge.sourceSymbolId) &&
      allowedSymbolIds.has(edge.targetSymbolId) &&
      (internalSymbolIds.has(edge.sourceSymbolId) ||
        internalSymbolIds.has(edge.targetSymbolId)),
  );
  const referencedExternalSymbolIds = new Set<string>();
  for (const edge of edges) {
    if (externalSymbolIds.has(edge.sourceSymbolId)) {
      referencedExternalSymbolIds.add(edge.sourceSymbolId);
    }
    if (externalSymbolIds.has(edge.targetSymbolId)) {
      referencedExternalSymbolIds.add(edge.targetSymbolId);
    }
  }
  const externalSymbols = facts.externalSymbols.filter((symbol) =>
    referencedExternalSymbolIds.has(symbol.symbolId),
  );
  const diagnostics = facts.diagnostics.filter((fact) =>
    filePathAllowed(fact.relPath),
  );
  const coverage = facts.coverage.filter((fact) =>
    filePathAllowed(fact.relPath),
  );
  const occurrences = facts.occurrences.filter((fact) =>
    filePathAllowed(fact.relPath),
  );
  const sourceLinesByPath =
    facts.sourceLinesByPath &&
    new Map(
      [...facts.sourceLinesByPath.entries()].filter(([relPath]) =>
        filePathAllowed(relPath),
      ),
    );
  const providerRuns = facts.providerRuns.map((run) => ({
    ...run,
    fileCount: files.length,
    symbolCount: symbols.length + externalSymbols.length,
    edgeCount: edges.length,
    diagnosticCount: diagnostics.length,
  }));

  return {
    files,
    symbols,
    occurrences,
    edges,
    externalSymbols,
    diagnostics,
    coverage,
    providerRuns,
    ...(sourceLinesByPath ? { sourceLinesByPath } : {}),
  };
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
  const useKnownFreshEdgeWriter =
    options.useKnownFreshEdgeWriter ?? useKnownFreshWriters;
  const writeEdges = options.writeEdges ?? true;
  const pruneExternalSymbols = options.pruneExternalSymbols ?? true;

  const runMaterialization = async (): Promise<void> => {
    if (!options.graphIntegrityExpectationsTracked) {
      await ladybugDb.invalidateGraphIntegrity(conn, repoId);
    }
    if (deleteExistingFileSymbols) {
      await measurePhase("deleteFileSymbols", async () => {
        await deleteProviderReplacementSymbols(
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
          for (const source of providerExternalSymbolSources(rows)) {
            await ladybugDb.pruneStaleScipExternalSymbols(
              txConn,
              repoId,
              rows.externalSymbols
                .filter((symbol) => symbol.source === source)
                .map((symbol) => symbol.symbolId),
              source,
            );
          }
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
          ...(useKnownFreshEdgeWriter
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
            await measurePhase(
              `insertEdges.${phaseName}`,
              async () => await fn(),
            ),
        });
      });
    });
  };

  if (!options.replaceFileSymbols) {
    await runMaterialization();
    return;
  }

  const symbolFtsIndexName =
    options.symbolFtsIndexName ?? DEFAULT_SYMBOL_FTS_INDEX_NAME;
  const dropResult = await dropFtsIndex(conn, "Symbol", symbolFtsIndexName);
  if (dropResult.status === "failed") {
    throw new Error(
      `Symbol FTS index '${symbolFtsIndexName}' could not be dropped before provider replacement: ${dropResult.error}`,
    );
  }

  let materializationError: unknown;
  try {
    await runMaterialization();
  } catch (error) {
    materializationError = error;
    throw error;
  } finally {
    if (dropResult.status === "dropped") {
      const ensureResult = await ensureFtsIndexForNonEmptyTable(
        conn,
        "Symbol",
        symbolFtsIndexName,
      );
      if (ensureResult.status === "failed") {
        const rebuildError = new Error(
          `Symbol FTS index '${symbolFtsIndexName}' could not be rebuilt after provider replacement: ${ensureResult.error}`,
        );
        if (materializationError !== undefined) {
          throw new AggregateError(
            [materializationError, rebuildError],
            "Provider replacement failed and Symbol FTS rebuild also failed",
          );
        }
        throw rebuildError;
      }
    }
  }
}

function providerExternalSymbolSources(
  rows: ProviderFirstGraphRows,
): Array<Exclude<ProviderSourceType, "legacy">> {
  const sources = new Set<Exclude<ProviderSourceType, "legacy">>();
  for (const symbol of rows.externalSymbols) {
    sources.add(symbol.source);
  }
  for (const symbol of rows.symbols) {
    if (symbol.source === "scip" || symbol.source === "lsp") {
      sources.add(symbol.source);
    }
  }
  return [...sources];
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
    source: fact.providerType,
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
