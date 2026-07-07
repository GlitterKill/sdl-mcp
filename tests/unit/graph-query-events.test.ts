import assert from "node:assert";
import { describe, it } from "node:test";

import {
  _consumeGraphQueryEventTokenForTesting,
  _extractGraphQueryTablesForTesting,
  _resetGraphQueryEventRateLimitForTesting,
} from "../../dist/db/ladybug-core.js";

describe("graph query event instrumentation", () => {
  it("extracts deterministic label names from Cypher table patterns", () => {
    assert.deepEqual(
      _extractGraphQueryTablesForTesting(`
        MATCH (source:Symbol)-[:DEPENDS_ON]->(target:Symbol)
        MERGE (file:File { path: $path })
        RETURN source, target
      `),
      ["File", "Symbol"],
    );

    assert.deepEqual(
      _extractGraphQueryTablesForTesting("MATCH (n) RETURN n"),
      [],
    );
  });

  it("limits graph query heatmap events to 20 per second", () => {
    _resetGraphQueryEventRateLimitForTesting();

    for (let i = 0; i < 20; i += 1) {
      assert.equal(_consumeGraphQueryEventTokenForTesting(1_000), true);
    }
    assert.equal(_consumeGraphQueryEventTokenForTesting(1_000), false);
    assert.equal(_consumeGraphQueryEventTokenForTesting(2_000), true);
  });
});
