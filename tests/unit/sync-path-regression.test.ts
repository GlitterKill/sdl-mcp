import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../src/db/ladybug.js";
import * as ladybugDb from "../../src/db/ladybug-queries.js";
import { exportArtifact } from "../../src/sync/sync.js";
import { pullLatestState } from "../../src/sync/pull.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("sync path regressions", () => {
  const dbPath = join(__dirname, ".lbug-sync-path-regression-db");
  const repoRoot = join(__dirname, ".tmp-sync-repo-root");
  const workspaceSyncDir = join(process.cwd(), ".sdl-sync");
  const repoId = "sync-path-regression-repo";
  const fileId = "sync-path-file";

  beforeEach(async () => {
    if (existsSync(dbPath)) {
      rmSync(dbPath, { recursive: true, force: true });
    }
    if (existsSync(repoRoot)) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
    if (existsSync(workspaceSyncDir)) {
      rmSync(workspaceSyncDir, { recursive: true, force: true });
    }
    mkdirSync(repoRoot, { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(dbPath);

    const conn = await getLadybugConn();
    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: repoRoot,
      configJson: JSON.stringify({
        repoId,
        rootPath: repoRoot,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });

    await ladybugDb.createVersion(conn, {
      versionId: "v-sync-path",
      repoId,
      createdAt: now,
      reason: "sync-path-regression",
      prevVersionHash: null,
      versionHash: "version-hash",
    });

    await ladybugDb.upsertFile(conn, {
      fileId,
      repoId,
      relPath: "src/index.ts",
      contentHash: "content-hash",
      language: "ts",
      byteSize: 123,
      lastIndexedAt: now,
    });
  });

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(dbPath)) {
      rmSync(dbPath, { recursive: true, force: true });
    }
    if (existsSync(repoRoot)) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
    if (existsSync(workspaceSyncDir)) {
      rmSync(workspaceSyncDir, { recursive: true, force: true });
    }
  });

  it("exports sync artifacts under the repo root sync directory", async () => {
    const result = await exportArtifact({
      repoId,
      versionId: "v-sync-path",
      commitSha: "abc123",
      branch: "main",
    });

    assert.equal(
      result.artifactPath,
      join(repoRoot, ".sdl-sync", `${result.artifactId}.sdl-artifact.json`),
    );
  });

  it("pulls from the repo root sync directory even when cwd differs", async () => {
    const exportResult = await exportArtifact({
      repoId,
      versionId: "v-sync-path",
      commitSha: "abc123",
      branch: "main",
      outputPath: join(repoRoot, ".sdl-sync", "repo-root.sdl-artifact.json"),
    });

    const pullResult = await pullLatestState({
      repoId,
      fallbackToFullIndex: false,
    });

    assert.equal(pullResult.success, true);
    assert.equal(pullResult.method, "artifact");
    assert.equal(pullResult.artifactId, exportResult.artifactId);
    assert.equal(pullResult.versionId, "v-sync-path");
  });
});
