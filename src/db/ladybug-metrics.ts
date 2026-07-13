/**
 * ladybug-metrics.ts - Metrics Operations
 * Extracted from ladybug-queries.ts as part of the god-object split.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type { Connection } from "kuzu";
import {
  execDdl,
  exec,
  queryAll,
  querySingle,
  toNumber,
  assertSafeInt,
  withTransaction,
} from "./ladybug-core.js";
import type {
  MetricsRow,
  TopSymbolByFanInRow,
  FanInOut,
} from "./ladybug-repos.js";
import { normalizePath } from "../util/paths.js";

const METRICS_COPY_COLUMNS = [
  "symbolId",
  "fanIn",
  "fanOut",
  "churn30d",
  "testRefsJson",
  "canonicalTestJson",
  "pageRank",
  "kCore",
  "updatedAt",
] as const;
const CSV_NULL_SENTINEL = "__sdl_ladybug_csv_null__";
const METRICS_CSV_WRITE_BATCH_SIZE = 4096;
const DEFAULT_METRICS_MISSING_COPY_THRESHOLD_ROWS = 512;
const METRICS_EXISTING_PROBE_CHUNK_SIZE = 8192;
const CENTRALITY_UPDATE_CHUNK_SIZE = 4096;

export interface IndexQualityPlaceholderRow {
  symbolId: string;
  status: string | null;
  kind: string | null;
  target: string | null;
}

export interface IndexQualityDbStats {
  unresolvedTargets: number;
  externalTargets: number;
  untypedPlaceholderTargets: number;
  isolatedPlaceholders: number;
  placeholderRows: IndexQualityPlaceholderRow[];
  missingSignatureByKind: Record<string, number>;
  scipPhaseCounts: Record<string, number>;
}

export interface GraphEntityCounts {
  symbolCount: number;
  edgeCount: number;
}

/** Read the graph-wide counts used by operational health checks. */
export async function getGraphEntityCounts(
  conn: Connection,
): Promise<GraphEntityCounts> {
  const symbolCountRow = await querySingle<{ symbolCount: unknown }>(
    conn,
    "MATCH (s:Symbol) RETURN count(s) AS symbolCount",
  );
  const edgeCountRow = await querySingle<{ edgeCount: unknown }>(
    conn,
    "MATCH ()-[d:DEPENDS_ON]->() RETURN count(d) AS edgeCount",
  );
  return {
    symbolCount: toNumber(symbolCountRow?.symbolCount ?? 0),
    edgeCount: toNumber(edgeCountRow?.edgeCount ?? 0),
  };
}

