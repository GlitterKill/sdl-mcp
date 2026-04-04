/**
 * ladybug-symbols.ts � Symbol Operations
 * Extracted from ladybug-queries.ts as part of the god-object split.
 */
import type { Connection } from "kuzu";
import {
  exec,
  queryAll,
  querySingle,
  toNumber,
  toBoolean,
  assertSafeInt,
  withTransaction,
} from "./ladybug-core.js";
import { logger } from "../util/logger.js";

const MAX_BATCH_WARNING_THRESHOLD = 5000;

export interface SymbolRow {
  symbolId: string;
  repoId: string;
  fileId: string;
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
  summarySource?: string;
  roleTagsJson?: string | null;
  searchText?: string | null;
  updatedAt: string;
}

export interface SymbolSnapshotRow {
  symbolId: string;
  astFingerprint: string;
  signatureJson: string | null;
  summary: string | null;
  invariantsJson: string | null;
  sideEffectsJson: string | null;
}

export async function upsertSymbol(
  conn: Connection,
  symbol: SymbolRow,
): Promise<void> {
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MATCH (f:File {fileId: $fileId})
     MERGE (s:Symbol {symbolId: $symbolId})
     SET s.kind = $kind,
         s.name = $name,
         s.exported = $exported,
         s.visibility = $visibility,
         s.language = $language,
         s.rangeStartLine = $rangeStartLine,
         s.rangeStartCol = $rangeStartCol,
         s.rangeEndLine = $rangeEndLine,
         s.rangeEndCol = $rangeEndCol,
         s.astFingerprint = $astFingerprint,
         s.signatureJson = $signatureJson,
         s.summary = $summary,
         s.invariantsJson = $invariantsJson,
         s.sideEffectsJson = $sideEffectsJson,
         s.roleTagsJson = $roleTagsJson,
         s.searchText = $searchText,
         s.summaryQuality = $summaryQuality,
         s.summarySource = $summarySource,
         s.updatedAt = $updatedAt
     MERGE (s)-[:SYMBOL_IN_FILE]->(f)
     MERGE (s)-[:SYMBOL_IN_REPO]->(r)`,
    {
      symbolId: symbol.symbolId,
      repoId: symbol.repoId,
      fileId: symbol.fileId,
      kind: symbol.kind,
      name: symbol.name,
      exported: symbol.exported,
      visibility: symbol.visibility,
      language: symbol.language,
      rangeStartLine: symbol.rangeStartLine,
      rangeStartCol: symbol.rangeStartCol,
      rangeEndLine: symbol.rangeEndLine,
      rangeEndCol: symbol.rangeEndCol,
      astFingerprint: symbol.astFingerprint,
      signatureJson: symbol.signatureJson,
      summary: symbol.summary,
      invariantsJson: symbol.invariantsJson,
      sideEffectsJson: symbol.sideEffectsJson,
      roleTagsJson: symbol.roleTagsJson ?? null,
      searchText: symbol.searchText ?? null,
      summaryQuality: symbol.summaryQuality ?? 0.0,
      summarySource: symbol.summarySource ?? "unknown",
      updatedAt: symbol.updatedAt,
    },
  );
}

export async function getSymbol(
  conn: Connection,
  symbolId: string,
): Promise<SymbolRow | null> {
  const row = await querySingle<{
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
    summaryQuality: number | null;
    summarySource: string | null;
    updatedAt: string;
  }>(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})-[:SYMBOL_IN_FILE]->(f:File)
     MATCH (s)-[:SYMBOL_IN_REPO]->(r:Repo)
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
            s.updatedAt AS updatedAt`,
    { symbolId },
  );

  if (!row) return null;

  return {
    symbolId: row.symbolId,
    repoId: row.repoId,
    fileId: row.fileId,
    kind: row.kind,
    name: row.name,
    exported: toBoolean(row.exported),
    visibility: row.visibility,
    language: row.language,
    rangeStartLine: toNumber(row.rangeStartLine),
    rangeStartCol: toNumber(row.rangeStartCol),
    rangeEndLine: toNumber(row.rangeEndLine),
    rangeEndCol: toNumber(row.rangeEndCol),
    astFingerprint: row.astFingerprint,
    signatureJson: row.signatureJson,
    summary: row.summary,
    invariantsJson: row.invariantsJson,
    sideEffectsJson: row.sideEffectsJson,
    summaryQuality: row.summaryQuality ?? undefined,
    summarySource: row.summarySource ?? undefined,
    updatedAt: row.updatedAt,
  };
}

