import type { Connection, PreparedStatement, QueryResult } from "kuzu";
import { normalizePath } from "../util/paths.js";
import { logger } from "../util/logger.js";
import { DatabaseError } from "../mcp/errors.js";

const MAX_PREPARED_STATEMENT_CACHE_SIZE = 200;

const preparedStatementCacheByConn = new WeakMap<
  Connection,
  Map<string, PreparedStatement>
>();

let joinHintSupported: boolean | null = null;

function isJoinHintSyntaxUnsupported(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("extraneous input 'HINT'") ||
    message.includes("extraneous input \"HINT\"")
  );
}

function assertSafeInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new DatabaseError(`${name} must be a safe integer, got: ${String(value)}`);
  }
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  if (value != null) {
    logger.warn("toNumber: unexpected non-numeric value coerced to 0", {
      type: typeof value,
      value: String(value).slice(0, 50),
    });
  }
  return 0;
}

function coerceQueryResult(result: QueryResult | QueryResult[]): QueryResult {
  if (!Array.isArray(result)) return result;
  if (result.length === 0) {
    throw new DatabaseError("Empty query result array from KuzuDB");
  }
  // Kuzu can return multiple results for multi-statement queries; we only use
  // single statements in this module. Close any earlier results defensively.
  for (let i = 0; i < result.length - 1; i++) {
    result[i]?.close();
  }
  return result[result.length - 1];
}

async function getPreparedStatement(
  conn: Connection,
  statement: string,
): Promise<PreparedStatement> {
  let cache = preparedStatementCacheByConn.get(conn);
  if (!cache) {
    cache = new Map<string, PreparedStatement>();
    preparedStatementCacheByConn.set(conn, cache);
  }

  const cached = cache.get(statement);
  if (cached) {
    // refresh LRU position
    cache.delete(statement);
    cache.set(statement, cached);
    return cached;
  }

  const prepared = await conn.prepare(statement);
  cache.set(statement, prepared);

  if (cache.size > MAX_PREPARED_STATEMENT_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }

  return prepared;
}

async function execute(
  conn: Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<QueryResult> {
  const prepared = await getPreparedStatement(conn, statement);
  const result = await conn.execute(prepared, params);
  return coerceQueryResult(result);
}

async function queryAll<T>(
  conn: Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const result = await execute(conn, statement, params);
  try {
    return (await result.getAll()) as T[];
  } finally {
    result.close();
  }
}

async function querySingle<T>(
  conn: Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<T | null> {
  const rows = await queryAll<T>(conn, statement, params);
  return rows.length > 0 ? rows[0] : null;
}

async function exec(
  conn: Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  const result = await execute(conn, statement, params);
  result.close();
}

export async function withTransaction<T>(
  conn: Connection,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  await exec(conn, "BEGIN TRANSACTION");
  try {
    const result = await fn(conn);
    await exec(conn, "COMMIT");
    return result;
  } catch (err) {
    try {
      await exec(conn, "ROLLBACK");
    } catch {
      // Ignore rollback failures
    }
    throw err;
  }
}

export interface MetricsRow {
  symbolId: string;
  fanIn: number;
  fanOut: number;
  churn30d: number;
  testRefsJson: string | null;
  canonicalTestJson: string | null;
  updatedAt: string;
}

export interface TopSymbolByFanInRow {
  symbolId: string;
  fanIn: number;
  fanOut: number;
  churn30d: number;
}

export interface FanInOut {
  fanIn: number;
  fanOut: number;
}

export interface RepoRow {
  repoId: string;
  rootPath: string;
  configJson: string;
  createdAt: string;
}

export interface FileRow {
  fileId: string;
  repoId: string;
  relPath: string;
  contentHash: string;
  language: string;
  byteSize: number;
  lastIndexedAt: string | null;
  directory: string;
}

function computeDirectory(relPath: string): string {
  const normalized = normalizePath(relPath);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
}

export async function upsertRepo(conn: Connection, repo: RepoRow): Promise<void> {
  await exec(
    conn,
    `MERGE (r:Repo {repoId: $repoId})
     ON CREATE SET r.createdAt = $createdAt
     SET r.rootPath = $rootPath,
         r.configJson = $configJson`,
    {
      repoId: repo.repoId,
      rootPath: normalizePath(repo.rootPath),
      configJson: repo.configJson,
      createdAt: repo.createdAt,
    },
  );
}

export async function getRepo(
  conn: Connection,
  repoId: string,
): Promise<RepoRow | null> {
  const row = await querySingle<RepoRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     RETURN r.repoId AS repoId,
            r.rootPath AS rootPath,
            r.configJson AS configJson,
            r.createdAt AS createdAt`,
    { repoId },
  );
  return row ?? null;
}

export async function listRepos(
  conn: Connection,
  limit = 1000,
): Promise<RepoRow[]> {
  assertSafeInt(limit, "limit");

  return queryAll<RepoRow>(
    conn,
    `MATCH (r:Repo)
     RETURN r.repoId AS repoId,
            r.rootPath AS rootPath,
            r.configJson AS configJson,
            r.createdAt AS createdAt
     ORDER BY r.repoId
     LIMIT $limit`,
    { limit },
  );
}

export async function deleteRepo(conn: Connection, repoId: string): Promise<void> {
  const fileRows = await queryAll<{ fileId: string }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     RETURN f.fileId AS fileId`,
    { repoId },
  );

  const fileIds = fileRows.map((r) => r.fileId);
  await deleteFilesByIds(conn, fileIds);

  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     DELETE r`,
    { repoId },
  );
}

export async function upsertFile(
  conn: Connection,
  file: Omit<FileRow, "directory">,
): Promise<void> {
  const relPath = normalizePath(file.relPath);
  const directory = computeDirectory(relPath);

  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (f:File {fileId: $fileId})
     SET f.relPath = $relPath,
         f.contentHash = $contentHash,
         f.language = $language,
         f.byteSize = $byteSize,
         f.lastIndexedAt = $lastIndexedAt,
         f.directory = $directory
     MERGE (f)-[:FILE_IN_REPO]->(r)`,
    {
      fileId: file.fileId,
      repoId: file.repoId,
      relPath,
      contentHash: file.contentHash,
      language: file.language,
      byteSize: file.byteSize,
      lastIndexedAt: file.lastIndexedAt,
      directory,
    },
  );
}

export async function getFilesByRepo(
  conn: Connection,
  repoId: string,
): Promise<FileRow[]> {
  const rows = await queryAll<Omit<FileRow, "repoId">>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     RETURN f.fileId AS fileId,
            f.relPath AS relPath,
            f.contentHash AS contentHash,
            f.language AS language,
            f.byteSize AS byteSize,
            f.lastIndexedAt AS lastIndexedAt,
            f.directory AS directory`,
    { repoId },
  );

  return rows.map((row) => ({
    ...row,
    repoId,
    byteSize: toNumber(row.byteSize),
    lastIndexedAt: row.lastIndexedAt ?? null,
  }));
}

export async function getFileByRepoPath(
  conn: Connection,
  repoId: string,
  relPath: string,
): Promise<FileRow | null> {
  const normalizedRelPath = normalizePath(relPath);
  const row = await querySingle<Omit<FileRow, "repoId">>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File {relPath: $relPath})
     RETURN f.fileId AS fileId,
            f.relPath AS relPath,
            f.contentHash AS contentHash,
            f.language AS language,
            f.byteSize AS byteSize,
            f.lastIndexedAt AS lastIndexedAt,
            f.directory AS directory`,
    { repoId, relPath: normalizedRelPath },
  );

  if (!row) return null;

  return {
    ...row,
    repoId,
    byteSize: toNumber(row.byteSize),
    lastIndexedAt: row.lastIndexedAt ?? null,
  };
}

export async function deleteFilesByIds(
  conn: Connection,
  fileIds: string[],
): Promise<void> {
  if (fileIds.length === 0) return;

  const uniqueFileIds = [...new Set(fileIds)];

  // Step 1: Collect all symbolIds for all fileIds in one query
  const symbolRows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)
     WHERE f.fileId IN $fileIds
     RETURN s.symbolId AS symbolId`,
    { fileIds: uniqueFileIds },
  );
  const symbolIds = symbolRows.map((r) => r.symbolId);

  if (symbolIds.length > 0) {
    // Step 2: Batch-delete DEPENDS_ON edges (both directions)
    await exec(
      conn,
      `MATCH (s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    );
    await exec(
      conn,
      `MATCH (:Symbol)-[d:DEPENDS_ON]->(s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    );

    // Step 3: Batch-delete cluster/process relationships
    await exec(
      conn,
      `MATCH (s:Symbol)-[r:BELONGS_TO_CLUSTER]->(:Cluster)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );
    await exec(
      conn,
      `MATCH (s:Symbol)-[r:PARTICIPATES_IN]->(:Process)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    // Step 4: Batch-delete SYMBOL_IN_REPO and SYMBOL_IN_FILE rels
    await exec(
      conn,
      `MATCH (s:Symbol)-[r:SYMBOL_IN_REPO]->(:Repo)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );
    await exec(
      conn,
      `MATCH (s:Symbol)-[r:SYMBOL_IN_FILE]->(:File)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    // Step 5: Batch-delete Metrics nodes
    await exec(
      conn,
      `MATCH (m:Metrics)
       WHERE m.symbolId IN $symbolIds
       DELETE m`,
      { symbolIds },
    );

    // Step 6: Batch-delete Symbol nodes
    await exec(
      conn,
      `MATCH (s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE s`,
      { symbolIds },
    );
  }

  // Step 7: Batch-delete FILE_IN_REPO rels and File nodes
  await exec(
    conn,
    `MATCH (f:File)-[r:FILE_IN_REPO]->(:Repo)
     WHERE f.fileId IN $fileIds
     DELETE r`,
    { fileIds: uniqueFileIds },
  );
  await exec(
    conn,
    `MATCH (f:File)
     WHERE f.fileId IN $fileIds
     DELETE f`,
    { fileIds: uniqueFileIds },
  );
}

export async function getFilesByDirectory(
  conn: Connection,
  repoId: string,
  directory: string,
): Promise<FileRow[]> {
  const normalizedDirectory = normalizePath(directory);

  const rows = await queryAll<Omit<FileRow, "repoId">>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     WHERE f.directory = $directory
     RETURN f.fileId AS fileId,
            f.relPath AS relPath,
            f.contentHash AS contentHash,
            f.language AS language,
            f.byteSize AS byteSize,
            f.lastIndexedAt AS lastIndexedAt,
            f.directory AS directory`,
    { repoId, directory: normalizedDirectory },
  );

  return rows.map((row) => ({
    ...row,
    repoId,
    byteSize: toNumber(row.byteSize),
    lastIndexedAt: row.lastIndexedAt ?? null,
  }));
}

