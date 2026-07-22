import type { Connection } from "kuzu";

import { DatabaseError } from "../domain/errors.js";
import {
  exec,
  queryAll,
  querySingle,
  toBoolean,
  toNumber,
} from "./ladybug-core.js";
import type { SymbolStatus } from "./symbol-placeholders.js";

const GRAPH_INTEGRITY_MANIFEST_BATCH_SIZE = 256;

/** Marker for deterministic persisted-manifest corruption. */
export class GraphIntegrityManifestValidationError extends DatabaseError {}

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
  extends Omit<PersistedGraphIntegrityReferenceCount, "symbolId"> {
  sourceSymbolId: string;
  fileId: string;
  symbolId: string | null;
}

export interface GraphIntegrityFileStateRecord {
  stateId: string;
  repoId: string;
  fileId: string;
  relPath: string;
  symbolCount: number;
  digest: string;
  filelessReferencesJson: string;
}

export interface GraphIntegrityFilelessStateRecord {
  stateId: string;
  repoId: string;
  symbolId: string;
  canonicalSymbolJson: string;
  referenceCount: number;
}

export interface GraphIntegrityManifest {
  files: readonly GraphIntegrityFileStateRecord[];
  fileless: readonly GraphIntegrityFilelessStateRecord[];
}

export interface GraphIntegrityFilelessDelta {
  upserts: readonly GraphIntegrityFilelessStateRecord[];
  deleteSymbolIds: readonly string[];
}

interface RawGraphIntegrityFileStateRecord
  extends Omit<GraphIntegrityFileStateRecord, "symbolCount"> {
  symbolCount: unknown;
}

interface RawGraphIntegrityFilelessStateRecord
  extends Omit<GraphIntegrityFilelessStateRecord, "referenceCount"> {
  referenceCount: unknown;
}

function graphIntegrityFileStateId(repoId: string, fileId: string): string {
  return JSON.stringify([repoId, fileId]);
}

function graphIntegrityFilelessStateId(
  repoId: string,
  symbolId: string,
): string {
  return JSON.stringify([repoId, symbolId]);
}

function assertFileStateIdentity(row: GraphIntegrityFileStateRecord): void {
  if (row.stateId !== graphIntegrityFileStateId(row.repoId, row.fileId)) {
    throw new GraphIntegrityManifestValidationError(
      "Graph integrity file state identity is inconsistent",
    );
  }
}

function assertFilelessStateIdentity(
  row: GraphIntegrityFilelessStateRecord,
): void {
  if (row.stateId !== graphIntegrityFilelessStateId(row.repoId, row.symbolId)) {
    throw new GraphIntegrityManifestValidationError(
      "Graph integrity fileless state identity is inconsistent",
    );
  }
}

function mapFileState(
  row: RawGraphIntegrityFileStateRecord,
): GraphIntegrityFileStateRecord {
  const mapped = { ...row, symbolCount: toNumber(row.symbolCount) };
  assertFileStateIdentity(mapped);
  return mapped;
}

function mapFilelessState(
  row: RawGraphIntegrityFilelessStateRecord,
): GraphIntegrityFilelessStateRecord {
  const mapped = { ...row, referenceCount: toNumber(row.referenceCount) };
  assertFilelessStateIdentity(mapped);
  return mapped;
}

export async function getGraphIntegrityFileState(
  conn: Connection,
  repoId: string,
  fileId: string,
): Promise<GraphIntegrityFileStateRecord | null> {
  const row = await querySingle<RawGraphIntegrityFileStateRecord>(
    conn,
    `MATCH (f:GraphIntegrityFileState {stateId: $stateId})
     MATCH (f)-[:GRAPH_INTEGRITY_FILE_STATE_IN_REPO]->(:Repo {repoId: $repoId})
     WHERE f.repoId = $repoId AND f.fileId = $fileId
     RETURN f.stateId AS stateId, f.repoId AS repoId, f.fileId AS fileId,
            f.relPath AS relPath, f.symbolCount AS symbolCount,
            f.digest AS digest, f.filelessReferencesJson AS filelessReferencesJson`,
    { stateId: graphIntegrityFileStateId(repoId, fileId), repoId, fileId },
  );
  return row ? mapFileState(row) : null;
}

