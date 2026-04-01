import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  compareTaskScopedCandidates,
  isTestLikePath,
} from "../../dist/retrieval/task-query-ranking.js";

describe("task query ranking", () => {
  it("identifies test-like paths consistently", () => {
    assert.equal(isTestLikePath("tests/unit/policy-engine.test.ts"), true);
    assert.equal(isTestLikePath("src/policy/engine.ts"), false);
  });

  it("prefers source policy symbols over test files for policy-engine tasks", () => {
    const sourceCandidate = {
      filePath: "src/policy/engine.ts",
      kind: "class",
      exported: true,
      name: "PolicyEngine",
    };
    const testCandidate = {
      filePath: "tests/unit/policy-engine.test.ts",
      kind: "function",
      exported: true,
      name: "PolicyEngine",
    };

    assert.ok(
      compareTaskScopedCandidates(
        "how does the policy engine work",
        sourceCandidate,
        testCandidate,
      ) < 0,
    );
  });

  it("boosts file paths that match the query domain", () => {
    const indexerCandidate = {
      filePath: "src/indexer/file-scanner.ts",
      kind: "class",
      exported: true,
      name: "FileScanner",
    };
    const tangentialCandidate = {
      filePath: "src/agent/classify-symptom-type.ts",
      kind: "function",
      exported: true,
      name: "classifySymptomType",
    };

    assert.ok(
      compareTaskScopedCandidates(
        "how does the indexing pipeline work",
        indexerCandidate,
        tangentialCandidate,
      ) < 0,
    );
  });
});