export async function getFileCount(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     RETURN count(f) AS count`,
    { repoId },
  );
  return row ? toNumber(row.count) : 0;
}

export async function getFilesByIds(
  conn: Connection,
  fileIds: string[],
): Promise<Map<string, FileRow>> {
  const result = new Map<string, FileRow>();
  if (fileIds.length === 0) return result;

  const rows = await queryAll<{
    fileId: string;
    repoId: string;
    relPath: string;
    contentHash: string;
    language: string;
    byteSize: unknown;
    lastIndexedAt: string | null;
    directory: string;
  }>(
    conn,
    `MATCH (f:File)
     WHERE f.fileId IN $fileIds
     MATCH (f)-[:FILE_IN_REPO]->(r:Repo)
     RETURN f.fileId AS fileId,
            r.repoId AS repoId,
            f.relPath AS relPath,
            f.contentHash AS contentHash,
            f.language AS language,
            f.byteSize AS byteSize,
            f.lastIndexedAt AS lastIndexedAt,
            f.directory AS directory`,
    { fileIds },
  );

  for (const row of rows) {
    result.set(row.fileId, {
      fileId: row.fileId,
      repoId: row.repoId,
      relPath: row.relPath,
      contentHash: row.contentHash,
      language: row.language,
      byteSize: toNumber(row.byteSize),
      lastIndexedAt: row.lastIndexedAt ?? null,
      directory: row.directory,
    });
  }

  return result;
}

export interface FileLiteRow {
  fileId: string;
  relPath: string;
}

export async function getFilesByRepoLite(
  conn: Connection,
  repoId: string,
): Promise<FileLiteRow[]> {
  const rows = await queryAll<FileLiteRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     RETURN f.fileId AS fileId,
            f.relPath AS relPath`,
    { repoId },
  );

  return rows;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string") return value === "true" || value === "1";
  return false;
}

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
      updatedAt: row.updatedAt,
    });
  }
  return result;
}

export interface SymbolLiteRow {
  symbolId: string;
  name: string;
  kind: string;
}

export async function getSymbolsByIdsLite(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, SymbolLiteRow>> {
  const result = new Map<string, SymbolLiteRow>();
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
     ORDER BY exactNameRank, ciExactNameRank, filePenalty, kindRank, nameMatchRank
     LIMIT $limit`,
    { repoId, query: trimmed, limit: safeLimit },
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
     ORDER BY exactNameRank, ciExactNameRank, filePenalty, kindRank, nameMatchRank
     LIMIT $limit`,
    { repoId, query: trimmed, limit: safeLimit },
  );

  return rows;
}

export interface EdgeRow {
  repoId: string;
  fromSymbolId: string;
  toSymbolId: string;
  edgeType: string;
  weight: number;
  confidence: number;
  resolution: string;
  provenance: string | null;
  createdAt: string;
}

export interface EdgeForSlice {
  fromSymbolId: string;
  toSymbolId: string;
  edgeType: string;
  weight: number;
  confidence: number;
}

export interface EdgeLite {
  fromSymbolId: string;
  toSymbolId: string;
  edgeType: string;
}

export async function insertEdge(conn: Connection, edge: EdgeRow): Promise<void> {
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (a:Symbol {symbolId: $fromSymbolId})
     MERGE (b:Symbol {symbolId: $toSymbolId})
     MERGE (a)-[:SYMBOL_IN_REPO]->(r)
     MERGE (b)-[:SYMBOL_IN_REPO]->(r)
     MERGE (a)-[d:DEPENDS_ON {edgeType: $edgeType}]->(b)
     SET d.weight = $weight,
         d.confidence = $confidence,
         d.resolution = $resolution,
         d.provenance = $provenance,
         d.createdAt = $createdAt`,
    {
      repoId: edge.repoId,
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      edgeType: edge.edgeType,
      weight: edge.weight,
      confidence: edge.confidence,
      resolution: edge.resolution,
      provenance: edge.provenance,
      createdAt: edge.createdAt,
    },
  );
}

export async function insertEdges(
  conn: Connection,
  edges: EdgeRow[],
): Promise<void> {
  if (edges.length === 0) return;

  const edgesByRepo = new Map<string, EdgeRow[]>();
  for (const edge of edges) {
    const bucket = edgesByRepo.get(edge.repoId);
    if (bucket) bucket.push(edge);
    else edgesByRepo.set(edge.repoId, [edge]);
  }

  for (const [repoId, repoEdges] of edgesByRepo) {
    const fromSymbolIds = [...new Set(repoEdges.map((e) => e.fromSymbolId))];

    for (const symbolId of fromSymbolIds) {
      await exec(
        conn,
        `MATCH (r:Repo {repoId: $repoId})
         MERGE (s:Symbol {symbolId: $symbolId})
         MERGE (s)-[:SYMBOL_IN_REPO]->(r)`,
        { repoId, symbolId },
      );
    }

    for (const edge of repoEdges) {
      await exec(
        conn,
        `MERGE (a:Symbol {symbolId: $fromSymbolId})
         MERGE (b:Symbol {symbolId: $toSymbolId})
         MERGE (a)-[d:DEPENDS_ON {edgeType: $edgeType}]->(b)
         SET d.weight = $weight,
             d.confidence = $confidence,
             d.resolution = $resolution,
             d.provenance = $provenance,
             d.createdAt = $createdAt`,
        {
          fromSymbolId: edge.fromSymbolId,
          toSymbolId: edge.toSymbolId,
          edgeType: edge.edgeType,
          weight: edge.weight,
          confidence: edge.confidence,
          resolution: edge.resolution,
          provenance: edge.provenance,
          createdAt: edge.createdAt,
        },
      );
    }
  }
}

export async function deleteEdge(
  conn: Connection,
  edge: { fromSymbolId: string; toSymbolId: string; edgeType: string },
): Promise<void> {
  await exec(
    conn,
    `MATCH (a:Symbol {symbolId: $fromSymbolId})-[d:DEPENDS_ON]->(b:Symbol {symbolId: $toSymbolId})
     WHERE d.edgeType = $edgeType
     DELETE d`,
    {
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      edgeType: edge.edgeType,
    },
  );
}

export async function getEdgesFrom(
  conn: Connection,
  symbolId: string,
): Promise<EdgeRow[]> {
  const rows = await queryAll<{
    repoId: string;
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string;
    provenance: string | null;
    createdAt: string;
  }>(
    conn,
    `MATCH (a:Symbol {symbolId: $symbolId})-[d:DEPENDS_ON]->(b:Symbol)
     MATCH (a)-[:SYMBOL_IN_REPO]->(r:Repo)
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.provenance AS provenance,
            d.createdAt AS createdAt`,
    { symbolId },
  );

  return rows.map((row) => ({
    repoId: row.repoId,
    fromSymbolId: row.fromSymbolId,
    toSymbolId: row.toSymbolId,
    edgeType: row.edgeType,
    weight: toNumber(row.weight),
    confidence: toNumber(row.confidence),
    resolution: row.resolution,
    provenance: row.provenance,
    createdAt: row.createdAt,
  }));
}

export async function getEdgesFromSymbols(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, EdgeRow[]>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, EdgeRow[]>();
  for (const id of symbolIds) result.set(id, []);

  const rows = await queryAll<{
    repoId: string;
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string;
    provenance: string | null;
    createdAt: string;
  }>(
    conn,
    `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE a.symbolId IN $symbolIds
     MATCH (a)-[:SYMBOL_IN_REPO]->(r:Repo)
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.provenance AS provenance,
            d.createdAt AS createdAt`,
    { symbolIds },
  );

  for (const row of rows) {
    const bucket = result.get(row.fromSymbolId);
    if (!bucket) continue;
    bucket.push({
      repoId: row.repoId,
      fromSymbolId: row.fromSymbolId,
      toSymbolId: row.toSymbolId,
      edgeType: row.edgeType,
      weight: toNumber(row.weight),
      confidence: toNumber(row.confidence),
      resolution: row.resolution,
      provenance: row.provenance,
      createdAt: row.createdAt,
    });
  }

  return result;
}

export async function getEdgesFromSymbolsForSlice(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, EdgeForSlice[]>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, EdgeForSlice[]>();
  for (const id of symbolIds) result.set(id, []);

  const rows = await queryAll<{
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
  }>(
    conn,
    `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE a.symbolId IN $symbolIds
     RETURN a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence`,
    { symbolIds },
  );

  for (const row of rows) {
    const bucket = result.get(row.fromSymbolId);
    if (!bucket) continue;
    bucket.push({
      fromSymbolId: row.fromSymbolId,
      toSymbolId: row.toSymbolId,
      edgeType: row.edgeType,
      weight: toNumber(row.weight),
      confidence: toNumber(row.confidence),
    });
  }

  return result;
}

export async function getEdgesFromSymbolsLite(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, EdgeLite[]>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, EdgeLite[]>();
  for (const id of symbolIds) result.set(id, []);

  const rows = await queryAll<{
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
  }>(
    conn,
    `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE a.symbolId IN $symbolIds
     RETURN a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType`,
    { symbolIds },
  );

  for (const row of rows) {
    const bucket = result.get(row.fromSymbolId);
    if (!bucket) continue;
    bucket.push({
      fromSymbolId: row.fromSymbolId,
      toSymbolId: row.toSymbolId,
      edgeType: row.edgeType,
    });
  }

  return result;
}

export async function getEdgesToSymbols(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, EdgeRow[]>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, EdgeRow[]>();
  for (const id of symbolIds) result.set(id, []);

  const queryWithHint = `MATCH (b:Symbol)
     WHERE b.symbolId IN $symbolIds
     MATCH (a:Symbol)-[d:DEPENDS_ON]->(b)
     MATCH (a)-[:SYMBOL_IN_REPO]->(r:Repo)
     WITH b, d, a, r
     HINT (b JOIN (d JOIN a))
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.provenance AS provenance,
            d.createdAt AS createdAt
     ORDER BY a.symbolId`;

  const queryWithoutHint = `MATCH (b:Symbol)
     WHERE b.symbolId IN $symbolIds
     MATCH (a:Symbol)-[d:DEPENDS_ON]->(b)
     MATCH (a)-[:SYMBOL_IN_REPO]->(r:Repo)
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.provenance AS provenance,
            d.createdAt AS createdAt
     ORDER BY a.symbolId`;

  let rows: Array<{
    repoId: string;
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string;
    provenance: string | null;
    createdAt: string;
  }>;

  try {
    rows = await queryAll<{
    repoId: string;
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string;
    provenance: string | null;
    createdAt: string;
  }>(
      conn,
      joinHintSupported === false ? queryWithoutHint : queryWithHint,
      { symbolIds },
    );
    if (joinHintSupported === null) {
      joinHintSupported = true;
    }
  } catch (error) {
    if (joinHintSupported !== false && isJoinHintSyntaxUnsupported(error)) {
      joinHintSupported = false;
      rows = await queryAll<{
        repoId: string;
        fromSymbolId: string;
        toSymbolId: string;
        edgeType: string;
        weight: unknown;
        confidence: unknown;
        resolution: string;
        provenance: string | null;
        createdAt: string;
      }>(conn, queryWithoutHint, { symbolIds });
    } else {
      throw error;
    }
  }

  for (const row of rows) {
    const bucket = result.get(row.toSymbolId);
    if (!bucket) continue;
    bucket.push({
      repoId: row.repoId,
      fromSymbolId: row.fromSymbolId,
      toSymbolId: row.toSymbolId,
      edgeType: row.edgeType,
      weight: toNumber(row.weight),
      confidence: toNumber(row.confidence),
      resolution: row.resolution,
      provenance: row.provenance,
      createdAt: row.createdAt,
    });
  }

  return result;
}

export async function getEdgesByRepo(
  conn: Connection,
  repoId: string,
): Promise<EdgeRow[]> {
  const rows = await queryAll<{
    repoId: string;
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string;
    provenance: string | null;
    createdAt: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.provenance AS provenance,
            d.createdAt AS createdAt`,
    { repoId },
  );

  return rows.map((row) => ({
    repoId: row.repoId,
    fromSymbolId: row.fromSymbolId,
    toSymbolId: row.toSymbolId,
    edgeType: row.edgeType,
    weight: toNumber(row.weight),
    confidence: toNumber(row.confidence),
    resolution: row.resolution,
    provenance: row.provenance,
    createdAt: row.createdAt,
  }));
}

