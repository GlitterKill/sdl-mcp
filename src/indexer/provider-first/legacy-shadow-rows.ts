import type { Connection } from "kuzu";

import type {
  EdgeRow,
  FileRow,
  SymbolRow,
} from "../../db/ladybug-queries.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { normalizePath } from "../../util/paths.js";
import type { ProviderFirstGraphRows } from "./materializer.js";

interface CollectLegacyFallbackShadowRowsParams {
  conn: Connection;
  repoId: string;
  relPaths: Iterable<string>;
  providerRows: ProviderFirstGraphRows;
}

interface FileQueryRow {
  fileId: string;
  relPath: string;
  contentHash: string;
  language: string;
  byteSize: unknown;
  lastIndexedAt: string | null;
}

interface SymbolQueryRow {
  symbolId: string;
  repoId: string;
  fileId: string;
  kind: string;
  name: string;
  exported: unknown;
  visibility: string | null;
  language: string;
  rangeStartLine: unknown;
  rangeStartCol: unknown;
  rangeEndLine: unknown;
  rangeEndCol: unknown;
  astFingerprint: string;
  signatureJson: string | null;
  summary: string | null;
  invariantsJson: string | null;
  sideEffectsJson: string | null;
  summaryQuality: unknown;
  summarySource: string | null;
  roleTagsJson: string | null;
  searchText: string | null;
  external: unknown;
  source: string | null;
  packageName: string | null;
  packageVersion: string | null;
  scipSymbol: string | null;
  symbolStatus: string | null;
  placeholderKind: string | null;
  placeholderTarget: string | null;
  updatedAt: string | null;
}

interface EdgeQueryRow {
  repoId: string;
  fromSymbolId: string;
  toSymbolId: string;
  edgeType: string | null;
  weight: unknown;
  confidence: unknown;
  resolution: string | null;
  resolverId: string | null;
  resolutionPhase: string | null;
  provenance: string | null;
  createdAt: string | null;
}

const READ_CHUNK_SIZE = 1_000;

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
  const files: Array<Omit<FileRow, "directory">> = [];
  for (const chunk of chunks(relPaths)) {
    const rows = await ladybugDb.queryAll<FileQueryRow>(
      conn,
      `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
       WHERE f.relPath IN $relPaths
       RETURN f.fileId AS fileId,
              f.relPath AS relPath,
              f.contentHash AS contentHash,
              f.language AS language,
              f.byteSize AS byteSize,
              f.lastIndexedAt AS lastIndexedAt
       ORDER BY f.relPath`,
      { repoId, relPaths: chunk },
    );
    files.push(
      ...rows.map((row) => ({
        fileId: row.fileId,
        repoId,
        relPath: normalizePath(row.relPath),
        contentHash: row.contentHash,
        language: row.language,
        byteSize: ladybugDb.toNumber(row.byteSize),
        lastIndexedAt: row.lastIndexedAt ?? null,
      })),
    );
  }
  return files;
}

async function collectSymbols(
  conn: Connection,
  repoId: string,
  fileIds: readonly string[],
  indexedAt: string,
): Promise<SymbolRow[]> {
  const symbols: SymbolRow[] = [];
  for (const chunk of chunks(fileIds)) {
    const rows = await ladybugDb.queryAll<SymbolQueryRow>(
      conn,
      `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
       WHERE f.fileId IN $fileIds
       RETURN s.symbolId AS symbolId,
              r.repoId AS repoId,
              f.fileId AS fileId,
              s.kind AS kind,
              s.name AS name,
              s.exported AS exported,
              s.visibility AS visibility,
              s.language AS language,
              s.rangeStartLine AS rangeStartLine,
              s.rangeStartCol AS rangeStartCol,
              s.rangeEndLine AS rangeEndLine,
              s.rangeEndCol AS rangeEndCol,
              s.astFingerprint AS astFingerprint,
              s.signatureJson AS signatureJson,
              s.summary AS summary,
              s.invariantsJson AS invariantsJson,
              s.sideEffectsJson AS sideEffectsJson,
              s.summaryQuality AS summaryQuality,
              s.summarySource AS summarySource,
              s.roleTagsJson AS roleTagsJson,
              s.searchText AS searchText,
              coalesce(s.external, false) AS external,
              s.source AS source,
              s.packageName AS packageName,
              s.packageVersion AS packageVersion,
              s.scipSymbol AS scipSymbol,
              coalesce(s.symbolStatus, 'real') AS symbolStatus,
              s.placeholderKind AS placeholderKind,
              s.placeholderTarget AS placeholderTarget,
              s.updatedAt AS updatedAt
       ORDER BY f.relPath, s.rangeStartLine, s.rangeStartCol, s.name`,
      { repoId, fileIds: chunk },
    );
    symbols.push(...rows.map((row) => symbolRow(row, indexedAt)));
  }
  return symbols;
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

  for (const chunk of chunks(fallbackSymbolIds)) {
    const rows = await ladybugDb.queryAll<EdgeQueryRow>(
      params.conn,
      `MATCH (from:Symbol)-[d:DEPENDS_ON]->(to:Symbol)
       WHERE from.repoId = $repoId
         AND to.repoId = $repoId
         AND (from.symbolId IN $symbolIds OR to.symbolId IN $symbolIds)
       RETURN from.repoId AS repoId,
              from.symbolId AS fromSymbolId,
              to.symbolId AS toSymbolId,
              d.edgeType AS edgeType,
              d.weight AS weight,
              d.confidence AS confidence,
              d.resolution AS resolution,
              d.resolverId AS resolverId,
              d.resolutionPhase AS resolutionPhase,
              d.provenance AS provenance,
              d.createdAt AS createdAt`,
      { repoId: params.repoId, symbolIds: chunk },
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
  }

  return [...edges.values()];
}

function symbolRow(row: SymbolQueryRow, indexedAt: string): SymbolRow {
  return {
    symbolId: row.symbolId,
    repoId: row.repoId,
    fileId: row.fileId,
    kind: row.kind,
    name: row.name,
    exported: ladybugDb.toBoolean(row.exported),
    visibility: row.visibility,
    language: row.language,
    rangeStartLine: ladybugDb.toNumber(row.rangeStartLine),
    rangeStartCol: ladybugDb.toNumber(row.rangeStartCol),
    rangeEndLine: ladybugDb.toNumber(row.rangeEndLine),
    rangeEndCol: ladybugDb.toNumber(row.rangeEndCol),
    astFingerprint: row.astFingerprint,
    signatureJson: row.signatureJson,
    summary: row.summary,
    invariantsJson: row.invariantsJson,
    sideEffectsJson: row.sideEffectsJson,
    summaryQuality:
      row.summaryQuality == null
        ? undefined
        : ladybugDb.toNumber(row.summaryQuality),
    summarySource: row.summarySource ?? undefined,
    roleTagsJson: row.roleTagsJson,
    searchText: row.searchText,
    external: ladybugDb.toBoolean(row.external) || undefined,
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

function edgeRow(row: EdgeQueryRow, indexedAt: string): EdgeRow {
  return {
    repoId: row.repoId,
    fromSymbolId: row.fromSymbolId,
    toSymbolId: row.toSymbolId,
    edgeType: row.edgeType ?? "call",
    weight: row.weight == null ? 1.0 : ladybugDb.toNumber(row.weight),
    confidence:
      row.confidence == null ? 1.0 : ladybugDb.toNumber(row.confidence),
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

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += READ_CHUNK_SIZE) {
    result.push(items.slice(i, i + READ_CHUNK_SIZE));
  }
  return result;
}
