import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { existsSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizePath } from "../util/paths.js";

import {
  buildExternalBenchmarkResults,
  compareArtifactPath,
  fingerprintDirectory,
  fingerprintFiles,
  hashSerializedManifest,
  normalizeArtifactPath,
  serializeExternalBenchmarkResults,
  serializeRunManifest,
  sha256File,
  type ExternalBenchmarkFailureBoundary,
  type ExternalBenchmarkRawRepeat,
  type ExternalBenchmarkRawResult,
  type ExternalBenchmarkRepeatManifest,
  type ExternalBenchmarkResults,
  type ExternalBenchmarkRunManifest,
  type ExternalBenchmarkStopBoundary,
  type HashedArtifactFile,
  type InitialDbFile,
} from "./external-manifest.js";
import { writeUtf8Output } from "./output-file.js";

export interface DbFamilyFingerprint {
  files: HashedArtifactFile[];
  sha256: string;
}

function familyEntries(primaryPath: string) {
  const directory = dirname(primaryPath);
  const primaryName = basename(primaryPath);
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).filter(
    (entry) =>
      entry.name === primaryName || entry.name.startsWith(primaryName + "."),
  );
}

export function collectDbFamilyFiles(primaryPath: string): string[] {
  const directory = dirname(primaryPath);
  return familyEntries(primaryPath)
    .filter((entry) => entry.isFile())
    .map((entry) => join(directory, entry.name))
    .sort((left, right) =>
      compareArtifactPath(
        normalizePath(left),
        normalizePath(right),
      ),
    );
}

export function assertDbFamilyAbsent(primaryPath: string): void {
  const existing = familyEntries(primaryPath);
  if (existing.length > 0) {
    throw new Error(
      "Database family must be absent: " +
        existing
          .map((entry) => join(dirname(primaryPath), entry.name))
          .sort()
          .join(", "),
    );
  }
}

export function fingerprintDbFamily(
  primaryPath: string,
): DbFamilyFingerprint {
  const entries = familyEntries(primaryPath);
  const nonRegular = entries.find((entry) => !entry.isFile());
  if (nonRegular !== undefined) {
    throw new Error(
      "Database family entry must be a regular file: " + nonRegular.name,
    );
  }

  return fingerprintFiles(
    dirname(primaryPath),
    entries.map((entry) => entry.name),
  );
}

export interface PreparedRepeatDatabase {
  graphDbPath: string;
  initialDbFiles: InitialDbFile[];
}

export function prepareColdRepeat(
  artifactRoot: string,
  repeat: number,
): PreparedRepeatDatabase {
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error("Repeat must be a positive integer");
  }

  const filename = `repeat-${String(repeat).padStart(3, "0")}.lbug`;
  const graphDbPath = "db/" + filename;
  assertDbFamilyAbsent(join(artifactRoot, "db", filename));
  return { graphDbPath, initialDbFiles: [] };
}

export interface WarmSnapshot {
  files: HashedArtifactFile[];
}

export function stageWarmSnapshot(
  sourcePrimaryPath: string,
  artifactRoot: string,
): WarmSnapshot {
  const before = fingerprintDbFamily(sourcePrimaryPath);
  const sourceName = basename(sourcePrimaryPath);
  if (!before.files.some(({ path }) => path === sourceName)) {
    throw new Error("Warm source primary database is missing: " + sourcePrimaryPath);
  }

  const warmDirectory = join(artifactRoot, "inputs", "warm-db");
  fs.mkdirSync(warmDirectory);
  const files = before.files.map(({ path, sha256 }) => {
    const destinationName = "repository.lbug" + path.slice(sourceName.length);
    const destination = join(warmDirectory, destinationName);
    fs.copyFileSync(
      join(dirname(sourcePrimaryPath), path),
      destination,
      fs.constants.COPYFILE_EXCL,
    );
    if (sha256File(destination) !== sha256) {
      throw new Error("Staged warm input hash mismatch: " + destinationName);
    }
    return {
      path: normalizeArtifactPath("inputs/warm-db/" + destinationName),
      sha256,
    };
  });

  const after = fingerprintDbFamily(sourcePrimaryPath);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("warm source changed during staging");
  }

  return {
    files: files.sort((left, right) =>
      compareArtifactPath(left.path, right.path),
    ),
  };
}

export function prepareWarmRepeat(
  artifactRoot: string,
  repeat: number,
  snapshot: WarmSnapshot,
): PreparedRepeatDatabase {
  const prepared = prepareColdRepeat(artifactRoot, repeat);
  const stagedPrefix = "inputs/warm-db/repository.lbug";
  const staged = snapshot.files
    .map((file) => ({
      path: normalizeArtifactPath(file.path),
      sha256: file.sha256,
    }))
    .sort((left, right) => compareArtifactPath(left.path, right.path));

  for (const file of staged) {
    if (
      file.path !== stagedPrefix &&
      !file.path.startsWith(stagedPrefix + ".")
    ) {
      throw new Error("Invalid staged warm input path: " + file.path);
    }
    if (
      sha256File(join(artifactRoot, ...file.path.split("/"))) !== file.sha256
    ) {
      throw new Error("staged warm input hash changed: " + file.path);
    }
  }

  const initialDbFiles = staged.map((file) => {
    const destinationPath =
      prepared.graphDbPath + file.path.slice(stagedPrefix.length);
    const source = join(artifactRoot, ...file.path.split("/"));
    const destination = join(artifactRoot, ...destinationPath.split("/"));
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    if (sha256File(destination) !== file.sha256) {
      throw new Error("copied warm input hash mismatch: " + destinationPath);
    }
    return {
      sourcePath: file.path,
      destinationPath,
      sha256: file.sha256,
    };
  });

  return { ...prepared, initialDbFiles };
}

function platformPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function canonicalizePath(input: string): string {
  const absolute = resolve(input);
  if (existsSync(absolute)) {
    return platformPath(fs.realpathSync.native(absolute));
  }
  return platformPath(
    join(fs.realpathSync.native(dirname(absolute)), basename(absolute)),
  );
}

export function assertCanonicalPathEqual(
  left: string,
  right: string,
): void {
  if (canonicalizePath(left) !== canonicalizePath(right)) {
    throw new Error("Canonical paths do not match");
  }
}

export function assertCanonicalPathContained(
  rootPath: string,
  candidatePath: string,
): void {
  const root = canonicalizePath(rootPath);
  const candidate = canonicalizePath(candidatePath);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Canonical path must be contained in the artifact root");
  }
}

export function buildChildEnvironment(
  inherited: NodeJS.ProcessEnv,
  configPath: string,
  graphDbPath: string,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  delete env.SDL_GRAPH_DB_DIR;
  delete env.SDL_GRAPH_DB_PATH;
  delete env.SDL_DB_PATH;
  delete env.SDL_CONFIG;
  env.SDL_CONFIG = configPath;
  env.SDL_GRAPH_DB_PATH = graphDbPath;
  env.SDL_DB_PATH = graphDbPath;
  return env;
}

