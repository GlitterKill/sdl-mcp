import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";

export type ExternalBenchmarkCacheMode = "cold" | "warm";

export interface HashedArtifactFile {
  path: string;
  sha256: string;
}

export interface InitialDbFile {
  sourcePath: string;
  destinationPath: string;
  sha256: string;
}

export interface ExternalBenchmarkRepeatManifest {
  repeat: number;
  graphDbPath: string;
  stdoutPath: string;
  stderrPath: string;
  initialDbFiles: InitialDbFile[];
  command: string[];
}

export interface ExternalBenchmarkRunManifest {
  schemaVersion: 1;
  target: {
    repoId: string;
    sourceRef: string;
    sourceCommit: string;
    sourceDirty: boolean;
    sourceTreeSha256: string;
    scipArtifactPath: string | null;
    scipArtifactSha256: string | null;
  };
  runner: {
    sdlMcpVersion: string;
    sdlMcpCommit: string;
    sdlMcpSourceDirty: boolean;
    sdlMcpBuildTreeSha256: string;
    launcherPath: "scripts/external-benchmark-runner.mjs";
    launcherSha256: string;
    nodeVersion: string;
    platform: NodeJS.Platform;
    architecture: string;
    cacheMode: ExternalBenchmarkCacheMode;
    repeats: number;
  };
  inputs: {
    configPath: "inputs/sdlmcp.config.json";
    configSha256: string;
    baselinePath: "inputs/baseline.json";
    baselineSha256: string;
    baselineFormatVersion: "1";
    baselineTargetRepoId: string;
    thresholdSourcePath: "config/benchmark.config.json";
    thresholdPath: "inputs/threshold.json";
    thresholdSha256: string;
    warmSnapshot: { files: HashedArtifactFile[] } | null;
  };
  repeats: ExternalBenchmarkRepeatManifest[];
}

export interface ExternalBenchmarkMetricEvidence {
  indexTimePerFile: number;
  indexTimePerSymbol: number;
  symbolsPerFile: number;
  edgesPerSymbol: number;
  graphConnectivity: number;
  exportedSymbolRatio: number;
  sliceBuildTimeMs: number;
  avgSkeletonTimeMs: number;
  avgCardTokens: number;
  avgSkeletonTokens: number;
  functionMethodRatio: number;
  avgDepsPerSymbol: number;
  callEdgeCount: number;
  importEdgeCount: number;
  totalSymbols: number;
  totalFiles: number;
  summaryGenerationMs: number;
  summaryTokens: number;
  healthScore: number | null;
  watcherEventsProcessed: number;
  watcherErrors: number;
}

export interface ExternalBenchmarkThresholdEvidence {
  metricName: string;
  category: string;
  currentValue: number;
  baselineValue: number | null;
  passed: boolean;
  delta: number | null;
  deltaPercent: number | null;
  message: string;
}

export interface ExternalBenchmarkRawThresholdEvidence {
  metricName: string;
  category: string;
  currentValue: number;
  baselineValue?: number;
  passed: boolean;
  delta?: number;
  deltaPercent?: number;
  message: string;
}

export interface ExternalBenchmarkRawResult {
  timestamp?: string;
  repoPath?: string;
  config?: unknown;
  metrics: ExternalBenchmarkMetricEvidence;
  thresholdResult?: {
    evaluations: ExternalBenchmarkRawThresholdEvidence[];
  };
}

export interface ExternalBenchmarkRawRepeat {
  repeat: number;
  exitCode: number | null;
  failureBoundary: ExternalBenchmarkFailureBoundary | null;
  durationMs: number;
  benchmarkResultPath: string;
  benchmarkResultSha256: string | null;
  benchmarkResult: ExternalBenchmarkRawResult | null;
}

export interface ExternalBenchmarkStopBoundary {
  boundary: Exclude<
    ExternalBenchmarkFailureBoundary,
    "unexecuted-after-failure"
  >;
  failedRepeat: number;
}

