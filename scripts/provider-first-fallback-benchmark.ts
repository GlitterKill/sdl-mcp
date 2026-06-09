import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

interface Args {
  config: string;
  repoId?: string;
  sampleSize: number;
  seed: string;
  repeats: number;
  outDir: string;
  priorityFileList?: string;
  maxLegacyFallbackFiles?: number;
  pass2Concurrency?: number;
}

interface FileMetadata {
  path: string;
  size: number;
  mtime: number;
}

interface SelectionResult {
  files: FileMetadata[];
  providerCandidateFiles: number;
  providerSelectedFiles: number;
  providerTarget: number;
  priorityCandidateFiles: number;
  prioritySelectedFiles: number;
  priorityTarget: number;
}

interface BenchmarkRunMetrics {
  repeat: number;
  exitCode: number | null;
  wallTimeMs?: number;
  durationMs?: number;
  providerFirstTotalMs?: number;
  providerPrimaryFiles?: number;
  semanticEligibleFiles?: number;
  scannedFiles?: number;
  providerDocs?: number;
  fallbackFiles?: number;
  fallbackTotalMs?: number;
  fallbackEngine?: FallbackEngineMetric;
  legacyFallbackPhases?: LegacyFallbackPhaseMetrics;
  pass2Resolvers?: Pass2ResolverBenchmarkMetric[];
  providerUnusableFiles?: number;
  warningCount: number;
  errorCount: number;
  stdoutPath: string;
  stderrPath: string;
  configPath: string;
  graphDbPath: string;
}

interface FallbackEngineMetric {
  engine: string;
  mode: string;
  concurrency: number;
  workers: number;
  batchPersist: boolean;
  autoDrain: boolean;
  nativeChunks: string;
  drainBetweenChunks: boolean;
}

interface LegacyFallbackPhaseMetrics {
  pass1Ms?: number;
  pass1DrainMs?: number;
  pass2Ms?: number;
  finalizeMs?: number;
  pass2TargetSelectionMs?: number;
  pass2ImportCacheMs?: number;
  pass2ResolverDispatchMs?: number;
  pass2WriteActiveMs?: number;
  pass2WriteQueueMs?: number;
}

interface Pass2ResolverBenchmarkMetric {
  resolverId: string;
  targets: number;
  files: number;
  edges: number;
  cumulativeMs: number;
  unresolved: number;
  ambiguous: number;
  broken: number;
}

interface ChildRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    config: "config/sdlmcp.config.json",
    sampleSize: 8000,
    seed: "provider-first-fallback-v1",
    repeats: 1,
    outDir: join(
      "devdocs",
      "benchmarks",
      "provider-first-fallback",
      timestamp(),
    ),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case "--config":
        args.config = requireValue(arg, value);
        i++;
        break;
      case "--repo-id":
        args.repoId = requireValue(arg, value);
        i++;
        break;
      case "--sample-size":
        args.sampleSize = Number.parseInt(requireValue(arg, value), 10);
        i++;
        break;
      case "--seed":
        args.seed = requireValue(arg, value);
        i++;
        break;
      case "--repeats":
        args.repeats = Number.parseInt(requireValue(arg, value), 10);
        i++;
        break;
      case "--out-dir":
        args.outDir = requireValue(arg, value);
        i++;
        break;
      case "--priority-file-list":
        args.priorityFileList = requireValue(arg, value);
        i++;
        break;
      case "--max-legacy-fallback-files":
        args.maxLegacyFallbackFiles = Number.parseInt(
          requireValue(arg, value),
          10,
        );
        i++;
        break;
      case "--pass2-concurrency":
        args.pass2Concurrency = Number.parseInt(requireValue(arg, value), 10);
        i++;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.sampleSize) || args.sampleSize < 1) {
    throw new Error("--sample-size must be a positive integer");
  }
  if (!Number.isInteger(args.repeats) || args.repeats < 1) {
    throw new Error("--repeats must be a positive integer");
  }
  if (
    args.pass2Concurrency !== undefined &&
    (!Number.isInteger(args.pass2Concurrency) || args.pass2Concurrency < 1)
  ) {
    throw new Error("--pass2-concurrency must be a positive integer");
  }
  return args;
}