export async function updateSymbolSummary(
  conn: Connection,
  symbolId: string,
  summary: string | null,
  summaryQuality: number,
  summarySource: string,
  updatedAt = new Date().toISOString(),
): Promise<void> {
  await exec(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})
     SET s.summary = $summary,
         s.summaryQuality = $summaryQuality,
         s.summarySource = $summarySource,
         s.updatedAt = $updatedAt`,
    { symbolId, summary, summaryQuality, summarySource, updatedAt },
  );
}

export async function getSymbolsByFile(
  conn: Connection,
  fileId: string,
): Promise<SymbolRow[]> {
  const rows = await queryAll<{
    symbolId: string;
    repoId: string;
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
    summaryQuality: number | null;
    summarySource: string | null;
    roleTagsJson: string | null;
    searchText: string | null;
    updatedAt: string;
  }>(
    conn,
    `MATCH (f:File {fileId: $fileId})<-[:SYMBOL_IN_FILE]-(s:Symbol)
     MATCH (s)-[:SYMBOL_IN_REPO]->(r:Repo)
     RETURN s.symbolId AS symbolId,
            r.repoId AS repoId,
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
            s.updatedAt AS updatedAt`,
    { fileId },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    repoId: row.repoId,
    fileId,
    kind: row.kind,
    name: row.name,
    exported: toBoolean(row.exported),
    visibility: row.visibility,
    language: row.language,
    rangeStartLine: toNumber(row.rangeStartLine),
    rangeStartCol: toNumber(row.rangeStartCol),
    rangeEndLine: toNumber(row.rangeEndLine),
    rangeEndCol: toNumber(row.rangeEndCol),
    astFingerprint: row.astFingerprint,
    signatureJson: row.signatureJson,
    summary: row.summary,
    invariantsJson: row.invariantsJson,
    sideEffectsJson: row.sideEffectsJson,
    summaryQuality: row.summaryQuality ?? undefined,
    summarySource: row.summarySource ?? undefined,
    roleTagsJson: row.roleTagsJson,
    searchText: row.searchText,
    updatedAt: row.updatedAt,
  }));
}

export async function getSymbolIdsByFile(
  conn: Connection,
  fileId: string,
): Promise<string[]> {
  const rows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (f:File {fileId: $fileId})<-[:SYMBOL_IN_FILE]-(s:Symbol)
     RETURN s.symbolId AS symbolId`,
    { fileId },
  );
  return rows.map((row) => row.symbolId);
}

export interface SymbolLiteRow {
  symbolId: string;
  repoId: string;
  fileId: string;
  name: string;
  kind: string;
  exported: boolean;
}

export async function getSymbolsByRepoLite(
  conn: Connection,
  repoId: string,
): Promise<SymbolLiteRow[]> {
  const rows = await queryAll<{
    symbolId: string;
    repoId: string;
    fileId: string;
    name: string;
    kind: string;
    exported: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     MATCH (s)-[:SYMBOL_IN_FILE]->(f:File)
     RETURN s.symbolId AS symbolId,
            r.repoId AS repoId,
            f.fileId AS fileId,
            s.name AS name,
            s.kind AS kind,
            s.exported AS exported`,
    { repoId },
  );
  return rows.map((row) => ({
    symbolId: row.symbolId,
    repoId: row.repoId,
    fileId: row.fileId,
    name: row.name,
    kind: row.kind,
    exported: toBoolean(row.exported),
  }));
}

export async function getSymbolIdsByRepo(
  conn: Connection,
  repoId: string,
): Promise<string[]> {
  const rows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     RETURN s.symbolId AS symbolId`,
    { repoId },
  );
  return rows.map((row) => row.symbolId);
}