export async function countRealMetricsForRepo(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
     MATCH (m:Metrics)
     WHERE m.symbolId = s.symbolId
     RETURN count(m) AS count`,
    { repoId },
  );
  return toNumber(row?.count ?? 0);
}

/** Read index-quality audit rows with all Ladybug numeric values normalized. */
export async function readIndexQualityStats(
  conn: Connection,
  repoId: string,
): Promise<IndexQualityDbStats> {
  const unresolvedRow = await querySingle<{ unresolvedTargets: unknown }>(
    conn,
    `MATCH (a:Symbol {repoId: $repoId})-[d:DEPENDS_ON]->(b:Symbol)
     WHERE coalesce(b.symbolStatus, '') = 'unresolved'
     RETURN count(d) AS unresolvedTargets`,
    { repoId },
  );
  const untypedRow = await querySingle<{ untypedPlaceholderTargets: unknown }>(
    conn,
    `MATCH (a:Symbol {repoId: $repoId})-[d:DEPENDS_ON]->(b:Symbol)
     WHERE NOT (b)-[:SYMBOL_IN_FILE]->(:File)
       AND (b.symbolStatus IS NULL OR b.symbolStatus = '')
     RETURN count(d) AS untypedPlaceholderTargets`,
    { repoId },
  );
  const externalRow = await querySingle<{ externalTargets: unknown }>(
    conn,
    `MATCH (a:Symbol {repoId: $repoId})-[d:DEPENDS_ON]->(b:Symbol)
     WHERE coalesce(b.symbolStatus, '') = 'external'
        OR coalesce(b.external, false) = true
     RETURN count(d) AS externalTargets`,
    { repoId },
  );
  const missingSignatureRows = await queryAll<{ kind: string; count: unknown }>(
    conn,
    `MATCH (s:Symbol {repoId: $repoId})
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
       AND (s.signatureJson IS NULL OR s.signatureJson = '')
     RETURN s.kind AS kind, count(s) AS count`,
    { repoId },
  );
  const placeholderRows = await queryAll<IndexQualityPlaceholderRow>(
    conn,
    `MATCH (s:Symbol {repoId: $repoId})
     WHERE NOT (s)-[:SYMBOL_IN_FILE]->(:File)
       AND (
         s.symbolId STARTS WITH 'unresolved:'
         OR coalesce(s.symbolStatus, '') = 'unresolved'
         OR coalesce(s.symbolStatus, '') = 'external'
       )
     RETURN s.symbolId AS symbolId, s.symbolStatus AS status,
            s.placeholderKind AS kind, s.placeholderTarget AS target`,
    { repoId },
  );
  const isolatedRow = await querySingle<{ count: unknown }>(
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
     RETURN count(s) AS count`,
    { repoId },
  );
  const scipPhaseRows = await queryAll<{ phase: string; count: unknown }>(
    conn,
    `MATCH (a:Symbol {repoId: $repoId})-[d:DEPENDS_ON]->(:Symbol)
     WHERE d.resolutionPhase = 'scip' OR d.resolverId = 'scip'
     RETURN d.resolutionPhase AS phase, count(d) AS count`,
    { repoId },
  );

  return {
    unresolvedTargets: toNumber(unresolvedRow?.unresolvedTargets ?? 0),
    externalTargets: toNumber(externalRow?.externalTargets ?? 0),
    untypedPlaceholderTargets: toNumber(
      untypedRow?.untypedPlaceholderTargets ?? 0,
    ),
    isolatedPlaceholders: toNumber(isolatedRow?.count ?? 0),
    placeholderRows,
    missingSignatureByKind: Object.fromEntries(
      missingSignatureRows.map((row) => [row.kind ?? "unknown", toNumber(row.count)]),
    ),
    scipPhaseCounts: Object.fromEntries(
      scipPhaseRows.map((row) => [row.phase ?? "unknown", toNumber(row.count)]),
    ),
  };
}

export interface SymbolMissingMetricsRow {
  symbolId: string;
}

export type ReplaceMetricsForRepoCopyPhaseName =
  | "csvMaterialize"
  | "deleteExisting"
  | "copyFrom";

export interface ReplaceMetricsForRepoCopyOptions {
  measurePhase?: <T>(
    phaseName: ReplaceMetricsForRepoCopyPhaseName,
    fn: () => Promise<T>,
  ) => Promise<T>;
}

export type UpsertMetricsBatchPhaseName =
  | "prepareRows"
  | "probeExisting"
  | "copyMissing.csvMaterialize"
  | "copyMissing.copyFrom"
  | "createMissing"
  | "mergeExisting";

export interface UpsertMetricsBatchStats {
  chunks: number;
  missingRows: number;
  existingRows: number;
  copyMissingRows: number;
  createMissingRows: number;
}

export interface UpsertMetricsBatchOptions {
  copyMissingThresholdRows?: number;
  measurePhase?: <T>(
    phaseName: UpsertMetricsBatchPhaseName,
    fn: () => Promise<T> | T,
  ) => Promise<T>;
  stats?: UpsertMetricsBatchStats;
}

export type UpsertCentralityBatchPhaseName =
  | "prepareRows"
  | "probeExisting"
  | "updateExisting"
  | "mergeMissing";

export interface UpsertCentralityBatchStats {
  chunks: number;
  missingRows: number;
  existingRows: number;
}