/** Return whether the repository has any persisted manifest row. */
export async function upsertGraphIntegrityFileStateInTransaction(
  conn: Connection,
  row: GraphIntegrityFileStateRecord,
): Promise<void> {
  assertFileStateIdentity(row);
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (f:GraphIntegrityFileState {stateId: $stateId})
     SET f.repoId = $repoId, f.fileId = $fileId, f.relPath = $relPath,
         f.symbolCount = $symbolCount, f.digest = $digest,
         f.filelessReferencesJson = $filelessReferencesJson
     MERGE (f)-[:GRAPH_INTEGRITY_FILE_STATE_IN_REPO]->(r)`,
    { ...row },
  );
}

export async function deleteGraphIntegrityFileStateInTransaction(
  conn: Connection,
  repoId: string,
  fileId: string,
): Promise<void> {
  const params = {
    stateId: graphIntegrityFileStateId(repoId, fileId),
    repoId,
    fileId,
  };
  await exec(
    conn,
    `MATCH (f:GraphIntegrityFileState {stateId: $stateId})-[rel:GRAPH_INTEGRITY_FILE_STATE_IN_REPO]->(:Repo {repoId: $repoId})
     WHERE f.repoId = $repoId AND f.fileId = $fileId
     DELETE rel, f`,
    params,
  );
}

export async function listGraphIntegrityFileStates(
  conn: Connection,
  repoId: string,
): Promise<GraphIntegrityFileStateRecord[]> {
  const rows = await queryAll<RawGraphIntegrityFileStateRecord>(
    conn,
    `MATCH (:Repo {repoId: $repoId})<-[:GRAPH_INTEGRITY_FILE_STATE_IN_REPO]-(f:GraphIntegrityFileState)
     WHERE f.repoId = $repoId
     RETURN f.stateId AS stateId, f.repoId AS repoId, f.fileId AS fileId,
            f.relPath AS relPath, f.symbolCount AS symbolCount,
            f.digest AS digest, f.filelessReferencesJson AS filelessReferencesJson
     ORDER BY f.relPath ASC, f.fileId ASC`,
    { repoId },
  );
  return rows.map(mapFileState);
}

export async function upsertGraphIntegrityFilelessStateInTransaction(
  conn: Connection,
  row: GraphIntegrityFilelessStateRecord,
): Promise<void> {
  assertFilelessStateIdentity(row);
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (s:GraphIntegrityFilelessState {stateId: $stateId})
     SET s.repoId = $repoId, s.symbolId = $symbolId,
         s.canonicalSymbolJson = $canonicalSymbolJson,
         s.referenceCount = $referenceCount
     MERGE (s)-[:GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO]->(r)`,
    { ...row },
  );
}

export async function deleteGraphIntegrityFilelessStateInTransaction(
  conn: Connection,
  repoId: string,
  symbolId: string,
): Promise<void> {
  const params = {
    stateId: graphIntegrityFilelessStateId(repoId, symbolId),
    repoId,
    symbolId,
  };
  await exec(
    conn,
    `MATCH (s:GraphIntegrityFilelessState {stateId: $stateId})-[rel:GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO]->(:Repo {repoId: $repoId})
     WHERE s.repoId = $repoId AND s.symbolId = $symbolId
     DELETE rel, s`,
    params,
  );
}

export async function listGraphIntegrityFilelessStates(
  conn: Connection,
  repoId: string,
): Promise<GraphIntegrityFilelessStateRecord[]> {
  const rows = await queryAll<RawGraphIntegrityFilelessStateRecord>(
    conn,
    `MATCH (:Repo {repoId: $repoId})<-[:GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO]-(s:GraphIntegrityFilelessState)
     WHERE s.repoId = $repoId
     RETURN s.stateId AS stateId, s.repoId AS repoId, s.symbolId AS symbolId,
            s.canonicalSymbolJson AS canonicalSymbolJson,
            s.referenceCount AS referenceCount
     ORDER BY s.symbolId ASC`,
    { repoId },
  );
  return rows.map(mapFilelessState);
}

export async function getGraphIntegrityFilelessStates(
  conn: Connection,
  repoId: string,
  symbolIds: readonly string[],
): Promise<GraphIntegrityFilelessStateRecord[]> {
  const uniqueSymbolIds = [...new Set(symbolIds)];
  const states: GraphIntegrityFilelessStateRecord[] = [];
  for (
    let offset = 0;
    offset < uniqueSymbolIds.length;
    offset += GRAPH_INTEGRITY_MANIFEST_BATCH_SIZE
  ) {
    const rows = await queryAll<RawGraphIntegrityFilelessStateRecord>(
      conn,
      `MATCH (:Repo {repoId: $repoId})<-[:GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO]-(s:GraphIntegrityFilelessState)
       WHERE s.repoId = $repoId AND s.symbolId IN $symbolIds
       RETURN s.stateId AS stateId, s.repoId AS repoId, s.symbolId AS symbolId,
              s.canonicalSymbolJson AS canonicalSymbolJson,
              s.referenceCount AS referenceCount
       ORDER BY s.symbolId ASC`,
      {
        repoId,
        symbolIds: uniqueSymbolIds.slice(
          offset,
          offset + GRAPH_INTEGRITY_MANIFEST_BATCH_SIZE,
        ),
      },
    );
    states.push(...rows.map(mapFilelessState));
  }
  return states;
}

