/**
 * ladybug-symbols.ts � Symbol Operations
 * Extracted from ladybug-queries.ts as part of the god-object split.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type { Connection } from "kuzu";
import {
  exec,
  execDdl,
  queryAll,
  querySingle,
  toNumber,
  toBoolean,
  assertSafeInt,
  withTransaction,
} from "./ladybug-core.js";
import { logger } from "../util/logger.js";
import { normalizePath } from "../util/paths.js";
import {
  classifyDependencyTarget,
  type SymbolPlaceholderMeta,
  type SymbolStatus,
} from "./symbol-placeholders.js";
import {
  resolveLadybugWriteChunkSize,
  type LadybugWriteChunkOptions,
} from "./ladybug-batching.js";

const MAX_BATCH_WARNING_THRESHOLD = 5000;
const PRESERVE_OPTIONAL_SYMBOL_FIELD = "__sdl_preserve_optional_symbol_field__";
const CSV_NULL_SENTINEL = "\\N";
const CSV_ARRAY_NULL = Symbol("symbolCsvArrayNull");
const DEFAULT_SYMBOL_SNAPSHOT_PAGE_SIZE = 32_768;
const MAX_SYMBOL_SNAPSHOT_PAGE_SIZE = 65_536;
const LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT = 2_048;

export async function countScipProviderSymbols(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
     WHERE s.source = 'scip'
     RETURN count(DISTINCT s) AS count`,
    { repoId },
  );
  return toNumber(row?.count ?? 0);
}

export async function hasProviderFirstBootstrap(
  conn: Connection,
  repoId: string,
): Promise<boolean> {
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
     WHERE (s.source = 'scip' OR s.source = 'lsp')
       AND coalesce(s.symbolStatus, 'real') = 'real'
     RETURN count(DISTINCT s) AS count`,
    { repoId },
  );
  return toNumber(row?.count ?? 0) > 0;
}

const SYMBOL_COPY_COLUMNS = [
  "symbolId",
  "repoId",
  "kind",
  "name",
  "exported",
  "visibility",
  "language",
  "rangeStartLine",
  "rangeStartCol",
  "rangeEndLine",
  "rangeEndCol",
  "astFingerprint",
  "signatureJson",
  "summary",
  "summaryQuality",
  "summarySource",
  "invariantsJson",
  "sideEffectsJson",
  "roleTagsJson",
  "searchText",
  "updatedAt",
  "embeddingMiniLM",
  "embeddingMiniLMCardHash",
  "embeddingMiniLMUpdatedAt",
  "embeddingMiniLMVec",
  "embeddingNomic",
  "embeddingNomicCardHash",
  "embeddingNomicUpdatedAt",
  "embeddingJinaCode",
  "embeddingJinaCodeCardHash",
  "embeddingJinaCodeUpdatedAt",
  "embeddingNomicVec",
  "embeddingJinaCodeVec",
  "external",
  "scipSymbol",
  "source",
  "packageName",
  "packageVersion",
  "symbolStatus",
  "placeholderKind",
  "placeholderTarget",
] as const;

const SIMPLE_REL_COPY_COLUMNS = ["from", "to"] as const;

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
  // SCIP integration fields
  external?: boolean;
  source?: string | null;
  packageName?: string | null;
  packageVersion?: string | null;
  scipSymbol?: string | null;
  symbolStatus?: SymbolStatus;
  placeholderKind?: string | null;
  placeholderTarget?: string | null;
  updatedAt: string;
}

export type KnownFileSymbolWritePhaseName =
  | "nodeAndRelCreate"
  | "nodeUpsert"
  | "fileRelCreate"
  | "repoRelCreate";

export interface UpsertKnownFileSymbolsOptions
  extends LadybugWriteChunkOptions {
  measurePhase?: <T>(
    phaseName: KnownFileSymbolWritePhaseName,
    fn: () => Promise<T>,
  ) => Promise<T>;
}

export interface UpsertSymbolBatchOptions extends LadybugWriteChunkOptions {}

type SymbolBatchUpsertRow = ReturnType<typeof toSymbolBatchUpsertRow>;

function toSymbolBatchUpsertRow(symbol: SymbolRow) {
  return {
    symbolId: symbol.symbolId,
    repoId: symbol.repoId,
    fileId: symbol.fileId,
    kind: symbol.kind,
    name: symbol.name,
    exported: symbol.exported,
    visibility: symbol.visibility ?? "",
    language: symbol.language,
    rangeStartLine: symbol.rangeStartLine,
    rangeStartCol: symbol.rangeStartCol,
    rangeEndLine: symbol.rangeEndLine,
    rangeEndCol: symbol.rangeEndCol,
    astFingerprint: symbol.astFingerprint,
    signatureJson: symbol.signatureJson ?? "",
    summary: symbol.summary ?? "",
    invariantsJson: symbol.invariantsJson ?? "",
    sideEffectsJson: symbol.sideEffectsJson ?? "",
    roleTagsJson: symbol.roleTagsJson ?? "",
    searchText: symbol.searchText ?? "",
    summaryQuality: symbol.summaryQuality ?? 0.0,
    summarySource: symbol.summarySource ?? "unknown",
    external: symbol.external ?? false,
    source: symbol.source ?? PRESERVE_OPTIONAL_SYMBOL_FIELD,
    packageName: symbol.packageName ?? PRESERVE_OPTIONAL_SYMBOL_FIELD,
    packageVersion: symbol.packageVersion ?? PRESERVE_OPTIONAL_SYMBOL_FIELD,
    scipSymbol: symbol.scipSymbol ?? PRESERVE_OPTIONAL_SYMBOL_FIELD,
    symbolStatus: "real",
    placeholderKind: "",
    placeholderTarget: "",
    updatedAt: symbol.updatedAt,
  };
}

function splitSymbolBatchRowsBySummaryQualityType(
  rows: SymbolBatchUpsertRow[],
): SymbolBatchUpsertRow[][] {
  const integralRows: SymbolBatchUpsertRow[] = [];
  const fractionalRows: SymbolBatchUpsertRow[] = [];

  for (const row of rows) {
    // LadybugDB 0.18.1 infers JS struct-array fields before Cypher casts run:
    // integral numbers become INT64, fractional numbers become DOUBLE, and a
    // mixed payload is rejected. Splitting here preserves values and keeps the
    // overall logical batch inside the same transaction.
    const group = Number.isInteger(row.summaryQuality)
      ? integralRows
      : fractionalRows;
    group.push(row);
  }

  return [integralRows, fractionalRows].filter((group) => group.length > 0);
}

export interface SymbolSnapshotRow {
  symbolId: string;
  astFingerprint: string;
  signatureJson: string | null;
  summary: string | null;
  invariantsJson: string | null;
  sideEffectsJson: string | null;
}

export interface SymbolSnapshotPageOptions {
  afterSymbolId?: string;
  limit?: number;
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
     SET s.repoId = $repoId,
         s.kind = $kind,
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
         s.external = false,
         s.symbolStatus = 'real',
         s.placeholderKind = '',
         s.placeholderTarget = '',
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

/**
 * Upsert all symbols for a single file in one transaction-scoped loop.
 *
 * All symbols in a file share the same `repoId` and `fileId`, so the Repo
 * and File nodes are matched once (implicitly, via per-symbol MATCH). The
 * prepared statement is cached by `ladybug-core` after the first call so
 * subsequent iterations reuse it without re-parsing. When called from inside
 * an already-open transaction the inner `withTransaction` call is a no-op
 * (depth > 0 nesting is transparent), so the outer transaction is preserved.
 *
 * @param conn  Write connection (or txConn from an outer transaction).
 * @param symbols  All symbols to upsert. May be empty (no-op).
 */
