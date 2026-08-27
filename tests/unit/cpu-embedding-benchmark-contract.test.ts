import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, type TestContext } from "node:test";

import {
  aggregateShapeSamples,
  buildBenchmarkShapes,
  evaluateProductionGate,
  rankQualifyingCandidates,
  runBenchmarkChild,
} from "../../scripts/cpu-embedding-benchmark-contract.mjs";

const BASELINE_SHAPE = {
  id: "baseline",
  batchSize: 32,
  concurrency: 1,
  texts: 192,
  executionProviders: ["cpu"],
  intraOpNumThreads: 8,
  interOpNumThreads: 1,
  executionMode: "sequential",
  enableCpuMemArena: true,
  enableMemPattern: true,
  graphOptimizationLevel: "all",
};

const PRODUCTION_SHAPE = {
  ...BASELINE_SHAPE,
  id: "production",
  batchSize: 16,
  concurrency: 8,
};

const PRODUCTION_TUPLE = {
  batchSize: PRODUCTION_SHAPE.batchSize,
  concurrency: PRODUCTION_SHAPE.concurrency,
  executionProviders: PRODUCTION_SHAPE.executionProviders,
  intraOpNumThreads: PRODUCTION_SHAPE.intraOpNumThreads,
  interOpNumThreads: PRODUCTION_SHAPE.interOpNumThreads,
  executionMode: PRODUCTION_SHAPE.executionMode,
  enableCpuMemArena: PRODUCTION_SHAPE.enableCpuMemArena,
  enableMemPattern: PRODUCTION_SHAPE.enableMemPattern,
  graphOptimizationLevel: PRODUCTION_SHAPE.graphOptimizationLevel,
};

function sample(
  shape: typeof BASELINE_SHAPE,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...shape,
    milliseconds: 1_000,
    textsPerSecond: 100,
    maxRssKiB: 512 * 1_024,
    ...overrides,
  };
}

function aggregate(
  shape: typeof BASELINE_SHAPE,
  textsPerSecond: number,
  medianMaxRssKiB = 512 * 1_024,
  worstMaxRssKiB = medianMaxRssKiB,
) {
  return {
    ...shape,
    medianMilliseconds: 1_000,
    medianTextsPerSecond: textsPerSecond,
    medianMaxRssKiB,
    worstMaxRssKiB,
  };
}

function mockSpawn(
  t: TestContext,
  {
    stdout = "",
    stderr = "",
    code = 0,
    signal = null,
    error,
  }: {
    stdout?: string;
    stderr?: string;
    code?: number | null;
    signal?: NodeJS.Signals | null;
    error?: Error;
  },
) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  t.mock.method(childProcess, "spawn", () => {
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setImmediate(() => {
        if (error) child.emit("error", error);
        else child.emit("close", code, signal);
      });
    });
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  });
}

function runMockedChild() {
  return runBenchmarkChild({
    scriptPath: "benchmark.mjs",
    cwd: "benchmark-root",
    shape: BASELINE_SHAPE,
  });
}

describe("buildBenchmarkShapes", () => {
  it("builds the stable sweep without duplicating the exact production tuple", () => {
    const shapes = buildBenchmarkShapes(PRODUCTION_TUPLE);

    assert.deepStrictEqual(
      shapes.map(({ id, batchSize, concurrency, enableCpuMemArena }) => ({
        id,
        batchSize,
        concurrency,
        enableCpuMemArena,
      })),
      [
        { id: "baseline", batchSize: 32, concurrency: 1, enableCpuMemArena: true },
        { id: "production", batchSize: 16, concurrency: 8, enableCpuMemArena: true },
        { id: "batch-8", batchSize: 8, concurrency: 8, enableCpuMemArena: true },
        { id: "batch-12", batchSize: 12, concurrency: 8, enableCpuMemArena: true },
        { id: "batch-20", batchSize: 20, concurrency: 8, enableCpuMemArena: true },
        { id: "batch-24", batchSize: 24, concurrency: 8, enableCpuMemArena: true },
        { id: "arena-off", batchSize: 16, concurrency: 8, enableCpuMemArena: false },
      ],
    );
    for (const shape of shapes) {
      assert.deepStrictEqual(shape.executionProviders, ["cpu"]);
      assert.equal(shape.intraOpNumThreads, 8);
      assert.equal(shape.interOpNumThreads, 1);
      assert.equal(shape.executionMode, "sequential");
      assert.equal(shape.enableMemPattern, true);
      assert.equal(shape.graphOptimizationLevel, "all");
    }

    const production = shapes.find(({ id }) => id === "production");
    assert.ok(production);
    assert.equal(
      shapes.filter(({ id, ...shape }) => {
        const { id: _productionId, ...productionTuple } = production;
        return id !== "production" &&
          JSON.stringify(shape) === JSON.stringify(productionTuple);
      }).length,
      0,
    );
  });
});

