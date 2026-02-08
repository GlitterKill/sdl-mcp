import type { Statement } from "better-sqlite3";
import { getDb } from "./db.js";
import { hashContent } from "../util/hashing.js";
import {
  MAX_STATEMENT_CACHE_SIZE,
  DB_CHUNK_SIZE,
  DB_QUERY_LIMIT_DEFAULT,
  DB_QUERY_LIMIT_MAX,
} from "../config/constants.js";
import type {
  RepoRow,
  FileRow,
  SymbolRow,
  EdgeRow,
  VersionRow,
  SymbolVersionRow,
  MetricsRow,
  AuditRow,
  SliceHandleRow,
  CardHashRow,
  ToolPolicyHashRow,
  TsconfigHashRow,
  SymbolReferenceRow,
} from "./schema.js";
import { z } from "zod";

const stmtCache = new Map<string, Statement>();
const stmtCacheOrder: string[] = [];

/**
 * Escapes SQL LIKE wildcard characters (%, _, \) in user input.
 * Prevents unintended pattern matching when user input contains these chars.
 */
function escapeSearchPattern(query: string): string {
  return query.replace(/[%_\\]/g, "\\$&");
}

function stmt(sql: string): Statement {
  let s = stmtCache.get(sql);
  if (s) {
    const idx = stmtCacheOrder.indexOf(sql);
    if (idx !== -1) {
      stmtCacheOrder.splice(idx, 1);
      stmtCacheOrder.push(sql);
    }
  } else {
    s = getDb().prepare(sql);
    stmtCache.set(sql, s);
    stmtCacheOrder.push(sql);

    if (stmtCache.size > MAX_STATEMENT_CACHE_SIZE) {
      const oldest = stmtCacheOrder.shift();
      if (oldest) {
        stmtCache.delete(oldest);
      }
    }
  }
  return s;
}

// Repo operations
/**
 * Creates a new repository record in the database.
 *
 * @param repo - Repository record with repo_id, root_path, config_json, and created_at
 */
export function createRepo(repo: RepoRow): void {
  stmt(
    "INSERT INTO repos (repo_id, root_path, config_json, created_at) VALUES (?, ?, ?, ?)",
  ).run(repo.repo_id, repo.root_path, repo.config_json, repo.created_at);
}

/**
 * Retrieves a repository by ID.
 *
 * @param repoId - Repository identifier
 * @returns Repository record or null if not found
 */
export function getRepo(repoId: string): RepoRow | null {
  return stmt("SELECT * FROM repos WHERE repo_id = ?").get(
    repoId,
  ) as RepoRow | null;
}

/**
 * Lists all repositories in the database.
 *
 * @returns Array of all repository records
 */
export function listRepos(): RepoRow[] {
  return stmt("SELECT * FROM repos").all() as RepoRow[];
}

/**
 * Updates repository root_path and config_json by ID.
 *
 * @param repoId - Repository identifier
 * @param updates - Partial repository record with fields to update (only root_path and config_json are supported)
 */
export function updateRepo(repoId: string, updates: Partial<RepoRow>): void {
  stmt(
    "UPDATE repos SET root_path = coalesce(?, root_path), config_json = coalesce(?, config_json) WHERE repo_id = ?",
  ).run(updates.root_path ?? null, updates.config_json ?? null, repoId);
}

// File operations
/**
 * Inserts or updates a file record.
 * Uses upsert semantics to handle both new and existing files.
 *
 * @param file - File record without file_id (auto-generated) and directory (computed)
 */
export function upsertFile(file: Omit<FileRow, "file_id" | "directory">): void {
  const directory = file.rel_path.includes("/")
    ? file.rel_path.substring(0, file.rel_path.lastIndexOf("/"))
    : "";

  stmt(
    `INSERT INTO files (repo_id, rel_path, content_hash, language, byte_size, last_indexed_at, directory)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, rel_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      language = excluded.language,
      byte_size = excluded.byte_size,
      last_indexed_at = excluded.last_indexed_at,
      directory = excluded.directory`,
  ).run(
    file.repo_id,
    file.rel_path,
    file.content_hash,
    file.language,
    file.byte_size,
    file.last_indexed_at,
    directory,
  );
}

/**
 * Retrieves a file by ID.
 *
 * @param fileId - File identifier
 * @returns File record or null if not found
 */
export function getFile(fileId: number): FileRow | null {
  return stmt("SELECT * FROM files WHERE file_id = ?").get(
    fileId,
  ) as FileRow | null;
}

/**
 * Lists all files for a repository.
 *
 * @param repoId - Repository identifier
 * @returns Array of file records for the repository
 */
export function getFilesByRepo(repoId: string): FileRow[] {
  return stmt("SELECT * FROM files WHERE repo_id = ?").all(repoId) as FileRow[];
}

/**
 * Lists all files for a repository with minimal projection.
 * Returns only file_id and rel_path for lightweight lookups.
 *
 * @param repoId - Repository identifier
 * @returns Array of file records with minimal fields
 */
export function getFilesByRepoLite(
  repoId: string,
): Pick<FileRow, "file_id" | "rel_path">[] {
  return stmt("SELECT file_id, rel_path FROM files WHERE repo_id = ?").all(
    repoId,
  ) as Pick<FileRow, "file_id" | "rel_path">[];
}

/**
 * Retrieves a file by repository ID and relative path.
 *
 * @param repoId - Repository identifier
 * @param relPath - Relative path within repository
 * @returns File record or null if not found
 */
export function getFileByRepoPath(
  repoId: string,
  relPath: string,
): FileRow | null {
  return stmt("SELECT * FROM files WHERE repo_id = ? AND rel_path = ?").get(
    repoId,
    relPath,
  ) as FileRow | null;
}

/**
 * Deletes a file record by ID.
 *
 * @param fileId - File identifier
 */
export function deleteFile(fileId: number): void {
  stmt("DELETE FROM files WHERE file_id = ?").run(fileId);
}

/**
 * Batch fetch files by IDs. Uses chunked queries to avoid SQLite parameter limits.
 * Returns a Map for O(1) lookup by file_id.
 */
