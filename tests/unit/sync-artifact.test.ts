import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync, rmdirSync, existsSync } from "fs";
import {
  exportArtifact,
  importArtifact,
  getArtifactMetadata,
} from "../../dist/sync/sync.js";
import { getDb, closeDb } from "../../dist/db/db.js";
import { runMigrations } from "../../dist/db/migrations.js";
import {
  createRepo,
  createVersion,
  upsertFile,
  upsertSymbolTransaction,
  resetQueryCache,
} from "../../dist/db/queries.js";
import { getCurrentTimestamp } from "../../dist/util/time.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Sync Artifact Model", () => {
  const testDbPath = join(__dirname, "test-sync.db");
  const syncDir = join(__dirname, "test-sync-artifacts");
  const repoId = "test-repo-sync";

  beforeEach(() => {
    process.env.SDL_DB_PATH = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(syncDir)) {
      rmdirSync(syncDir, { recursive: true });
    }
  });

  afterEach(() => {
    resetQueryCache();
    closeDb();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(syncDir)) {
      rmdirSync(syncDir, { recursive: true });
    }
    delete process.env.SDL_DB_PATH;
  });

  it("should create sync artifact with commit SHA linking", async () => {
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
      rel_path: "test.ts",
      content_hash: "abc123",
      language: "ts",
      byte_size: 100,
      last_indexed_at: getCurrentTimestamp(),
    });

    const result = await exportArtifact({
      repoId,
      commitSha: "abc123def456",
      branch: "main",
      outputPath: join(syncDir, "test.sdl-artifact.json"),
    });

    assert.ok(result.artifactId.includes(repoId));
    assert.strictEqual(result.commitSha, "abc123def456");
    assert.strictEqual(result.fileCount, 1);
    assert.ok(result.sizeBytes > 0);
  });

  it("should export and import sync artifact with integrity verification", async () => {
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
      rel_path: "test.ts",
      content_hash: "abc123",
      language: "ts",
      byte_size: 100,
      last_indexed_at: getCurrentTimestamp(),
    });

    const exportResult = await exportArtifact({
      repoId,
      commitSha: "abc123def456",
      outputPath: join(syncDir, "test.sdl-artifact.json"),
    });

    const importResult = await importArtifact({
      artifactPath: exportResult.artifactPath,
      repoId,
      verifyIntegrity: true,
    });

    assert.strictEqual(importResult.verified, true);
    assert.strictEqual(importResult.filesRestored, 1);
    assert.strictEqual(importResult.repoId, repoId);
  });

  it("should reject import with hash mismatch on tampered artifact", async () => {
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
      rel_path: "test.ts",
      content_hash: "abc123",
      language: "ts",
      byte_size: 100,
      last_indexed_at: getCurrentTimestamp(),
    });

    const exportResult = await exportArtifact({
      repoId,
      outputPath: join(syncDir, "test.sdl-artifact.json"),
    });

    const { readFile, writeFile } = await import("fs/promises");
    const artifactContent = await readFile(exportResult.artifactPath, "utf-8");
    const artifact = JSON.parse(artifactContent);
    artifact.artifact_hash = "tamperedhash";
    await writeFile(
      exportResult.artifactPath,
      JSON.stringify(artifact),
      "utf-8",
    );

    await assert.rejects(
      importArtifact({
        artifactPath: exportResult.artifactPath,
        repoId,
        verifyIntegrity: true,
      }),
      { message: /Artifact integrity check failed/ },
    );
  });

  it("should retrieve artifact metadata without full import", async () => {
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
      rel_path: "test.ts",
      content_hash: "abc123",
      language: "ts",
      byte_size: 100,
      last_indexed_at: getCurrentTimestamp(),
    });

    const exportResult = await exportArtifact({
      repoId,
      outputPath: join(syncDir, "test.sdl-artifact.json"),
    });

    const metadata = getArtifactMetadata(exportResult.artifactPath);

    assert.ok(metadata !== null);
    assert.strictEqual(metadata?.artifact_id, exportResult.artifactId);
    assert.strictEqual(metadata?.repo_id, repoId);
    assert.strictEqual(metadata?.file_count, 1);
  });

  it("should handle missing artifact metadata gracefully", () => {
    const metadata = getArtifactMetadata(join(syncDir, "nonexistent.json"));
    assert.strictEqual(metadata, null);
  });

  it("should handle repo_id mismatch with force flag", async () => {
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
      rel_path: "test.ts",
      content_hash: "abc123",
      language: "ts",
      byte_size: 100,
      last_indexed_at: getCurrentTimestamp(),
    });

    const exportResult = await exportArtifact({
      repoId,
      outputPath: join(syncDir, "test.sdl-artifact.json"),
    });

    await assert.rejects(
      importArtifact({
        artifactPath: exportResult.artifactPath,
        repoId: "different-repo",
        verifyIntegrity: false,
      }),
      { message: /does not match expected repo_id/ },
    );

    const importResult = await importArtifact({
      artifactPath: exportResult.artifactPath,
      repoId: "different-repo",
      force: true,
      verifyIntegrity: false,
    });

    assert.strictEqual(importResult.repoId, repoId);
  });
});
