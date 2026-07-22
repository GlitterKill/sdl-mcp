import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  BENCHMARK_SCHEMA_VERSION,
  BENCHMARK_TIMEOUT_MS,
  DEFAULT_THRESHOLDS,
  FIXTURE_FILE_COUNT,
  FIXTURE_SEED,
  FIXTURE_SYMBOLS_PER_FILE,
  buildBenchmarkArtifact,
  cleanupBenchmarkWorkRoot,
  createBenchmarkFixture,
  createBenchmarkLaneInputs,
  createBenchmarkWorkRoot,
  createWorkerReporter,
  evaluateBenchmarkChecks,
  nearestRankPercentile,
  runSynchronousControl,
  superviseBenchmarkWorker,
  validateBenchmarkWorkRoot,
  type BenchmarkPartialProgress,
  type BenchmarkWorkerMessage,
} from "../../scripts/background-graph-integrity-benchmark.ts";

type BenchmarkArtifact = ReturnType<typeof buildBenchmarkArtifact>;

class FakeBenchmarkWorker extends EventEmitter {
  readonly events: string[];
  alive: boolean;
  killed = false;
  readonly pid: number | undefined;

  constructor(events: string[], pid: number | null = 4242) {
    super();
    this.events = events;
    this.pid = pid ?? undefined;
    this.alive = pid !== null;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.events.push(signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    this.events.push("exit");
    this.emit("exit", code, signal);
    this.alive = false;
    this.events.push("close");
    this.emit("close", code, signal);
  }
}

class FakeWatchdogScheduler {
  private nextId = 1;
  readonly timers = new Map<number, { callback: () => void; delayMs: number }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  fire(delayMs?: number): void {
    const entry = [...this.timers.entries()].find(
      ([, timer]) => delayMs === undefined || timer.delayMs === delayMs,
    );
    assert.ok(entry, `No pending timer${delayMs === undefined ? "" : ` for ${delayMs} ms`}`);
    this.timers.delete(entry[0]);
    entry[1].callback();
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  get delays(): number[] {
    return [...this.timers.values()].map((timer) => timer.delayMs);
  }
}

const TERMINATION_GRACE_MS = 25;
const FORCE_KILL_TIMEOUT_MS = 50;
const DEATH_POLL_MS = 5;

function supervisorOptions(
  worker: FakeBenchmarkWorker,
  scheduler: FakeWatchdogScheduler,
  events: string[],
  writeArtifact: (artifact: BenchmarkArtifact) => void,
  overrides: Record<string, unknown> = {},
) {
  return {
    worker,
    timeoutMs: BENCHMARK_TIMEOUT_MS,
    terminationGraceMs: TERMINATION_GRACE_MS,
    forceKillTimeoutMs: FORCE_KILL_TIMEOUT_MS,
    deathPollMs: DEATH_POLL_MS,
    scheduler,
    platform: "linux" as NodeJS.Platform,
    isProcessAlive: () => worker.alive,
    async forceTerminate() {
      events.push("force");
      worker.close(null, "SIGKILL");
    },
    cleanupWorkRoot() {
      events.push("cleanup");
    },
    createFailureArtifact,
    writeArtifact,
    ...overrides,
  };
}

async function nextTurn<T>(promise: Promise<T>): Promise<T | "pending"> {
  return Promise.race([
    promise,
    new Promise<"pending">((resolvePromise) =>
      setImmediate(() => resolvePromise("pending")),
    ),
  ]);
}

function createArtifact(overrides: Partial<Parameters<typeof buildBenchmarkArtifact>[0]> = {}) {
  return buildBenchmarkArtifact({
    commitSha: "0".repeat(40),
    os: "win32",
    cpu: "test cpu",
    node: "v24.0.0",
    ladybugDb: "0.18.1",
    addonMode: "disabled",
    fixtureHash: "a".repeat(64),
    editSequenceHash: "b".repeat(64),
    startingDatabaseHash: "c".repeat(64),
    cacheMode: "warm-serial",
    candidateForegroundSamplesMs: Array(20).fill(100),
    controlForegroundSamplesMs: Array(20).fill(1_000),
    backgroundVerificationSamplesMs: Array(20).fill(300),
    concurrentForegroundMs: 120,
    timeoutCount: 0,
    foregroundFullGraphCaptures: 0,
    ...overrides,
  });
}

function createProgress(
  overrides: Partial<BenchmarkPartialProgress> = {},
): BenchmarkPartialProgress {
  return {
    startingDatabaseHash: "c".repeat(64),
    candidateForegroundSamplesMs: [],
    controlForegroundSamplesMs: [],
    backgroundVerificationSamplesMs: [],
    concurrentForegroundMs: Number.MAX_VALUE,
    foregroundFullGraphCaptures: 0,
    ...overrides,
  };
}

function createFailureArtifact(
  timeoutCount: number,
  progress = createProgress(),
): BenchmarkArtifact {
  return createArtifact({
    startingDatabaseHash: progress.startingDatabaseHash,
    candidateForegroundSamplesMs: progress.candidateForegroundSamplesMs,
    controlForegroundSamplesMs: progress.controlForegroundSamplesMs,
    backgroundVerificationSamplesMs: progress.backgroundVerificationSamplesMs,
    concurrentForegroundMs: progress.concurrentForegroundMs,
    timeoutCount,
    foregroundFullGraphCaptures: progress.foregroundFullGraphCaptures,
  });
}

describe("background graph integrity benchmark contract", () => {
  it("generates the stable 1,500 by 20 fixture and edit sequence", () => {
    const fixture = createBenchmarkFixture();

    assert.equal(fixture.seed, FIXTURE_SEED);
    assert.equal(fixture.files.length, FIXTURE_FILE_COUNT);
    assert.equal(FIXTURE_FILE_COUNT, 1_500);
    assert.equal(FIXTURE_SYMBOLS_PER_FILE, 20);
    for (const file of fixture.files) {
      assert.equal(
        file.content.match(/^export function /gm)?.length,
        FIXTURE_SYMBOLS_PER_FILE,
      );
      assert.match(file.content, /crossFilePlaceholder_\d{4}\(\)/);
    }
    assert.equal(fixture.warmupEdits.length, 3);
    assert.equal(fixture.measuredEdits.length, 20);
    assert.equal(fixture.concurrentEdits.length, 2);
    assert.equal(
      fixture.fixtureHash,
      "b5aff09bec455bfcde38190ebbe2c1a3652e919ce54de4cdbed157d9d314566c",
    );
    assert.equal(
      fixture.editSequenceHash,
      "f8a3ceed9465077afdc5e3ffa7b443f51f30a65bc5ede2d170275bd15be41873",
    );
  });

  it("gives candidate and control byte-identical fixture and serial edits", () => {
    const lanes = createBenchmarkLaneInputs(createBenchmarkFixture());

    assert.notStrictEqual(lanes.candidate.files, lanes.control.files);
    assert.equal(
      JSON.stringify(lanes.candidate.files),
      JSON.stringify(lanes.control.files),
    );
    assert.equal(
      JSON.stringify(lanes.candidate.edits),
      JSON.stringify(lanes.control.edits),
    );
  });

  it("uses nearest-rank percentiles", () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    assert.equal(nearestRankPercentile(samples, 0.5), 10);
    assert.equal(nearestRankPercentile(samples, 0.95), 19);
    assert.throws(() => nearestRankPercentile([], 0.95), /sample/i);
  });

  it("enforces strict foreground boundaries and inclusive ratio/background boundaries", () => {
    const passing = evaluateBenchmarkChecks(
      {
        candidateForegroundP50Ms: 499.999,
        candidateForegroundP95Ms: 999.999,
        controlForegroundP50Ms: 2_500,
        concurrentForegroundMs: 999.999,
        backgroundVerificationP95Ms: 3_500,
        timeoutCount: 0,
        foregroundFullGraphCaptures: 0,
        candidateMeasuredSamples: 20,
        controlMeasuredSamples: 20,
      },
      DEFAULT_THRESHOLDS,
    );
    assert.ok(passing.every((check) => check.passed));

    for (const overrides of [
      { candidateForegroundP50Ms: 500 },
      { candidateForegroundP95Ms: 1_000 },
      { controlForegroundP50Ms: 2_499.99 },
      { concurrentForegroundMs: 1_000 },
      { backgroundVerificationP95Ms: 3_500.001 },
      { timeoutCount: 1 },
      { foregroundFullGraphCaptures: 1 },
      { candidateMeasuredSamples: 19 },
      { controlMeasuredSamples: 19 },
    ]) {
      const checks = evaluateBenchmarkChecks(
        {
          candidateForegroundP50Ms: 499.999,
          candidateForegroundP95Ms: 999.999,
          controlForegroundP50Ms: 2_500,
          concurrentForegroundMs: 999.999,
          backgroundVerificationP95Ms: 3_500,
          timeoutCount: 0,
          foregroundFullGraphCaptures: 0,
          candidateMeasuredSamples: 20,
          controlMeasuredSamples: 20,
          ...overrides,
        },
        DEFAULT_THRESHOLDS,
      );
      assert.ok(checks.some((check) => !check.passed), JSON.stringify(overrides));
    }
  });

  it("escalates a timed-out worker, confirms death, then writes partial evidence", async () => {
    const events: string[] = [];
    const worker = new FakeBenchmarkWorker(events);
    const scheduler = new FakeWatchdogScheduler();
    const completed = createArtifact();
    let written: BenchmarkArtifact | undefined;
    let resolved = false;

    const supervision = superviseBenchmarkWorker(
      supervisorOptions(worker, scheduler, events, (artifact) => {
        events.push("write");
        written = artifact;
      }),
    ).then((result) => {
      resolved = true;
      return result;
    });

    worker.emit("message", {
      type: "metadata",
      startingDatabaseHash: "c".repeat(64),
    });
    worker.emit("message", {
      type: "sample-start",
      sampleId: "candidate:measured:0",
    });
    worker.emit("message", {
      type: "sample-end",
      sampleId: "candidate:measured:0",
      progress: createProgress({
        candidateForegroundSamplesMs: [111],
        backgroundVerificationSamplesMs: [222],
      }),
    });
    worker.emit("message", { type: "sample-start", sampleId: "candidate:measured:1" });
    worker.emit("message", { type: "capture", count: 1 });
    assert.deepEqual(scheduler.delays, [BENCHMARK_TIMEOUT_MS]);
    scheduler.fire(BENCHMARK_TIMEOUT_MS);
    assert.deepEqual(events, ["SIGTERM"]);
    assert.equal(written, undefined);

    worker.emit("message", { type: "sample-end", sampleId: "candidate:measured:1" });
    worker.emit("message", { type: "complete", artifact: completed });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);
    assert.equal(written, undefined);

    scheduler.fire(TERMINATION_GRACE_MS);
    const result = await supervision;

    assert.deepEqual(events, [
      "SIGTERM",
      "force",
      "exit",
      "close",
      "cleanup",
      "write",
    ]);
    assert.equal(worker.alive, false);
    assert.equal(scheduler.pendingCount, 0);
    assert.equal(result.timedOut, true);
    assert.equal(written?.timeoutCount, 1);
    assert.equal(written?.passed, false);
    assert.equal(written?.startingDatabaseHash, "c".repeat(64));
    assert.deepEqual(written?.rawSamplesMs.candidateForeground, [111]);
    assert.deepEqual(written?.rawSamplesMs.backgroundVerification, [222]);
    assert.equal(written?.foregroundFullGraphCaptures, 1);
    assert.equal(
      written?.checks.find((check) => check.name === "foreground full-graph captures")
        ?.passed,
      false,
    );
    assert.notStrictEqual(written, completed);
  });

