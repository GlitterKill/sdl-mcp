import type { Connection } from "kuzu";

import { queryAll, querySingle, toBoolean, toNumber } from "./ladybug-core.js";
import type { SymbolStatus } from "./symbol-placeholders.js";

export interface PersistedGraphIntegritySymbolRow {
  symbolId: string;
  fileId: string;
  relPath: string;
  name: string;
  kind: string;
  language: string;
  rangeStartLine: number;
  rangeStartCol: number;
  rangeEndLine: number;
  rangeEndCol: number;
  signatureJson: string | null;
  source: string | null;
  scipSymbol: string | null;
  astFingerprint: string | null;
  symbolStatus: SymbolStatus | null;
  external: boolean;
  placeholderKind: string | null;
  placeholderTarget: string | null;
}

export interface GraphIntegritySymbolCursor {
  relPath: string;
  fileId: string;
  symbolId: string;
}

export interface PersistedGraphIntegrityReferenceCount {
  symbolId: string;
  edgeType: string;
  referenceCount: number;
}

export interface PersistedGraphIntegrityReferenceCountCursor {
  symbolId: string;
  edgeType: string;
}

export interface PersistedGraphIntegrityFileReferenceCount
  extends PersistedGraphIntegrityReferenceCount {
  fileId: string;
}

export interface PersistedGraphIntegritySourceReferenceCount
  extends PersistedGraphIntegrityReferenceCount {
  sourceSymbolId: string;
}

/**
 * Conservatively count symbols outside or shared with the repository being
 * verified. Shared nodes can leave the target membership during cleanup, so
 * counting them on both sides may disable pruning but can never make a large
 * physical Symbol table look safe to mutate.
 */
export async function getPersistedGraphIntegrityOtherRepoSymbolCount(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const outsideRow = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (s:Symbol)
     WHERE NOT (s)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
     RETURN count(s) AS count`,
    { repoId },
  );
  const sharedRow = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[:SYMBOL_IN_REPO]->(other:Repo)
     WHERE other.repoId <> $repoId
     RETURN count(DISTINCT s) AS count`,
    { repoId },
  );
  return toNumber(outsideRow?.count ?? 0) + toNumber(sharedRow?.count ?? 0);
}

interface RawPersistedGraphIntegritySymbolRow extends Omit<
  PersistedGraphIntegritySymbolRow,
  | "rangeStartLine"
  | "rangeStartCol"
  | "rangeEndLine"
  | "rangeEndCol"
  | "external"
> {
  rangeStartLine: unknown;
  rangeStartCol: unknown;
  rangeEndLine: unknown;
  rangeEndCol: unknown;
  external: unknown;
}

/** Read one stable keyset page for the post-index integrity digest. */
export async function getPersistedGraphIntegritySymbolPage(
  conn: Connection,
  params: {
    repoId: string;
    after?: GraphIntegritySymbolCursor;
    limit: number;
  },
): Promise<PersistedGraphIntegritySymbolRow[]> {
  const hasCursor = params.after !== undefined;
  const rows = await queryAll<RawPersistedGraphIntegritySymbolRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]->(f:File)-[:FILE_IN_REPO]->(r)
     WITH s, coalesce(f.fileId, '') AS fileId, coalesce(f.relPath, '') AS relPath
     WHERE true
     ${
       hasCursor
         ? `AND (
              relPath > $afterRelPath OR
              (relPath = $afterRelPath AND fileId > $afterFileId) OR
              (relPath = $afterRelPath AND fileId = $afterFileId AND s.symbolId > $afterSymbolId)
            )`
         : ""
     }
     RETURN s.symbolId AS symbolId,
            fileId,
            relPath,
            s.name AS name,
            s.kind AS kind,
            s.language AS language,
            s.rangeStartLine AS rangeStartLine,
            s.rangeStartCol AS rangeStartCol,
            s.rangeEndLine AS rangeEndLine,
            s.rangeEndCol AS rangeEndCol,
            s.signatureJson AS signatureJson,
            s.source AS source,
            s.scipSymbol AS scipSymbol,
            s.astFingerprint AS astFingerprint,
            s.symbolStatus AS symbolStatus,
            s.external AS external,
            s.placeholderKind AS placeholderKind,
            s.placeholderTarget AS placeholderTarget
     ORDER BY relPath ASC, fileId ASC, s.symbolId ASC
     LIMIT $limit`,
    {
      repoId: params.repoId,
      afterRelPath: params.after?.relPath ?? "",
      afterFileId: params.after?.fileId ?? "",
      afterSymbolId: params.after?.symbolId ?? "",
      limit: params.limit,
    },
  );
  return rows.map((row) => ({
    ...row,
    rangeStartLine: toNumber(row.rangeStartLine),
    rangeStartCol: toNumber(row.rangeStartCol),
    rangeEndLine: toNumber(row.rangeEndLine),
    rangeEndCol: toNumber(row.rangeEndCol),
    external: toBoolean(row.external),
  }));
}

interface RawPersistedGraphIntegrityReferenceCount
  extends Omit<PersistedGraphIntegrityReferenceCount, "referenceCount"> {
  referenceCount: unknown;
}

interface RawPersistedGraphIntegrityFileReferenceCount
  extends Omit<PersistedGraphIntegrityFileReferenceCount, "referenceCount"> {
  referenceCount: unknown;
}

interface RawPersistedGraphIntegritySourceReferenceCount
  extends Omit<PersistedGraphIntegritySourceReferenceCount, "referenceCount"> {
  referenceCount: unknown;
}

/**
 * Read one aggregate keyset page of incoming references that keep fileless
 * symbols live. File-backed sources are the only shape emitted by indexers;
 * an explicit source-shape probe below disables pruning if a legacy graph
 * contains a fileless source.
 */
export async function getPersistedGraphIntegrityReferenceCountPage(
  conn: Connection,
  params: {
    repoId: string;
    after?: PersistedGraphIntegrityReferenceCountCursor;
    limit: number;
  },
): Promise<PersistedGraphIntegrityReferenceCount[]> {
  const hasCursor = params.after !== undefined;
  // The source MATCH below proves `a` is file-backed. File-backed symbols have
  // repository-unique IDs and a canonical repoId, unlike the shared fileless
  // target `b`. Filtering that source property also avoids a LadybugDB 0.18.1
  // native failure on the equivalent cyclic repository-relationship aggregate.
  const rows = await queryAll<RawPersistedGraphIntegrityReferenceCount>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(b:Symbol)
     MATCH (a:Symbol)-[d:DEPENDS_ON]->(b)
     MATCH (a)-[:SYMBOL_IN_FILE]->(:File)
     WHERE a.repoId = $repoId
       AND NOT (b)-[:SYMBOL_IN_FILE]->(:File)
     WITH b.symbolId AS symbolId,
          coalesce(d.edgeType, '') AS edgeType,
          count(*) AS referenceCount
     WHERE true
     ${
       hasCursor
         ? `AND (
              symbolId > $afterSymbolId OR
              (symbolId = $afterSymbolId AND edgeType > $afterEdgeType)
            )`
         : ""
     }
     RETURN symbolId, edgeType, referenceCount
     ORDER BY symbolId ASC, edgeType ASC
     LIMIT $limit`,
    {
      repoId: params.repoId,
      afterSymbolId: params.after?.symbolId ?? "",
      afterEdgeType: params.after?.edgeType ?? "",
      limit: params.limit,
    },
  );
  return rows.map((row) => ({
    ...row,
    referenceCount: toNumber(row.referenceCount),
  }));
}