export async function getCallersOfSymbols(
  conn: Connection,
  repoId: string,
  symbolIds: string[],
): Promise<string[]> {
  if (symbolIds.length === 0) return [];

  const queryWithHint = `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(to:Symbol)
     WHERE to.symbolId IN $symbolIds
     MATCH (from:Symbol)-[d:DEPENDS_ON]->(to)
     MATCH (from)-[:SYMBOL_IN_REPO]->(r)
     WHERE d.edgeType IN ['call', 'import']
     WITH r, to, d, from
     HINT (to JOIN (d JOIN from))
     RETURN DISTINCT from.symbolId AS symbolId
     ORDER BY symbolId`;

  const queryWithoutHint = `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(to:Symbol)
     WHERE to.symbolId IN $symbolIds
     MATCH (from:Symbol)-[d:DEPENDS_ON]->(to)
     MATCH (from)-[:SYMBOL_IN_REPO]->(r)
     WHERE d.edgeType IN ['call', 'import']
     RETURN DISTINCT from.symbolId AS symbolId
     ORDER BY symbolId`;

  let rows: Array<{ symbolId: string }>;

  try {
    rows = await queryAll<{ symbolId: string }>(
      conn,
      joinHintSupported === false ? queryWithoutHint : queryWithHint,
      { repoId, symbolIds },
    );
    if (joinHintSupported === null) {
      joinHintSupported = true;
    }
  } catch (error) {
    if (joinHintSupported !== false && isJoinHintSyntaxUnsupported(error)) {
      joinHintSupported = false;
      rows = await queryAll<{ symbolId: string }>(conn, queryWithoutHint, {
        repoId,
        symbolIds,
      });
    } else {
      throw error;
    }
  }

  return rows.map((row) => row.symbolId);
}

export async function deleteEdgesByFileId(
  conn: Connection,
  fileId: string,
): Promise<void> {
  const symbolRows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (f:File {fileId: $fileId})<-[:SYMBOL_IN_FILE]-(s:Symbol)
     RETURN s.symbolId AS symbolId`,
    { fileId },
  );

  const symbolIds = symbolRows.map((r) => r.symbolId);
  if (symbolIds.length === 0) return;

  await exec(
    conn,
    `MATCH (s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     WHERE s.symbolId IN $symbolIds
     DELETE d`,
    { symbolIds },
  );

  await exec(
    conn,
    `MATCH (:Symbol)-[d:DEPENDS_ON]->(s:Symbol)
     WHERE s.symbolId IN $symbolIds
     DELETE d`,
    { symbolIds },
  );
}

export async function deleteOutgoingEdgesByTypeForSymbols(
  conn: Connection,
  symbolIds: string[],
  edgeType: string,
): Promise<void> {
  if (symbolIds.length === 0) return;

  await exec(
    conn,
    `MATCH (s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     WHERE s.symbolId IN $symbolIds AND d.edgeType = $edgeType
     DELETE d`,
    { symbolIds, edgeType },
  );
}

export async function getEdgeCountsByType(
  conn: Connection,
  repoId: string,
): Promise<Record<string, number>> {
  const rows = await queryAll<{ edgeType: string; count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     RETURN d.edgeType AS edgeType, count(d) AS count`,
    { repoId },
  );

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.edgeType] = toNumber(row.count);
  }
  return result;
}

export async function getEdgeCount(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     RETURN count(d) AS count`,
    { repoId },
  );
  return row ? toNumber(row.count) : 0;
}

export async function getCallEdgeResolutionCounts(
  conn: Connection,
  repoId: string,
): Promise<{
  totalCallEdges: number;
  resolvedCallEdges: number;
  exactCallEdges: number;
}> {
  const total = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     WHERE d.edgeType = 'call'
     RETURN count(d) AS count`,
    { repoId },
  );

  const resolved = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(t:Symbol)
     WHERE d.edgeType = 'call' AND NOT startsWith(t.symbolId, 'unresolved:')
     RETURN count(d) AS count`,
    { repoId },
  );

  const exact = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     WHERE d.edgeType = 'call' AND (d.resolution = 'exact' OR d.confidence >= 0.9)
     RETURN count(d) AS count`,
    { repoId },
  );

  return {
    totalCallEdges: total ? toNumber(total.count) : 0,
    resolvedCallEdges: resolved ? toNumber(resolved.count) : 0,
    exactCallEdges: exact ? toNumber(exact.count) : 0,
  };
}

export interface VersionRow {
  versionId: string;
  repoId: string;
  createdAt: string;
  reason: string | null;
  prevVersionHash: string | null;
  versionHash: string | null;
}

export interface SymbolVersionRow {
  id: string;
  versionId: string;
  symbolId: string;
  astFingerprint: string;
  signatureJson: string | null;
  summary: string | null;
  invariantsJson: string | null;
  sideEffectsJson: string | null;
}

