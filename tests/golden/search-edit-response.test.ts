/**
 * Golden contract test for the `sdl.search.edit` response shapes.
 *
 * The plan handle carries server-side preconditions for apply. Agent-visible
 * responses intentionally omit sha/mtime precondition snapshots and AST byte
 * capture internals.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  SearchEditApplyResponse,
  SearchEditPreviewResponse,
} from "../../dist/mcp/tools.js";
import type { RetrievalEvidence } from "../../dist/retrieval/types.js";

describe("sdl.search.edit response golden", () => {
  it("SearchEditPreviewResponse carries planHandle + compact fileEntries", () => {
    const evidence: RetrievalEvidence = {
      sources: ["fts"],
      topRanksPerSource: { fts: [1, 2] },
      candidateCountPerSource: { fts: 2 },
      fusionLatencyMs: 4,
    };
    const response: SearchEditPreviewResponse = {
      mode: "preview",
      planHandle: "se-0123456789abcdef",
      defaultCreateBackup: true,
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
          astMatches: [
            {
              target: { name: "target", nodeType: "identifier", text: "oldName" },
              captures: [{ name: "target", nodeType: "identifier", text: "oldName" }],
            },
          ],
        },
      ],
      requiresApply: true,
      expiresAt: new Date(0).toISOString(),
      retrievalEvidence: evidence,
    };

    const keys = Object.keys(response).sort();
    assert.ok(keys.includes("mode"));
    assert.ok(keys.includes("planHandle"));
    assert.ok(keys.includes("fileEntries"));
    assert.ok(keys.includes("defaultCreateBackup"));
    assert.equal(response.defaultCreateBackup, true);
    assert.equal(keys.includes("preconditionSnapshot"), false);
    assert.ok(Array.isArray(response.fileEntries));
    assert.ok(response.fileEntries.length > 0);

    const entry = response.fileEntries[0];
    assert.equal(entry.editMode, "replacePattern");
    assert.equal(typeof entry.matchCount, "number");
    assert.equal(typeof entry.indexedSource, "boolean");
    assert.equal(typeof entry.snippets.before, "string");
    assert.equal(typeof entry.snippets.after, "string");
    assert.equal(entry.astMatches?.[0]?.target.name, "target");
    assert.equal("startByte" in (entry.astMatches?.[0]?.target ?? {}), false);

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
      defaultCreateBackup: true,
      filesMatched: 0,
      matchesFound: 0,
      filesEligible: 0,
      filesSkipped: [],
      fileEntries: [],
      requiresApply: false,
      expiresAt: new Date(0).toISOString(),
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
      defaultCreateBackup: true,
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
        { file: "a.txt", status: "written", bytes: 42, indexUpdate: { applied: true } },
        { file: "b.txt", status: "written", bytes: 57, indexUpdate: { applied: false, error: "overlay-unavailable" } },
        { file: "c.txt", status: "failed", reason: "EACCES" },
      ],
      rollback: { triggered: true, restoredFiles: ["a.txt", "b.txt"] },
    };

    const statuses = new Set(response.results.map((r) => r.status));
    assert.ok(statuses.has("written"));
    assert.ok(statuses.has("failed"));
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

  it("preview response key set matches golden snapshot", () => {
    const response: SearchEditPreviewResponse = {
      mode: "preview",
      planHandle: "se-keysnap",
      defaultCreateBackup: true,
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
      retrievalEvidence: {
        sources: ["fts"],
        topRanksPerSource: { fts: [1] },
        candidateCountPerSource: { fts: 1 },
      },
    };

    const EXPECTED_PREVIEW_KEYS = [
      "mode", "planHandle", "defaultCreateBackup", "filesMatched", "matchesFound",
      "filesEligible", "filesSkipped", "fileEntries", "requiresApply",
      "expiresAt", "retrievalEvidence",
    ].sort();
    assert.equal(EXPECTED_PREVIEW_KEYS.length, 11, "preview key count drift — update golden keys when interface changes");
    assert.deepEqual(Object.keys(response).sort(), EXPECTED_PREVIEW_KEYS);

    const EXPECTED_ENTRY_KEYS = [
      "file", "matchCount", "editMode", "snippets", "indexedSource",
    ].sort();
    assert.deepEqual(Object.keys(response.fileEntries[0]).sort(), EXPECTED_ENTRY_KEYS);
  });

  it("apply response key set matches golden snapshot", () => {
    const response: SearchEditApplyResponse = {
      mode: "apply",
      planHandle: "se-keysnap-apply",
      filesAttempted: 1,
      filesWritten: 1,
      filesSkipped: 0,
      filesFailed: 0,
      results: [{ file: "a.ts", status: "written", bytes: 100, indexUpdate: { applied: true } }],
      rollback: { triggered: false, restoredFiles: [] },
    };

    const EXPECTED_APPLY_KEYS = [
      "mode", "planHandle", "filesAttempted", "filesWritten",
      "filesSkipped", "filesFailed", "results", "rollback",
    ].sort();
    assert.equal(EXPECTED_APPLY_KEYS.length, 8, "apply key count drift — update golden keys when interface changes");
    assert.deepEqual(Object.keys(response).sort(), EXPECTED_APPLY_KEYS);
  });
});