function requireValue(name: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function stableScore(seed: string, value: string): number {
  return createHash("sha256")
    .update(seed)
    .update("\0")
    .update(value)
    .digest()
    .readUInt32BE(0);
}

function groupKey(path: string): string {
  const normalized = normalizePath(path);
  const ext = normalized.includes(".")
    ? normalized.slice(normalized.lastIndexOf(".")).toLowerCase()
    : "<none>";
  const top = normalized.split("/")[0] ?? "<root>";
  const second = normalized.split("/")[1] ?? "<root>";
  return `${ext}:${top}/${second}`;
}

function selectRepresentativeFiles(
  files: readonly FileMetadata[],
  sampleSize: number,
  seed: string,
  priorityPaths: ReadonlySet<string>,
  providerPaths: ReadonlySet<string>,
): SelectionResult {
  const byPath = new Map(files.map((file) => [normalizePath(file.path), file]));
  const selected = new Map<string, FileMetadata>();
  const providerCandidateFiles = [...providerPaths].filter((path) =>
    byPath.has(normalizePath(path)),
  ).length;
  const priorityCandidateFiles = [...priorityPaths].filter((path) =>
    byPath.has(normalizePath(path)),
  ).length;
  const priorityTarget = Math.min(
    priorityCandidateFiles,
    Math.floor(sampleSize * 0.4),
  );
  const providerTarget =
    providerCandidateFiles > 0
      ? Math.min(
          providerCandidateFiles,
          Math.max(1, Math.floor(sampleSize * 0.4)),
        )
      : 0;

  const orderedPriorityPaths = [...priorityPaths].sort(
    (left, right) => stableScore(seed, left) - stableScore(seed, right),
  );
  for (const path of orderedPriorityPaths) {
    if (selected.size >= sampleSize || selected.size >= priorityTarget) {
      break;
    }
    const file = byPath.get(normalizePath(path));
    if (file) selected.set(file.path, file);
  }

  const orderedProviderPaths = [...providerPaths].sort(
    (left, right) => stableScore(seed, left) - stableScore(seed, right),
  );
  for (const path of orderedProviderPaths) {
    if (
      selected.size >= sampleSize ||
      countSelectedProviderFiles(selected, providerPaths) >= providerTarget
    ) {
      break;
    }
    const file = byPath.get(normalizePath(path));
    if (file) selected.set(file.path, file);
  }

  const remaining = files.filter((file) => !selected.has(file.path));
  const groups = new Map<string, FileMetadata[]>();
  for (const file of remaining) {
    const key = groupKey(file.path);
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }

  const orderedGroups = [...groups.entries()]
    .map(([key, group]) => ({
      key,
      group: group.sort(
        (left, right) =>
          stableScore(seed, left.path) - stableScore(seed, right.path),
      ),
      cursor: 0,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));

  while (selected.size < sampleSize && orderedGroups.length > 0) {
    let madeProgress = false;
    for (const entry of orderedGroups) {
      if (selected.size >= sampleSize) break;
      const next = entry.group[entry.cursor++];
      if (!next) continue;
      selected.set(next.path, next);
      madeProgress = true;
    }
    if (!madeProgress) break;
  }

  const selectedFiles = [...selected.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  return {
    files: selectedFiles,
    providerCandidateFiles,
    providerSelectedFiles: selectedFiles.filter((file) =>
      providerPaths.has(normalizePath(file.path)),
    ).length,
    providerTarget,
    priorityCandidateFiles,
    prioritySelectedFiles: selectedFiles.filter((file) =>
      priorityPaths.has(normalizePath(file.path)),
    ).length,
    priorityTarget,
  };
}

function countSelectedProviderFiles(
  selected: ReadonlyMap<string, FileMetadata>,
  providerPaths: ReadonlySet<string>,
): number {
  let count = 0;
  for (const file of selected.values()) {
    if (providerPaths.has(normalizePath(file.path))) count++;
  }
  return count;
}

function readPriorityPaths(path: string | undefined): Set<string> {
  if (!path) return new Set();
  const absolute = resolve(path);
  const raw = readFileSync(absolute, "utf8");
  if (absolute.endsWith(".json")) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("--priority-file-list JSON must be an array");
    }
    return new Set(
      parsed
        .map((entry) => {
          if (typeof entry === "string") return normalizePath(entry);
          if (
            entry &&
            typeof entry === "object" &&
            "path" in entry &&
            typeof entry.path === "string"
          ) {
            return normalizePath(entry.path);
          }
          return undefined;
        })
        .filter((entry): entry is string => Boolean(entry)),
    );
  }
  return new Set(
    raw
      .split(/\r?\n/)
      .map((line) => normalizePath(line.trim()))
      .filter((line) => line && !line.startsWith("#")),
  );
}

function summarizeSelection(files: readonly FileMetadata[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const file of files) {
    const key = groupKey(file.path);
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(summary).sort((left, right) => left[0].localeCompare(right[0])),
  );
}

async function readProviderDocumentPaths(
  repoRoot: string,
  scipConfig: { enabled?: boolean; indexes?: Array<{ path: string }> } | undefined,
): Promise<Set<string>> {
  const providerPaths = new Set<string>();
  if (!scipConfig?.enabled || !scipConfig.indexes || scipConfig.indexes.length === 0) {
    return providerPaths;
  }
  const { createScipDecoder } = await import("../dist/scip/decoder-factory.js");
  for (const index of scipConfig.indexes) {
    const indexPath = resolve(repoRoot, index.path);
    if (!existsSync(indexPath)) continue;
    const decoder = await createScipDecoder(indexPath);
    try {
      for await (const document of decoder.documents()) {
        if (document.relativePath) {
          providerPaths.add(normalizePath(document.relativePath));
        }
      }
    } finally {
      decoder.close();
    }
  }
  return providerPaths;
}

function parseMetrics(
  repeat: number,
  stdout: string,
  stderr: string,
  paths: Pick<
    BenchmarkRunMetrics,
    "exitCode" | "stdoutPath" | "stderrPath" | "configPath" | "graphDbPath"
  >,
): BenchmarkRunMetrics {
  const providerCoverage = stdout.match(
    /Provider-first coverage: (\d+)\/(\d+) .* provider-primary/,
  );
  const scanScope = stdout.match(/scan scope (\d+), provider docs (\d+)/);
  const fallback = stdout.match(
    /Provider-first legacy fallback diagnostics: files=(\d+) total=(\d+)ms/,
  );
  const providerUnusableMatches = [
    ...stdout.matchAll(/: (\d+) file\(s\)(?:;|$)/g),
  ];
  return {
    repeat,
    exitCode: paths.exitCode,
    wallTimeMs: numberMatch(stdout, /Wall time: (\d+)ms/),
    durationMs: numberMatch(stdout, /Duration: (\d+)ms/),
    providerFirstTotalMs: numberMatch(
      stdout,
      /Provider-first timings: total=(\d+)ms/,
    ),
    providerPrimaryFiles: providerCoverage
      ? Number.parseInt(providerCoverage[1], 10)
      : undefined,
    semanticEligibleFiles: providerCoverage
      ? Number.parseInt(providerCoverage[2], 10)
      : undefined,
    scannedFiles: scanScope
      ? Number.parseInt(scanScope[1], 10)
      : numberMatch(stdout, /scanned (\d+) file\(s\)/),
    providerDocs: scanScope ? Number.parseInt(scanScope[2], 10) : undefined,
    fallbackFiles: fallback ? Number.parseInt(fallback[1], 10) : undefined,
    fallbackTotalMs: fallback ? Number.parseInt(fallback[2], 10) : undefined,
    fallbackEngine: parseFallbackEngineMetric(stdout),
    legacyFallbackPhases: parseLegacyFallbackPhaseMetrics(stdout),
    pass2Resolvers: parsePass2ResolverMetrics(stdout),
    providerUnusableFiles: providerUnusableMatches.reduce(
      (sum, match) => sum + Number.parseInt(match[1], 10),
      0,
    ),
    warningCount:
      countMatches(stderr, /\bwarn(?:ing)?\b/gi) +
      countMatches(stdout, /(^|\n)\s*(?:warn(?:ing)?|\[warn\])/gi),
    errorCount:
      countMatches(stderr, /\berror\b/gi) +
      countMatches(stdout, /(^|\n)\s*(?:error:|Error:|\[error\])/g),
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    configPath: paths.configPath,
    graphDbPath: paths.graphDbPath,
  };
}

function parseFallbackEngineMetric(
  stdout: string,
): FallbackEngineMetric | undefined {
  const match = stdout.match(
    /pass 1 engine=(\S+) fallback=(\S+) concurrency=(\d+) workers=(\d+) batchPersist=(on|off) autoDrain=(on|off) nativeChunks=(\S+) drainBetweenChunks=(on|off)/,
  );
  if (!match) return undefined;
  return {
    engine: match[1],
    mode: match[2],
    concurrency: Number.parseInt(match[3], 10),
    workers: Number.parseInt(match[4], 10),
    batchPersist: match[5] === "on",
    autoDrain: match[6] === "on",
    nativeChunks: match[7],
    drainBetweenChunks: match[8] === "on",
  };
}

function parseLegacyFallbackPhaseMetrics(
  stdout: string,
): LegacyFallbackPhaseMetrics | undefined {
  const topLevel = stdout.match(
    /pass1=(\d+)ms, pass1Drain=(\d+)ms,\s+pass2=(\d+)ms, finalize=(\d+)ms/,
  );
  const pass2 = stdout.match(
    /pass2: targetSelection=(\d+)ms,\s+importCache=(\d+)ms, resolverDispatch=(\d+)ms, writeActive=(\d+)ms, writeQueue=(\d+)ms/,
  );
  if (!topLevel && !pass2) return undefined;
  return {
    pass1Ms: topLevel ? Number.parseInt(topLevel[1], 10) : undefined,
    pass1DrainMs: topLevel ? Number.parseInt(topLevel[2], 10) : undefined,
    pass2Ms: topLevel ? Number.parseInt(topLevel[3], 10) : undefined,
    finalizeMs: topLevel ? Number.parseInt(topLevel[4], 10) : undefined,
    pass2TargetSelectionMs: pass2 ? Number.parseInt(pass2[1], 10) : undefined,
    pass2ImportCacheMs: pass2 ? Number.parseInt(pass2[2], 10) : undefined,
    pass2ResolverDispatchMs: pass2 ? Number.parseInt(pass2[3], 10) : undefined,
    pass2WriteActiveMs: pass2 ? Number.parseInt(pass2[4], 10) : undefined,
    pass2WriteQueueMs: pass2 ? Number.parseInt(pass2[5], 10) : undefined,
  };
}

function parsePass2ResolverMetrics(
  stdout: string,
): Pass2ResolverBenchmarkMetric[] | undefined {
  const line = stdout.match(/pass2\.resolvers: ([^\r\n]+)/)?.[1];
  if (!line) return undefined;
  const metrics = line
    .split(";")
    .map((entry) => entry.trim())
    .flatMap((entry) => {
      const match = entry.match(
        /^(\S+) targets=(\d+) files=(\d+) edges=(\d+) cumulative=(\d+)ms unresolved=(\d+) ambiguous=(\d+) broken=(\d+)$/,
      );
      if (!match) return [];
      return [
        {
          resolverId: match[1],
          targets: Number.parseInt(match[2], 10),
          files: Number.parseInt(match[3], 10),
          edges: Number.parseInt(match[4], 10),
          cumulativeMs: Number.parseInt(match[5], 10),
          unresolved: Number.parseInt(match[6], 10),
          ambiguous: Number.parseInt(match[7], 10),
          broken: Number.parseInt(match[8], 10),
        },
      ];
    });
  return metrics.length > 0 ? metrics : undefined;
}

function numberMatch(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function median(values: Array<number | undefined>): number | undefined {
  const clean = values
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  if (clean.length === 0) return undefined;
  return clean[Math.floor(clean.length / 2)];
}

function runIndexCommand(params: {
  args: readonly string[];
  stdoutPath: string;
  stderrPath: string;
}): Promise<ChildRunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutStream = createWriteStream(params.stdoutPath, { flags: "w" });
    const stderrStream = createWriteStream(params.stderrPath, { flags: "w" });
    const child = spawn(process.execPath, params.args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      stdoutStream.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrStream.write(chunk);
    });
    child.on("error", (error) => {
      stdoutStream.end();
      stderrStream.end();
      rejectRun(error);
    });
    child.on("close", (exitCode) => {
      stdoutStream.end();
      stderrStream.end();
      resolveRun({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });

  if (!existsSync(resolve("dist/cli/index.js"))) {
    throw new Error("dist/cli/index.js missing; run npm run build:runtime first");
  }

  const [{ loadConfig }, { scanRepository }] = await Promise.all([
    import("../dist/config/loadConfig.js"),
    import("../dist/indexer/fileScanner.js"),
  ]);
  const configPath = resolve(args.config);
  const loadedConfig = loadConfig(configPath);
  const repo =
    loadedConfig.repos.find((candidate: { repoId: string }) =>
      args.repoId ? candidate.repoId === args.repoId : true,
    ) ?? null;
  if (!repo) {
    throw new Error(`Repo not found: ${args.repoId ?? "<first repo>"}`);
  }

  const allFiles = (await scanRepository(repo.rootPath, {
    ...repo,
    sourceFileListPath: undefined,
  })) as FileMetadata[];
  const priorityPaths = readPriorityPaths(args.priorityFileList);
  const selection = selectRepresentativeFiles(
    allFiles,
    args.sampleSize,
    args.seed,
    priorityPaths,
    await readProviderDocumentPaths(repo.rootPath, loadedConfig.scip),
  );
  const selected = selection.files;
  const sourceFileListPath = join(outDir, "source-files.txt");
  writeFileSync(
    sourceFileListPath,
    `${selected.map((file) => file.path).join("\n")}\n`,
    "utf8",
  );
  writeFileSync(
    join(outDir, "source-files.json"),
    JSON.stringify(selected, null, 2),
    "utf8",
  );
  writeFileSync(
    join(outDir, "selection.json"),
    JSON.stringify(
      {
        repoId: repo.repoId,
        repoRoot: repo.rootPath,
        seed: args.seed,
        requestedSampleSize: args.sampleSize,
        totalCandidateFiles: allFiles.length,
        selectedFiles: selected.length,
        priorityFileList: args.priorityFileList
          ? resolve(args.priorityFileList)
          : null,
        priorityCandidateFiles: selection.priorityCandidateFiles,
        prioritySelectedFiles: selection.prioritySelectedFiles,
        priorityTarget: selection.priorityTarget,
        providerCandidateFiles: selection.providerCandidateFiles,
        providerSelectedFiles: selection.providerSelectedFiles,
        providerTarget: selection.providerTarget,
        groups: summarizeSelection(selected),
      },
      null,
      2,
    ),
    "utf8",
  );

  const rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const runMetrics: BenchmarkRunMetrics[] = [];

  for (let repeat = 1; repeat <= args.repeats; repeat++) {
    const runConfig = structuredClone(rawConfig);
    const repoConfig = runConfig.repos.find(
      (candidate: { repoId: string }) => candidate.repoId === repo.repoId,
    );
    repoConfig.sourceFileListPath = sourceFileListPath;
    runConfig.graphDatabase = {
      ...(runConfig.graphDatabase ?? {}),
      path: normalizePath(join(outDir, `repeat-${repeat}.lbug`)),
    };
    runConfig.indexing = {
      ...(runConfig.indexing ?? {}),
      pipeline: "providerFirst",
      providerFirst: {
        ...(runConfig.indexing?.providerFirst ?? {}),
        maxLegacyFallbackFiles:
          args.maxLegacyFallbackFiles ?? Math.max(args.sampleSize, selected.length),
      },
    };
    if (args.pass2Concurrency !== undefined) {
      runConfig.indexing.pass2Concurrency = args.pass2Concurrency;
    }
    const runConfigPath = join(outDir, `repeat-${repeat}.config.json`);
    writeFileSync(runConfigPath, JSON.stringify(runConfig, null, 2), "utf8");

    const stdoutPath = join(outDir, `repeat-${repeat}.stdout.log`);
    const stderrPath = join(outDir, `repeat-${repeat}.stderr.log`);
    const graphDbPath = runConfig.graphDatabase.path;
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }

    const started = Date.now();
    const result = await runIndexCommand({
      args: [
        "dist/cli/index.js",
        "--config",
        runConfigPath,
        "index",
        "--repo-id",
        repo.repoId,
        "--force",
        "--diagnostics",
      ],
      stdoutPath,
      stderrPath,
    });
    const stdout = result.stdout;
    const stderr = result.stderr;

    const metrics = parseMetrics(repeat, stdout, stderr, {
      exitCode: result.exitCode,
      stdoutPath,
      stderrPath,
      configPath: runConfigPath,
      graphDbPath,
    });
    metrics.wallTimeMs ??= Date.now() - started;
    runMetrics.push(metrics);
    writeFileSync(
      join(outDir, `repeat-${repeat}.metrics.json`),
      JSON.stringify(metrics, null, 2),
      "utf8",
    );
    console.log(
      `repeat ${repeat}: exit=${metrics.exitCode} wall=${metrics.wallTimeMs}ms fallback=${metrics.fallbackFiles ?? "n/a"} provider=${metrics.providerPrimaryFiles ?? "n/a"}/${metrics.scannedFiles ?? "n/a"}`,
    );
  }

  const summary = {
    repoId: repo.repoId,
    outDir,
    selectedFiles: selected.length,
    repeats: args.repeats,
    failedRuns: runMetrics.filter((run) => run.exitCode !== 0).length,
    medianWallTimeMs: median(runMetrics.map((run) => run.wallTimeMs)),
    medianProviderFirstTotalMs: median(
      runMetrics.map((run) => run.providerFirstTotalMs),
    ),
    medianFallbackTotalMs: median(runMetrics.map((run) => run.fallbackTotalMs)),
    runs: runMetrics,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`summary: ${join(outDir, "summary.json")}`);
  if (summary.failedRuns > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
