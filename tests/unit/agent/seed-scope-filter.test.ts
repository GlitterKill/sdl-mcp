import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildScopedPreciseConceptQueries,
  selectFirstUnseenPerBatch,
  selectScopedConceptSeeds,
  tagExistingSeedCandidate,
  useScopedResultsOrFallback,
} from "../../../dist/agent/context-seeding.js";
import type { ContextSeedCandidate } from "../../../dist/agent/types.js";

describe("scoped lexical fallback", () => {
  it("derives one normalized query per requested concept", () => {
    assert.deepEqual(
      buildScopedPreciseConceptQueries(
        "Find tests for workflow aggregation, usage stats, search edit, " +
          "delta signatures, and deterministic output",
      ),
      [
        "tests workflow aggregation",
        "usage stats",
        "search edit searchEdit",
        "delta signatures",
        "determinism output",
      ],
    );
  });

  it("preserves the existing query plan for a single concept", () => {
    assert.deepEqual(buildScopedPreciseConceptQueries("Find workflow tests"), []);
  });

  it("preserves the existing query plan when a clause excludes a concept", () => {
    for (const taskText of [
      "Find workflow aggregation tests, not benchmark helpers",
      "Find workflow aggregation tests, excluding benchmark helpers",
      "Find workflow aggregation tests, except benchmark helpers",
      "Find workflow aggregation tests, but without benchmark helpers",
    ]) {
      assert.deepEqual(
        buildScopedPreciseConceptQueries(taskText),
        [],
        `expected negated clause to disable concept pruning: ${taskText}`,
      );
    }
  });

  it("bounds multi-topic queries to the precise lexical capacity", () => {
    assert.equal(
      buildScopedPreciseConceptQueries(
        Array.from({ length: 20 }, (_, index) => `concept${index}`).join(", "),
      ).length,
      9,
    );
  });

  it("selects the first unseen result from every concept deterministically", () => {
    const duplicate = { id: "workflow-1" };
    assert.deepEqual(
      selectFirstUnseenPerBatch(
        [
          [duplicate, { id: "workflow-2" }],
          [duplicate, { id: "usage-1" }],
          [{ id: "search-edit-1" }],
          [{ id: "delta-1" }],
          [{ id: "search-edit-1" }, { id: "determinism-1" }],
        ],
        ({ id }) => id,
      ),
      {
        selected: [
          duplicate,
          { id: "usage-1" },
          { id: "search-edit-1" },
          { id: "delta-1" },
          { id: "determinism-1" },
        ],
        complete: true,
      },
    );
  });

  it("marks concept coverage incomplete when a batch has no unseen result", () => {
    assert.deepEqual(
      selectFirstUnseenPerBatch(
        [[{ id: "workflow" }], [], [{ id: "delta" }]],
        ({ id }) => id,
      ),
      {
        selected: [{ id: "workflow" }, { id: "delta" }],
        complete: false,
      },
    );
  });

  it("preserves every resolved concept when another concept is unresolved", () => {
    assert.deepEqual(
      selectScopedConceptSeeds(
        [
          [{ symbolId: "workflow" }],
          [],
          [{ symbolId: "delta" }],
        ],
      ),
      {
        selected: [{ symbolId: "workflow" }, { symbolId: "delta" }],
        resolvedRefs: ["symbol:workflow", "symbol:delta"],
        complete: false,
      },
    );
  });

  it("tags a semantic-first duplicate with named-concept provenance", () => {
    const candidates: ContextSeedCandidate[] = [
      {
        contextRef: "symbol:workflow",
        source: "semantic",
        score: 0.35,
        sourceRank: 0,
      },
    ];

    assert.equal(
      tagExistingSeedCandidate(
        candidates,
        "symbol:workflow",
        "namedConcept",
      ),
      true,
    );
    assert.equal(candidates[0]?.expansionReason, "namedConcept");
  });

  it("uses global search only when scoped results are unavailable", async () => {
    let fallbackCalls = 0;
    const fallback = async () => {
      fallbackCalls += 1;
      return ["global"];
    };

    assert.deepEqual(await useScopedResultsOrFallback([], fallback), []);
    assert.equal(fallbackCalls, 0);
    assert.deepEqual(await useScopedResultsOrFallback(undefined, fallback), ["global"]);
    assert.equal(fallbackCalls, 1);
  });
});