/** Aggregate baseline contributions made by files that this run will replace. */
export async function getPersistedGraphIntegrityFileReferenceCounts(
  conn: Connection,
  repoId: string,
  fileIds: readonly string[],
): Promise<PersistedGraphIntegrityFileReferenceCount[]> {
  if (fileIds.length === 0) return [];
  const rows = await queryAll<RawPersistedGraphIntegrityFileReferenceCount>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)-[:SYMBOL_IN_REPO]->(r)
     MATCH (a)-[:SYMBOL_IN_FILE]->(f:File)
     WHERE f.fileId IN $fileIds
       AND NOT (b)-[:SYMBOL_IN_FILE]->(:File)
     RETURN f.fileId AS fileId,
            b.symbolId AS symbolId,
            coalesce(d.edgeType, '') AS edgeType,
            count(*) AS referenceCount
     ORDER BY fileId ASC, symbolId ASC, edgeType ASC`,
    { repoId, fileIds },
  );
  return rows.map((row) => ({
    ...row,
    referenceCount: toNumber(row.referenceCount),
  }));
}

/** Read exact pre-write liveness for pass-2 sources that were not reindexed. */
export async function getPersistedGraphIntegritySourceReferenceCounts(
  conn: Connection,
  repoId: string,
  sourceSymbolIds: readonly string[],
  edgeType: string,
): Promise<PersistedGraphIntegritySourceReferenceCount[]> {
  if (sourceSymbolIds.length === 0) return [];
  const rows = await queryAll<RawPersistedGraphIntegritySourceReferenceCount>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)-[:SYMBOL_IN_REPO]->(r)
     WHERE a.symbolId IN $sourceSymbolIds
       AND coalesce(d.edgeType, '') = $edgeType
       AND NOT (b)-[:SYMBOL_IN_FILE]->(:File)
     RETURN a.symbolId AS sourceSymbolId,
            b.symbolId AS symbolId,
            coalesce(d.edgeType, '') AS edgeType,
            count(*) AS referenceCount
     ORDER BY sourceSymbolId ASC, symbolId ASC, edgeType ASC`,
    { repoId, sourceSymbolIds, edgeType },
  );
  return rows.map((row) => ({
    ...row,
    referenceCount: toNumber(row.referenceCount),
  }));
}

/** Fileless sources are outside the compact liveness model; retain on sight. */
export async function hasPersistedGraphIntegrityFilelessSourceReferences(
  conn: Connection,
  repoId: string,
): Promise<boolean> {
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(b:Symbol)
     MATCH (a:Symbol)-[d:DEPENDS_ON]->(b)
     WHERE NOT (a)-[:SYMBOL_IN_FILE]->(:File)
     RETURN count(d) AS count`,
    { repoId },
  );
  return toNumber(row?.count ?? 0) > 0;
}