  it("preserves a completed worker artifact and cleans only after close", async () => {
    const events: string[] = [];
    const worker = new FakeBenchmarkWorker(events);
    const scheduler = new FakeWatchdogScheduler();
    const completed = createArtifact();
    let written: BenchmarkArtifact | undefined;

    const supervision = superviseBenchmarkWorker(
      supervisorOptions(worker, scheduler, events, (artifact) => {
        events.push("write");
        written = artifact;
      }),
    );

    worker.emit("message", { type: "metadata", startingDatabaseHash: "c".repeat(64) });
    worker.emit("message", { type: "sample-start", sampleId: "candidate:measured:0" });
    worker.emit("message", {
      type: "sample-end",
      sampleId: "candidate:measured:0",
      progress: createProgress({
        candidateForegroundSamplesMs: Array(20).fill(100),
        controlForegroundSamplesMs: Array(20).fill(1_000),
        backgroundVerificationSamplesMs: Array(20).fill(300),
        concurrentForegroundMs: 120,
      }),
    });
    worker.emit("message", { type: "complete", artifact: completed });
    assert.equal(written, undefined);
    worker.close(0, null);

    const result = await supervision;
    assert.equal(worker.killed, false);
    assert.equal(scheduler.pendingCount, 0);
    assert.strictEqual(result.artifact, completed);
    assert.strictEqual(written, completed);
    assert.deepEqual(events, ["exit", "close", "cleanup", "write"]);
  });