export async function createVersion(
  conn: Connection,
  version: VersionRow,
): Promise<void> {
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (v:Version {versionId: $versionId})
     SET v.createdAt = $createdAt,
         v.reason = $reason,
         v.prevVersionHash = $prevVersionHash,
         v.versionHash = $versionHash
     MERGE (v)-[:VERSION_OF_REPO]->(r)`,
    {
      versionId: version.versionId,
      repoId: version.repoId,
      createdAt: version.createdAt,
      reason: version.reason,
      prevVersionHash: version.prevVersionHash,
      versionHash: version.versionHash,
    },
  );
}

export async function updateVersionHashes(
  conn: Connection,
  versionId: string,
  prevVersionHash: string | null,
  versionHash: string | null,
): Promise<void> {
  await exec(
    conn,
    `MATCH (v:Version {versionId: $versionId})
     SET v.prevVersionHash = $prevVersionHash,
         v.versionHash = $versionHash`,
    { versionId, prevVersionHash, versionHash },
  );
}

export async function getVersion(
  conn: Connection,
  versionId: string,
): Promise<VersionRow | null> {
  const row = await querySingle<{
    versionId: string;
    repoId: string;
    createdAt: string;
    reason: string | null;
    prevVersionHash: string | null;
    versionHash: string | null;
  }>(
    conn,
    `MATCH (v:Version {versionId: $versionId})-[:VERSION_OF_REPO]->(r:Repo)
     RETURN v.versionId AS versionId,
            r.repoId AS repoId,
            v.createdAt AS createdAt,
            v.reason AS reason,
            v.prevVersionHash AS prevVersionHash,
            v.versionHash AS versionHash`,
    { versionId },
  );

  return row ?? null;
}

export async function getLatestVersion(
  conn: Connection,
  repoId: string,
): Promise<VersionRow | null> {
  const row = await querySingle<{
    versionId: string;
    createdAt: string;
    reason: string | null;
    prevVersionHash: string | null;
    versionHash: string | null;
  }>(
    conn,
    `MATCH (v:Version)-[:VERSION_OF_REPO]->(r:Repo {repoId: $repoId})
     RETURN v.versionId AS versionId,
            v.createdAt AS createdAt,
            v.reason AS reason,
            v.prevVersionHash AS prevVersionHash,
            v.versionHash AS versionHash
     ORDER BY v.createdAt DESC
     LIMIT 1`,
    { repoId },
  );

  if (!row) return null;

  return { repoId, ...row };
}

export async function getVersionsByRepo(
  conn: Connection,
  repoId: string,
  limit = 100,
): Promise<VersionRow[]> {
  assertSafeInt(limit, "limit");
  limit = Math.max(0, Math.min(limit, 10000));

  const rows = await queryAll<{
    versionId: string;
    createdAt: string;
    reason: string | null;
    prevVersionHash: string | null;
    versionHash: string | null;
  }>(
    conn,
    `MATCH (v:Version)-[:VERSION_OF_REPO]->(r:Repo {repoId: $repoId})
     RETURN v.versionId AS versionId,
            v.createdAt AS createdAt,
            v.reason AS reason,
            v.prevVersionHash AS prevVersionHash,
            v.versionHash AS versionHash
     ORDER BY v.createdAt DESC
     LIMIT $limit`,
    { repoId },
  );

  return rows.map((row) => ({ repoId, ...row }));
}

export async function snapshotSymbolVersion(
  conn: Connection,
  row: Omit<SymbolVersionRow, "id">,
): Promise<void> {
  const id = `${row.versionId}:${row.symbolId}`;

  await exec(
    conn,
    `MERGE (sv:SymbolVersion {id: $id})
     SET sv.versionId = $versionId,
         sv.symbolId = $symbolId,
         sv.astFingerprint = $astFingerprint,
         sv.signatureJson = $signatureJson,
         sv.summary = $summary,
         sv.invariantsJson = $invariantsJson,
         sv.sideEffectsJson = $sideEffectsJson`,
    {
      id,
      versionId: row.versionId,
      symbolId: row.symbolId,
      astFingerprint: row.astFingerprint,
      signatureJson: row.signatureJson,
      summary: row.summary,
      invariantsJson: row.invariantsJson,
      sideEffectsJson: row.sideEffectsJson,
    },
  );
}

export async function getSymbolVersionsAtVersion(
  conn: Connection,
  versionId: string,
): Promise<SymbolVersionRow[]> {
  const rows = await queryAll<SymbolVersionRow>(
    conn,
    `MATCH (sv:SymbolVersion {versionId: $versionId})
     RETURN sv.id AS id,
            sv.versionId AS versionId,
            sv.symbolId AS symbolId,
            sv.astFingerprint AS astFingerprint,
            sv.signatureJson AS signatureJson,
            sv.summary AS summary,
            sv.invariantsJson AS invariantsJson,
            sv.sideEffectsJson AS sideEffectsJson`,
    { versionId },
  );
  return rows;
}

export async function getFanInAtVersion(
  conn: Connection,
  repoId: string,
  symbolId: string,
  versionId: string,
): Promise<number> {
  const symbolAtVersion = await querySingle<{ symbolId: string }>(
    conn,
    `MATCH (sv:SymbolVersion {versionId: $versionId, symbolId: $symbolId})
     RETURN sv.symbolId AS symbolId`,
    { versionId, symbolId },
  );

  if (!symbolAtVersion) {
    const metricsRow = await querySingle<{ fanIn: unknown }>(
      conn,
      `MATCH (m:Metrics {symbolId: $symbolId})
       RETURN m.fanIn AS fanIn`,
      { symbolId },
    );
    return metricsRow ? toNumber(metricsRow.fanIn) : 0;
  }

  const row = await querySingle<{ cnt: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(from:Symbol)-[d:DEPENDS_ON]->(to:Symbol {symbolId: $symbolId})
     MATCH (sv:SymbolVersion {versionId: $versionId, symbolId: from.symbolId})
     RETURN count(d) AS cnt`,
    { repoId, symbolId, versionId },
  );

  return row ? toNumber(row.cnt) : 0;
}

export async function batchGetFanInAtVersion(
  conn: Connection,
  repoId: string,
  symbolIds: string[],
  versionId: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (symbolIds.length === 0) return result;

  // Check which symbols exist in this version
  const versionRows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (sv:SymbolVersion)
     WHERE sv.versionId = $versionId AND sv.symbolId IN $symbolIds
     RETURN sv.symbolId AS symbolId`,
    { versionId, symbolIds },
  );
  const inVersion = new Set(versionRows.map((r) => r.symbolId));

  // For symbols NOT in version, fall back to current metrics
  const fallbackIds = symbolIds.filter((id) => !inVersion.has(id));
  if (fallbackIds.length > 0) {
    const metricsRows = await queryAll<{ symbolId: string; fanIn: unknown }>(
      conn,
      `MATCH (m:Metrics)
       WHERE m.symbolId IN $symbolIds
       RETURN m.symbolId AS symbolId, m.fanIn AS fanIn`,
      { symbolIds: fallbackIds },
    );
    for (const row of metricsRows) {
      result.set(row.symbolId, toNumber(row.fanIn));
    }
  }

  // For symbols IN version, count version-scoped incoming edges
  const versionIds = Array.from(inVersion);
  if (versionIds.length > 0) {
    const rows = await queryAll<{ symbolId: string; cnt: unknown }>(
      conn,
      `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(from:Symbol)-[d:DEPENDS_ON]->(to:Symbol)
       WHERE to.symbolId IN $symbolIds
       MATCH (sv:SymbolVersion {versionId: $versionId})
       WHERE sv.symbolId = from.symbolId
       RETURN to.symbolId AS symbolId, count(d) AS cnt`,
      { repoId, symbolIds: versionIds, versionId },
    );
    for (const row of rows) {
      result.set(row.symbolId, toNumber(row.cnt));
    }
  }

  // Ensure all requested symbolIds have entries (default 0)
  for (const id of symbolIds) {
    if (!result.has(id)) result.set(id, 0);
  }

  return result;
}

export interface SliceHandleRow {
  handle: string;
  repoId: string;
  createdAt: string;
  expiresAt: string;
  minVersion: string | null;
  maxVersion: string | null;
  sliceHash: string;
  spilloverRef: string | null;
}

export async function upsertSliceHandle(
  conn: Connection,
  handle: SliceHandleRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (h:SliceHandle {handle: $handle})
     SET h.repoId = $repoId,
         h.createdAt = $createdAt,
         h.expiresAt = $expiresAt,
         h.minVersion = $minVersion,
         h.maxVersion = $maxVersion,
         h.sliceHash = $sliceHash,
         h.spilloverRef = $spilloverRef`,
    {
      handle: handle.handle,
      repoId: handle.repoId,
      createdAt: handle.createdAt,
      expiresAt: handle.expiresAt,
      minVersion: handle.minVersion,
      maxVersion: handle.maxVersion,
      sliceHash: handle.sliceHash,
      spilloverRef: handle.spilloverRef,
    },
  );
}

export async function getSliceHandle(
  conn: Connection,
  handle: string,
): Promise<SliceHandleRow | null> {
  const row = await querySingle<SliceHandleRow>(
    conn,
    `MATCH (h:SliceHandle {handle: $handle})
     RETURN h.handle AS handle,
            h.repoId AS repoId,
            h.createdAt AS createdAt,
            h.expiresAt AS expiresAt,
            h.minVersion AS minVersion,
            h.maxVersion AS maxVersion,
            h.sliceHash AS sliceHash,
            h.spilloverRef AS spilloverRef`,
    { handle },
  );
  return row ?? null;
}

export async function deleteExpiredSliceHandles(
  conn: Connection,
  beforeTimestamp: string,
): Promise<number> {
  const rows = await queryAll<{ handle: string }>(
    conn,
    `MATCH (h:SliceHandle)
     WHERE h.expiresAt < $beforeTimestamp
     RETURN h.handle AS handle`,
    { beforeTimestamp },
  );

  for (const row of rows) {
    await exec(
      conn,
      `MATCH (h:SliceHandle {handle: $handle})
       DELETE h`,
      { handle: row.handle },
    );
  }

  return rows.length;
}

export async function updateSliceHandleSpillover(
  conn: Connection,
  handle: string,
  spilloverRef: string | null,
): Promise<void> {
  await exec(
    conn,
    `MATCH (h:SliceHandle {handle: $handle})
     SET h.spilloverRef = $spilloverRef`,
    { handle, spilloverRef },
  );
}

export interface CardHashRow {
  cardHash: string;
  cardBlob: string;
  createdAt: string;
}

export async function upsertCardHash(
  conn: Connection,
  row: CardHashRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (c:CardHash {cardHash: $cardHash})
     SET c.cardBlob = $cardBlob,
         c.createdAt = $createdAt`,
    {
      cardHash: row.cardHash,
      cardBlob: row.cardBlob,
      createdAt: row.createdAt,
    },
  );
}

export async function getCardHash(
  conn: Connection,
  cardHash: string,
): Promise<CardHashRow | null> {
  const row = await querySingle<CardHashRow>(
    conn,
    `MATCH (c:CardHash {cardHash: $cardHash})
     RETURN c.cardHash AS cardHash,
            c.cardBlob AS cardBlob,
            c.createdAt AS createdAt`,
    { cardHash },
  );
  return row ?? null;
}

export async function upsertMetrics(
  conn: Connection,
  metrics: MetricsRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (m:Metrics {symbolId: $symbolId})
     SET m.fanIn = $fanIn,
         m.fanOut = $fanOut,
         m.churn30d = $churn30d,
         m.testRefsJson = $testRefsJson,
         m.canonicalTestJson = $canonicalTestJson,
         m.updatedAt = $updatedAt`,
    {
      symbolId: metrics.symbolId,
      fanIn: metrics.fanIn,
      fanOut: metrics.fanOut,
      churn30d: metrics.churn30d,
      testRefsJson: metrics.testRefsJson,
      canonicalTestJson: metrics.canonicalTestJson,
      updatedAt: metrics.updatedAt,
    },
  );
}

export async function getMetrics(
  conn: Connection,
  symbolId: string,
): Promise<MetricsRow | null> {
  const row = await querySingle<{
    symbolId: string;
    fanIn: unknown;
    fanOut: unknown;
    churn30d: unknown;
    testRefsJson: string | null;
    canonicalTestJson: string | null;
    updatedAt: string;
  }>(
    conn,
    `MATCH (m:Metrics {symbolId: $symbolId})
     RETURN m.symbolId AS symbolId,
            m.fanIn AS fanIn,
            m.fanOut AS fanOut,
            m.churn30d AS churn30d,
            m.testRefsJson AS testRefsJson,
            m.canonicalTestJson AS canonicalTestJson,
            m.updatedAt AS updatedAt`,
    { symbolId },
  );

  if (!row) return null;

  return {
    symbolId: row.symbolId,
    fanIn: toNumber(row.fanIn),
    fanOut: toNumber(row.fanOut),
    churn30d: toNumber(row.churn30d),
    testRefsJson: row.testRefsJson,
    canonicalTestJson: row.canonicalTestJson,
    updatedAt: row.updatedAt,
  };
}

