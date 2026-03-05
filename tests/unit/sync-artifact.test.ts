import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";

import {
  exportArtifact,
  importArtifact,
} from "../../dist/sync/sync.js";
import { closeKuzuDb, getKuzuConn, initKuzuDb } from "../../dist/db/kuzu.js";
import * as kuzuDb from "../../dist/db/kuzu-queries.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Sync Artifact Model", () => {
  const graphDbPath = join(__dirname, ".kuzu-sync-artifact-test-db");
  const syncDir = join(__dirname, ".tmp-sync-artifacts");
  const repoId = "test-repo-sync";

  beforeEach(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    if (existsSync(syncDir)) {
      rmSync(syncDir, { recursive: true, force: true });
    }

    await closeKuzuDb();
    await initKuzuDb(graphDbPath);

    const conn = await getKuzuConn();
    const now = new Date().toISOString();

    await kuzuDb.upsertRepo(conn, {
      repoId,
      rootPath: "/fake/repo",
      configJson: JSON.stringify({
        repoId,
        rootPath: "/fake/repo",
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

    await kuzuDb.createVersion(conn, {
      versionId: "v-test",
      repoId,
      createdAt: now,
      reason: "test-version",
      prevVersionHash: null,
      versionHash: null,
    });

    await kuzuDb.upsertFile(conn, {
      fileId: "file-1",
      repoId,
      relPath: "test.ts",
      contentHash: "abc123",
      language: "ts",
      byteSize: 100,
      lastIndexedAt: now,
    });
  });

  afterEach(async () => {
    await closeKuzuDb();
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    if (existsSync(syncDir)) {
      rmSync(syncDir, { recursive: true, force: true });
    }
  });

  it("creates sync artifact with commit SHA linking", async () => {
    const result = await exportArtifact({
      repoId,
      versionId: "v-test",
      commitSha: "abc123def456",
      branch: "main",
      outputPath: join(syncDir, "test.sdl-artifact.json"),
    });

    assert.ok(result.artifactId.includes(repoId));
    assert.strictEqual(result.commitSha, "abc123def456");
    assert.strictEqual(result.fileCount, 1);
    assert.ok(result.sizeBytes > 0);
  });

  it("exports and imports sync artifact with integrity verification", async () => {
    const exportResult = await exportArtifact({
      repoId,
      versionId: "v-test",
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

  it("rejects import with hash mismatch on tampered artifact", async () => {
    const exportResult = await exportArtifact({
      repoId,
      versionId: "v-test",
      commitSha: "abc123def456",
      outputPath: join(syncDir, "test.sdl-artifact.json"),
    });

    // Tamper the JSON artifact file to trigger integrity failure.
    const tamperedPath = join(syncDir, "tampered.sdl-artifact.json");
    rmSync(tamperedPath, { force: true });
    // Copy then mutate artifact_hash to trigger integrity failure.
    const fs = await import("node:fs");
    const raw = fs.readFileSync(exportResult.artifactPath, "utf-8");
    const parsed = JSON.parse(raw) as { artifact_hash: string };
    parsed.artifact_hash = `${parsed.artifact_hash}-tampered`;
    fs.writeFileSync(tamperedPath, JSON.stringify(parsed, null, 2), "utf-8");

    try {
      await importArtifact({
        artifactPath: tamperedPath,
        repoId,
        verifyIntegrity: true,
      });
      assert.fail("Expected integrity check failure");
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("hash mismatch"));
    }
  });
});