export async function upsertSymbolBatch(
  conn: Connection,
  symbols: SymbolRow[],
  options?: UpsertSymbolBatchOptions,
): Promise<void> {
  if (symbols.length === 0) return;

  // Dedup by symbolId — W3 OPTIONAL-MATCH+CREATE has no within-batch
  // idempotency, so duplicate (s, f) or (s, r) pairs would CREATE twice.
  const seenSymbolIds = new Set<string>();
  symbols = symbols.filter((s) => {
    if (seenSymbolIds.has(s.symbolId)) return false;
    seenSymbolIds.add(s.symbolId);
    return true;
  });

  if (symbols.length > MAX_BATCH_WARNING_THRESHOLD) {
    logger.warn("upsertSymbolBatch: unusually large file-scoped batch", {
      count: symbols.length,
      threshold: MAX_BATCH_WARNING_THRESHOLD,
    });
  }

  // UNWIND-batched MERGE: collapses N round-trips to one statement per chunk
  // while preserving idempotency (MERGE) and side-effect-only semantics (no
  // RETURN — avoids LadybugDB issue #285 cardinality bug).
  const chunkSize = resolveLadybugWriteChunkSize(
    "symbols",
    options?.chunkSize,
  );
  await withTransaction(conn, async (txConn) => {
    for (let i = 0; i < symbols.length; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);
      // Coerce nullable STRING fields to '' — kuzu binder picks ANY type
      // when a struct field is uniformly null. Empty string keeps the payload
      // shape stable for the parameter binder.
      const rowGroups = splitSymbolBatchRowsBySummaryQualityType(
        chunk.map(toSymbolBatchUpsertRow),
      );
      // Three-pass W3 workaround for LadybugDB UNWIND+MERGE-rel runtime bug:
      // (1) MERGE node + SET props, (2) idempotent SYMBOL_IN_FILE,
      // (3) idempotent SYMBOL_IN_REPO. Plain MERGE-rel inside UNWIND throws
      // "invalid unordered_map<K, T> key" in 0.15.x–0.16.0.
      for (const rows of rowGroups) {
        await exec(
          txConn,
          `UNWIND $rows AS row
         MATCH (r:Repo {repoId: row.repoId})
         MATCH (f:File {fileId: row.fileId})
         MERGE (s:Symbol {symbolId: row.symbolId})
         SET s.repoId = row.repoId,
             s.kind = row.kind,
             s.name = row.name,
             s.exported = row.exported,
             s.visibility = row.visibility,
             s.language = row.language,
             s.rangeStartLine = row.rangeStartLine,
             s.rangeStartCol = row.rangeStartCol,
             s.rangeEndLine = row.rangeEndLine,
             s.rangeEndCol = row.rangeEndCol,
             s.astFingerprint = row.astFingerprint,
             s.signatureJson = row.signatureJson,
             s.summary = row.summary,
             s.invariantsJson = row.invariantsJson,
             s.sideEffectsJson = row.sideEffectsJson,
             s.roleTagsJson = row.roleTagsJson,
             s.searchText = row.searchText,
             s.summaryQuality = row.summaryQuality,
             s.summarySource = row.summarySource,
             s.external = row.external,
             s.source = CASE
               WHEN row.source = $preserveOptionalSymbolField
               THEN coalesce(s.source, 'treesitter')
               ELSE row.source
             END,
             s.packageName = CASE
               WHEN row.packageName = $preserveOptionalSymbolField
               THEN s.packageName
               ELSE row.packageName
             END,
             s.packageVersion = CASE
               WHEN row.packageVersion = $preserveOptionalSymbolField
               THEN s.packageVersion
               ELSE row.packageVersion
             END,
             s.scipSymbol = CASE
               WHEN row.scipSymbol = $preserveOptionalSymbolField
               THEN s.scipSymbol
               ELSE row.scipSymbol
             END,
              s.symbolStatus = row.symbolStatus,
              s.placeholderKind = row.placeholderKind,
              s.placeholderTarget = row.placeholderTarget,
              s.updatedAt = row.updatedAt`,
          { rows, preserveOptionalSymbolField: PRESERVE_OPTIONAL_SYMBOL_FIELD },
        );
        await exec(
          txConn,
          `UNWIND $rows AS row
         MATCH (s:Symbol {symbolId: row.symbolId})
         MATCH (f:File {fileId: row.fileId})
         OPTIONAL MATCH (s)-[existing:SYMBOL_IN_FILE]->(f)
         WITH s, f, existing
         WHERE existing IS NULL
         CREATE (s)-[:SYMBOL_IN_FILE]->(f)`,
          { rows },
        );
        await exec(
          txConn,
          `UNWIND $rows AS row
         MATCH (s:Symbol {symbolId: row.symbolId})
         MATCH (r:Repo {repoId: row.repoId})
         OPTIONAL MATCH (s)-[existing:SYMBOL_IN_REPO]->(r)
         WITH s, r, existing
         WHERE existing IS NULL
         CREATE (s)-[:SYMBOL_IN_REPO]->(r)`,
          { rows },
        );
      }
    }
  });
}

/**
 * Write a validated fresh set of file-backed symbols when the caller has
 * already removed old symbols for the same files. This avoids the generic
 * relationship existence checks and optional-field preservation needed by the
 * legacy upsert path.
 */
export async function upsertKnownFileSymbols(
  conn: Connection,
  symbols: SymbolRow[],
  options?: UpsertKnownFileSymbolsOptions,
): Promise<void> {
  if (symbols.length === 0) return;

  const seenSymbolIds = new Set<string>();
  symbols = symbols.filter((symbol) => {
    if (seenSymbolIds.has(symbol.symbolId)) return false;
    seenSymbolIds.add(symbol.symbolId);
    return true;
  });

  // COPY streams from temporary artifacts, so chunking the old UNWIND payload
  // no longer applies. The option is kept for API compatibility with callers
  // that still pass the standard Ladybug write options.
  void options?.chunkSize;
  const measurePhase =
    options?.measurePhase ??
    (async <T>(
      _phaseName: KnownFileSymbolWritePhaseName,
      fn: () => Promise<T>,
    ): Promise<T> => await fn());
  await withTransaction(conn, async (txConn) => {
    await measurePhase("nodeAndRelCreate", async () => {
      await copyKnownFileSymbols(txConn, symbols);
    });
  });
}