  it("writes a failing artifact and cleans after an early worker crash", async () => {
    const events: string[] = [];
    const worker = new FakeBenchmarkWorker(events);
    const scheduler = new FakeWatchdogScheduler();
    let written: BenchmarkArtifact | undefined;

    const supervision = superviseBenchmarkWorker(
      supervisorOptions(worker, scheduler, events, (artifact) => {
        events.push("write");
        written = artifact;
      }),
    );

    worker.close(1, null);
    const result = await supervision;

    assert.equal(worker.killed, false);
    assert.equal(result.timedOut, false);
    assert.equal(written?.timeoutCount, 0);
    assert.equal(written?.passed, false);
    assert.ok(
      written?.checks.some(
        (check) => check.name === "worker process failures" && !check.passed,
      ),
    );
    assert.deepEqual(events, ["exit", "close", "cleanup", "write"]);
  });

  it("settles a spawn error with no pid without waiting for an exit event", async () => {
    const events: string[] = [];
    const worker = new FakeBenchmarkWorker(events, null);
    const scheduler = new FakeWatchdogScheduler();
    let written: BenchmarkArtifact | undefined;
    const supervision = superviseBenchmarkWorker(
      supervisorOptions(worker, scheduler, events, (artifact) => {
        events.push("write");
        written = artifact;
      }),
    );

    worker.emit("error", new Error("spawn failed"));
    const result = await nextTurn(supervision);

    assert.notEqual(result, "pending");
    assert.equal(written?.passed, false);
    assert.equal(worker.killed, false);
    assert.deepEqual(events, ["cleanup", "write"]);
  });

