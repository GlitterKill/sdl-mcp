import type { Connection } from "kuzu";

import { IndexError } from "../domain/errors.js";
import { resolveLadybugWriteChunkSize } from "./ladybug-batching.js";
import { LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT } from "./ladybug-symbols.js";
import {
  exec,
  execDdl,
  queryAll,
  querySingle,
  toBoolean,
  toNumber,
  withTransaction,
} from "./ladybug-core.js";
import { normalizePath } from "../util/paths.js";

const PROVIDER_FIRST_DELETE_SYMBOL_FILE_CHUNK_SIZE = 256;

/** Collect the exact persisted Symbol rows a provider replacement would retire. */
async function collectProviderReplacementSymbolIds(
  conn: Connection,
  repoId: string,
  fileIds: readonly string[],
  incomingSymbolIds: readonly string[],
): Promise<string[]> {
  // Symbol fan-out is much larger than file fan-out, so deliberately keep the
  // discovery chunks below the generic write size.
  const fileChunkSize = Math.min(
    resolveLadybugWriteChunkSize("files"),
    PROVIDER_FIRST_DELETE_SYMBOL_FILE_CHUNK_SIZE,
  );
  const symbolIds = new Set<string>();
  for (let i = 0; i < fileIds.length; i += fileChunkSize) {
    const chunk = fileIds.slice(i, i + fileChunkSize);
    const rows = await queryAll<{ symbolId: string }>(
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
    resolveLadybugWriteChunkSize("symbols"),
    PROVIDER_FIRST_DELETE_SYMBOL_FILE_CHUNK_SIZE * 4,
  );
  for (let i = 0; i < uniqueIncomingSymbolIds.length; i += symbolChunkSize) {
    const chunk = uniqueIncomingSymbolIds.slice(i, i + symbolChunkSize);
    const rows = await queryAll<{ symbolId: string }>(
      conn,
      `MATCH (s:Symbol {repoId: $repoId})
       WHERE s.symbolId IN $symbolIds
       RETURN s.symbolId AS symbolId`,
      { repoId, symbolIds: chunk },
    );
    for (const row of rows) symbolIds.add(row.symbolId);
  }

  return [...symbolIds];
}

export async function countProviderReplacementSymbols(
  conn: Connection,
  repoId: string,
  fileIds: readonly string[],
  incomingSymbolIds: readonly string[],
): Promise<number> {
  return (
    await collectProviderReplacementSymbolIds(
      conn,
      repoId,
      fileIds,
      incomingSymbolIds,
    )
  ).length;
}

/** Retire provider-owned symbols and every graph row that depends on them. */
export async function deleteProviderReplacementSymbols(
  conn: Connection,
  repoId: string,
  fileIds: readonly string[],
  incomingSymbolIds: readonly string[],
): Promise<void> {
  const uniqueSymbolIds = await collectProviderReplacementSymbolIds(
    conn,
    repoId,
    fileIds,
    incomingSymbolIds,
  );
  if (uniqueSymbolIds.length > LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT) {
    throw new IndexError(
      `Provider Symbol replacement would retire ${uniqueSymbolIds.length} rows, exceeding the LadybugDB safety limit of ${LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT}. A fresh database rebuild is required.`,
    );
  }
  const symbolChunkSize = Math.min(
    resolveLadybugWriteChunkSize("symbols"),
    PROVIDER_FIRST_DELETE_SYMBOL_FILE_CHUNK_SIZE * 4,
  );
  for (let i = 0; i < uniqueSymbolIds.length; i += symbolChunkSize) {
    const chunk = uniqueSymbolIds.slice(i, i + symbolChunkSize);
    const fileCleanupIds = i === 0 ? [...fileIds] : [];
    await withTransaction(conn, async (txConn) => {
      await retireProviderSymbolsByIds(txConn, repoId, chunk, fileCleanupIds);
    });
  }
}

async function retireProviderSymbolsByIds(
  conn: Connection,
  repoId: string,
  symbolIds: string[],
  fileIds: string[],
): Promise<void> {
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
    [`MATCH (m:Metrics) WHERE m.symbolId IN $symbolIds DELETE m`, { symbolIds }],
    [
      `MATCH (e:SymbolEmbedding) WHERE e.symbolId IN $symbolIds DELETE e`,
      { symbolIds },
    ],
    [
      `MATCH (sc:SummaryCache) WHERE sc.symbolId IN $symbolIds DELETE sc`,
      { symbolIds },
    ],
    [
      `MATCH (sr:SymbolReference) WHERE sr.fileId IN $fileIds DELETE sr`,
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
    await exec(conn, query, params);
  }
}

const LEGACY_FALLBACK_READ_CHUNK_SIZE = 1_000;

export interface LegacyFallbackFileDbRow {
  fileId: string;
  relPath: string;
  contentHash: string;
  language: string;
  byteSize: number;
  lastIndexedAt: string | null;
}

export interface LegacyFallbackSymbolDbRow {
  symbolId: string;
  repoId: string;
  fileId: string;
  relPath: string;
  kind: string;
  name: string;
  exported: boolean;
  visibility: string | null;
  language: string;
  rangeStartLine: number;
  rangeStartCol: number;
  rangeEndLine: number;
  rangeEndCol: number;
  astFingerprint: string;
  signatureJson: string | null;
  summary: string | null;
  invariantsJson: string | null;
  sideEffectsJson: string | null;
  summaryQuality?: number;
  summarySource: string | null;
  roleTagsJson: string | null;
  searchText: string | null;
  external: boolean;
  source: string | null;
  packageName: string | null;
  packageVersion: string | null;
  scipSymbol: string | null;
  symbolStatus: string | null;
  placeholderKind: string | null;
  placeholderTarget: string | null;
  updatedAt: string | null;
}

export interface LegacyFallbackEdgeDbRow {
  repoId: string;
  fromSymbolId: string;
  toSymbolId: string;
  edgeType: string | null;
  weight: number;
  confidence: number;
  resolution: string | null;
  resolverId: string | null;
  resolutionPhase: string | null;
  provenance: string | null;
  createdAt: string | null;
}

export async function readLegacyFallbackFiles(
  conn: Connection,
  repoId: string,
  relPaths: readonly string[],
): Promise<LegacyFallbackFileDbRow[]> {
  const files: LegacyFallbackFileDbRow[] = [];
  for (const paths of chunks(relPaths, LEGACY_FALLBACK_READ_CHUNK_SIZE)) {
    const rows = await queryAll<{
      fileId: string;
      relPath: string;
      contentHash: string;
      language: string;
      byteSize: unknown;
      lastIndexedAt: string | null;
    }>(
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
      { repoId, relPaths: paths.map(normalizePath) },
    );
    files.push(
      ...rows.map((row) => ({
        ...row,
        relPath: normalizePath(row.relPath),
        byteSize: toNumber(row.byteSize),
      })),
    );
  }
  return files;
}

export async function readLegacyFallbackSymbols(
  conn: Connection,
  repoId: string,
  fileIds: readonly string[],
): Promise<LegacyFallbackSymbolDbRow[]> {
  const symbols: LegacyFallbackSymbolDbRow[] = [];
  for (const ids of chunks(fileIds, LEGACY_FALLBACK_READ_CHUNK_SIZE)) {
    const rows = await queryAll<{
      symbolId: string; repoId: string; fileId: string; relPath: string;
      kind: string; name: string; exported: unknown; visibility: string | null;
      language: string; rangeStartLine: unknown; rangeStartCol: unknown;
      rangeEndLine: unknown; rangeEndCol: unknown; astFingerprint: string;
      signatureJson: string | null; summary: string | null;
      invariantsJson: string | null; sideEffectsJson: string | null;
      summaryQuality: unknown; summarySource: string | null;
      roleTagsJson: string | null; searchText: string | null; external: unknown;
      source: string | null; packageName: string | null; packageVersion: string | null;
      scipSymbol: string | null; symbolStatus: string | null;
      placeholderKind: string | null; placeholderTarget: string | null;
      updatedAt: string | null;
    }>(
      conn,
      `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
       WHERE f.fileId IN $fileIds
       RETURN s.symbolId AS symbolId, r.repoId AS repoId, f.fileId AS fileId,
              f.relPath AS relPath, s.kind AS kind, s.name AS name,
              s.exported AS exported, s.visibility AS visibility, s.language AS language,
              s.rangeStartLine AS rangeStartLine, s.rangeStartCol AS rangeStartCol,
              s.rangeEndLine AS rangeEndLine, s.rangeEndCol AS rangeEndCol,
              s.astFingerprint AS astFingerprint, s.signatureJson AS signatureJson,
              s.summary AS summary, s.invariantsJson AS invariantsJson,
              s.sideEffectsJson AS sideEffectsJson, s.summaryQuality AS summaryQuality,
              s.summarySource AS summarySource, s.roleTagsJson AS roleTagsJson,
              s.searchText AS searchText, coalesce(s.external, false) AS external,
              s.source AS source, s.packageName AS packageName,
              s.packageVersion AS packageVersion, s.scipSymbol AS scipSymbol,
              coalesce(s.symbolStatus, 'real') AS symbolStatus,
              s.placeholderKind AS placeholderKind,
              s.placeholderTarget AS placeholderTarget, s.updatedAt AS updatedAt
       ORDER BY f.relPath, s.rangeStartLine, s.rangeStartCol, s.name`,
      { repoId, fileIds: ids },
    );
    symbols.push(
      ...rows.map((row) => ({
        ...row,
        relPath: normalizePath(row.relPath),
        exported: toBoolean(row.exported),
        rangeStartLine: toNumber(row.rangeStartLine),
        rangeStartCol: toNumber(row.rangeStartCol),
        rangeEndLine: toNumber(row.rangeEndLine),
        rangeEndCol: toNumber(row.rangeEndCol),
        summaryQuality:
          row.summaryQuality == null ? undefined : toNumber(row.summaryQuality),
        external: toBoolean(row.external),
      })),
    );
  }
  return symbols;
}

export async function readLegacyFallbackEdges(
  conn: Connection,
  repoId: string,
  symbolIds: readonly string[],
): Promise<LegacyFallbackEdgeDbRow[]> {
  const edges: LegacyFallbackEdgeDbRow[] = [];
  for (const ids of chunks(symbolIds, LEGACY_FALLBACK_READ_CHUNK_SIZE)) {
    const rows = await queryAll<{
      repoId: string; fromSymbolId: string; toSymbolId: string;
      edgeType: string | null; weight: unknown; confidence: unknown;
      resolution: string | null; resolverId: string | null;
      resolutionPhase: string | null; provenance: string | null; createdAt: string | null;
    }>(
      conn,
      `MATCH (from:Symbol)-[d:DEPENDS_ON]->(to:Symbol)
       WHERE from.repoId = $repoId AND to.repoId = $repoId
         AND (from.symbolId IN $symbolIds OR to.symbolId IN $symbolIds)
       RETURN from.repoId AS repoId, from.symbolId AS fromSymbolId,
              to.symbolId AS toSymbolId, d.edgeType AS edgeType,
              d.weight AS weight, d.confidence AS confidence,
              d.resolution AS resolution, d.resolverId AS resolverId,
              d.resolutionPhase AS resolutionPhase, d.provenance AS provenance,
              d.createdAt AS createdAt`,
      { repoId, symbolIds: ids },
    );
    edges.push(
      ...rows.map((row) => ({
        ...row,
        weight: row.weight == null ? 1 : toNumber(row.weight),
        confidence: row.confidence == null ? 1 : toNumber(row.confidence),
      })),
    );
  }
  return edges;
}

function chunks<T>(items: readonly T[], chunkSize: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    result.push(items.slice(i, i + chunkSize));
  }
  return result;
}

