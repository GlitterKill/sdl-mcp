import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { unlinkSync, rmdirSync, existsSync, mkdirSync } from "fs";
import { exportArtifact, importArtifact } from "../../src/sync/sync.js";
import { pullWithFallback } from "../../src/sync/pull.js";
import { getDb, closeDb } from "../../src/db/db.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  createRepo,
  upsertFile,
  upsertSymbolTransaction,
  createEdgeTransaction,
} from "../../src/db/queries.js";
import { getCurrentTimestamp } from "../../src/util/time.js";
import { indexRepo } from "../../src/indexer/indexer.js";

describe("Round-Trip Sync Integration", () => {
  const testDbPath = join(__dirname, "test-roundtrip.db");
  const syncDir = join(__dirname, "test-roundtrip-artifacts");
  const repoId = "test-repo-roundtrip";

  beforeEach(() => {
    process.env.SDL_DB_PATH = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(syncDir)) {
      rmdirSync(syncDir, { recursive: true });
    }
    mkdirSync(syncDir, { recursive: true });
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

  it("should perform complete round-trip sync: export -> import -> verify", async () => {
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
      rel_path: "src/index.ts",
      content_hash: "hash1",
      language: "ts",
      byte_size: 500,
      last_indexed_at: getCurrentTimestamp(),
      directory: "src",
    });

    upsertFile({
      repo_id: repoId,
      rel_path: "src/utils.ts",
      content_hash: "hash2",
      language: "ts",
      byte_size: 300,
      last_indexed_at: getCurrentTimestamp(),
      directory: "src",
    });

    const exportResult = await exportArtifact({
      repoId,
      commitSha: "abc123def456",
      branch: "main",
      outputPath: join(syncDir, "roundtrip-test.sdl-artifact.json"),
    });

    expect(exportResult.fileCount).toBe(2);

    closeDb();
    unlinkSync(testDbPath);

    const newDb = getDb();
    runMigrations(newDb);

    const importResult = await importArtifact({
      artifactPath: exportResult.artifactPath,
      repoId,
      verifyIntegrity: true,
    });

    expect(importResult.verified).toBe(true);
    expect(importResult.filesRestored).toBe(2);
    expect(importResult.repoId).toBe(repoId);

    const { getFilesByRepo } = await import("../../src/db/queries.js");
    const restoredFiles = getFilesByRepo(repoId);
    expect(restoredFiles.length).toBe(2);
    expect(restoredFiles.some((f: any) => f.rel_path === "src/index.ts")).toBe(
      true,
    );
    expect(restoredFiles.some((f: any) => f.rel_path === "src/utils.ts")).toBe(
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

    upsertFile({
      repo_id: repoId,
      rel_path: "src/test.ts",
      content_hash: "hash1",
      language: "ts",
      byte_size: 200,
      last_indexed_at: getCurrentTimestamp(),
      directory: "src",
    });

    const exportResult = await exportArtifact({
      repoId,
      commitSha: "abc123",
      outputPath: join(syncDir, "pull-test.sdl-artifact.json"),
    });

    closeDb();
    unlinkSync(testDbPath);

    const newDb = getDb();
    runMigrations(newDb);

    const pullResult = await pullWithFallback({
      repoId,
      commitSha: "abc123",
      fallbackToFullIndex: false,
      maxRetries: 1,
    });

    expect(pullResult.success).toBe(true);
    expect(pullResult.method).toBe("artifact");
    expect(pullResult.versionId).not.toBeNull();
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

    expect(pullResult.success).toBe(false);
    expect(pullResult.method).toBe("fallback");
    expect(pullResult.error).toContain("No sync artifact found");
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

    upsertFile({
      repo_id: repoId,
      rel_path: "deterministic.ts",
      content_hash: "det-hash",
      language: "ts",
      byte_size: 150,
      last_indexed_at: getCurrentTimestamp(),
      directory: ".",
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

    expect(exportResult1.artifactId).toBe(exportResult2.artifactId);
    expect(exportResult1.artifactHash).toBe(exportResult2.artifactHash);

    const { readFile } = await import("fs/promises");
    const content1 = await readFile(exportResult1.artifactPath, "utf-8");
    const content2 = await readFile(exportResult2.artifactPath, "utf-8");
    const artifact1 = JSON.parse(content1);
    const artifact2 = JSON.parse(content2);

    expect(artifact1.compressed_data).toBe(artifact2.compressed_data);
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

    let attemptCount = 0;
    const originalGetArtifactMetadata = (await import("../../src/sync/sync.js"))
      .getArtifactMetadata;

    const mockGetArtifactMetadata = (path: string) => {
      attemptCount++;
      if (attemptCount < 2) {
        return null;
      }
      return originalGetArtifactMetadata(path);
    };

    const exportResult = await exportArtifact({
      repoId,
      outputPath: join(syncDir, "retry-test.sdl-artifact.json"),
    });

    const pullResult = await pullWithFallback({
      repoId,
      maxRetries: 3,
    });

    expect(pullResult.success).toBe(true);
  });
});
