import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { unlinkSync, rmdirSync, existsSync } from "fs";
import {
  exportArtifact,
  importArtifact,
  getArtifactMetadata,
} from "../../src/sync/sync.js";
import { getDb, closeDb } from "../../src/db/db.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  createRepo,
  upsertFile,
  upsertSymbolTransaction,
} from "../../src/db/queries.js";
import { getCurrentTimestamp } from "../../src/util/time.js";

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
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(syncDir)) {
      rmdirSync(syncDir, { recursive: true });
    }
    delete process.env.SDL_DB_PATH;
    closeDb();
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

    upsertFile({
      repo_id: repoId,
      rel_path: "test.ts",
      content_hash: "abc123",
      language: "ts",
      byte_size: 100,
      last_indexed_at: getCurrentTimestamp(),
      directory: ".",
    });

    const result = await exportArtifact({
      repoId,
      commitSha: "abc123def456",
      branch: "main",
      outputPath: join(syncDir, "test.sdl-artifact.json"),
    });

    expect(result.artifactId).toContain(repoId);
    expect(result.commitSha).toBe("abc123def456");
    expect(result.fileCount).toBe(1);
    expect(result.sizeBytes).toBeGreaterThan(0);
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

    upsertFile({
      repo_id: repoId,
      rel_path: "test.ts",
      content_hash: "abc123",
      language: "ts",
      byte_size: 100,
      last_indexed_at: getCurrentTimestamp(),
      directory: ".",
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

    expect(importResult.verified).toBe(true);
    expect(importResult.filesRestored).toBe(1);
    expect(importResult.repoId).toBe(repoId);
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

    upsertFile({
      repo_id: repoId,
      rel_path: "test.ts",
      content_hash: "abc123",
      language: "ts",
      byte_size: 100,
      last_indexed_at: getCurrentTimestamp(),
      directory: ".",
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

    await expect(
      importArtifact({
        artifactPath: exportResult.artifactPath,
        repoId,
        verifyIntegrity: true,
      }),
    ).rejects.toThrow("Artifact integrity check failed");
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

    upsertFile({
      repo_id: repoId,
      rel_path: "test.ts",
      content_hash: "abc123",
      language: "ts",
      byte_size: 100,
      last_indexed_at: getCurrentTimestamp(),
      directory: ".",
    });

    const exportResult = await exportArtifact({
      repoId,
      outputPath: join(syncDir, "test.sdl-artifact.json"),
    });

    const metadata = getArtifactMetadata(exportResult.artifactPath);

    expect(metadata).not.toBeNull();
    expect(metadata?.artifact_id).toBe(exportResult.artifactId);
    expect(metadata?.repo_id).toBe(repoId);
    expect(metadata?.file_count).toBe(1);
  });

  it("should handle missing artifact metadata gracefully", () => {
    const metadata = getArtifactMetadata(join(syncDir, "nonexistent.json"));
    expect(metadata).toBeNull();
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

    upsertFile({
      repo_id: repoId,
      rel_path: "test.ts",
      content_hash: "abc123",
      language: "ts",
      byte_size: 100,
      last_indexed_at: getCurrentTimestamp(),
      directory: ".",
    });

    const exportResult = await exportArtifact({
      repoId,
      outputPath: join(syncDir, "test.sdl-artifact.json"),
    });

    await expect(
      importArtifact({
        artifactPath: exportResult.artifactPath,
        repoId: "different-repo",
        verifyIntegrity: false,
      }),
    ).rejects.toThrow("does not match expected repo_id");

    const importResult = await importArtifact({
      artifactPath: exportResult.artifactPath,
      repoId: "different-repo",
      force: true,
      verifyIntegrity: false,
    });

    expect(importResult.repoId).toBe(repoId);
  });
});