export interface UpsertCentralityBatchOptions {
  /**
   * Use only when the caller has just materialized Metrics rows for every
   * symbol in `rows`. This avoids a full existence probe in post-index derived
   * refresh, where probing can dominate the centrality write.
   */
  assumeRowsExist?: boolean;
  measurePhase?: <T>(
    phaseName: UpsertCentralityBatchPhaseName,
    fn: () => Promise<T> | T,
  ) => Promise<T>;
  stats?: UpsertCentralityBatchStats;
}

export interface RepoFanCountRow {
  symbolId: string;
  count: number;
}

export interface MetricsFingerprintRow {
  repoId: string;
  metricsHash: string;
  rowCount: number;
  updatedAt: string;
}

function escapeCopyPath(path: string): string {
  return normalizePath(path).replace(/'/g, "''");
}

function escapeCopyOptionString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
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
         m.pageRank = $pageRank,
         m.kCore = $kCore,
         m.updatedAt = $updatedAt`,
    {
      symbolId: metrics.symbolId,
      fanIn: metrics.fanIn,
      fanOut: metrics.fanOut,
      churn30d: metrics.churn30d,
      testRefsJson: metrics.testRefsJson,
      canonicalTestJson: metrics.canonicalTestJson,
      pageRank: metrics.pageRank ?? 0,
      kCore: metrics.kCore ?? 0,
      updatedAt: metrics.updatedAt,
    },
  );
}

/**
 * Batch-upsert metrics rows via UNWIND-batched MERGE within a single
 * transaction. Side-effect mode (no RETURN) avoids LadybugDB issue #285.
 */
export async function upsertMetricsBatch(
  conn: Connection,
  rows: MetricsRow[],
  options?: UpsertMetricsBatchOptions,
): Promise<void> {
  if (rows.length === 0) return;
  const CHUNK = 256;
  const measurePhase =
    options?.measurePhase ??
    (async <T>(
      _phaseName: UpsertMetricsBatchPhaseName,
      fn: () => Promise<T> | T,
    ): Promise<T> => await fn());
  const copyMissingThresholdRows =
    options?.copyMissingThresholdRows ??
    DEFAULT_METRICS_MISSING_COPY_THRESHOLD_ROWS;
  rows = await measurePhase("prepareRows", () => dedupeMetricsRows(rows));
  await withTransaction(conn, async (txConn) => {
    const existingSymbolIds = await measurePhase("probeExisting", () =>
      getExistingMetricSymbolIds(txConn, rows.map((row) => row.symbolId)),
    );
    const missingRows: MetricsRow[] = [];
    const existingRows: MetricsRow[] = [];
    for (const row of rows) {
      if (existingSymbolIds.has(row.symbolId)) {
        existingRows.push(row);
      } else {
        missingRows.push(row);
      }
    }
    if (options?.stats) {
      options.stats.chunks += Math.ceil(rows.length / CHUNK);
      options.stats.missingRows += missingRows.length;
      options.stats.existingRows += existingRows.length;
    }

    if (missingRows.length >= copyMissingThresholdRows) {
      if (options?.stats) options.stats.copyMissingRows += missingRows.length;
      const tempDir = await mkdtemp(join(tmpdir(), "sdl-metrics-missing-"));
      const filePath = join(tempDir, "metrics.csv");
      try {
        await measurePhase("copyMissing.csvMaterialize", () =>
          writeMetricsCsv(filePath, missingRows),
        );
        await measurePhase("copyMissing.copyFrom", () =>
          execDdl(
            txConn,
            `COPY Metrics FROM '${escapeCopyPath(filePath)}' ` +
              `(HEADER=true, PARALLEL=FALSE, NULL_STRINGS=['${escapeCopyOptionString(CSV_NULL_SENTINEL)}'])`,
          ),
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    } else if (missingRows.length > 0) {
      if (options?.stats) options.stats.createMissingRows += missingRows.length;
      for (let i = 0; i < missingRows.length; i += CHUNK) {
        const chunk = toMetricsParamRows(missingRows.slice(i, i + CHUNK));
        await measurePhase("createMissing", () =>
          exec(
            txConn,
            `UNWIND $rows AS row
             CREATE (:Metrics {
               symbolId: row.symbolId,
               fanIn: row.fanIn,
               fanOut: row.fanOut,
               churn30d: row.churn30d,
               testRefsJson: row.testRefsJson,
               canonicalTestJson: row.canonicalTestJson,
               pageRank: row.pageRank,
               kCore: row.kCore,
               updatedAt: row.updatedAt
             })`,
            { rows: chunk },
          ),
        );
      }
    }

    for (let i = 0; i < existingRows.length; i += CHUNK) {
      const chunk = toMetricsParamRows(existingRows.slice(i, i + CHUNK));
      await measurePhase("mergeExisting", () =>
        exec(
          txConn,
          `UNWIND $rows AS row
           MATCH (m:Metrics {symbolId: row.symbolId})
           SET m.fanIn = row.fanIn,
               m.fanOut = row.fanOut,
               m.churn30d = row.churn30d,
               m.testRefsJson = row.testRefsJson,
               m.canonicalTestJson = row.canonicalTestJson,
               m.pageRank = row.pageRank,
               m.kCore = row.kCore,
               m.updatedAt = row.updatedAt`,
          { rows: chunk },
        ),
      );
    }
  });
}

function dedupeMetricsRows(rows: readonly MetricsRow[]): MetricsRow[] {
  const bySymbolId = new Map<string, MetricsRow>();
  for (const row of rows) {
    bySymbolId.set(row.symbolId, row);
  }
  return [...bySymbolId.values()];
}

function toMetricsParamRows(rows: readonly MetricsRow[]): Array<{
  symbolId: string;
  fanIn: number;
  fanOut: number;
  churn30d: number;
  testRefsJson: string | null;
  canonicalTestJson: string | null;
  pageRank: number;
  kCore: number;
  updatedAt: string;
}> {
  return rows.map((m) => ({
    symbolId: m.symbolId,
    fanIn: m.fanIn,
    fanOut: m.fanOut,
    churn30d: m.churn30d,
    testRefsJson: m.testRefsJson,
    canonicalTestJson: m.canonicalTestJson,
    pageRank: m.pageRank ?? 0,
    kCore: m.kCore ?? 0,
    updatedAt: m.updatedAt,
  }));
}

async function getExistingMetricSymbolIds(
  conn: Connection,
  symbolIds: readonly string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  for (let i = 0; i < symbolIds.length; i += METRICS_EXISTING_PROBE_CHUNK_SIZE) {
    const chunk = symbolIds.slice(i, i + METRICS_EXISTING_PROBE_CHUNK_SIZE);
    const rows = await queryAll<{ symbolId: string }>(
      conn,
      `MATCH (m:Metrics)
       WHERE m.symbolId IN $symbolIds
       RETURN m.symbolId AS symbolId`,
      { symbolIds: chunk },
    );
    for (const row of rows) {
      existing.add(row.symbolId);
    }
  }
  return existing;
}

export async function getMetricsFingerprint(
  conn: Connection,
  repoId: string,
): Promise<MetricsFingerprintRow | null> {
  const row = await querySingle<{
    repoId: string;
    metricsHash: string;
    rowCount: unknown;
    updatedAt: string;
  }>(
    conn,
    `MATCH (m:MetricsFingerprint {repoId: $repoId})
     RETURN m.repoId AS repoId,
            m.metricsHash AS metricsHash,
            m.rowCount AS rowCount,
            m.updatedAt AS updatedAt`,
    { repoId },
  );
  if (!row) return null;
  return {
    repoId: row.repoId,
    metricsHash: row.metricsHash,
    rowCount: toNumber(row.rowCount),
    updatedAt: row.updatedAt,
  };
}

export async function upsertMetricsFingerprint(
  conn: Connection,
  row: MetricsFingerprintRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (m:MetricsFingerprint {repoId: $repoId})
     SET m.metricsHash = $metricsHash,
         m.rowCount = $rowCount,
         m.updatedAt = $updatedAt`,
    {
      repoId: row.repoId,
      metricsHash: row.metricsHash,
      rowCount: row.rowCount,
      updatedAt: row.updatedAt,
    },
  );
}

