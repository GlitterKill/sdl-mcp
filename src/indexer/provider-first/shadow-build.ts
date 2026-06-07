import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";

import { execDdl, querySingle, toNumber } from "../../db/ladybug-core.js";
import {
  createBaseSchema,
  createSecondaryIndexes,
  type SecondaryIndexBuildFailure,
} from "../../db/ladybug-schema.js";
import { hashValue } from "../../util/hashing.js";
import { normalizePath } from "../../util/paths.js";
import { validateProviderFirstGraphRows } from "./graph-validation.js";
import type { ProviderFirstGraphRows } from "./materializer.js";
import type { ProviderFirstShadowActivationSummary } from "./shadow-activation.js";
import type { ProviderFirstShadowFinalizationSummary } from "./shadow-finalization.js";

export type ProviderFirstShadowBuildStatus = "staged" | "skipped";
export type ProviderFirstShadowActivation = "shadowDb";
export type ProviderFirstShadowRequestedFormat = "parquet" | "csv";
export type ProviderFirstShadowFormat = "csv";

export interface ProviderFirstShadowBuildCounts {
  files: number;
  symbols: number;
  externalSymbols: number;
  edges: number;
}

export type ProviderFirstShadowDbLoadStatus = "loaded" | "skipped";

export interface ProviderFirstShadowDbSecondaryIndexSummary {
  attempted: number;
  failures: SecondaryIndexBuildFailure[];
}

export interface ProviderFirstShadowDbLoadCounts {
  repos: number;
  files: number;
  symbols: number;
  fileInRepo: number;
  symbolInFile: number;
  symbolInRepo: number;
  edges: number;
}

export type ProviderFirstShadowDbLoadSummary =
  | ProviderFirstShadowDbLoadedSummary
  | ProviderFirstShadowDbSkippedSummary;

export interface ProviderFirstShadowDbLoadedSummary {
  status: "loaded";
  path: string;
  expectedCounts: ProviderFirstShadowDbLoadCounts;
  actualCounts: ProviderFirstShadowDbLoadCounts;
  secondaryIndexes: ProviderFirstShadowDbSecondaryIndexSummary;
  loadedAt: string;
  reasons: string[];
}

export interface ProviderFirstShadowDbSkippedSummary {
  status: "skipped";
  path?: undefined;
  expectedCounts: ProviderFirstShadowDbLoadCounts;
  actualCounts?: undefined;
  secondaryIndexes?: ProviderFirstShadowDbSecondaryIndexSummary;
  loadedAt?: undefined;
  reasons: string[];
}

export interface ProviderFirstShadowBuildSummary {
  status: ProviderFirstShadowBuildStatus;
  activation: ProviderFirstShadowActivation;
  requestedFormat: ProviderFirstShadowRequestedFormat;
  format?: ProviderFirstShadowFormat;
  generationId: string;
  stagingDir?: string;
  manifestPath?: string;
  shadowDb?: ProviderFirstShadowDbLoadSummary;
  finalization?: ProviderFirstShadowFinalizationSummary;
  activationResult?: ProviderFirstShadowActivationSummary;
  counts: ProviderFirstShadowBuildCounts;
  reasons: string[];
}

export interface StageProviderFirstShadowBuildParams {
  repoId: string;
  generationId: string;
  activation: ProviderFirstShadowActivation;
  requestedFormat: ProviderFirstShadowRequestedFormat;
  activeDbPath?: string | null;
  repoRoot?: string;
  repoConfigJson?: string;
  rows: ProviderFirstGraphRows;
}

interface CsvArtifactManifest {
  path: string;
  columns: string[];
  rows: number;
  targetTable: string;
  kind: "node" | "relationship";
}

const REPO_COLUMNS = ["repoId", "rootPath", "configJson", "createdAt"] as const;

const FILE_COLUMNS = [
  "fileId",
  "relPath",
  "contentHash",
  "language",
  "byteSize",
  "lastIndexedAt",
  "directory",
] as const;