export function assertChildEnvironment(
  env: NodeJS.ProcessEnv,
  artifactRoot: string,
  manifest: ExternalBenchmarkRunManifest,
  repeat: ExternalBenchmarkRepeatManifest,
  usedDbPaths: Set<string>,
): void {
  if (env.SDL_GRAPH_DB_DIR !== undefined) {
    throw new Error("SDL_GRAPH_DB_DIR must be absent");
  }
  const configPath = env.SDL_CONFIG;
  const graphDbPath = env.SDL_GRAPH_DB_PATH;
  if (configPath === undefined || !fs.statSync(configPath).isFile()) {
    throw new Error("SDL_CONFIG must name the generated config");
  }
  if (graphDbPath === undefined || env.SDL_DB_PATH !== graphDbPath) {
    throw new Error("SDL graph database paths must be present and equal");
  }

  const expectedConfig = join(
    artifactRoot,
    ...manifest.inputs.configPath.split("/"),
  );
  const expectedDb = join(artifactRoot, ...repeat.graphDbPath.split("/"));
  assertCanonicalPathContained(artifactRoot, configPath);
  assertCanonicalPathEqual(configPath, expectedConfig);
  assertCanonicalPathContained(artifactRoot, graphDbPath);
  assertCanonicalPathEqual(graphDbPath, expectedDb);

  const canonicalDb = canonicalizePath(graphDbPath);
  if (usedDbPaths.has(canonicalDb)) {
    throw new Error("Graph database path was already used");
  }
  usedDbPaths.add(canonicalDb);
}

const BASELINE_METRICS = [
  "indexTimePerFile",
  "indexTimePerSymbol",
  "symbolsPerFile",
  "edgesPerSymbol",
  "graphConnectivity",
  "exportedSymbolRatio",
  "sliceBuildTimeMs",
  "avgSkeletonTimeMs",
  "avgCardTokens",
  "avgSkeletonTokens",
] as const;

type BaselineMetric = (typeof BASELINE_METRICS)[number];
type BaselineMetrics = Record<BaselineMetric, number>;

export interface BaselineV1 {
  formatVersion: 1;
  repoId: string;
  metrics: BaselineMetrics;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(label + " must contain exactly: " + expected.join(", "));
  }
}

export function validateBaselineV1(
  input: unknown,
  expectedRepoId: string,
): BaselineV1 {
  const baseline = record(input, "Baseline");
  if (baseline.formatVersion !== 1) {
    throw new Error("Baseline formatVersion must be 1");
  }
  if (baseline.repoId !== expectedRepoId) {
    throw new Error("Baseline target repoId does not match");
  }
  const metrics = record(baseline.metrics, "Baseline metrics");
  requireExactKeys(metrics, BASELINE_METRICS, "Baseline metrics");
  for (const metric of BASELINE_METRICS) {
    if (typeof metrics[metric] !== "number" || !Number.isFinite(metrics[metric])) {
      throw new Error("Baseline metric must be finite: " + metric);
    }
  }
  return input as BaselineV1;
}

const THRESHOLD_RULES = [
  ["indexing", "indexTimePerFile", "lower-is-better", "maxMs", "allowableIncreasePercent"],
  ["indexing", "indexTimePerSymbol", "lower-is-better", "maxMs", "allowableIncreasePercent"],
  ["quality", "symbolsPerFile", "higher-is-better", "minValue", "allowableDecreasePercent"],
  ["quality", "edgesPerSymbol", "higher-is-better", "minValue", "allowableDecreasePercent"],
  ["quality", "graphConnectivity", "higher-is-better", "minValue", "allowableDecreasePercent"],
  ["quality", "exportedSymbolRatio", "higher-is-better", "minValue", "allowableDecreasePercent"],
  ["performance", "sliceBuildTimeMs", "lower-is-better", "maxMs", "allowableIncreasePercent"],
  ["performance", "avgSkeletonTimeMs", "lower-is-better", "maxMs", "allowableIncreasePercent"],
  ["tokenEfficiency", "avgCardTokens", "lower-is-better", "maxTokens", "allowableIncreasePercent"],
  ["tokenEfficiency", "avgSkeletonTokens", "lower-is-better", "maxTokens", "allowableIncreasePercent"],
  ["coverage", "callEdgeCoverage", "higher-is-better", "minPercent", "allowableDecreasePercent"],
  ["coverage", "importEdgeCoverage", "higher-is-better", "minPercent", "allowableDecreasePercent"],
] as const;

export function validateThresholdConfigV1(input: unknown): string[] {
  const config = record(input, "Threshold config");
  if (config.version !== "1.0") {
    throw new Error('Threshold version must be "1.0"');
  }
  const thresholds = record(config.thresholds, "Thresholds");
  if (Object.keys(thresholds).length === 0) {
    throw new Error("Thresholds must not be empty");
  }

  const categories = [...new Set(THRESHOLD_RULES.map(([category]) => category))];
  requireExactKeys(thresholds, categories, "Threshold categories");
  for (const categoryName of categories) {
    const metrics = THRESHOLD_RULES.filter(
      ([category]) => category === categoryName,
    ).map(([, metric]) => metric);
    requireExactKeys(
      record(thresholds[categoryName], categoryName),
      metrics,
      categoryName + " thresholds",
    );
  }

  for (const [categoryName, metric, trend, absolute, allowance] of THRESHOLD_RULES) {
    const category = record(thresholds[categoryName], categoryName);
    const rule = record(category[metric], metric);
    requireExactKeys(rule, ["trend", absolute, allowance], metric + " rule");
    if (rule.trend !== trend) {
      throw new Error("Threshold trend mismatch: " + metric);
    }
    for (const key of [absolute, allowance]) {
      if (typeof rule[key] !== "number" || !Number.isFinite(rule[key])) {
        throw new Error("Threshold limit must be finite: " + metric);
      }
    }
  }

  return THRESHOLD_RULES.map(
    ([category, metric]) => category + "/" + metric,
  ).sort(compareArtifactPath);
}