export type ExternalBenchmarkFailureBoundary =
  | "preflight-between-repeats"
  | "child-spawn"
  | "child-stream"
  | "child-exit"
  | "raw-result-missing"
  | "raw-result-invalid"
  | "threshold-evidence-invalid"
  | "unexecuted-after-failure";

export interface ExternalBenchmarkRepeatResult {
  repeat: number;
  exitCode: number | null;
  failureBoundary: ExternalBenchmarkFailureBoundary | null;
  durationMs: number;
  benchmarkResultPath: string;
  benchmarkResultSha256: string | null;
  metrics: ExternalBenchmarkMetricEvidence | null;
  thresholds: ExternalBenchmarkThresholdEvidence[];
  passed: boolean;
}

export interface ExternalBenchmarkResults {
  schemaVersion: 1;
  runManifestSha256: string;
  passed: boolean;
  repeats: ExternalBenchmarkRepeatResult[];
}

export interface ExternalBenchmarkPreflightFailure {
  schemaVersion: 1;
  boundary: "post-artifact-pre-manifest";
  message: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function compareArtifactPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeArtifactPath(input: string): string {
  const normalized = input.replace(/\\/gu, "/");
  const segments = normalized.split("/");

  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Artifact path must be a safe relative path: " + input);
  }

  return normalized;
}

function validateSha256(sha256: string): string {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error("Expected a lowercase SHA-256 hash");
  }
  return sha256;
}

function normalizeHashedFile(file: HashedArtifactFile): HashedArtifactFile {
  return {
    path: normalizeArtifactPath(file.path),
    sha256: validateSha256(file.sha256),
  };
}

function normalizeInitialDbFile(file: InitialDbFile): InitialDbFile {
  return {
    sourcePath: normalizeArtifactPath(file.sourcePath),
    destinationPath: normalizeArtifactPath(file.destinationPath),
    sha256: validateSha256(file.sha256),
  };
}

export function serializeRunManifest(
  input: ExternalBenchmarkRunManifest,
): string {
  const warmSnapshot =
    input.inputs.warmSnapshot === null
      ? null
      : {
          files: [...input.inputs.warmSnapshot.files]
            .map(normalizeHashedFile)
            .sort((left, right) =>
              compareArtifactPath(left.path, right.path),
            ),
        };

  const repeats = [...input.repeats]
    .map((repeat) => ({
      repeat: repeat.repeat,
      graphDbPath: normalizeArtifactPath(repeat.graphDbPath),
      stdoutPath: normalizeArtifactPath(repeat.stdoutPath),
      stderrPath: normalizeArtifactPath(repeat.stderrPath),
      initialDbFiles: [...repeat.initialDbFiles]
        .map(normalizeInitialDbFile)
        .sort(
          (left, right) =>
            compareArtifactPath(
              left.destinationPath,
              right.destinationPath,
            ) || compareArtifactPath(left.sourcePath, right.sourcePath),
        ),
      command: [...repeat.command],
    }))
    .sort((left, right) => left.repeat - right.repeat);

  const manifest: ExternalBenchmarkRunManifest = {
    schemaVersion: 1,
    target: {
      repoId: input.target.repoId,
      sourceRef: input.target.sourceRef,
      sourceCommit: input.target.sourceCommit,
      sourceDirty: input.target.sourceDirty,
      sourceTreeSha256: validateSha256(input.target.sourceTreeSha256),
      scipArtifactPath:
        input.target.scipArtifactPath === null
          ? null
          : normalizeArtifactPath(input.target.scipArtifactPath),
      scipArtifactSha256:
        input.target.scipArtifactSha256 === null
          ? null
          : validateSha256(input.target.scipArtifactSha256),
    },
    runner: {
      sdlMcpVersion: input.runner.sdlMcpVersion,
      sdlMcpCommit: input.runner.sdlMcpCommit,
      sdlMcpSourceDirty: input.runner.sdlMcpSourceDirty,
      sdlMcpBuildTreeSha256: validateSha256(
        input.runner.sdlMcpBuildTreeSha256,
      ),
      launcherPath: "scripts/external-benchmark-runner.mjs",
      launcherSha256: validateSha256(input.runner.launcherSha256),
      nodeVersion: input.runner.nodeVersion,
      platform: input.runner.platform,
      architecture: input.runner.architecture,
      cacheMode: input.runner.cacheMode,
      repeats: input.runner.repeats,
    },
    inputs: {
      configPath: "inputs/sdlmcp.config.json",
      configSha256: validateSha256(input.inputs.configSha256),
      baselinePath: "inputs/baseline.json",
      baselineSha256: validateSha256(input.inputs.baselineSha256),
      baselineFormatVersion: "1",
      baselineTargetRepoId: input.inputs.baselineTargetRepoId,
      thresholdSourcePath: "config/benchmark.config.json",
      thresholdPath: "inputs/threshold.json",
      thresholdSha256: validateSha256(input.inputs.thresholdSha256),
      warmSnapshot,
    },
    repeats,
  };

  return JSON.stringify(manifest, null, 2) + "\n";
}