export async function deleteMetricsFingerprint(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (m:MetricsFingerprint {repoId: $repoId})
     DELETE m`,
    { repoId },
  );
}

/**
 * Replace the complete metrics set for the repo's current symbols through
 * LadybugDB COPY. This is only for full-repo recomputation; partial
 * incremental updates must use upsertMetricsBatch so unchanged symbols keep
 * their previous metrics rows.
 */
export async function replaceMetricsForRepoCopy(
  conn: Connection,
  repoId: string,
  rows: MetricsRow[],
  options?: ReplaceMetricsForRepoCopyOptions,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "sdl-metrics-"));
  const filePath = join(tempDir, "metrics.csv");
  const measurePhase =
    options?.measurePhase ??
    (async <T>(
      _phaseName: ReplaceMetricsForRepoCopyPhaseName,
      fn: () => Promise<T>,
    ): Promise<T> => await fn());
  try {
    if (rows.length > 0) {
      await measurePhase("csvMaterialize", () => writeMetricsCsv(filePath, rows));
    }
    await withTransaction(conn, async (txConn) => {
      await measurePhase("deleteExisting", () =>
        exec(
          txConn,
          `MATCH (s:Symbol)
           WHERE s.repoId = $repoId
           MATCH (m:Metrics {symbolId: s.symbolId})
           DELETE m`,
          { repoId },
        ),
      );
      if (rows.length > 0) {
        await measurePhase("copyFrom", () =>
          execDdl(
            txConn,
            `COPY Metrics FROM '${escapeCopyPath(filePath)}' ` +
              `(HEADER=true, PARALLEL=FALSE, NULL_STRINGS=['${escapeCopyOptionString(CSV_NULL_SENTINEL)}'])`,
          ),
        );
      }
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeMetricsCsv(
  filePath: string,
  rows: readonly MetricsRow[],
): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  try {
    await writeCsvLine(stream, METRICS_COPY_COLUMNS);
    let buffer: string[] = [];

    const flush = async (): Promise<void> => {
      if (buffer.length === 0) return;
      const chunk = buffer.join("");
      buffer = [];
      if (!stream.write(chunk)) {
        await waitForDrain(stream);
      }
    };

    for (const row of rows) {
      buffer.push(csvLine([
        row.symbolId,
        row.fanIn,
        row.fanOut,
        row.churn30d,
        row.testRefsJson,
        row.canonicalTestJson,
        row.pageRank ?? 0,
        row.kCore ?? 0,
        row.updatedAt,
      ]));
      if (buffer.length >= METRICS_CSV_WRITE_BATCH_SIZE) {
        await flush();
      }
    }
    await flush();
    stream.end();
    await finished(stream);
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

async function writeCsvLine(
  stream: NodeJS.WritableStream,
  cells: readonly unknown[],
): Promise<void> {
  const line = csvLine(cells);
  if (!stream.write(line)) {
    await waitForDrain(stream);
  }
}

function csvLine(cells: readonly unknown[]): string {
  return `${cells.map(csvCell).join(",")}\n`;
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
  if (value === null || value === undefined) return CSV_NULL_SENTINEL;
  const text = String(value);
  if (text === "") return '""';
  const escaped = text.replaceAll('"', '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

export async function getSymbolsMissingMetricsByRepo(
  conn: Connection,
  repoId: string,
  limit?: number,
): Promise<SymbolMissingMetricsRow[]> {
  const params: Record<string, unknown> = { repoId };
  let limitClause = "";
  if (limit !== undefined) {
    assertSafeInt(limit, "limit");
    params.limit = Math.max(0, Math.min(limit, 1_000_000));
    limitClause = "\n     LIMIT $limit";
  }

  return await queryAll<SymbolMissingMetricsRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
     OPTIONAL MATCH (m:Metrics {symbolId: s.symbolId})
     WITH s, m
     WHERE m IS NULL
     RETURN s.symbolId AS symbolId
     ORDER BY s.symbolId${limitClause}`,
    params,
  );
}