export function validateThresholdFiles(
  sourcePath: string,
  stagedPath: string,
): { sha256: string; pairs: string[] } {
  const source = fs.readFileSync(sourcePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(
      "Failed to parse threshold config: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const pairs = validateThresholdConfigV1(parsed);
  if (!source.equals(fs.readFileSync(stagedPath))) {
    throw new Error("Threshold source and staged files must be byte-identical");
  }
  return { sha256: sha256File(sourcePath), pairs };
}

function parseJsonFile(filePath: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      "Failed to parse " +
        label +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export function buildGeneratedRunConfig(
  baseConfigPath: string,
  externalConfigPath: string,
  repoId: string,
): Record<string, unknown> {
  const base = record(parseJsonFile(baseConfigPath, "base config"), "Base config");
  const external = record(
    parseJsonFile(externalConfigPath, "external config"),
    "External config",
  );
  if (!Array.isArray(external.repos)) {
    throw new Error("External config repos must be an array");
  }
  const selected = external.repos.filter(
    (repo) => record(repo, "External repo").repoId === repoId,
  );
  if (selected.length !== 1) {
    throw new Error("External config must contain exactly one selected target");
  }
  const indexing = record(base.indexing, "Base indexing");
  return {
    ...base,
    repos: selected,
    indexing: { ...indexing, enableFileWatching: false },
  };
}

export function validateGeneratedRunConfig(
  input: unknown,
  repoId: string,
  targetRoot: string,
  runnerRoot: string,
): void {
  const config = record(input, "Generated config");
  if (!Array.isArray(config.repos) || config.repos.length !== 1) {
    throw new Error("Generated config must contain exactly one repo");
  }
  const repo = record(config.repos[0], "Generated repo");
  if (repo.repoId !== repoId || typeof repo.rootPath !== "string") {
    throw new Error("Generated config target does not match");
  }
  if (record(config.indexing, "Generated indexing").enableFileWatching !== false) {
    throw new Error("Generated config file watching must be disabled");
  }
  assertCanonicalPathEqual(
    resolve(runnerRoot, repo.rootPath),
    targetRoot,
  );
}

function assertFileHash(
  filePath: string,
  expectedSha256: string,
  label: string,
): void {
  if (sha256File(filePath) !== expectedSha256) {
    throw new Error(label + " hash mismatch");
  }
}

export function assertManifestFileHashes(
  runnerRoot: string,
  artifactRoot: string,
  manifest: ExternalBenchmarkRunManifest,
  thresholdSourcePath = join(
    runnerRoot,
    ...manifest.inputs.thresholdSourcePath.split("/"),
  ),
): void {
  assertFileHash(
    join(runnerRoot, ...manifest.runner.launcherPath.split("/")),
    manifest.runner.launcherSha256,
    "launcher",
  );
  assertFileHash(
    join(artifactRoot, ...manifest.inputs.configPath.split("/")),
    manifest.inputs.configSha256,
    "staged config",
  );
  assertFileHash(
    join(artifactRoot, ...manifest.inputs.baselinePath.split("/")),
    manifest.inputs.baselineSha256,
    "staged baseline",
  );
  for (const filePath of [
    thresholdSourcePath,
    join(artifactRoot, ...manifest.inputs.thresholdPath.split("/")),
  ]) {
    assertFileHash(filePath, manifest.inputs.thresholdSha256, "threshold");
  }
}

export interface GitSnapshot {
  commit: string;
  dirty: boolean;
  treeSha256: string;
}

export type ExecFileText = (
  file: string,
  args: readonly string[],
) => string;

const execText: ExecFileText = (file, args) =>
  execFileSync(file, [...args], { encoding: "utf8" });

function runGit(
  rootPath: string,
  args: readonly string[],
  exec: ExecFileText,
): string {
  return exec("git", ["-C", rootPath, ...args]);
}

export function readGitSnapshot(
  rootPath: string,
  exec: ExecFileText = execText,
): GitSnapshot {
  const commit = runGit(rootPath, ["rev-parse", "HEAD"], exec).trim();
  const dirty =
    runGit(
      rootPath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      exec,
    ).trim().length > 0;
  const files = runGit(
    rootPath,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    exec,
  )
    .split("\0")
    .filter((path) => path.length > 0)
    .map(normalizeArtifactPath);

  return {
    commit,
    dirty,
    treeSha256: fingerprintFiles(rootPath, files).sha256,
  };
}

export function assertGitSnapshot(
  actual: GitSnapshot,
  expected: GitSnapshot,
  label: string,
): void {
  if (actual.commit !== expected.commit) {
    throw new Error(label + " commit mismatch");
  }
  if (actual.dirty !== expected.dirty) {
    throw new Error(label + " dirty state mismatch");
  }
  if (actual.treeSha256 !== expected.treeSha256) {
    throw new Error(label + " source tree mismatch");
  }
}

export function assertTargetRef(
  targetRoot: string,
  lock: { ref: string; cloneUrl: string },
  exec: ExecFileText = execText,
): GitSnapshot {
  const snapshot = readGitSnapshot(targetRoot, exec);
  const lockedCommit = runGit(
    targetRoot,
    ["rev-parse", "--verify", lock.ref + "^{commit}"],
    exec,
  ).trim();
  if (snapshot.commit !== lockedCommit) {
    throw new Error("Target HEAD does not match the locked ref");
  }
  const trimSlash = (value: string) => value.trim().replace(/\/+$/u, "");
  const origin = runGit(
    targetRoot,
    ["remote", "get-url", "origin"],
    exec,
  );
  if (trimSlash(origin) !== trimSlash(lock.cloneUrl)) {
    throw new Error("Target origin does not match the lock");
  }
  return snapshot;
}

export function assertRunnerSnapshot(
  runnerRoot: string,
  manifest: ExternalBenchmarkRunManifest,
  expectedSource: GitSnapshot,
  exec: ExecFileText = execText,
): void {
  const actual = readGitSnapshot(runnerRoot, exec);
  assertGitSnapshot(actual, expectedSource, "runner");
  if (
    actual.commit !== manifest.runner.sdlMcpCommit ||
    actual.dirty !== manifest.runner.sdlMcpSourceDirty
  ) {
    throw new Error("Runner commit or dirty state mismatch");
  }
  if (
    fingerprintDirectory(join(runnerRoot, "dist")).sha256 !==
    manifest.runner.sdlMcpBuildTreeSha256
  ) {
    throw new Error("Runner dist hash mismatch");
  }
  assertFileHash(
    join(runnerRoot, ...manifest.runner.launcherPath.split("/")),
    manifest.runner.launcherSha256,
    "runner launcher",
  );
}


export interface ExternalBenchmarkCliOptions {
  repoId: string;
  outDir: string;
  lock: string;
  baseConfig: string;
  externalConfig: string;
  baseline: string;
  threshold: string;
  cacheMode: "cold" | "warm";
  repeats: number;
  warmDb: string | undefined;
  scipArtifact: string | undefined;
}

const EXTERNAL_BENCHMARK_OPTIONS: ReadonlyMap<string, string> = new Map([
  ["--repo-id", "repoId"],
  ["--out-dir", "outDir"],
  ["--lock", "lock"],
  ["--base-config", "baseConfig"],
  ["--external-config", "externalConfig"],
  ["--baseline", "baseline"],
  ["--threshold", "threshold"],
  ["--cache-mode", "cacheMode"],
  ["--repeats", "repeats"],
  ["--warm-db", "warmDb"],
  ["--scip-artifact", "scipArtifact"],
] as const);

export function parseExternalBenchmarkArgs(
  argv: readonly string[],
): ExternalBenchmarkCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = flag === undefined ? undefined : EXTERNAL_BENCHMARK_OPTIONS.get(flag);
    const value = argv[index + 1];
    if (key === undefined) {
      throw new Error("Unknown external benchmark option: " + String(flag));
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error("Missing value for external benchmark option: " + flag);
    }
    if (values.has(key)) {
      throw new Error("Duplicate external benchmark option: " + flag);
    }
    values.set(key, value);
  }

  const repoId = values.get("repoId");
  const outDir = values.get("outDir");
  if (repoId === undefined || outDir === undefined) {
    throw new Error("--repo-id and --out-dir are required");
  }

  const cacheMode = values.get("cacheMode") ?? "cold";
  if (cacheMode !== "cold" && cacheMode !== "warm") {
    throw new Error("--cache-mode must be cold or warm");
  }
  const repeatsText = values.get("repeats") ?? "1";
  const repeats = Number(repeatsText);
  if (!/^\d+$/u.test(repeatsText) || repeats < 1 || repeats > 20) {
    throw new Error("--repeats must be an integer from 1 through 20");
  }

  const warmDb = values.get("warmDb");
  if ((cacheMode === "warm") !== (warmDb !== undefined)) {
    throw new Error("--warm-db is required for warm mode and forbidden for cold mode");
  }

  return {
    repoId,
    outDir,
    lock: values.get("lock") ?? "scripts/benchmark/matrix-external-repos.lock.json",
    baseConfig: values.get("baseConfig") ?? "config/sdlmcp.config.json",
    externalConfig:
      values.get("externalConfig") ??
      "benchmarks/real-world/external-repos.config.json",
    baseline:
      values.get("baseline") ?? ".benchmark/baseline." + repoId + ".json",
    threshold: values.get("threshold") ?? "config/benchmark.config.json",
    cacheMode,
    repeats,
    warmDb,
    scipArtifact: values.get("scipArtifact"),
  };
}

export async function runExternalBenchmarkCli(
  argv: readonly string[],
  runChild: RunBenchmarkChild = runBenchmarkChild,
): Promise<number> {
  return runExternalBenchmarkPrepared(argv, runChild);
}


export interface BenchmarkChildRequest {
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  rawResultPath: string;
}

export type RunBenchmarkChild = (
  request: BenchmarkChildRequest,
) => Promise<{ exitCode: number | null; durationMs: number }>;

interface PreparedExternalBenchmarkRun {
  artifactRoot: string;
  runnerRoot: string;
  targetRoot: string;
  targetSnapshot: GitSnapshot;
  runnerSnapshot: GitSnapshot;
  baselineSourcePath: string;
  thresholdSourcePath: string;
  thresholdPairs: string[];
  warmSourcePath: string | null;
  warmSourceFingerprint: DbFamilyFingerprint | null;
  manifest: ExternalBenchmarkRunManifest;
  manifestSha256: string;
}

async function runExternalBenchmarkPrepared(
  argv: readonly string[],
  runChild: RunBenchmarkChild,
): Promise<number> {
  const options = parseExternalBenchmarkArgs(argv);
  const requestedRoot = resolve(options.outDir);
  if (existsSync(requestedRoot)) {
    throw new Error("External benchmark artifact root must be absent");
  }

  const artifactRoot = canonicalizePath(requestedRoot);
  fs.mkdirSync(artifactRoot);
  writeUtf8Output(join(artifactRoot, "preflight.log"), "", "exclusive");

  let state: PreparedExternalBenchmarkRun;
  try {
    state = prepareExternalBenchmarkRun(options, artifactRoot);
  } catch (error) {
    writeUtf8Output(
      join(artifactRoot, "preflight-error.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          boundary: "post-artifact-pre-manifest",
          message: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ) + "\n",
      "exclusive",
    );
    return 1;
  }

  return executeExternalBenchmarkRepeats(state, runChild);
}

function prepareExternalBenchmarkRun(
  options: ExternalBenchmarkCliOptions,
  artifactRoot: string,
): PreparedExternalBenchmarkRun {
  const runnerRoot = canonicalizePath(
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  );
  const lockPath = canonicalizePath(resolve(runnerRoot, options.lock));
  if (!existsSync(lockPath)) {
    throw new Error("External benchmark lock file does not exist");
  }
  const lock = record(
    parseJsonFile(lockPath, "external benchmark lock"),
    "External benchmark lock",
  );
  if (!Array.isArray(lock.repos) || lock.repos.length === 0) {
    throw new Error("External benchmark lock must contain repos");
  }
  const matches = lock.repos
    .map((value) => record(value, "External benchmark lock repo"))
    .filter((value) => value.repoId === options.repoId);
  if (matches.length !== 1) {
    throw new Error("External benchmark lock must contain the target exactly once");
  }
  const selectedLock = matches[0];
  if (
    typeof selectedLock.ref !== "string" ||
    typeof selectedLock.cloneUrl !== "string"
  ) {
    throw new Error("External benchmark lock target is invalid");
  }

  const baseConfigPath = canonicalizePath(resolve(runnerRoot, options.baseConfig));
  const externalConfigPath = canonicalizePath(
    resolve(runnerRoot, options.externalConfig),
  );
  const generatedConfig = buildGeneratedRunConfig(
    baseConfigPath,
    externalConfigPath,
    options.repoId,
  );
  if (!Array.isArray(generatedConfig.repos)) {
    throw new Error("Generated config repos must be an array");
  }
  const generatedRepo = record(generatedConfig.repos[0], "Generated config repo");
  if (typeof generatedRepo.rootPath !== "string") {
    throw new Error("Generated config rootPath must be a string");
  }
  const targetRoot = canonicalizePath(
    resolve(runnerRoot, generatedRepo.rootPath),
  );
  validateGeneratedRunConfig(
    generatedConfig,
    options.repoId,
    targetRoot,
    runnerRoot,
  );
  const targetSnapshot = assertTargetRef(
    targetRoot,
    { ref: selectedLock.ref, cloneUrl: selectedLock.cloneUrl },
  );
  const runnerSnapshot = readGitSnapshot(runnerRoot);
  const distFingerprint = fingerprintDirectory(join(runnerRoot, "dist"));
  const launcherPath = join(
    runnerRoot,
    "scripts",
    "external-benchmark-runner.mjs",
  );
  if (!existsSync(launcherPath) || !fs.statSync(launcherPath).isFile()) {
    throw new Error("External benchmark launcher does not exist");
  }

  const packageJson = record(
    parseJsonFile(join(runnerRoot, "package.json"), "package.json"),
    "package.json",
  );
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version must be a string");
  }
  const baselineSourcePath = canonicalizePath(
    resolve(runnerRoot, options.baseline),
  );
  const baselineText = fs.readFileSync(baselineSourcePath, "utf8");
  const baseline = validateBaselineV1(
    JSON.parse(baselineText),
    options.repoId,
  );
  const thresholdSourcePath = canonicalizePath(
    resolve(runnerRoot, options.threshold),
  );
  const thresholdText = fs.readFileSync(thresholdSourcePath, "utf8");
  const thresholdPairs = validateThresholdConfigV1(
    JSON.parse(thresholdText),
  );

  for (const directory of ["inputs", "logs", "db", "raw"]) {
    fs.mkdirSync(join(artifactRoot, directory));
  }
  const configPath = join(artifactRoot, "inputs", "sdlmcp.config.json");
  const baselinePath = join(artifactRoot, "inputs", "baseline.json");
  const thresholdPath = join(artifactRoot, "inputs", "threshold.json");
  writeUtf8Output(
    configPath,
    JSON.stringify(generatedConfig, null, 2) + "\n",
    "exclusive",
  );
  writeUtf8Output(baselinePath, baselineText, "exclusive");
  writeUtf8Output(thresholdPath, thresholdText, "exclusive");
  validateGeneratedRunConfig(
    parseJsonFile(configPath, "staged config"),
    options.repoId,
    targetRoot,
    runnerRoot,
  );
  validateBaselineV1(
    parseJsonFile(baselinePath, "staged baseline"),
    options.repoId,
  );
  const stagedThreshold = validateThresholdFiles(
    thresholdSourcePath,
    thresholdPath,
  );
  if (JSON.stringify(stagedThreshold.pairs) !== JSON.stringify(thresholdPairs)) {
    throw new Error("Staged threshold contract changed");
  }

  let warmSourcePath: string | null = null;
  let warmSourceFingerprint: DbFamilyFingerprint | null = null;
  let warmSnapshot: WarmSnapshot | null = null;
  if (options.cacheMode === "warm") {
    warmSourcePath = canonicalizePath(resolve(runnerRoot, options.warmDb!));
    warmSourceFingerprint = fingerprintDbFamily(warmSourcePath);
    warmSnapshot = stageWarmSnapshot(warmSourcePath, artifactRoot);
  }

  const repeats: ExternalBenchmarkRepeatManifest[] = [];
  for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
    const prepared =
      options.cacheMode === "cold"
        ? prepareColdRepeat(artifactRoot, repeat)
        : prepareWarmRepeat(artifactRoot, repeat, warmSnapshot!);
    const number = String(repeat).padStart(3, "0");
    repeats.push({
      repeat,
      graphDbPath: prepared.graphDbPath,
      stdoutPath: `logs/repeat-${number}.stdout.log`,
      stderrPath: `logs/repeat-${number}.stderr.log`,
      initialDbFiles: prepared.initialDbFiles,
      command: [
        "node",
        "dist/cli/index.js",
        "benchmark:ci",
        "--repo-id",
        options.repoId,
        "--baseline-path",
        "inputs/baseline.json",
        "--threshold-path",
        "inputs/threshold.json",
        "--out-exclusive",
        "--out",
        `raw/repeat-${number}.benchmark.json`,
      ],
    });
  }

  let scipArtifactPath: string | null = null;
  let scipArtifactSha256: string | null = null;
  if (options.scipArtifact !== undefined) {
    const absoluteScipPath = canonicalizePath(
      resolve(targetRoot, options.scipArtifact),
    );
    assertCanonicalPathContained(targetRoot, absoluteScipPath);
    if (!fs.statSync(absoluteScipPath).isFile()) {
      throw new Error("SCIP artifact must be a regular file");
    }
    scipArtifactPath = normalizeArtifactPath(
      relative(targetRoot, absoluteScipPath),
    );
    scipArtifactSha256 = sha256File(absoluteScipPath);
  }

  const manifest: ExternalBenchmarkRunManifest = {
    schemaVersion: 1,
    target: {
      repoId: options.repoId,
      sourceRef: selectedLock.ref,
      sourceCommit: targetSnapshot.commit,
      sourceDirty: targetSnapshot.dirty,
      sourceTreeSha256: targetSnapshot.treeSha256,
      scipArtifactPath,
      scipArtifactSha256,
    },
    runner: {
      sdlMcpVersion: packageJson.version,
      sdlMcpCommit: runnerSnapshot.commit,
      sdlMcpSourceDirty: runnerSnapshot.dirty,
      sdlMcpBuildTreeSha256: distFingerprint.sha256,
      launcherPath: "scripts/external-benchmark-runner.mjs",
      launcherSha256: sha256File(launcherPath),
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      cacheMode: options.cacheMode,
      repeats: options.repeats,
    },
    inputs: {
      configPath: "inputs/sdlmcp.config.json",
      configSha256: sha256File(configPath),
      baselinePath: "inputs/baseline.json",
      baselineSha256: sha256File(baselinePath),
      baselineFormatVersion: "1",
      baselineTargetRepoId: baseline.repoId,
      thresholdSourcePath: "config/benchmark.config.json",
      thresholdPath: "inputs/threshold.json",
      thresholdSha256: stagedThreshold.sha256,
      warmSnapshot: warmSnapshot === null ? null : { files: warmSnapshot.files },
    },
    repeats,
  };
  const serializedManifest = serializeRunManifest(manifest);
  writeUtf8Output(
    join(artifactRoot, "run-manifest.json"),
    serializedManifest,
    "exclusive",
  );
  return {
    artifactRoot,
    runnerRoot,
    targetRoot,
    targetSnapshot,
    runnerSnapshot,
    baselineSourcePath,
    thresholdSourcePath,
    thresholdPairs,
    warmSourcePath,
    warmSourceFingerprint,
    manifest,
    manifestSha256: hashSerializedManifest(serializedManifest),
  };
}

