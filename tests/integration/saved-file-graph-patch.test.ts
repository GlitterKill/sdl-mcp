import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  capturePersistedGraphIntegrity,
} from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import { patchSavedFile } from "../../dist/live-index/file-patcher.js";
import { generateFileId } from "../../dist/util/hashing.js";
import {
  getDerivedState,
  markGraphIntegrityVerified,
} from "../../dist/db/ladybug-derived-state.js";
import { handleBufferPush } from "../../dist/mcp/tools/buffer.js";
import {
  resetDefaultLiveIndexCoordinator,
  waitForDefaultLiveIndexIdle,
} from "../../dist/live-index/coordinator.js";

describe("saved file graph patch", () => {
  const repoId = "saved-file-graph-patch-repo";
  const durableFileId = generateFileId(repoId, "src/example.ts");
  const dbPath = join(tmpdir(), ".lbug-saved-file-graph-patch-test-db.lbug");
  const configPath = join(tmpdir(), `sdl-saved-file-patch-${Date.now()}.json`);
  let repoDir = "";
  let baselineDigest = "";
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    repoDir = mkdtempSync(join(tmpdir(), "sdl-saved-file-patch-repo-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "example.ts"),
      [
        "export function alpha() {",
        "  return beta();",
        "}",
        "",
        "export function beta() {",
        "  return 1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify(
        { repos: [], policy: {}, indexing: { engine: "typescript", enableFileWatching: false } },
        null,
        2,
      ),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    await closeLadybugDb();
    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const now = "2026-03-07T12:00:00.000Z";
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
      }),
      createdAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: durableFileId,
      repoId,
      relPath: "src/example.ts",
      contentHash: "baseline-content-hash",
      language: "typescript",
      byteSize: 108,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertSymbolBatch(conn, [
      {
        symbolId: "scip-alpha",
        repoId,
        fileId: durableFileId,
        kind: "function",
        name: "alpha",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 3,
        rangeEndCol: 1,
        astFingerprint: "baseline-alpha",
        signatureJson: JSON.stringify({ name: "alpha" }),
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        source: "scip",
        scipSymbol: "scip-alpha",
        updatedAt: now,
      },
    ]);

    await ladybugDb.createVersion(conn, {
      versionId: "v1",
      repoId,
      createdAt: now,
      reason: "verified live-edit baseline",
      prevVersionHash: null,
      versionHash: null,
    });
    const baseline = await capturePersistedGraphIntegrity(conn, repoId);
    baselineDigest = baseline.digest;
    await markGraphIntegrityVerified(repoId, "v1", baselineDigest);
  });

  beforeEach(() => {
    resetDefaultLiveIndexCoordinator();
  });

  after(async () => {
    resetDefaultLiveIndexCoordinator();
    await closeLadybugDb();
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    if (existsSync(configPath)) rmSync(configPath, { force: true });
    if (repoDir && existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = prevConfig;
    if (prevConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = prevConfigPath;
  });

  it("serializes concurrent saved-file integrity patches for the same repository", async () => {
    const request = {
      repoId,
      filePath: "src/example.ts",
      content: [
        "export function alpha() {",
        "  return gamma();",
        "}",
        "",
        "export function gamma() {",
        "  return 2;",
        "}",
      ].join("\n"),
      language: "typescript",
      version: 2,
    };

    const patched = await Promise.all([
      patchSavedFile(request),
      patchSavedFile(request),
    ]);
    assert.equal(patched.length, 2);
    assert.ok(patched.every((result) => result.fileId === durableFileId));

    const conn = await getLadybugConn();
    const file = await ladybugDb.getFileByRepoPath(conn, repoId, "src/example.ts");
    assert.equal(file?.fileId, durableFileId);
    const duplicateFiles = await ladybugDb.getFilesByIds(conn, [
      `${repoId}:src/example.ts`,
    ]);
    assert.equal(duplicateFiles.has(`${repoId}:src/example.ts`), false);

    const symbols = await ladybugDb.getSymbolsByFile(conn, durableFileId);
    const alpha = symbols.find((symbol) => symbol.name === "alpha");
    assert.equal(alpha?.source, "scip");
    assert.equal(alpha?.scipSymbol, "scip-alpha");

    const state = await getDerivedState(repoId);
    const captured = await capturePersistedGraphIntegrity(conn, repoId);
    assert.equal(state?.graphIntegrityState, "verified");
    assert.equal(state?.graphIntegrityVersionId, "v1");
    assert.equal(state?.graphIntegrityDigest, captured.digest);
  });

  it("preserves the durable provider file identity across saved-file patches", async () => {
    const patched = await patchSavedFile({
      repoId,
      filePath: "src/example.ts",
      content: [
        "export function alpha() {",
        "  return gamma();",
        "}",
        "",
        "export function gamma() {",
        "  return 2;",
        "}",
      ].join("\n"),
      language: "typescript",
      version: 2,
    });
    assert.equal(patched.fileId, durableFileId);
    assert.equal(patched.parseResult.file.fileId, durableFileId);
    assert.ok(patched.parseResult.symbols.length > 0);
    assert.ok(
      patched.parseResult.symbols.every(
        (symbol) => symbol.fileId === durableFileId,
      ),
    );

    const conn = await getLadybugConn();
    const file = await ladybugDb.getFileByRepoPath(conn, repoId, "src/example.ts");
    assert.ok(file);
    assert.equal(file.fileId, durableFileId);
    const symbols = await ladybugDb.getSymbolsByFile(conn, file.fileId);
    assert.ok(symbols.every((symbol) => symbol.fileId === durableFileId));
    const duplicateFiles = await ladybugDb.getFilesByIds(conn, [
      `${repoId}:src/example.ts`,
    ]);
    assert.equal(duplicateFiles.has(`${repoId}:src/example.ts`), false);
    const names = symbols.map((symbol) => symbol.name).sort();
    assert.deepStrictEqual(names, ["alpha", "gamma"]);
    const alpha = symbols.find((symbol) => symbol.name === "alpha");
    assert.equal(alpha?.symbolId, "scip-alpha");
    assert.equal(alpha?.source, "scip");
    assert.equal(alpha?.scipSymbol, "scip-alpha");

    const state = await getDerivedState(repoId);
    const captured = await capturePersistedGraphIntegrity(conn, repoId);
    assert.equal(state?.graphIntegrityState, "verified");
    assert.equal(state?.graphIntegrityVersionId, "v1");
    assert.equal(state?.graphIntegrityDigest, captured.digest);
    assert.notEqual(captured.digest, baselineDigest);

    await handleBufferPush({
      repoId,
      eventType: "save",
      filePath: "src/example.ts",
      content: [
        "export function alpha() {",
        "  return gamma();",
        "}",
        "",
        "export function gamma() {",
        "  return 3;",
        "}",
      ].join("\n"),
      language: "typescript",
      version: 3,
      dirty: false,
      timestamp: "2026-03-07T12:20:00.000Z",
    });
    await waitForDefaultLiveIndexIdle();

    const matchedState = await getDerivedState(repoId);
    const matchedCapture = await capturePersistedGraphIntegrity(conn, repoId);
    assert.equal(matchedState?.graphIntegrityState, "verified");
    assert.equal(matchedState?.graphIntegrityVersionId, "v1");
    assert.equal(matchedState?.graphIntegrityDigest, matchedCapture.digest);
    assert.notEqual(matchedCapture.digest, captured.digest);
  });
});
