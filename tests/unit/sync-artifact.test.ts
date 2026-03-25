import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  exportArtifact,
  importArtifact,
} from "../../dist/sync/sync.js";
import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Sync Artifact Model", () => {
  let graphDbPath = "";
  let syncDir = "";
  const repoId = "test-repo-sync";

  beforeEach(async () => {
    const runId = randomUUID();
    graphDbPath = join(tmpdir(), `.lbug-sync-artifact-test-db-${runId}`);
    syncDir = join(__dirname, `.tmp-sync-artifacts-${runId}`);
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    if (existsSync(syncDir)) {
      rmSync(syncDir, { recursive: true, force: true });
    }

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);

    const conn = await getLadybugConn();
    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, {
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

    await ladybugDb.createVersion(conn, {
      versionId: "v-test",
      repoId,
      createdAt: now,
      reason: "test-version",
      prevVersionHash: null,
      versionHash: null,
    });

    await ladybugDb.upsertFile(conn, {
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
    await closeLadybugDb();
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

  it("round-trips enrichment metadata through sync artifacts", async () => {
    const conn = await getLadybugConn();
    const now = new Date().toISOString();

    await ladybugDb.upsertSymbol(conn, {
      symbolId: "sym-1",
      repoId,
      fileId: "file-1",
      kind: "function",
      name: "handleLoginRequest",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 5,
      rangeEndCol: 1,
      astFingerprint: "fp-1",
      signatureJson: JSON.stringify({
        params: [{ name: "authRequest", type: "Request" }],
      }),
      summary: "Handle login requests",
      invariantsJson: null,
      sideEffectsJson: null,
      roleTagsJson: JSON.stringify(["handler", "entrypoint"]),
      searchText: "handleloginrequest handle login requests handler entrypoint auth request",
      updatedAt: now,
    });

    const exportResult = await exportArtifact({
      repoId,
      versionId: "v-test",
      commitSha: "abc123def456",
      outputPath: join(syncDir, "enrichment.sdl-artifact.json"),
    });

    const fs = await import("node:fs");
    const artifact = JSON.parse(
      fs.readFileSync(exportResult.artifactPath, "utf-8"),
    ) as { compressed_data: string };
    const state = JSON.parse(
      gunzipSync(Buffer.from(artifact.compressed_data, "base64")).toString("utf-8"),
    ) as {
      symbols: Array<{
        role_tags_json: string | null;
        search_text: string | null;
      }>;
    };

    assert.strictEqual(
      state.symbols[0]?.role_tags_json,
      JSON.stringify(["handler", "entrypoint"]),
    );
    assert.match(state.symbols[0]?.search_text ?? "", /\bhandler\b/);

    await closeLadybugDb();
    rmSync(graphDbPath, { recursive: true, force: true });
    await initLadybugDb(graphDbPath);

    const importResult = await importArtifact({
      artifactPath: exportResult.artifactPath,
      repoId,
      verifyIntegrity: true,
    });

    assert.strictEqual(importResult.symbolsRestored, 1);

    const restoredConn = await getLadybugConn();
    const restoredSymbols = await ladybugDb.getSymbolsByRepo(restoredConn, repoId);

    assert.strictEqual(restoredSymbols.length, 1);
    assert.strictEqual(
      restoredSymbols[0]?.roleTagsJson,
      JSON.stringify(["handler", "entrypoint"]),
    );
    assert.match(restoredSymbols[0]?.searchText ?? "", /\bauth\b/);
  });

  it("rebuilds enrichment metadata when importing legacy artifacts", async () => {
    const conn = await getLadybugConn();
    const now = new Date().toISOString();

    await ladybugDb.upsertFile(conn, {
      fileId: "file-1",
      repoId,
      relPath: "src/main.tsx",
      contentHash: "abc123",
      language: "tsx",
      byteSize: 100,
      lastIndexedAt: now,
    });

    await ladybugDb.upsertSymbol(conn, {
      symbolId: "sym-legacy",
      repoId,
      fileId: "file-1",
      kind: "function",
      name: "renderApp",
      exported: true,
      visibility: "public",
      language: "tsx",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 5,
      rangeEndCol: 1,
      astFingerprint: "fp-legacy",
      signatureJson: JSON.stringify({
        params: [{ name: "rootElement", type: "HTMLElement" }],
      }),
      summary: "Render app shell",
      invariantsJson: null,
      sideEffectsJson: null,
      roleTagsJson: JSON.stringify(["entrypoint"]),
      searchText: "render app shell entrypoint root element main tsx",
      updatedAt: now,
    });

    const exportResult = await exportArtifact({
      repoId,
      versionId: "v-test",
      outputPath: join(syncDir, "legacy.sdl-artifact.json"),
    });

    const fs = await import("node:fs");
    const artifact = JSON.parse(
      fs.readFileSync(exportResult.artifactPath, "utf-8"),
    ) as {
      artifact_hash: string;
      compressed_data: string;
    };
    const state = JSON.parse(
      gunzipSync(Buffer.from(artifact.compressed_data, "base64")).toString("utf-8"),
    ) as {
      symbols: Array<Record<string, unknown>>;
    };

    for (const symbol of state.symbols) {
      delete symbol.role_tags_json;
      delete symbol.search_text;
    }

    const rewrittenStateJson = JSON.stringify(state, null, 0);
    const { hashContent } = await import("../../dist/util/hashing.js");
    artifact.compressed_data = gzipSync(Buffer.from(rewrittenStateJson)).toString("base64");
    artifact.artifact_hash = hashContent(rewrittenStateJson);
    fs.writeFileSync(exportResult.artifactPath, JSON.stringify(artifact, null, 2), "utf-8");

    await closeLadybugDb();
    rmSync(graphDbPath, { recursive: true, force: true });
    await initLadybugDb(graphDbPath);

    await importArtifact({
      artifactPath: exportResult.artifactPath,
      repoId,
      verifyIntegrity: true,
    });

    const restoredConn = await getLadybugConn();
    const restoredSymbols = await ladybugDb.getSymbolsByRepo(restoredConn, repoId);

    assert.strictEqual(restoredSymbols[0]?.roleTagsJson, JSON.stringify(["entrypoint"]));
    assert.match(restoredSymbols[0]?.searchText ?? "", /\brender\b/);
    assert.match(restoredSymbols[0]?.searchText ?? "", /\broot\b/);
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