export async function getMetricsBySymbolIds(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, MetricsRow>> {
  if (symbolIds.length === 0) return new Map();

  const rows = await queryAll<{
    symbolId: string;
    fanIn: unknown;
    fanOut: unknown;
    churn30d: unknown;
    testRefsJson: string | null;
    canonicalTestJson: string | null;
    updatedAt: string;
  }>(
    conn,
    `MATCH (m:Metrics)
     WHERE m.symbolId IN $symbolIds
     RETURN m.symbolId AS symbolId,
            m.fanIn AS fanIn,
            m.fanOut AS fanOut,
            m.churn30d AS churn30d,
            m.testRefsJson AS testRefsJson,
            m.canonicalTestJson AS canonicalTestJson,
            m.updatedAt AS updatedAt`,
    { symbolIds },
  );

  const result = new Map<string, MetricsRow>();
  for (const row of rows) {
    result.set(row.symbolId, {
      symbolId: row.symbolId,
      fanIn: toNumber(row.fanIn),
      fanOut: toNumber(row.fanOut),
      churn30d: toNumber(row.churn30d),
      testRefsJson: row.testRefsJson,
      canonicalTestJson: row.canonicalTestJson,
      updatedAt: row.updatedAt,
    });
  }
  return result;
}

export async function getTopSymbolsByFanIn(
  conn: Connection,
  repoId: string,
  limit = 10,
): Promise<TopSymbolByFanInRow[]> {
  assertSafeInt(limit, "limit");
  limit = Math.max(0, Math.min(limit, 1000));

  const rows = await queryAll<{
    symbolId: string;
    fanIn: unknown;
    fanOut: unknown;
    churn30d: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     MATCH (m:Metrics {symbolId: s.symbolId})
     RETURN s.symbolId AS symbolId,
            m.fanIn AS fanIn,
            m.fanOut AS fanOut,
            m.churn30d AS churn30d
     ORDER BY m.fanIn DESC
     LIMIT $limit`,
    { repoId },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    fanIn: toNumber(row.fanIn),
    fanOut: toNumber(row.fanOut),
    churn30d: toNumber(row.churn30d),
  }));
}

export async function getTopSymbolsByChurn(
  conn: Connection,
  repoId: string,
  limit = 10,
): Promise<TopSymbolByFanInRow[]> {
  assertSafeInt(limit, "limit");
  limit = Math.max(0, Math.min(limit, 1000));

  const rows = await queryAll<{
    symbolId: string;
    fanIn: unknown;
    fanOut: unknown;
    churn30d: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     MATCH (m:Metrics {symbolId: s.symbolId})
     RETURN s.symbolId AS symbolId,
            m.fanIn AS fanIn,
            m.fanOut AS fanOut,
            m.churn30d AS churn30d
     ORDER BY m.churn30d DESC
     LIMIT $limit`,
    { repoId },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    fanIn: toNumber(row.fanIn),
    fanOut: toNumber(row.fanOut),
    churn30d: toNumber(row.churn30d),
  }));
}

export async function computeFanInOut(
  conn: Connection,
  symbolId: string,
): Promise<FanInOut> {
  const row = await querySingle<{
    fanIn: unknown;
    fanOut: unknown;
  }>(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})
     OPTIONAL MATCH (s)<-[i:DEPENDS_ON]-(:Symbol)
     WITH s, count(i) AS fanIn
     OPTIONAL MATCH (s)-[o:DEPENDS_ON]->(:Symbol)
     RETURN fanIn AS fanIn, count(o) AS fanOut`,
    { symbolId },
  );

  if (!row) return { fanIn: 0, fanOut: 0 };

  return {
    fanIn: toNumber(row.fanIn),
    fanOut: toNumber(row.fanOut),
  };
}

export async function batchComputeFanInOut(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, FanInOut>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, FanInOut>();
  for (const symbolId of symbolIds) {
    result.set(symbolId, { fanIn: 0, fanOut: 0 });
  }

  // NOTE: Kuzu can produce incorrect counts for large UNWIND lists, especially
  // when the input list contains many missing symbols. Prefer WHERE ... IN and
  // fill missing IDs in JS.
  const fanInRows = await queryAll<{ symbolId: string; fanIn: unknown }>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolId IN $symbolIds
     OPTIONAL MATCH (s)<-[i:DEPENDS_ON]-(:Symbol)
     RETURN s.symbolId AS symbolId, count(i) AS fanIn`,
    { symbolIds },
  );

  for (const row of fanInRows) {
    const entry = result.get(row.symbolId);
    if (entry) entry.fanIn = toNumber(row.fanIn);
  }

  const fanOutRows = await queryAll<{ symbolId: string; fanOut: unknown }>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolId IN $symbolIds
     OPTIONAL MATCH (s)-[o:DEPENDS_ON]->(:Symbol)
     RETURN s.symbolId AS symbolId, count(o) AS fanOut`,
    { symbolIds },
  );

  for (const row of fanOutRows) {
    const entry = result.get(row.symbolId);
    if (entry) entry.fanOut = toNumber(row.fanOut);
  }

  return result;
}

// ============================================================================
// Auxiliary queries (audit, feedback, embeddings, caches, artifacts)
// ============================================================================

export interface AuditRow {
  eventId: string;
  timestamp: string;
  tool: string;
  decision: string;
  repoId: string | null;
  symbolId: string | null;
  detailsJson: string;
}

export async function insertAuditEvent(
  conn: Connection,
  row: AuditRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (a:Audit {eventId: $eventId})
     SET a.timestamp = $timestamp,
         a.tool = $tool,
         a.decision = $decision,
         a.repoId = $repoId,
         a.symbolId = $symbolId,
         a.detailsJson = $detailsJson`,
    {
      eventId: row.eventId,
      timestamp: row.timestamp,
      tool: row.tool,
      decision: row.decision,
      repoId: row.repoId,
      symbolId: row.symbolId,
      detailsJson: row.detailsJson,
    },
  );
}

export async function getAuditEvents(
  conn: Connection,
  options: {
    repoId?: string;
    sinceTimestamp?: string;
    untilTimestamp?: string;
    limit?: number;
  } = {},
): Promise<AuditRow[]> {
  const safeLimit = options.limit ?? 1000;
  assertSafeInt(safeLimit, "limit");

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.repoId) {
    conditions.push("a.repoId = $repoId");
    params.repoId = options.repoId;
  }

  if (options.sinceTimestamp) {
    conditions.push("a.timestamp >= $sinceTimestamp");
    params.sinceTimestamp = options.sinceTimestamp;
  }

  if (options.untilTimestamp) {
    conditions.push("a.timestamp <= $untilTimestamp");
    params.untilTimestamp = options.untilTimestamp;
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return queryAll<AuditRow>(
    conn,
    `MATCH (a:Audit)
     ${whereClause}
     RETURN a.eventId AS eventId,
            a.timestamp AS timestamp,
            a.tool AS tool,
            a.decision AS decision,
            a.repoId AS repoId,
            a.symbolId AS symbolId,
            a.detailsJson AS detailsJson
     ORDER BY a.timestamp DESC
     LIMIT $limit`,
    params,
  );
}

export interface AgentFeedbackRow {
  feedbackId: string;
  repoId: string;
  versionId: string;
  sliceHandle: string;
  usefulSymbolsJson: string;
  missingSymbolsJson: string;
  taskTagsJson: string | null;
  taskType: string | null;
  taskText: string | null;
  createdAt: string;
}

