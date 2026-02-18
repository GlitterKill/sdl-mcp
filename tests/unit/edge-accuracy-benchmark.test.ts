import { describe, it } from "node:test";
import assert from "node:assert";
import { evaluateEdgeAccuracySuite } from "../../src/benchmark/edgeAccuracy.js";

describe("edge-accuracy benchmark suite", () => {
  it("produces per-language precision/recall/f1 scores", () => {
    const scores = evaluateEdgeAccuracySuite();
    assert.ok(scores.length >= 3);

    const python = scores.find((score) => score.language === "python");
    const go = scores.find((score) => score.language === "go");
    const java = scores.find((score) => score.language === "java");

    assert.ok(python, "python score is required");
    assert.ok(go, "go score is required");
    assert.ok(java, "java score is required");

    for (const score of scores) {
      assert.ok(score.precision >= 0 && score.precision <= 1);
      assert.ok(score.recall >= 0 && score.recall <= 1);
      assert.ok(score.f1 >= 0 && score.f1 <= 1);
      assert.ok(score.strategyAccuracy >= 0 && score.strategyAccuracy <= 1);
    }
  });

  it("meets minimum f1 floor for tier-2 languages", () => {
    const scores = evaluateEdgeAccuracySuite();
    for (const score of scores) {
      if (score.language === "python" || score.language === "go" || score.language === "java") {
        assert.ok(
          score.f1 >= 0.75,
          `${score.language} f1 must be >= 0.75, got ${score.f1.toFixed(3)}`,
        );
      }
    }
  });
});