const SYMBOL_COLUMNS = [
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

const EDGE_COLUMNS = [
  "from",
  "to",
  "edgeType",
  "weight",
  "confidence",
  "resolution",
  "resolverId",
  "resolutionPhase",
  "provenance",
  "createdAt",
] as const;

const SIMPLE_REL_COLUMNS = ["from", "to"] as const;
const COPY_ORDER = [
  "repos",
  "files",
  "symbols",
  "externalSymbols",
  "fileInRepo",
  "symbolInFile",
  "symbolInRepo",
  "edges",
] as const;
const CSV_NULL_SENTINEL = "\\N";
const CSV_ARRAY_NULL = Symbol("providerFirstCsvArrayNull");

export async function stageProviderFirstShadowBuild(
  params: StageProviderFirstShadowBuildParams,
): Promise<ProviderFirstShadowBuildSummary> {
  const counts = providerFirstShadowBuildCounts(params.rows);
  validateProviderFirstGraphRows(params.rows, {
    repoId: params.repoId,
    context: "Provider-first shadow staging",
  });
  const reasons: string[] = [];
  if (!params.activeDbPath) {
    return {
      status: "skipped",
      activation: params.activation,
      requestedFormat: params.requestedFormat,
      generationId: params.generationId,
      counts,
      reasons: ["active LadybugDB path is not available for shadow staging"],
    };
  }

  const format: ProviderFirstShadowFormat = "csv";
  if (params.requestedFormat === "parquet") {
    reasons.push("Parquet staging is not available; wrote CSV fallback.");
  }

  const stagingDir = join(
    dirname(params.activeDbPath),
    "provider-first-shadow",
    safePathSegment(params.repoId),
    safePathSegment(params.generationId),
  );
  const manifestPath = join(stagingDir, "manifest.json");
  const shadowDbPath = join(stagingDir, "shadow.lbug");
  const createdAt = new Date().toISOString();

  try {
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });
    // Write nodes before relationships so the artifacts mirror the eventual
    // LadybugDB COPY load order and can be activated by a shadow loader without
    // relationship endpoint races.
    const artifacts = {
      repos: await writeCsvArtifact({
        stagingDir,
        fileName: "repos.csv",
        columns: [...REPO_COLUMNS],
        targetTable: "Repo",
        kind: "node",
        rows: [
          {
            repoId: params.repoId,
            rootPath: params.repoRoot ?? "",
            configJson: params.repoConfigJson ?? "{}",
            createdAt,
          },
        ],
        mapRow: (row) => [
          row.repoId,
          normalizePath(row.rootPath),
          row.configJson,
          row.createdAt,
        ],
      }),
      files: await writeCsvArtifact({
        stagingDir,
        fileName: "files.csv",
        columns: [...FILE_COLUMNS],
        targetTable: "File",
        kind: "node",
        rows: params.rows.files,
        mapRow: (row) => [
          row.fileId,
          normalizePath(row.relPath),
          row.contentHash,
          row.language,
          row.byteSize,
          row.lastIndexedAt,
          directoryForRelPath(row.relPath),
        ],
      }),
      symbols: await writeCsvArtifact({
        stagingDir,
        fileName: "symbols.csv",
        columns: [...SYMBOL_COLUMNS],
        targetTable: "Symbol",
        kind: "node",
        rows: params.rows.symbols,
        mapRow: symbolRowToCopyCells,
      }),
      externalSymbols: await writeCsvArtifact({
        stagingDir,
        fileName: "external-symbols.csv",
        columns: [...SYMBOL_COLUMNS],
        targetTable: "Symbol",
        kind: "node",
        rows: params.rows.externalSymbols,
        mapRow: externalSymbolRowToCopyCells,
      }),
      fileInRepo: await writeCsvArtifact({
        stagingDir,
        fileName: "file-in-repo.csv",
        columns: [...SIMPLE_REL_COLUMNS],
        targetTable: "FILE_IN_REPO",
        kind: "relationship",
        rows: params.rows.files,
        mapRow: (row) => [row.fileId, row.repoId],
      }),
      symbolInFile: await writeCsvArtifact({
        stagingDir,
        fileName: "symbol-in-file.csv",
        columns: [...SIMPLE_REL_COLUMNS],
        targetTable: "SYMBOL_IN_FILE",
        kind: "relationship",
        rows: params.rows.symbols,
        mapRow: (row) => [row.symbolId, row.fileId],
      }),
      symbolInRepo: await writeCsvArtifact({
        stagingDir,
        fileName: "symbol-in-repo.csv",
        columns: [...SIMPLE_REL_COLUMNS],
        targetTable: "SYMBOL_IN_REPO",
        kind: "relationship",
        rows: [...params.rows.symbols, ...params.rows.externalSymbols],
        mapRow: (row) => [row.symbolId, row.repoId],
      }),
      edges: await writeCsvArtifact({
        stagingDir,
        fileName: "depends-on.csv",
        columns: [...EDGE_COLUMNS],
        targetTable: "DEPENDS_ON",
        kind: "relationship",
        rows: params.rows.edges,
        mapRow: (row) => [
          row.fromSymbolId,
          row.toSymbolId,
          row.edgeType,
          row.weight,
          row.confidence,
          row.resolution,
          row.resolverId,
          row.resolutionPhase,
          row.provenance,
          row.createdAt,
        ],
      }),
    };
    const shadowDb = await loadProviderFirstShadowDb({
      shadowDbPath,
      artifacts,
      expectedCounts: expectedShadowDbLoadCounts(counts),
    });
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          version: 1,
          kind: "provider-first-shadow-staging",
          repoId: params.repoId,
          generationId: params.generationId,
          activation: params.activation,
          requestedFormat: params.requestedFormat,
          format,
          createdAt: new Date().toISOString(),
          counts,
          shadowDb,
          copyOrder: [...COPY_ORDER],
          artifacts,
          validation: {
            nodesBeforeRelationships: true,
            graphRowsValidated: true,
          },
          reasons,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    return {
      status: "staged",
      activation: params.activation,
      requestedFormat: params.requestedFormat,
      format,
      generationId: params.generationId,
      stagingDir: normalizePath(stagingDir),
      manifestPath: normalizePath(manifestPath),
      shadowDb,
      counts,
      reasons,
    };
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return {
      status: "skipped",
      activation: params.activation,
      requestedFormat: params.requestedFormat,
      generationId: params.generationId,
      counts,
      reasons: [`shadow staging failed: ${errorMessage(err)}`],
    };
  }
}