  it("rejects honestly when force termination cannot confirm worker death", async () => {
    const events: string[] = [];
    const worker = new FakeBenchmarkWorker(events);
    const scheduler = new FakeWatchdogScheduler();
    let written: BenchmarkArtifact | undefined;
    const supervision = superviseBenchmarkWorker(
      supervisorOptions(
        worker,
        scheduler,
        events,
        (artifact) => {
          written = artifact;
        },
        {
          async forceTerminate() {
            events.push("force-failed");
            throw new Error("force termination failed");
          },
        },
      ),
    );

    worker.emit("message", { type: "metadata", startingDatabaseHash: "c".repeat(64) });
    worker.emit("message", { type: "sample-start", sampleId: "candidate:measured:0" });
    scheduler.fire(BENCHMARK_TIMEOUT_MS);
    scheduler.fire(TERMINATION_GRACE_MS);

    await assert.rejects(supervision, /force termination failed/);
    assert.equal(written, undefined);
    assert.equal(worker.alive, true);
    assert.ok(!events.includes("cleanup"));
  });

  it("bounds a force-termination command that never settles", async () => {
    const events: string[] = [];
    const worker = new FakeBenchmarkWorker(events);
    const scheduler = new FakeWatchdogScheduler();
    const supervision = superviseBenchmarkWorker(
      supervisorOptions(worker, scheduler, events, () => {}, {
        forceTerminate: () => new Promise<void>(() => {}),
      }),
    );

    worker.emit("message", { type: "metadata", startingDatabaseHash: "c".repeat(64) });
    worker.emit("message", { type: "sample-start", sampleId: "candidate:measured:0" });
    scheduler.fire(BENCHMARK_TIMEOUT_MS);
    scheduler.fire(TERMINATION_GRACE_MS);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    scheduler.fire(FORCE_KILL_TIMEOUT_MS);

    await assert.rejects(supervision, /force termination command.*timed out/i);
    assert.equal(worker.alive, true);
    assert.ok(!events.includes("cleanup"));
    assert.equal(scheduler.pendingCount, 0);
  });