export async function getRepoFanInCounts(
  conn: Connection,
  repoId: string,
): Promise<RepoFanCountRow[]> {
  const rows = await queryAll<{ symbolId: string; count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(src:Symbol)-[d:DEPENDS_ON]->(s:Symbol)-[:SYMBOL_IN_REPO]->(r)
     WHERE coalesce(src.symbolStatus, 'real') = 'real'
       AND coalesce(s.symbolStatus, 'real') = 'real'
     RETURN s.symbolId AS symbolId, count(d) AS count`,
    { repoId },
  );
  return rows.map((row) => ({
    symbolId: row.symbolId,
    count: toNumber(row.count),
  }));
}

export async function getRepoFanOutCounts(
  conn: Connection,
  repoId: string,
): Promise<RepoFanCountRow[]> {
  const rows = await queryAll<{ symbolId: string; count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(dst:Symbol)-[:SYMBOL_IN_REPO]->(r)
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
       AND coalesce(dst.symbolStatus, 'real') = 'real'
     RETURN s.symbolId AS symbolId, count(d) AS count`,
    { repoId },
  );
  return rows.map((row) => ({
    symbolId: row.symbolId,
    count: toNumber(row.count),
  }));
}

export async function copyMissingMetricsRows(
  conn: Connection,
  csvPath: string,
): Promise<void> {
  const safePath = escapeCopyPath(csvPath);
  await execDdl(conn, `COPY Metrics FROM '${safePath}' (HEADER=true)`);
}