describe("runBenchmarkChild", () => {
  it("resolves one valid JSON record", async (t) => {
    const record = sample(BASELINE_SHAPE);
    mockSpawn(t, { stdout: JSON.stringify(record) });

    assert.deepStrictEqual(await runMockedChild(), record);
  });

  it("rejects a spawn error", async (t) => {
    mockSpawn(t, { error: new Error("spawn EPERM") });

    await assert.rejects(runMockedChild(), /spawn EPERM/u);
  });

  it("rejects a signal exit", async (t) => {
    mockSpawn(t, { signal: "SIGTERM" });

    await assert.rejects(runMockedChild(), /signal SIGTERM/u);
  });

  it("rejects a nonzero exit and bounds captured stderr", async (t) => {
    mockSpawn(t, { code: 2, stderr: `diagnostic:${"x".repeat(20_000)}` });

    await assert.rejects(runMockedChild(), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exited 2.*diagnostic:/u);
      assert.ok(error.message.length < 10_000);
      return true;
    });
  });

  it("rejects empty stdout", async (t) => {
    mockSpawn(t, { stdout: "  \n" });

    await assert.rejects(runMockedChild(), /empty stdout/u);
  });

  it("rejects malformed JSON", async (t) => {
    mockSpawn(t, { stdout: "{" });

    await assert.rejects(runMockedChild(), /invalid JSON/u);
  });

  it("rejects returned identity and session tuple mismatches", async (t) => {
    for (const [field, value] of [
      ["id", "wrong"],
      ["batchSize", 8],
      ["concurrency", 2],
      ["executionProviders", ["cpu", "fallback"]],
      ["intraOpNumThreads", 4],
      ["interOpNumThreads", 2],
      ["executionMode", "parallel"],
      ["enableCpuMemArena", false],
      ["enableMemPattern", false],
      ["graphOptimizationLevel", "basic"],
    ] as const) {
      await t.test(field, async (t) => {
        mockSpawn(t, {
          stdout: JSON.stringify(sample(BASELINE_SHAPE, { [field]: value })),
        });

        await assert.rejects(runMockedChild(), new RegExp(field, "u"));
      });
    }
  });

  it("rejects invalid metrics", async (t) => {
    for (const [field, value] of [
      ["milliseconds", 0],
      ["textsPerSecond", Number.NaN],
      ["maxRssKiB", 1.5],
    ] as const) {
      await t.test(field, async (t) => {
        mockSpawn(t, {
          stdout: JSON.stringify(sample(BASELINE_SHAPE, { [field]: value })),
        });

        await assert.rejects(runMockedChild(), new RegExp(field, "u"));
      });
    }
  });
});

describe("aggregateShapeSamples", () => {
  it("aggregates a one-sample quick run", () => {
    assert.deepStrictEqual(
      aggregateShapeSamples(BASELINE_SHAPE, [sample(BASELINE_SHAPE)], 1),
      aggregate(BASELINE_SHAPE, 100),
    );
  });

  it("uses medians and preserves the worst peak RSS", () => {
    const result = aggregateShapeSamples(
      BASELINE_SHAPE,
      [
        sample(BASELINE_SHAPE, {
          milliseconds: 900,
          textsPerSecond: 110,
          maxRssKiB: 500_000,
        }),
        sample(BASELINE_SHAPE, {
          milliseconds: 1_100,
          textsPerSecond: 90,
          maxRssKiB: 700_000,
        }),
        sample(BASELINE_SHAPE, {
          milliseconds: 1_000,
          textsPerSecond: 100,
          maxRssKiB: 600_000,
        }),
      ],
      3,
    );

    assert.equal(result.medianMilliseconds, 1_000);
    assert.equal(result.medianTextsPerSecond, 100);
    assert.equal(result.medianMaxRssKiB, 600_000);
    assert.equal(result.worstMaxRssKiB, 700_000);
  });

  it("averages the two middle values for an even sample count", () => {
    const result = aggregateShapeSamples(
      BASELINE_SHAPE,
      [
        sample(BASELINE_SHAPE, {
          milliseconds: 800,
          textsPerSecond: 80,
          maxRssKiB: 400_000,
        }),
        sample(BASELINE_SHAPE, {
          milliseconds: 1_000,
          textsPerSecond: 100,
          maxRssKiB: 500_000,
        }),
        sample(BASELINE_SHAPE, {
          milliseconds: 1_200,
          textsPerSecond: 120,
          maxRssKiB: 600_000,
        }),
        sample(BASELINE_SHAPE, {
          milliseconds: 1_400,
          textsPerSecond: 140,
          maxRssKiB: 700_000,
        }),
      ],
      4,
    );

    assert.equal(result.medianMilliseconds, 1_100);
    assert.equal(result.medianTextsPerSecond, 110);
    assert.equal(result.medianMaxRssKiB, 550_000);
    assert.equal(result.worstMaxRssKiB, 700_000);
  });

  it("rejects incomplete sample sets and non-object records", () => {
    assert.throws(
      () =>
        aggregateShapeSamples(
          PRODUCTION_SHAPE,
          [sample(PRODUCTION_SHAPE), sample(PRODUCTION_SHAPE)],
          3,
        ),
      /exactly 3 samples/u,
    );
    assert.throws(
      () => aggregateShapeSamples(BASELINE_SHAPE, [null], 1),
      /sample 1 must be an object/u,
    );
  });

  it("rejects a wrong id or any mismatched shape tuple value", () => {
    const shape = { ...BASELINE_SHAPE, executionProviders: ["cpu", "fallback"] };
    for (const [field, value] of [
      ["id", "not-baseline"],
      ["batchSize", 16],
      ["concurrency", 2],
      ["texts", 48],
      ["executionProviders", ["fallback", "cpu"]],
      ["intraOpNumThreads", 4],
      ["interOpNumThreads", 2],
      ["executionMode", "parallel"],
      ["enableCpuMemArena", false],
      ["enableMemPattern", false],
      ["graphOptimizationLevel", "basic"],
    ] as const) {
      assert.throws(
        () =>
          aggregateShapeSamples(shape, [sample(shape, { [field]: value })], 1),
        new RegExp(`sample 1 ${field}`, "u"),
      );
    }
  });

  it("rejects invalid, nonfinite, and nonpositive numeric fields", () => {
    for (const [field, value] of [
      ["texts", 0],
      ["batchSize", 1.5],
      ["milliseconds", Number.NaN],
      ["textsPerSecond", Number.POSITIVE_INFINITY],
      ["maxRssKiB", -1],
      ["maxRssKiB", 1.5],
    ] as const) {
      assert.throws(
        () =>
          aggregateShapeSamples(
            BASELINE_SHAPE,
            [sample(BASELINE_SHAPE, { [field]: value })],
            1,
          ),
        new RegExp(field, "u"),
      );
    }
  });
});

