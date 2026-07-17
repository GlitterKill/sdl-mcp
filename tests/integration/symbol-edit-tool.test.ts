import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, readFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  getDefaultLiveIndexCoordinator,
  getDefaultOverlayStore,
  resetDefaultLiveIndexCoordinator,
  waitForDefaultLiveIndexIdle,
} from "../../dist/live-index/coordinator.js";
import { handleSymbolEdit } from "../../dist/mcp/tools/symbol-edit/index.js";
import { resetSearchEditPlanStore } from "../../dist/mcp/tools/search-edit/plan-store.js";
import type {
  SymbolEditApplyResponse,
  SymbolEditPreviewResponse,
} from "../../dist/mcp/tools.js";

const REPO_ID = "symbol-edit-smoke";
const FILE_ID = "file-auth";
const SYMBOL_ID = "sym-handle-auth";
const REL_PATH = "src/auth.ts";
const PY_FILE_ID = "file-tool-py";
const PY_SYMBOL_ID = "sym-run-py";
const PY_REL_PATH = "src/tool.py";
const RANGE = { startLine: 1, startCol: 0, endLine: 3, endCol: 1 };
const FINGERPRINT = "fp-auth-1";

let repoRoot: string;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function seedFile(content: string): Promise<void> {
  const absPath = join(repoRoot, "src", "auth.ts");
  await writeFile(absPath, content, "utf-8");
  const conn = await getLadybugConn();
  const stats = await stat(absPath);
  await ladybugDb.upsertRepo(conn, {
    repoId: REPO_ID,
    rootPath: repoRoot,
    configJson: "{}",
    createdAt: new Date().toISOString(),
  });
  await ladybugDb.upsertFile(conn, {
    fileId: FILE_ID,
    repoId: REPO_ID,
    relPath: REL_PATH,
    contentHash: sha256(content),
    language: "typescript",
    byteSize: Buffer.byteLength(content, "utf-8"),
    lastIndexedAt: new Date().toISOString(),
  });
  await ladybugDb.upsertSymbol(conn, {
    symbolId: SYMBOL_ID,
    repoId: REPO_ID,
    fileId: FILE_ID,
    kind: "function",
    name: "handleAuth",
    exported: true,
    visibility: "exported",
    language: "typescript",
    rangeStartLine: RANGE.startLine,
    rangeStartCol: RANGE.startCol,
    rangeEndLine: RANGE.endLine,
    rangeEndCol: RANGE.endCol,
    astFingerprint: FINGERPRINT,
    signatureJson: JSON.stringify({ name: "handleAuth", returns: "boolean" }),
    summary: "Handles auth",
    invariantsJson: JSON.stringify([]),
    sideEffectsJson: JSON.stringify([]),
    updatedAt: new Date().toISOString(),
  });
  assert.equal(stats.isFile(), true);
}