function providerFirstShadowBuildCounts(
  rows: ProviderFirstGraphRows,
): ProviderFirstShadowBuildCounts {
  return {
    files: rows.files.length,
    symbols: rows.symbols.length,
    externalSymbols: rows.externalSymbols.length,
    edges: rows.edges.length,
  };
}

async function writeCsvArtifact<T>(params: {
  stagingDir: string;
  fileName: string;
  columns: string[];
  targetTable: string;
  kind: "node" | "relationship";
  rows: readonly T[];
  mapRow: (row: T) => unknown[];
}): Promise<CsvArtifactManifest> {
  const filePath = join(params.stagingDir, params.fileName);
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  try {
    await writeCsvLine(stream, params.columns);
    for (const row of params.rows) {
      await writeCsvLine(stream, params.mapRow(row));
    }
    stream.end();
    await finished(stream);
  } catch (err) {
    stream.destroy();
    throw err;
  }
  return {
    path: normalizePath(filePath),
    columns: params.columns,
    rows: params.rows.length,
    targetTable: params.targetTable,
    kind: params.kind,
  };
}

async function loadProviderFirstShadowDb(params: {
  shadowDbPath: string;
  artifacts: Record<(typeof COPY_ORDER)[number], CsvArtifactManifest>;
  expectedCounts: ProviderFirstShadowDbLoadCounts;
}): Promise<ProviderFirstShadowDbLoadSummary> {
  try {
    await rm(params.shadowDbPath, { recursive: true, force: true });
    const kuzu = await import("kuzu");
    const db = new kuzu.Database(params.shadowDbPath);
    const conn = new kuzu.Connection(db);
    try {
      await createBaseSchema(conn);
      await copyArtifact(conn, "Repo", params.artifacts.repos);
      await copyArtifact(conn, "File", params.artifacts.files);
      await copyArtifact(conn, "Symbol", params.artifacts.symbols);
      await copyArtifact(conn, "Symbol", params.artifacts.externalSymbols);
      await copyArtifact(conn, "FILE_IN_REPO", params.artifacts.fileInRepo);
      await copyArtifact(conn, "SYMBOL_IN_FILE", params.artifacts.symbolInFile);
      await copyArtifact(conn, "SYMBOL_IN_REPO", params.artifacts.symbolInRepo);
      await copyArtifact(conn, "DEPENDS_ON", params.artifacts.edges);
      const secondaryIndexes = await createSecondaryIndexes(conn);
      const actualCounts = await readShadowDbCounts(conn);
      validateShadowDbCounts(actualCounts, params.expectedCounts);
      await execDdl(conn, "CHECKPOINT");
      return {
        status: "loaded",
        path: normalizePath(params.shadowDbPath),
        expectedCounts: params.expectedCounts,
        actualCounts,
        secondaryIndexes,
        loadedAt: new Date().toISOString(),
        reasons: shadowDbLoadReasons(secondaryIndexes),
      };
    } finally {
      await conn.close().catch(() => {});
      await db.close().catch(() => {});
    }
  } catch (err) {
    await rm(params.shadowDbPath, { recursive: true, force: true }).catch(
      () => {},
    );
    return {
      status: "skipped",
      expectedCounts: params.expectedCounts,
      reasons: [`shadow DB bulk load failed: ${errorMessage(err)}`],
    };
  }
}