export async function ownsGraphIntegrityRevision(
  conn: Connection,
  repoId: string,
  versionId: string,
  revision: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(revision)) {
    throw new DatabaseError("Graph integrity revision must be a safe integer");
  }
  const row = await querySingle<{ repoId: string }>(
    conn,
    `MATCH (d:DerivedState {repoId: $repoId})
     WHERE d.graphIntegrityVersionId = $versionId
       AND d.graphIntegrityRevision = $revision
     RETURN d.repoId AS repoId`,
    { repoId, versionId, revision },
  );
  return row !== null;
}

/** Apply one saved-file manifest delta on the caller-owned graph transaction. */
export async function applyGraphIntegrityFilePatchInTransaction(
  conn: Connection,
  file: GraphIntegrityFileStateRecord,
  fileless: GraphIntegrityFilelessDelta,
): Promise<void> {
  for (const row of fileless.upserts) {
    assertFilelessStateIdentity(row);
    if (row.repoId !== file.repoId) {
      throw new DatabaseError(
        "Graph integrity fileless state belongs to another repository",
      );
    }
  }
  await upsertGraphIntegrityFileStateInTransaction(conn, file);
  for (
    let offset = 0;
    offset < fileless.upserts.length;
    offset += GRAPH_INTEGRITY_MANIFEST_BATCH_SIZE
  ) {
    const rows = fileless.upserts.slice(
      offset,
      offset + GRAPH_INTEGRITY_MANIFEST_BATCH_SIZE,
    );
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (r:Repo {repoId: $repoId})
       MERGE (s:GraphIntegrityFilelessState {stateId: row.stateId})
       SET s.repoId = row.repoId, s.symbolId = row.symbolId,
           s.canonicalSymbolJson = row.canonicalSymbolJson,
           s.referenceCount = row.referenceCount
       MERGE (s)-[:GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO]->(r)`,
      { repoId: file.repoId, rows },
    );
  }
  for (
    let offset = 0;
    offset < fileless.deleteSymbolIds.length;
    offset += GRAPH_INTEGRITY_MANIFEST_BATCH_SIZE
  ) {
    const rows = fileless.deleteSymbolIds
      .slice(offset, offset + GRAPH_INTEGRITY_MANIFEST_BATCH_SIZE)
      .map((symbolId) => ({
        symbolId,
        stateId: graphIntegrityFilelessStateId(file.repoId, symbolId),
      }));
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (s:Symbol {symbolId: row.symbolId})-[rel:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE NOT (s)-[:SYMBOL_IN_FILE]->(:File)-[:FILE_IN_REPO]->(:Repo {repoId: $repoId})
       DELETE rel`,
      { repoId: file.repoId, rows },
    );
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (s:GraphIntegrityFilelessState)-[rel:GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.stateId = row.stateId
         AND s.repoId = $repoId
         AND s.symbolId = row.symbolId
       DELETE rel, s`,
      { repoId: file.repoId, rows },
    );
  }
}

export async function deleteGraphIntegrityManifestInTransaction(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (:Repo {repoId: $repoId})<-[rel:GRAPH_INTEGRITY_FILE_STATE_IN_REPO]-(f:GraphIntegrityFileState)
     WHERE f.repoId = $repoId
     DELETE rel, f`,
    { repoId },
  );
  await exec(
    conn,
    `MATCH (:Repo {repoId: $repoId})<-[rel:GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO]-(s:GraphIntegrityFilelessState)
     WHERE s.repoId = $repoId
     DELETE rel, s`,
    { repoId },
  );
  await exec(
    conn,
    `MERGE (d:DerivedState {repoId: $repoId})
     SET d.graphIntegrityManifestEstablished = false`,
    { repoId },
  );
}