export function getFilesByIds(fileIds: number[]): Map<number, FileRow> {
  if (fileIds.length === 0) return new Map();

  const result = new Map<number, FileRow>();
  const uniqueIds = [...new Set(fileIds)]; // Deduplicate

  for (let i = 0; i < uniqueIds.length; i += DB_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + DB_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = getDb()
      .prepare(`SELECT * FROM files WHERE file_id IN (${placeholders})`)
      .all(...chunk) as FileRow[];

    for (const row of rows) {
      result.set(row.file_id, row);
    }
  }

  return result;
}

/**
 * Batch fetch files by IDs with minimal projection.
 * Returns only file_id and rel_path for lightweight lookups.
 * Uses chunked queries to avoid SQLite parameter limits.
 *
 * @param fileIds - Array of file identifiers
 * @returns Map of file_id to minimal file record
 */
export function getFilesByIdsLite(
  fileIds: number[],
): Map<number, Pick<FileRow, "file_id" | "rel_path">> {
  if (fileIds.length === 0) return new Map();

  const result = new Map<number, Pick<FileRow, "file_id" | "rel_path">>();
  const uniqueIds = [...new Set(fileIds)]; // Deduplicate

  for (let i = 0; i < uniqueIds.length; i += DB_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + DB_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT file_id, rel_path FROM files WHERE file_id IN (${placeholders})`,
      )
      .all(...chunk) as Pick<FileRow, "file_id" | "rel_path">[];

    for (const row of rows) {
      result.set(row.file_id, row);
    }
  }

  return result;
}

// Symbol operations
/**
 * Inserts or updates a symbol record.
 * Uses upsert semantics to handle both new and existing symbols.
 *
 * @param symbol - Complete symbol record with all fields
 */
export function upsertSymbol(symbol: SymbolRow): void {
  stmt(
    `INSERT INTO symbols (
      symbol_id, repo_id, file_id, kind, name, exported, visibility, language,
      range_start_line, range_start_col, range_end_line, range_end_col,
      ast_fingerprint, signature_json, summary, invariants_json, side_effects_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol_id) DO UPDATE SET
      repo_id = excluded.repo_id,
      file_id = excluded.file_id,
      kind = excluded.kind,
      name = excluded.name,
      exported = excluded.exported,
      visibility = excluded.visibility,
      language = excluded.language,
      range_start_line = excluded.range_start_line,
      range_start_col = excluded.range_start_col,
      range_end_line = excluded.range_end_line,
      range_end_col = excluded.range_end_col,
      ast_fingerprint = excluded.ast_fingerprint,
      signature_json = excluded.signature_json,
      summary = excluded.summary,
      invariants_json = excluded.invariants_json,
      side_effects_json = excluded.side_effects_json,
      updated_at = excluded.updated_at`,
  ).run(
    symbol.symbol_id,
    symbol.repo_id,
    symbol.file_id,
    symbol.kind,
    symbol.name,
    symbol.exported,
    symbol.visibility,
    symbol.language,
    symbol.range_start_line,
    symbol.range_start_col,
    symbol.range_end_line,
    symbol.range_end_col,
    symbol.ast_fingerprint,
    symbol.signature_json,
    symbol.summary,
    symbol.invariants_json,
    symbol.side_effects_json,
    symbol.updated_at,
  );
}

/**
 * Retrieves a symbol by ID.
 *
 * @param symbolId - Symbol identifier
 * @returns Symbol record or null if not found
 */
export function getSymbol(symbolId: string): SymbolRow | null {
  return stmt("SELECT * FROM symbols WHERE symbol_id = ?").get(
    symbolId,
  ) as SymbolRow | null;
}

/**
 * Lists all symbols for a file.
 *
 * @param fileId - File identifier
 * @returns Array of symbol records for the file
 */
export function getSymbolsByFile(fileId: number): SymbolRow[] {
  return stmt("SELECT * FROM symbols WHERE file_id = ?").all(
    fileId,
  ) as SymbolRow[];
}

/**
 * Lists all symbol IDs for a file (minimal projection).
 * Use when only symbol IDs are needed, not full records.
 *
 * @param fileId - File identifier
 * @returns Array of symbol identifiers
 */
export function getSymbolIdsByFile(fileId: number): string[] {
  return stmt("SELECT symbol_id FROM symbols WHERE file_id = ?")
    .all(fileId)
    .map((row) => (row as { symbol_id: string }).symbol_id);
}

/**
 * Lists all symbols for a file with minimal projection.
 * Returns symbol_id, name, exported for import resolution.
 *
 * @param fileId - File identifier
 * @returns Array of symbol records with minimal fields
 */
export function getSymbolsByFileLite(
  fileId: number,
): Pick<SymbolRow, "symbol_id" | "name" | "exported">[] {
  return stmt(
    "SELECT symbol_id, name, exported FROM symbols WHERE file_id = ?",
  ).all(fileId) as Pick<SymbolRow, "symbol_id" | "name" | "exported">[];
}

/**
 * Lists all symbols for a repository.
 *
 * @param repoId - Repository identifier
 * @returns Array of all symbol records for repository
 */
export function getSymbolsByRepo(repoId: string): SymbolRow[] {
  return stmt("SELECT * FROM symbols WHERE repo_id = ?").all(
    repoId,
  ) as SymbolRow[];
}

/**
 * Lists all symbols for a repository with version snapshot projection.
 * Returns only fields needed for versioning: symbol_id, ast_fingerprint, signature_json,
 * summary, invariants_json, side_effects_json.
 *
 * @param repoId - Repository identifier
 * @returns Array of symbol records for snapshot
 */
export function getSymbolsByRepoForSnapshot(
  repoId: string,
): Pick<
  SymbolRow,
  | "symbol_id"
  | "ast_fingerprint"
  | "signature_json"
  | "summary"
  | "invariants_json"
  | "side_effects_json"
>[] {
  return stmt(
    `SELECT symbol_id, ast_fingerprint, signature_json, summary, invariants_json, side_effects_json
     FROM symbols WHERE repo_id = ?`,
  ).all(repoId) as Pick<
    SymbolRow,
    | "symbol_id"
    | "ast_fingerprint"
    | "signature_json"
    | "summary"
    | "invariants_json"
    | "side_effects_json"
  >[];
}

export function countSymbolsByRepo(repoId: string): number {
  const result = stmt(
    "SELECT COUNT(*) as count FROM symbols WHERE repo_id = ?",
  ).get(repoId) as { count: number };
  return result.count;
}

/**
 * Batch fetch symbols by IDs. Uses chunked queries to avoid SQLite parameter limits.
 * Returns a Map for O(1) lookup by symbol_id.
 *
 * @param symbolIds - Array of symbol identifiers
 * @returns Map of symbol_id to SymbolRow
 */
export function getSymbolsByIds(symbolIds: string[]): Map<string, SymbolRow> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, SymbolRow>();

  for (let i = 0; i < symbolIds.length; i += DB_CHUNK_SIZE) {
    const chunk = symbolIds.slice(i, i + DB_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = getDb()
      .prepare(`SELECT * FROM symbols WHERE symbol_id IN (${placeholders})`)
      .all(...chunk) as SymbolRow[];

    for (const row of rows) {
      result.set(row.symbol_id, row);
    }
  }

  return result;
}

/**
 * Batch fetch symbols by IDs with minimal projection.
 * Returns only symbol_id, name, file_id for lightweight lookups.
 * Uses chunked queries to avoid SQLite parameter limits.
 *
 * @param symbolIds - Array of symbol identifiers
 * @returns Map of symbol_id to minimal symbol record
 */
export function getSymbolsByIdsLite(
  symbolIds: string[],
): Map<string, Pick<SymbolRow, "symbol_id" | "name" | "file_id">> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<
    string,
    Pick<SymbolRow, "symbol_id" | "name" | "file_id">
  >();

  for (let i = 0; i < symbolIds.length; i += DB_CHUNK_SIZE) {
    const chunk = symbolIds.slice(i, i + DB_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT symbol_id, name, file_id FROM symbols WHERE symbol_id IN (${placeholders})`,
      )
      .all(...chunk) as Pick<SymbolRow, "symbol_id" | "name" | "file_id">[];

    for (const row of rows) {
      result.set(row.symbol_id, row);
    }
  }

  return result;
}

