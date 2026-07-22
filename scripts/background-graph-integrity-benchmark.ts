import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, platform, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { invalidateConfigCache } from "../dist/config/loadConfig.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../dist/db/ladybug.js";
import {
  getDerivedState,
  markGraphIntegrityVerifiedIfVerifying,
} from "../dist/db/ladybug-derived-state.js";
import * as ladybugDb from "../dist/db/ladybug-queries.js";
import { indexRepo } from "../dist/indexer/indexer.js";
import {
  cancelAndWaitForAllGraphIntegrityVerifiers,
  withGraphIntegrityVerifierQuiesced,
} from "../dist/indexer/provider-first/background-graph-integrity-verifier.js";
import {
  compareGraphIntegrityExpectations,
  createGraphIntegrityExpectationFromManifest,
} from "../dist/indexer/provider-first/persisted-graph-integrity.js";
import {
  captureForegroundPersistedGraphIntegrity,
  patchSavedFile,
  type SavedFilePatchObserver,
} from "../dist/live-index/file-patcher.js";

export const BENCHMARK_SCHEMA_VERSION = 1;
export const FIXTURE_SEED = "background-integrity-v1";
export const FIXTURE_FILE_COUNT = 1_500;
export const FIXTURE_SYMBOLS_PER_FILE = 20;
export const BENCHMARK_WARMUP_COUNT = 3;
export const BENCHMARK_SAMPLE_COUNT = 20;
export const BENCHMARK_TIMEOUT_MS = 30_000;
const BENCHMARK_TERMINATION_GRACE_MS = 5_000;
const BENCHMARK_FORCE_KILL_TIMEOUT_MS = 10_000;
const BENCHMARK_DEATH_POLL_MS = 50;

function serialSampleId(
  lane: "candidate" | "control",
  index: number,
): string {
  return index < BENCHMARK_WARMUP_COUNT
    ? `${lane}:warmup:${index}`
    : `${lane}:measured:${index - BENCHMARK_WARMUP_COUNT}`;
}

const CANDIDATE_SERIAL_SAMPLE_COUNT =
  BENCHMARK_WARMUP_COUNT + BENCHMARK_SAMPLE_COUNT;
const CONCURRENT_SAMPLE_INDEX = CANDIDATE_SERIAL_SAMPLE_COUNT;
const CONTROL_SAMPLE_OFFSET = CONCURRENT_SAMPLE_INDEX + 1;

export const BENCHMARK_SAMPLE_SEQUENCE = Object.freeze([
  ...Array.from({ length: CANDIDATE_SERIAL_SAMPLE_COUNT }, (_, index) =>
    serialSampleId("candidate", index),
  ),
  "concurrent:0",
  ...Array.from({ length: CANDIDATE_SERIAL_SAMPLE_COUNT }, (_, index) =>
    serialSampleId("control", index),
  ),
]);

export const DEFAULT_THRESHOLDS = {
  candidateForegroundP50Ms: 500,
  candidateForegroundP95Ms: 1_000,
  candidateToControlP50Ratio: 0.2,
  concurrentForegroundMs: 1_000,
  backgroundVerificationP95Ms: 3_500,
} as const;

interface BenchmarkFile {
  relPath: string;
  content: string;
}

interface BenchmarkEdit extends BenchmarkFile {
  language: "typescript";
  version: number;
}

export interface BenchmarkFixture {
  seed: typeof FIXTURE_SEED;
  files: BenchmarkFile[];
  warmupEdits: BenchmarkEdit[];
  measuredEdits: BenchmarkEdit[];
  concurrentEdits: BenchmarkEdit[];
  fixtureHash: string;
  editSequenceHash: string;
}

export interface BenchmarkThresholdInputs {
  candidateForegroundP50Ms: number;
  candidateForegroundP95Ms: number;
  controlForegroundP50Ms: number;
  concurrentForegroundMs: number;
  backgroundVerificationP95Ms: number;
  timeoutCount: number;
  foregroundFullGraphCaptures: number;
  candidateMeasuredSamples: number;
  controlMeasuredSamples: number;
}

export interface BenchmarkCheck {
  name: string;
  actual: number;
  comparator: "<" | "<=" | "=";
  threshold: number;
  passed: boolean;
}

export interface BenchmarkArtifactInput {
  commitSha: string;
  os: string;
  cpu: string | null;
  node: string;
  ladybugDb: string;
  addonMode: "disabled" | "enabled";
  fixtureHash: string;
  editSequenceHash: string;
  startingDatabaseHash: string;
  cacheMode: "warm-serial";
  candidateForegroundSamplesMs: number[];
  controlForegroundSamplesMs: number[];
  backgroundVerificationSamplesMs: number[];
  concurrentForegroundMs: number;
  timeoutCount: number;
  foregroundFullGraphCaptures: number;
}

export interface TimeoutScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BenchmarkPartialProgress {
  startingDatabaseHash: string;
  candidateForegroundSamplesMs: number[];
  controlForegroundSamplesMs: number[];
  backgroundVerificationSamplesMs: number[];
  concurrentForegroundMs: number;
  foregroundFullGraphCaptures: number;
}

export type BenchmarkArtifact = ReturnType<typeof buildBenchmarkArtifact>;

export type BenchmarkWorkerMessage =
  | { type: "metadata"; startingDatabaseHash: string }
  | { type: "sample-start"; sampleId: string }
  | { type: "capture"; count: number }
  | {
      type: "sample-end";
      sampleId: string;
      progress: BenchmarkPartialProgress;
    }
  | { type: "complete"; artifact: BenchmarkArtifact }
  | { type: "error"; message: string };

interface BenchmarkWorker extends EventEmitter {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface BenchmarkSupervisorOptions {
  worker: BenchmarkWorker;
  timeoutMs: number;
  terminationGraceMs?: number;
  forceKillTimeoutMs?: number;
  deathPollMs?: number;
  scheduler?: TimeoutScheduler;
  platform?: NodeJS.Platform;
  isProcessAlive?(pid: number): boolean;
  forceTerminate?(worker: BenchmarkWorker, platform: NodeJS.Platform): Promise<void>;
  cleanupWorkRoot?(): void;
  createFailureArtifact(
    timeoutCount: number,
    progress: BenchmarkPartialProgress,
  ): BenchmarkArtifact;
  writeArtifact(artifact: BenchmarkArtifact): void;
}

interface BenchmarkSupervisorResult {
  artifact: BenchmarkArtifact;
  timedOut: boolean;
}

interface BenchmarkSampleUpdate {
  candidateForegroundMs?: number;
  controlForegroundMs?: number;
  backgroundVerificationMs?: number;
  concurrentForegroundMs?: number;
  foregroundFullGraphCaptures?: number;
}

interface BenchmarkSampleReporter {
  start(sampleId: string): Promise<void>;
  capture(count: number): void;
  end(sampleId: string, update: BenchmarkSampleUpdate): Promise<void>;
}

const nativeTimeoutScheduler: TimeoutScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateBenchmarkWorkRoot(
  workRoot: string,
  tempRoot = tmpdir(),
): string {
  const resolvedTempRoot = resolve(tempRoot);
  const resolvedWorkRoot = resolve(workRoot);
  const rel = relative(resolvedTempRoot, resolvedWorkRoot);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Benchmark work root must remain inside the temporary directory");
  }
  if (!rel || rel.includes(sep) || !rel.startsWith("sdl-bgi-")) {
    throw new Error("Invalid benchmark work root");
  }
  return resolvedWorkRoot;
}

