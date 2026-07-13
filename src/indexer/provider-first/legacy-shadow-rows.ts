import type { Connection } from "kuzu";

import type {
  EdgeRow,
  FileRow,
  SymbolRow,
} from "../../db/ladybug-queries.js";
import {
  readLegacyFallbackEdges,
  readLegacyFallbackFiles,
  readLegacyFallbackSymbols,
  type LegacyFallbackEdgeDbRow,
  type LegacyFallbackSymbolDbRow,
} from "../../db/ladybug-provider-first.js";
import { normalizePath } from "../../util/paths.js";
import { canonicalizeLanguageId } from "../language.js";
import type { ProviderFirstGraphRows } from "./materializer.js";

interface CollectLegacyFallbackShadowRowsParams {
  conn: Connection;
  repoId: string;
  relPaths: Iterable<string>;
  providerRows: ProviderFirstGraphRows;
}

/**
 * Copy the legacy fallback slice that was just written to the live graph back
 * into provider-first row form so the shadow DB can represent the same file
 * coverage before activation work starts.
 */
export async function collectLegacyFallbackShadowRows(
  params: CollectLegacyFallbackShadowRowsParams,
): Promise<ProviderFirstGraphRows> {
  const relPaths = [...new Set(params.relPaths)]
    .map((relPath) => normalizePath(relPath))
    .filter((relPath) => relPath);
  if (relPaths.length === 0) return emptyGraphRows();

  const indexedAt = new Date().toISOString();
  const files = await collectFiles(params.conn, params.repoId, relPaths);
  const fileIds = files.map((file) => file.fileId);
  const symbols = await collectSymbols(
    params.conn,
    params.repoId,
    fileIds,
    indexedAt,
  );
  const fallbackSymbolIds = new Set(symbols.map((symbol) => symbol.symbolId));
  const availableSymbolIds = new Set<string>([
    ...params.providerRows.symbols.map((symbol) => symbol.symbolId),
    ...params.providerRows.externalSymbols.map((symbol) => symbol.symbolId),
    ...fallbackSymbolIds,
  ]);
  const edges = await collectEdges({
    conn: params.conn,
    repoId: params.repoId,
    fallbackSymbolIds,
    availableSymbolIds,
    indexedAt,
  });

  return {
    files,
    symbols,
    externalSymbols: [],
    edges,
    changedFileIds: new Set(files.map((file) => file.fileId)),
  };
}

export function mergeProviderFirstGraphRows(
  ...rowSets: readonly ProviderFirstGraphRows[]
): ProviderFirstGraphRows {
  const files = new Map<string, ProviderFirstGraphRows["files"][number]>();
  const symbols = new Map<string, SymbolRow>();
  const externalSymbols = new Map<
    string,
    ProviderFirstGraphRows["externalSymbols"][number]
  >();
  const edges = new Map<string, EdgeRow>();
  const changedFileIds = new Set<string>();

  for (const rows of rowSets) {
    for (const file of rows.files) files.set(file.fileId, file);
    for (const symbol of rows.symbols) symbols.set(symbol.symbolId, symbol);
    for (const symbol of rows.externalSymbols) {
      externalSymbols.set(symbol.symbolId, symbol);
    }
    for (const edge of rows.edges) {
      edges.set(edgeKey(edge), edge);
    }
    for (const fileId of rows.changedFileIds) changedFileIds.add(fileId);
  }

  return {
    files: [...files.values()],
    symbols: [...symbols.values()],
    externalSymbols: [...externalSymbols.values()],
    edges: [...edges.values()],
    changedFileIds,
  };
}

async function collectFiles(
  conn: Connection,
  repoId: string,
  relPaths: readonly string[],
): Promise<Array<Omit<FileRow, "directory">>> {
  const rows = await readLegacyFallbackFiles(conn, repoId, relPaths);
  return rows.map((row) => ({
    fileId: row.fileId,
    repoId,
    relPath: row.relPath,
    contentHash: row.contentHash,
    language: canonicalizeLanguageId(row.language, row.relPath),
    byteSize: row.byteSize,
    lastIndexedAt: row.lastIndexedAt,
  }));
}

