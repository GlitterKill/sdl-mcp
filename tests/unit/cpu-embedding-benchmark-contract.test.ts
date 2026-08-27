import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aggregateShapeSamples,
  evaluateProductionGate,
  rankQualifyingCandidates,
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
  concurrency: 8,
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
      () => aggregateShapeSamples(BASELINE_SHAPE, [], 1),
      /exactly 1 sample/u,
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