export function createBenchmarkWorkRoot(tempRoot = tmpdir()): string {
  return mkdtempSync(join(resolve(tempRoot), "sdl-bgi-"));
}

export function cleanupBenchmarkWorkRoot(
  workRoot: string,
  tempRoot = tmpdir(),
): void {
  rmSync(validateBenchmarkWorkRoot(workRoot, tempRoot), {
    recursive: true,
    force: true,
  });
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function createSource(fileIndex: number, variant = 0): string {
  return `${Array.from({ length: FIXTURE_SYMBOLS_PER_FILE }, (_, symbolIndex) => {
    const name = `symbol_${pad(fileIndex, 4)}_${pad(symbolIndex, 2)}`;
    const value =
      symbolIndex === FIXTURE_SYMBOLS_PER_FILE - 1
        ? `crossFilePlaceholder_${pad((fileIndex + 1) % FIXTURE_FILE_COUNT, 4)}()`
        : String(symbolIndex + variant);
    return `export function ${name}(): number {\n  return ${value};\n}`;
  }).join("\n\n")}\n`;
}

export function createBenchmarkFixture(): BenchmarkFixture {
  const files = Array.from({ length: FIXTURE_FILE_COUNT }, (_, fileIndex) => ({
    relPath: `src/file-${pad(fileIndex, 4)}.ts`,
    content: createSource(fileIndex),
  }));
  const edits = Array.from(
    { length: BENCHMARK_WARMUP_COUNT + BENCHMARK_SAMPLE_COUNT + 2 },
    (_, editIndex): BenchmarkEdit => ({
      relPath: `src/file-${pad(editIndex, 4)}.ts`,
      content: createSource(editIndex, editIndex + 1),
      language: "typescript",
      version: editIndex + 1,
    }),
  );
  return {
    seed: FIXTURE_SEED,
    files,
    warmupEdits: edits.slice(0, BENCHMARK_WARMUP_COUNT),
    measuredEdits: edits.slice(
      BENCHMARK_WARMUP_COUNT,
      BENCHMARK_WARMUP_COUNT + BENCHMARK_SAMPLE_COUNT,
    ),
    concurrentEdits: edits.slice(-2),
    fixtureHash: sha256(JSON.stringify({ seed: FIXTURE_SEED, files })),
    editSequenceHash: sha256(JSON.stringify(edits)),
  };
}

export function createBenchmarkLaneInputs(fixture: BenchmarkFixture): {
  candidate: { files: BenchmarkFile[]; edits: BenchmarkEdit[] };
  control: { files: BenchmarkFile[]; edits: BenchmarkEdit[] };
} {
  const files = structuredClone(fixture.files);
  const edits = structuredClone([
    ...fixture.warmupEdits,
    ...fixture.measuredEdits,
  ]);
  return {
    candidate: { files, edits },
    control: {
      files: structuredClone(files),
      edits: structuredClone(edits),
    },
  };
}

export function nearestRankPercentile(
  samples: readonly number[],
  percentile: number,
): number {
  if (samples.length === 0) throw new Error("At least one sample is required");
  if (!(percentile > 0 && percentile <= 1)) {
    throw new Error("Percentile must be greater than zero and at most one");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1]!;
}

export function evaluateBenchmarkChecks(
  metrics: BenchmarkThresholdInputs,
  thresholds = DEFAULT_THRESHOLDS,
): BenchmarkCheck[] {
  const ratio =
    metrics.controlForegroundP50Ms > 0
      ? metrics.candidateForegroundP50Ms / metrics.controlForegroundP50Ms
      : Number.POSITIVE_INFINITY;
  return [
    check("candidate foreground p50", metrics.candidateForegroundP50Ms, "<", thresholds.candidateForegroundP50Ms),
    check("candidate foreground p95", metrics.candidateForegroundP95Ms, "<", thresholds.candidateForegroundP95Ms),
    check("candidate/control p50 ratio", ratio, "<=", thresholds.candidateToControlP50Ratio),
    check("concurrent foreground edit", metrics.concurrentForegroundMs, "<", thresholds.concurrentForegroundMs),
    check("background verification p95", metrics.backgroundVerificationP95Ms, "<=", thresholds.backgroundVerificationP95Ms),
    check("sample timeouts", metrics.timeoutCount, "=", 0),
    check("foreground full-graph captures", metrics.foregroundFullGraphCaptures, "=", 0),
    check("candidate measured samples", metrics.candidateMeasuredSamples, "=", BENCHMARK_SAMPLE_COUNT),
    check("control measured samples", metrics.controlMeasuredSamples, "=", BENCHMARK_SAMPLE_COUNT),
  ];
}

function check(
  name: string,
  actual: number,
  comparator: BenchmarkCheck["comparator"],
  threshold: number,
): BenchmarkCheck {
  const passed =
    comparator === "<"
      ? actual < threshold
      : comparator === "<="
        ? actual <= threshold
        : actual === threshold;
  return { name, actual, comparator, threshold, passed };
}

function emptyBenchmarkProgress(): BenchmarkPartialProgress {
  return {
    startingDatabaseHash: "unavailable",
    candidateForegroundSamplesMs: [],
    controlForegroundSamplesMs: [],
    backgroundVerificationSamplesMs: [],
    concurrentForegroundMs: Number.MAX_VALUE,
    foregroundFullGraphCaptures: 0,
  };
}

function copyBenchmarkProgress(
  progress: BenchmarkPartialProgress,
): BenchmarkPartialProgress {
  return {
    ...progress,
    candidateForegroundSamplesMs: [...progress.candidateForegroundSamplesMs],
    controlForegroundSamplesMs: [...progress.controlForegroundSamplesMs],
    backgroundVerificationSamplesMs: [
      ...progress.backgroundVerificationSamplesMs,
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isHash(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeFiniteNumber(value) && Number.isInteger(value);
}

function isSampleArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= BENCHMARK_SAMPLE_COUNT &&
    value.every(isNonNegativeFiniteNumber)
  );
}

function isSampleId(value: unknown): value is string {
  if (value === "concurrent:0") return true;
  if (typeof value !== "string") return false;
  const match = /^(candidate|control):(warmup|measured):(\d+)$/u.exec(value);
  if (!match) return false;
  const index = Number(match[3]);
  return match[2] === "warmup"
    ? index < BENCHMARK_WARMUP_COUNT
    : index < BENCHMARK_SAMPLE_COUNT;
}

function parseBenchmarkProgress(value: unknown): BenchmarkPartialProgress | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "startingDatabaseHash",
      "candidateForegroundSamplesMs",
      "controlForegroundSamplesMs",
      "backgroundVerificationSamplesMs",
      "concurrentForegroundMs",
      "foregroundFullGraphCaptures",
    ]) ||
    !isHash(value.startingDatabaseHash, 64) ||
    !isSampleArray(value.candidateForegroundSamplesMs) ||
    !isSampleArray(value.controlForegroundSamplesMs) ||
    !isSampleArray(value.backgroundVerificationSamplesMs) ||
    value.backgroundVerificationSamplesMs.length !==
      value.candidateForegroundSamplesMs.length ||
    !isNonNegativeFiniteNumber(value.concurrentForegroundMs) ||
    !isNonNegativeInteger(value.foregroundFullGraphCaptures)
  ) {
    return undefined;
  }
  return {
    startingDatabaseHash: value.startingDatabaseHash,
    candidateForegroundSamplesMs: [...value.candidateForegroundSamplesMs],
    controlForegroundSamplesMs: [...value.controlForegroundSamplesMs],
    backgroundVerificationSamplesMs: [
      ...value.backgroundVerificationSamplesMs,
    ],
    concurrentForegroundMs: value.concurrentForegroundMs,
    foregroundFullGraphCaptures: value.foregroundFullGraphCaptures,
  };
}