export async function replaceGraphIntegrityManifestInTransaction(
  conn: Connection,
  repoId: string,
  manifest: GraphIntegrityManifest,
): Promise<void> {
  const fileStateIds = new Set<string>();
  const fileIds = new Set<string>();
  for (const row of manifest.files) {
    assertFileStateIdentity(row);
    if (row.repoId !== repoId) {
      throw new Error("Graph integrity file state belongs to another repository");
    }
    if (fileStateIds.has(row.stateId) || fileIds.has(row.fileId)) {
      throw new DatabaseError("Duplicate graph integrity file state identity");
    }
    fileStateIds.add(row.stateId);
    fileIds.add(row.fileId);
  }
  const filelessStateIds = new Set<string>();
  const symbolIds = new Set<string>();
  for (const row of manifest.fileless) {
    assertFilelessStateIdentity(row);
    if (row.repoId !== repoId) {
      throw new Error("Graph integrity fileless state belongs to another repository");
    }
    if (filelessStateIds.has(row.stateId) || symbolIds.has(row.symbolId)) {
      throw new DatabaseError(
        "Duplicate graph integrity fileless state identity",
      );
    }
    filelessStateIds.add(row.stateId);
    symbolIds.add(row.symbolId);
  }

  await deleteGraphIntegrityManifestInTransaction(conn, repoId);
  for (
    let offset = 0;
    offset < manifest.files.length;
    offset += GRAPH_INTEGRITY_MANIFEST_BATCH_SIZE
  ) {
    const rows = manifest.files.slice(
      offset,
      offset + GRAPH_INTEGRITY_MANIFEST_BATCH_SIZE,
    );
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (r:Repo {repoId: $repoId})
       MERGE (f:GraphIntegrityFileState {stateId: row.stateId})
       SET f.repoId = row.repoId, f.fileId = row.fileId, f.relPath = row.relPath,
           f.symbolCount = row.symbolCount, f.digest = row.digest,
           f.filelessReferencesJson = row.filelessReferencesJson
       MERGE (f)-[:GRAPH_INTEGRITY_FILE_STATE_IN_REPO]->(r)`,
      { repoId, rows },
    );
  }
  for (
    let offset = 0;
    offset < manifest.fileless.length;
    offset += GRAPH_INTEGRITY_MANIFEST_BATCH_SIZE
  ) {
    const rows = manifest.fileless.slice(
      offset,
      offset + GRAPH_INTEGRITY_MANIFEST_BATCH_SIZE,
    );
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (r:Repo {repoId: $repoId})
       MERGE (s:GraphIntegrityFilelessState {stateId: row.stateId})
       SET s.repoId = row.repoId, s.symbolId = row.symbolId,
           s.canonicalSymbolJson = row.canonicalSymbolJson,
           s.referenceCount = row.referenceCount
       MERGE (s)-[:GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO]->(r)`,
      { repoId, rows },
    );
  }
  await exec(
    conn,
    `MERGE (d:DerivedState {repoId: $repoId})
     SET d.graphIntegrityManifestEstablished = true`,
    { repoId },
  );
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
  // Membership endpoints are not unique. Filter the candidate range first,
  // then collapse logical tuples before ordering and limiting the page.
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
     WITH DISTINCT s, fileId, relPath
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

/**
 * Read exact pre-write liveness and file ownership for pass-2 sources that
 * were not reindexed. A source with no matching edge returns one null-target
 * ownership row so its first new fileless reference remains attributable.
 */
export async function getPersistedGraphIntegritySourceReferenceCounts(
  conn: Connection,
  repoId: string,
  sourceSymbolIds: readonly string[],
  edgeType: string,
): Promise<PersistedGraphIntegritySourceReferenceCount[]> {
  if (sourceSymbolIds.length === 0) return [];
  const rows = await queryAll<RawPersistedGraphIntegritySourceReferenceCount>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[:SYMBOL_IN_FILE]->(f:File)-[:FILE_IN_REPO]->(r)
     WHERE a.symbolId IN $sourceSymbolIds
     WITH DISTINCT r, a, f
     OPTIONAL MATCH (a)-[d:DEPENDS_ON]->(b:Symbol)-[:SYMBOL_IN_REPO]->(r)
     WHERE coalesce(d.edgeType, '') = $edgeType
       AND NOT (b)-[:SYMBOL_IN_FILE]->(:File)
     WITH DISTINCT a, f, b, d
     RETURN a.symbolId AS sourceSymbolId,
            f.fileId AS fileId,
            b.symbolId AS symbolId,
            $edgeType AS edgeType,
            count(d) AS referenceCount
     ORDER BY sourceSymbolId ASC, fileId ASC, coalesce(symbolId, '') ASC, edgeType ASC`,
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