  it("rejects malformed IPC and terminates before writing a failure artifact", async () => {
    const malformedMessages: unknown[] = [
      { type: "metadata", startingDatabaseHash: "not-a-hash" },
      { type: "sample-start", sampleId: "candidate:measured:20" },
      {
        type: "sample-end",
        sampleId: "candidate:measured:0",
        progress: createProgress({ candidateForegroundSamplesMs: [Number.NaN] }),
      },
      {
        type: "complete",
        artifact: {
          ...createArtifact(),
          metricsMs: {
            ...createArtifact().metricsMs,
            concurrentForeground: Number.NaN,
          },
        },
      },
      { type: "complete", artifact: { ...createArtifact(), passed: false } },
      { type: "unknown" },
    ];

    for (const malformed of malformedMessages) {
      const events: string[] = [];
      const worker = new FakeBenchmarkWorker(events);
      const scheduler = new FakeWatchdogScheduler();
      let written: BenchmarkArtifact | undefined;
      const supervision = superviseBenchmarkWorker(
        supervisorOptions(worker, scheduler, events, (artifact) => {
          events.push("write");
          written = artifact;
        }),
      );
      if (
        typeof malformed === "object" &&
        malformed !== null &&
        !(
          Reflect.get(malformed, "type") === "metadata" &&
          Reflect.get(malformed, "startingDatabaseHash") === "not-a-hash"
        )
      ) {
        worker.emit("message", {
          type: "metadata",
          startingDatabaseHash: "c".repeat(64),
        });
      }
      if (
        typeof malformed === "object" &&
        malformed !== null &&
        Reflect.get(malformed, "type") === "sample-end"
      ) {
        worker.emit("message", {
          type: "sample-start",
          sampleId: "candidate:measured:0",
        });
      }

      worker.emit("message", malformed);
      assert.deepEqual(events, ["SIGTERM"]);
      scheduler.fire(TERMINATION_GRACE_MS);
      const result = await supervision;

      assert.equal(result.artifact.passed, false);
      assert.equal(written?.passed, false);
      assert.ok(
        written?.checks.some(
          (check) => check.name === "worker process failures" && !check.passed,
        ),
      );
      assert.equal(worker.alive, false);
      assert.equal(scheduler.pendingCount, 0);
    }
  });

  it("rejects non-monotonic capture evidence as a protocol fault", async () => {
    const events: string[] = [];
    const worker = new FakeBenchmarkWorker(events);
    const scheduler = new FakeWatchdogScheduler();
    const supervision = superviseBenchmarkWorker(
      supervisorOptions(worker, scheduler, events, () => {}),
    );

    worker.emit("message", { type: "metadata", startingDatabaseHash: "c".repeat(64) });
    worker.emit("message", { type: "sample-start", sampleId: "candidate:measured:0" });
    worker.emit("message", { type: "capture", count: 1 });
    worker.emit("message", { type: "capture", count: 1 });
    assert.deepEqual(events, ["SIGTERM"]);
    scheduler.fire(TERMINATION_GRACE_MS);
    const result = await supervision;

    assert.equal(result.artifact.foregroundFullGraphCaptures, 1);
    assert.equal(result.artifact.passed, false);
  });

  it("streams cumulative capture evidence synchronously from the worker reporter", () => {
    const progress = createProgress();
    const messages: BenchmarkWorkerMessage[] = [];
    const reporter = createWorkerReporter(
      progress,
      async (message) => {
        messages.push(message);
      },
      (message) => {
        messages.push(message);
      },
    );

    reporter.capture(1);

    assert.equal(progress.foregroundFullGraphCaptures, 1);
    assert.deepEqual(messages, [{ type: "capture", count: 1 }]);
  });

