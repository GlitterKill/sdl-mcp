/**
 * Smoke integration test for sdl.search.edit.
 *
 * Covers:
 *  - preview returns a planHandle + file entries + preconditions
 *  - apply with fresh handle writes all files and surfaces indexUpdate
 *    for indexed source
 *  - apply with an unknown handle fails closed
 *  - apply after a file drifts fails closed and writes nothing
 *
 * Kept narrow on purpose. Full matrix (LRU eviction, TTL expiry,
 * backup rollback on mid-batch failure, golden snapshots, property
 * tests) is tracked in devdocs/plans/tool-enhancement-plan.md.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleSearchEdit } from "../../dist/mcp/tools/search-edit/index.js";
import { handleResponseGet } from "../../dist/mcp/tools/response.js";
import { resetSearchEditPlanStore } from "../../dist/mcp/tools/search-edit/plan-store.js";
import {
  SearchEditRequestSchema,
  type SearchEditApplyResponse,
  type SearchEditPreviewResponse,
} from "../../dist/mcp/tools.js";
import { getLadybugConn, initLadybugDb, closeLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { normalizePath } from "../../dist/util/paths.js";

const REPO_ID = "search-edit-smoke";

let repoRoot: string;

async function ensureRepoRegistered(root: string): Promise<void> {
  const conn = await getLadybugConn();
  const existing = await ladybugDb.getRepo(conn, REPO_ID);
  if (existing) {
    if (normalizePath(existing.rootPath) === normalizePath(root)) return;
    // Different root; re-register.
  }
  await ladybugDb.upsertRepo(conn, {
    repoId: REPO_ID,
    rootPath: root,
    configJson: "{}",
    createdAt: new Date().toISOString(),
  });
}

describe("sdl.search.edit", { concurrency: false }, () => {
  before(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "sdl-search-edit-"));
    await writeFile(
      join(repoRoot, "a.txt"),
      "hello oldName world\nsecond oldName line\n",
      "utf-8",
    );
    await writeFile(join(repoRoot, "b.txt"), "third oldName line\n", "utf-8");
    await writeFile(join(repoRoot, "unrelated.txt"), "nothing here\n", "utf-8");
    await initLadybugDb(join(repoRoot, "test.lbug"));
    await ensureRepoRegistered(repoRoot);
    resetSearchEditPlanStore();
  });

  after(async () => {
    await closeLadybugDb();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("preview returns planHandle and per-file entries", async () => {
    const req = SearchEditRequestSchema.parse({
      mode: "preview",
      repoId: REPO_ID,
      targeting: "text",
      query: {
        literal: "oldName",
        replacement: "newName",
        global: true,
      },
      editMode: "replacePattern",
      filters: { extensions: [".txt"] },
    });
    const response = (await handleSearchEdit(req)) as SearchEditPreviewResponse;

    assert.equal(response.mode, "preview");
    assert.ok(response.planHandle.startsWith("se-"));
    assert.equal(response.filesMatched, 2);
    assert.ok(response.matchesFound >= 2);
    assert.ok(response.requiresApply);
    assert.equal(response.preconditionSnapshot.length, 2);
    const files = response.fileEntries.map((e) => e.file).sort();
    assert.deepEqual(files, ["a.txt", "b.txt"]);
  });

  it("preview can spill the large response behind response.get", async () => {
    const req = SearchEditRequestSchema.parse({
      mode: "preview",
      repoId: REPO_ID,
      targeting: "text",
      query: {
        literal: "oldName",
        replacement: "newName",
        global: true,
      },
      editMode: "replacePattern",
      filters: { extensions: [".txt"] },
      responseMode: "handle",
    });
    const response = (await handleSearchEdit(req)) as Record<string, unknown>;

    assert.equal(response.responseMode, "handle");
    assert.equal(response.kind, "responseArtifact");
    assert.equal(
      (response.metadata as Record<string, unknown>).toolName,
      "sdl.search.edit",
    );

    const full = await handleResponseGet({
      repoId: REPO_ID,
      handle: response.handle,
      full: true,
    }) as Record<string, unknown>;
    const preview = full.content as SearchEditPreviewResponse;
    assert.equal(preview.mode, "preview");
    assert.ok(preview.planHandle.startsWith("se-"));
    assert.equal(preview.filesMatched, 2);
  });

  it("apply writes all files and removes backups on success", async () => {
    const previewReq = SearchEditRequestSchema.parse({
      mode: "preview",
      repoId: REPO_ID,
      targeting: "text",
      query: { literal: "oldName", replacement: "newName", global: true },
      editMode: "replacePattern",
      filters: { extensions: [".txt"] },
    });
    const preview = (await handleSearchEdit(
      previewReq,
    )) as SearchEditPreviewResponse;

    const applyReq = SearchEditRequestSchema.parse({
      mode: "apply",
      repoId: REPO_ID,
      planHandle: preview.planHandle,
    });
    const apply = (await handleSearchEdit(applyReq)) as SearchEditApplyResponse;

    assert.equal(apply.mode, "apply");
    assert.equal(apply.filesWritten, 2);
    assert.equal(apply.filesFailed, 0);
    assert.equal(apply.rollback.triggered, false);
    assert.equal(apply.fileEntries?.length, preview.fileEntries.length);
    assert.match(apply.fileEntries?.[0]?.snippets.before ?? "", /oldName/);
    assert.match(apply.fileEntries?.[0]?.snippets.after ?? "", /newName/);

    const a = await readFile(join(repoRoot, "a.txt"), "utf-8");
    const b = await readFile(join(repoRoot, "b.txt"), "utf-8");
    assert.ok(a.includes("newName"));
    assert.ok(b.includes("newName"));
    assert.ok(!a.includes("oldName"));
    assert.ok(!b.includes("oldName"));
  });

  it("apply with unknown planHandle fails closed", async () => {
    const applyReq = SearchEditRequestSchema.parse({
      mode: "apply",
      repoId: REPO_ID,
      planHandle: "se-bogus-deadbeef",
    });
    await assert.rejects(
      () => handleSearchEdit(applyReq),
      /missing or expired/i,
    );
  });

  it("apply after drift fails closed and writes nothing further", async () => {
    // Reset content so preview sees "oldName".
    await writeFile(join(repoRoot, "a.txt"), "oldName again\n", "utf-8");
    await writeFile(join(repoRoot, "b.txt"), "oldName again\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "text",
        query: { literal: "oldName", replacement: "newName", global: true },
        editMode: "replacePattern",
        filters: { extensions: [".txt"] },
      }),
    )) as SearchEditPreviewResponse;

    // Drift one file between preview and apply.
    await writeFile(
      join(repoRoot, "a.txt"),
      "someone else got there first\n",
      "utf-8",
    );

    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "apply",
            repoId: REPO_ID,
            planHandle: preview.planHandle,
          }),
        ),
      /drifted/i,
    );

    // b.txt must NOT have been written — drift check aborts before the
    // first write.
    const b = await readFile(join(repoRoot, "b.txt"), "utf-8");
    assert.ok(b.includes("oldName"));
  });

  it("preview populates retrievalEvidence when hybrid narrowing runs", async () => {
    // Reset content so preview has a literal match of >=3 chars.
    await writeFile(
      join(repoRoot, "a.txt"),
      "hello oldName world\n",
      "utf-8",
    );
    await writeFile(join(repoRoot, "b.txt"), "oldName line\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "text",
        query: {
          literal: "oldName",
          replacement: "newName",
          global: true,
        },
        editMode: "replacePattern",
        filters: { extensions: [".txt"] },
      }),
    )) as SearchEditPreviewResponse;

    // Any literal of length >= 3 routes through narrowFilesForQuery ->
    // entitySearch(..., includeEvidence: true). Even when the hybrid
    // backend is degraded (no FTS index built on this temp repo, no
    // vector model available), entitySearch returns a fallback-evidence
    // payload so callers can reason about *why* narrowing produced no
    // candidates. The planner copies that through unchanged.
    assert.ok(
      preview.retrievalEvidence,
      "retrievalEvidence should be populated for text-mode preview with hybrid narrowing",
    );
    const ev = preview.retrievalEvidence!;
    assert.ok(
      Array.isArray(ev.sources),
      "retrievalEvidence.sources must be an array",
    );
    assert.ok(
      ev.topRanksPerSource &&
        typeof ev.topRanksPerSource === "object",
      "retrievalEvidence.topRanksPerSource must be an object",
    );
    assert.ok(
      ev.candidateCountPerSource &&
        typeof ev.candidateCountPerSource === "object",
      "retrievalEvidence.candidateCountPerSource must be an object",
    );
    // Either the hybrid path produced real sources OR the orchestrator
    // recorded a fallbackReason describing why. Never both empty.
    const hasSources = ev.sources.length > 0;
    const hasFallback =
      typeof ev.fallbackReason === "string" && ev.fallbackReason.length > 0;
    assert.ok(
      hasSources || hasFallback,
      `retrievalEvidence should expose sources or fallbackReason; got ${JSON.stringify(ev)}`,
    );
  });

  it("apply rejects an expired planHandle (fail-closed on TTL)", async () => {
    // Swap in a store with a tiny TTL so we can expire a handle deterministically.
    resetSearchEditPlanStore({ ttlMs: 5 });
    try {
      const expiringRel = "expired.txt";
      await writeFile(
        join(repoRoot, expiringRel),
        "original\n",
        "utf-8",
      );

      const preview = (await handleSearchEdit(
        SearchEditRequestSchema.parse({
          mode: "preview",
          repoId: REPO_ID,
          targeting: "text",
          query: {
            literal: "original",
            replacement: "replaced",
            global: true,
          },
          editMode: "replacePattern",
          filters: { extensions: [".txt"], include: [expiringRel] },
        }),
      )) as SearchEditPreviewResponse;
      assert.ok(preview.planHandle, "preview should return a handle");

      // Let the TTL expire.
      await new Promise((resolve) => setTimeout(resolve, 30));

      await assert.rejects(
        () =>
          handleSearchEdit(
            SearchEditRequestSchema.parse({
              mode: "apply",
              repoId: REPO_ID,
              planHandle: preview.planHandle,
            }),
          ),
        /expired|not.*found|unknown|invalid/i,
        "apply must reject expired handles",
      );

      // Disk content unchanged.
      const content = await readFile(join(repoRoot, expiringRel), "utf-8");
      assert.equal(content, "original\n");
    } finally {
      // Restore the default store for other tests.
      resetSearchEditPlanStore();
    }
  });



  it("double-apply with same planHandle fails closed (M4)", async () => {
    // Reset content so preview has matches.
    await writeFile(join(repoRoot, "a.txt"), "oldName here\n", "utf-8");
    await writeFile(join(repoRoot, "b.txt"), "oldName there\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "text",
        query: { literal: "oldName", replacement: "newName", global: true },
        editMode: "replacePattern",
        filters: { extensions: [".txt"] },
      }),
    )) as SearchEditPreviewResponse;

    // First apply should succeed.
    const apply1 = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    )) as SearchEditApplyResponse;
    assert.equal(apply1.mode, "apply");
    assert.ok(apply1.filesWritten >= 1);

    // Second apply with same handle must fail.
    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "apply",
            repoId: REPO_ID,
            planHandle: preview.planHandle,
          }),
        ),
      /missing or expired/i,
    );
  });
  it("apply with mismatched repoId fails closed (M5)", async () => {
    // Reset content so preview has matches.
    await writeFile(join(repoRoot, "a.txt"), "oldName here\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "text",
        query: { literal: "oldName", replacement: "newName", global: true },
        editMode: "replacePattern",
        filters: { extensions: [".txt"] },
      }),
    )) as SearchEditPreviewResponse;

    // Apply with wrong repoId must fail referencing the original repoId.
    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "apply",
            repoId: "wrong-repo-id",
            planHandle: preview.planHandle,
          }),
        ),
      new RegExp(REPO_ID),
    );
  });

  it("batch preview/apply merges two operations in one file", async () => {
    await writeFile(join(repoRoot, "a.txt"), "alpha beta\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        operations: [
          {
            id: "alpha-op",
            targeting: "text",
            query: { literal: "alpha", replacement: "ALPHA", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
          {
            id: "beta-op",
            targeting: "text",
            query: { literal: "beta", replacement: "BETA", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.matchesFound, 2);
    assert.deepEqual((preview.fileEntries[0] as any).operationIds, ["alpha-op", "beta-op"]);

    const apply = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    )) as SearchEditApplyResponse;

    assert.equal(apply.filesWritten, 1);
    assert.equal(await readFile(join(repoRoot, "a.txt"), "utf-8"), "ALPHA BETA\n");
  });

  it("batch preview/apply supports operations across multiple files", async () => {
    await writeFile(join(repoRoot, "a.txt"), "left token\n", "utf-8");
    await writeFile(join(repoRoot, "b.txt"), "right token\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        operations: [
          {
            id: "left-op",
            targeting: "text",
            query: { literal: "left", replacement: "LEFT", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
          {
            id: "right-op",
            targeting: "text",
            query: { literal: "right", replacement: "RIGHT", global: true },
            editMode: "replacePattern",
            filters: { include: ["b.txt"] },
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 2);
    assert.deepEqual(
      preview.fileEntries.map((entry) => [(entry as any).operationIds[0], entry.file]).sort(),
      [["left-op", "a.txt"], ["right-op", "b.txt"]],
    );

    await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    );

    assert.equal(await readFile(join(repoRoot, "a.txt"), "utf-8"), "LEFT token\n");
    assert.equal(await readFile(join(repoRoot, "b.txt"), "utf-8"), "RIGHT token\n");
  });

  it("batch apply only merges each operation's planned original-source diff", async () => {
    await writeFile(join(repoRoot, "a.txt"), "foo marker\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        operations: [
          {
            id: "foo-to-bar",
            targeting: "text",
            query: { literal: "foo", replacement: "bar", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
          {
            id: "bar-to-baz",
            targeting: "text",
            query: { literal: "bar", replacement: "baz", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.matchesFound, 1);
    await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    );

    assert.equal(await readFile(join(repoRoot, "a.txt"), "utf-8"), "bar marker\n");
  });

  it("batch preview applies shared top-level filters to operations", async () => {
    await writeFile(join(repoRoot, "a.txt"), "shared token\n", "utf-8");
    await writeFile(join(repoRoot, "b.txt"), "shared token\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        filters: { include: ["a.txt"] },
        operations: [
          {
            id: "shared-op",
            targeting: "text",
            query: { literal: "shared", replacement: "SHARED", global: true },
            editMode: "replacePattern",
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.fileEntries[0].file, "a.txt");
  });

  it("batch preview permits disjoint edits when one operation has multiple matches", async () => {
    await writeFile(join(repoRoot, "a.txt"), "a x a\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        operations: [
          {
            id: "a-op",
            targeting: "text",
            query: { literal: "a", replacement: "A", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
          {
            id: "x-op",
            targeting: "text",
            query: { literal: "x", replacement: "X", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 1);
    assert.equal(preview.matchesFound, 3);

    await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: preview.planHandle,
      }),
    );

    assert.equal(await readFile(join(repoRoot, "a.txt"), "utf-8"), "A X A\n");
  });

  it("batch preview rejects zero-width edits inside another operation range", async () => {
    await writeFile(join(repoRoot, "a.txt"), "abcdef\n", "utf-8");

    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "preview",
            repoId: REPO_ID,
            operations: [
              {
                id: "replace-cde",
                targeting: "text",
                query: { literal: "cde", replacement: "XY", global: true },
                editMode: "replacePattern",
                filters: { include: ["a.txt"] },
              },
              {
                id: "insert-before-d",
                targeting: "text",
                query: { regex: "(?=d)", replacement: "_", global: true },
                editMode: "replacePattern",
                filters: { include: ["a.txt"] },
              },
            ],
          }),
        ),
      /replace-cde.*insert-before-d.*overlap/i,
    );
  });

  it("batch preview enforces aggregate top-level match caps", async () => {
    await writeFile(join(repoRoot, "a.txt"), "alpha beta\n", "utf-8");

    const preview = (await handleSearchEdit(
      SearchEditRequestSchema.parse({
        mode: "preview",
        repoId: REPO_ID,
        maxMatchesPerFile: 1,
        maxTotalMatches: 1,
        operations: [
          {
            id: "alpha-op",
            targeting: "text",
            query: { literal: "alpha", replacement: "ALPHA", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
          {
            id: "beta-op",
            targeting: "text",
            query: { literal: "beta", replacement: "BETA", global: true },
            editMode: "replacePattern",
            filters: { include: ["a.txt"] },
          },
        ],
      }),
    )) as SearchEditPreviewResponse;

    assert.equal(preview.filesMatched, 0);
    assert.equal(preview.matchesFound, 0);
    assert.ok(
      preview.filesSkipped.some((entry) =>
        entry.reason.startsWith("matches-exceed-per-file-cap:"),
      ),
    );
  });

  it("batch preview rejects overlapping operation ranges", async () => {
    await writeFile(join(repoRoot, "a.txt"), "one\ntwo\n", "utf-8");

    await assert.rejects(
      () =>
        handleSearchEdit(
          SearchEditRequestSchema.parse({
            mode: "preview",
            repoId: REPO_ID,
            operations: [
              {
                id: "first",
                targeting: "text",
                query: { literal: "one", replaceLines: { start: 0, end: 1, content: "ONE" } },
                editMode: "replaceLines",
                filters: { include: ["a.txt"] },
              },
              {
                id: "second",
                targeting: "text",
                query: { literal: "one", replaceLines: { start: 0, end: 1, content: "TWO" } },
                editMode: "replaceLines",
                filters: { include: ["a.txt"] },
              },
            ],
          }),
        ),
      /first.*second.*a\.txt.*overlap/i,
    );
  });

  it("batch preview rejects duplicate explicit operation ids", async () => {
    await writeFile(join(repoRoot, "a.txt"), "alpha beta\n", "utf-8");

    await assert.rejects(
      async () => {
        const request = SearchEditRequestSchema.parse({
          mode: "preview",
          repoId: REPO_ID,
          operations: [
            {
              id: "rename",
              targeting: "text",
              query: { literal: "alpha", replacement: "ALPHA", global: true },
              editMode: "replacePattern",
              filters: { include: ["a.txt"] },
            },
            {
              id: "rename",
              targeting: "text",
              query: { literal: "beta", replacement: "BETA", global: true },
              editMode: "replacePattern",
              filters: { include: ["a.txt"] },
            },
          ],
        });
        await handleSearchEdit(request);
      },
      /duplicate.*operation.*rename/i,
    );
  });

});