export async function getSymbolsByRepo(
  conn: Connection,
  repoId: string,
): Promise<SymbolRow[]> {
  const rows = await queryAll<{
    symbolId: string;
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
    summaryQuality: number | null;
    summarySource: string | null;
    roleTagsJson: string | null;
    searchText: string | null;
    updatedAt: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     MATCH (s)-[:SYMBOL_IN_FILE]->(f:File)
     RETURN s.symbolId AS symbolId,
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
            s.updatedAt AS updatedAt`,
    { repoId },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    repoId,
    fileId: row.fileId,
    kind: row.kind,
    name: row.name,
    exported: toBoolean(row.exported),
    visibility: row.visibility,
    language: row.language,
    rangeStartLine: toNumber(row.rangeStartLine),
    rangeStartCol: toNumber(row.rangeStartCol),
    rangeEndLine: toNumber(row.rangeEndLine),
    rangeEndCol: toNumber(row.rangeEndCol),
    astFingerprint: row.astFingerprint,
    signatureJson: row.signatureJson,
    summary: row.summary,
    invariantsJson: row.invariantsJson,
    sideEffectsJson: row.sideEffectsJson,
    summaryQuality: row.summaryQuality ?? undefined,
    summarySource: row.summarySource ?? undefined,
    roleTagsJson: row.roleTagsJson,
    searchText: row.searchText,
    updatedAt: row.updatedAt,
  }));
}

export async function getSymbolsByRepoForSnapshot(
  conn: Connection,
  repoId: string,
): Promise<SymbolSnapshotRow[]> {
  const rows = await queryAll<SymbolSnapshotRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     RETURN s.symbolId AS symbolId,
            s.astFingerprint AS astFingerprint,
            s.signatureJson AS signatureJson,
            s.summary AS summary,
            s.invariantsJson AS invariantsJson,
            s.sideEffectsJson AS sideEffectsJson`,
    { repoId },
  );
  return rows;
}

export async function getSymbolCount(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     RETURN count(s) AS count`,
    { repoId },
  );
  return row ? toNumber(row.count) : 0;
}

export async function getSymbolsByIds(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, SymbolRow>> {
  if (symbolIds.length === 0) return new Map();

  if (symbolIds.length > MAX_BATCH_WARNING_THRESHOLD) {
    logger.warn("getSymbolsByIds: large batch size", {
      count: symbolIds.length,
      threshold: MAX_BATCH_WARNING_THRESHOLD,
    });
  }

  const rows = await queryAll<{
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
    summaryQuality: number | null;
    summarySource: string | null;
    roleTagsJson: string | null;
    searchText: string | null;
    updatedAt: string;
  }>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolId IN $symbolIds
     MATCH (s)-[:SYMBOL_IN_FILE]->(f:File)
     MATCH (s)-[:SYMBOL_IN_REPO]->(r:Repo)
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
            s.updatedAt AS updatedAt`,
    { symbolIds },
  );

  const result = new Map<string, SymbolRow>();
  for (const row of rows) {
    result.set(row.symbolId, {
      symbolId: row.symbolId,
      repoId: row.repoId,
      fileId: row.fileId,
      kind: row.kind,
      name: row.name,
      exported: toBoolean(row.exported),
      visibility: row.visibility,
      language: row.language,
      rangeStartLine: toNumber(row.rangeStartLine),
      rangeStartCol: toNumber(row.rangeStartCol),
      rangeEndLine: toNumber(row.rangeEndLine),
      rangeEndCol: toNumber(row.rangeEndCol),
      astFingerprint: row.astFingerprint,
      signatureJson: row.signatureJson,
      summary: row.summary,
      invariantsJson: row.invariantsJson,
      sideEffectsJson: row.sideEffectsJson,
      summaryQuality: row.summaryQuality ?? undefined,
      summarySource: row.summarySource ?? undefined,
      roleTagsJson: row.roleTagsJson,
      searchText: row.searchText,
      updatedAt: row.updatedAt,
    });
  }
  return result;
}