function assertExternalBenchmarkInputs(
  state: PreparedExternalBenchmarkRun,
  repeat: ExternalBenchmarkRepeatManifest,
): void {
  assertGitSnapshot(
    readGitSnapshot(state.targetRoot),
    state.targetSnapshot,
    "target",
  );
  assertRunnerSnapshot(state.runnerRoot, state.manifest, state.runnerSnapshot);
  assertManifestFileHashes(
    state.runnerRoot,
    state.artifactRoot,
    state.manifest,
    state.thresholdSourcePath,
  );
  assertFileHash(
    state.baselineSourcePath,
    state.manifest.inputs.baselineSha256,
    "baseline source",
  );
  const stagedBaselinePath = join(
    state.artifactRoot,
    ...state.manifest.inputs.baselinePath.split("/"),
  );
  if (
    !fs.readFileSync(state.baselineSourcePath).equals(
      fs.readFileSync(stagedBaselinePath),
    )
  ) {
    throw new Error("Baseline source and staged files must be byte-identical");
  }
  validateBaselineV1(
    parseJsonFile(state.baselineSourcePath, "baseline"),
    state.manifest.target.repoId,
  );

  const stagedThresholdPath = join(
    state.artifactRoot,
    ...state.manifest.inputs.thresholdPath.split("/"),
  );
  const threshold = validateThresholdFiles(
    state.thresholdSourcePath,
    stagedThresholdPath,
  );
  if (JSON.stringify(threshold.pairs) !== JSON.stringify(state.thresholdPairs)) {
    throw new Error("Threshold contract changed");
  }
  validateGeneratedRunConfig(
    parseJsonFile(
      join(
        state.artifactRoot,
        ...state.manifest.inputs.configPath.split("/"),
      ),
      "staged config",
    ),
    state.manifest.target.repoId,
    state.targetRoot,
    state.runnerRoot,
  );

  if (
    state.warmSourcePath !== null &&
    state.warmSourceFingerprint !== null &&
    JSON.stringify(fingerprintDbFamily(state.warmSourcePath)) !==
      JSON.stringify(state.warmSourceFingerprint)
  ) {
    throw new Error("Warm source database family changed");
  }
  for (const file of state.manifest.inputs.warmSnapshot?.files ?? []) {
    assertFileHash(
      join(state.artifactRoot, ...file.path.split("/")),
      file.sha256,
      "warm snapshot",
    );
  }

  const graphDbPath = join(
    state.artifactRoot,
    ...repeat.graphDbPath.split("/"),
  );
  if (repeat.initialDbFiles.length === 0) {
    assertDbFamilyAbsent(graphDbPath);
    return;
  }
  const actualPaths = collectDbFamilyFiles(graphDbPath).map((filePath) =>
    normalizeArtifactPath(relative(state.artifactRoot, filePath)),
  );
  const expectedPaths = repeat.initialDbFiles
    .map((file) => file.destinationPath)
    .sort(compareArtifactPath);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Repeat database family membership changed");
  }
  for (const file of repeat.initialDbFiles) {
    assertFileHash(
      join(state.artifactRoot, ...file.sourcePath.split("/")),
      file.sha256,
      "warm source copy",
    );
    assertFileHash(
      join(state.artifactRoot, ...file.destinationPath.split("/")),
      file.sha256,
      "repeat database",
    );
  }
}


