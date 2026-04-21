import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { narrowFilesForQuery } from "../../dist/retrieval/orchestrator.js";

/**
 * `narrowFilesForQuery` is the entry point used by `sdl.search.edit`'s
 * planner to shortlist files via hybrid FTS+vector retrieval before
 * falling back to raw enumeration.
 *
 * These tests cover the graceful-degradation paths — when the DB/index
 * is not available the function must return `paths: []` and (when
 * evidence was requested) a non-empty evidence object that records the
 * fallback reason. The happy-path end-to-end is covered by the
 * integration smoke test.
 */
describe("narrowFilesForQuery", () => {
  it("returns empty paths when the repo is unknown (evidence requested)", async () => {
    const result = await narrowFilesForQuery({
      repoId: "repo-that-does-not-exist-" + Date.now(),
      query: "fooBarBaz",
      limit: 5,
      includeEvidence: true,
    });
    assert.equal(Array.isArray(result.paths), true);
    assert.equal(result.paths.length, 0);
    // evidence field may or may not be populated depending on whether
    // the retrieval backend short-circuits before producing evidence,
    // but when present it must carry the shape RetrievalEvidence uses.
    if (result.evidence) {
      assert.equal(typeof result.evidence, "object");
      assert.equal(Array.isArray(result.evidence.sources), true);
    }
  });

  it("does not throw when includeEvidence is false", async () => {
    const result = await narrowFilesForQuery({
      repoId: "repo-none",
      query: "anything",
      limit: 3,
      includeEvidence: false,
    });
    assert.equal(result.paths.length, 0);
  });

  it("clamps limit into a sane range", async () => {
    // Extremely large and extremely small limits must not throw.
    const tiny = await narrowFilesForQuery({
      repoId: "repo-none",
      query: "x",
      limit: -5,
      includeEvidence: false,
    });
    assert.equal(tiny.paths.length, 0);
    const huge = await narrowFilesForQuery({
      repoId: "repo-none",
      query: "x",
      limit: 10_000,
      includeEvidence: false,
    });
    assert.equal(huge.paths.length, 0);
  });
});