export async function upsertAgentFeedback(
  conn: Connection,
  row: AgentFeedbackRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (f:AgentFeedback {feedbackId: $feedbackId})
     SET f.repoId = $repoId,
         f.versionId = $versionId,
         f.sliceHandle = $sliceHandle,
         f.usefulSymbolsJson = $usefulSymbolsJson,
         f.missingSymbolsJson = $missingSymbolsJson,
         f.taskTagsJson = $taskTagsJson,
         f.taskType = $taskType,
         f.taskText = $taskText,
         f.createdAt = $createdAt`,
    {
      feedbackId: row.feedbackId,
      repoId: row.repoId,
      versionId: row.versionId,
      sliceHandle: row.sliceHandle,
      usefulSymbolsJson: row.usefulSymbolsJson,
      missingSymbolsJson: row.missingSymbolsJson,
      taskTagsJson: row.taskTagsJson,
      taskType: row.taskType,
      taskText: row.taskText,
      createdAt: row.createdAt,
    },
  );
}

export async function getAgentFeedback(
  conn: Connection,
  feedbackId: string,
): Promise<AgentFeedbackRow | null> {
  const row = await querySingle<AgentFeedbackRow>(
    conn,
    `MATCH (f:AgentFeedback {feedbackId: $feedbackId})
     RETURN f.feedbackId AS feedbackId,
            f.repoId AS repoId,
            f.versionId AS versionId,
            f.sliceHandle AS sliceHandle,
            f.usefulSymbolsJson AS usefulSymbolsJson,
            f.missingSymbolsJson AS missingSymbolsJson,
            f.taskTagsJson AS taskTagsJson,
            f.taskType AS taskType,
            f.taskText AS taskText,
            f.createdAt AS createdAt`,
    { feedbackId },
  );
  return row ?? null;
}

export async function getAgentFeedbackByRepo(
  conn: Connection,
  repoId: string,
  limit: number,
): Promise<AgentFeedbackRow[]> {
  assertSafeInt(limit, "limit");
  return queryAll<AgentFeedbackRow>(
    conn,
    `MATCH (f:AgentFeedback {repoId: $repoId})
     RETURN f.feedbackId AS feedbackId,
            f.repoId AS repoId,
            f.versionId AS versionId,
            f.sliceHandle AS sliceHandle,
            f.usefulSymbolsJson AS usefulSymbolsJson,
            f.missingSymbolsJson AS missingSymbolsJson,
            f.taskTagsJson AS taskTagsJson,
            f.taskType AS taskType,
            f.taskText AS taskText,
            f.createdAt AS createdAt
     ORDER BY f.createdAt DESC
     LIMIT $limit`,
    { repoId },
  );
}

export async function getAgentFeedbackByVersion(
  conn: Connection,
  repoId: string,
  versionId: string,
  limit: number,
): Promise<AgentFeedbackRow[]> {
  assertSafeInt(limit, "limit");
  return queryAll<AgentFeedbackRow>(
    conn,
    `MATCH (f:AgentFeedback {repoId: $repoId, versionId: $versionId})
     RETURN f.feedbackId AS feedbackId,
            f.repoId AS repoId,
            f.versionId AS versionId,
            f.sliceHandle AS sliceHandle,
            f.usefulSymbolsJson AS usefulSymbolsJson,
            f.missingSymbolsJson AS missingSymbolsJson,
            f.taskTagsJson AS taskTagsJson,
            f.taskType AS taskType,
            f.taskText AS taskText,
            f.createdAt AS createdAt
     ORDER BY f.createdAt DESC
     LIMIT $limit`,
    { repoId, versionId },
  );
}

export interface AggregatedFeedback {
  totalFeedback: number;
  symbolPositiveCounts: Map<string, number>;
  symbolNegativeCounts: Map<string, number>;
  taskTypeCounts: Map<string, number>;
}

export async function getAggregatedFeedback(
  conn: Connection,
  repoId: string,
  sinceTimestamp?: string,
): Promise<AggregatedFeedback> {
  const conditions: string[] = ["f.repoId = $repoId"];
  const params: Record<string, unknown> = { repoId };

  if (sinceTimestamp) {
    conditions.push("f.createdAt >= $sinceTimestamp");
    params.sinceTimestamp = sinceTimestamp;
  }

  const rows = await queryAll<Pick<AgentFeedbackRow, "usefulSymbolsJson" | "missingSymbolsJson" | "taskTagsJson" | "taskType">>(
    conn,
    `MATCH (f:AgentFeedback)
     WHERE ${conditions.join(" AND ")}
     RETURN f.usefulSymbolsJson AS usefulSymbolsJson,
            f.missingSymbolsJson AS missingSymbolsJson,
            f.taskTagsJson AS taskTagsJson,
            f.taskType AS taskType
     ORDER BY f.createdAt DESC`,
    params,
  );

  const symbolPositiveCounts = new Map<string, number>();
  const symbolNegativeCounts = new Map<string, number>();
  const taskTypeCounts = new Map<string, number>();

  for (const row of rows) {
    let usefulSymbols: string[];
    let missingSymbols: string[];
    let taskTags: string[];
    try {
      usefulSymbols = JSON.parse(row.usefulSymbolsJson) as string[];
      missingSymbols = JSON.parse(row.missingSymbolsJson) as string[];
      taskTags = row.taskTagsJson ? (JSON.parse(row.taskTagsJson) as string[]) : [];
    } catch {
      continue;
    }

    for (const symbolId of usefulSymbols) {
      symbolPositiveCounts.set(
        symbolId,
        (symbolPositiveCounts.get(symbolId) ?? 0) + 1,
      );
    }

    for (const symbolId of missingSymbols) {
      symbolNegativeCounts.set(
        symbolId,
        (symbolNegativeCounts.get(symbolId) ?? 0) + 1,
      );
    }

    if (row.taskType) {
      taskTypeCounts.set(row.taskType, (taskTypeCounts.get(row.taskType) ?? 0) + 1);
    }

    for (const tag of taskTags) {
      taskTypeCounts.set(tag, (taskTypeCounts.get(tag) ?? 0) + 1);
    }
  }

  return {
    totalFeedback: rows.length,
    symbolPositiveCounts,
    symbolNegativeCounts,
    taskTypeCounts,
  };
}

export interface SymbolEmbeddingRow {
  symbolId: string;
  model: string;
  embeddingVector: string;
  version: string;
  cardHash: string;
  createdAt: string;
  updatedAt: string;
}

export async function upsertSymbolEmbedding(
  conn: Connection,
  row: SymbolEmbeddingRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (e:SymbolEmbedding {symbolId: $symbolId})
     SET e.model = $model,
         e.embeddingVector = $embeddingVector,
         e.version = $version,
         e.cardHash = $cardHash,
         e.createdAt = $createdAt,
         e.updatedAt = $updatedAt`,
    {
      symbolId: row.symbolId,
      model: row.model,
      embeddingVector: row.embeddingVector,
      version: row.version,
      cardHash: row.cardHash,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  );
}

export async function getSymbolEmbedding(
  conn: Connection,
  symbolId: string,
): Promise<SymbolEmbeddingRow | null> {
  const row = await querySingle<SymbolEmbeddingRow>(
    conn,
    `MATCH (e:SymbolEmbedding {symbolId: $symbolId})
     RETURN e.symbolId AS symbolId,
            e.model AS model,
            e.embeddingVector AS embeddingVector,
            e.version AS version,
            e.cardHash AS cardHash,
            e.createdAt AS createdAt,
            e.updatedAt AS updatedAt`,
    { symbolId },
  );
  return row ?? null;
}

export async function getSymbolEmbeddings(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, SymbolEmbeddingRow>> {
  const result = new Map<string, SymbolEmbeddingRow>();
  if (symbolIds.length === 0) return result;

  const rows = await queryAll<SymbolEmbeddingRow>(
    conn,
    `MATCH (e:SymbolEmbedding)
     WHERE e.symbolId IN $symbolIds
     RETURN e.symbolId AS symbolId,
            e.model AS model,
            e.embeddingVector AS embeddingVector,
            e.version AS version,
            e.cardHash AS cardHash,
            e.createdAt AS createdAt,
            e.updatedAt AS updatedAt`,
    { symbolIds },
  );

  for (const row of rows) {
    result.set(row.symbolId, row);
  }

  return result;
}

export async function deleteSymbolEmbeddings(
  conn: Connection,
  symbolIds: string[],
): Promise<void> {
  if (symbolIds.length === 0) return;
  await exec(
    conn,
    `MATCH (e:SymbolEmbedding)
     WHERE e.symbolId IN $symbolIds
     DELETE e`,
    { symbolIds },
  );
}

export interface SummaryCacheRow {
  symbolId: string;
  summary: string;
  provider: string;
  model: string;
  cardHash: string;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

export async function getSummaryCache(
  conn: Connection,
  symbolId: string,
): Promise<SummaryCacheRow | null> {
  const row = await querySingle<{
    symbolId: string;
    summary: string;
    provider: string;
    model: string;
    cardHash: string;
    costUsd: unknown;
    createdAt: string;
    updatedAt: string;
  }>(
    conn,
    `MATCH (c:SummaryCache {symbolId: $symbolId})
     RETURN c.symbolId AS symbolId,
            c.summary AS summary,
            c.provider AS provider,
            c.model AS model,
            c.cardHash AS cardHash,
            c.costUsd AS costUsd,
            c.createdAt AS createdAt,
            c.updatedAt AS updatedAt`,
    { symbolId },
  );

  if (!row) return null;

  return {
    symbolId: row.symbolId,
    summary: row.summary,
    provider: row.provider,
    model: row.model,
    cardHash: row.cardHash,
    costUsd: toNumber(row.costUsd),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertSummaryCache(
  conn: Connection,
  row: SummaryCacheRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (c:SummaryCache {symbolId: $symbolId})
     SET c.summary = $summary,
         c.provider = $provider,
         c.model = $model,
         c.cardHash = $cardHash,
         c.costUsd = $costUsd,
         c.createdAt = $createdAt,
         c.updatedAt = $updatedAt`,
    {
      symbolId: row.symbolId,
      summary: row.summary,
      provider: row.provider,
      model: row.model,
      cardHash: row.cardHash,
      costUsd: row.costUsd,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  );
}

export async function deleteSummaryCacheByRepo(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     MATCH (c:SummaryCache {symbolId: s.symbolId})
     DELETE c`,
    { repoId },
  );
}

export interface SyncArtifactRow {
  artifactId: string;
  repoId: string;
  versionId: string;
  commitSha: string | null;
  branch: string | null;
  artifactHash: string;
  compressedData: string;
  createdAt: string;
  sizeBytes: number;
}

export async function upsertSyncArtifact(
  conn: Connection,
  row: SyncArtifactRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (a:SyncArtifact {artifactId: $artifactId})
     SET a.repoId = $repoId,
         a.versionId = $versionId,
         a.commitSha = $commitSha,
         a.branch = $branch,
         a.artifactHash = $artifactHash,
         a.compressedData = $compressedData,
         a.createdAt = $createdAt,
         a.sizeBytes = $sizeBytes`,
    {
      artifactId: row.artifactId,
      repoId: row.repoId,
      versionId: row.versionId,
      commitSha: row.commitSha,
      branch: row.branch,
      artifactHash: row.artifactHash,
      compressedData: row.compressedData,
      createdAt: row.createdAt,
      sizeBytes: row.sizeBytes,
    },
  );
}

export async function getSyncArtifact(
  conn: Connection,
  artifactId: string,
): Promise<SyncArtifactRow | null> {
  const row = await querySingle<{
    artifactId: string;
    repoId: string;
    versionId: string;
    commitSha: string | null;
    branch: string | null;
    artifactHash: string;
    compressedData: string;
    createdAt: string;
    sizeBytes: unknown;
  }>(
    conn,
    `MATCH (a:SyncArtifact {artifactId: $artifactId})
     RETURN a.artifactId AS artifactId,
            a.repoId AS repoId,
            a.versionId AS versionId,
            a.commitSha AS commitSha,
            a.branch AS branch,
            a.artifactHash AS artifactHash,
            a.compressedData AS compressedData,
            a.createdAt AS createdAt,
            a.sizeBytes AS sizeBytes`,
    { artifactId },
  );

  if (!row) return null;

  return {
    artifactId: row.artifactId,
    repoId: row.repoId,
    versionId: row.versionId,
    commitSha: row.commitSha,
    branch: row.branch,
    artifactHash: row.artifactHash,
    compressedData: row.compressedData,
    createdAt: row.createdAt,
    sizeBytes: toNumber(row.sizeBytes),
  };
}

export async function getSyncArtifactsByRepo(
  conn: Connection,
  repoId: string,
  limit: number,
): Promise<SyncArtifactRow[]> {
  assertSafeInt(limit, "limit");
  const rows = await queryAll<{
    artifactId: string;
    repoId: string;
    versionId: string;
    commitSha: string | null;
    branch: string | null;
    artifactHash: string;
    compressedData: string;
    createdAt: string;
    sizeBytes: unknown;
  }>(
    conn,
    `MATCH (a:SyncArtifact {repoId: $repoId})
     RETURN a.artifactId AS artifactId,
            a.repoId AS repoId,
            a.versionId AS versionId,
            a.commitSha AS commitSha,
            a.branch AS branch,
            a.artifactHash AS artifactHash,
            a.compressedData AS compressedData,
            a.createdAt AS createdAt,
            a.sizeBytes AS sizeBytes
     ORDER BY a.createdAt DESC
     LIMIT $limit`,
    { repoId },
  );

  return rows.map((row) => ({
    artifactId: row.artifactId,
    repoId: row.repoId,
    versionId: row.versionId,
    commitSha: row.commitSha,
    branch: row.branch,
    artifactHash: row.artifactHash,
    compressedData: row.compressedData,
    createdAt: row.createdAt,
    sizeBytes: toNumber(row.sizeBytes),
  }));
}

export interface SymbolReferenceRow {
  refId: string;
  repoId: string;
  symbolName: string;
  fileId: string;
  lineNumber: number | null;
  createdAt: string;
}

export async function insertSymbolReference(
  conn: Connection,
  row: SymbolReferenceRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (sr:SymbolReference {refId: $refId})
     SET sr.repoId = $repoId,
         sr.symbolName = $symbolName,
         sr.fileId = $fileId,
         sr.lineNumber = $lineNumber,
         sr.createdAt = $createdAt`,
    {
      refId: row.refId,
      repoId: row.repoId,
      symbolName: row.symbolName,
      fileId: row.fileId,
      lineNumber: row.lineNumber,
      createdAt: row.createdAt,
    },
  );
}

export async function getTestRefsForSymbol(
  conn: Connection,
  repoId: string,
  symbolName: string,
): Promise<string[]> {
  const rows = await queryAll<{ relPath: string }>(
    conn,
    `MATCH (sr:SymbolReference {repoId: $repoId, symbolName: $symbolName})
     MATCH (f:File {fileId: sr.fileId})
     RETURN DISTINCT f.relPath AS relPath`,
    { repoId, symbolName },
  );
  return rows.map((row) => row.relPath);
}

export async function deleteSymbolReferencesByFileId(
  conn: Connection,
  fileId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (sr:SymbolReference {fileId: $fileId})
     DELETE sr`,
    { fileId },
  );
}

export interface ToolPolicyHashRow {
  policyHash: string;
  policyBlob: string;
  createdAt: string;
}

export async function upsertToolPolicyHash(
  conn: Connection,
  row: ToolPolicyHashRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (p:ToolPolicyHash {policyHash: $policyHash})
     SET p.policyBlob = $policyBlob,
         p.createdAt = $createdAt`,
    {
      policyHash: row.policyHash,
      policyBlob: row.policyBlob,
      createdAt: row.createdAt,
    },
  );
}

export async function getToolPolicyHash(
  conn: Connection,
  policyHash: string,
): Promise<ToolPolicyHashRow | null> {
  const row = await querySingle<ToolPolicyHashRow>(
    conn,
    `MATCH (p:ToolPolicyHash {policyHash: $policyHash})
     RETURN p.policyHash AS policyHash,
            p.policyBlob AS policyBlob,
            p.createdAt AS createdAt`,
    { policyHash },
  );
  return row ?? null;
}

export interface TsconfigHashRow {
  tsconfigHash: string;
  tsconfigBlob: string;
  createdAt: string;
}

export async function upsertTsconfigHash(
  conn: Connection,
  row: TsconfigHashRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (t:TsconfigHash {tsconfigHash: $tsconfigHash})
     SET t.tsconfigBlob = $tsconfigBlob,
         t.createdAt = $createdAt`,
    {
      tsconfigHash: row.tsconfigHash,
      tsconfigBlob: row.tsconfigBlob,
      createdAt: row.createdAt,
    },
  );
}

export async function getTsconfigHash(
  conn: Connection,
  tsconfigHash: string,
): Promise<TsconfigHashRow | null> {
  const row = await querySingle<TsconfigHashRow>(
    conn,
    `MATCH (t:TsconfigHash {tsconfigHash: $tsconfigHash})
     RETURN t.tsconfigHash AS tsconfigHash,
            t.tsconfigBlob AS tsconfigBlob,
            t.createdAt AS createdAt`,
    { tsconfigHash },
  );
  return row ?? null;
}

export interface ClusterRow {
  clusterId: string;
  repoId: string;
  label: string;
  symbolCount: number;
  cohesionScore: number;
  versionId: string | null;
  createdAt: string;
}

export interface ClusterMemberRow {
  symbolId: string;
  membershipScore: number;
}

export interface ClusterForSymbolRow {
  clusterId: string;
  label: string;
  symbolCount: number;
  membershipScore: number;
}

export async function upsertCluster(conn: Connection, row: ClusterRow): Promise<void> {
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (c:Cluster {clusterId: $clusterId})
     SET c.repoId = $repoId,
         c.label = $label,
         c.symbolCount = $symbolCount,
         c.cohesionScore = $cohesionScore,
         c.versionId = $versionId,
         c.createdAt = $createdAt
     MERGE (c)-[:CLUSTER_IN_REPO]->(r)`,
    {
      clusterId: row.clusterId,
      repoId: row.repoId,
      label: row.label,
      symbolCount: row.symbolCount,
      cohesionScore: row.cohesionScore,
      versionId: row.versionId,
      createdAt: row.createdAt,
    },
  );
}

