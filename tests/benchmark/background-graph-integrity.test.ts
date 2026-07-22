import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BENCHMARK_SCHEMA_VERSION,
  BENCHMARK_TIMEOUT_MS,
  DEFAULT_THRESHOLDS,
  FIXTURE_FILE_COUNT,
  FIXTURE_SEED,
  FIXTURE_SYMBOLS_PER_FILE,
  buildBenchmarkArtifact,
  createBenchmarkFixture,
  createBenchmarkLaneInputs,
  evaluateBenchmarkChecks,
  nearestRankPercentile,
  runSynchronousControl,
  withHardTimeout,
} from "../../scripts/background-graph-integrity-benchmark.ts";

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

  it("times out through injected timing without sleeping", async () => {
    let scheduledMs = 0;
    await assert.rejects(
      withHardTimeout(
        new Promise<never>(() => {}),
        BENCHMARK_TIMEOUT_MS,
        {
          setTimeout(callback, delayMs) {
            scheduledMs = delayMs;
            callback();
            return 1;
          },
          clearTimeout() {},
        },
      ),
      /30,000 ms/,
    );
    assert.equal(scheduledMs, BENCHMARK_TIMEOUT_MS);
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