async function copyArtifact(
  conn: import("kuzu").Connection,
  tableName: string,
  artifact: CsvArtifactManifest,
): Promise<void> {
  if (artifact.targetTable !== tableName) {
    throw new Error(
      `Provider-first shadow artifact target mismatch: expected ${tableName}, got ${artifact.targetTable}`,
    );
  }
  await execDdl(
    conn,
    `COPY ${tableName} FROM '${escapeCopyPath(artifact.path)}' ` +
      `(HEADER=true, PARALLEL=FALSE, NULL_STRINGS=['${escapeCopyOptionString(CSV_NULL_SENTINEL)}'])`,
  );
}

async function readShadowDbCounts(
  conn: import("kuzu").Connection,
): Promise<ProviderFirstShadowDbLoadCounts> {
  return {
    repos: await countShadowRows(
      conn,
      "MATCH (r:Repo) RETURN count(r) AS count",
    ),
    files: await countShadowRows(
      conn,
      "MATCH (f:File) RETURN count(f) AS count",
    ),
    symbols: await countShadowRows(
      conn,
      "MATCH (s:Symbol) RETURN count(s) AS count",
    ),
    fileInRepo: await countShadowRows(
      conn,
      "MATCH (:File)-[r:FILE_IN_REPO]->(:Repo) RETURN count(r) AS count",
    ),
    symbolInFile: await countShadowRows(
      conn,
      "MATCH (:Symbol)-[r:SYMBOL_IN_FILE]->(:File) RETURN count(r) AS count",
    ),
    symbolInRepo: await countShadowRows(
      conn,
      "MATCH (:Symbol)-[r:SYMBOL_IN_REPO]->(:Repo) RETURN count(r) AS count",
    ),
    edges: await countShadowRows(
      conn,
      "MATCH (:Symbol)-[r:DEPENDS_ON]->(:Symbol) RETURN count(r) AS count",
    ),
  };
}

async function countShadowRows(
  conn: import("kuzu").Connection,
  query: string,
): Promise<number> {
  const row = await querySingle<{ count: unknown }>(conn, query);
  return toNumber(row?.count ?? 0);
}