export interface ProviderFirstShadowDbCounts {
  repos: number;
  files: number;
  symbols: number;
  fileInRepo: number;
  symbolInFile: number;
  symbolInRepo: number;
  edges: number;
}

export interface ProviderFirstCopyArtifact {
  path: string;
  targetTable: string;
}

export async function copyProviderFirstArtifact(
  conn: Connection,
  tableName: string,
  artifact: ProviderFirstCopyArtifact,
  nullSentinel: string,
): Promise<void> {
  if (artifact.targetTable !== tableName) {
    throw new Error(
      `Provider-first shadow artifact target mismatch: expected ${tableName}, got ${artifact.targetTable}`,
    );
  }
  const path = normalizePath(artifact.path).replace(/'/g, "''");
  const escapedNull = nullSentinel.replace(/\\/g, "\\\\").replace(/'/g, "''");
  await execDdl(
    conn,
    `COPY ${tableName} FROM '${path}' ` +
      `(HEADER=true, PARALLEL=FALSE, QUOTE='"', NULL_STRINGS=['${escapedNull}'])`,
  );
}

export async function readProviderFirstShadowDbCounts(
  conn: Connection,
): Promise<ProviderFirstShadowDbCounts> {
  return {
    repos: await countRows(conn, "MATCH (r:Repo) RETURN count(r) AS count"),
    files: await countRows(conn, "MATCH (f:File) RETURN count(f) AS count"),
    symbols: await countRows(conn, "MATCH (s:Symbol) RETURN count(s) AS count"),
    fileInRepo: await countRows(
      conn,
      "MATCH (:File)-[r:FILE_IN_REPO]->(:Repo) RETURN count(r) AS count",
    ),
    symbolInFile: await countRows(
      conn,
      "MATCH (:Symbol)-[r:SYMBOL_IN_FILE]->(:File) RETURN count(r) AS count",
    ),
    symbolInRepo: await countRows(
      conn,
      "MATCH (:Symbol)-[r:SYMBOL_IN_REPO]->(:Repo) RETURN count(r) AS count",
    ),
    edges: await countRows(
      conn,
      "MATCH (:Symbol)-[r:DEPENDS_ON]->(:Symbol) RETURN count(r) AS count",
    ),
  };
}

async function countRows(conn: Connection, statement: string): Promise<number> {
  const row = await querySingle<{ count: unknown }>(conn, statement);
  return toNumber(row?.count ?? 0);
}