describe("production benchmark gate", () => {
  it("accepts a fractional median RSS produced from integer samples", () => {
    const baseline = aggregateShapeSamples(
      BASELINE_SHAPE,
      [
        sample(BASELINE_SHAPE, { maxRssKiB: 100 }),
        sample(BASELINE_SHAPE, { maxRssKiB: 101 }),
      ],
      2,
    );
    const production = aggregateShapeSamples(
      PRODUCTION_SHAPE,
      [
        sample(PRODUCTION_SHAPE, { textsPerSecond: 115, maxRssKiB: 100 }),
        sample(PRODUCTION_SHAPE, { textsPerSecond: 115, maxRssKiB: 101 }),
      ],
      2,
    );

    assert.equal(baseline.medianMaxRssKiB, 100.5);
    assert.equal(evaluateProductionGate({ baseline, production }).passed, true);
  });

  it("does not let an experimental winner make production pass", () => {
    const baseline = aggregate(BASELINE_SHAPE, 100);
    const production = aggregate(PRODUCTION_SHAPE, 114.99);
    const experimental = aggregate(
      { ...PRODUCTION_SHAPE, id: "experimental" },
      140,
    );

    assert.deepStrictEqual(
      rankQualifyingCandidates({ baseline, candidates: [experimental] }).map(
        ({ id }) => id,
      ),
      ["experimental"],
    );
    assert.equal(evaluateProductionGate({ baseline, production }).passed, false);
  });

  it("uses median throughput and worst production RSS", () => {
    const baseline = aggregate(BASELINE_SHAPE, 100, 1_000_000, 1_050_000);
    const production = aggregate(PRODUCTION_SHAPE, 115, 1_000_000, 1_131_073);

    assert.deepStrictEqual(evaluateProductionGate({ baseline, production }), {
      passed: false,
      upliftPercent: 15,
      memoryLimitKiB: 1_131_072,
      throughputPassed: true,
      memoryPassed: false,
    });
  });

  it("treats the throughput and RSS limits as inclusive", () => {
    const baseline = aggregate(BASELINE_SHAPE, 100, 1_000_000);
    const production = aggregate(PRODUCTION_SHAPE, 115, 1_131_072, 1_131_072);

    assert.deepStrictEqual(evaluateProductionGate({ baseline, production }), {
      passed: true,
      upliftPercent: 15,
      memoryLimitKiB: 1_131_072,
      throughputPassed: true,
      memoryPassed: true,
    });
  });

  it("ranks qualifying candidates by throughput then id", () => {
    const baseline = aggregate(BASELINE_SHAPE, 100, 1_000_000);
    const candidates = [
      aggregate({ ...PRODUCTION_SHAPE, id: "zeta" }, 120),
      aggregate({ ...PRODUCTION_SHAPE, id: "too-slow" }, 114.99),
      aggregate({ ...PRODUCTION_SHAPE, id: "alpha" }, 120),
      aggregate(
        { ...PRODUCTION_SHAPE, id: "too-large" },
        130,
        1_000_000,
        1_131_073,
      ),
    ];

    assert.deepStrictEqual(
      rankQualifyingCandidates({ baseline, candidates }).map(({ id }) => id),
      ["alpha", "zeta"],
    );
  });
});
