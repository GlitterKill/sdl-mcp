#!/usr/bin/env tsx
/**
 * Benchmark harness for delta blast-radius and task-text slice retrieval.
 *
 * Build first so the benchmark exercises the same runtime artifacts users run:
 *   npm run build
 *   npm run bench:delta-slice -- --repo sdl-mcp --label baseline
 *   npm run bench:delta-slice -- --repo sdl-mcp --label optimized
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";

import { resolveCliConfigPath } from "../dist/config/configPath.js";
import { loadConfig } from "../dist/config/loadConfig.js";
import { initGraphDb } from "../dist/db/initGraphDb.js";
import { getLadybugConn } from "../dist/db/ladybug.js";
import { queryAll } from "../dist/db/ladybug-queries.js";
import { getLatestVersion } from "../dist/db/ladybug-versions.js";
import { computeBlastRadius } from "../dist/delta/blastRadius.js";
import { buildSlice } from "../dist/graph/slice.js";

interface DeltaBenchRun {
  changedSymbolCount: number;
  maxHops: number;
  repeats: number;
  avgMs: number;
  p95Ms: number;
  resultCount: number;
}

interface SliceBenchRun {
  query: string;
  repeats: number;
  avgMs: number;
  p95Ms: number;
  cardCount: number;
  frontierCount: number;
}

interface BenchmarkReport {
  label: string;
  repoId: string;
  createdAt: string;
  gitCommit: string | null;
  nodeVersion: string;
  delta: DeltaBenchRun[];
  slice: SliceBenchRun[];
  notes: string[];
}

const DEFAULT_CHANGED_SIZES = [1, 10, 100];
const DEFAULT_MAX_HOPS = [2, 3, 6];
const DEFAULT_SLICE_QUERIES = [
  "optimize blast radius changed symbols",
  "task text hybrid retrieval start nodes",
  "observability retrieval phase metrics",
];

function getArg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.findIndex(
    (arg) => arg === flag || arg.startsWith(`${flag}=`),
  );
  if (index === -1) return fallback;
  const arg = process.argv[index];
  if (arg.includes("=")) return arg.split("=", 2)[1];
  return process.argv[index + 1] ?? fallback;
}

function parseCsvNumbers(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  const parsed = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  return parsed.length > 0 ? parsed : fallback;
}

function parseQueries(value: string | undefined): string[] {
  if (!value) return DEFAULT_SLICE_QUERIES;
  const parsed = value
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_SLICE_QUERIES;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function safeGitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function listBenchmarkSymbolIds(
  conn: Awaited<ReturnType<typeof getLadybugConn>>,
  repoId: string,
  limit: number,
): Promise<string[]> {
  const rows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WHERE coalesce(s.external, false) = false
     RETURN s.symbolId AS symbolId
     ORDER BY s.symbolId
     LIMIT $limit`,
    { repoId, limit },
  );
  return rows.map((row) => row.symbolId).filter(Boolean);
}

async function runDeltaBenchmarks(input: {
  conn: Awaited<ReturnType<typeof getLadybugConn>>;
  repoId: string;
  symbolIds: string[];
  sizes: number[];
  hops: number[];
  repeats: number;
}): Promise<DeltaBenchRun[]> {
  const runs: DeltaBenchRun[] = [];
  for (const requestedSize of input.sizes) {
    const changedSymbols = input.symbolIds.slice(0, requestedSize);
    if (changedSymbols.length === 0) continue;
    for (const maxHops of input.hops) {
      const timings: number[] = [];
      let resultCount = 0;
      for (let repeat = 0; repeat < input.repeats; repeat++) {
        const startedAt = performance.now();
        const result = await computeBlastRadius(input.conn, changedSymbols, {
          repoId: input.repoId,
          maxHops,
          maxResults: 200,
        });
        timings.push(performance.now() - startedAt);
        resultCount = result.length;
      }
      runs.push({
        changedSymbolCount: changedSymbols.length,
        maxHops,
        repeats: input.repeats,
        avgMs: average(timings),
        p95Ms: percentile(timings, 0.95),
        resultCount,
      });
    }
  }
  return runs;
}

async function runSliceBenchmarks(input: {
  conn: Awaited<ReturnType<typeof getLadybugConn>>;
  repoId: string;
  versionId: string;
  queries: string[];
  repeats: number;
}): Promise<SliceBenchRun[]> {
  const runs: SliceBenchRun[] = [];
  for (const query of input.queries) {
    const timings: number[] = [];
    let cardCount = 0;
    let frontierCount = 0;
    for (let repeat = 0; repeat < input.repeats; repeat++) {
      const startedAt = performance.now();
      const result = await buildSlice({
        conn: input.conn,
        repoId: input.repoId,
        versionId: input.versionId,
        taskText: query,
        budget: { maxCards: 25 },
      });
      timings.push(performance.now() - startedAt);
      cardCount = result.slice.cards.length;
      frontierCount = result.slice.frontier?.length ?? 0;
    }
    runs.push({
      query,
      repeats: input.repeats,
      avgMs: average(timings),
      p95Ms: percentile(timings, 0.95),
      cardCount,
      frontierCount,
    });
  }
  return runs;
}

function writeMarkdownSummary(report: BenchmarkReport, path: string): void {
  const lines = [
    `# Delta/Slice set-oriented benchmark - ${report.label}`,
    "",
    `- Created: ${report.createdAt}`,
    `- Repo: \`${report.repoId}\``,
    `- Commit: \`${report.gitCommit ?? "unknown"}\``,
    `- Node: \`${report.nodeVersion}\``,
    "",
    "## Delta Blast Radius",
    "",
    "| changed symbols | max hops | repeats | avg ms | p95 ms | result count |",
    "| :-- | :-- | :-- | --: | --: | --: |",
    ...report.delta.map(
      (run) =>
        `| ${run.changedSymbolCount} | ${run.maxHops} | ${run.repeats} | ${run.avgMs.toFixed(1)} | ${run.p95Ms.toFixed(1)} | ${run.resultCount} |`,
    ),
    "",
    "## Slice Retrieval",
    "",
    "| query | repeats | avg ms | p95 ms | cards | frontier |",
    "| :-- | :-- | --: | --: | --: | --: |",
    ...report.slice.map(
      (run) =>
        `| ${run.query.replace(/\|/g, "\\|")} | ${run.repeats} | ${run.avgMs.toFixed(1)} | ${run.p95Ms.toFixed(1)} | ${run.cardCount} | ${run.frontierCount} |`,
    ),
    "",
    "## Notes",
    "",
    ...report.notes.map((note) => `- ${note}`),
    "",
  ];
  writeFileSync(path, lines.join("\n"), "utf8");
}

async function main(): Promise<void> {
  const repoId = getArg("repo", "sdl-mcp")!;
  const label = getArg("label", "optimized")!;
  const repeats = Math.max(1, Number(getArg("repeats", "1")));
  const sizes = parseCsvNumbers(getArg("sizes"), DEFAULT_CHANGED_SIZES);
  const hops = parseCsvNumbers(getArg("hops"), DEFAULT_MAX_HOPS);
  const queries = parseQueries(getArg("queries"));
  const outDir = resolve(getArg("out-dir", ".tmp/delta-slice-benchmark")!);
  const summaryDir = resolve(
    getArg("summary-dir", "devdocs/benchmarks")!,
  );
  const configPath = resolveCliConfigPath(getArg("config"), "read");
  const config = loadConfig(configPath);

  mkdirSync(outDir, { recursive: true });
  mkdirSync(summaryDir, { recursive: true });

  await initGraphDb(config, configPath);
  const conn = await getLadybugConn();
  const maxSymbols = Math.max(...sizes);
  const symbolIds = await listBenchmarkSymbolIds(conn, repoId, maxSymbols);
  const latestVersion = await getLatestVersion(conn, repoId);
  const notes: string[] = [];
  if (symbolIds.length < maxSymbols) {
    notes.push(
      `Only ${symbolIds.length} repo-local symbols were available; larger requested delta sizes were capped.`,
    );
  }
  if (!latestVersion) {
    notes.push("No latest version was found; slice benchmarks were skipped.");
  }

  const delta = await runDeltaBenchmarks({
    conn,
    repoId,
    symbolIds,
    sizes,
    hops,
    repeats,
  });
  const slice = latestVersion
    ? await runSliceBenchmarks({
        conn,
        repoId,
        versionId: latestVersion.versionId,
        queries,
        repeats,
      })
    : [];

  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-");
  const report: BenchmarkReport = {
    label,
    repoId,
    createdAt,
    gitCommit: safeGitCommit(),
    nodeVersion: process.version,
    delta,
    slice,
    notes,
  };

  const jsonPath = resolve(outDir, `${label}-${stamp}.json`);
  const markdownPath = resolve(
    summaryDir,
    `delta-slice-set-oriented-${label}-${stamp.slice(0, 10)}.md`,
  );
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeMarkdownSummary(report, markdownPath);
  console.log(`[bench:delta-slice] wrote ${jsonPath}`);
  console.log(`[bench:delta-slice] wrote ${markdownPath}`);
}

main().catch((error) => {
  console.error(
    `[bench:delta-slice] fatal: ${
      error instanceof Error ? error.stack : String(error)
    }`,
  );
  process.exitCode = 1;
});