export function hashSerializedManifest(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

// Target-tree symlinks are evidence themselves; never follow their targets.
export function fingerprintFiles(
  rootPath: string,
  relativePaths: readonly string[],
): { files: HashedArtifactFile[]; sha256: string } {
  const files = relativePaths
    .map((relativePath) => {
      const path = normalizeArtifactPath(relativePath);
      const absolutePath = resolve(rootPath, ...path.split("/"));
      const stats = lstatSync(absolutePath);
      let sha256: string;

      if (stats.isSymbolicLink()) {
        sha256 = createHash("sha256")
          .update(readlinkSync(absolutePath), "utf8")
          .digest("hex");
      } else if (stats.isFile()) {
        sha256 = sha256File(absolutePath);
      } else {
        throw new Error("Fingerprint input is not a file: " + path);
      }

      return { path, sha256 };
    })
    .sort((left, right) => compareArtifactPath(left.path, right.path));

  return {
    files,
    sha256: createHash("sha256")
      .update(JSON.stringify(files), "utf8")
      .digest("hex"),
  };
}

export function fingerprintDirectory(
  rootPath: string,
): { files: HashedArtifactFile[]; sha256: string } {
  const relativePaths: string[] = [];

  const walk = (directoryPath: string, prefix: string): void => {
    const entries = readdirSync(directoryPath, { withFileTypes: true }).sort(
      (left, right) => compareArtifactPath(left.name, right.name),
    );

    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = resolve(directoryPath, entry.name);

      if (entry.isSymbolicLink()) {
        throw new Error("Build tree cannot contain a symbolic link: " + path);
      }
      if (entry.isDirectory()) {
        walk(absolutePath, path);
      } else if (entry.isFile()) {
        relativePaths.push(path);
      } else {
        throw new Error("Build tree contains a special file: " + path);
      }
    }
  };

  walk(rootPath, "");
  return fingerprintFiles(rootPath, relativePaths);
}

