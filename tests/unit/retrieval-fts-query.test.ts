import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildFtsStoredProcQuery } from "../../dist/retrieval/orchestrator.js";

describe("FTS stored procedure query builder", () => {
  it("passes TOP separately from BM25 K", () => {
    const query = buildFtsStoredProcQuery(
      "Symbol",
      "symbol_search_text_v1",
      "executeCardRung",
      12,
      false,
    );

    assert.match(query, /CALL QUERY_FTS_INDEX/);
    assert.match(query, /K := 1\.2/);
    assert.match(query, /TOP := 12/);
    assert.doesNotMatch(query, /K := 12/);
  });

  it("rejects unsafe table and index names before interpolation", () => {
    assert.throws(() =>
      buildFtsStoredProcQuery("Symbol) RETURN 1", "idx", "query", 10, false),
    );
    assert.throws(() =>
      buildFtsStoredProcQuery("Symbol", "idx-name", "query", 10, false),
    );
  });
});