class BenchmarkChildFailure extends Error {
  constructor(
    readonly boundary: "child-spawn" | "child-stream",
    cause: unknown,
  ) {
    super(
      boundary.replace("-", " ") +
        ": " +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

export function runBenchmarkChild(
  request: BenchmarkChildRequest,
): Promise<{ exitCode: number | null; durationMs: number }> {
  const started = performance.now();
  const stdout = fs.createWriteStream(request.stdoutPath, { flags: "wx" });
  const stderr = fs.createWriteStream(request.stderrPath, { flags: "wx" });

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let childClosed = false;
    let stdoutClosed = false;
    let stderrClosed = false;
    let exitCode: number | null = null;
    let child: ReturnType<typeof spawn> | undefined;
    let failure: BenchmarkChildFailure | undefined;

    const finish = () => {
      if (settled || !childClosed || !stdoutClosed || !stderrClosed) return;
      settled = true;
      if (failure !== undefined) {
        rejectPromise(failure);
        return;
      }
      resolvePromise({
        exitCode,
        durationMs: roundDuration(performance.now() - started),
      });
    };
    const fail = (
      boundary: "child-spawn" | "child-stream",
      error: unknown,
    ) => {
      if (settled || failure !== undefined) return;
      failure = new BenchmarkChildFailure(boundary, error);
      child?.kill();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      stdout.destroy();
      stderr.destroy();
      finish();
    };

    stdout.once("error", (error) => fail("child-stream", error));
    stderr.once("error", (error) => fail("child-stream", error));
    stdout.once("close", () => {
      stdoutClosed = true;
      finish();
    });
    stderr.once("close", () => {
      stderrClosed = true;
      finish();
    });

    try {
      child = spawn(process.execPath, request.command.slice(1), {
        cwd: request.cwd,
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      childClosed = true;
      fail("child-spawn", error);
      return;
    }
    child.once("error", (error) => fail("child-spawn", error));
    child.once("close", (code) => {
      exitCode = code;
      childClosed = true;
      finish();
    });
    if (child.stdout === null || child.stderr === null) {
      fail("child-spawn", new Error("Child stdio pipes are unavailable"));
      return;
    }
    child.stdout.once("error", (error) => fail("child-stream", error));
    child.stderr.once("error", (error) => fail("child-stream", error));
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
  });
}

async function executeExternalBenchmarkRepeats(
  state: PreparedExternalBenchmarkRun,
  runChild: RunBenchmarkChild,
): Promise<number> {
  const rawRepeats: ExternalBenchmarkRawRepeat[] = [];
  let stop: ExternalBenchmarkStopBoundary | undefined;
  let activeRepeat = 1;
  let unexpectedBoundary:
    | "preflight-between-repeats"
    | "raw-result-invalid" = "preflight-between-repeats";
  let results: ExternalBenchmarkResults | undefined;
  const usedDbPaths = new Set<string>();

  try {
    for (const repeat of state.manifest.repeats) {
      activeRepeat = repeat.repeat;
      unexpectedBoundary = "preflight-between-repeats";
      try {
        assertExternalBenchmarkInputs(state, repeat);
      } catch (error) {
        const boundary = "preflight-between-repeats";
        writeRepeatDiagnostic(state, repeat, error);
        rawRepeats.push(failedRawRepeat(repeat, boundary));
        stop = { boundary, failedRepeat: repeat.repeat };
        break;
      }

      const request = buildBenchmarkChildRequest(
        state,
        repeat,
        usedDbPaths,
      );
      let childResult: { exitCode: number | null; durationMs: number };
      try {
        childResult = await runChild(request);
      } catch (error) {
        const boundary =
          error instanceof BenchmarkChildFailure
            ? error.boundary
            : "child-spawn";
        rawRepeats.push(failedRawRepeat(repeat, boundary));
        stop = { boundary, failedRepeat: repeat.repeat };
        break;
      }

      unexpectedBoundary = "raw-result-invalid";
      const raw = readRawBenchmarkRepeat(
        state,
        repeat,
        childResult.exitCode,
        roundDuration(childResult.durationMs),
        request.rawResultPath,
      );
      rawRepeats.push(raw);
      if (raw.failureBoundary !== null) {
        stop = {
          boundary:
            raw.failureBoundary === "unexecuted-after-failure"
              ? "raw-result-invalid"
              : raw.failureBoundary,
          failedRepeat: repeat.repeat,
        };
        break;
      }
    }
  } catch (error) {
    const repeat = state.manifest.repeats[activeRepeat - 1];
    const boundary = unexpectedBoundary;
    writeRepeatDiagnostic(state, repeat, error);
    if (!rawRepeats.some((raw) => raw.repeat === activeRepeat)) {
      rawRepeats.push(failedRawRepeat(repeat, boundary));
    }
    stop = { boundary, failedRepeat: activeRepeat };
  } finally {
    ensureDeclaredLogs(state);
    results = buildExternalBenchmarkResults(
      state.manifestSha256,
      state.manifest.runner.repeats,
      rawRepeats,
      stop,
    );
    writeUtf8Output(
      join(state.artifactRoot, "results.json"),
      serializeExternalBenchmarkResults(results),
      "exclusive",
    );
  }

  return results?.passed === true ? 0 : 1;
}

function buildBenchmarkChildRequest(
  state: PreparedExternalBenchmarkRun,
  repeat: ExternalBenchmarkRepeatManifest,
  usedDbPaths: Set<string>,
): BenchmarkChildRequest {
  const configPath = join(
    state.artifactRoot,
    ...state.manifest.inputs.configPath.split("/"),
  );
  const graphDbPath = join(
    state.artifactRoot,
    ...repeat.graphDbPath.split("/"),
  );
  const env = buildChildEnvironment(process.env, configPath, graphDbPath);
  assertChildEnvironment(
    env,
    state.artifactRoot,
    state.manifest,
    repeat,
    usedDbPaths,
  );
  return {
    command: [...repeat.command],
    cwd: state.runnerRoot,
    env,
    stdoutPath: join(state.artifactRoot, ...repeat.stdoutPath.split("/")),
    stderrPath: join(state.artifactRoot, ...repeat.stderrPath.split("/")),
    rawResultPath: join(
      state.artifactRoot,
      "raw",
      `repeat-${String(repeat.repeat).padStart(3, "0")}.benchmark.json`,
    ),
  };
}

function readRawBenchmarkRepeat(
  state: PreparedExternalBenchmarkRun,
  repeat: ExternalBenchmarkRepeatManifest,
  exitCode: number | null,
  durationMs: number,
  rawResultPath: string,
): ExternalBenchmarkRawRepeat {
  if (!existsSync(rawResultPath)) {
    return failedRawRepeat(
      repeat,
      "raw-result-missing",
      exitCode,
      durationMs,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(rawResultPath, "utf8"));
  } catch {
    return failedRawRepeat(
      repeat,
      "raw-result-invalid",
      exitCode,
      durationMs,
    );
  }

  let benchmarkResult: ExternalBenchmarkRawResult;
  try {
    benchmarkResult = validateRawBenchmarkResult(
      parsed,
      state.manifest.target.repoId,
      state.thresholdPairs,
    );
  } catch (error) {
    return failedRawRepeat(
      repeat,
      error instanceof ThresholdEvidenceFailure
        ? "threshold-evidence-invalid"
        : "raw-result-invalid",
      exitCode,
      durationMs,
    );
  }
  const evaluations = benchmarkResult.thresholdResult!.evaluations;
  const benchmarkResultPath =
    repeat.command[repeat.command.length - 1] ??
    `raw/repeat-${String(repeat.repeat).padStart(3, "0")}.benchmark.json`;
  const raw: ExternalBenchmarkRawRepeat = {
    repeat: repeat.repeat,
    exitCode,
    failureBoundary: null,
    durationMs,
    benchmarkResultPath,
    benchmarkResultSha256: sha256File(rawResultPath),
    benchmarkResult,
  };
  if (
    exitCode === null ||
    (exitCode !== 0 &&
      !evaluations.some(
        (value) => record(value, "Raw threshold evaluation").passed === false,
      ))
  ) {
    raw.failureBoundary = "child-exit";
  }
  return raw;
}

function failedRawRepeat(
  repeat: ExternalBenchmarkRepeatManifest,
  boundary: Exclude<
    ExternalBenchmarkFailureBoundary,
    "unexecuted-after-failure"
  >,
  exitCode: number | null = null,
  durationMs = 0,
): ExternalBenchmarkRawRepeat {
  return {
    repeat: repeat.repeat,
    exitCode,
    failureBoundary: boundary,
    durationMs: roundDuration(durationMs),
    benchmarkResultPath:
      repeat.command[repeat.command.length - 1] ??
      `raw/repeat-${String(repeat.repeat).padStart(3, "0")}.benchmark.json`,
    benchmarkResultSha256: null,
    benchmarkResult: null,
  };
}

function writeRepeatDiagnostic(
  state: PreparedExternalBenchmarkRun,
  repeat: ExternalBenchmarkRepeatManifest,
  error: unknown,
): void {
  const path = join(state.artifactRoot, ...repeat.stderrPath.split("/"));
  const message = error instanceof Error ? error.message : String(error);
  if (existsSync(path)) {
    fs.appendFileSync(path, message + "\n", "utf8");
  } else {
    writeUtf8Output(path, message + "\n", "exclusive");
  }
}

function ensureDeclaredLogs(state: PreparedExternalBenchmarkRun): void {
  for (const repeat of state.manifest.repeats) {
    for (const path of [repeat.stdoutPath, repeat.stderrPath]) {
      const filePath = join(state.artifactRoot, ...path.split("/"));
      if (!existsSync(filePath)) {
        writeUtf8Output(filePath, "", "exclusive");
      }
    }
  }
}

function roundDuration(value: number): number {
  return Math.round(value * 1000) / 1000;
}


class ThresholdEvidenceFailure extends Error {}

const RAW_METRIC_KEYS = [
  "indexTimePerFile",
  "indexTimePerSymbol",
  "symbolsPerFile",
  "edgesPerSymbol",
  "graphConnectivity",
  "exportedSymbolRatio",
  "sliceBuildTimeMs",
  "avgSkeletonTimeMs",
  "avgCardTokens",
  "avgSkeletonTokens",
  "functionMethodRatio",
  "avgDepsPerSymbol",
  "callEdgeCount",
  "importEdgeCount",
  "totalSymbols",
  "totalFiles",
  "summaryGenerationMs",
  "summaryTokens",
  "healthScore",
  "watcherEventsProcessed",
  "watcherErrors",
] as const;

export function validateRawBenchmarkResult(
  input: unknown,
  expectedRepoId: string,
  expectedPairs: readonly string[],
): ExternalBenchmarkRawResult {
  const result = record(input, "Raw benchmark result");
  if (result.repoId !== expectedRepoId) {
    throw new Error("Raw benchmark repoId does not match");
  }

  const metrics = record(result.metrics, "Raw benchmark metrics");
  for (const key of RAW_METRIC_KEYS) {
    const value = metrics[key];
    if (
      key === "healthScore"
        ? value !== null &&
          (typeof value !== "number" || !Number.isFinite(value))
        : typeof value !== "number" || !Number.isFinite(value)
    ) {
      throw new Error("Raw benchmark metric must be finite: " + key);
    }
  }

  const thresholdResult = record(
    result.thresholdResult,
    "Raw threshold result",
  );
  if (
    typeof thresholdResult.passed !== "boolean" ||
    !Array.isArray(thresholdResult.evaluations) ||
    thresholdResult.evaluations.length === 0
  ) {
    throw new ThresholdEvidenceFailure("Threshold result is incomplete");
  }

  const expected = [...expectedPairs].sort(compareArtifactPath);
  const actual: string[] = [];
  let passedCount = 0;
  for (const value of thresholdResult.evaluations) {
    const evaluation = record(value, "Raw threshold evaluation");
    if (
      typeof evaluation.category !== "string" ||
      typeof evaluation.metricName !== "string"
    ) {
      throw new ThresholdEvidenceFailure("Threshold pair is invalid");
    }
    const pair = evaluation.category + "/" + evaluation.metricName;
    if (actual.includes(pair) || !expected.includes(pair)) {
      throw new ThresholdEvidenceFailure("Threshold pair set is invalid");
    }
    actual.push(pair);
    for (const key of ["currentValue", "baselineValue", "delta", "deltaPercent"]) {
      const field = evaluation[key];
      if (
        field !== undefined &&
        field !== null &&
        (typeof field !== "number" || !Number.isFinite(field))
      ) {
        throw new ThresholdEvidenceFailure(
          "Threshold value is invalid: " + pair + "/" + key,
        );
      }
    }
    if (
      typeof evaluation.currentValue !== "number" ||
      !Number.isFinite(evaluation.currentValue) ||
      typeof evaluation.passed !== "boolean" ||
      typeof evaluation.message !== "string"
    ) {
      throw new ThresholdEvidenceFailure(
        "Threshold evaluation is invalid: " + pair,
      );
    }
    if (evaluation.passed) passedCount += 1;
  }
  actual.sort(compareArtifactPath);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ThresholdEvidenceFailure("Threshold pair set is not exact");
  }

  const summary = record(thresholdResult.summary, "Threshold summary");
  const total = thresholdResult.evaluations.length;
  if (
    summary.total !== total ||
    summary.passed !== passedCount ||
    summary.failed !== total - passedCount ||
    thresholdResult.passed !== (passedCount === total)
  ) {
    throw new ThresholdEvidenceFailure("Threshold summary is inconsistent");
  }

  return input as ExternalBenchmarkRawResult;
}


export function writeDbFamilyFingerprintFile(
  primaryPath: string,
  outputPath: string,
): void {
  const fingerprint = fingerprintDbFamily(primaryPath);
  writeUtf8Output(
    outputPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        files: fingerprint.files,
        sha256: fingerprint.sha256,
      },
      null,
      2,
    ) + "\n",
    "exclusive",
  );
}