function normalizeMetricEvidence(
  metrics: ExternalBenchmarkMetricEvidence,
): ExternalBenchmarkMetricEvidence {
  return {
    indexTimePerFile: metrics.indexTimePerFile,
    indexTimePerSymbol: metrics.indexTimePerSymbol,
    symbolsPerFile: metrics.symbolsPerFile,
    edgesPerSymbol: metrics.edgesPerSymbol,
    graphConnectivity: metrics.graphConnectivity,
    exportedSymbolRatio: metrics.exportedSymbolRatio,
    sliceBuildTimeMs: metrics.sliceBuildTimeMs,
    avgSkeletonTimeMs: metrics.avgSkeletonTimeMs,
    avgCardTokens: metrics.avgCardTokens,
    avgSkeletonTokens: metrics.avgSkeletonTokens,
    functionMethodRatio: metrics.functionMethodRatio,
    avgDepsPerSymbol: metrics.avgDepsPerSymbol,
    callEdgeCount: metrics.callEdgeCount,
    importEdgeCount: metrics.importEdgeCount,
    totalSymbols: metrics.totalSymbols,
    totalFiles: metrics.totalFiles,
    summaryGenerationMs: metrics.summaryGenerationMs,
    summaryTokens: metrics.summaryTokens,
    healthScore: metrics.healthScore,
    watcherEventsProcessed: metrics.watcherEventsProcessed,
    watcherErrors: metrics.watcherErrors,
  };
}

function normalizeThresholdEvidence(
  threshold:
    | ExternalBenchmarkRawThresholdEvidence
    | ExternalBenchmarkThresholdEvidence,
): ExternalBenchmarkThresholdEvidence {
  return {
    metricName: threshold.metricName,
    category: threshold.category,
    currentValue: threshold.currentValue,
    baselineValue: threshold.baselineValue ?? null,
    passed: threshold.passed,
    delta: threshold.delta ?? null,
    deltaPercent: threshold.deltaPercent ?? null,
    message: threshold.message,
  };
}

function thresholdOrder(
  left: ExternalBenchmarkThresholdEvidence,
  right: ExternalBenchmarkThresholdEvidence,
): number {
  return (
    compareArtifactPath(left.metricName, right.metricName) ||
    compareArtifactPath(left.category, right.category)
  );
}

function repeatPassed(repeat: ExternalBenchmarkRepeatResult): boolean {
  return (
    repeat.exitCode === 0 &&
    repeat.failureBoundary === null &&
    repeat.benchmarkResultSha256 !== null &&
    repeat.metrics !== null &&
    repeat.thresholds.length > 0 &&
    repeat.thresholds.every((threshold) => threshold.passed)
  );
}

function mapRawRepeat(
  raw: ExternalBenchmarkRawRepeat,
  failureBoundary: ExternalBenchmarkFailureBoundary | null,
): ExternalBenchmarkRepeatResult {
  const metrics =
    raw.benchmarkResult === null
      ? null
      : normalizeMetricEvidence(raw.benchmarkResult.metrics);
  const thresholds =
    raw.benchmarkResult?.thresholdResult?.evaluations
      .map(normalizeThresholdEvidence)
      .sort(thresholdOrder) ?? [];

  const repeat: ExternalBenchmarkRepeatResult = {
    repeat: raw.repeat,
    exitCode: raw.exitCode,
    failureBoundary,
    durationMs: raw.durationMs,
    benchmarkResultPath: normalizeArtifactPath(raw.benchmarkResultPath),
    benchmarkResultSha256:
      raw.benchmarkResultSha256 === null
        ? null
        : validateSha256(raw.benchmarkResultSha256),
    metrics,
    thresholds,
    passed: false,
  };
  repeat.passed = repeatPassed(repeat);
  return repeat;
}

function missingRepeat(
  repeat: number,
  failureBoundary: ExternalBenchmarkFailureBoundary,
): ExternalBenchmarkRepeatResult {
  return {
    repeat,
    exitCode: null,
    failureBoundary,
    durationMs: 0,
    benchmarkResultPath:
      `raw/repeat-${String(repeat).padStart(3, "0")}.benchmark.json`,
    benchmarkResultSha256: null,
    metrics: null,
    thresholds: [],
    passed: false,
  };
}

