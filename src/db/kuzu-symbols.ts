/**
 * kuzu-symbols.ts — Symbol Operations
 * Extracted from kuzu-queries.ts as part of the god-object split.
 */
import type { Connection } from "kuzu";
import { exec, queryAll, querySingle, toNumber, toBoolean, assertSafeInt } from "./kuzu-core.js";

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
    updatedAt: row.updatedAt,
  };
}

export async function updateSymbolSummary(
  conn: Connection,
  symbolId: string,
  summary: string | null,
  updatedAt = new Date().toISOString(),
): Promise<void> {
  await exec(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})
     SET s.summary = $summary,
         s.updatedAt = $updatedAt`,
    { symbolId, summary, updatedAt },
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
}

export async function getSymbolsByIdsLite(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, SymbolBasicInfo>> {
  const result = new Map<string, SymbolBasicInfo>();
  if (symbolIds.length === 0) return result;

  const rows = await queryAll<{
    symbolId: string;
    name: string;
    kind: string;
  }>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolId IN $symbolIds
     RETURN s.symbolId AS symbolId,
            coalesce(s.name, '') AS name,
            coalesce(s.kind, '') AS kind`,
    { symbolIds },
  );

  for (const row of rows) {
    result.set(row.symbolId, {
      symbolId: row.symbolId,
      name: row.name,
      kind: row.kind,
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
    updatedAt: row.updatedAt,
  }));
}

export async function deleteSymbolsByFileId(
  conn: Connection,
  fileId: string,
): Promise<void> {
  const symbolRows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (f:File {fileId: $fileId})<-[:SYMBOL_IN_FILE]-(s:Symbol)
     RETURN s.symbolId AS symbolId`,
    { fileId },
  );

  for (const { symbolId } of symbolRows) {
    await exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})-[d:DEPENDS_ON]->(:Symbol)
       DELETE d`,
      { symbolId },
    );

    await exec(
      conn,
      `MATCH (:Symbol)-[d:DEPENDS_ON]->(s:Symbol {symbolId: $symbolId})
       DELETE d`,
      { symbolId },
    );

    await exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})-[r:SYMBOL_IN_REPO]->(:Repo)
       DELETE r`,
      { symbolId },
    );

    await exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})-[r:SYMBOL_IN_FILE]->(:File {fileId: $fileId})
       DELETE r`,
      { symbolId, fileId },
    );

    await exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})-[r:BELONGS_TO_CLUSTER]->(:Cluster)
       DELETE r`,
      { symbolId },
    );

    await exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})-[r:PARTICIPATES_IN]->(:Process)
       DELETE r`,
      { symbolId },
    );

    await exec(
      conn,
      `MATCH (m:Metrics {symbolId: $symbolId})
       DELETE m`,
      { symbolId },
    );

    await exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})
       DELETE s`,
      { symbolId },
    );
  }
}

export async function searchSymbols(
  conn: Connection,
  repoId: string,
  query: string,
  limit: number,
): Promise<SymbolRow[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  assertSafeInt(limit, "limit");
  const safeLimit = Math.max(1, Math.min(limit, 1000));

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
    updatedAt: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
     WHERE lower(s.name) CONTAINS lower($query)
        OR lower(coalesce(s.summary, '')) CONTAINS lower($query)
        OR lower(coalesce(s.searchText, '')) CONTAINS lower($query)
     WITH s, f,
          CASE WHEN s.name = $query THEN 0 ELSE 1 END AS exactNameRank,
          CASE WHEN lower(s.name) = lower($query) THEN 0 ELSE 1 END AS ciExactNameRank,
          CASE
            WHEN f.relPath CONTAINS '/adapter/' THEN 2
            WHEN f.relPath CONTAINS '/tests/' OR f.relPath STARTS WITH 'tests/' THEN 2
            WHEN f.relPath STARTS WITH 'scripts/' THEN 2
            WHEN f.relPath CONTAINS '.test.' OR f.relPath CONTAINS '.spec.' THEN 2
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
            s.updatedAt AS updatedAt
     ORDER BY exactNameRank, ciExactNameRank, filePenalty, kindRank, nameMatchRank`,
    { repoId, query: trimmed },
  );

  return rows.slice(0, safeLimit).map((row) => ({
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
    updatedAt: row.updatedAt,
  }));
}

export interface SearchSymbolLiteRow {
  symbolId: string;
  name: string;
  fileId: string;
  kind: string;
}

export async function searchSymbolsLite(
  conn: Connection,
  repoId: string,
  query: string,
  limit: number,
): Promise<SearchSymbolLiteRow[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  assertSafeInt(limit, "limit");
  const safeLimit = Math.max(1, Math.min(limit, 1000));

  const rows = await queryAll<SearchSymbolLiteRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
     WHERE lower(s.name) CONTAINS lower($query)
        OR lower(coalesce(s.summary, '')) CONTAINS lower($query)
        OR lower(coalesce(s.searchText, '')) CONTAINS lower($query)
     WITH s, f,
          CASE WHEN s.name = $query THEN 0 ELSE 1 END AS exactNameRank,
          CASE WHEN lower(s.name) = lower($query) THEN 0 ELSE 1 END AS ciExactNameRank,
          CASE
            WHEN f.relPath CONTAINS '/adapter/' THEN 2
            WHEN f.relPath CONTAINS '/tests/' OR f.relPath STARTS WITH 'tests/' THEN 2
            WHEN f.relPath STARTS WITH 'scripts/' THEN 2
            WHEN f.relPath CONTAINS '.test.' OR f.relPath CONTAINS '.spec.' THEN 2
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
            s.kind AS kind
     ORDER BY exactNameRank, ciExactNameRank, filePenalty, kindRank, nameMatchRank`,
    { repoId, query: trimmed },
  );

  return rows.slice(0, safeLimit);
}

