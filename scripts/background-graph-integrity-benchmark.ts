import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

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

interface BenchmarkArtifactInput {
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

interface TimeoutScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class BenchmarkTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Benchmark sample exceeded ${timeoutMs.toLocaleString("en-US")} ms`);
    this.timeoutMs = timeoutMs;
  }
}

const nativeTimeoutScheduler: TimeoutScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

export async function withHardTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  scheduler: TimeoutScheduler = nativeTimeoutScheduler,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const handle = scheduler.setTimeout(
      () => rejectPromise(new BenchmarkTimeoutError(timeoutMs)),
      timeoutMs,
    );
    operation.then(
      (value) => {
        scheduler.clearTimeout(handle);
        resolvePromise(value);
      },
      (error: unknown) => {
        scheduler.clearTimeout(handle);
        rejectPromise(error);
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
  timeoutCount: number;
}

interface PatchCommit {
  revision: number;
  versionId: string;
}

async function runCandidateLane(
  repoId: string,
  serialEdits: readonly BenchmarkEdit[],
  concurrentEdits: readonly BenchmarkEdit[],
): Promise<LaneResult> {
  const foregroundSamplesMs: number[] = [];
  const backgroundSamplesMs: number[] = [];
  let foregroundFullGraphCaptures = 0;
  let timeoutCount = 0;

  for (const [index, edit] of serialEdits.entries()) {
    try {
      const sample = await withHardTimeout(
        runCandidateSample(repoId, edit, () => {
          foregroundFullGraphCaptures += 1;
        }),
        BENCHMARK_TIMEOUT_MS,
      );
      if (index >= BENCHMARK_WARMUP_COUNT) {
        foregroundSamplesMs.push(sample.foregroundMs);
        backgroundSamplesMs.push(sample.backgroundMs);
      }
    } catch (error) {
      if (error instanceof BenchmarkTimeoutError) timeoutCount += 1;
      else throw error;
      break;
    }
  }

  let concurrentForegroundMs = Number.MAX_VALUE;
  if (timeoutCount === 0) {
    try {
      const [firstEdit, secondEdit] = concurrentEdits;
      if (!firstEdit || !secondEdit) throw new Error("Concurrent edits are missing");
      let firstRevision: number | undefined;
      await patchSavedFile(
        { repoId, filePath: firstEdit.relPath, ...firstEdit },
        {
          onCommitted(revision) {
            firstRevision = revision;
          },
          onForegroundFullGraphCapture() {
            foregroundFullGraphCaptures += 1;
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
      await withHardTimeout(
        patchSavedFile(
          { repoId, filePath: secondEdit.relPath, ...secondEdit },
          {
            onCommitted(revision) {
              secondRevision = revision;
            },
            onForegroundFullGraphCapture() {
              foregroundFullGraphCaptures += 1;
            },
          },
        ),
        BENCHMARK_TIMEOUT_MS,
      );
      concurrentForegroundMs = performance.now() - secondStart;
      if (secondRevision === undefined) {
        throw new Error("Concurrent candidate edit did not publish a revision");
      }
      await withHardTimeout(
        waitForExactVerifiedRevision(repoId, secondRevision),
        BENCHMARK_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof BenchmarkTimeoutError) timeoutCount += 1;
      else throw error;
    }
  }

  await cancelAndWaitForAllGraphIntegrityVerifiers();
  return {
    foregroundSamplesMs,
    backgroundSamplesMs,
    concurrentForegroundMs,
    foregroundFullGraphCaptures,
    timeoutCount,
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
): Promise<{ foregroundSamplesMs: number[]; timeoutCount: number }> {
  const foregroundSamplesMs: number[] = [];
  let timeoutCount = 0;
  const observer: SavedFilePatchObserver = {
    onCommitted() {},
    onForegroundFullGraphCapture() {},
  };

  for (const [index, edit] of serialEdits.entries()) {
    const startedAt = performance.now();
    try {
      await withHardTimeout(
        runControlSample(repoId, edit, observer),
        BENCHMARK_TIMEOUT_MS,
      );
      if (index >= BENCHMARK_WARMUP_COUNT) {
        foregroundSamplesMs.push(performance.now() - startedAt);
      }
    } catch (error) {
      if (error instanceof BenchmarkTimeoutError) timeoutCount += 1;
      else throw error;
      break;
    }
  }
  return { foregroundSamplesMs, timeoutCount };
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

async function runBenchmark(outputPath: string): Promise<void> {
  const fixture = createBenchmarkFixture();
  const lanes = createBenchmarkLaneInputs(fixture);
  if (
    sha256(JSON.stringify(lanes.candidate.files)) !==
      sha256(JSON.stringify(lanes.control.files)) ||
    sha256(JSON.stringify(lanes.candidate.edits)) !==
      sha256(JSON.stringify(lanes.control.edits))
  ) {
    throw new Error("Candidate and control inputs are not byte-identical");
  }
  const workRoot = mkdtempSync(join(tmpdir(), "sdl-bgi-"));
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

    await openDatabase(candidateDb);
    const candidate = await runCandidateLane(
      repoId,
      lanes.candidate.edits,
      fixture.concurrentEdits,
    );
    await closeLadybugDb();

    await openDatabase(controlDb);
    const control = await runControlLane(repoId, lanes.control.edits);
    await closeLadybugDb();

    const artifact = buildBenchmarkArtifact({
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
          ? "disabled"
          : "enabled",
      fixtureHash: fixture.fixtureHash,
      editSequenceHash: fixture.editSequenceHash,
      startingDatabaseHash: candidateStartHash,
      cacheMode: "warm-serial",
      candidateForegroundSamplesMs: candidate.foregroundSamplesMs,
      controlForegroundSamplesMs: control.foregroundSamplesMs,
      backgroundVerificationSamplesMs: candidate.backgroundSamplesMs,
      concurrentForegroundMs: candidate.concurrentForegroundMs,
      timeoutCount: candidate.timeoutCount + control.timeoutCount,
      foregroundFullGraphCaptures: candidate.foregroundFullGraphCaptures,
    });
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    console.log(`${artifact.passed ? "PASS" : "FAIL"} ${outputPath}`);
    for (const item of artifact.checks) {
      console.log(
        `${item.passed ? "PASS" : "FAIL"} ${item.name}: ${item.actual} ${item.comparator} ${item.threshold}`,
      );
    }
    if (!artifact.passed) process.exitCode = 1;
  } finally {
    await cancelAndWaitForAllGraphIntegrityVerifiers().catch(() => {});
    await closeLadybugDb().catch(() => {});
    invalidateConfigCache();
    restoreEnv("SDL_CONFIG", previousEnv.config);
    restoreEnv("SDL_CONFIG_PATH", previousEnv.configPath);
    restoreEnv("SDL_GRAPH_DB_PATH", previousEnv.graphDbPath);
    restoreEnv("SDL_GRAPH_DB_DIR", previousEnv.graphDbDir);
    restoreEnv("SDL_DB_PATH", previousEnv.dbPath);
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function main(): Promise<void> {
  await runBenchmark(parseOutPath(process.argv.slice(2)));
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