/**
 * Searches symbols by name or summary with LIKE pattern matching.
 * Returns full symbol records with all fields.
 *
 * @param repoId - Repository identifier
 * @param query - Search query string
 * @param limit - Maximum number of results to return
 * @returns Array of matching symbol records
 */
export function searchSymbols(
  repoId: string,
  query: string,
  limit: number,
): SymbolRow[] {
  const searchPattern = `%${escapeSearchPattern(query)}%`;
  // Order results by relevance:
  // 1. Exact name match (case-sensitive) first
  // 2. Exact name match (case-insensitive) second
  // 3. Prefer core files over adapter/test files (deprioritize adapter/, tests/, scripts/)
  // 4. Important symbol kinds (class, function, interface, type, method) before variables
  // 5. Name matches before summary-only matches
  return stmt(
    `SELECT s.* FROM symbols s
     JOIN files f ON s.file_id = f.file_id
     WHERE s.repo_id = ? AND (s.name LIKE ? ESCAPE '\\' OR s.summary LIKE ? ESCAPE '\\')
     ORDER BY
       CASE WHEN s.name = ? THEN 0 ELSE 1 END,
       CASE WHEN LOWER(s.name) = LOWER(?) THEN 0 ELSE 1 END,
       CASE
         WHEN f.rel_path LIKE '%/adapter/%' THEN 2
         WHEN f.rel_path LIKE '%/tests/%' OR f.rel_path LIKE 'tests/%' THEN 2
         WHEN f.rel_path LIKE 'scripts/%' THEN 2
         WHEN f.rel_path LIKE '%.test.%' OR f.rel_path LIKE '%.spec.%' THEN 2
         ELSE 0
       END,
       CASE s.kind
         WHEN 'class' THEN 0
         WHEN 'function' THEN 1
         WHEN 'interface' THEN 2
         WHEN 'type' THEN 3
         WHEN 'method' THEN 4
         WHEN 'constructor' THEN 5
         WHEN 'module' THEN 6
         ELSE 7
       END,
       CASE WHEN s.name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END
     LIMIT ?`,
  ).all(
    repoId,
    searchPattern,
    searchPattern,
    query,
    query,
    searchPattern,
    limit,
  ) as SymbolRow[];
}

/**
 * Searches symbols by name or summary with LIKE pattern matching.
 * Returns minimal projection: only symbol_id, name, file_id, kind.
 * Use for search result listings where full symbol data is not needed.
 *
 * @param repoId - Repository identifier
 * @param query - Search query string
 * @param limit - Maximum number of results to return
 * @returns Array of symbol records with minimal fields
 */
export function searchSymbolsLite(
  repoId: string,
  query: string,
  limit: number,
): Pick<SymbolRow, "symbol_id" | "name" | "file_id" | "kind">[] {
  const searchPattern = `%${escapeSearchPattern(query)}%`;
  // Order results by relevance (same logic as searchSymbols)
  return stmt(
    `SELECT s.symbol_id, s.name, s.file_id, s.kind FROM symbols s
     JOIN files f ON s.file_id = f.file_id
     WHERE s.repo_id = ? AND (s.name LIKE ? ESCAPE '\\' OR s.summary LIKE ? ESCAPE '\\')
     ORDER BY
       CASE WHEN s.name = ? THEN 0 ELSE 1 END,
       CASE WHEN LOWER(s.name) = LOWER(?) THEN 0 ELSE 1 END,
       CASE
         WHEN f.rel_path LIKE '%/adapter/%' THEN 2
         WHEN f.rel_path LIKE '%/tests/%' OR f.rel_path LIKE 'tests/%' THEN 2
         WHEN f.rel_path LIKE 'scripts/%' THEN 2
         WHEN f.rel_path LIKE '%.test.%' OR f.rel_path LIKE '%.spec.%' THEN 2
         ELSE 0
       END,
       CASE s.kind
         WHEN 'class' THEN 0
         WHEN 'function' THEN 1
         WHEN 'interface' THEN 2
         WHEN 'type' THEN 3
         WHEN 'method' THEN 4
         WHEN 'constructor' THEN 5
         WHEN 'module' THEN 6
         ELSE 7
       END,
       CASE WHEN s.name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END
     LIMIT ?`,
  ).all(
    repoId,
    searchPattern,
    searchPattern,
    query,
    query,
    searchPattern,
    limit,
  ) as Pick<SymbolRow, "symbol_id" | "name" | "file_id" | "kind">[];
}