export function buildExternalBenchmarkResults(
  runManifestSha256: string,
  expectedRepeats: number,
  rawRepeats: readonly ExternalBenchmarkRawRepeat[],
  stop?: ExternalBenchmarkStopBoundary,
): ExternalBenchmarkResults {
  validateSha256(runManifestSha256);
  if (!Number.isInteger(expectedRepeats) || expectedRepeats < 0) {
    throw new Error("Expected repeat count must be a non-negative integer");
  }

  const byRepeat = new Map<number, ExternalBenchmarkRawRepeat>();
  for (const raw of rawRepeats) {
    if (
      !Number.isInteger(raw.repeat) ||
      raw.repeat < 1 ||
      raw.repeat > expectedRepeats ||
      byRepeat.has(raw.repeat)
    ) {
      throw new Error("Raw repeat numbers must be unique and in range");
    }
    byRepeat.set(raw.repeat, raw);
  }
  if (
    stop !== undefined &&
    (!Number.isInteger(stop.failedRepeat) ||
      stop.failedRepeat < 1 ||
      stop.failedRepeat > expectedRepeats)
  ) {
    throw new Error("Failed repeat must be within the expected repeat count");
  }

  // The first real failure is preserved; only later repeats are synthetic.
  let failedRepeat = stop?.failedRepeat;
  let failureBoundary: ExternalBenchmarkFailureBoundary | undefined =
    stop?.boundary;
  for (let repeat = 1; repeat <= expectedRepeats; repeat += 1) {
    const raw = byRepeat.get(repeat);
    const boundary = raw?.failureBoundary;
    if (
      (raw === undefined || boundary !== null) &&
      (failedRepeat === undefined || repeat < failedRepeat)
    ) {
      failedRepeat = repeat;
      failureBoundary = boundary ?? "raw-result-missing";
    }
  }

  const repeats: ExternalBenchmarkRepeatResult[] = [];
  for (let repeat = 1; repeat <= expectedRepeats; repeat += 1) {
    if (failedRepeat !== undefined && repeat > failedRepeat) {
      repeats.push(missingRepeat(repeat, "unexecuted-after-failure"));
      continue;
    }

    const raw = byRepeat.get(repeat);
    const boundary =
      repeat === failedRepeat
        ? (failureBoundary ?? "raw-result-missing")
        : (raw?.failureBoundary ?? null);
    repeats.push(
      raw === undefined
        ? missingRepeat(repeat, boundary ?? "raw-result-missing")
        : mapRawRepeat(raw, boundary),
    );
  }

  const passed =
    repeats.length === expectedRepeats &&
    expectedRepeats > 0 &&
    repeats.every(
      (repeat) =>
        repeat.exitCode === 0 &&
        repeat.failureBoundary === null &&
        repeat.benchmarkResultSha256 !== null &&
        repeat.metrics !== null &&
        repeat.thresholds.length > 0 &&
        repeat.thresholds.every((threshold) => threshold.passed),
    );

  return {
    schemaVersion: 1,
    runManifestSha256,
    passed,
    repeats,
  };
}

export function serializeExternalBenchmarkResults(
  input: ExternalBenchmarkResults,
): string {
  const results: ExternalBenchmarkResults = {
    schemaVersion: 1,
    runManifestSha256: validateSha256(input.runManifestSha256),
    passed: input.passed,
    repeats: [...input.repeats]
      .sort((left, right) => left.repeat - right.repeat)
      .map((repeat) => ({
      repeat: repeat.repeat,
      exitCode: repeat.exitCode,
      failureBoundary: repeat.failureBoundary,
      durationMs: repeat.durationMs,
      benchmarkResultPath: normalizeArtifactPath(
        repeat.benchmarkResultPath,
      ),
      benchmarkResultSha256:
        repeat.benchmarkResultSha256 === null
          ? null
          : validateSha256(repeat.benchmarkResultSha256),
      metrics:
        repeat.metrics === null
          ? null
          : normalizeMetricEvidence(repeat.metrics),
      thresholds: [...repeat.thresholds]
        .map(normalizeThresholdEvidence)
        .sort(thresholdOrder),
      passed: repeat.passed,
    })),
  };

  return JSON.stringify(results, null, 2) + "\n";
}