export interface SymbolBasicInfo {
  symbolId: string;
  name: string;
  kind: string;
  fileId?: string;
}

export async function getSymbolsByIdsLite(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, SymbolBasicInfo>> {
  const result = new Map<string, SymbolBasicInfo>();
  if (symbolIds.length === 0) return result;

  if (symbolIds.length > MAX_BATCH_WARNING_THRESHOLD) {
    logger.warn("getSymbolsByIdsLite: large batch size", {
      count: symbolIds.length,
      threshold: MAX_BATCH_WARNING_THRESHOLD,
    });
  }

  const rows = await queryAll<{
    symbolId: string;
    name: string;
    kind: string;
    fileId: string | null;
  }>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolId IN $symbolIds
     OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]->(f:File)
     RETURN s.symbolId AS symbolId,
            coalesce(s.name, '') AS name,
            coalesce(s.kind, '') AS kind,
            f.fileId AS fileId`,
    { symbolIds },
  );

  for (const row of rows) {
    result.set(row.symbolId, {
      symbolId: row.symbolId,
      name: row.name,
      kind: row.kind,
      fileId: row.fileId ?? undefined,
    });
  }

  return result;
}

export async function findSymbolsInRange(
  conn: Connection,
  repoId: string,
  fileId: string,
  startLine: number,
  endLine: number,
): Promise<SymbolRow[]> {
  const rows = await queryAll<{
    symbolId: string;
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
    summaryQuality: number | null;
    summarySource: string | null;
    updatedAt: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[:SYMBOL_IN_FILE]->(f:File {fileId: $fileId})
     WHERE s.rangeStartLine <= $endLine AND s.rangeEndLine >= $startLine
     WITH s,
          CASE
            WHEN s.rangeStartLine >= $startLine AND s.rangeEndLine <= $endLine THEN 0
            WHEN s.rangeStartLine <= $startLine AND s.rangeEndLine >= $endLine THEN 1
            WHEN s.rangeStartLine >= $startLine AND s.rangeStartLine <= $endLine THEN 2
            WHEN s.rangeEndLine >= $startLine AND s.rangeEndLine <= $endLine THEN 3
            ELSE 4
          END AS containmentRank,
          abs(s.rangeStartLine - $startLine) AS dist
     RETURN s.symbolId AS symbolId,
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
            s.updatedAt AS updatedAt
     ORDER BY containmentRank, dist`,
    { repoId, fileId, startLine, endLine },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    repoId,
    fileId,
    kind: row.kind,
    name: row.name,
    exported: toBoolean(row.exported),
    visibility: row.visibility,
    language: row.language,
    rangeStartLine: toNumber(row.rangeStartLine),
    rangeStartCol: toNumber(row.rangeStartCol),
    rangeEndLine: toNumber(row.rangeEndLine),
    rangeEndCol: toNumber(row.rangeEndCol),
    astFingerprint: row.astFingerprint,
    signatureJson: row.signatureJson,
    summary: row.summary,
    invariantsJson: row.invariantsJson,
    sideEffectsJson: row.sideEffectsJson,
    summaryQuality: row.summaryQuality ?? undefined,
    summarySource: row.summarySource ?? undefined,
    updatedAt: row.updatedAt,
  }));
}