function parseBenchmarkArtifact(value: unknown): BenchmarkArtifact | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "commitSha",
      "os",
      "cpu",
      "node",
      "ladybugDb",
      "addonMode",
      "fixtureSeed",
      "fixtureHash",
      "editSequenceHash",
      "startingDatabaseHash",
      "cacheMode",
      "warmupCount",
      "sampleCount",
      "timeoutMs",
      "rawSamplesMs",
      "metricsMs",
      "timeoutCount",
      "thresholds",
      "foregroundFullGraphCaptures",
      "checks",
      "passed",
    ]) ||
    value.schemaVersion !== BENCHMARK_SCHEMA_VERSION ||
    !isHash(value.commitSha, 40) ||
    !isNonEmptyString(value.os) ||
    !(value.cpu === null || isNonEmptyString(value.cpu)) ||
    !isNonEmptyString(value.node) ||
    !isNonEmptyString(value.ladybugDb) ||
    !(value.addonMode === "disabled" || value.addonMode === "enabled") ||
    value.fixtureSeed !== FIXTURE_SEED ||
    !isHash(value.fixtureHash, 64) ||
    !isHash(value.editSequenceHash, 64) ||
    !isHash(value.startingDatabaseHash, 64) ||
    value.cacheMode !== "warm-serial" ||
    value.warmupCount !== BENCHMARK_WARMUP_COUNT ||
    value.sampleCount !== BENCHMARK_SAMPLE_COUNT ||
    value.timeoutMs !== BENCHMARK_TIMEOUT_MS ||
    !isRecord(value.rawSamplesMs) ||
    !hasExactKeys(value.rawSamplesMs, [
      "candidateForeground",
      "controlForeground",
      "backgroundVerification",
    ]) ||
    !isSampleArray(value.rawSamplesMs.candidateForeground) ||
    value.rawSamplesMs.candidateForeground.length !== BENCHMARK_SAMPLE_COUNT ||
    !isSampleArray(value.rawSamplesMs.controlForeground) ||
    value.rawSamplesMs.controlForeground.length !== BENCHMARK_SAMPLE_COUNT ||
    !isSampleArray(value.rawSamplesMs.backgroundVerification) ||
    value.rawSamplesMs.backgroundVerification.length !== BENCHMARK_SAMPLE_COUNT ||
    !isRecord(value.metricsMs) ||
    !isNonNegativeFiniteNumber(value.metricsMs.concurrentForeground) ||
    !isNonNegativeInteger(value.timeoutCount) ||
    !isNonNegativeInteger(value.foregroundFullGraphCaptures)
  ) {
    return undefined;
  }
  const expected = buildBenchmarkArtifact({
    commitSha: value.commitSha,
    os: value.os,
    cpu: value.cpu,
    node: value.node,
    ladybugDb: value.ladybugDb,
    addonMode: value.addonMode,
    fixtureHash: value.fixtureHash,
    editSequenceHash: value.editSequenceHash,
    startingDatabaseHash: value.startingDatabaseHash,
    cacheMode: value.cacheMode,
    candidateForegroundSamplesMs: value.rawSamplesMs.candidateForeground,
    controlForegroundSamplesMs: value.rawSamplesMs.controlForeground,
    backgroundVerificationSamplesMs:
      value.rawSamplesMs.backgroundVerification,
    concurrentForegroundMs: value.metricsMs.concurrentForeground,
    timeoutCount: value.timeoutCount,
    foregroundFullGraphCaptures: value.foregroundFullGraphCaptures,
  });
  return JSON.stringify(value) === JSON.stringify(expected)
    ? (value as BenchmarkArtifact)
    : undefined;
}

function parseWorkerMessage(message: unknown): BenchmarkWorkerMessage | undefined {
  if (!isRecord(message) || !isNonEmptyString(message.type)) return undefined;
  switch (message.type) {
    case "metadata":
      return hasExactKeys(message, ["type", "startingDatabaseHash"]) &&
        isHash(message.startingDatabaseHash, 64)
        ? { type: "metadata", startingDatabaseHash: message.startingDatabaseHash }
        : undefined;
    case "sample-start":
      return hasExactKeys(message, ["type", "sampleId"]) && isSampleId(message.sampleId)
        ? { type: "sample-start", sampleId: message.sampleId }
        : undefined;
    case "capture":
      return hasExactKeys(message, ["type", "count"]) &&
        isNonNegativeInteger(message.count) &&
        message.count > 0
        ? { type: "capture", count: message.count }
        : undefined;
    case "sample-end": {
      const progress = parseBenchmarkProgress(message.progress);
      return hasExactKeys(message, ["type", "sampleId", "progress"]) &&
        isSampleId(message.sampleId) &&
        progress
        ? { type: "sample-end", sampleId: message.sampleId, progress }
        : undefined;
    }
    case "complete": {
      const artifact = parseBenchmarkArtifact(message.artifact);
      return hasExactKeys(message, ["type", "artifact"]) && artifact
        ? { type: "complete", artifact }
        : undefined;
    }
    case "error":
      return hasExactKeys(message, ["type", "message"]) &&
        isNonEmptyString(message.message) &&
        message.message.length <= 4_096
        ? { type: "error", message: message.message }
        : undefined;
    default:
      return undefined;
  }
}

function arraysEqual(previous: readonly number[], next: readonly number[]): boolean {
  return (
    previous.length === next.length &&
    previous.every((value, index) => next[index] === value)
  );
}

function appendsOne(previous: readonly number[], next: readonly number[]): boolean {
  return (
    next.length === previous.length + 1 &&
    previous.every((value, index) => next[index] === value)
  );
}

