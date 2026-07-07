import assert from "node:assert";
import { describe, it } from "node:test";

import { _recordSearchGraphEventForTesting } from "../../dist/viewer/routes.js";

describe("viewer route graph events", () => {
  it("records search graph events with a bounded top-symbol sample", () => {
    const events: unknown[] = [];
    _recordSearchGraphEventForTesting(
      { recordGraphEvent: (event: unknown) => events.push(event) },
      "repo-a",
      "buildGraph",
      Array.from({ length: 55 }, (_, index) => ({ symbolId: `s${index}`, name: `s${index}`, kind: "function" })),
    );

    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      type: "graph.search.executed",
      repoId: "repo-a",
      query: "buildGraph",
      topSymbolIds: Array.from({ length: 50 }, (_, index) => `s${index}`),
    });
  });

  it("ignores absent observability service", () => {
    assert.doesNotThrow(() => _recordSearchGraphEventForTesting(null, "repo-a", "q", []));
  });
});