async function copyKnownFileSymbols(
  conn: Connection,
  symbols: readonly SymbolRow[],
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "sdl-known-symbols-"));
  const symbolPath = join(tempDir, "symbols.csv");
  const symbolInFilePath = join(tempDir, "symbol-in-file.csv");
  const symbolInRepoPath = join(tempDir, "symbol-in-repo.csv");
  try {
    await writeKnownSymbolsCsv(symbolPath, symbols);
    await writeSimpleRelCsv(
      symbolInFilePath,
      symbols.map((symbol) => [symbol.symbolId, symbol.fileId] as const),
    );
    await writeSimpleRelCsv(
      symbolInRepoPath,
      symbols.map((symbol) => [symbol.symbolId, symbol.repoId] as const),
    );

    await copyCsvArtifact(conn, "Symbol", symbolPath);
    await copyCsvArtifact(conn, "SYMBOL_IN_FILE", symbolInFilePath);
    await copyCsvArtifact(conn, "SYMBOL_IN_REPO", symbolInRepoPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function copyCsvArtifact(
  conn: Connection,
  tableName: string,
  filePath: string,
): Promise<void> {
  await execDdl(
    conn,
    `COPY ${tableName} FROM '${escapeCopyPath(filePath)}' ` +
      `(HEADER=true, PARALLEL=FALSE, NULL_STRINGS=['${escapeCopyOptionString(CSV_NULL_SENTINEL)}'])`,
  );
}

async function writeKnownSymbolsCsv(
  filePath: string,
  symbols: readonly SymbolRow[],
): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  try {
    await writeCsvLine(stream, SYMBOL_COPY_COLUMNS);
    for (const symbol of symbols) {
      await writeCsvLine(stream, symbolRowToCopyCells(symbol));
    }
    stream.end();
    await finished(stream);
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

async function writeSimpleRelCsv(
  filePath: string,
  rows: readonly (readonly [string, string])[],
): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  try {
    await writeCsvLine(stream, SIMPLE_REL_COPY_COLUMNS);
    for (const row of rows) {
      await writeCsvLine(stream, row);
    }
    stream.end();
    await finished(stream);
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

function symbolRowToCopyCells(symbol: SymbolRow): unknown[] {
  return [
    symbol.symbolId,
    symbol.repoId,
    symbol.kind,
    symbol.name,
    symbol.exported,
    symbol.visibility ?? "",
    symbol.language,
    symbol.rangeStartLine,
    symbol.rangeStartCol,
    symbol.rangeEndLine,
    symbol.rangeEndCol,
    symbol.astFingerprint,
    symbol.signatureJson ?? "",
    symbol.summary ?? "",
    symbol.summaryQuality ?? 0.0,
    symbol.summarySource ?? "unknown",
    symbol.invariantsJson ?? "",
    symbol.sideEffectsJson ?? "",
    symbol.roleTagsJson ?? "",
    symbol.searchText ?? "",
    symbol.updatedAt,
    null,
    null,
    null,
    CSV_ARRAY_NULL,
    null,
    null,
    null,
    null,
    null,
    null,
    CSV_ARRAY_NULL,
    CSV_ARRAY_NULL,
    symbol.external ?? false,
    symbol.scipSymbol ?? "",
    symbol.source ?? "treesitter",
    symbol.packageName ?? "",
    symbol.packageVersion ?? "",
    symbol.symbolStatus ?? "real",
    symbol.placeholderKind ?? "",
    symbol.placeholderTarget ?? "",
  ];
}

async function writeCsvLine(
  stream: NodeJS.WritableStream,
  cells: readonly unknown[],
): Promise<void> {
  const line = `${cells.map(csvCell).join(",")}\n`;
  if (!stream.write(line)) {
    await waitForDrain(stream);
  }
}

function waitForDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stream.removeListener("drain", onDrain);
      stream.removeListener("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function csvCell(value: unknown): string {
  if (value === CSV_ARRAY_NULL) return "";
  if (value === null || value === undefined) return CSV_NULL_SENTINEL;
  const text = String(value);
  if (text === "") return '""';
  const escaped = text.replaceAll('"', '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function escapeCopyPath(path: string): string {
  return normalizePath(path).replace(/'/g, "''");
}

function escapeCopyOptionString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

export async function normalizeFileBackedSymbolStatuses(
  conn: Connection,
  repoId: string,
  fileIds?: readonly string[],
): Promise<number> {
  if (fileIds && fileIds.length === 0) return 0;
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
     WHERE s.repoId = $repoId
       ${fileIds ? "AND f.fileId IN $fileIds" : ""}
       AND coalesce(s.placeholderKind, '') <> 'provider-metadata'
       AND (
         coalesce(s.symbolStatus, 'real') <> 'real'
         OR coalesce(s.placeholderKind, '') <> ''
         OR coalesce(s.placeholderTarget, '') <> ''
       )
     RETURN count(DISTINCT s) AS count`,
    { repoId, fileIds },
  );
  const repaired = toNumber(row?.count ?? 0);
  if (repaired === 0) return 0;

  await exec(
    conn,
    `MATCH (s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
     WHERE s.repoId = $repoId
       ${fileIds ? "AND f.fileId IN $fileIds" : ""}
       AND coalesce(s.placeholderKind, '') <> 'provider-metadata'
       AND (
         coalesce(s.symbolStatus, 'real') <> 'real'
         OR coalesce(s.placeholderKind, '') <> ''
         OR coalesce(s.placeholderTarget, '') <> ''
       )
     SET s.symbolStatus = 'real',
         s.placeholderKind = '',
         s.placeholderTarget = ''`,
    { repoId, fileIds },
  );
  return repaired;
}

export interface DependencyPlaceholderNormalizeResult {
  fileBackedRepaired: number;
  dependencyPlaceholdersRepaired: number;
}

export interface DependencyPlaceholderNormalizeOptions {
  fileIds?: ReadonlySet<string>;
}

export async function normalizeDependencyPlaceholderSymbols(
  conn: Connection,
  repoId: string,
  options: DependencyPlaceholderNormalizeOptions = {},
): Promise<DependencyPlaceholderNormalizeResult> {
  const hasExternalColumn = await symbolExternalColumnExists(conn);
  const fileIds = options.fileIds ? [...options.fileIds] : undefined;
  const fileBackedRepaired = await countFileBackedDependencyMetadataRepairs(
    conn,
    repoId,
    hasExternalColumn,
    fileIds,
  );
  await normalizeFileBackedSymbolStatuses(conn, repoId, fileIds);
  if (hasExternalColumn) {
    if (!fileIds || fileIds.length > 0) {
      await exec(
        conn,
        `MATCH (s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
         WHERE s.repoId = $repoId
           ${fileIds ? "AND f.fileId IN $fileIds" : ""}
           AND coalesce(s.external, false) = true
         SET s.external = false`,
        { repoId, fileIds },
      );
    }
  }
  const rows = await queryAll<{
    symbolId: string;
    symbolStatus: string | null;
    placeholderKind: string | null;
    placeholderTarget: string | null;
    external?: unknown;
  }>(
    conn,
    `MATCH (s:Symbol {repoId: $repoId})
     WHERE NOT (s)-[:SYMBOL_IN_FILE]->(:File)
       AND s.symbolId STARTS WITH 'unresolved:'
     RETURN s.symbolId AS symbolId,
            s.symbolStatus AS symbolStatus,
            s.placeholderKind AS placeholderKind,
            s.placeholderTarget AS placeholderTarget${
              hasExternalColumn
                ? `,
            coalesce(s.external, false) AS external`
                : ""
            }`,
    { repoId },
  );
  const repairs: Array<{
    symbolId: string;
    symbolStatus: SymbolPlaceholderMeta["symbolStatus"];
    placeholderKind: string;
    placeholderTarget: string;
    external: boolean;
  }> = [];

  for (const row of rows) {
    const meta = classifyDependencyTarget(row.symbolId);
    const external = meta.symbolStatus === "external";
    if (
      row.symbolStatus !== meta.symbolStatus ||
      (row.placeholderKind ?? "") !== (meta.placeholderKind ?? "") ||
      (row.placeholderTarget ?? "") !== (meta.placeholderTarget ?? "") ||
      (hasExternalColumn && toBoolean(row.external) !== external)
    ) {
      repairs.push({
        symbolId: row.symbolId,
        symbolStatus: meta.symbolStatus,
        placeholderKind: meta.placeholderKind ?? "",
        placeholderTarget: meta.placeholderTarget ?? "",
        external,
      });
    }
  }

  const CHUNK = 256;
  for (let i = 0; i < repairs.length; i += CHUNK) {
    const chunk = repairs.slice(i, i + CHUNK);
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (s:Symbol {symbolId: row.symbolId})
       SET s.symbolStatus = row.symbolStatus,
           s.placeholderKind = row.placeholderKind,
           s.placeholderTarget = row.placeholderTarget${
             hasExternalColumn
               ? `,
           s.external = row.external`
               : ""
           }`,
      { rows: chunk },
    );
  }

  return {
    fileBackedRepaired,
    dependencyPlaceholdersRepaired: repairs.length,
  };
}

async function countFileBackedDependencyMetadataRepairs(
  conn: Connection,
  repoId: string,
  hasExternalColumn: boolean,
  fileIds?: readonly string[],
): Promise<number> {
  if (fileIds && fileIds.length === 0) return 0;
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
     WHERE s.repoId = $repoId
       ${fileIds ? "AND f.fileId IN $fileIds" : ""}
       AND coalesce(s.placeholderKind, '') <> 'provider-metadata'
       AND (
         coalesce(s.symbolStatus, 'real') <> 'real'
         OR coalesce(s.placeholderKind, '') <> ''
         OR coalesce(s.placeholderTarget, '') <> ''${
           hasExternalColumn
             ? `
         OR coalesce(s.external, false) = true`
             : ""
         }
       )
     RETURN count(DISTINCT s) AS count`,
    { repoId, fileIds },
  );
  return toNumber(row?.count ?? 0);
}

export async function pruneIsolatedPlaceholderSymbols(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const rows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (s:Symbol {repoId: $repoId})
     WHERE NOT (s)-[:SYMBOL_IN_FILE]->(:File)
       AND (
         s.symbolId STARTS WITH 'unresolved:'
         OR coalesce(s.symbolStatus, '') = 'unresolved'
         OR coalesce(s.symbolStatus, '') = 'external'
       )
       AND NOT (:Symbol)-[:DEPENDS_ON]->(s)
       AND NOT (s)-[:DEPENDS_ON]->(:Symbol)
     RETURN s.symbolId AS symbolId`,
    { repoId },
  );
  const symbolIds = rows.map((row) => row.symbolId);
  if (symbolIds.length === 0) return 0;

  const symbolCountRow = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (s:Symbol) RETURN count(s) AS count`,
  );
  const symbolCount = toNumber(symbolCountRow?.count ?? 0);
  if (symbolCount > LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT) {
    // LadybugDB 0.18.1 corrupts earlier COPY-loaded Symbol vectors when a
    // large Symbol table's tail nodes or relationships are deleted or mutated.
    // Retain isolated non-real placeholders until the engine can delete them
    // safely; stable placeholder IDs keep this bounded across unchanged runs.
    logger.debug("Retaining isolated placeholders for LadybugDB 0.18.1 safety", {
      repoId,
      retained: symbolIds.length,
      symbolCount,
    });
    return 0;
  }

  const cleanup = {
    symbolInFile: await cleanupPatternExists(
      conn,
      `MATCH (:Symbol)-[:SYMBOL_IN_FILE]->(:File) RETURN 1 AS ok LIMIT 0`,
    ),
    belongsToCluster: await cleanupPatternExists(
      conn,
      `MATCH (:Symbol)-[:BELONGS_TO_CLUSTER]->(:Cluster) RETURN 1 AS ok LIMIT 0`,
    ),
    belongsToShadowCluster: await cleanupPatternExists(
      conn,
      `MATCH (:Symbol)-[:BELONGS_TO_SHADOW_CLUSTER]->(:ShadowCluster) RETURN 1 AS ok LIMIT 0`,
    ),
    participatesIn: await cleanupPatternExists(
      conn,
      `MATCH (:Symbol)-[:PARTICIPATES_IN]->(:Process) RETURN 1 AS ok LIMIT 0`,
    ),
    memoryOf: await cleanupPatternExists(
      conn,
      `MATCH (:Memory)-[:MEMORY_OF]->(:Symbol) RETURN 1 AS ok LIMIT 0`,
    ),
    metrics: await cleanupPatternExists(
      conn,
      `MATCH (:Metrics) RETURN 1 AS ok LIMIT 0`,
    ),
    symbolEmbedding: await cleanupPatternExists(
      conn,
      `MATCH (:SymbolEmbedding) RETURN 1 AS ok LIMIT 0`,
    ),
    summaryCache: await cleanupPatternExists(
      conn,
      `MATCH (:SummaryCache) RETURN 1 AS ok LIMIT 0`,
    ),
  };

  await withTransaction(conn, async (txConn) => {
    await exec(
      txConn,
      `MATCH (s:Symbol)-[rel:SYMBOL_IN_REPO]->(:Repo)
       WHERE s.symbolId IN $symbolIds
       DELETE rel`,
      { symbolIds },
    );
    if (cleanup.symbolInFile) {
      await exec(
        txConn,
        `MATCH (s:Symbol)-[rel:SYMBOL_IN_FILE]->(:File)
         WHERE s.symbolId IN $symbolIds
         DELETE rel`,
        { symbolIds },
      );
    }
    if (cleanup.belongsToCluster) {
      await exec(
        txConn,
        `MATCH (s:Symbol)-[rel:BELONGS_TO_CLUSTER]->(:Cluster)
         WHERE s.symbolId IN $symbolIds
         DELETE rel`,
        { symbolIds },
      );
    }
    if (cleanup.belongsToShadowCluster) {
      await exec(
        txConn,
        `MATCH (s:Symbol)-[rel:BELONGS_TO_SHADOW_CLUSTER]->(:ShadowCluster)
         WHERE s.symbolId IN $symbolIds
         DELETE rel`,
        { symbolIds },
      );
    }
    if (cleanup.participatesIn) {
      await exec(
        txConn,
        `MATCH (s:Symbol)-[rel:PARTICIPATES_IN]->(:Process)
         WHERE s.symbolId IN $symbolIds
         DELETE rel`,
        { symbolIds },
      );
    }
    if (cleanup.memoryOf) {
      await exec(
        txConn,
        `MATCH (mem:Memory)-[rel:MEMORY_OF]->(s:Symbol)
         WHERE s.symbolId IN $symbolIds
         DELETE rel`,
        { symbolIds },
      );
    }
    if (cleanup.metrics) {
      await exec(
        txConn,
        `MATCH (m:Metrics)
         WHERE m.symbolId IN $symbolIds
         DELETE m`,
        { symbolIds },
      );
    }
    if (cleanup.symbolEmbedding) {
      await exec(
        txConn,
        `MATCH (e:SymbolEmbedding)
         WHERE e.symbolId IN $symbolIds
         DELETE e`,
        { symbolIds },
      );
    }
    if (cleanup.summaryCache) {
      await exec(
        txConn,
        `MATCH (sc:SummaryCache)
         WHERE sc.symbolId IN $symbolIds
         DELETE sc`,
        { symbolIds },
      );
    }
    await exec(
      txConn,
      `MATCH (s:Symbol {repoId: $repoId})
       WHERE s.symbolId IN $symbolIds
       DELETE s`,
      { repoId, symbolIds },
    );
  });

  return symbolIds.length;
}

async function cleanupPatternExists(
  conn: Connection,
  statement: string,
): Promise<boolean> {
  try {
    await queryAll(conn, statement, {});
    return true;
  } catch (error) {
    if (String(error).toLowerCase().includes("does not exist")) {
      return false;
    }
    throw error;
  }
}

async function symbolExternalColumnExists(conn: Connection): Promise<boolean> {
  try {
    await queryAll(
      conn,
      `MATCH (s:Symbol)
       RETURN coalesce(s.external, false) AS external
       LIMIT 0`,
      {},
    );
    return true;
  } catch (error) {
    if (isMissingSymbolExternalColumnError(error)) {
      return false;
    }
    throw error;
  }
}

export function isMissingSymbolExternalColumnError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("external") &&
    (message.includes("cannot find property") ||
      (message.includes("property") && message.includes("does not exist")) ||
      (message.includes("column") && message.includes("does not exist")) ||
      message.includes("no such property") ||
      message.includes("not found"))
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

/**
 * Grouped read of exported symbol names by file id. Used by file-summary
 * materialisation to avoid the N+1 round trip of calling getSymbolsByFile per
 * file. Returns a map keyed by fileId; missing entries mean no exported
 * symbols for that file.
 */
export async function getExportedSymbolsByFileIds(
  conn: Connection,
  fileIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (fileIds.length === 0) return result;
  const rows = await queryAll<{ fileId: string; name: string }>(
    conn,
    `MATCH (f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)
     WHERE f.fileId IN $fileIds AND s.exported = true
     RETURN f.fileId AS fileId, s.name AS name`,
    { fileIds },
  );
  for (const row of rows) {
    const list = result.get(row.fileId) ?? [];
    list.push(row.name);
    result.set(row.fileId, list);
  }
  return result;
}

export async function getExportedSymbolsByRepo(
  conn: Connection,
  repoId: string,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const rows = await queryAll<{ fileId: string; name: string }>(
    conn,
    `MATCH (s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
     WHERE s.repoId = $repoId AND s.exported = true
     RETURN f.fileId AS fileId, s.name AS name`,
    { repoId },
  );
  for (const row of rows) {
    const list = result.get(row.fileId) ?? [];
    list.push(row.name);
    result.set(row.fileId, list);
  }
  return result;
}

/**
 * Lightweight exported-symbol shape used by pass-2 import resolution. Only
 * the fields the resolver actually consumes — keeps the cache footprint
 * tight when populated for an entire repo.
 */
export interface ExportedSymbolLite {
  symbolId: string;
  name: string;
}

/**
 * Batched read of exported `(symbolId, name)` tuples grouped by fileId.
 * Used by `runPass2Resolvers` to populate a pass-level cache so that the
 * `import-resolution.ts` hot loop can resolve target symbols via map
 * lookups instead of one `getSymbolsByFile` call per imported module.
 */
export async function getExportedSymbolsLiteByFileIds(
  conn: Connection,
  fileIds: string[],
): Promise<Map<string, ExportedSymbolLite[]>> {
  const result = new Map<string, ExportedSymbolLite[]>();
  if (fileIds.length === 0) return result;
  const rows = await queryAll<{
    fileId: string;
    symbolId: string;
    name: string;
  }>(
    conn,
    `MATCH (f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)
     WHERE f.fileId IN $fileIds AND s.exported = true
     RETURN f.fileId AS fileId, s.symbolId AS symbolId, s.name AS name`,
    { fileIds },
  );
  for (const row of rows) {
    const list = result.get(row.fileId) ?? [];
    list.push({ symbolId: row.symbolId, name: row.name });
    result.set(row.fileId, list);
  }
  return result;
}

export interface FileSummarySymbolFactRow {
  fileId: string;
  name: string;
  kind: string;
  exported: boolean;
  signatureJson: string | null;
  summary: string | null;
  rangeStartLine: number;
}

export async function getFileSummarySymbolFactsByFileIds(
  conn: Connection,
  fileIds: string[],
): Promise<Map<string, FileSummarySymbolFactRow[]>> {
  const result = new Map<string, FileSummarySymbolFactRow[]>();
  if (fileIds.length === 0) return result;

  const rows = await queryAll<{
    fileId: string;
    name: string;
    kind: string;
    exported: unknown;
    signatureJson: string | null;
    summary: string | null;
    rangeStartLine: unknown;
  }>(
    conn,
    `MATCH (f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)
     WHERE f.fileId IN $fileIds AND coalesce(s.symbolStatus, 'real') = 'real'
     RETURN f.fileId AS fileId,
            s.name AS name,
            s.kind AS kind,
            s.exported AS exported,
            s.signatureJson AS signatureJson,
            s.summary AS summary,
            s.rangeStartLine AS rangeStartLine`,
    { fileIds },
  );

  for (const row of rows) {
    const list = result.get(row.fileId) ?? [];
    list.push({
      fileId: row.fileId,
      name: row.name,
      kind: row.kind,
      exported: toBoolean(row.exported),
      signatureJson: row.signatureJson,
      summary: row.summary,
      rangeStartLine: toNumber(row.rangeStartLine),
    });
    result.set(row.fileId, list);
  }

  sortFileSummarySymbolFacts(result);
  return result;
}

export async function getFileSummarySymbolFactsByRepo(
  conn: Connection,
  repoId: string,
): Promise<Map<string, FileSummarySymbolFactRow[]>> {
  const result = new Map<string, FileSummarySymbolFactRow[]>();
  const rows = await queryAll<{
    fileId: string;
    name: string;
    kind: string;
    exported: unknown;
    signatureJson: string | null;
    summary: string | null;
    rangeStartLine: unknown;
  }>(
    conn,
    `MATCH (s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
     WHERE s.repoId = $repoId AND coalesce(s.symbolStatus, 'real') = 'real'
     RETURN f.fileId AS fileId,
            s.name AS name,
            s.kind AS kind,
            s.exported AS exported,
            s.signatureJson AS signatureJson,
            s.summary AS summary,
            s.rangeStartLine AS rangeStartLine`,
    { repoId },
  );

  for (const row of rows) {
    const list = result.get(row.fileId) ?? [];
    list.push({
      fileId: row.fileId,
      name: row.name,
      kind: row.kind,
      exported: toBoolean(row.exported),
      signatureJson: row.signatureJson,
      summary: row.summary,
      rangeStartLine: toNumber(row.rangeStartLine),
    });
    result.set(row.fileId, list);
  }

  sortFileSummarySymbolFacts(result);
  return result;
}

function sortFileSummarySymbolFacts(
  result: Map<string, FileSummarySymbolFactRow[]>,
): void {
  for (const list of result.values()) {
    list.sort((a, b) => {
      if (a.exported !== b.exported) return a.exported ? -1 : 1;
      return a.rangeStartLine - b.rangeStartLine;
    });
  }
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
    external: unknown;
    packageName: string | null;
    packageVersion: string | null;
    scipSymbol: string | null;
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
            coalesce(s.external, false) AS external,
            s.packageName AS packageName,
            s.packageVersion AS packageVersion,
            s.scipSymbol AS scipSymbol,
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
    external: toBoolean(row.external) || undefined,
    packageName: row.packageName,
    packageVersion: row.packageVersion,
    scipSymbol: row.scipSymbol,
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
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
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
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
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
    external: unknown;
    packageName: string | null;
    packageVersion: string | null;
    scipSymbol: string | null;
    updatedAt: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
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
            coalesce(s.external, false) AS external,
            s.packageName AS packageName,
            s.packageVersion AS packageVersion,
            s.scipSymbol AS scipSymbol,
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
    external: toBoolean(row.external) || undefined,
    packageName: row.packageName,
    packageVersion: row.packageVersion,
    scipSymbol: row.scipSymbol,
    updatedAt: row.updatedAt,
  }));
}

export async function getSymbolsByRepoForSnapshot(
  conn: Connection,
  repoId: string,
): Promise<SymbolSnapshotRow[]> {
  const rows = await queryAll<SymbolSnapshotRow>(
    conn,
     `MATCH (s:Symbol)
     WHERE s.repoId = $repoId
       AND coalesce(s.symbolStatus, 'real') = 'real'
       AND coalesce(s.external, false) = false
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

export async function getSymbolsByRepoForSnapshotPage(
  conn: Connection,
  repoId: string,
  options: SymbolSnapshotPageOptions = {},
): Promise<SymbolSnapshotRow[]> {
  const limit = resolveSymbolSnapshotPageSize(options.limit);
  const hasCursor = options.afterSymbolId !== undefined;
  const rows = await queryAll<SymbolSnapshotRow>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.repoId = $repoId
       AND coalesce(s.symbolStatus, 'real') = 'real'
       AND coalesce(s.external, false) = false
     ${hasCursor ? "AND s.symbolId > $afterSymbolId" : ""}
     RETURN s.symbolId AS symbolId,
            s.astFingerprint AS astFingerprint,
            s.signatureJson AS signatureJson,
            s.summary AS summary,
            s.invariantsJson AS invariantsJson,
            s.sideEffectsJson AS sideEffectsJson
     ORDER BY s.symbolId ASC
     LIMIT $limit`,
    {
      repoId,
      afterSymbolId: options.afterSymbolId ?? "",
      limit,
    },
  );
  return rows;
}

function resolveSymbolSnapshotPageSize(limit?: number): number {
  if (limit === undefined) return DEFAULT_SYMBOL_SNAPSHOT_PAGE_SIZE;
  assertSafeInt(limit, "symbol snapshot page size");
  if (limit < 1 || limit > MAX_SYMBOL_SNAPSHOT_PAGE_SIZE) {
    throw new RangeError(
      `symbol snapshot page size must be between 1 and ${MAX_SYMBOL_SNAPSHOT_PAGE_SIZE}`,
    );
  }
  return limit;
}

export async function getSymbolCount(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
       AND coalesce(s.external, false) = false
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
    external: unknown;
    packageName: string | null;
    packageVersion: string | null;
    scipSymbol: string | null;
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
            coalesce(s.external, false) AS external,
            s.packageName AS packageName,
            s.packageVersion AS packageVersion,
            s.scipSymbol AS scipSymbol,
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
      external: toBoolean(row.external) || undefined,
      packageName: row.packageName,
      packageVersion: row.packageVersion,
      scipSymbol: row.scipSymbol,
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

export async function getExistingSymbolIds(
  conn: Connection,
  symbolIds: string[],
): Promise<Set<string>> {
  if (symbolIds.length === 0) return new Set();

  if (symbolIds.length > MAX_BATCH_WARNING_THRESHOLD) {
    logger.warn("getExistingSymbolIds: large batch size", {
      count: symbolIds.length,
      threshold: MAX_BATCH_WARNING_THRESHOLD,
    });
  }

  const rows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolId IN $symbolIds
     RETURN s.symbolId AS symbolId`,
    { symbolIds },
  );

  return new Set(rows.map((row) => row.symbolId));
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

export async function deleteSymbolsByFileIds(
  conn: Connection,
  fileIds: string[],
): Promise<void> {
  if (fileIds.length === 0) return;

  const symbolRows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)
     WHERE f.fileId IN $fileIds
     RETURN s.symbolId AS symbolId`,
    { fileIds },
  );

  if (symbolRows.length === 0) return;

  const symbolIds = symbolRows.map((r) => r.symbolId);

  await exec(
    conn,
    `MATCH (m:Metrics)
     WHERE m.symbolId IN $symbolIds
     DELETE m`,
    { symbolIds },
  );
  await exec(
    conn,
    `MATCH (e:SymbolEmbedding)
     WHERE e.symbolId IN $symbolIds
     DELETE e`,
    { symbolIds },
  );
  await exec(
    conn,
    `MATCH (sc:SummaryCache)
     WHERE sc.symbolId IN $symbolIds
     DELETE sc`,
    { symbolIds },
  );
  await exec(
    conn,
    `MATCH (sr:SymbolReference)
     WHERE sr.fileId IN $fileIds
     DELETE sr`,
    { fileIds },
  );
  await exec(
    conn,
    `MATCH (mem:Memory)-[r:MEMORY_OF]->(s:Symbol)
     WHERE s.symbolId IN $symbolIds
     DELETE r`,
    { symbolIds },
  );
  await exec(
    conn,
    `MATCH (mem:Memory)-[r:MEMORY_OF_FILE]->(f:File)
     WHERE f.fileId IN $fileIds
     DELETE r`,
    { fileIds },
  );
  // Symbol graph relationships are all incident to Symbol nodes. DETACH DELETE
  // lets LadybugDB remove them in one indexed symbol pass instead of scanning
  // every relationship type separately during full-refresh stale cleanup.
  await exec(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolId IN $symbolIds
     DETACH DELETE s`,
    { symbolIds },
  );
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
      `MATCH (s:Symbol)-[r:BELONGS_TO_SHADOW_CLUSTER]->(:ShadowCluster)
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

/**
 * Delete specific symbols by their IDs, including all relationships and
 * associated nodes. This is the targeted counterpart to deleteSymbolsByFileId,
 * used by the diff/merge reconciliation to remove only specific symbols.
 */
export async function deleteSymbolsByIds(
  conn: Connection,
  symbolIds: string[],
): Promise<void> {
  if (symbolIds.length === 0) return;

  await withTransaction(conn, async (txConn) => {
    // Outgoing DEPENDS_ON edges
    await exec(
      txConn,
      `MATCH (s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    );

    // Incoming DEPENDS_ON edges
    await exec(
      txConn,
      `MATCH (:Symbol)-[d:DEPENDS_ON]->(s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    );

    // SYMBOL_IN_REPO edges
    await exec(
      txConn,
      `MATCH (s:Symbol)-[r:SYMBOL_IN_REPO]->(:Repo)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    // SYMBOL_IN_FILE edges
    await exec(
      txConn,
      `MATCH (s:Symbol)-[r:SYMBOL_IN_FILE]->(:File)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    // BELONGS_TO_CLUSTER edges
    await exec(
      txConn,
      `MATCH (s:Symbol)-[r:BELONGS_TO_CLUSTER]->(:Cluster)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    // BELONGS_TO_SHADOW_CLUSTER edges
    await exec(
      txConn,
      `MATCH (s:Symbol)-[r:BELONGS_TO_SHADOW_CLUSTER]->(:ShadowCluster)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    // PARTICIPATES_IN edges
    await exec(
      txConn,
      `MATCH (s:Symbol)-[r:PARTICIPATES_IN]->(:Process)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    // Metrics nodes
    await exec(
      txConn,
      `MATCH (m:Metrics)
       WHERE m.symbolId IN $symbolIds
       DELETE m`,
      { symbolIds },
    );

    // SymbolEmbedding nodes
    await exec(
      txConn,
      `MATCH (e:SymbolEmbedding)
       WHERE e.symbolId IN $symbolIds
       DELETE e`,
      { symbolIds },
    );

    // SummaryCache nodes
    await exec(
      txConn,
      `MATCH (sc:SummaryCache)
       WHERE sc.symbolId IN $symbolIds
       DELETE sc`,
      { symbolIds },
    );

    // MEMORY_OF edges (Memory -> deleted Symbol)
    await exec(
      txConn,
      `MATCH (mem:Memory)-[r:MEMORY_OF]->(s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    // Symbol nodes
    await exec(
      txConn,
      `MATCH (s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE s`,
      { symbolIds },
    );
  });
}

/**
 * Delete non-SCIP outgoing edges for specific symbols. Used during diff/merge
 * reconciliation to refresh tree-sitter edges while preserving SCIP edges.
 */
export async function deleteNonScipOutgoingEdges(
  conn: Connection,
  symbolIds: string[],
): Promise<void> {
  if (symbolIds.length === 0) return;

  await exec(
    conn,
    `MATCH (s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     WHERE s.symbolId IN $symbolIds
       AND (d.resolverId IS NULL OR d.resolverId <> 'scip')
     DELETE d`,
    { symbolIds },
  );
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
  external: unknown;
  scipSymbol: string | null;
  packageName: string | null;
  packageVersion: string | null;
}

// Public symbol search returns file-backed real symbols plus first-class SCIP
// externals. Dependency placeholder stubs stay in the graph for traversal, but
// they are not ordinary search results even if stale metadata gives them names.
const SEARCHABLE_SYMBOL_BOUNDARY = `(
       (coalesce(s.symbolStatus, 'real') = 'real' AND coalesce(f.fileId, '') <> '')
       OR (
         coalesce(s.symbolStatus, 'real') = 'external'
         AND coalesce(s.external, false) = true
         AND coalesce(s.placeholderKind, '') = 'scip'
       )
     )`;

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
    external: toBoolean(row.external),
    scipSymbol: row.scipSymbol,
    packageName: row.packageName,
    packageVersion: row.packageVersion,
  };
}

async function searchSymbolsSingleTerm(
  conn: Connection,
  repoId: string,
  term: string,
  kinds?: string[],
  excludeExternal?: boolean,
): Promise<SearchSymbolsRawRow[]> {
  return queryAll<SearchSymbolsRawRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]->(f:File)
     WITH s, f
     WHERE ${SEARCHABLE_SYMBOL_BOUNDARY}
       AND (lower(coalesce(s.name, '')) CONTAINS lower($query)
        OR lower(coalesce(s.summary, '')) CONTAINS lower($query)
        OR lower(coalesce(s.searchText, '')) CONTAINS lower($query))
     ${kinds && kinds.length > 0 ? "AND s.kind IN $kinds" : ""}
     ${excludeExternal ? "AND coalesce(s.external, false) = false" : ""}
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
            coalesce(f.fileId, '') AS fileId,
            coalesce(f.relPath, '') AS file,
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
            s.updatedAt AS updatedAt,
            coalesce(s.external, false) AS external,
            s.scipSymbol AS scipSymbol,
            s.packageName AS packageName,
            s.packageVersion AS packageVersion
     ORDER BY exactNameRank, ciExactNameRank, wordBoundaryRank, filePenalty, kindRank, nameMatchRank, s.symbolId
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

export async function getSearchableSymbolsByIds(
  conn: Connection,
  repoId: string,
  symbolIds: string[],
  excludeExternal?: boolean,
): Promise<Map<string, SymbolRow>> {
  if (symbolIds.length === 0) return new Map();

  const rows = await queryAll<SearchSymbolsRawRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WHERE s.symbolId IN $symbolIds
     OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]->(f:File)
     WITH s, f
     WHERE ${SEARCHABLE_SYMBOL_BOUNDARY}
     ${excludeExternal ? "AND coalesce(s.external, false) = false" : ""}
     RETURN s.symbolId AS symbolId,
            coalesce(f.fileId, '') AS fileId,
            coalesce(f.relPath, '') AS file,
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
            s.updatedAt AS updatedAt,
            coalesce(s.external, false) AS external,
            s.scipSymbol AS scipSymbol,
            s.packageName AS packageName,
            s.packageVersion AS packageVersion`,
    { repoId, symbolIds },
  );

  const result = new Map<string, SymbolRow>();
  for (const row of rows) {
    result.set(row.symbolId, mapSearchSymbolRow(row, repoId));
  }
  return result;
}

export async function searchSymbols(
  conn: Connection,
  repoId: string,
  query: string,
  limit: number,
  kinds?: string[],
  excludeExternal?: boolean,
): Promise<SymbolRow[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  assertSafeInt(limit, "limit");
  const safeLimit = Math.max(1, Math.min(limit, 1000));

  const terms = splitSearchTerms(trimmed);

  // Single-term: use existing behavior
  if (terms.length <= 1) {
    const rows = await searchSymbolsSingleTerm(
      conn,
      repoId,
      trimmed,
      kinds,
      excludeExternal,
    );
    return rows
      .slice(0, safeLimit)
      .map((row) => mapSearchSymbolRow(row, repoId));
  }

  // Multi-term (including camelCase-split): run per-term queries, merge with match-count ranking.
  // Serialize queries — LadybugDB connections are not safe for concurrent execute() calls.
  const perTermResults: SearchSymbolsRawRow[][] = [];
  for (const term of terms) {
    perTermResults.push(
      await searchSymbolsSingleTerm(conn, repoId, term, kinds, excludeExternal),
    );
  }

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
        (a.row.exported ? 0 : 1) - (b.row.exported ? 0 : 1) ||
        a.row.symbolId.localeCompare(b.row.symbolId)
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

export interface SearchSymbolLiteCandidate extends SearchSymbolLiteRow {
  summary: string;
  searchText: string;
}

/**
 * Load every real, file-backed symbol within the explicit path scope in one
 * query. Ranking stays in memory so each lexical lane can reuse this pool
 * without repeating path lookups or imposing an alphabetical pre-limit.
 */
export async function getScopedSearchSymbolPool(
  conn: Connection,
  repoId: string,
  focusPaths: string[],
): Promise<SearchSymbolLiteCandidate[]> {
  const normalizedPaths = Array.from(
    new Map(
      focusPaths
        .map((focusPath) => normalizePath(focusPath.trim()).replace(/\/+$/, ""))
        .filter(Boolean)
        .map((focusPath) => [focusPath.toLowerCase(), focusPath]),
    ).values(),
  );
  if (normalizedPaths.length === 0) return [];

  const hasRootScope = normalizedPaths.some((focusPath) => focusPath === ".");
  const params: Record<string, unknown> = { repoId };
  const scopeClauses = hasRootScope
    ? []
    : normalizedPaths.map((focusPath, index) => {
        params[`scopePath${index}`] = focusPath.toLowerCase();
        params[`scopePrefix${index}`] = `${focusPath.toLowerCase()}/`;
        return `(lower(f.relPath) = $scopePath${index} OR lower(f.relPath) STARTS WITH $scopePrefix${index})`;
      });

  return queryAll<SearchSymbolLiteCandidate>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
     ${scopeClauses.length > 0 ? `AND (${scopeClauses.join(" OR ")})` : ""}
     RETURN s.symbolId AS symbolId,
            coalesce(s.name, '') AS name,
            f.fileId AS fileId,
            f.relPath AS file,
            coalesce(s.kind, '') AS kind,
            coalesce(s.exported, false) AS exported,
            coalesce(s.summary, '') AS summary,
            coalesce(s.searchText, '') AS searchText
     ORDER BY f.relPath ASC, s.symbolId ASC`,
    params,
  );
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
  excludeExternal?: boolean,
): Promise<SearchSymbolLiteRow[]> {
  return queryAll<SearchSymbolLiteRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]->(f:File)
     WITH s, f
     WHERE ${SEARCHABLE_SYMBOL_BOUNDARY}
       AND (lower(coalesce(s.name, '')) CONTAINS lower($query)
        OR lower(coalesce(s.summary, '')) CONTAINS lower($query)
        OR lower(coalesce(s.searchText, '')) CONTAINS lower($query))
     ${kinds && kinds.length > 0 ? "AND s.kind IN $kinds" : ""}
     ${excludeExternal ? "AND coalesce(s.external, false) = false" : ""}
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
            coalesce(f.fileId, '') AS fileId,
            coalesce(f.relPath, '') AS file,
            s.kind AS kind,
            s.exported AS exported
     ORDER BY exactNameRank, ciExactNameRank, wordBoundaryRank, filePenalty, kindRank, nameMatchRank, s.symbolId
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

function mergeSearchSymbolLiteTermResults(
  perTermResults: SearchSymbolLiteRow[][],
  query: string,
  limit: number,
): SearchSymbolLiteRow[] {
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

  const lowerQuery = query.trim().toLowerCase();
  return Array.from(matchCounts.values())
    .sort((a, b) => {
      const aName = a.row.name.toLowerCase();
      const bName = b.row.name.toLowerCase();
      const aExact = aName === lowerQuery ? 0 : 1;
      const bExact = bName === lowerQuery ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const aPrefix = aName.startsWith(lowerQuery) ? 0 : 1;
      const bPrefix = bName.startsWith(lowerQuery) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      const aContains = aName.includes(lowerQuery) ? 0 : 1;
      const bContains = bName.includes(lowerQuery) ? 0 : 1;
      if (aContains !== bContains) return aContains - bContains;
      return (
        b.count - a.count ||
        a.row.name.localeCompare(b.row.name) ||
        (a.row.file.startsWith("tests/") ? 1 : 0) -
          (b.row.file.startsWith("tests/") ? 1 : 0) ||
        (a.row.exported ? 0 : 1) - (b.row.exported ? 0 : 1) ||
        a.row.symbolId.localeCompare(b.row.symbolId)
      );
    })
    .map((entry) => entry.row)
    .slice(0, limit);
}

interface PreparedSearchSymbolLiteCandidate {
  row: SearchSymbolLiteCandidate;
  name: string;
  summary: string;
  searchText: string;
}

function prepareSearchSymbolLitePool(
  candidates: SearchSymbolLiteCandidate[],
): PreparedSearchSymbolLiteCandidate[] {
  return candidates.map((row) => ({
    row,
    name: row.name.toLowerCase(),
    summary: row.summary.toLowerCase(),
    searchText: row.searchText.toLowerCase(),
  }));
}

function searchSymbolsLiteSingleTermInPreparedPool(
  candidates: PreparedSearchSymbolLiteCandidate[],
  term: string,
  kinds?: string[],
): SearchSymbolLiteRow[] {
  const queryLower = term.toLowerCase();
  const queryPadded = ` ${queryLower} `;
  const queryStart = `${queryLower} `;
  const queryEnd = ` ${queryLower}`;
  const allowedKinds = kinds && kinds.length > 0 ? new Set(kinds) : undefined;

  return candidates
    .filter((candidate) => {
      if (allowedKinds && !allowedKinds.has(candidate.row.kind)) return false;
      return (
        candidate.name.includes(queryLower) ||
        candidate.summary.includes(queryLower) ||
        candidate.searchText.includes(queryLower)
      );
    })
    .map((candidate) => ({
      candidate,
      rank: rankPreparedSearchSymbolLiteCandidate(
        candidate,
        term,
        queryLower,
        queryPadded,
        queryStart,
        queryEnd,
      ),
    }))
    .sort((a, b) => {
      for (let index = 0; index < a.rank.length; index++) {
        const difference = a.rank[index] - b.rank[index];
        if (difference !== 0) return difference;
      }
      return a.candidate.row.symbolId.localeCompare(b.candidate.row.symbolId);
    })
    .slice(0, 200)
    .map(
      ({
        candidate: {
          row: { summary: _summary, searchText: _searchText, ...row },
        },
      }) => row,
    );
}

function searchSymbolsLiteInPreparedPool(
  candidates: PreparedSearchSymbolLiteCandidate[],
  query: string,
  limit: number,
  kinds?: string[],
): SearchSymbolLiteRow[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  assertSafeInt(limit, "limit");
  const safeLimit = Math.max(1, Math.min(limit, 1000));
  const terms = splitSearchTerms(trimmed);
  if (terms.length <= 1) {
    return searchSymbolsLiteSingleTermInPreparedPool(
      candidates,
      trimmed,
      kinds,
    ).slice(0, safeLimit);
  }

  return mergeSearchSymbolLiteTermResults(
    terms.map((term) =>
      searchSymbolsLiteSingleTermInPreparedPool(candidates, term, kinds),
    ),
    trimmed,
    safeLimit,
  );
}

/** Rank a preloaded scoped pool with the same term and merge rules as DB search. */
export function searchSymbolsLiteInPool(
  candidates: SearchSymbolLiteCandidate[],
  query: string,
  limit = 20,
  kinds?: string[],
): SearchSymbolLiteRow[] {
  return searchSymbolsLiteInPreparedPool(
    prepareSearchSymbolLitePool(candidates),
    query,
    limit,
    kinds,
  );
}

/** Rank a query plan while preparing candidate search fields only once. */
export function searchSymbolsLiteQueriesInPool(
  candidates: SearchSymbolLiteCandidate[],
  queries: Array<{ query: string; limit: number; kinds?: string[] }>,
): SearchSymbolLiteRow[][] {
  const prepared = prepareSearchSymbolLitePool(candidates);
  return queries.map(({ query, limit, kinds }) =>
    searchSymbolsLiteInPreparedPool(prepared, query, limit, kinds),
  );
}

export async function searchSymbolsLite(
  conn: Connection,
  repoId: string,
  query: string,
  limit: number,
  kinds?: string[],
  excludeExternal?: boolean,
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
      excludeExternal,
    );
    return rows.slice(0, safeLimit);
  }

  // Multi-term: run per-term queries, merge with match-count ranking.
  // Serialize queries — LadybugDB connections are not safe for concurrent execute() calls.
  const perTermResults: SearchSymbolLiteRow[][] = [];
  for (const term of terms) {
    perTermResults.push(
      await searchSymbolsLiteSingleTerm(
        conn,
        repoId,
        term,
        kinds,
        excludeExternal,
      ),
    );
  }

  return mergeSearchSymbolLiteTermResults(perTermResults, trimmed, safeLimit);
}

export async function searchSymbolsLiteBatch(
  conn: Connection,
  repoId: string,
  tokens: string[],
  perTokenLimit: number,
  kinds?: string[],
  excludeExternal?: boolean,
): Promise<SearchSymbolLiteRow[][]> {
  assertSafeInt(perTokenLimit, "perTokenLimit");
  const safeLimit = Math.max(1, Math.min(perTokenLimit, 1000));
  const normalizedTokens = tokens.map((token) => token.trim()).filter(Boolean);
  if (normalizedTokens.length === 0) {
    return tokens.map(() => []);
  }

  const uniqueTokens = Array.from(new Set(normalizedTokens));
  const candidateLimit = Math.max(
    safeLimit,
    Math.min(5000, uniqueTokens.length * Math.max(20, safeLimit * 8)),
  );
  const params: Record<string, unknown> = { repoId, candidateLimit };
  const tokenClauses = uniqueTokens.map((token, index) => {
    params[`query${index}`] = token.toLowerCase();
    return `(lower(coalesce(s.name, '')) CONTAINS $query${index}
        OR lower(coalesce(s.summary, '')) CONTAINS $query${index}
        OR lower(coalesce(s.searchText, '')) CONTAINS $query${index})`;
  });
  if (kinds && kinds.length > 0) {
    params.kinds = kinds;
  }

  const candidates = await queryAll<SearchSymbolLiteCandidate>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]->(f:File)
     WITH s, f
     WHERE ${SEARCHABLE_SYMBOL_BOUNDARY}
       AND (${tokenClauses.join(" OR ")})
     ${kinds && kinds.length > 0 ? "AND s.kind IN $kinds" : ""}
     ${excludeExternal ? "AND coalesce(s.external, false) = false" : ""}
     WITH s, f,
          CASE
            WHEN coalesce(f.relPath, '') CONTAINS '/adapter/' THEN 2
            WHEN coalesce(f.relPath, '') CONTAINS '/tests/' OR coalesce(f.relPath, '') STARTS WITH 'tests/' THEN 2
            WHEN coalesce(f.relPath, '') STARTS WITH 'scripts/' THEN 2
            WHEN coalesce(f.relPath, '') CONTAINS '.test.' OR coalesce(f.relPath, '') CONTAINS '.spec.' THEN 2
            WHEN coalesce(f.relPath, '') CONTAINS 'target/' THEN 2
            WHEN coalesce(f.relPath, '') CONTAINS 'vendor/' THEN 2
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
          END AS kindRank
     RETURN s.symbolId AS symbolId,
            s.name AS name,
            coalesce(f.fileId, '') AS fileId,
            coalesce(f.relPath, '') AS file,
            s.kind AS kind,
            s.exported AS exported,
            coalesce(s.summary, '') AS summary,
            coalesce(s.searchText, '') AS searchText
     ORDER BY filePenalty, kindRank, s.name
     LIMIT $candidateLimit`,
    params,
  );

  const candidatesByToken = new Map<string, SearchSymbolLiteRow[]>();
  for (const token of uniqueTokens) {
    const tokenLower = token.toLowerCase();
    const queryPadded = ` ${tokenLower} `;
    const queryStart = `${tokenLower} `;
    const queryEnd = ` ${tokenLower}`;
    const matches = candidates
      .filter((candidate) => {
        const name = candidate.name.toLowerCase();
        const summary = candidate.summary.toLowerCase();
        const searchText = candidate.searchText.toLowerCase();
        return (
          name.includes(tokenLower) ||
          summary.includes(tokenLower) ||
          searchText.includes(tokenLower)
        );
      })
      .sort((a, b) => {
        const rankA = rankSearchSymbolLiteCandidate(
          a,
          token,
          tokenLower,
          queryPadded,
          queryStart,
          queryEnd,
        );
        const rankB = rankSearchSymbolLiteCandidate(
          b,
          token,
          tokenLower,
          queryPadded,
          queryStart,
          queryEnd,
        );
        for (let index = 0; index < rankA.length; index++) {
          const diff = rankA[index] - rankB[index];
          if (diff !== 0) return diff;
        }
        return a.symbolId.localeCompare(b.symbolId);
      })
      .slice(0, safeLimit)
      .map(({ summary: _summary, searchText: _searchText, ...row }) => row);
    if (matches.length < safeLimit) {
      const seen = new Set(matches.map((row) => row.symbolId));
      const fallbackRows = await searchSymbolsLiteSingleTerm(
        conn,
        repoId,
        token,
        kinds,
        excludeExternal,
      );
      for (const row of fallbackRows) {
        if (seen.has(row.symbolId)) continue;
        matches.push(row);
        seen.add(row.symbolId);
        if (matches.length >= safeLimit) break;
      }
    }
    candidatesByToken.set(token, matches);
  }

  return tokens.map((token) => candidatesByToken.get(token.trim()) ?? []);
}

function rankSearchSymbolLiteCandidate(
  row: SearchSymbolLiteCandidate,
  query: string,
  queryLower: string,
  queryPadded: string,
  queryStart: string,
  queryEnd: string,
): number[] {
  const name = row.name.toLowerCase();
  const searchText = row.searchText.toLowerCase();
  return [
    row.name === query ? 0 : 1,
    name === queryLower ? 0 : 1,
    searchText.includes(queryPadded) ||
    searchText.startsWith(queryStart) ||
    searchText.endsWith(queryEnd)
      ? 0
      : 1,
    getSearchSymbolLiteFilePenalty(row.file),
    getSearchSymbolLiteKindRank(row.kind),
    name.includes(queryLower) ? 0 : 1,
  ];
}

function rankPreparedSearchSymbolLiteCandidate(
  candidate: PreparedSearchSymbolLiteCandidate,
  query: string,
  queryLower: string,
  queryPadded: string,
  queryStart: string,
  queryEnd: string,
): number[] {
  return [
    candidate.row.name === query ? 0 : 1,
    candidate.name === queryLower ? 0 : 1,
    candidate.searchText.includes(queryPadded) ||
    candidate.searchText.startsWith(queryStart) ||
    candidate.searchText.endsWith(queryEnd)
      ? 0
      : 1,
    getSearchSymbolLiteFilePenalty(candidate.row.file),
    getSearchSymbolLiteKindRank(candidate.row.kind),
    candidate.name.includes(queryLower) ? 0 : 1,
  ];
}

function getSearchSymbolLiteFilePenalty(file: string): number {
  if (file.includes("/adapter/")) return 2;
  if (file.includes("/tests/") || file.startsWith("tests/")) return 2;
  if (file.startsWith("scripts/")) return 2;
  if (file.includes(".test.") || file.includes(".spec.")) return 2;
  if (file.includes("target/")) return 2;
  if (file.includes("vendor/")) return 2;
  return 0;
}

function getSearchSymbolLiteKindRank(kind: string): number {
  switch (kind) {
    case "class":
      return 0;
    case "function":
      return 1;
    case "interface":
      return 2;
    case "type":
      return 3;
    case "method":
      return 4;
    case "constructor":
      return 5;
    case "module":
      return 6;
    default:
      return 7;
  }
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
  const normalizedPath = normalizePath(relPath);

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

/**
 * Direct exact-name lookup — guarantees exact matches are never missed
 * due to CONTAINS/LIKE limit truncation in searchSymbolsLite.
 */
export async function findSymbolByExactName(
  conn: Connection,
  repoId: string,
  name: string,
  kinds?: string[],
  excludeExternal?: boolean,
): Promise<SearchSymbolLiteRow | null> {
  const hasKinds = Boolean(kinds && kinds.length > 0);
  const params: Record<string, unknown> = {
    repoId,
    name: name.toLowerCase(),
    ...(hasKinds ? { kinds } : {}),
  };
  const rows = await queryAll<SearchSymbolLiteRow>(
    conn,
    `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(r:Repo {repoId: $repoId})
     OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]->(f:File)
     WITH s, f
     WHERE ${SEARCHABLE_SYMBOL_BOUNDARY}
       AND lower(coalesce(s.name, '')) = $name
     ${hasKinds ? "AND s.kind IN $kinds" : ""}
     ${excludeExternal ? "AND coalesce(s.external, false) = false" : ""}
     RETURN s.symbolId AS symbolId, s.name AS name,
            coalesce(f.fileId, '') AS fileId,
            coalesce(f.relPath, '') AS file,
            s.kind AS kind, s.exported AS exported,
            coalesce(f.relPath, '') AS filePath, s.summary AS summary,
            '' AS searchText
     LIMIT 1`,
    params,
  );
  return rows[0] ?? null;
}