function progressMatchesSampleEnd(
  sampleId: string,
  previous: BenchmarkPartialProgress,
  next: BenchmarkPartialProgress,
): boolean {
  if (
    next.startingDatabaseHash !== previous.startingDatabaseHash ||
    next.foregroundFullGraphCaptures !== previous.foregroundFullGraphCaptures
  ) {
    return false;
  }
  const candidateChanged = appendsOne(
    previous.candidateForegroundSamplesMs,
    next.candidateForegroundSamplesMs,
  );
  const controlChanged = appendsOne(
    previous.controlForegroundSamplesMs,
    next.controlForegroundSamplesMs,
  );
  const backgroundChanged = appendsOne(
    previous.backgroundVerificationSamplesMs,
    next.backgroundVerificationSamplesMs,
  );
  const candidateUnchanged = arraysEqual(
    previous.candidateForegroundSamplesMs,
    next.candidateForegroundSamplesMs,
  );
  const controlUnchanged = arraysEqual(
    previous.controlForegroundSamplesMs,
    next.controlForegroundSamplesMs,
  );
  const backgroundUnchanged = arraysEqual(
    previous.backgroundVerificationSamplesMs,
    next.backgroundVerificationSamplesMs,
  );
  const concurrentUnchanged =
    next.concurrentForegroundMs === previous.concurrentForegroundMs;

  if (sampleId.startsWith("candidate:measured:")) {
    return (
      candidateChanged &&
      backgroundChanged &&
      controlUnchanged &&
      concurrentUnchanged
    );
  }
  if (sampleId.startsWith("control:measured:")) {
    return (
      candidateUnchanged &&
      backgroundUnchanged &&
      controlChanged &&
      concurrentUnchanged
    );
  }
  if (sampleId === "concurrent:0") {
    return (
      candidateUnchanged &&
      backgroundUnchanged &&
      controlUnchanged &&
      previous.concurrentForegroundMs === Number.MAX_VALUE &&
      next.concurrentForegroundMs < Number.MAX_VALUE
    );
  }
  return (
    candidateUnchanged &&
    backgroundUnchanged &&
    controlUnchanged &&
    concurrentUnchanged
  );
}

function artifactMatchesProgress(
  artifact: BenchmarkArtifact,
  progress: BenchmarkPartialProgress,
): boolean {
  return (
    artifact.startingDatabaseHash === progress.startingDatabaseHash &&
    JSON.stringify(artifact.rawSamplesMs.candidateForeground) ===
      JSON.stringify(progress.candidateForegroundSamplesMs) &&
    JSON.stringify(artifact.rawSamplesMs.controlForeground) ===
      JSON.stringify(progress.controlForegroundSamplesMs) &&
    JSON.stringify(artifact.rawSamplesMs.backgroundVerification) ===
      JSON.stringify(progress.backgroundVerificationSamplesMs) &&
    artifact.metricsMs.concurrentForeground === progress.concurrentForegroundMs &&
    artifact.foregroundFullGraphCaptures ===
      progress.foregroundFullGraphCaptures
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

async function forceTerminateWorker(
  worker: BenchmarkWorker,
  currentPlatform: NodeJS.Platform,
): Promise<void> {
  const pid = worker.pid;
  if (pid === undefined) return;
  if (currentPlatform !== "win32") {
    worker.kill("SIGKILL");
    return;
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: BENCHMARK_FORCE_KILL_TIMEOUT_MS },
      (error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      },
    );
  });
}