export async function deleteSymbolsByFileId(
  conn: Connection,
  fileId: string,
): Promise<void> {
  await withTransaction(conn, async (txConn) => {
    const symbolRows = await queryAll<{ symbolId: string }>(
      txConn,
      `MATCH (f:File {fileId: $fileId})<-[:SYMBOL_IN_FILE]-(s:Symbol)
       RETURN s.symbolId AS symbolId`,
      { fileId },
    );

    if (symbolRows.length === 0) return;

    const symbolIds = symbolRows.map((r) => r.symbolId);

    // Batch delete all relationships and nodes for the collected symbols
    await exec(
      txConn,
      `MATCH (s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    );

    await exec(
      txConn,
      `MATCH (:Symbol)-[d:DEPENDS_ON]->(s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    );

    await exec(
      txConn,
      `MATCH (s:Symbol)-[r:SYMBOL_IN_REPO]->(:Repo)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    await exec(
      txConn,
      `MATCH (s:Symbol)-[r:SYMBOL_IN_FILE]->(:File {fileId: $fileId})
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds, fileId },
    );

    await exec(
      txConn,
      `MATCH (s:Symbol)-[r:BELONGS_TO_CLUSTER]->(:Cluster)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    await exec(
      txConn,
      `MATCH (s:Symbol)-[r:PARTICIPATES_IN]->(:Process)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    await exec(
      txConn,
      `MATCH (m:Metrics)
       WHERE m.symbolId IN $symbolIds
       DELETE m`,
      { symbolIds },
    );

    // Delete SymbolEmbedding nodes
    await exec(
      txConn,
      `MATCH (e:SymbolEmbedding)
       WHERE e.symbolId IN $symbolIds
       DELETE e`,
      { symbolIds },
    );

    // Delete SummaryCache nodes
    await exec(
      txConn,
      `MATCH (sc:SummaryCache)
       WHERE sc.symbolId IN $symbolIds
       DELETE sc`,
      { symbolIds },
    );

    // Delete SymbolReference nodes for this file
    await exec(
      txConn,
      `MATCH (sr:SymbolReference)
       WHERE sr.fileId = $fileId
       DELETE sr`,
      { fileId },
    );

    // Delete MEMORY_OF edges (Memory -> deleted Symbol)
    await exec(
      txConn,
      `MATCH (mem:Memory)-[r:MEMORY_OF]->(s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    // Delete MEMORY_OF_FILE edges (Memory -> deleted File)
    await exec(
      txConn,
      `MATCH (mem:Memory)-[r:MEMORY_OF_FILE]->(f:File {fileId: $fileId})
       DELETE r`,
      { fileId },
    );

    await exec(
      txConn,
      `MATCH (s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE s`,
      { symbolIds },
    );
  });
}

interface SearchSymbolsRawRow {
  symbolId: string;
  fileId: string;
  file: string;
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
  summaryQuality: number | null;
  summarySource: string | null;
  updatedAt: string;
}

function mapSearchSymbolRow(
  row: SearchSymbolsRawRow,
  repoId: string,
): SymbolRow {
  return {
    symbolId: row.symbolId,
    repoId,
    fileId: row.fileId,
    kind: row.kind,
    name: row.name,
    exported: toBoolean(row.exported),
    visibility: row.visibility,
    language: row.language,
    rangeStartLine: toNumber(row.rangeStartLine),
    rangeStartCol: toNumber(row.rangeStartCol),
    rangeEndLine: toNumber(row.rangeEndLine),
    rangeEndCol: toNumber(row.rangeEndCol),
    astFingerprint: row.astFingerprint,
    signatureJson: row.signatureJson,
    summary: row.summary,
    invariantsJson: row.invariantsJson,
    sideEffectsJson: row.sideEffectsJson,
    summaryQuality: row.summaryQuality ?? undefined,
    summarySource: row.summarySource ?? undefined,
    updatedAt: row.updatedAt,
  };
}

async function searchSymbolsSingleTerm(
  conn: Connection,
  repoId: string,
  term: string,
  kinds?: string[],
): Promise<SearchSymbolsRawRow[]> {
  return queryAll<SearchSymbolsRawRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
     WHERE (lower(s.name) CONTAINS lower($query)
        OR lower(coalesce(s.summary, '')) CONTAINS lower($query)
        OR lower(coalesce(s.searchText, '')) CONTAINS lower($query))
     ${kinds && kinds.length > 0 ? "AND s.kind IN $kinds" : ""}
     WITH s, f,
          CASE WHEN s.name = $query THEN 0 ELSE 1 END AS exactNameRank,
          CASE WHEN lower(s.name) = lower($query) THEN 0 ELSE 1 END AS ciExactNameRank,
          CASE
            WHEN lower(coalesce(s.searchText, '')) CONTAINS $queryPadded
              OR lower(coalesce(s.searchText, '')) STARTS WITH $queryStart
              OR lower(coalesce(s.searchText, '')) ENDS WITH $queryEnd
            THEN 0 ELSE 1
          END AS wordBoundaryRank,
          CASE
            WHEN f.relPath CONTAINS '/adapter/' THEN 2
            WHEN f.relPath CONTAINS '/tests/' OR f.relPath STARTS WITH 'tests/' THEN 2
            WHEN f.relPath STARTS WITH 'scripts/' THEN 2
            WHEN f.relPath CONTAINS '.test.' OR f.relPath CONTAINS '.spec.' THEN 2
            WHEN f.relPath CONTAINS 'target/' THEN 2
            WHEN f.relPath CONTAINS 'vendor/' THEN 2
            ELSE 0
          END AS filePenalty,
          CASE s.kind
            WHEN 'class' THEN 0
            WHEN 'function' THEN 1
            WHEN 'interface' THEN 2
            WHEN 'type' THEN 3
            WHEN 'method' THEN 4
            WHEN 'constructor' THEN 5
            WHEN 'module' THEN 6
            ELSE 7
          END AS kindRank,
          CASE WHEN lower(s.name) CONTAINS lower($query) THEN 0 ELSE 1 END AS nameMatchRank
     RETURN s.symbolId AS symbolId,
            f.fileId AS fileId,
            f.relPath AS file,
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
            s.updatedAt AS updatedAt
     ORDER BY exactNameRank, ciExactNameRank, wordBoundaryRank, filePenalty, kindRank, nameMatchRank
     LIMIT $limit`,
    {
      repoId,
      query: term,
      queryPadded: ` ${term.toLowerCase()} `,
      queryStart: `${term.toLowerCase()} `,
      queryEnd: ` ${term.toLowerCase()}`,
      limit: 200,
      ...(kinds && kinds.length > 0 && { kinds }),
    },
  );
}

export async function searchSymbols(
  conn: Connection,
  repoId: string,
  query: string,
  limit: number,
  kinds?: string[],
): Promise<SymbolRow[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  assertSafeInt(limit, "limit");
  const safeLimit = Math.max(1, Math.min(limit, 1000));

  const terms = splitSearchTerms(trimmed);

  // Single-term: use existing behavior
  if (terms.length <= 1) {
    const rows = await searchSymbolsSingleTerm(conn, repoId, trimmed, kinds);
    return rows
      .slice(0, safeLimit)
      .map((row) => mapSearchSymbolRow(row, repoId));
  }

  // Multi-term (including camelCase-split): run per-term queries, merge with match-count ranking
  const perTermResults = await Promise.all(
    terms.map((term) => searchSymbolsSingleTerm(conn, repoId, term, kinds)),
  );

  const matchCounts = new Map<
    string,
    { row: SearchSymbolsRawRow; count: number }
  >();
  for (const termRows of perTermResults) {
    for (const row of termRows) {
      const existing = matchCounts.get(row.symbolId);
      if (existing) {
        existing.count += 1;
      } else {
        matchCounts.set(row.symbolId, { row, count: 1 });
      }
    }
  }

  const lowerTrimmed = trimmed.toLowerCase();
  return Array.from(matchCounts.values())
    .sort((a, b) => {
      // Exact name match first
      const aExact = a.row.name.toLowerCase() === lowerTrimmed ? 0 : 1;
      const bExact = b.row.name.toLowerCase() === lowerTrimmed ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      // Name starts with full query
      const aPrefix = a.row.name.toLowerCase().startsWith(lowerTrimmed) ? 0 : 1;
      const bPrefix = b.row.name.toLowerCase().startsWith(lowerTrimmed) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      // Name contains full query
      const aContains = a.row.name.toLowerCase().includes(lowerTrimmed) ? 0 : 1;
      const bContains = b.row.name.toLowerCase().includes(lowerTrimmed) ? 0 : 1;
      if (aContains !== bContains) return aContains - bContains;
      // More terms matched = better
      return (
        b.count - a.count ||
        a.row.name.localeCompare(b.row.name) ||
        (a.row.file.startsWith("tests/") ? 1 : 0) -
          (b.row.file.startsWith("tests/") ? 1 : 0) ||
        (a.row.exported ? 0 : 1) - (b.row.exported ? 0 : 1)
      );
    })
    .map((entry) => mapSearchSymbolRow(entry.row, repoId))
    .slice(0, safeLimit);
}

export interface SearchSymbolLiteRow {
  symbolId: string;
  name: string;
  fileId: string;
  file: string;
  kind: string;
  exported: boolean;
}

/**
 * Split a search query into individual terms for OR matching.
 * Single words (no spaces) return as a single-element array.
 */
export function splitSearchTerms(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (!trimmed.includes(" ")) {
    // Split camelCase/PascalCase into words for multi-term search
    const words = trimmed.match(
      /[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g,
    );
    if (words && words.length > 1) {
      return words.map((w) => w.toLowerCase());
    }
    return [trimmed];
  }
  return trimmed.split(/\s+/).filter((t) => t.length > 0);
}

async function searchSymbolsLiteSingleTerm(
  conn: Connection,
  repoId: string,
  term: string,
  kinds?: string[],
): Promise<SearchSymbolLiteRow[]> {
  return queryAll<SearchSymbolLiteRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
     WHERE (lower(s.name) CONTAINS lower($query)
        OR lower(coalesce(s.summary, '')) CONTAINS lower($query)
        OR lower(coalesce(s.searchText, '')) CONTAINS lower($query))
     ${kinds && kinds.length > 0 ? "AND s.kind IN $kinds" : ""}
     WITH s, f,
          CASE WHEN s.name = $query THEN 0 ELSE 1 END AS exactNameRank,
          CASE WHEN lower(s.name) = lower($query) THEN 0 ELSE 1 END AS ciExactNameRank,
          CASE
            WHEN lower(coalesce(s.searchText, '')) CONTAINS $queryPadded
              OR lower(coalesce(s.searchText, '')) STARTS WITH $queryStart
              OR lower(coalesce(s.searchText, '')) ENDS WITH $queryEnd
            THEN 0 ELSE 1
          END AS wordBoundaryRank,
          CASE
            WHEN f.relPath CONTAINS '/adapter/' THEN 2
            WHEN f.relPath CONTAINS '/tests/' OR f.relPath STARTS WITH 'tests/' THEN 2
            WHEN f.relPath STARTS WITH 'scripts/' THEN 2
            WHEN f.relPath CONTAINS '.test.' OR f.relPath CONTAINS '.spec.' THEN 2
            WHEN f.relPath CONTAINS 'target/' THEN 2
            WHEN f.relPath CONTAINS 'vendor/' THEN 2
            ELSE 0
          END AS filePenalty,
          CASE s.kind
            WHEN 'class' THEN 0
            WHEN 'function' THEN 1
            WHEN 'interface' THEN 2
            WHEN 'type' THEN 3
            WHEN 'method' THEN 4
            WHEN 'constructor' THEN 5
            WHEN 'module' THEN 6
            ELSE 7
          END AS kindRank,
           CASE WHEN lower(s.name) CONTAINS lower($query) THEN 0 ELSE 1 END AS nameMatchRank
     RETURN s.symbolId AS symbolId,
            s.name AS name,
            f.fileId AS fileId,
            f.relPath AS file,
            s.kind AS kind,
            s.exported AS exported
     ORDER BY exactNameRank, ciExactNameRank, wordBoundaryRank, filePenalty, kindRank, nameMatchRank
     LIMIT $limit`,
    {
      repoId,
      query: term,
      queryPadded: ` ${term.toLowerCase()} `,
      queryStart: `${term.toLowerCase()} `,
      queryEnd: ` ${term.toLowerCase()}`,
      limit: 200,
      ...(kinds && kinds.length > 0 && { kinds }),
    },
  );
}

export async function searchSymbolsLite(
  conn: Connection,
  repoId: string,
  query: string,
  limit: number,
  kinds?: string[],
): Promise<SearchSymbolLiteRow[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  assertSafeInt(limit, "limit");
  const safeLimit = Math.max(1, Math.min(limit, 1000));

  const terms = splitSearchTerms(trimmed);

  // Single-term: use existing behavior
  if (terms.length <= 1) {
    const rows = await searchSymbolsLiteSingleTerm(
      conn,
      repoId,
      trimmed,
      kinds,
    );
    return rows.slice(0, safeLimit);
  }

  // Multi-term: run per-term queries, merge with match-count ranking
  const perTermResults = await Promise.all(
    terms.map((term) => searchSymbolsLiteSingleTerm(conn, repoId, term, kinds)),
  );

  // Count how many terms each symbol matched
  const matchCounts = new Map<
    string,
    { row: SearchSymbolLiteRow; count: number }
  >();
  for (const termRows of perTermResults) {
    for (const row of termRows) {
      const existing = matchCounts.get(row.symbolId);
      if (existing) {
        existing.count += 1;
      } else {
        matchCounts.set(row.symbolId, { row, count: 1 });
      }
    }
  }

  // Sort by match count descending, with compound name match tiebreakers
  const lt = query.trim().toLowerCase();
  return Array.from(matchCounts.values())
    .sort((a, b) => {
      // Exact name match first
      const aExact = a.row.name.toLowerCase() === lt ? 0 : 1;
      const bExact = b.row.name.toLowerCase() === lt ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      // Name starts with full query
      const aPrefix = a.row.name.toLowerCase().startsWith(lt) ? 0 : 1;
      const bPrefix = b.row.name.toLowerCase().startsWith(lt) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      // Name contains full query
      const aContains = a.row.name.toLowerCase().includes(lt) ? 0 : 1;
      const bContains = b.row.name.toLowerCase().includes(lt) ? 0 : 1;
      if (aContains !== bContains) return aContains - bContains;
      // More terms matched = better
      return (
        b.count - a.count ||
        a.row.name.localeCompare(b.row.name) ||
        (a.row.file.startsWith("tests/") ? 1 : 0) -
          (b.row.file.startsWith("tests/") ? 1 : 0) ||
        (a.row.exported ? 0 : 1) - (b.row.exported ? 0 : 1)
      );
    })
    .map((entry) => entry.row)
    .slice(0, safeLimit);
}

/**
 * Resolve a file::name shorthand to a symbolId.
 * Uses ENDS WITH on relPath so callers can abbreviate paths
 * (e.g. "code.ts::handleGetSkeleton" instead of full "src/mcp/tools/code.ts::handleGetSkeleton").
 * Returns the best match by kind priority, or null if none found.
 */
export async function resolveSymbolByShorthand(
  conn: Connection,
  repoId: string,
  relPath: string,
  symbolName: string,
): Promise<string | null> {
  const normalizedPath = relPath.replace(/\\/g, "/");

  const rows = await queryAll<{ symbolId: string; kind: string }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol {name: $name})-[:SYMBOL_IN_FILE]->(f:File)
     WHERE f.relPath ENDS WITH $relPath
     RETURN s.symbolId AS symbolId, s.kind AS kind
     ORDER BY CASE s.kind
       WHEN 'class' THEN 0
       WHEN 'function' THEN 1
       WHEN 'interface' THEN 2
       WHEN 'type' THEN 3
       WHEN 'method' THEN 4
       WHEN 'constructor' THEN 5
       WHEN 'module' THEN 6
       ELSE 7
     END
     LIMIT 5`,
    { repoId, name: symbolName, relPath: normalizedPath },
  );

  if (rows.length === 0) return null;

  if (rows.length > 1) {
    logger.debug(
      `resolveSymbolByShorthand: multiple matches for "${relPath}::${symbolName}" — using best by kind (${rows[0].kind})`,
    );
  }

  return rows[0].symbolId;
}
