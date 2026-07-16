import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  filterSeedCandidatesToScope,
  rankScopedSeedSymbols,
} from "../../../dist/agent/context-seeding.js";
import type { ContextSeedCandidate } from "../../../dist/agent/types.js";

function candidate(
  contextRef: string,
  score: number,
  entityType?: ContextSeedCandidate["entityType"],
): ContextSeedCandidate {
  return {
    contextRef,
    source: "semantic",
    score,
    sourceRank: 0,
    ...(entityType ? { entityType } : {}),
  };
}

describe("filterSeedCandidatesToScope", () => {
  it("drops symbol candidates outside the explicit scope", () => {
    const candidates = [
      candidate("symbol:inside", 0.8, "symbol"),
      candidate("symbol:outside", 0.9, "symbol"),
    ];
    const candidatePaths = new Map([
      ["symbol:inside", "src/agent/context-engine.ts"],
      ["symbol:outside", "src/db/ladybug-core.ts"],
    ]);

    const filtered = filterSeedCandidatesToScope(
      candidates,
      candidatePaths,
      ["src/agent"],
    );

    assert.deepEqual(filtered, [candidates[0]]);
  });

  it("keeps a lower-ranked scoped candidate after higher out-of-scope candidates", () => {
    const candidates = Array.from({ length: 20 }, (_, index) =>
      candidate(`symbol:outside-${index}`, 1 - index / 100, "symbol"),
    );
    const scopedCandidate = candidate("symbol:inside", 0.5, "symbol");
    candidates.push(scopedCandidate);
    const candidatePaths = new Map(
      candidates.map((item) => [item.contextRef, "src/db/ladybug-core.ts"]),
    );
    candidatePaths.set(scopedCandidate.contextRef, "src/agent/context-seeding.ts");

    const filtered = filterSeedCandidatesToScope(
      candidates,
      candidatePaths,
      ["src/agent/context-seeding.ts"],
    );

    assert.deepEqual(filtered, [scopedCandidate]);
  });

  it("drops opaque and unknown candidates and maps file summaries by path", () => {
    const scopedFile = candidate("fileSummary:file-in", 0.7, "fileSummary");
    const candidates = [
      candidate("cluster:cluster-1", 1, "cluster"),
      candidate("process:process-1", 0.9, "process"),
      candidate("symbol:unknown", 0.8, "symbol"),
      scopedFile,
      candidate("fileSummary:file-out", 0.6, "fileSummary"),
    ];
    const candidatePaths = new Map([
      [scopedFile.contextRef, "src/agent/context-seeding.ts"],
      ["fileSummary:file-out", "src/db/ladybug-core.ts"],
    ]);

    const filtered = filterSeedCandidatesToScope(
      candidates,
      candidatePaths,
      ["src/agent"],
    );

    assert.deepEqual(filtered, [scopedFile]);
  });

  it("returns the original candidate array when scope is empty", () => {
    const candidates = [candidate("cluster:cluster-1", 1, "cluster")];

    const filtered = filterSeedCandidatesToScope(
      candidates,
      new Map(),
      [],
    );

    assert.strictEqual(filtered, candidates);
  });
});

describe("rankScopedSeedSymbols", () => {
  it("ranks exact query terms ahead of partial name matches", () => {
    const ranked = rankScopedSeedSymbols(
      [
        { symbolId: "partial", name: "workflowNoise" },
        { symbolId: "schema", name: "WorkflowRequestSchema" },
        { symbolId: "unrelated", name: "unrelatedHelper" },
        { symbolId: "handler", name: "handleWorkflow" },
      ],
      "handleWorkflow WorkflowRequestSchema workflow",
      3,
    );

    assert.deepEqual(
      ranked.map((symbol) => symbol.symbolId),
      ["handler", "schema", "partial"],
    );
  });
});