function waitForOperationWithTimeout<T>(
  operation: Promise<T>,
  scheduler: TimeoutScheduler,
  timeoutMs: number,
  description: string,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const handle = scheduler.setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(new Error(`${description} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        scheduler.clearTimeout(handle);
        resolvePromise(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        scheduler.clearTimeout(handle);
        rejectPromise(error);
      },
    );
  });
}

function waitForCloseOrTimeout(
  closePromise: Promise<void>,
  scheduler: TimeoutScheduler,
  delayMs: number,
): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    let settled = false;
    let handle: unknown;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (handle !== undefined) scheduler.clearTimeout(handle);
      resolvePromise();
    };
    handle = scheduler.setTimeout(finish, delayMs);
    closePromise.then(finish);
  });
}

async function waitForProcessDeath(
  pid: number,
  alive: (processId: number) => boolean,
  closePromise: Promise<void>,
  scheduler: TimeoutScheduler,
  pollMs: number,
  timeoutMs: number,
): Promise<void> {
  let waitedMs = 0;
  while (alive(pid)) {
    if (waitedMs >= timeoutMs) {
      throw new Error(`Worker process ${pid} remained alive after force termination`);
    }
    const delayMs = Math.min(pollMs, timeoutMs - waitedMs);
    await waitForCloseOrTimeout(closePromise, scheduler, delayMs);
    waitedMs += delayMs;
  }
}

function addWorkerExitFailure(artifact: BenchmarkArtifact): BenchmarkArtifact {
  return {
    ...artifact,
    checks: [
      ...artifact.checks,
      check("worker process failures", 1, "=", 0),
    ],
    passed: false,
  };
}

export async function superviseBenchmarkWorker(
  options: BenchmarkSupervisorOptions,
): Promise<BenchmarkSupervisorResult> {
  const scheduler = options.scheduler ?? nativeTimeoutScheduler;
  const terminationGraceMs =
    options.terminationGraceMs ?? BENCHMARK_TERMINATION_GRACE_MS;
  const forceKillTimeoutMs =
    options.forceKillTimeoutMs ?? BENCHMARK_FORCE_KILL_TIMEOUT_MS;
  const deathPollMs = options.deathPollMs ?? BENCHMARK_DEATH_POLL_MS;
  const currentPlatform = options.platform ?? platform();
  const alive = options.isProcessAlive ?? isProcessAlive;
  const forceTerminate = options.forceTerminate ?? forceTerminateWorker;
  return new Promise<BenchmarkSupervisorResult>((resolvePromise, rejectPromise) => {
    let activeSampleId: string | undefined;
    let nextSampleIndex = 0;
    let completedArtifact: BenchmarkArtifact | undefined;
    let progress = emptyBenchmarkProgress();
    let watchdog: unknown;
    let timedOut = false;
    let workerFailed = false;
    let ignoreMessages = false;
    let settled = false;
    let failureStarted = false;
    let closeCode: number | null = null;
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolvePromise) => {
      resolveClose = resolvePromise;
    });

    const clearWatchdog = () => {
      if (watchdog !== undefined) {
        scheduler.clearTimeout(watchdog);
        watchdog = undefined;
      }
    };
    const rejectSupervisor = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      rejectPromise(error);
    };

    const finish = () => {
      if (settled) return;
      const pid = options.worker.pid;
      if (pid !== undefined && alive(pid)) {
        rejectSupervisor(
          new Error(`Worker process ${pid} was not confirmed dead before finalization`),
        );
        return;
      }
      settled = true;
      clearWatchdog();
      try {
        let artifact: BenchmarkArtifact;
        if (!timedOut && !workerFailed && closeCode === 0 && completedArtifact) {
          artifact = completedArtifact;
        } else {
          artifact = options.createFailureArtifact(
            timedOut ? 1 : 0,
            copyBenchmarkProgress(progress),
          );
          if (!timedOut) artifact = addWorkerExitFailure(artifact);
        }
        options.cleanupWorkRoot?.();
        options.writeArtifact(artifact);
        resolvePromise({ artifact, timedOut });
      } catch (error) {
        rejectPromise(error);
      }
    };

    const terminateWorker = async (timeout: boolean) => {
      if (failureStarted || settled) return;
      failureStarted = true;
      timedOut = timeout;
      workerFailed = !timeout;
      ignoreMessages = true;
      clearWatchdog();
      const pid = options.worker.pid;
      if (pid === undefined) {
        finish();
        return;
      }
      try {
        try {
          options.worker.kill("SIGTERM");
        } catch {
          // Force termination below remains authoritative.
        }
        await waitForCloseOrTimeout(closePromise, scheduler, terminationGraceMs);
        if (alive(pid)) {
          try {
            await waitForOperationWithTimeout(
              forceTerminate(options.worker, currentPlatform),
              scheduler,
              forceKillTimeoutMs,
              "Force termination command",
            );
          } catch (error) {
            if (alive(pid)) throw error;
          }
          await waitForProcessDeath(
            pid,
            alive,
            closePromise,
            scheduler,
            deathPollMs,
            forceKillTimeoutMs,
          );
        }
        finish();
      } catch (error) {
        rejectSupervisor(error);
      }
    };

    options.worker.on("message", (message: unknown) => {
      if (ignoreMessages || settled) return;
      const parsed = parseWorkerMessage(message);
      if (!parsed) {
        void terminateWorker(false);
        return;
      }
      if (parsed.type === "metadata") {
        if (
          progress.startingDatabaseHash !== "unavailable" ||
          activeSampleId !== undefined ||
          completedArtifact !== undefined
        ) {
          void terminateWorker(false);
          return;
        }
        progress = {
          ...progress,
          startingDatabaseHash: parsed.startingDatabaseHash,
        };
        return;
      }
      if (parsed.type === "sample-start") {
        if (
          progress.startingDatabaseHash === "unavailable" ||
          activeSampleId !== undefined ||
          completedArtifact !== undefined ||
          parsed.sampleId !== BENCHMARK_SAMPLE_SEQUENCE[nextSampleIndex]
        ) {
          void terminateWorker(false);
          return;
        }
        activeSampleId = parsed.sampleId;
        watchdog = scheduler.setTimeout(() => {
          void terminateWorker(true);
        }, options.timeoutMs);
        return;
      }
      if (parsed.type === "capture") {
        if (
          activeSampleId === undefined ||
          parsed.count !== progress.foregroundFullGraphCaptures + 1
        ) {
          void terminateWorker(false);
          return;
        }
        progress = { ...progress, foregroundFullGraphCaptures: parsed.count };
        return;
      }
      if (parsed.type === "sample-end") {
        if (
          activeSampleId !== parsed.sampleId ||
          !progressMatchesSampleEnd(parsed.sampleId, progress, parsed.progress)
        ) {
          void terminateWorker(false);
          return;
        }
        clearWatchdog();
        activeSampleId = undefined;
        progress = copyBenchmarkProgress(parsed.progress);
        nextSampleIndex += 1;
        return;
      }
      if (parsed.type === "error") {
        void terminateWorker(false);
        return;
      }
      if (
        activeSampleId !== undefined ||
        completedArtifact !== undefined ||
        nextSampleIndex !== BENCHMARK_SAMPLE_SEQUENCE.length ||
        progress.startingDatabaseHash === "unavailable" ||
        !artifactMatchesProgress(parsed.artifact, progress)
      ) {
        void terminateWorker(false);
        return;
      }
      completedArtifact = parsed.artifact;
    });

    options.worker.on("error", () => {
      void terminateWorker(false);
    });

    options.worker.on(
      "close",
      (code: number | null, _signal: NodeJS.Signals | null) => {
        closeCode = code;
        resolveClose();
        if (!failureStarted) finish();
      },
    );
  });
}

export async function runSynchronousControl<TCommit>(operations: {
  captureTrustedBaseline(): Promise<void>;
  applyWithoutNotification(): Promise<TCommit>;
  captureCompare(commit: TCommit): Promise<string>;
  publish(commit: TCommit, digest: string): Promise<void>;
}): Promise<TCommit> {
  await operations.captureTrustedBaseline();
  const commit = await operations.applyWithoutNotification();
  const digest = await operations.captureCompare(commit);
  await operations.publish(commit, digest);
  return commit;
}

export function buildBenchmarkArtifact(input: BenchmarkArtifactInput) {
  const candidateP50 = percentileOrFailureValue(
    input.candidateForegroundSamplesMs,
    0.5,
  );
  const candidateP95 = percentileOrFailureValue(
    input.candidateForegroundSamplesMs,
    0.95,
  );
  const controlP50 = percentileOrFailureValue(
    input.controlForegroundSamplesMs,
    0.5,
  );
  const controlP95 = percentileOrFailureValue(
    input.controlForegroundSamplesMs,
    0.95,
  );
  const backgroundP50 = percentileOrFailureValue(
    input.backgroundVerificationSamplesMs,
    0.5,
  );
  const backgroundP95 = percentileOrFailureValue(
    input.backgroundVerificationSamplesMs,
    0.95,
  );
  const checks = evaluateBenchmarkChecks({
    candidateForegroundP50Ms: candidateP50,
    candidateForegroundP95Ms: candidateP95,
    controlForegroundP50Ms: controlP50,
    concurrentForegroundMs: input.concurrentForegroundMs,
    backgroundVerificationP95Ms: backgroundP95,
    timeoutCount: input.timeoutCount,
    foregroundFullGraphCaptures: input.foregroundFullGraphCaptures,
    candidateMeasuredSamples: input.candidateForegroundSamplesMs.length,
    controlMeasuredSamples: input.controlForegroundSamplesMs.length,
  });
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    commitSha: input.commitSha,
    os: input.os,
    cpu: input.cpu,
    node: input.node,
    ladybugDb: input.ladybugDb,
    addonMode: input.addonMode,
    fixtureSeed: FIXTURE_SEED,
    fixtureHash: input.fixtureHash,
    editSequenceHash: input.editSequenceHash,
    startingDatabaseHash: input.startingDatabaseHash,
    cacheMode: input.cacheMode,
    warmupCount: BENCHMARK_WARMUP_COUNT,
    sampleCount: BENCHMARK_SAMPLE_COUNT,
    timeoutMs: BENCHMARK_TIMEOUT_MS,
    rawSamplesMs: {
      candidateForeground: input.candidateForegroundSamplesMs,
      controlForeground: input.controlForegroundSamplesMs,
      backgroundVerification: input.backgroundVerificationSamplesMs,
    },
    metricsMs: {
      candidateForeground: { p50: candidateP50, p95: candidateP95 },
      controlForeground: { p50: controlP50, p95: controlP95 },
      backgroundVerification: { p50: backgroundP50, p95: backgroundP95 },
      concurrentForeground: input.concurrentForegroundMs,
    },
    timeoutCount: input.timeoutCount,
    thresholds: DEFAULT_THRESHOLDS,
    foregroundFullGraphCaptures: input.foregroundFullGraphCaptures,
    checks,
    passed: checks.every((item) => item.passed),
  };
}

function percentileOrFailureValue(
  samples: readonly number[],
  percentile: number,
): number {
  return samples.length === 0
    ? Number.MAX_VALUE
    : nearestRankPercentile(samples, percentile);
}

interface LaneResult {
  foregroundSamplesMs: number[];
  backgroundSamplesMs: number[];
  concurrentForegroundMs: number;
  foregroundFullGraphCaptures: number;
}

interface PatchCommit {
  revision: number;
  versionId: string;
}

async function runCandidateLane(
  repoId: string,
  serialEdits: readonly BenchmarkEdit[],
  concurrentEdits: readonly BenchmarkEdit[],
  reporter: BenchmarkSampleReporter,
): Promise<LaneResult> {
  const foregroundSamplesMs: number[] = [];
  const backgroundSamplesMs: number[] = [];
  let foregroundFullGraphCaptures = 0;

  for (const [index, edit] of serialEdits.entries()) {
    const sampleId = BENCHMARK_SAMPLE_SEQUENCE[index]!;
    await reporter.start(sampleId);
    const sample = await runCandidateSample(repoId, edit, () => {
      foregroundFullGraphCaptures += 1;
      reporter.capture(foregroundFullGraphCaptures);
    });
    const update: BenchmarkSampleUpdate = { foregroundFullGraphCaptures };
    if (index >= BENCHMARK_WARMUP_COUNT) {
      foregroundSamplesMs.push(sample.foregroundMs);
      backgroundSamplesMs.push(sample.backgroundMs);
      update.candidateForegroundMs = sample.foregroundMs;
      update.backgroundVerificationMs = sample.backgroundMs;
    }
    await reporter.end(sampleId, update);
  }

  let concurrentForegroundMs = Number.MAX_VALUE;
  const [firstEdit, secondEdit] = concurrentEdits;
  if (!firstEdit || !secondEdit) throw new Error("Concurrent edits are missing");
  const sampleId = BENCHMARK_SAMPLE_SEQUENCE[CONCURRENT_SAMPLE_INDEX]!;
  await reporter.start(sampleId);
  let firstRevision: number | undefined;
  await patchSavedFile(
    { repoId, filePath: firstEdit.relPath, ...firstEdit },
    {
      onCommitted(revision) {
        firstRevision = revision;
      },
      onForegroundFullGraphCapture() {
        foregroundFullGraphCaptures += 1;
        reporter.capture(foregroundFullGraphCaptures);
      },
    },
  );
  const firstState = await getDerivedState(repoId);
  if (
    firstRevision === undefined ||
    firstState?.graphIntegrityRevision !== firstRevision ||
    firstState.graphIntegrityState !== "verifying"
  ) {
    throw new Error(
      "The first concurrent edit was not still verifying before the second edit",
    );
  }
  let secondRevision: number | undefined;
  const secondStart = performance.now();
  await patchSavedFile(
    { repoId, filePath: secondEdit.relPath, ...secondEdit },
    {
      onCommitted(revision) {
        secondRevision = revision;
      },
      onForegroundFullGraphCapture() {
        foregroundFullGraphCaptures += 1;
        reporter.capture(foregroundFullGraphCaptures);
      },
    },
  );
  concurrentForegroundMs = performance.now() - secondStart;
  if (secondRevision === undefined) {
    throw new Error("Concurrent candidate edit did not publish a revision");
  }
  await waitForExactVerifiedRevision(repoId, secondRevision);
  await reporter.end(sampleId, {
    concurrentForegroundMs,
    foregroundFullGraphCaptures,
  });

  await cancelAndWaitForAllGraphIntegrityVerifiers();
  return {
    foregroundSamplesMs,
    backgroundSamplesMs,
    concurrentForegroundMs,
    foregroundFullGraphCaptures,
  };
}

async function runCandidateSample(
  repoId: string,
  edit: BenchmarkEdit,
  onCapture: () => void,
): Promise<{ foregroundMs: number; backgroundMs: number }> {
  let revision: number | undefined;
  let committedAt: number | undefined;
  const startedAt = performance.now();
  await patchSavedFile(
    { repoId, filePath: edit.relPath, ...edit },
    {
      onCommitted(committedRevision) {
        revision = committedRevision;
        committedAt = performance.now();
      },
      onForegroundFullGraphCapture: onCapture,
    },
  );
  const foregroundMs = performance.now() - startedAt;
  if (revision === undefined || committedAt === undefined) {
    throw new Error(`Candidate edit did not publish a revision for ${edit.relPath}`);
  }
  const verifiedAt = await waitForExactVerifiedRevision(repoId, revision);
  return { foregroundMs, backgroundMs: verifiedAt - committedAt };
}

async function waitForExactVerifiedRevision(
  repoId: string,
  revision: number,
): Promise<number> {
  while (true) {
    const state = await getDerivedState(repoId);
    if (!state || state.graphIntegrityState === "unknown") {
      throw new Error(`Graph integrity became unknown while waiting for revision ${revision}`);
    }
    if ((state.graphIntegrityRevision ?? -1) > revision) {
      throw new Error(`Revision ${revision} was superseded before exact verification`);
    }
    if (
      state.graphIntegrityRevision === revision &&
      state.graphIntegrityState === "failed"
    ) {
      throw new Error(`Graph integrity verification failed for revision ${revision}`);
    }
    if (
      state.graphIntegrityRevision === revision &&
      state.graphIntegrityVerifiedRevision === revision &&
      state.graphIntegrityState === "verified"
    ) {
      return performance.now();
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

async function runControlLane(
  repoId: string,
  serialEdits: readonly BenchmarkEdit[],
  reporter: BenchmarkSampleReporter,
): Promise<{ foregroundSamplesMs: number[] }> {
  const foregroundSamplesMs: number[] = [];
  const observer: SavedFilePatchObserver = {
    onCommitted() {},
    onForegroundFullGraphCapture() {},
  };

  for (const [index, edit] of serialEdits.entries()) {
    const sampleId = BENCHMARK_SAMPLE_SEQUENCE[CONTROL_SAMPLE_OFFSET + index]!;
    await reporter.start(sampleId);
    const startedAt = performance.now();
    await runControlSample(repoId, edit, observer);
    const update: BenchmarkSampleUpdate = {};
    if (index >= BENCHMARK_WARMUP_COUNT) {
      const foregroundMs = performance.now() - startedAt;
      foregroundSamplesMs.push(foregroundMs);
      update.controlForegroundMs = foregroundMs;
    }
    await reporter.end(sampleId, update);
  }
  return { foregroundSamplesMs };
}

async function runControlSample(
  repoId: string,
  edit: BenchmarkEdit,
  observer: SavedFilePatchObserver,
): Promise<void> {
  let baselineVersionId = "";
  await runSynchronousControl<PatchCommit>({
    async captureTrustedBaseline() {
      const state = await getDerivedState(repoId);
      if (
        !state ||
        state.graphIntegrityState !== "verified" ||
        state.graphIntegrityRevision !== state.graphIntegrityVerifiedRevision ||
        !state.graphIntegrityVersionId ||
        !state.graphIntegrityDigest
      ) {
        throw new Error("Synchronous control baseline is not verified");
      }
      baselineVersionId = state.graphIntegrityVersionId;
      const actual = await captureForegroundPersistedGraphIntegrity(
        observer,
        await getLadybugConn(),
        repoId,
      );
      if (actual.digest !== state.graphIntegrityDigest) {
        throw new Error("Synchronous control baseline digest mismatch");
      }
    },
    async applyWithoutNotification() {
      let revision: number | undefined;
      await withGraphIntegrityVerifierQuiesced(repoId, () =>
        patchSavedFile(
          { repoId, filePath: edit.relPath, ...edit },
          {
            ...observer,
            onCommitted(committedRevision) {
              revision = committedRevision;
            },
          },
        ),
      );
      if (revision === undefined) {
        throw new Error("Synchronous control edit did not publish a revision");
      }
      return { revision, versionId: baselineVersionId };
    },
    async captureCompare() {
      const conn = await getLadybugConn();
      const files = await ladybugDb.listGraphIntegrityFileStates(conn, repoId);
      const fileless = await ladybugDb.listGraphIntegrityFilelessStates(
        conn,
        repoId,
      );
      const actual = await captureForegroundPersistedGraphIntegrity(
        observer,
        conn,
        repoId,
      );
      const expected = createGraphIntegrityExpectationFromManifest(files, fileless);
      const mismatch = compareGraphIntegrityExpectations(expected, actual);
      if (mismatch) {
        throw new Error(`Synchronous control mismatch: ${JSON.stringify(mismatch)}`);
      }
      return actual.digest;
    },
    async publish(commit, digest) {
      if (
        !(await markGraphIntegrityVerifiedIfVerifying(
          repoId,
          commit.versionId,
          commit.revision,
          digest,
        ))
      ) {
        throw new Error(`Synchronous control lost revision ${commit.revision}`);
      }
    },
  });
}

async function seedBaseDatabase(
  workRoot: string,
  repoRoot: string,
  configPath: string,
  dbPath: string,
  fixture: BenchmarkFixture,
  repoId: string,
): Promise<void> {
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  for (const file of fixture.files) {
    writeFileSync(join(repoRoot, file.relPath), file.content, "utf8");
  }
  writeFileSync(
    configPath,
    `${JSON.stringify({
      repos: [],
      policy: {},
      indexing: {
        pipeline: "legacy",
        engine: "typescript",
        enableFileWatching: false,
      },
      semantic: { enabled: false, generateSummaries: false },
      scip: { enabled: false },
    })}\n`,
    "utf8",
  );
  process.env.SDL_CONFIG = configPath;
  delete process.env.SDL_CONFIG_PATH;
  process.env.SDL_GRAPH_DB_PATH = dbPath;
  delete process.env.SDL_GRAPH_DB_DIR;
  delete process.env.SDL_DB_PATH;
  invalidateConfigCache();

  await initLadybugDb(dbPath);
  await withWriteConn((conn) =>
    ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: repoRoot,
      configJson: JSON.stringify({
        repoId,
        rootPath: repoRoot,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
      }),
      createdAt: "2026-07-21T00:00:00.000Z",
    }),
  );
  const indexed = await indexRepo(repoId, "full");
  if (
    indexed.filesProcessed !== FIXTURE_FILE_COUNT ||
    indexed.symbolsIndexed < FIXTURE_FILE_COUNT * FIXTURE_SYMBOLS_PER_FILE
  ) {
    throw new Error(
      `Fixture index is incomplete: ${indexed.filesProcessed} files, ${indexed.symbolsIndexed} symbols`,
    );
  }
  const state = await getDerivedState(repoId);
  if (
    state?.graphIntegrityState !== "verified" ||
    state.graphIntegrityRevision !== 0 ||
    state.graphIntegrityVerifiedRevision !== 0
  ) {
    throw new Error("Fixture index did not publish verified revision zero");
  }
  await closeLadybugDb();
  if (!existsSync(dbPath)) {
    throw new Error(`Fixture database was not created under ${workRoot}`);
  }
}

function copyDatabase(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: statSync(source).isDirectory(),
    errorOnExist: true,
  });
}

function hashPath(root: string): string {
  const hash = createHash("sha256");
  const visit = (path: string): void => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  };
  visit(root);
  return hash.digest("hex");
}

async function openDatabase(path: string): Promise<void> {
  process.env.SDL_GRAPH_DB_PATH = path;
  await initLadybugDb(path);
}

function parseOutPath(argv: readonly string[]): string {
  const index = argv.indexOf("--out");
  if (index < 0 || !argv[index + 1]) {
    throw new Error(
      "Usage: npm run benchmark:background-graph-integrity -- --out .benchmark/background-graph-integrity/<artifact>.json",
    );
  }
  if (argv.length !== 2) throw new Error(`Unknown benchmark arguments: ${argv.join(" ")}`);
  const output = resolve(argv[index + 1]!);
  const artifactRoot = resolve(".benchmark", "background-graph-integrity");
  const rel = relative(artifactRoot, output);
  if (rel.startsWith("..") || resolve(artifactRoot, rel) !== output) {
    throw new Error("--out must be under .benchmark/background-graph-integrity");
  }
  return output;
}

function parseWorkerArgs(argv: readonly string[]): {
  outputPath: string;
  workRoot: string;
} {
  const workRootIndex = argv.indexOf("--work-root");
  if (workRootIndex < 0 || !argv[workRootIndex + 1] || argv.length !== 4) {
    throw new Error("Benchmark worker requires --out and --work-root");
  }
  const outIndex = argv.indexOf("--out");
  if (outIndex < 0 || !argv[outIndex + 1]) {
    throw new Error("Benchmark worker requires --out and --work-root");
  }
  return {
    outputPath: parseOutPath(["--out", argv[outIndex + 1]]),
    workRoot: validateBenchmarkWorkRoot(argv[workRootIndex + 1]),
  };
}

function getBenchmarkMetadata(fixture: BenchmarkFixture) {
  return {
    commitSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim(),
    os: platform(),
    cpu: cpus()[0]?.model ?? null,
    node: process.version,
    ladybugDb: JSON.parse(
      readFileSync(resolve("node_modules", "kuzu", "package.json"), "utf8"),
    ).version as string,
    addonMode:
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON === "1"
        ? ("disabled" as const)
        : ("enabled" as const),
    fixtureHash: fixture.fixtureHash,
    editSequenceHash: fixture.editSequenceHash,
  };
}

function buildArtifactFromProgress(
  metadata: ReturnType<typeof getBenchmarkMetadata>,
  progress: BenchmarkPartialProgress,
  timeoutCount: number,
): BenchmarkArtifact {
  return buildBenchmarkArtifact({
    ...metadata,
    startingDatabaseHash: progress.startingDatabaseHash,
    cacheMode: "warm-serial",
    candidateForegroundSamplesMs: progress.candidateForegroundSamplesMs,
    controlForegroundSamplesMs: progress.controlForegroundSamplesMs,
    backgroundVerificationSamplesMs:
      progress.backgroundVerificationSamplesMs,
    concurrentForegroundMs: progress.concurrentForegroundMs,
    timeoutCount,
    foregroundFullGraphCaptures: progress.foregroundFullGraphCaptures,
  });
}

async function sendWorkerMessage(message: BenchmarkWorkerMessage): Promise<void> {
  if (!process.send) {
    throw new Error("Benchmark worker requires an IPC channel");
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    process.send!(message, (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

function sendWorkerMessageNow(message: BenchmarkWorkerMessage): void {
  if (!process.send) {
    throw new Error("Benchmark worker requires an IPC channel");
  }
  process.send(message);
}

export function createWorkerReporter(
  progress: BenchmarkPartialProgress,
  send: (message: BenchmarkWorkerMessage) => Promise<void> = sendWorkerMessage,
  sendNow: (message: BenchmarkWorkerMessage) => void = sendWorkerMessageNow,
): BenchmarkSampleReporter {
  return {
    async start(sampleId) {
      // IPC is outside the timed measurement; the parent watchdog covers the
      // complete DB operation and its exact-revision verification wait.
      await send({ type: "sample-start", sampleId });
    },
    capture(count) {
      progress.foregroundFullGraphCaptures = count;
      sendNow({ type: "capture", count });
    },
    async end(sampleId, update) {
      if (update.candidateForegroundMs !== undefined) {
        progress.candidateForegroundSamplesMs.push(update.candidateForegroundMs);
      }
      if (update.controlForegroundMs !== undefined) {
        progress.controlForegroundSamplesMs.push(update.controlForegroundMs);
      }
      if (update.backgroundVerificationMs !== undefined) {
        progress.backgroundVerificationSamplesMs.push(
          update.backgroundVerificationMs,
        );
      }
      if (update.concurrentForegroundMs !== undefined) {
        progress.concurrentForegroundMs = update.concurrentForegroundMs;
      }
      if (update.foregroundFullGraphCaptures !== undefined) {
        progress.foregroundFullGraphCaptures =
          update.foregroundFullGraphCaptures;
      }
      await send({
        type: "sample-end",
        sampleId,
        progress: copyBenchmarkProgress(progress),
      });
    },
  };
}

async function runBenchmarkWorker(workRoot: string): Promise<BenchmarkArtifact> {
  const fixture = createBenchmarkFixture();
  const metadata = getBenchmarkMetadata(fixture);
  const progress = emptyBenchmarkProgress();
  const reporter = createWorkerReporter(progress);
  const lanes = createBenchmarkLaneInputs(fixture);
  if (
    sha256(JSON.stringify(lanes.candidate.files)) !==
      sha256(JSON.stringify(lanes.control.files)) ||
    sha256(JSON.stringify(lanes.candidate.edits)) !==
      sha256(JSON.stringify(lanes.control.edits))
  ) {
    throw new Error("Candidate and control inputs are not byte-identical");
  }
  validateBenchmarkWorkRoot(workRoot);
  const repoRoot = join(workRoot, "repo");
  const configPath = join(workRoot, "sdlmcp.config.json");
  const baseDb = join(workRoot, "base.lbug");
  const candidateDb = join(workRoot, "candidate.lbug");
  const controlDb = join(workRoot, "control.lbug");
  const repoId = "background-integrity-benchmark";
  const previousEnv = {
    config: process.env.SDL_CONFIG,
    configPath: process.env.SDL_CONFIG_PATH,
    graphDbPath: process.env.SDL_GRAPH_DB_PATH,
    graphDbDir: process.env.SDL_GRAPH_DB_DIR,
    dbPath: process.env.SDL_DB_PATH,
  };

  try {
    await seedBaseDatabase(
      workRoot,
      repoRoot,
      configPath,
      baseDb,
      fixture,
      repoId,
    );
    copyDatabase(baseDb, candidateDb);
    copyDatabase(baseDb, controlDb);
    const candidateStartHash = hashPath(candidateDb);
    const controlStartHash = hashPath(controlDb);
    if (candidateStartHash !== controlStartHash) {
      throw new Error("Candidate and control database clones are not byte-identical");
    }
    progress.startingDatabaseHash = candidateStartHash;
    await sendWorkerMessage({
      type: "metadata",
      startingDatabaseHash: candidateStartHash,
    });

    await openDatabase(candidateDb);
    const candidate = await runCandidateLane(
      repoId,
      lanes.candidate.edits,
      fixture.concurrentEdits,
      reporter,
    );
    await closeLadybugDb();

    await openDatabase(controlDb);
    const control = await runControlLane(repoId, lanes.control.edits, reporter);
    await closeLadybugDb();

    return buildBenchmarkArtifact({
      ...metadata,
      startingDatabaseHash: candidateStartHash,
      cacheMode: "warm-serial",
      candidateForegroundSamplesMs: candidate.foregroundSamplesMs,
      controlForegroundSamplesMs: control.foregroundSamplesMs,
      backgroundVerificationSamplesMs: candidate.backgroundSamplesMs,
      concurrentForegroundMs: candidate.concurrentForegroundMs,
      timeoutCount: 0,
      foregroundFullGraphCaptures: candidate.foregroundFullGraphCaptures,
    });
  } finally {
    await cancelAndWaitForAllGraphIntegrityVerifiers().catch(() => {});
    await closeLadybugDb().catch(() => {});
    invalidateConfigCache();
    restoreEnv("SDL_CONFIG", previousEnv.config);
    restoreEnv("SDL_CONFIG_PATH", previousEnv.configPath);
    restoreEnv("SDL_GRAPH_DB_PATH", previousEnv.graphDbPath);
    restoreEnv("SDL_GRAPH_DB_DIR", previousEnv.graphDbDir);
    restoreEnv("SDL_DB_PATH", previousEnv.dbPath);
  }
}

function writeBenchmarkArtifact(
  outputPath: string,
  artifact: BenchmarkArtifact,
): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

function printBenchmarkResult(outputPath: string, artifact: BenchmarkArtifact): void {
  console.log(`${artifact.passed ? "PASS" : "FAIL"} ${outputPath}`);
  for (const item of artifact.checks) {
    console.log(
      `${item.passed ? "PASS" : "FAIL"} ${item.name}: ${item.actual} ${item.comparator} ${item.threshold}`,
    );
  }
}

async function runBenchmarkParent(outputPath: string): Promise<void> {
  const fixture = createBenchmarkFixture();
  const metadata = getBenchmarkMetadata(fixture);
  const workRoot = createBenchmarkWorkRoot();
  let worker: ReturnType<typeof spawn>;
  try {
    worker = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(import.meta.url),
        "--worker",
        "--out",
        outputPath,
        "--work-root",
        workRoot,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      },
    );
  } catch (error) {
    cleanupBenchmarkWorkRoot(workRoot);
    throw error;
  }
  const result = await superviseBenchmarkWorker({
    worker,
    timeoutMs: BENCHMARK_TIMEOUT_MS,
    createFailureArtifact: (timeoutCount, progress) =>
      buildArtifactFromProgress(metadata, progress, timeoutCount),
    cleanupWorkRoot: () => cleanupBenchmarkWorkRoot(workRoot),
    writeArtifact: (artifact) => writeBenchmarkArtifact(outputPath, artifact),
  });
  printBenchmarkResult(outputPath, result.artifact);
  if (!result.artifact.passed) process.exitCode = 1;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--worker") {
    const workerArgs = parseWorkerArgs(argv.slice(1));
    try {
      const artifact = await runBenchmarkWorker(workerArgs.workRoot);
      await sendWorkerMessage({ type: "complete", artifact });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(
        0,
        4_096,
      );
      await sendWorkerMessage({ type: "error", message }).catch(() => {});
      throw error;
    }
    return;
  }
  await runBenchmarkParent(parseOutPath(argv));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
