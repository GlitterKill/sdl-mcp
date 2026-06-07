/**
 * ladybug-versions.ts - Version and Snapshot Operations
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
  assertSafeInt,
  withTransaction,
} from "./ladybug-core.js";
import { DEFAULT_BATCH_QUERY_LIMIT } from "../config/constants.js";
import { normalizePath } from "../util/paths.js";
import { resolveLadybugWriteChunkSize } from "./ladybug-batching.js";

const SYMBOL_VERSION_COPY_COLUMNS = [
  "id",
  "versionId",
  "symbolId",
  "astFingerprint",
  "signatureJson",
  "summary",
  "invariantsJson",
  "sideEffectsJson",
] as const;
const CSV_NULL_SENTINEL = "__sdl_ladybug_csv_null__";
const SYMBOL_VERSION_CSV_WRITE_BATCH_SIZE = 4096;

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
    `MERGE (r:Repo {repoId: $repoId})
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
    // Note: ISO-8601 string sort is correct because all createdAt values
    // use Date.toISOString() which produces consistent UTC format with ms precision.
    { repoId },
  );

  if (!row) return null;

  return { repoId, ...row };
}

export async function getVersionsByRepo(
  conn: Connection,
  repoId: string,
  limit = DEFAULT_BATCH_QUERY_LIMIT,
): Promise<VersionRow[]> {
  assertSafeInt(limit, "limit");
  const maxFetch = Math.max(0, Math.min(limit, 10000));

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
    { repoId, limit: maxFetch },
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

/**
 * Batch snapshot current symbol facts into SymbolVersion nodes. This preserves
 * the single-row snapshot semantics while avoiding one MERGE round trip per
 * symbol during full-index versioning.
 */
export async function snapshotSymbolVersionsBatch(
  conn: Connection,
  rows: Array<Omit<SymbolVersionRow, "id">>,
  options?: { chunkSize?: number },
): Promise<void> {
  if (rows.length === 0) return;
  const chunkSize = resolveLadybugWriteChunkSize(
    "symbolVersions",
    options?.chunkSize,
  );
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize).map((row) => ({
      id: `${row.versionId}:${row.symbolId}`,
      versionId: row.versionId,
      symbolId: row.symbolId,
      astFingerprint: row.astFingerprint,
      signatureJson: row.signatureJson,
      summary: row.summary,
      invariantsJson: row.invariantsJson,
      sideEffectsJson: row.sideEffectsJson,
    }));
    await withTransaction(conn, async (txConn) => {
      await exec(
        txConn,
        `UNWIND $rows AS row
         MERGE (sv:SymbolVersion {id: row.id})
         SET sv.versionId = row.versionId,
             sv.symbolId = row.symbolId,
             sv.astFingerprint = row.astFingerprint,
             sv.signatureJson = row.signatureJson,
             sv.summary = row.summary,
             sv.invariantsJson = row.invariantsJson,
             sv.sideEffectsJson = row.sideEffectsJson`,
        { rows: chunk },
      );
    });
  }
}

/**
 * Snapshot a known-fresh version through LadybugDB COPY. This is intentionally
 * separate from snapshotSymbolVersionsBatch because COPY cannot preserve MERGE
 * semantics for repair/reuse paths that may already contain SymbolVersion ids.
 */
export async function snapshotFreshSymbolVersionsCopy(
  conn: Connection,
  rows: Array<Omit<SymbolVersionRow, "id">>,
): Promise<void> {
  await snapshotFreshSymbolVersionsCopyPages(conn, [rows]);
}

export interface FreshSymbolVersionCopyWriter {
  writePage(rows: readonly Omit<SymbolVersionRow, "id">[]): Promise<void>;
  finish(conn: Connection): Promise<number>;
  dispose(): Promise<void>;
}

export async function createFreshSymbolVersionCopyWriter(): Promise<FreshSymbolVersionCopyWriter> {
  const tempDir = await mkdtemp(join(tmpdir(), "sdl-symbol-versions-"));
  const filePath = join(tempDir, "symbol-versions.csv");
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  let rowCount = 0;
  let closed = false;

  try {
    await writeCsvLine(stream, SYMBOL_VERSION_COPY_COLUMNS);
  } catch (err) {
    stream.destroy();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return {
    async writePage(rows): Promise<void> {
      if (closed) {
        throw new Error("Cannot write to closed SymbolVersion COPY writer");
      }
      rowCount += await writeSymbolVersionRows(stream, rows);
    },
    async finish(copyConn): Promise<number> {
      if (!closed) {
        stream.end();
        await finished(stream);
        closed = true;
      }
      if (rowCount > 0) {
        await execDdl(
          copyConn,
          `COPY SymbolVersion FROM '${escapeCopyPath(filePath)}' ` +
            `(HEADER=true, PARALLEL=FALSE, NULL_STRINGS=['${escapeCopyOptionString(CSV_NULL_SENTINEL)}'])`,
        );
      }
      return rowCount;
    },
    async dispose(): Promise<void> {
      if (!closed) {
        stream.destroy();
        closed = true;
      }
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Snapshot a known-fresh version from paged row batches through one streaming
 * CSV artifact and one COPY call. The caller can keep source reads bounded
 * while avoiding one temp file and COPY invocation per page.
 */
export async function snapshotFreshSymbolVersionsCopyPages(
  conn: Connection,
  pages:
    | Iterable<readonly Omit<SymbolVersionRow, "id">[]>
    | AsyncIterable<readonly Omit<SymbolVersionRow, "id">[]>,
): Promise<number> {
  const writer = await createFreshSymbolVersionCopyWriter();
  try {
    for await (const rows of pages) {
      await writer.writePage(rows);
    }
    return await writer.finish(conn);
  } finally {
    await writer.dispose();
  }
}

async function writeSymbolVersionRows(
  stream: NodeJS.WritableStream,
  rows: readonly Omit<SymbolVersionRow, "id">[],
): Promise<number> {
  let rowCount = 0;
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
      `${row.versionId}:${row.symbolId}`,
      row.versionId,
      row.symbolId,
      row.astFingerprint,
      row.signatureJson,
      row.summary,
      row.invariantsJson,
      row.sideEffectsJson,
    ]));
    rowCount += 1;
    if (buffer.length >= SYMBOL_VERSION_CSV_WRITE_BATCH_SIZE) {
      await flush();
    }
  }
  await flush();
  return rowCount;
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

function escapeCopyPath(path: string): string {
  return normalizePath(path).replace(/'/g, "''");
}

function escapeCopyOptionString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

export async function getSymbolVersionsByIds(
  conn: Connection,
  versionId: string,
  symbolIds: string[],
): Promise<SymbolVersionRow[]> {
  if (symbolIds.length === 0) return [];

  const rows = await queryAll<SymbolVersionRow>(
    conn,
    `MATCH (sv:SymbolVersion {versionId: $versionId})
     WHERE sv.symbolId IN $symbolIds
     RETURN sv.id AS id,
            sv.versionId AS versionId,
            sv.symbolId AS symbolId,
            sv.astFingerprint AS astFingerprint,
            sv.signatureJson AS signatureJson,
            sv.summary AS summary,
            sv.invariantsJson AS invariantsJson,
            sv.sideEffectsJson AS sideEffectsJson`,
    { versionId, symbolIds },
  );
  return rows;
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