export async function upsertClusterMember(
  conn: Connection,
  row: { symbolId: string; clusterId: string; membershipScore: number },
): Promise<void> {
  await exec(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})
     MATCH (c:Cluster {clusterId: $clusterId})
     MERGE (s)-[m:BELONGS_TO_CLUSTER]->(c)
     SET m.membershipScore = $membershipScore`,
    {
      symbolId: row.symbolId,
      clusterId: row.clusterId,
      membershipScore: row.membershipScore,
    },
  );
}

export async function upsertClusterMembersBatch(
  conn: Connection,
  members: Array<{ symbolId: string; clusterId: string; membershipScore: number }>,
): Promise<void> {
  if (members.length === 0) return;
  for (const member of members) {
    await exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})
       MATCH (c:Cluster {clusterId: $clusterId})
       MERGE (s)-[m:BELONGS_TO_CLUSTER]->(c)
       SET m.membershipScore = $membershipScore`,
      {
        symbolId: member.symbolId,
        clusterId: member.clusterId,
        membershipScore: member.membershipScore,
      },
    );
  }
}

export async function getClusterForSymbol(
  conn: Connection,
  symbolId: string,
): Promise<ClusterForSymbolRow | null> {
  const row = await querySingle<{
    clusterId: string;
    label: string;
    symbolCount: unknown;
    membershipScore: unknown;
  }>(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})-[m:BELONGS_TO_CLUSTER]->(c:Cluster)
     RETURN c.clusterId AS clusterId,
            c.label AS label,
            c.symbolCount AS symbolCount,
            m.membershipScore AS membershipScore`,
    { symbolId },
  );

  if (!row) return null;

  return {
    clusterId: row.clusterId,
    label: row.label,
    symbolCount: toNumber(row.symbolCount),
    membershipScore: Number(row.membershipScore ?? 0),
  };
}

export async function getClustersForSymbols(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, ClusterForSymbolRow>> {
  if (symbolIds.length === 0) return new Map();

  const rows = await queryAll<{
    symbolId: string;
    clusterId: string;
    label: string;
    symbolCount: unknown;
    membershipScore: unknown;
  }>(
    conn,
    `MATCH (s:Symbol)-[m:BELONGS_TO_CLUSTER]->(c:Cluster)
     WHERE s.symbolId IN $symbolIds
     RETURN s.symbolId AS symbolId,
            c.clusterId AS clusterId,
            c.label AS label,
            c.symbolCount AS symbolCount,
            m.membershipScore AS membershipScore
     ORDER BY symbolId ASC, clusterId ASC`,
    { symbolIds },
  );

  const map = new Map<string, ClusterForSymbolRow>();
  for (const row of rows) {
    if (map.has(row.symbolId)) continue;
    map.set(row.symbolId, {
      clusterId: row.clusterId,
      label: row.label,
      symbolCount: toNumber(row.symbolCount),
      membershipScore: Number(row.membershipScore ?? 0),
    });
  }

  return map;
}

export async function getClustersForRepo(
  conn: Connection,
  repoId: string,
): Promise<ClusterRow[]> {
  const rows = await queryAll<{
    clusterId: string;
    label: string;
    symbolCount: unknown;
    cohesionScore: unknown;
    versionId: string | null;
    createdAt: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:CLUSTER_IN_REPO]-(c:Cluster)
     RETURN c.clusterId AS clusterId,
            c.label AS label,
            c.symbolCount AS symbolCount,
            c.cohesionScore AS cohesionScore,
            c.versionId AS versionId,
            c.createdAt AS createdAt
     ORDER BY c.clusterId`,
    { repoId },
  );

  return rows.map((row) => ({
    clusterId: row.clusterId,
    repoId,
    label: row.label,
    symbolCount: toNumber(row.symbolCount),
    cohesionScore: Number(row.cohesionScore ?? 0),
    versionId: row.versionId,
    createdAt: row.createdAt,
  }));
}

export async function getClusterOverviewStats(
  conn: Connection,
  repoId: string,
): Promise<{
  totalClusters: number;
  averageClusterSize: number;
  largestClusters: Array<{ clusterId: string; label: string; size: number }>;
}> {
  const agg = await querySingle<{
    totalClusters: unknown;
    averageClusterSize: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:CLUSTER_IN_REPO]-(c:Cluster)
     RETURN COUNT(c) AS totalClusters,
            AVG(c.symbolCount) AS averageClusterSize`,
    { repoId },
  );

  const top = await queryAll<{
    clusterId: string;
    label: string;
    size: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:CLUSTER_IN_REPO]-(c:Cluster)
     RETURN c.clusterId AS clusterId,
            c.label AS label,
            c.symbolCount AS size
     ORDER BY size DESC, clusterId ASC
     LIMIT 5`,
    { repoId },
  );

  return {
    totalClusters: toNumber(agg?.totalClusters ?? 0),
    averageClusterSize: toNumber(agg?.averageClusterSize ?? 0),
    largestClusters: top.map((row) => ({
      clusterId: row.clusterId,
      label: row.label,
      size: toNumber(row.size),
    })),
  };
}