export interface VerifyExternalBenchmarkEvidenceOptions {
  root: string;
  repoId: string;
  sourceRef: string;
  sourceCommit: string;
  cacheMode: "cold" | "warm";
  repeats: number;
  defaultDbBefore: string;
  defaultDbAfter: string;
  thresholdSourcePath?: string;
}

export function verifyExternalBenchmarkEvidence(
  options: VerifyExternalBenchmarkEvidenceOptions,
): number {
  const artifactRoot = canonicalizePath(options.root);
  const runnerRoot = canonicalizePath(
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  );
  const manifestPath = containedArtifactPath(
    artifactRoot,
    "run-manifest.json",
  );
  const resultsPath = containedArtifactPath(artifactRoot, "results.json");
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const resultsText = fs.readFileSync(resultsPath, "utf8");
  const manifest = JSON.parse(manifestText) as ExternalBenchmarkRunManifest;
  const results = JSON.parse(resultsText) as ExternalBenchmarkResults;

  if (serializeRunManifest(manifest) !== manifestText) {
    throw new Error("Run manifest bytes are not canonical");
  }
  if (serializeExternalBenchmarkResults(results) !== resultsText) {
    throw new Error("External benchmark results bytes are not canonical");
  }
  const manifestSha256 = hashSerializedManifest(manifestText);
  if (
    results.runManifestSha256 !== manifestSha256 ||
    results.passed !== true
  ) {
    throw new Error("Results do not identify a passing run manifest");
  }
  if (
    manifest.target.repoId !== options.repoId ||
    manifest.target.sourceRef !== options.sourceRef ||
    manifest.target.sourceCommit !== options.sourceCommit ||
    manifest.runner.cacheMode !== options.cacheMode ||
    manifest.runner.repeats !== options.repeats ||
    manifest.repeats.length !== options.repeats ||
    results.repeats.length !== options.repeats
  ) {
    throw new Error("Verifier options do not match the run manifest");
  }

  const runnerSnapshot = readGitSnapshot(runnerRoot);
  assertRunnerSnapshot(runnerRoot, manifest, runnerSnapshot);
  const thresholdSourcePath = canonicalizePath(
    options.thresholdSourcePath ??
      join(runnerRoot, ...manifest.inputs.thresholdSourcePath.split("/")),
  );
  assertManifestFileHashes(
    runnerRoot,
    artifactRoot,
    manifest,
    thresholdSourcePath,
  );
  const threshold = validateThresholdFiles(
    thresholdSourcePath,
    containedArtifactPath(artifactRoot, manifest.inputs.thresholdPath),
  );

  const configPath = containedArtifactPath(
    artifactRoot,
    manifest.inputs.configPath,
  );
  const config = record(
    parseJsonFile(configPath, "staged config"),
    "Staged config",
  );
  if (!Array.isArray(config.repos) || config.repos.length !== 1) {
    throw new Error("Staged config must contain one target");
  }
  const repo = record(config.repos[0], "Staged config repo");
  if (typeof repo.rootPath !== "string") {
    throw new Error("Staged target rootPath must be a string");
  }
  const targetRoot = canonicalizePath(resolve(runnerRoot, repo.rootPath));
  validateGeneratedRunConfig(
    config,
    manifest.target.repoId,
    targetRoot,
    runnerRoot,
  );
  const targetSnapshot = readGitSnapshot(targetRoot);
  assertGitSnapshot(
    targetSnapshot,
    {
      commit: manifest.target.sourceCommit,
      dirty: manifest.target.sourceDirty,
      treeSha256: manifest.target.sourceTreeSha256,
    },
    "target",
  );
  validateBaselineV1(
    parseJsonFile(
      containedArtifactPath(artifactRoot, manifest.inputs.baselinePath),
      "staged baseline",
    ),
    manifest.target.repoId,
  );

  if (manifest.target.scipArtifactPath !== null) {
    const scipPath = canonicalizePath(
      resolve(targetRoot, manifest.target.scipArtifactPath),
    );
    assertCanonicalPathContained(targetRoot, scipPath);
    assertFileHash(
      scipPath,
      manifest.target.scipArtifactSha256!,
      "SCIP artifact",
    );
  } else if (manifest.target.scipArtifactSha256 !== null) {
    throw new Error("SCIP artifact path and hash must both be null");
  }

  if (options.cacheMode === "cold") {
    if (
      manifest.inputs.warmSnapshot !== null ||
      manifest.repeats.some((repeat) => repeat.initialDbFiles.length !== 0)
    ) {
      throw new Error("Cold evidence must not declare warm inputs");
    }
  } else if (manifest.inputs.warmSnapshot === null) {
    throw new Error("Warm evidence must declare a warm snapshot");
  }
  for (const file of manifest.inputs.warmSnapshot?.files ?? []) {
    assertFileHash(
      containedArtifactPath(artifactRoot, file.path),
      file.sha256,
      "warm snapshot",
    );
  }

  const rawRepeats: ExternalBenchmarkRawRepeat[] = [];
  for (const repeat of manifest.repeats) {
    const result = results.repeats[repeat.repeat - 1];
    if (
      result === undefined ||
      result.repeat !== repeat.repeat ||
      result.failureBoundary !== null ||
      result.passed !== true ||
      result.benchmarkResultSha256 === null
    ) {
      throw new Error("Result repeat is incomplete: " + repeat.repeat);
    }
    for (const path of [repeat.stdoutPath, repeat.stderrPath]) {
      const logPath = containedArtifactPath(artifactRoot, path);
      if (!fs.statSync(logPath).isFile()) {
        throw new Error("Declared log is not a file: " + path);
      }
    }
    const rawPath = containedArtifactPath(
      artifactRoot,
      result.benchmarkResultPath,
    );
    assertFileHash(
      rawPath,
      result.benchmarkResultSha256,
      "raw benchmark result",
    );
    const benchmarkResult = validateRawBenchmarkResult(
      parseJsonFile(rawPath, "raw benchmark result"),
      manifest.target.repoId,
      threshold.pairs,
    );
    rawRepeats.push({
      repeat: repeat.repeat,
      exitCode: result.exitCode,
      failureBoundary: null,
      durationMs: result.durationMs,
      benchmarkResultPath: result.benchmarkResultPath,
      benchmarkResultSha256: result.benchmarkResultSha256,
      benchmarkResult,
    });

    const graphDbPath = containedArtifactPath(
      artifactRoot,
      repeat.graphDbPath,
    );
    if (collectDbFamilyFiles(graphDbPath).length === 0) {
      throw new Error("Repeat database family is missing: " + repeat.repeat);
    }
    for (const file of repeat.initialDbFiles) {
      assertFileHash(
        containedArtifactPath(artifactRoot, file.sourcePath),
        file.sha256,
        "initial database source",
      );
      assertFileHash(
        containedArtifactPath(artifactRoot, file.destinationPath),
        file.sha256,
        "initial database destination",
      );
    }
  }

  const rebuilt = buildExternalBenchmarkResults(
    manifestSha256,
    manifest.runner.repeats,
    rawRepeats,
  );
  if (serializeExternalBenchmarkResults(rebuilt) !== resultsText) {
    throw new Error("Raw benchmark results do not agree with results.json");
  }

  const before = fs.readFileSync(canonicalizePath(options.defaultDbBefore));
  const after = fs.readFileSync(canonicalizePath(options.defaultDbAfter));
  if (!before.equals(after)) {
    throw new Error("Default DB family fingerprints differ");
  }
  validateDbFamilyFingerprint(JSON.parse(before.toString("utf8")));
  return 0;
}

