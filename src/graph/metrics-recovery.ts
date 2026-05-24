import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import type { MetricsRow } from "../db/ladybug-queries.js";
import type { IndexProgress } from "../indexer/indexer-init.js";
import { logger } from "../util/logger.js";

const COPY_THRESHOLD_ROWS = 10_000;

export interface MetricsRecoveryOptions {
  limit?: number;
  copyThresholdRows?: number;
  onProgress?: (progress: IndexProgress) => void;
  now?: () => Date;
}

export interface MetricsRecoveryResult {
  missingRows: number;
  repairedRows: number;
  writeMode: "none" | "batch" | "copy";
}

function emitMetricsProgress(
  onProgress: MetricsRecoveryOptions["onProgress"],
  message: string,
  current = 0,
  total = 0,
): void {
  onProgress?.({
    stage: "finalizing",
    substage: "metrics",
    current,
    total,
    stageCurrent: current,
    stageTotal: total,
    message,
  });
}

function countsBySymbol(
  rows: ladybugDb.RepoFanCountRow[],
): Map<string, number> {
  return new Map(rows.map((row) => [row.symbolId, row.count]));
}

function csvValue(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  return `"${value.replace(/"/g, '""')}"`;
}

function metricsRowsToCsv(rows: MetricsRow[]): string {
  const header = [
    "symbolId",
    "fanIn",
    "fanOut",
    "churn30d",
    "testRefsJson",
    "canonicalTestJson",
    "pageRank",
    "kCore",
    "updatedAt",
  ].join(",");
  const body = rows.map((row) =>
    [
      csvValue(row.symbolId),
      csvValue(row.fanIn),
      csvValue(row.fanOut),
      csvValue(row.churn30d),
      csvValue(row.testRefsJson),
      csvValue(row.canonicalTestJson),
      csvValue(row.pageRank ?? 0),
      csvValue(row.kCore ?? 0),
      csvValue(row.updatedAt),
    ].join(","),
  );
  return `${[header, ...body].join("\n")}\n`;
}

async function writeRowsWithCopy(rows: MetricsRow[]): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "sdl-metrics-recovery-"));
  const csvPath = join(tempDir, "metrics.csv");
  try {
    await writeFile(csvPath, metricsRowsToCsv(rows), "utf8");
    await withWriteConn((wConn) => ladybugDb.copyMissingMetricsRows(wConn, csvPath));
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch((error) => {
      logger.debug("Failed to remove metrics recovery temp directory", {
        tempDir,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export async function recoverMissingMetricsForRepo(
  repoId: string,
  options: MetricsRecoveryOptions = {},
): Promise<MetricsRecoveryResult> {
  const readConn = await getLadybugConn();
  emitMetricsProgress(options.onProgress, "Checking for missing metrics rows");
  const missing = await ladybugDb.getSymbolsMissingMetricsByRepo(
    readConn,
    repoId,
    options.limit,
  );
  if (missing.length === 0) {
    emitMetricsProgress(options.onProgress, "Metrics rows already complete");
    return { missingRows: 0, repairedRows: 0, writeMode: "none" };
  }

  emitMetricsProgress(
    options.onProgress,
    `Aggregating fan counts for ${missing.length} missing metrics rows`,
    0,
    missing.length,
  );
  const [fanInCounts, fanOutCounts] = await Promise.all([
    ladybugDb.getRepoFanInCounts(readConn, repoId),
    ladybugDb.getRepoFanOutCounts(readConn, repoId),
  ]);
  const fanInBySymbol = countsBySymbol(fanInCounts);
  const fanOutBySymbol = countsBySymbol(fanOutCounts);
  const updatedAt = (options.now?.() ?? new Date()).toISOString();
  const rows: MetricsRow[] = missing.map(({ symbolId }) => ({
    symbolId,
    fanIn: fanInBySymbol.get(symbolId) ?? 0,
    fanOut: fanOutBySymbol.get(symbolId) ?? 0,
    churn30d: 0,
    testRefsJson: "[]",
    canonicalTestJson: null,
    pageRank: 0,
    kCore: 0,
    updatedAt,
  }));

  const copyThreshold = options.copyThresholdRows ?? COPY_THRESHOLD_ROWS;
  const writeMode = rows.length >= copyThreshold ? "copy" : "batch";
  emitMetricsProgress(
    options.onProgress,
    `Writing ${rows.length} missing metrics rows via ${writeMode}`,
    0,
    rows.length,
  );
  if (writeMode === "copy") {
    await writeRowsWithCopy(rows);
  } else {
    await withWriteConn((wConn) => ladybugDb.upsertMetricsBatch(wConn, rows));
  }
  emitMetricsProgress(
    options.onProgress,
    `Recovered ${rows.length} missing metrics rows`,
    rows.length,
    rows.length,
  );

  return {
    missingRows: missing.length,
    repairedRows: rows.length,
    writeMode,
  };
}