export async function getClusterMembers(
  conn: Connection,
  clusterId: string,
): Promise<ClusterMemberRow[]> {
  const rows = await queryAll<{
    symbolId: string;
    membershipScore: unknown;
  }>(
    conn,
    `MATCH (s:Symbol)-[m:BELONGS_TO_CLUSTER]->(c:Cluster {clusterId: $clusterId})
     RETURN s.symbolId AS symbolId,
            m.membershipScore AS membershipScore
     ORDER BY symbolId`,
    { clusterId },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    membershipScore: Number(row.membershipScore ?? 0),
  }));
}

export async function getRelatedClusters(
  conn: Connection,
  clusterId: string,
  limit: number = 20,
): Promise<Array<{ clusterId: string; edgeCount: number }>> {
  const rows = await queryAll<{ clusterId: string }>(
    conn,
    `MATCH (c1:Cluster {clusterId: $clusterId})<-[:BELONGS_TO_CLUSTER]-(s:Symbol)
     MATCH (s)-[d:DEPENDS_ON]->(t:Symbol)-[:BELONGS_TO_CLUSTER]->(c2:Cluster)
     WHERE c2.clusterId <> $clusterId
     RETURN c2.clusterId AS clusterId`,
    { clusterId },
  );

  const edgeCounts = new Map<string, number>();
  for (const row of rows) {
    edgeCounts.set(row.clusterId, (edgeCounts.get(row.clusterId) ?? 0) + 1);
  }

  const results = Array.from(edgeCounts.entries()).map(([clusterId, edgeCount]) => ({
    clusterId,
    edgeCount,
  }));

  results.sort(
    (a, b) => b.edgeCount - a.edgeCount || a.clusterId.localeCompare(b.clusterId),
  );

  return results.slice(0, Math.max(1, limit));
}

export async function deleteClustersByRepo(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (c:Cluster {repoId: $repoId})
     OPTIONAL MATCH (:Symbol)-[m:BELONGS_TO_CLUSTER]->(c)
     DELETE m`,
    { repoId },
  );

  await exec(
    conn,
    `MATCH (c:Cluster {repoId: $repoId})-[rel:CLUSTER_IN_REPO]->(:Repo {repoId: $repoId})
     DELETE rel`,
    { repoId },
  );

  await exec(
    conn,
    `MATCH (c:Cluster {repoId: $repoId})
     DELETE c`,
    { repoId },
  );
}

export interface ProcessRow {
  processId: string;
  repoId: string;
  entrySymbolId: string;
  label: string;
  depth: number;
  versionId: string | null;
  createdAt: string;
}

export interface ProcessStepRow {
  symbolId: string;
  stepOrder: number;
  role: string | null;
}

export interface ProcessForSymbolRow {
  processId: string;
  entrySymbolId: string;
  label: string;
  depth: number;
  stepOrder: number;
  role: string | null;
}

export async function upsertProcess(conn: Connection, row: ProcessRow): Promise<void> {
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (p:Process {processId: $processId})
     SET p.repoId = $repoId,
         p.entrySymbolId = $entrySymbolId,
         p.label = $label,
         p.depth = $depth,
         p.versionId = $versionId,
         p.createdAt = $createdAt
     MERGE (p)-[:PROCESS_IN_REPO]->(r)`,
    {
      processId: row.processId,
      repoId: row.repoId,
      entrySymbolId: row.entrySymbolId,
      label: row.label,
      depth: row.depth,
      versionId: row.versionId,
      createdAt: row.createdAt,
    },
  );
}

export async function upsertProcessStep(
  conn: Connection,
  row: { processId: string; symbolId: string; stepOrder: number; role: string },
): Promise<void> {
  await exec(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})
     MATCH (p:Process {processId: $processId})
     MERGE (s)-[r:PARTICIPATES_IN]->(p)
     SET r.stepOrder = $stepOrder,
         r.role = $role`,
    {
      processId: row.processId,
      symbolId: row.symbolId,
      stepOrder: row.stepOrder,
      role: row.role,
    },
  );
}

export async function upsertProcessStepsBatch(
  conn: Connection,
  steps: Array<{ processId: string; symbolId: string; stepOrder: number; role: string }>,
): Promise<void> {
  if (steps.length === 0) return;
  for (const step of steps) {
    await exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})
       MATCH (p:Process {processId: $processId})
       MERGE (s)-[r:PARTICIPATES_IN]->(p)
       SET r.stepOrder = $stepOrder,
           r.role = $role`,
      {
        processId: step.processId,
        symbolId: step.symbolId,
        stepOrder: step.stepOrder,
        role: step.role,
      },
    );
  }
}

export async function getProcessesForSymbol(
  conn: Connection,
  symbolId: string,
): Promise<ProcessForSymbolRow[]> {
  const rows = await queryAll<{
    processId: string;
    entrySymbolId: string;
    label: string;
    depth: unknown;
    stepOrder: unknown;
    role: string | null;
  }>(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})-[r:PARTICIPATES_IN]->(p:Process)
     RETURN p.processId AS processId,
            p.entrySymbolId AS entrySymbolId,
            p.label AS label,
            p.depth AS depth,
            r.stepOrder AS stepOrder,
            r.role AS role
     ORDER BY r.stepOrder ASC, processId ASC`,
    { symbolId },
  );

  return rows.map((row) => ({
    processId: row.processId,
    entrySymbolId: row.entrySymbolId,
    label: row.label,
    depth: toNumber(row.depth),
    stepOrder: toNumber(row.stepOrder),
    role: row.role,
  }));
}

export async function getProcessesForSymbols(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, ProcessForSymbolRow[]>> {
  if (symbolIds.length === 0) return new Map();

  const rows = await queryAll<{
    symbolId: string;
    processId: string;
    entrySymbolId: string;
    label: string;
    depth: unknown;
    stepOrder: unknown;
    role: string | null;
  }>(
    conn,
    `MATCH (s:Symbol)-[r:PARTICIPATES_IN]->(p:Process)
     WHERE s.symbolId IN $symbolIds
     RETURN s.symbolId AS symbolId,
            p.processId AS processId,
            p.entrySymbolId AS entrySymbolId,
            p.label AS label,
            p.depth AS depth,
            r.stepOrder AS stepOrder,
            r.role AS role
     ORDER BY symbolId ASC, r.stepOrder ASC, processId ASC`,
    { symbolIds },
  );

  const map = new Map<string, ProcessForSymbolRow[]>();
  for (const row of rows) {
    const list = map.get(row.symbolId) ?? [];
    list.push({
      processId: row.processId,
      entrySymbolId: row.entrySymbolId,
      label: row.label,
      depth: toNumber(row.depth),
      stepOrder: toNumber(row.stepOrder),
      role: row.role,
    });
    map.set(row.symbolId, list);
  }

  return map;
}

export async function getProcessOverviewStats(
  conn: Connection,
  repoId: string,
): Promise<{
  totalProcesses: number;
  averageDepth: number;
  entryPoints: number;
  longestProcesses: Array<{ processId: string; label: string; depth: number }>;
}> {
  const agg = await querySingle<{
    totalProcesses: unknown;
    averageDepth: unknown;
    entryPoints: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:PROCESS_IN_REPO]-(p:Process)
     RETURN COUNT(p) AS totalProcesses,
            AVG(p.depth) AS averageDepth,
            COUNT(DISTINCT p.entrySymbolId) AS entryPoints`,
    { repoId },
  );

  const top = await queryAll<{
    processId: string;
    label: string;
    depth: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:PROCESS_IN_REPO]-(p:Process)
     RETURN p.processId AS processId,
            p.label AS label,
            p.depth AS depth
     ORDER BY depth DESC, processId ASC
     LIMIT 5`,
    { repoId },
  );

  return {
    totalProcesses: toNumber(agg?.totalProcesses ?? 0),
    averageDepth: toNumber(agg?.averageDepth ?? 0),
    entryPoints: toNumber(agg?.entryPoints ?? 0),
    longestProcesses: top.map((row) => ({
      processId: row.processId,
      label: row.label,
      depth: toNumber(row.depth),
    })),
  };
}

export async function getProcessFlow(
  conn: Connection,
  processId: string,
): Promise<ProcessStepRow[]> {
  const rows = await queryAll<{
    symbolId: string;
    stepOrder: unknown;
    role: string | null;
  }>(
    conn,
    `MATCH (s:Symbol)-[r:PARTICIPATES_IN]->(p:Process {processId: $processId})
     RETURN s.symbolId AS symbolId,
            r.stepOrder AS stepOrder,
            r.role AS role
     ORDER BY r.stepOrder ASC, symbolId ASC`,
    { processId },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    stepOrder: toNumber(row.stepOrder),
    role: row.role,
  }));
}

export async function getProcessStepsAfterSymbol(
  conn: Connection,
  processId: string,
  symbolId: string,
): Promise<ProcessStepRow[]> {
  const rows = await queryAll<{
    symbolId: string;
    stepOrder: unknown;
    role: string | null;
  }>(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})-[r:PARTICIPATES_IN]->(p:Process {processId: $processId})
     WITH p, r.stepOrder AS startOrder
     MATCH (s2:Symbol)-[r2:PARTICIPATES_IN]->(p)
     WHERE r2.stepOrder > startOrder
     RETURN s2.symbolId AS symbolId,
            r2.stepOrder AS stepOrder,
            r2.role AS role
     ORDER BY r2.stepOrder ASC, symbolId ASC`,
    { processId, symbolId },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    stepOrder: toNumber(row.stepOrder),
    role: row.role,
  }));
}

export async function deleteProcessesByRepo(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (p:Process {repoId: $repoId})
     OPTIONAL MATCH (:Symbol)-[m:PARTICIPATES_IN]->(p)
     DELETE m`,
    { repoId },
  );

  await exec(
    conn,
    `MATCH (p:Process {repoId: $repoId})-[rel:PROCESS_IN_REPO]->(:Repo {repoId: $repoId})
     DELETE rel`,
    { repoId },
  );

  await exec(
    conn,
    `MATCH (p:Process {repoId: $repoId})
     DELETE p`,
    { repoId },
  );
}