/**
 * Batch-upsert centrality metrics only (pageRank + kCore). Used by the
 * algorithm stage of the cluster orchestrator to update only the new
 * centrality fields without touching fanIn/fanOut/churn/test refs.
 * Idempotent via MERGE.
 */
export async function upsertCentralityBatch(
  conn: Connection,
  rows: Array<{
    symbolId: string;
    pageRank: number;
    kCore: number;
    updatedAt: string;
  }>,
  options?: UpsertCentralityBatchOptions,
): Promise<void> {
  if (rows.length === 0) return;
  const measurePhase =
    options?.measurePhase ??
    (async <T>(
      _phaseName: UpsertCentralityBatchPhaseName,
      fn: () => Promise<T> | T,
    ): Promise<T> => await fn());
  rows = await measurePhase("prepareRows", () => dedupeCentralityRows(rows));
  await withTransaction(conn, async (txConn) => {
    let existingRows: typeof rows = [];
    const missingRows: typeof rows = [];
    if (options?.assumeRowsExist) {
      // Keep the array reference; spreading 250k+ centrality rows overflows
      // the JS call stack before DB chunking begins.
      existingRows = rows;
    } else {
      const existingSymbolIds = await measurePhase("probeExisting", () =>
        getExistingMetricSymbolIds(txConn, rows.map((row) => row.symbolId)),
      );
      for (const row of rows) {
        if (existingSymbolIds.has(row.symbolId)) {
          existingRows.push(row);
        } else {
          missingRows.push(row);
        }
      }
    }
    if (options?.stats) {
      options.stats.chunks += Math.ceil(rows.length / CENTRALITY_UPDATE_CHUNK_SIZE);
      options.stats.existingRows += existingRows.length;
      options.stats.missingRows += missingRows.length;
    }

    for (let i = 0; i < existingRows.length; i += CENTRALITY_UPDATE_CHUNK_SIZE) {
      const chunk = existingRows.slice(i, i + CENTRALITY_UPDATE_CHUNK_SIZE);
      await measurePhase("updateExisting", () =>
        exec(
          txConn,
          `UNWIND $rows AS row
           MATCH (m:Metrics {symbolId: row.symbolId})
           SET m.pageRank = row.pageRank,
               m.kCore = row.kCore,
               m.updatedAt = row.updatedAt`,
          { rows: chunk },
        ),
      );
    }

    for (let i = 0; i < missingRows.length; i += CENTRALITY_UPDATE_CHUNK_SIZE) {
      const chunk = missingRows.slice(i, i + CENTRALITY_UPDATE_CHUNK_SIZE);
      await measurePhase("mergeMissing", () =>
        exec(
          txConn,
          `UNWIND $rows AS row
           MERGE (m:Metrics {symbolId: row.symbolId})
           SET m.pageRank = row.pageRank,
               m.kCore = row.kCore,
               m.updatedAt = row.updatedAt`,
          { rows: chunk },
        ),
      );
    }
  });
}