function validateShadowDbCounts(
  actual: ProviderFirstShadowDbLoadCounts,
  expected: ProviderFirstShadowDbLoadCounts,
): void {
  for (const key of Object.keys(expected) as Array<
    keyof ProviderFirstShadowDbLoadCounts
  >) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `Provider-first shadow DB ${key} count mismatch: expected ${expected[key]}, got ${actual[key]}`,
      );
    }
  }
}

function expectedShadowDbLoadCounts(
  counts: ProviderFirstShadowBuildCounts,
): ProviderFirstShadowDbLoadCounts {
  return {
    repos: 1,
    files: counts.files,
    symbols: counts.symbols + counts.externalSymbols,
    fileInRepo: counts.files,
    symbolInFile: counts.symbols,
    symbolInRepo: counts.symbols + counts.externalSymbols,
    edges: counts.edges,
  };
}

function symbolRowToCopyCells(row: ProviderFirstGraphRows["symbols"][number]): unknown[] {
  return [
    row.symbolId,
    row.repoId,
    row.kind,
    row.name,
    row.exported,
    row.visibility ?? "",
    row.language,
    row.rangeStartLine,
    row.rangeStartCol,
    row.rangeEndLine,
    row.rangeEndCol,
    row.astFingerprint,
    row.signatureJson ?? "",
    row.summary ?? "",
    row.summaryQuality ?? 0,
    row.summarySource ?? "unknown",
    row.invariantsJson ?? "",
    row.sideEffectsJson ?? "",
    row.roleTagsJson ?? "",
    row.searchText ?? "",
    row.updatedAt,
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
    row.external ?? false,
    row.scipSymbol,
    row.source ?? "treesitter",
    row.packageName,
    row.packageVersion,
    row.symbolStatus ?? "real",
    row.placeholderKind ?? "",
    row.placeholderTarget ?? "",
  ];
}

function externalSymbolRowToCopyCells(
  row: ProviderFirstGraphRows["externalSymbols"][number],
): unknown[] {
  const summary = `external ${row.name}`;
  return [
    row.symbolId,
    row.repoId,
    row.kind,
    row.name,
    row.exported,
    "public",
    row.language ?? "external",
    row.rangeStartLine ?? 0,
    row.rangeStartCol ?? 0,
    row.rangeEndLine ?? 0,
    row.rangeEndCol ?? 0,
    hashValue({ providerSymbolId: row.scipSymbol, packageName: row.packageName }),
    JSON.stringify({ text: `${row.kind} ${row.name}` }),
    summary,
    0.4,
    "provider:scip",
    null,
    null,
    JSON.stringify(["external"]),
    `${row.name} ${summary}`,
    row.updatedAt,
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
    row.external,
    row.scipSymbol,
    row.source,
    row.packageName ?? "",
    row.packageVersion ?? "",
    row.external ? "external" : "real",
    row.external ? "scip" : "",
    row.external ? row.scipSymbol : "",
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

function shadowDbLoadReasons(params: {
  failures: readonly SecondaryIndexBuildFailure[];
}): string[] {
  if (params.failures.length === 0) return [];
  const unsupported = params.failures.filter((failure) =>
    isUnsupportedSecondaryIndexFailure(failure),
  );
  const unexpected = params.failures.length - unsupported.length;
  const reasons: string[] = [];
  if (unsupported.length > 0) {
    reasons.push(
      `secondary indexes skipped: CREATE INDEX unsupported by LadybugDB runtime (${unsupported.length})`,
    );
  }
  if (unexpected > 0) {
    const noun = unexpected === 1 ? "build" : "builds";
    reasons.push(`${unexpected} secondary index ${noun} failed`);
  }
  return reasons;
}

function isUnsupportedSecondaryIndexFailure(
  failure: SecondaryIndexBuildFailure,
): boolean {
  return (
    failure.error.includes("Parser exception: Invalid input <CREATE INDEX") &&
    failure.error.includes("expected rule oC_SingleQuery")
  );
}

function safePathSegment(value: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const prefix = (safe || "unknown").slice(0, 111);
  return `${prefix}-${hashValue(value).slice(0, 8)}`;
}

function directoryForRelPath(relPath: string): string {
  const normalized = normalizePath(relPath);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
