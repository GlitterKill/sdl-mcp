import { execFileSync } from "node:child_process";
import fs, { existsSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  compareArtifactPath,
  fingerprintDirectory,
  fingerprintFiles,
  normalizeArtifactPath,
  sha256File,
  type ExternalBenchmarkRepeatManifest,
  type ExternalBenchmarkRunManifest,
  type HashedArtifactFile,
  type InitialDbFile,
} from "./external-manifest.js";

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
        left.replaceAll("\\", "/"),
        right.replaceAll("\\", "/"),
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

  for (const [categoryName, metric, trend, absolute, allowance] of THRESHOLD_RULES) {
    const category = record(thresholds[categoryName], categoryName);
    const rule = record(category[metric], metric);
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
  for (const [root, path] of [
    [runnerRoot, manifest.inputs.thresholdSourcePath],
    [artifactRoot, manifest.inputs.thresholdPath],
  ] as const) {
    assertFileHash(
      join(root, ...path.split("/")),
      manifest.inputs.thresholdSha256,
      "threshold",
    );
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