  it("creates and removes only validated benchmark roots beneath the temp root", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "sdl-bgi-contract-"));
    try {
      const workRoot = createBenchmarkWorkRoot(sandbox);
      assert.equal(validateBenchmarkWorkRoot(workRoot, sandbox), resolve(workRoot));
      assert.equal(existsSync(workRoot), true);

      cleanupBenchmarkWorkRoot(workRoot, sandbox);
      assert.equal(existsSync(workRoot), false);

      const unsafeRoot = join(sandbox, "not-a-benchmark-root");
      mkdirSync(unsafeRoot);
      assert.throws(
        () => cleanupBenchmarkWorkRoot(unsafeRoot, sandbox),
        /benchmark work root/i,
      );
      assert.equal(existsSync(unsafeRoot), true);
      assert.throws(
        () => validateBenchmarkWorkRoot(resolve(sandbox, "..", "outside"), sandbox),
        /temporary directory/i,
      );
      assert.throws(
        () => validateBenchmarkWorkRoot(sandbox, sandbox),
        /benchmark work root/i,
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("does not resolve the synchronous control before capture, compare, and publication", async () => {
    const events: string[] = [];
    let releasePublication!: () => void;
    const publication = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let resolved = false;

    const control = runSynchronousControl({
      async captureTrustedBaseline() {
        events.push("capture:baseline");
      },
      async applyWithoutNotification() {
        events.push("apply");
        return { revision: 7 };
      },
      async captureCompare() {
        events.push("capture:actual");
        events.push("compare");
        return "digest";
      },
      async publish(commit, digest) {
        events.push(`publish:${commit.revision}:${digest}`);
        await publication;
      },
    }).then(() => {
      resolved = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);
    assert.deepEqual(events, [
      "capture:baseline",
      "apply",
      "capture:actual",
      "compare",
      "publish:7:digest",
    ]);

    releasePublication();
    await control;
    assert.equal(resolved, true);
  });

  it("builds the complete deterministic artifact schema and aggregate result", () => {
    const artifact = buildBenchmarkArtifact({
      commitSha: "0123456789abcdef",
      os: "win32",
      cpu: "test cpu",
      node: "v24.0.0",
      ladybugDb: "0.18.1",
      addonMode: "disabled",
      fixtureHash: "fixture-hash",
      editSequenceHash: "edit-hash",
      startingDatabaseHash: "database-hash",
      cacheMode: "warm-serial",
      candidateForegroundSamplesMs: Array(20).fill(100),
      controlForegroundSamplesMs: Array(20).fill(1_000),
      backgroundVerificationSamplesMs: Array(20).fill(300),
      concurrentForegroundMs: 120,
      timeoutCount: 0,
      foregroundFullGraphCaptures: 0,
    });

    assert.deepEqual(Object.keys(artifact), [
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
    ]);
    assert.equal(artifact.schemaVersion, BENCHMARK_SCHEMA_VERSION);
    assert.equal(artifact.fixtureSeed, FIXTURE_SEED);
    assert.equal(artifact.rawSamplesMs.candidateForeground.length, 20);
    assert.equal(artifact.rawSamplesMs.controlForeground.length, 20);
    assert.equal(artifact.metricsMs.candidateForeground.p50, 100);
    assert.equal(artifact.metricsMs.candidateForeground.p95, 100);
    assert.equal(artifact.metricsMs.controlForeground.p50, 1_000);
    assert.equal(artifact.metricsMs.backgroundVerification.p95, 300);
    assert.ok(artifact.checks.every((check) => check.passed));
    assert.equal(artifact.passed, true);

    const failed = buildBenchmarkArtifact({
      ...artifact,
      candidateForegroundSamplesMs: Array(20).fill(500),
      controlForegroundSamplesMs: Array(20).fill(1_000),
      backgroundVerificationSamplesMs: Array(20).fill(3_501),
      concurrentForegroundMs: 1_000,
      timeoutCount: 1,
      foregroundFullGraphCaptures: 1,
    });
    assert.equal(failed.passed, false);
    assert.ok(failed.checks.some((check) => !check.passed));

    const timedOut = buildBenchmarkArtifact({
      commitSha: "0123456789abcdef",
      os: "win32",
      cpu: null,
      node: "v24.0.0",
      ladybugDb: "0.18.1",
      addonMode: "disabled",
      fixtureHash: "fixture-hash",
      editSequenceHash: "edit-hash",
      startingDatabaseHash: "database-hash",
      cacheMode: "warm-serial",
      candidateForegroundSamplesMs: [],
      controlForegroundSamplesMs: [],
      backgroundVerificationSamplesMs: [],
      concurrentForegroundMs: Number.MAX_VALUE,
      timeoutCount: 1,
      foregroundFullGraphCaptures: 0,
    });
    assert.equal(timedOut.passed, false);
    assert.ok(Number.isFinite(timedOut.metricsMs.candidateForeground.p50));
    assert.ok(Number.isFinite(timedOut.metricsMs.controlForeground.p95));
    assert.ok(Number.isFinite(timedOut.metricsMs.backgroundVerification.p95));
  });
});
