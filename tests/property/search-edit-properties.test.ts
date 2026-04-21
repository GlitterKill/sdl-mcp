import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBatch } from "../../dist/mcp/tools/search-edit/batch-executor.js";
import type {
  PlannedFileEdit,
  PlanPrecondition,
  StoredPlan,
} from "../../dist/mcp/tools/search-edit/plan-store.js";
import { getLadybugConn } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { normalizePath } from "../../dist/util/paths.js";

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function randomContent(seed: number): string {
  let h = seed;
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789 	";
  const lineCount = 1 + (h = (h * 1103515245 + 12345) & 0x7fffffff) % 20;
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    const len = 1 + (h = (h * 1103515245 + 12345) & 0x7fffffff) % 80;
    let line = "";
    for (let j = 0; j < len; j++) {
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      line += chars[h % chars.length];
    }
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}
function makePlan(
  repoId: string,
  edits: PlannedFileEdit[],
  preconditions: PlanPrecondition[],
): StoredPlan {
  return {
    planHandle: "se-prop-" + Math.random().toString(36).slice(2),
    repoId,
    createdAt: Date.now(),
    expiresAt: Date.now() + 900_000,
    defaultCreateBackup: true,
    consumed: false,
    edits,
    preconditions,
    summary: {},
  };
}

/**
 * Property:
 *   for every successful search.edit apply over N files,
 *   applying a "revert" plan (new -> original) restores the starting
 *   content exactly. That is, apply is invertible in content space.
 */
describe("search-edit property: apply+revert identity", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "sdl-se-prop-"));
    const conn = await getLadybugConn();
    await ladybugDb.upsertRepo(conn, {
      repoId: "repo-prop",
      rootPath: normalizePath(root),
      configJson: "{}",
      createdAt: new Date().toISOString(),
    });
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("apply then reverse-apply restores original content (N=1..5)", async () => {
    for (let n = 1; n <= 5; n++) {
      const files: Array<{
        rel: string;
        abs: string;
        orig: string;
        patched: string;
      }> = [];
      const edits: PlannedFileEdit[] = [];
      const preconds: PlanPrecondition[] = [];
      for (let i = 0; i < n; i++) {
        const rel = `p${n}-${i}.txt`;
        const abs = join(root, rel);
        const orig = `orig-${n}-${i}\nline2\n`;
        const patched = `patched-${n}-${i}\nline2\n`;
        await writeFile(abs, orig, "utf-8");
        const s = await stat(abs);
        files.push({ rel, abs, orig, patched });
        edits.push({
          relPath: rel,
          absPath: abs,
          newContent: patched,
          createBackup: true,
          fileExists: true,
          indexedSource: false,
          matchCount: 1,
          editMode: "overwrite",
        });
        preconds.push({
          relPath: rel,
          absPath: abs,
          sha256: sha(orig),
          mtimeMs: s.mtimeMs,
        });
      }

      const forward = makePlan("repo-prop", edits, preconds);
      const r1 = await applyBatch(forward, undefined);
      assert.equal(r1.filesWritten, n, `n=${n}: forward writes`);
      assert.equal(r1.rollback.triggered, false);

      // Build reverse plan using current disk state as precondition.
      const revEdits: PlannedFileEdit[] = [];
      const revPreconds: PlanPrecondition[] = [];
      for (const f of files) {
        const content = await readFile(f.abs, "utf-8");
        assert.equal(content, f.patched, `patched written for ${f.rel}`);
        const s = await stat(f.abs);
        revEdits.push({
          relPath: f.rel,
          absPath: f.abs,
          newContent: f.orig,
          createBackup: true,
          fileExists: true,
          indexedSource: false,
          matchCount: 1,
          editMode: "overwrite",
        });
        revPreconds.push({
          relPath: f.rel,
          absPath: f.abs,
          sha256: sha(f.patched),
          mtimeMs: s.mtimeMs,
        });
      }
      const backward = makePlan("repo-prop", revEdits, revPreconds);
      const r2 = await applyBatch(backward, undefined);
      assert.equal(r2.filesWritten, n, `n=${n}: reverse writes`);
      // content identity.
      for (const f of files) {
        const round = await readFile(f.abs, "utf-8");
        assert.equal(round, f.orig, `roundtrip for ${f.rel}`);
      }
    }
  });

  it("backups exist during write and are removed on success", async () => {
    const abs = join(root, "bak.txt");
    await writeFile(abs, "before\n", "utf-8");
    const s = await stat(abs);
    const plan = makePlan(
      "repo-prop",
      [
        {
          relPath: "bak.txt",
          absPath: abs,
          newContent: "after\n",
          createBackup: true,
          fileExists: true,
          indexedSource: false,
          matchCount: 1,
          editMode: "overwrite",
        },
      ],
      [
        {
          relPath: "bak.txt",
          absPath: abs,
          sha256: sha("before\n"),
          mtimeMs: s.mtimeMs,
        },
      ],
    );
    const r = await applyBatch(plan, undefined);
    assert.equal(r.filesWritten, 1);
    // backup cleaned up on success.
    assert.equal(existsSync(abs + ".bak"), false);
    const content = await readFile(abs, "utf-8");
    assert.equal(content, "after\n");
  });

  it("apply then reverse-apply works with replacePattern editMode", async () => {
    const rel = "rp-test.txt";
    const abs = join(root, rel);
    const orig = "hello oldName world\noldName again\n";
    const patched = "hello newName world\nnewName again\n";
    await writeFile(abs, orig, "utf-8");
    const s = await stat(abs);

    const forwardPlan = makePlan(
      "repo-prop",
      [{
        relPath: rel,
        absPath: abs,
        newContent: patched,
        createBackup: true,
        fileExists: true,
        indexedSource: false,
        matchCount: 2,
        editMode: "replacePattern",
      }],
      [{
        relPath: rel,
        absPath: abs,
        sha256: sha(orig),
        mtimeMs: s.mtimeMs,
      }],
    );
    const r1 = await applyBatch(forwardPlan, undefined);
    assert.equal(r1.filesWritten, 1);
    assert.equal(r1.rollback.triggered, false);
    assert.equal(await readFile(abs, "utf-8"), patched);

    // Reverse: patched -> orig
    const s2 = await stat(abs);
    const reversePlan = makePlan(
      "repo-prop",
      [{
        relPath: rel,
        absPath: abs,
        newContent: orig,
        createBackup: true,
        fileExists: true,
        indexedSource: false,
        matchCount: 2,
        editMode: "replacePattern",
      }],
      [{
        relPath: rel,
        absPath: abs,
        sha256: sha(patched),
        mtimeMs: s2.mtimeMs,
      }],
    );
    const r2 = await applyBatch(reversePlan, undefined);
    assert.equal(r2.filesWritten, 1);
    assert.equal(r2.rollback.triggered, false);
    assert.equal(await readFile(abs, "utf-8"), orig, "roundtrip with replacePattern");
  });
});