describe("sdl.symbol.edit", { concurrency: false }, () => {
  before(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "sdl-symbol-edit-"));
    await initLadybugDb(join(repoRoot, "symbol-edit.lbug"));
    await writeFile(join(repoRoot, "package.json"), "{}", "utf-8");
    await rm(join(repoRoot, "src"), { recursive: true, force: true });
    await mkdir(join(repoRoot, "src"), { recursive: true });
  });

  beforeEach(async () => {
    resetSearchEditPlanStore();
    resetDefaultLiveIndexCoordinator();
    await seedFile("export function handleAuth(): boolean {\n  return false;\n}\n");
  });

  after(async () => {
    await closeLadybugDb();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("previews and applies a saved-file symbol edit", async () => {
    const preview = (await handleSymbolEdit({
      mode: "preview",
      repoId: REPO_ID,
      symbolId: SYMBOL_ID,
      operation: { kind: "replaceBody", content: "return true;\n" },
    })) as SymbolEditPreviewResponse;

    assert.equal(preview.mode, "preview");
    assert.equal(preview.symbolId, SYMBOL_ID);
    assert.equal(preview.writeTarget, "file");
    assert.equal(preview.validation.parseAfter, true);
    assert.ok(preview.planHandle.startsWith("se-"));
    assert.equal(preview.fileEntries[0]?.snippets.beforeStartLine, 1);
    assert.match(preview.fileEntries[0]?.snippets.before ?? "", />2 \|   return false;/);
    assert.match(preview.fileEntries[0]?.snippets.after ?? "", />2 \|   return true;/);

    const apply = (await handleSymbolEdit({
      mode: "apply",
      repoId: REPO_ID,
      planHandle: preview.planHandle,
    })) as SymbolEditApplyResponse;

    assert.equal(apply.mode, "apply");
    assert.equal(apply.filesWritten, 1);
    assert.equal(apply.filesFailed, 0);
    assert.equal(apply.writeTarget, "file");
    assert.equal(
      await readFile(join(repoRoot, "src", "auth.ts"), "utf-8"),
      "export function handleAuth(): boolean {\n  return true;\n}\n",
    );
  });

  it("rejects apply when the saved file sha drifts after preview", async () => {
    const preview = (await handleSymbolEdit({
      mode: "preview",
      repoId: REPO_ID,
      symbolId: SYMBOL_ID,
      operation: { kind: "replaceBody", content: "return true;\n" },
    })) as SymbolEditPreviewResponse;

    await writeFile(
      join(repoRoot, "src", "auth.ts"),
      "export function handleAuth(): boolean {\n  return false || true;\n}\n",
      "utf-8",
    );

    await assert.rejects(
      () =>
        handleSymbolEdit({
          mode: "apply",
          repoId: REPO_ID,
          planHandle: preview.planHandle,
        }),
      /drifted/i,
    );
  });

  it("rejects apply when only the saved file mtime drifts after preview", async () => {
    const original = "export function handleAuth(): boolean {\n  return false;\n}\n";
    const preview = (await handleSymbolEdit({
      mode: "preview",
      repoId: REPO_ID,
      symbolId: SYMBOL_ID,
      operation: { kind: "replaceBody", content: "return true;\n" },
    })) as SymbolEditPreviewResponse;

    const future = new Date(Date.now() + 2000);
    await utimes(join(repoRoot, "src", "auth.ts"), future, future);
    assert.equal(await readFile(join(repoRoot, "src", "auth.ts"), "utf-8"), original);

    await assert.rejects(
      () =>
        handleSymbolEdit({
          mode: "apply",
          repoId: REPO_ID,
          planHandle: preview.planHandle,
        }),
      /mtime drifted/i,
    );
  });

  it("applyNow enforces the expected snapshot and writes in one call", async () => {
    const apply = (await handleSymbolEdit({
      mode: "applyNow",
      repoId: REPO_ID,
      symbolId: SYMBOL_ID,
      expectedAstFingerprint: FINGERPRINT,
      expectedRange: RANGE,
      operation: {
        kind: "replaceSignature",
        content: "export async function handleAuth(): Promise<boolean>",
      },
    })) as SymbolEditApplyResponse;

    assert.equal(apply.mode, "apply");
    assert.equal(apply.filesWritten, 1);
    assert.match(
      await readFile(join(repoRoot, "src", "auth.ts"), "utf-8"),
      /export async function handleAuth\(\): Promise<boolean> \{/,
    );
  });

  it("updates a live draft instead of writing disk when an overlay exists", async () => {
    const draftContent =
      "export function handleAuth(): boolean {\n  return false;\n}\n";
    await getDefaultLiveIndexCoordinator().pushBufferUpdate({
      repoId: REPO_ID,
      eventType: "change",
      filePath: REL_PATH,
      content: draftContent,
      language: "typescript",
      version: 1,
      dirty: true,
      timestamp: new Date().toISOString(),
    });
    await waitForDefaultLiveIndexIdle();

    const preview = (await handleSymbolEdit({
      mode: "preview",
      repoId: REPO_ID,
      symbolRef: { name: "handleAuth", file: REL_PATH },
      operation: { kind: "replaceBody", content: "return true;\n" },
    })) as SymbolEditPreviewResponse;

    assert.equal(preview.writeTarget, "draft");
    assert.equal("preconditions" in preview, false);

    const apply = (await handleSymbolEdit({
      mode: "apply",
      repoId: REPO_ID,
      planHandle: preview.planHandle,
    })) as SymbolEditApplyResponse;

    assert.equal(apply.writeTarget, "draft");
    assert.equal(apply.filesWritten, 1);
    assert.equal(apply.draftUpdate?.accepted, true);
    const draft = getDefaultOverlayStore().getDraft(REPO_ID, REL_PATH);
    assert.match(draft?.content ?? "", /return true;/);
    assert.match(
      await readFile(join(repoRoot, "src", "auth.ts"), "utf-8"),
      /return false;/,
    );
  });

  it("rejects a saved-file plan if a live draft appears before apply", async () => {
    const preview = (await handleSymbolEdit({
      mode: "preview",
      repoId: REPO_ID,
      symbolId: SYMBOL_ID,
      operation: { kind: "replaceBody", content: "return true;\n" },
    })) as SymbolEditPreviewResponse;

    await getDefaultLiveIndexCoordinator().pushBufferUpdate({
      repoId: REPO_ID,
      eventType: "change",
      filePath: REL_PATH,
      content: "export function handleAuth(): boolean {\n  return false;\n}\n",
      language: "typescript",
      version: 1,
      dirty: true,
      timestamp: new Date().toISOString(),
    });
    await waitForDefaultLiveIndexIdle();

    await assert.rejects(
      () =>
        handleSymbolEdit({
          mode: "apply",
          repoId: REPO_ID,
          planHandle: preview.planHandle,
        }),
      /write target changed from file to draft/i,
    );
    assert.match(
      await readFile(join(repoRoot, "src", "auth.ts"), "utf-8"),
      /return false;/,
    );
  });

  it("rejects draft apply when the saved file drifts after preview", async () => {
    await getDefaultLiveIndexCoordinator().pushBufferUpdate({
      repoId: REPO_ID,
      eventType: "change",
      filePath: REL_PATH,
      content: "export function handleAuth(): boolean {\n  return false;\n}\n",
      language: "typescript",
      version: 1,
      dirty: true,
      timestamp: new Date().toISOString(),
    });
    await waitForDefaultLiveIndexIdle();

    const preview = (await handleSymbolEdit({
      mode: "preview",
      repoId: REPO_ID,
      symbolRef: { name: "handleAuth", file: REL_PATH },
      operation: { kind: "replaceBody", content: "return true;\n" },
    })) as SymbolEditPreviewResponse;

    await writeFile(
      join(repoRoot, "src", "auth.ts"),
      "export function handleAuth(): boolean {\n  return false || true;\n}\n",
      "utf-8",
    );

    await assert.rejects(
      () =>
        handleSymbolEdit({
          mode: "apply",
          repoId: REPO_ID,
          planHandle: preview.planHandle,
        }),
      /saved file sha drifted/i,
    );
  });

  it("rejects non-TypeScript range-only edits when parse-after fails", async () => {
    const pyPath = join(repoRoot, "src", "tool.py");
    const content = "def run():\n    return True\n";
    await writeFile(pyPath, content, "utf-8");
    const conn = await getLadybugConn();
    await ladybugDb.upsertFile(conn, {
      fileId: PY_FILE_ID,
      repoId: REPO_ID,
      relPath: PY_REL_PATH,
      contentHash: sha256(content),
      language: "python",
      byteSize: Buffer.byteLength(content, "utf-8"),
      lastIndexedAt: new Date().toISOString(),
    });
    await ladybugDb.upsertSymbol(conn, {
      symbolId: PY_SYMBOL_ID,
      repoId: REPO_ID,
      fileId: PY_FILE_ID,
      kind: "function",
      name: "run",
      exported: true,
      visibility: "exported",
      language: "python",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 2,
      rangeEndCol: 15,
      astFingerprint: "fp-run-1",
      signatureJson: JSON.stringify({ name: "run" }),
      summary: "Runs a tool",
      invariantsJson: JSON.stringify([]),
      sideEffectsJson: JSON.stringify([]),
      updatedAt: new Date().toISOString(),
    });

    await assert.rejects(
      () =>
        handleSymbolEdit({
          mode: "preview",
          repoId: REPO_ID,
          symbolId: PY_SYMBOL_ID,
          operation: {
            kind: "insertAfter",
            content: "def broken(:\n",
          },
        }),
      /Parse validation failed/i,
    );
  });

  it("does not resolve range-only replaceSymbol against a duplicate symbol elsewhere", async () => {
    const pyPath = join(repoRoot, "src", "tool.py");
    const content = "def run():\n    return True\n\ndef run():\n    return False\n";
    await writeFile(pyPath, content, "utf-8");
    const conn = await getLadybugConn();
    await ladybugDb.upsertFile(conn, {
      fileId: PY_FILE_ID,
      repoId: REPO_ID,
      relPath: PY_REL_PATH,
      contentHash: sha256(content),
      language: "python",
      byteSize: Buffer.byteLength(content, "utf-8"),
      lastIndexedAt: new Date().toISOString(),
    });
    await ladybugDb.upsertSymbol(conn, {
      symbolId: PY_SYMBOL_ID,
      repoId: REPO_ID,
      fileId: PY_FILE_ID,
      kind: "function",
      name: "run",
      exported: true,
      visibility: "exported",
      language: "python",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 2,
      rangeEndCol: 15,
      astFingerprint: "fp-run-1",
      signatureJson: JSON.stringify({ name: "run" }),
      summary: "Runs a tool",
      invariantsJson: JSON.stringify([]),
      sideEffectsJson: JSON.stringify([]),
      updatedAt: new Date().toISOString(),
    });

    const preview = (await handleSymbolEdit({
      mode: "preview",
      repoId: REPO_ID,
      symbolId: PY_SYMBOL_ID,
      operation: {
        kind: "replaceSymbol",
        content: "def other():\n    return True",
      },
    })) as SymbolEditPreviewResponse;

    assert.equal(preview.validation.targetSymbolResolved, false);
  });
});
