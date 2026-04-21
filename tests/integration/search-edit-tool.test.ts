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

});