/**
 * Finds symbols within a line range, sorted by containment.
 * Returns fully contained symbols first, then overlapping.
 *
 * @param repoId - Repository identifier
 * @param fileId - File identifier
 * @param startLine - Start line of range (1-indexed)
 * @param endLine - End line of range (1-indexed)
 * @returns Array of symbol records sorted by containment
 */
export function findSymbolsInRange(
  repoId: string,
  fileId: number,
  startLine: number,
  endLine: number,
): SymbolRow[] {
  return stmt(
    `SELECT * FROM symbols
     WHERE repo_id = ? AND file_id = ?
     AND range_start_line <= ? AND range_end_line >= ?
     ORDER BY
       CASE
         WHEN range_start_line >= ? AND range_end_line <= ? THEN 0
         WHEN range_start_line <= ? AND range_end_line >= ? THEN 1
         WHEN range_start_line >= ? AND range_start_line <= ? THEN 2
         WHEN range_end_line >= ? AND range_end_line <= ? THEN 3
         ELSE 4
       END,
       ABS(range_start_line - ?)`,
  ).all(
    repoId,
    fileId,
    endLine,
    startLine,
    startLine,
    endLine,
    startLine,
    endLine,
    startLine,
    endLine,
    startLine,
    endLine,
    startLine,
    startLine,
  ) as SymbolRow[];
}

/**
 * Finds symbols within a line range with minimal projection.
 * Returns only symbol_id for diagnostic mapping.
 *
 * @param repoId - Repository identifier
 * @param fileId - File identifier
 * @param startLine - Start line of range (1-indexed)
 * @param endLine - End line of range (1-indexed)
 * @returns Array of symbol IDs sorted by containment
 */
export function findSymbolsInRangeLite(
  repoId: string,
  fileId: number,
  startLine: number,
  endLine: number,
): Pick<SymbolRow, "symbol_id">[] {
  return stmt(
    `SELECT symbol_id FROM symbols
     WHERE repo_id = ? AND file_id = ?
     AND range_start_line <= ? AND range_end_line >= ?
     ORDER BY
       CASE
         WHEN range_start_line >= ? AND range_end_line <= ? THEN 0
         WHEN range_start_line <= ? AND range_end_line >= ? THEN 1
         WHEN range_start_line >= ? AND range_start_line <= ? THEN 2
         WHEN range_end_line >= ? AND range_end_line <= ? THEN 3
         ELSE 4
       END,
       ABS(range_start_line - ?)`,
  ).all(
    repoId,
    fileId,
    endLine,
    startLine,
    startLine,
    endLine,
    startLine,
    endLine,
    startLine,
    endLine,
    startLine,
    endLine,
    startLine,
    startLine,
  ) as Pick<SymbolRow, "symbol_id">[];
}

/**
 * Deletes all symbols for a file.
 *
 * @param fileId - File identifier
 */
export function deleteSymbolsByFile(fileId: number): void {
  stmt("DELETE FROM symbols WHERE file_id = ?").run(fileId);
}

/**
 * Deletes all symbols for a file along with their edges, metrics, and versions.
 * Runs within a transaction for atomicity.
 *
 * @param fileId - File identifier
 */
export function deleteSymbolsByFileWithEdges(fileId: number): void {
  const db = getDb();
  const deleteTx = db.transaction(() => {
    const symbols = getSymbolsByFile(fileId);
    for (const symbol of symbols) {
      stmt("DELETE FROM symbols WHERE symbol_id = ?").run(symbol.symbol_id);
    }
  });
  deleteTx();
}

// Edge operations
/**
 * Creates a new edge record.
 *
 * @param edge - Edge record with all required fields
 */
export function createEdge(edge: EdgeRow): void {
  stmt(
    "INSERT INTO edges (repo_id, from_symbol_id, to_symbol_id, type, weight, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    edge.repo_id,
    edge.from_symbol_id,
    edge.to_symbol_id,
    edge.type,
    edge.weight,
    edge.provenance,
    edge.created_at,
  );
}

/**
 * Retrieves outgoing edges for a symbol.
 *
 * @param symbolId - Symbol identifier
 * @returns Array of outgoing edge records
 */
export function getEdgesFrom(symbolId: string): EdgeRow[] {
  return stmt("SELECT * FROM edges WHERE from_symbol_id = ?").all(
    symbolId,
  ) as EdgeRow[];
}

/**
 * Retrieves incoming edges for a symbol.
 * Used by scripts/dump-symbol.ts for symbol analysis.
 *
 * @param symbolId - Symbol identifier
 * @returns Array of incoming edge records
 */
export function getEdgesTo(symbolId: string): EdgeRow[] {
  return stmt("SELECT * FROM edges WHERE to_symbol_id = ?").all(
    symbolId,
  ) as EdgeRow[];
}

/**
 * Lists all edges for a repository.
 *
 * @param repoId - Repository identifier
 * @returns Array of all edge records for repository
 */
export function getEdgesByRepo(repoId: string): EdgeRow[] {
  return stmt("SELECT * FROM edges WHERE repo_id = ?").all(repoId) as EdgeRow[];
}

/**
 * Batch fetch outgoing edges for multiple symbols. Uses chunked queries.
 * Returns a Map where key is from_symbol_id and value is array of edges.
 *
 * @param symbolIds - Array of symbol identifiers
 * @returns Map of symbol_id to array of outgoing edges
 */
export function getEdgesFromSymbols(
  symbolIds: string[],
): Map<string, EdgeRow[]> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, EdgeRow[]>();
  // Initialize empty arrays for all requested symbols
  for (const id of symbolIds) {
    result.set(id, []);
  }

  for (let i = 0; i < symbolIds.length; i += DB_CHUNK_SIZE) {
    const chunk = symbolIds.slice(i, i + DB_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = getDb()
      .prepare(`SELECT * FROM edges WHERE from_symbol_id IN (${placeholders})`)
      .all(...chunk) as EdgeRow[];

    for (const row of rows) {
      const edges = result.get(row.from_symbol_id);
      if (edges) {
        edges.push(row);
      }
    }
  }

  return result;
}

