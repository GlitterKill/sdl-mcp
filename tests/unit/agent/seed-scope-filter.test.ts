import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  filterSeedCandidatesToScope,
} from "../../../dist/agent/context-seeding.js";
import * as contextSeedingModule from "../../../dist/agent/context-seeding.js";
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

describe("scoped lexical fallback", () => {
  it("uses global search only when scoped results are unavailable", async () => {
    const selectResults = (
      contextSeedingModule as typeof contextSeedingModule & {
        useScopedResultsOrFallback: <T>(
          scopedResults: T[] | undefined,
          fallback: () => Promise<T[]>,
        ) => Promise<T[]>;
      }
    ).useScopedResultsOrFallback;
    assert.equal(typeof selectResults, "function");

    let fallbackCalls = 0;
    const fallback = async () => {
      fallbackCalls += 1;
      return ["global"];
    };

    assert.deepEqual(await selectResults([], fallback), []);
    assert.equal(fallbackCalls, 0);
    assert.deepEqual(await selectResults(undefined, fallback), ["global"]);
    assert.equal(fallbackCalls, 1);
  });
});