function containedArtifactPath(rootPath: string, artifactPath: string): string {
  const normalized = normalizeArtifactPath(artifactPath);
  const filePath = canonicalizePath(
    join(rootPath, ...normalized.split("/")),
  );
  assertCanonicalPathContained(rootPath, filePath);
  return filePath;
}

function validateDbFamilyFingerprint(input: unknown): void {
  const value = record(input, "DB family fingerprint");
  requireExactKeys(
    value,
    ["schemaVersion", "files", "sha256"],
    "DB family fingerprint",
  );
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.files) ||
    typeof value.sha256 !== "string"
  ) {
    throw new Error("DB family fingerprint is invalid");
  }
  const files = value.files.map((entry) => {
    const file = record(entry, "DB family fingerprint file");
    requireExactKeys(file, ["path", "sha256"], "DB family fingerprint file");
    if (typeof file.path !== "string" || typeof file.sha256 !== "string") {
      throw new Error("DB family fingerprint file is invalid");
    }
    return {
      path: normalizeArtifactPath(file.path),
      sha256: file.sha256,
    };
  });
  const sorted = [...files].sort((left, right) =>
    compareArtifactPath(left.path, right.path),
  );
  const sha256 = createHash("sha256")
    .update(JSON.stringify(sorted), "utf8")
    .digest("hex");
  if (
    JSON.stringify(files) !== JSON.stringify(sorted) ||
    sha256 !== value.sha256
  ) {
    throw new Error("DB family fingerprint hash is invalid");
  }
}
