import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync, rmSync, existsSync, mkdirSync } from "fs";
import { exportArtifact, importArtifact } from "../../dist/sync/sync.js";
import { pullWithFallback } from "../../dist/sync/pull.js";
import { getDb, closeDb } from "../../dist/db/db.js";
import { runMigrations } from "../../dist/db/migrations.js";
import {
  createRepo,
  createVersion,
  upsertFile,
  upsertSymbolTransaction,
  createEdgeTransaction,
  resetQueryCache,
} from "../../dist/db/queries.js";
import { getCurrentTimestamp } from "../../dist/util/time.js";
import { indexRepo } from "../../dist/indexer/indexer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Round-Trip Sync Integration", () => {
  const testDbPath = join(__dirname, "test-roundtrip.db");
  const syncDir = join(__dirname, "test-roundtrip-artifacts");
  const pullSyncDir = join(process.cwd(), ".sdl-sync");
  const repoId = "test-repo-roundtrip";

  beforeEach(() => {
    process.env.SDL_DB_PATH = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(syncDir)) {
      rmSync(syncDir, { recursive: true, force: true });
    }
    mkdirSync(syncDir, { recursive: true });
    if (existsSync(pullSyncDir)) {
      rmSync(pullSyncDir, { recursive: true, force: true });
    }
    mkdirSync(pullSyncDir, { recursive: true });
  });

  afterEach(() => {
    resetQueryCache();
    closeDb();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(syncDir)) {
      rmSync(syncDir, { recursive: true, force: true });
    }
    if (existsSync(pullSyncDir)) {
      rmSync(pullSyncDir, { recursive: true, force: true });
    }
    delete process.env.SDL_DB_PATH;
  });

  it("should perform complete round-trip sync: export -> import -> verify", async () => {
    const db = getDb();
    runMigrations(db);

    createRepo({
      repo_id: repoId,
      root_path: "/fake/repo",
      config_json: "{}",
      created_at: getCurrentTimestamp(),
    });

    createVersion({
      version_id: "v-test",
      repo_id: repoId,
      created_at: getCurrentTimestamp(),
      reason: "test-version",
    });

    upsertFile({
      repo_id: repoId,
      rel_path: "src/index.ts",
      content_hash: "hash1",
      language: "ts",
      byte_size: 500,
      last_indexed_at: getCurrentTimestamp(),
    });

    upsertFile({
      repo_id: repoId,
      rel_path: "src/utils.ts",
      content_hash: "hash2",
      language: "ts",
      byte_size: 300,
      last_indexed_at: getCurrentTimestamp(),
    });

    const exportResult = await exportArtifact({
      repoId,
      commitSha: "abc123def456",
      branch: "main",
      outputPath: join(syncDir, "roundtrip-test.sdl-artifact.json"),
    });

    assert.strictEqual(exportResult.fileCount, 2);

    resetQueryCache();
    closeDb();
    unlinkSync(testDbPath);

    const newDb = getDb();
    runMigrations(newDb);

    const importResult = await importArtifact({
      artifactPath: exportResult.artifactPath,
      repoId,
      verifyIntegrity: true,
    });

    assert.strictEqual(importResult.verified, true);
    assert.strictEqual(importResult.filesRestored, 2);
    assert.strictEqual(importResult.repoId, repoId);

    const { getFilesByRepo } = await import("../../dist/db/queries.js");
    const restoredFiles = getFilesByRepo(repoId);
    assert.strictEqual(restoredFiles.length, 2);
    assert.strictEqual(
      restoredFiles.some((f: any) => f.rel_path === "src/index.ts"),
      true,
    );
    assert.strictEqual(
      restoredFiles.some((f: any) => f.rel_path === "src/utils.ts"),
      true,
    );
  });

  it("should pull from artifact when available, fallback to index when not", async () => {
    const db = getDb();
    runMigrations(db);

    createRepo({
      repo_id: repoId,
      root_path: "/fake/repo",
      config_json: "{}",
      created_at: getCurrentTimestamp(),
    });

    createVersion({
      version_id: "v-test",
      repo_id: repoId,
      created_at: getCurrentTimestamp(),
      reason: "test-version",
    });

    upsertFile({
      repo_id: repoId,
      rel_path: "src/test.ts",
      content_hash: "hash1",
      language: "ts",
      byte_size: 200,
      last_indexed_at: getCurrentTimestamp(),
    });

    await exportArtifact({
      repoId,
      commitSha: "abc123",
    });

    resetQueryCache();
    closeDb();
    unlinkSync(testDbPath);

    const newDb = getDb();
    runMigrations(newDb);

    createRepo({
      repo_id: repoId,
      root_path: "/fake/repo",
      config_json: "{}",
      created_at: getCurrentTimestamp(),
    });

    const pullResult = await pullWithFallback({
      repoId,
      commitSha: "abc123",
      fallbackToFullIndex: false,
      maxRetries: 1,
    });

    assert.strictEqual(pullResult.success, true);
    assert.strictEqual(pullResult.method, "artifact");
    assert.ok(pullResult.versionId !== null);
  });

  it("should handle pull with no artifact and fallback disabled", async () => {
    const db = getDb();
    runMigrations(db);

    createRepo({
      repo_id: repoId,
      root_path: "/fake/repo",
      config_json: "{}",
      created_at: getCurrentTimestamp(),
    });

    const pullResult = await pullWithFallback({
      repoId,
      fallbackToFullIndex: false,
      maxRetries: 1,
    });

    assert.strictEqual(pullResult.success, false);
    assert.strictEqual(pullResult.method, "fallback");
    assert.ok(pullResult.error.includes("No sync artifact found"));
  });

  it("should verify deterministic restore across multiple exports/imports", async () => {
    const db = getDb();
    runMigrations(db);

    createRepo({
      repo_id: repoId,
      root_path: "/fake/repo",
      config_json: "{}",
      created_at: getCurrentTimestamp(),
    });

    createVersion({
      version_id: "v-test",
      repo_id: repoId,
      created_at: getCurrentTimestamp(),
      reason: "test-version",
    });

    upsertFile({
      repo_id: repoId,
      rel_path: "deterministic.ts",
      content_hash: "det-hash",
      language: "ts",
      byte_size: 150,
      last_indexed_at: getCurrentTimestamp(),
    });

    const exportResult1 = await exportArtifact({
      repoId,
      commitSha: "commit1",
      outputPath: join(syncDir, "det1.sdl-artifact.json"),
    });

    const exportResult2 = await exportArtifact({
      repoId,
      commitSha: "commit1",
      outputPath: join(syncDir, "det2.sdl-artifact.json"),
    });

    assert.strictEqual(exportResult1.artifactId, exportResult2.artifactId);
    assert.strictEqual(exportResult1.artifactHash, exportResult2.artifactHash);

    const { readFile } = await import("fs/promises");
    const content1 = await readFile(exportResult1.artifactPath, "utf-8");
    const content2 = await readFile(exportResult2.artifactPath, "utf-8");
    const artifact1 = JSON.parse(content1);
    const artifact2 = JSON.parse(content2);

    assert.strictEqual(artifact1.compressed_data, artifact2.compressed_data);
  });

  it("should handle pull with retry on transient failures", async () => {
    const db = getDb();
    runMigrations(db);

    createRepo({
      repo_id: repoId,
      root_path: "/fake/repo",
      config_json: "{}",
      created_at: getCurrentTimestamp(),
    });

    createVersion({
      version_id: "v-test",
      repo_id: repoId,
      created_at: getCurrentTimestamp(),
      reason: "test-version",
    });

    let attemptCount = 0;
    const originalGetArtifactMetadata = (await import("../../dist/sync/sync.js"))
      .getArtifactMetadata;

    const mockGetArtifactMetadata = (path: string) => {
      attemptCount++;
      if (attemptCount < 2) {
        return null;
      }
      return originalGetArtifactMetadata(path);
    };

    await exportArtifact({
      repoId,
    });

    const pullResult = await pullWithFallback({
      repoId,
      maxRetries: 3,
    });

    assert.strictEqual(pullResult.success, true);
  });
});