function dedupeCentralityRows(
  rows: readonly {
    symbolId: string;
    pageRank: number;
    kCore: number;
    updatedAt: string;
  }[],
): Array<{
  symbolId: string;
  pageRank: number;
  kCore: number;
  updatedAt: string;
}> {
  const bySymbolId = new Map<string, {
    symbolId: string;
    pageRank: number;
    kCore: number;
    updatedAt: string;
  }>();
  for (const row of rows) {
    bySymbolId.set(row.symbolId, row);
  }
  return [...bySymbolId.values()];
}

/**
 * Batch-upsert canonical test mappings via UNWIND-batched MERGE. Wrapped in a
 * transaction to amortize commit overhead. Used during incremental indexing to
 * propagate canonical test changes to symbols not in the changed-file set.
 */
export async function upsertCanonicalTestBatch(
  conn: Connection,
  rows: Array<{ symbolId: string; canonicalTestJson: string | null; updatedAt: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  const CHUNK = 256;
  await withTransaction(conn, async (txConn) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await exec(
        txConn,
        `UNWIND $rows AS row
         MERGE (m:Metrics {symbolId: row.symbolId})
         SET m.canonicalTestJson = row.canonicalTestJson,
             m.updatedAt = row.updatedAt`,
        { rows: chunk },
      );
    }
  });
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
    pageRank: unknown;
    kCore: unknown;
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
            coalesce(m.pageRank, 0.0) AS pageRank,
            coalesce(m.kCore, 0) AS kCore,
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
    pageRank: toNumber(row.pageRank),
    kCore: toNumber(row.kCore),
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
    pageRank: unknown;
    kCore: unknown;
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
            coalesce(m.pageRank, 0.0) AS pageRank,
            coalesce(m.kCore, 0) AS kCore,
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
      pageRank: toNumber(row.pageRank),
      kCore: toNumber(row.kCore),
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

  const maxFetch = Math.min(limit, 10000);
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
    { repoId, limit: maxFetch },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    fanIn: toNumber(row.fanIn),
    fanOut: toNumber(row.fanOut),
    churn30d: toNumber(row.churn30d),
  }));
}

export async function getMetricsByRepo(
  conn: Connection,
  repoId: string,
): Promise<Map<string, MetricsRow>> {
  const rows = await queryAll<{
    symbolId: string;
    fanIn: unknown;
    fanOut: unknown;
    churn30d: unknown;
    testRefsJson: string | null;
    canonicalTestJson: string | null;
    pageRank: unknown;
    kCore: unknown;
    updatedAt: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     MATCH (m:Metrics {symbolId: s.symbolId})
     RETURN m.symbolId AS symbolId,
            m.fanIn AS fanIn,
            m.fanOut AS fanOut,
            m.churn30d AS churn30d,
            m.testRefsJson AS testRefsJson,
            m.canonicalTestJson AS canonicalTestJson,
            coalesce(m.pageRank, 0.0) AS pageRank,
            coalesce(m.kCore, 0) AS kCore,
            m.updatedAt AS updatedAt`,
    { repoId },
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
      pageRank: toNumber(row.pageRank),
      kCore: toNumber(row.kCore),
      updatedAt: row.updatedAt,
    });
  }
  return result;
}

export async function getTopSymbolsByChurn(
  conn: Connection,
  repoId: string,
  limit = 10,
): Promise<TopSymbolByFanInRow[]> {
  assertSafeInt(limit, "limit");
  limit = Math.max(0, Math.min(limit, 1000));

  const maxFetch = Math.min(limit, 10000);
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
    { repoId, limit: maxFetch },
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

  // NOTE: Ladybug can produce incorrect counts for large UNWIND lists, especially
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