async function collectSymbols(
  conn: Connection,
  repoId: string,
  fileIds: readonly string[],
  indexedAt: string,
): Promise<SymbolRow[]> {
  const rows = await readLegacyFallbackSymbols(conn, repoId, fileIds);
  return rows.map((row) => symbolRow(row, indexedAt));
}

async function collectEdges(params: {
  conn: Connection;
  repoId: string;
  fallbackSymbolIds: ReadonlySet<string>;
  availableSymbolIds: ReadonlySet<string>;
  indexedAt: string;
}): Promise<EdgeRow[]> {
  const edges = new Map<string, EdgeRow>();
  const fallbackSymbolIds = [...params.fallbackSymbolIds];
  if (fallbackSymbolIds.length === 0) return [];

  const rows = await readLegacyFallbackEdges(
    params.conn,
    params.repoId,
    fallbackSymbolIds,
  );
  for (const row of rows) {
    if (
      !params.availableSymbolIds.has(row.fromSymbolId) ||
      !params.availableSymbolIds.has(row.toSymbolId)
    ) {
      continue;
    }
    const edge = edgeRow(row, params.indexedAt);
    edges.set(edgeKey(edge), edge);
  }

  return [...edges.values()];
}

function symbolRow(row: LegacyFallbackSymbolDbRow, indexedAt: string): SymbolRow {
  return {
    symbolId: row.symbolId,
    repoId: row.repoId,
    fileId: row.fileId,
    kind: row.kind,
    name: row.name,
    exported: row.exported,
    visibility: row.visibility,
    language: canonicalizeLanguageId(row.language, row.relPath),
    rangeStartLine: row.rangeStartLine,
    rangeStartCol: row.rangeStartCol,
    rangeEndLine: row.rangeEndLine,
    rangeEndCol: row.rangeEndCol,
    astFingerprint: row.astFingerprint,
    signatureJson: row.signatureJson,
    summary: row.summary,
    invariantsJson: row.invariantsJson,
    sideEffectsJson: row.sideEffectsJson,
    summaryQuality:
      row.summaryQuality == null
        ? undefined
        : row.summaryQuality,
    summarySource: row.summarySource ?? undefined,
    roleTagsJson: row.roleTagsJson,
    searchText: row.searchText,
    external: row.external || undefined,
    source: row.source,
    packageName: row.packageName,
    packageVersion: row.packageVersion,
    scipSymbol: row.scipSymbol,
    symbolStatus: symbolStatus(row.symbolStatus),
    placeholderKind: row.placeholderKind,
    placeholderTarget: row.placeholderTarget,
    updatedAt: row.updatedAt ?? indexedAt,
  };
}

function edgeRow(row: LegacyFallbackEdgeDbRow, indexedAt: string): EdgeRow {
  return {
    repoId: row.repoId,
    fromSymbolId: row.fromSymbolId,
    toSymbolId: row.toSymbolId,
    edgeType: row.edgeType ?? "call",
    weight: row.weight,
    confidence: row.confidence,
    resolution: row.resolution ?? "heuristic",
    resolverId: row.resolverId ?? undefined,
    resolutionPhase: row.resolutionPhase ?? undefined,
    provenance: row.provenance,
    createdAt: row.createdAt ?? indexedAt,
  };
}

function symbolStatus(value: string | null): SymbolRow["symbolStatus"] {
  if (value === "external" || value === "unresolved" || value === "real") {
    return value;
  }
  return "real";
}

function edgeKey(edge: EdgeRow): string {
  return [
    edge.fromSymbolId,
    edge.toSymbolId,
    edge.edgeType,
    edge.resolverId ?? "",
  ].join("\u0000");
}

function emptyGraphRows(): ProviderFirstGraphRows {
  return {
    files: [],
    symbols: [],
    externalSymbols: [],
    edges: [],
    changedFileIds: new Set(),
  };
}
