/**
 * Golden contract test for the `sdl.search.edit` response shapes.
 *
 * Validates that `SearchEditPreviewResponse` and `SearchEditApplyResponse`
 * carry the fields the tool-enhancement plan promised (planHandle, per-file
 * entries, preconditions, rollback metadata, retrievalEvidence). Shape
 * drift here is a public-API break.
 *
 * Modeled on `scip-ingest-response.test.ts` — structural golden, does not
 * require a running server or live index. Live-server golden snapshots
 * (`search-edit-preview.json`, `search-edit-apply.json`, and the
 * `sdl.action.search` fixture that picks up the new tool) are regenerated
 * via `npm run golden:update` in environments that can boot the stdio
 * server; the plan's deferred items document that.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  SearchEditApplyResponse,
  SearchEditPreviewResponse,
} from "../../dist/mcp/tools.js";
import type { RetrievalEvidence } from "../../dist/retrieval/types.js";

// These tests validate response interfaces at compile time (TypeScript type
// checking) and detect field drift at runtime (key-set snapshots). Value
// assertions on hand-crafted literals are intentionally minimal since the
// primary value is ensuring the interface shape remains stable.
describe("sdl.search.edit response golden", () => {
  it("SearchEditPreviewResponse carries planHandle + fileEntries + preconditions", () => {
    const evidence: RetrievalEvidence = {
      sources: ["fts"],
      topRanksPerSource: { fts: [1, 2] },
      candidateCountPerSource: { fts: 2 },
      fusionLatencyMs: 4,
    };
    const response: SearchEditPreviewResponse = {
      mode: "preview",
      planHandle: "se-0123456789abcdef",
      filesMatched: 2,
      matchesFound: 3,
      filesEligible: 4,
      filesSkipped: [{ path: "node_modules/x.ts", reason: "excluded" }],
      fileEntries: [
        {
          file: "a.txt",
          matchCount: 2,
          editMode: "replacePattern",
          snippets: { before: "oldName", after: "newName" },
          indexedSource: false,
        },
      ],
      requiresApply: true,
      expiresAt: new Date(0).toISOString(),
      preconditionSnapshot: [
        { file: "a.txt", sha256: "deadbeef", mtimeMs: 1 },
        { file: "b.txt", sha256: null, mtimeMs: null },
      ],
      retrievalEvidence: evidence,
    };

    // Structural shape validation — compile-time type check is the primary guard;
    // these runtime checks verify the object is well-formed for downstream consumers.
    const keys = Object.keys(response).sort();
    assert.ok(keys.includes("mode"));
    assert.ok(keys.includes("planHandle"));
    assert.ok(keys.includes("fileEntries"));
    assert.ok(keys.includes("preconditionSnapshot"));
    assert.ok(Array.isArray(response.fileEntries));
    assert.ok(Array.isArray(response.preconditionSnapshot));
    assert.ok(response.fileEntries.length > 0);

    const entry = response.fileEntries[0];
    assert.equal(entry.editMode, "replacePattern");
    assert.equal(typeof entry.matchCount, "number");
    assert.equal(typeof entry.indexedSource, "boolean");
    assert.equal(typeof entry.snippets.before, "string");
    assert.equal(typeof entry.snippets.after, "string");

    const pc = response.preconditionSnapshot[0];
    assert.equal(typeof pc.file, "string");
    // sha256 and mtimeMs are nullable to support freshly-created files.
    assert.ok(pc.sha256 === null || typeof pc.sha256 === "string");
    assert.ok(pc.mtimeMs === null || typeof pc.mtimeMs === "number");

    assert.ok(response.retrievalEvidence);
    assert.ok(Array.isArray(response.retrievalEvidence!.sources));
    assert.ok(
      response.retrievalEvidence!.topRanksPerSource &&
        typeof response.retrievalEvidence!.topRanksPerSource === "object",
    );
    assert.ok(
      response.retrievalEvidence!.candidateCountPerSource &&
        typeof response.retrievalEvidence!.candidateCountPerSource === "object",
    );
  });

  it("SearchEditPreviewResponse accepts fallback-only retrievalEvidence", () => {
    const response: SearchEditPreviewResponse = {
      mode: "preview",
      planHandle: "se-fallback-path",
      filesMatched: 0,
      matchesFound: 0,
      filesEligible: 0,
      filesSkipped: [],
      fileEntries: [],
      requiresApply: false,
      expiresAt: new Date(0).toISOString(),
      preconditionSnapshot: [],
      retrievalEvidence: {
        sources: [],
        topRanksPerSource: {},
        candidateCountPerSource: {},
        fallbackReason: "fallback-to-legacy: retrieval unavailable",
      },
    };

    assert.equal(response.requiresApply, false);
    assert.ok(response.retrievalEvidence);
    assert.equal(response.retrievalEvidence!.sources.length, 0);
    assert.equal(typeof response.retrievalEvidence!.fallbackReason, "string");
  });

  it("SearchEditPreviewResponse allows retrievalEvidence to be omitted for symbol targeting", () => {
    const response: SearchEditPreviewResponse = {
      mode: "preview",
      planHandle: "se-symbol-target",
      filesMatched: 1,
      matchesFound: 1,
      filesEligible: 1,
      filesSkipped: [],
      fileEntries: [
        {
          file: "src/foo.ts",
          matchCount: 1,
          editMode: "replaceLines",
          snippets: { before: "", after: "" },
          indexedSource: true,
        },
      ],
      requiresApply: true,
      expiresAt: new Date(0).toISOString(),
      preconditionSnapshot: [],
    };
    assert.equal(response.retrievalEvidence, undefined);
  });

  it("SearchEditApplyResponse carries per-file results + rollback metadata", () => {
    const response: SearchEditApplyResponse = {
      mode: "apply",
      planHandle: "se-apply-123",
      filesAttempted: 3,
      filesWritten: 2,
      filesSkipped: 0,
      filesFailed: 1,
      results: [
        {
          file: "a.txt",
          status: "written",
          bytes: 42,
          indexUpdate: { applied: true },
        },
        {
          file: "b.txt",
          status: "written",
          bytes: 57,
          indexUpdate: {
            applied: false,
            error: "overlay-unavailable",
          },
        },
        {
          file: "c.txt",
          status: "failed",
          reason: "EACCES",
        },
      ],
      rollback: {
        triggered: true,
        restoredFiles: ["a.txt", "b.txt"],
      },
    };

    // Structural: verify results array has all expected status variants
    const statuses = new Set(response.results.map((r) => r.status));
    assert.ok(statuses.has("written"));
    assert.ok(statuses.has("failed"));
    assert.ok(response.results.length === 3);
    assert.ok(Array.isArray(response.rollback.restoredFiles));
  });

  it("SearchEditApplyResponse allows no-op apply (zero files written)", () => {
    const response: SearchEditApplyResponse = {
      mode: "apply",
      planHandle: "se-noop",
      filesAttempted: 0,
      filesWritten: 0,
      filesSkipped: 0,
      filesFailed: 0,
      results: [],
      rollback: { triggered: false, restoredFiles: [] },
    };
    assert.equal(response.results.length, 0);
    assert.equal(response.rollback.triggered, false);
    assert.equal(response.rollback.restoredFiles.length, 0);
  });


  it("preview response key set matches golden snapshot (catches field drift)", () => {
    const response: SearchEditPreviewResponse = {
      mode: "preview",
      planHandle: "se-keysnap",
      filesMatched: 1,
      matchesFound: 1,
      filesEligible: 5,
      filesSkipped: [],
      fileEntries: [{
        file: "a.ts",
        matchCount: 1,
        editMode: "replacePattern",
        snippets: { before: "", after: "" },
        indexedSource: true,
      }],
      requiresApply: true,
      expiresAt: "2026-01-01T00:00:00.000Z",
      preconditionSnapshot: [{ file: "a.ts", sha256: "abc", mtimeMs: 1 }],
      retrievalEvidence: {
        sources: ["fts"],
        topRanksPerSource: { fts: [1] },
        candidateCountPerSource: { fts: 1 },
      },
    };

    const EXPECTED_PREVIEW_KEYS = [
      "mode", "planHandle", "filesMatched", "matchesFound",
      "filesEligible", "filesSkipped", "fileEntries", "requiresApply",
      "expiresAt", "preconditionSnapshot", "retrievalEvidence",
    ].sort();
    assert.equal(EXPECTED_PREVIEW_KEYS.length, 11, "preview key count drift — update golden keys when interface changes");
    assert.deepEqual(Object.keys(response).sort(), EXPECTED_PREVIEW_KEYS);

    const EXPECTED_ENTRY_KEYS = [
      "file", "matchCount", "editMode", "snippets", "indexedSource",
    ].sort();
    assert.deepEqual(Object.keys(response.fileEntries[0]).sort(), EXPECTED_ENTRY_KEYS);
  });

  it("apply response key set matches golden snapshot (catches field drift)", () => {
    const response: SearchEditApplyResponse = {
      mode: "apply",
      planHandle: "se-keysnap-apply",
      filesAttempted: 1,
      filesWritten: 1,
      filesSkipped: 0,
      filesFailed: 0,
      results: [{
        file: "a.ts",
        status: "written",
        bytes: 100,
        indexUpdate: { applied: true },
      }],
      rollback: { triggered: false, restoredFiles: [] },
    };

    const EXPECTED_APPLY_KEYS = [
      "mode", "planHandle", "filesAttempted", "filesWritten",
      "filesSkipped", "filesFailed", "results", "rollback",
    ].sort();
    assert.equal(EXPECTED_APPLY_KEYS.length, 8, "apply key count drift — update golden keys when interface changes");
    assert.deepEqual(Object.keys(response).sort(), EXPECTED_APPLY_KEYS);

    const EXPECTED_RESULT_KEYS = [
      "file", "status", "bytes", "indexUpdate",
    ].sort();
    assert.deepEqual(Object.keys(response.results[0]).sort(), EXPECTED_RESULT_KEYS);
  });
});
