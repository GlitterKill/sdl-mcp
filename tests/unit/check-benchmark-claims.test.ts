import assert from "node:assert";
import { describe, it } from "node:test";
import { evaluateBenchmarkClaims } from "../../scripts/check-benchmark-claims.ts";

describe("evaluateBenchmarkClaims", () => {
  it("passes when all families meet thresholds", () => {
    const result = evaluateBenchmarkClaims({
      aggregate: {
        overall: { minTokenReductionPct: 34 },
        families: [
          {
            family: "security",
            p25TokenReductionPct: 44,
            p50TokenReductionPct: 58,
            minTokenReductionPct: 34,
          },
          {
            family: "infra-devops",
            p25TokenReductionPct: 41,
            p50TokenReductionPct: 53,
            minTokenReductionPct: 28,
          },
        ],
      },
      minFamilyP50: 50,
      minFamilyP25: 40,
      minTaskFloor: 20,
    });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.failures.length, 0);
  });

  it("fails when any family violates thresholds", () => {
    const result = evaluateBenchmarkClaims({
      aggregate: {
        overall: { minTokenReductionPct: 15 },
        families: [
          {
            family: "security",
            p25TokenReductionPct: 35,
            p50TokenReductionPct: 49,
            minTokenReductionPct: 15,
          },
        ],
      },
      minFamilyP50: 50,
      minFamilyP25: 40,
      minTaskFloor: 20,
    });

    assert.strictEqual(result.passed, false);
    assert.ok(result.failures.some((failure) => failure.includes("p50")));
    assert.ok(result.failures.some((failure) => failure.includes("p25")));
    assert.ok(result.failures.some((failure) => failure.includes("min task")));
  });
});