/**
 * Batch fetch outgoing edges for multiple symbols with minimal projection.
 * Returns only from_symbol_id, to_symbol_id, type for dependency tracking.
 * Uses chunked queries to avoid SQLite parameter limits.
 *
 * @param symbolIds - Array of symbol identifiers
 * @returns Map of symbol_id to array of minimal edge records
 */
export function getEdgesFromSymbolsLite(
  symbolIds: string[],
): Map<string, Pick<EdgeRow, "from_symbol_id" | "to_symbol_id" | "type">[]> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<
    string,
    Pick<EdgeRow, "from_symbol_id" | "to_symbol_id" | "type">[]
  >();
  // Initialize empty arrays for all requested symbols
  for (const id of symbolIds) {
    result.set(id, []);
  }

  for (let i = 0; i < symbolIds.length; i += DB_CHUNK_SIZE) {
    const chunk = symbolIds.slice(i, i + DB_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT from_symbol_id, to_symbol_id, type FROM edges WHERE from_symbol_id IN (${placeholders})`,
      )
      .all(...chunk) as Pick<
      EdgeRow,
      "from_symbol_id" | "to_symbol_id" | "type"
    >[];

    for (const row of rows) {
      const edges = result.get(row.from_symbol_id);
      if (edges) {
        edges.push(row);
      }
    }
  }

  return result;
}

/**
 * Deletes all edges (both incoming and outgoing) for a symbol.
 *
 * @param symbolId - Symbol identifier
 */
export function deleteEdgesBySymbol(symbolId: string): void {
  stmt("DELETE FROM edges WHERE from_symbol_id = ? OR to_symbol_id = ?").run(
    symbolId,
    symbolId,
  );
}

// Version operations
export function createVersion(version: VersionRow): void {
  stmt(
    "INSERT INTO versions (version_id, repo_id, created_at, reason) VALUES (?, ?, ?, ?)",
  ).run(
    version.version_id,
    version.repo_id,
    version.created_at,
    version.reason,
  );
}

export function getVersion(versionId: string): VersionRow | null {
  return stmt("SELECT * FROM versions WHERE version_id = ?").get(
    versionId,
  ) as VersionRow | null;
}

export function getLatestVersion(repoId: string): VersionRow | null {
  return stmt(
    "SELECT * FROM versions WHERE repo_id = ? ORDER BY created_at DESC LIMIT 1",
  ).get(repoId) as VersionRow | null;
}

export function listVersions(
  repoId: string,
  limit: number = DB_QUERY_LIMIT_DEFAULT,
): VersionRow[] {
  return stmt(
    "SELECT * FROM versions WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(repoId, limit) as VersionRow[];
}

// Symbol version operations
export function snapshotSymbolVersion(
  versionId: string,
  symbolId: string,
  snapshot: SymbolVersionRow,
): void {
  stmt(
    `INSERT INTO symbol_versions (version_id, symbol_id, ast_fingerprint, signature_json, summary, invariants_json, side_effects_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(version_id, symbol_id) DO UPDATE SET
     ast_fingerprint = excluded.ast_fingerprint,
     signature_json = excluded.signature_json,
     summary = excluded.summary,
     invariants_json = excluded.invariants_json,
     side_effects_json = excluded.side_effects_json`,
  ).run(
    versionId,
    symbolId,
    snapshot.ast_fingerprint,
    snapshot.signature_json,
    snapshot.summary,
    snapshot.invariants_json,
    snapshot.side_effects_json,
  );
}

export function getSymbolVersion(
  versionId: string,
  symbolId: string,
): SymbolVersionRow | null {
  return stmt(
    "SELECT * FROM symbol_versions WHERE version_id = ? AND symbol_id = ?",
  ).get(versionId, symbolId) as SymbolVersionRow | null;
}

// Metrics operations
export function upsertMetrics(metrics: {
  symbolId: string;
  fanIn: number;
  fanOut: number;
  churn30d: number;
  testRefsJson: string;
  updatedAt: string;
}): void {
  stmt(
    `INSERT INTO metrics (symbol_id, fan_in, fan_out, churn_30d, test_refs_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol_id) DO UPDATE SET
     fan_in = excluded.fan_in,
     fan_out = excluded.fan_out,
     churn_30d = excluded.churn_30d,
     test_refs_json = excluded.test_refs_json,
     updated_at = excluded.updated_at`,
  ).run(
    metrics.symbolId,
    metrics.fanIn,
    metrics.fanOut,
    metrics.churn30d,
    metrics.testRefsJson,
    metrics.updatedAt,
  );
}

export function getMetrics(symbolId: string): MetricsRow | null {
  return stmt("SELECT * FROM metrics WHERE symbol_id = ?").get(
    symbolId,
  ) as MetricsRow | null;
}

/**
 * Batch fetch metrics by symbol IDs. Uses chunked queries to avoid SQLite parameter limits.
 * Returns a Map for O(1) lookup by symbol_id.
 */
export function getMetricsBySymbolIds(
  symbolIds: string[],
): Map<string, MetricsRow> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, MetricsRow>();

  for (let i = 0; i < symbolIds.length; i += DB_CHUNK_SIZE) {
    const chunk = symbolIds.slice(i, i + DB_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = getDb()
      .prepare(`SELECT * FROM metrics WHERE symbol_id IN (${placeholders})`)
      .all(...chunk) as MetricsRow[];

    for (const row of rows) {
      result.set(row.symbol_id, row);
    }
  }

  return result;
}

const AuditEventSchema = z.object({
  timestamp: z.string(),
  tool: z.string(),
  decision: z.string(),
  repoId: z.string().optional(),
  symbolId: z.string().optional(),
  detailsJson: z.string(),
});

export function logAuditEvent(event: {
  timestamp: string;
  tool: string;
  decision: string;
  repoId?: string;
  symbolId?: string;
  detailsJson: string;
}): void {
  const validated = AuditEventSchema.parse(event);
  stmt(
    "INSERT INTO audit (timestamp, tool, decision, repo_id, symbol_id, details_json) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    validated.timestamp,
    validated.tool,
    validated.decision,
    validated.repoId ?? null,
    validated.symbolId ?? null,
    validated.detailsJson,
  );
}

export function getAuditEvents(repoId?: string, limit?: number): AuditRow[] {
  return stmt(
    `SELECT * FROM audit
     WHERE (? IS NULL OR repo_id = ?)
     ORDER BY timestamp DESC
     LIMIT ?`,
  ).all(
    repoId ?? null,
    repoId ?? null,
    limit ?? DB_QUERY_LIMIT_MAX,
  ) as AuditRow[];
}

// Transaction helpers
export function createRepoTransaction(repo: RepoRow): void {
  const db = getDb();
  const createTx = db.transaction(() => {
    createRepo(repo);
  });
  createTx();
}

export function upsertFileTransaction(
  file: Omit<FileRow, "file_id" | "directory">,
): void {
  const db = getDb();
  const upsertTx = db.transaction(() => {
    upsertFile(file);
  });
  upsertTx();
}

export function upsertSymbolTransaction(symbol: SymbolRow): void {
  const db = getDb();
  const upsertTx = db.transaction(() => {
    upsertSymbol(symbol);
  });
  upsertTx();
}

export function createEdgeTransaction(edge: EdgeRow): void {
  const db = getDb();
  const createTx = db.transaction(() => {
    createEdge(edge);
  });
  createTx();
}

export function createVersionTransaction(version: VersionRow): void {
  const db = getDb();
  const createTx = db.transaction(() => {
    createVersion(version);
  });
  createTx();
}

export function deleteFileTransaction(fileId: number): void {
  const db = getDb();
  const deleteTx = db.transaction(() => {
    deleteSymbolsByFileWithEdges(fileId);
    deleteSymbolReferencesByFileId(fileId);
    deleteFile(fileId);
  });
  deleteTx();
}

export function deleteSymbolTransaction(symbolId: string): void {
  const db = getDb();
  const deleteTx = db.transaction(() => {
    deleteEdgesBySymbol(symbolId);
    stmt("DELETE FROM metrics WHERE symbol_id = ?").run(symbolId);
    stmt("DELETE FROM symbol_versions WHERE symbol_id = ?").run(symbolId);
    stmt("DELETE FROM symbols WHERE symbol_id = ?").run(symbolId);
  });
  deleteTx();
}

export function createSnapshotTransaction(
  version: VersionRow,
  snapshots: SymbolVersionRow[],
): void {
  const db = getDb();
  const snapshotTx = db.transaction(() => {
    createVersion(version);
    for (const snapshot of snapshots) {
      snapshotSymbolVersion(version.version_id, snapshot.symbol_id, snapshot);
    }

    const sortedVersions = [...snapshots].sort((a, b) =>
      a.symbol_id.localeCompare(b.symbol_id),
    );

    const fingerprints = sortedVersions
      .map((sv) => sv.ast_fingerprint)
      .join("|");
    const combined = `${version.prev_version_hash || "none"}:${fingerprints}`;
    const versionHash = hashContent(combined);

    updateVersionHashes(
      version.version_id,
      version.prev_version_hash,
      versionHash,
    );
  });
  snapshotTx();
}

// Slice handle operations
export function createSliceHandle(handle: SliceHandleRow): void {
  stmt(
    `INSERT INTO slice_handles (handle, repo_id, created_at, expires_at, min_version, max_version, slice_hash, spillover_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    handle.handle,
    handle.repo_id,
    handle.created_at,
    handle.expires_at,
    handle.min_version ?? null,
    handle.max_version ?? null,
    handle.slice_hash,
    handle.spillover_ref ?? null,
  );
}

export function getSliceHandle(handle: string): SliceHandleRow | null {
  return stmt("SELECT * FROM slice_handles WHERE handle = ?").get(
    handle,
  ) as SliceHandleRow | null;
}

export function deleteSliceHandle(handle: string): void {
  stmt("DELETE FROM slice_handles WHERE handle = ?").run(handle);
}

export function deleteExpiredSliceHandles(beforeTimestamp: string): number {
  const result = stmt("DELETE FROM slice_handles WHERE expires_at < ?").run(
    beforeTimestamp,
  );
  return result.changes;
}

export function updateSliceHandleSpillover(
  handle: string,
  spilloverRef: string,
): void {
  stmt("UPDATE slice_handles SET spillover_ref = ? WHERE handle = ?").run(
    spilloverRef,
    handle,
  );
}

// Content-addressed storage operations
export function upsertCardHash(
  cardHash: string,
  cardBlob: string,
  createdAt: string,
): void {
  stmt(
    `INSERT INTO card_hashes (card_hash, card_blob, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(card_hash) DO NOTHING`,
  ).run(cardHash, cardBlob, createdAt);
}

export function getCardHash(cardHash: string): CardHashRow | null {
  return stmt("SELECT * FROM card_hashes WHERE card_hash = ?").get(
    cardHash,
  ) as CardHashRow | null;
}

export function upsertToolPolicyHash(
  policyHash: string,
  policyBlob: string,
  createdAt: string,
): void {
  stmt(
    `INSERT INTO tool_policy_hashes (policy_hash, policy_blob, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(policy_hash) DO NOTHING`,
  ).run(policyHash, policyBlob, createdAt);
}

export function getToolPolicyHash(
  policyHash: string,
): ToolPolicyHashRow | null {
  return stmt("SELECT * FROM tool_policy_hashes WHERE policy_hash = ?").get(
    policyHash,
  ) as ToolPolicyHashRow | null;
}

export function upsertTsconfigHash(
  tsconfigHash: string,
  tsconfigBlob: string,
  createdAt: string,
): void {
  stmt(
    `INSERT INTO tsconfig_hashes (tsconfig_hash, tsconfig_blob, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(tsconfig_hash) DO NOTHING`,
  ).run(tsconfigHash, tsconfigBlob, createdAt);
}

export function getTsconfigHash(tsconfigHash: string): TsconfigHashRow | null {
  return stmt("SELECT * FROM tsconfig_hashes WHERE tsconfig_hash = ?").get(
    tsconfigHash,
  ) as TsconfigHashRow | null;
}

// Version hash operations
export function updateVersionHashes(
  versionId: string,
  prevVersionHash: string | null,
  versionHash: string | null,
): void {
  stmt(
    "UPDATE versions SET prev_version_hash = ?, version_hash = ? WHERE version_id = ?",
  ).run(prevVersionHash, versionHash, versionId);
}

export function getVersionByHash(versionHash: string): VersionRow | null {
  return stmt("SELECT * FROM versions WHERE version_hash = ?").get(
    versionHash,
  ) as VersionRow | null;
}

export function listVersionsByPrevHash(prevVersionHash: string): VersionRow[] {
  return stmt(
    "SELECT * FROM versions WHERE prev_version_hash = ? ORDER BY created_at DESC",
  ).all(prevVersionHash) as VersionRow[];
}

// Symbol reference operations (inverted index for test references)
export function insertSymbolReference(
  ref: Omit<SymbolReferenceRow, "ref_id">,
): void {
  stmt(
    `INSERT INTO symbol_references (repo_id, symbol_name, file_id, line_number, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    ref.repo_id,
    ref.symbol_name,
    ref.file_id,
    ref.line_number,
    ref.created_at,
  );
}

export function getTestRefsForSymbol(
  repoId: string,
  symbolName: string,
): string[] {
  return stmt(
    `SELECT f.rel_path FROM symbol_references sr
     JOIN files f ON sr.file_id = f.file_id
     WHERE sr.repo_id = ? AND sr.symbol_name = ?`,
  )
    .all(repoId, symbolName)
    .map((r) => (r as { rel_path: string }).rel_path);
}

export function deleteSymbolReferencesByFileId(fileId: number): void {
  stmt("DELETE FROM symbol_references WHERE file_id = ?").run(fileId);
}

// ============================================================================
// Directory Aggregation Queries (for repo overview)
// ============================================================================

/**
 * Row type for directory-level symbol aggregation.
 */
export interface DirectoryAggregateRow {
  directory: string;
  file_count: number;
  symbol_count: number;
  exported_count: number;
  function_count: number;
  class_count: number;
  interface_count: number;
  type_count: number;
  method_count: number;
  variable_count: number;
  module_count: number;
  constructor_count: number;
}

/**
 * Aggregates symbol counts by directory for a repository.
 * Groups files by their parent directory and counts symbols by kind.
 *
 * @param repoId - Repository identifier
 * @returns Array of directory aggregations
 */
export function getDirectoryAggregates(
  repoId: string,
): DirectoryAggregateRow[] {
  // Use pre-computed directory column for better performance
  return stmt(`
    SELECT
      f.directory,
      COUNT(DISTINCT s.file_id) as file_count,
      COUNT(*) as symbol_count,
      SUM(CASE WHEN s.exported = 1 THEN 1 ELSE 0 END) as exported_count,
      SUM(CASE WHEN s.kind = 'function' THEN 1 ELSE 0 END) as function_count,
      SUM(CASE WHEN s.kind = 'class' THEN 1 ELSE 0 END) as class_count,
      SUM(CASE WHEN s.kind = 'interface' THEN 1 ELSE 0 END) as interface_count,
      SUM(CASE WHEN s.kind = 'type' THEN 1 ELSE 0 END) as type_count,
      SUM(CASE WHEN s.kind = 'method' THEN 1 ELSE 0 END) as method_count,
      SUM(CASE WHEN s.kind = 'variable' THEN 1 ELSE 0 END) as variable_count,
      SUM(CASE WHEN s.kind = 'module' THEN 1 ELSE 0 END) as module_count,
      SUM(CASE WHEN s.kind = 'constructor' THEN 1 ELSE 0 END) as constructor_count
    FROM symbols s
    JOIN files f ON s.file_id = f.file_id
    WHERE s.repo_id = ?
    GROUP BY f.directory
    ORDER BY symbol_count DESC
  `).all(repoId) as DirectoryAggregateRow[];
}

/**
 * Row type for exported symbol listing.
 */
export interface ExportedSymbolRow {
  symbol_id: string;
  name: string;
  kind: string;
  exported: number;
  directory: string;
  signature_json: string | null;
}

/**
 * Gets exported symbols grouped by directory.
 *
 * @param repoId - Repository identifier
 * @param limit - Maximum symbols per directory
 * @returns Array of exported symbol records with directory
 */
export function getExportedSymbolsByDirectory(
  repoId: string,
  limit: number = 20,
): ExportedSymbolRow[] {
  return stmt(`
    WITH file_dirs AS (
      SELECT
        file_id,
        CASE
          WHEN instr(rel_path, '/') > 0
          THEN substr(rel_path, 1, length(rel_path) - length(replace(rel_path, rtrim(rel_path, replace(rel_path, '/', '')), '')))
          ELSE ''
        END as directory
      FROM files
      WHERE repo_id = ?
    ),
    ranked_exports AS (
      SELECT
        s.symbol_id,
        s.name,
        s.kind,
        s.exported,
        s.signature_json,
        fd.directory,
        ROW_NUMBER() OVER (PARTITION BY fd.directory ORDER BY s.name) as rn
      FROM symbols s
      JOIN file_dirs fd ON s.file_id = fd.file_id
      WHERE s.repo_id = ? AND s.exported = 1
    )
    SELECT symbol_id, name, kind, exported, directory, signature_json
    FROM ranked_exports
    WHERE rn <= ?
    ORDER BY directory, name
  `).all(repoId, repoId, limit) as ExportedSymbolRow[];
}

/**
 * Row type for top symbols by metric.
 */
export interface TopSymbolRow {
  symbol_id: string;
  name: string;
  kind: string;
  exported: number;
  signature_json: string | null;
  fan_in: number;
  fan_out: number;
  churn_30d: number;
  directory: string;
}

/**
 * Gets top symbols by fan-in (most depended upon).
 *
 * @param repoId - Repository identifier
 * @param limit - Maximum number of symbols to return
 * @returns Array of symbols ordered by fan-in descending
 */
export function getTopSymbolsByFanIn(
  repoId: string,
  limit: number = 10,
): TopSymbolRow[] {
  return stmt(`
    WITH file_dirs AS (
      SELECT
        file_id,
        CASE
          WHEN instr(rel_path, '/') > 0
          THEN substr(rel_path, 1, length(rel_path) - length(replace(rel_path, rtrim(rel_path, replace(rel_path, '/', '')), '')))
          ELSE ''
        END as directory
      FROM files
      WHERE repo_id = ?
    )
    SELECT
      s.symbol_id,
      s.name,
      s.kind,
      s.exported,
      s.signature_json,
      COALESCE(m.fan_in, 0) as fan_in,
      COALESCE(m.fan_out, 0) as fan_out,
      COALESCE(m.churn_30d, 0) as churn_30d,
      COALESCE(fd.directory, '') as directory
    FROM symbols s
    LEFT JOIN metrics m ON s.symbol_id = m.symbol_id
    LEFT JOIN file_dirs fd ON s.file_id = fd.file_id
    WHERE s.repo_id = ?
    ORDER BY COALESCE(m.fan_in, 0) DESC
    LIMIT ?
  `).all(repoId, repoId, limit) as TopSymbolRow[];
}

/**
 * Gets top symbols by churn (most frequently changed).
 *
 * @param repoId - Repository identifier
 * @param limit - Maximum number of symbols to return
 * @returns Array of symbols ordered by churn descending
 */
export function getTopSymbolsByChurn(
  repoId: string,
  limit: number = 10,
): TopSymbolRow[] {
  return stmt(`
    WITH file_dirs AS (
      SELECT
        file_id,
        CASE
          WHEN instr(rel_path, '/') > 0
          THEN substr(rel_path, 1, length(rel_path) - length(replace(rel_path, rtrim(rel_path, replace(rel_path, '/', '')), '')))
          ELSE ''
        END as directory
      FROM files
      WHERE repo_id = ?
    )
    SELECT
      s.symbol_id,
      s.name,
      s.kind,
      s.exported,
      s.signature_json,
      COALESCE(m.fan_in, 0) as fan_in,
      COALESCE(m.fan_out, 0) as fan_out,
      COALESCE(m.churn_30d, 0) as churn_30d,
      COALESCE(fd.directory, '') as directory
    FROM symbols s
    LEFT JOIN metrics m ON s.symbol_id = m.symbol_id
    LEFT JOIN file_dirs fd ON s.file_id = fd.file_id
    WHERE s.repo_id = ? AND COALESCE(m.churn_30d, 0) > 0
    ORDER BY COALESCE(m.churn_30d, 0) DESC
    LIMIT ?
  `).all(repoId, repoId, limit) as TopSymbolRow[];
}

/**
 * Row type for file statistics.
 */
export interface FileStatsRow {
  rel_path: string;
  directory: string;
  symbol_count: number;
  edge_count: number;
}

/**
 * Gets files with most symbols.
 *
 * @param repoId - Repository identifier
 * @param limit - Maximum number of files to return
 * @returns Array of files ordered by symbol count descending
 */
export function getFilesBySymbolCount(
  repoId: string,
  limit: number = 10,
): FileStatsRow[] {
  return stmt(`
    SELECT
      f.rel_path,
      CASE
        WHEN instr(f.rel_path, '/') > 0
        THEN substr(f.rel_path, 1, length(f.rel_path) - length(replace(f.rel_path, rtrim(f.rel_path, replace(f.rel_path, '/', '')), '')))
        ELSE ''
      END as directory,
      COUNT(s.symbol_id) as symbol_count,
      0 as edge_count
    FROM files f
    LEFT JOIN symbols s ON f.file_id = s.file_id
    WHERE f.repo_id = ?
    GROUP BY f.file_id
    ORDER BY symbol_count DESC
    LIMIT ?
  `).all(repoId, limit) as FileStatsRow[];
}

/**
 * Gets files with most edges (highest connectivity).
 *
 * @param repoId - Repository identifier
 * @param limit - Maximum number of files to return
 * @returns Array of files ordered by edge count descending
 */
export function getFilesByEdgeCount(
  repoId: string,
  limit: number = 10,
): FileStatsRow[] {
  return stmt(`
    WITH file_edges AS (
      SELECT
        s.file_id,
        COUNT(e.edge_id) as edge_count
      FROM symbols s
      LEFT JOIN edges e ON s.symbol_id = e.from_symbol_id OR s.symbol_id = e.to_symbol_id
      WHERE s.repo_id = ?
      GROUP BY s.file_id
    )
    SELECT
      f.rel_path,
      CASE
        WHEN instr(f.rel_path, '/') > 0
        THEN substr(f.rel_path, 1, length(f.rel_path) - length(replace(f.rel_path, rtrim(f.rel_path, replace(f.rel_path, '/', '')), '')))
        ELSE ''
      END as directory,
      0 as symbol_count,
      COALESCE(fe.edge_count, 0) as edge_count
    FROM files f
    LEFT JOIN file_edges fe ON f.file_id = fe.file_id
    WHERE f.repo_id = ?
    ORDER BY edge_count DESC
    LIMIT ?
  `).all(repoId, repoId, limit) as FileStatsRow[];
}

/**
 * Gets aggregate edge counts by type for a repository.
 *
 * @param repoId - Repository identifier
 * @returns Object with counts per edge type
 */
export function getEdgeCountsByType(repoId: string): {
  call: number;
  import: number;
  config: number;
} {
  const rows = stmt(`
    SELECT type, COUNT(*) as count
    FROM edges
    WHERE repo_id = ?
    GROUP BY type
  `).all(repoId) as Array<{ type: string; count: number }>;

  const result = { call: 0, import: 0, config: 0 };
  for (const row of rows) {
    if (row.type === "call") result.call = row.count;
    else if (row.type === "import") result.import = row.count;
    else if (row.type === "config") result.config = row.count;
  }
  return result;
}

/**
 * Gets total counts for files, symbols, and edges in a repository.
 *
 * @param repoId - Repository identifier
 * @returns Object with total counts
 */
export function getRepoTotals(repoId: string): {
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  exportedCount: number;
} {
  const row = stmt(`
    SELECT
      (SELECT COUNT(*) FROM files WHERE repo_id = ?) as file_count,
      (SELECT COUNT(*) FROM symbols WHERE repo_id = ?) as symbol_count,
      (SELECT COUNT(*) FROM edges WHERE repo_id = ?) as edge_count,
      (SELECT COUNT(*) FROM symbols WHERE repo_id = ? AND exported = 1) as exported_count
  `).get(repoId, repoId, repoId, repoId) as {
    file_count: number;
    symbol_count: number;
    edge_count: number;
    exported_count: number;
  };

  return {
    fileCount: row.file_count,
    symbolCount: row.symbol_count,
    edgeCount: row.edge_count,
    exportedCount: row.exported_count,
  };
}
