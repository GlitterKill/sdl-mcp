import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { handleFileWrite } from "../../dist/mcp/tools/file-write.js";
import { generateFileId } from "../../dist/util/hashing.js";
import {
  capturePersistedGraphIntegrity,
  compareGraphIntegrityExpectations,
  createGraphIntegrityExpectationFromManifest,
  createGraphIntegrityFileState,
} from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import {
  getDerivedState,
  markGraphIntegrityVerified,
} from "../../dist/db/ladybug-derived-state.js";
import {
  cancelAndWaitForGraphIntegrityVerifier,
} from "../../dist/indexer/provider-first/background-graph-integrity-verifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function waitForVerifiedRevision(
  repoId: string,
  revision: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await getDerivedState(repoId);
    if (
      state?.graphIntegrityState === "verified" &&
      state.graphIntegrityVerifiedRevision === revision
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for graph integrity revision ${revision}`);
}

describe("sdl.file.write", () => {
  const testDir = join(__dirname, "test-file-write-tool");
  const graphDbPath = join(testDir, "graph");
  const repoId = "test-file-write-repo";
  const configDir = join(testDir, "config");

  beforeEach(async () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(configDir, { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);

    const conn = await getLadybugConn();
    const now = new Date().toISOString();
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: testDir,
      configJson: JSON.stringify({
        repoId,
        rootPath: testDir,
        ignore: [],
        languages: ["ts", "json", "yaml", "md"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: false,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });
  });

  afterEach(async () => {
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    await closeLadybugDb();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("content mode (create/overwrite)", () => {
    it("creates a new file with createIfMissing", async () => {
      const response = await handleFileWrite({
        repoId,
        filePath: "config/new.json",
        content: '{"version": 1}',
        createIfMissing: true,
        createBackup: false,
      });

      assert.equal(response.mode, "create");
      assert.equal(response.bytesWritten, 14);
      assert.equal(existsSync(join(configDir, "new.json")), true);
      assert.equal(
        readFileSync(join(configDir, "new.json"), "utf-8"),
        '{"version": 1}',
      );
    });

    it("overwrites existing file and creates backup", async () => {
      const filePath = join(configDir, "existing.json");
      writeFileSync(filePath, '{"old": true}', "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/existing.json",
        content: '{"new": true}',
        createBackup: true,
      });

      assert.equal(response.mode, "overwrite");
      assert.equal(response.backupPath, "config/existing.json.bak");
      assert.match(response.snippets?.before ?? "", /old/);
      assert.match(response.snippets?.after ?? "", /new/);
      assert.equal(readFileSync(filePath, "utf-8"), '{"new": true}');
      assert.equal(readFileSync(filePath + ".bak", "utf-8"), '{"old": true}');
    });

    it("updates an indexed TypeScript graph through the shared saved-file patch", async () => {
      const relPath = "src/indexed.ts";
      const filePath = join(testDir, relPath);
      const fileId = generateFileId(repoId, relPath);
      const baselineContent = "export function alpha() { return 1; }";
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, baselineContent, "utf-8");

      const conn = await getLadybugConn();
      const now = "2026-07-21T12:00:00.000Z";
      await ladybugDb.upsertFile(conn, {
        fileId,
        repoId,
        relPath,
        contentHash: "baseline",
        language: "typescript",
        byteSize: Buffer.byteLength(baselineContent),
        lastIndexedAt: now,
      });
      await ladybugDb.upsertSymbolBatch(conn, [
        {
          symbolId: "scip-indexed-alpha",
          repoId,
          fileId,
          kind: "function",
          name: "alpha",
          exported: true,
          visibility: "public",
          language: "typescript",
          rangeStartLine: 1,
          rangeStartCol: 0,
          rangeEndLine: 1,
          rangeEndCol: baselineContent.length,
          astFingerprint: "baseline-alpha",
          signatureJson: JSON.stringify({ name: "alpha" }),
          summary: null,
          invariantsJson: null,
          sideEffectsJson: null,
          source: "scip",
          scipSymbol: "scip-indexed-alpha",
          updatedAt: now,
        },
      ]);
      await ladybugDb.createVersion(conn, {
        versionId: "v-indexed",
        repoId,
        createdAt: now,
        reason: "indexed file.write baseline",
        prevVersionHash: null,
        versionHash: null,
      });
      const baseline = await capturePersistedGraphIntegrity(conn, repoId);
      const baselineSymbols = await ladybugDb.getSymbolsByFile(conn, fileId);
      await ladybugDb.upsertGraphIntegrityFileStateInTransaction(
        conn,
        createGraphIntegrityFileState(
          repoId,
          fileId,
          relPath,
          baselineSymbols,
          [],
        ),
      );
      await markGraphIntegrityVerified(repoId, "v-indexed", baseline.digest);

      const response = await handleFileWrite({
        repoId,
        filePath: relPath,
        content: "export function alpha() { return 2; }",
        createBackup: false,
      });

      assert.deepStrictEqual(response.indexUpdate, {
        applied: true,
        symbolsMatched: 1,
        symbolsAdded: 0,
        symbolsRemoved: 0,
        edgesUpserted: 0,
      });
      const committedState = await getDerivedState(repoId);
      assert.equal(committedState?.graphIntegrityVersionId, "v-indexed");
      assert.equal(committedState?.graphIntegrityRevision, 1);
      const manifest = createGraphIntegrityExpectationFromManifest(
        await ladybugDb.listGraphIntegrityFileStates(conn, repoId),
        await ladybugDb.listGraphIntegrityFilelessStates(conn, repoId),
      );
      const graph = await capturePersistedGraphIntegrity(conn, repoId);
      assert.equal(
        graph.digest,
        manifest.digest,
        JSON.stringify(compareGraphIntegrityExpectations(manifest, graph)),
      );
      await waitForVerifiedRevision(repoId, 1);
      assert.equal(
        (await getDerivedState(repoId))?.graphIntegrityDigest,
        graph.digest,
      );
    });

    it("throws when file does not exist and createIfMissing is false", async () => {
      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/nonexistent.json",
          replaceLines: { start: 0, end: 1, content: "test" },
        }),
        /File not found.*createIfMissing/,
      );
    });
  });

  describe("replaceLines mode", () => {
    it("replaces a line range", async () => {
      const filePath = join(configDir, "lines.txt");
      writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5", "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/lines.txt",
        replaceLines: { start: 1, end: 3, content: "replaced" },
        createBackup: false,
      });

      assert.equal(response.mode, "replaceLines");
      const content = readFileSync(filePath, "utf-8");
      assert.equal(content, "line1\nreplaced\nline4\nline5");
    });

    it("throws when start exceeds file length", async () => {
      const filePath = join(configDir, "short.txt");
      writeFileSync(filePath, "line1\nline2", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/short.txt",
          replaceLines: { start: 10, end: 11, content: "test" },
          createBackup: false,
        }),
        /Start line 10 exceeds file length/,
      );
    });

    it("throws when end exceeds file length", async () => {
      const filePath = join(configDir, "short.txt");
      writeFileSync(filePath, "line1\nline2", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/short.txt",
          replaceLines: { start: 0, end: 100, content: "test" },
          createBackup: false,
        }),
        /End line 100 exceeds file length/,
      );
    });

    it("throws when end < start", async () => {
      const filePath = join(configDir, "lines.txt");
      writeFileSync(filePath, "line1\nline2\nline3", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/lines.txt",
          replaceLines: { start: 2, end: 1, content: "test" },
          createBackup: false,
        }),
        /End line 1 must be >= start line 2/,
      );
    });
  });

  describe("replacePattern mode", () => {
    it("replaces first occurrence by default", async () => {
      const filePath = join(configDir, "pattern.txt");
      writeFileSync(filePath, "foo bar foo baz foo", "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/pattern.txt",
        replacePattern: { pattern: "foo", replacement: "FOO" },
        createBackup: false,
      });

      assert.equal(response.mode, "replacePattern");
      assert.equal(response.replacementCount, 1);
      assert.equal(readFileSync(filePath, "utf-8"), "FOO bar foo baz foo");
    });

    it("replaces all occurrences with global flag", async () => {
      const filePath = join(configDir, "pattern.txt");
      writeFileSync(filePath, "foo bar foo baz foo", "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/pattern.txt",
        replacePattern: { pattern: "foo", replacement: "FOO", global: true },
        createBackup: false,
      });

      assert.equal(response.replacementCount, 3);
      assert.equal(readFileSync(filePath, "utf-8"), "FOO bar FOO baz FOO");
    });

    it("throws on invalid regex pattern", async () => {
      const filePath = join(configDir, "pattern.txt");
      writeFileSync(filePath, "test", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/pattern.txt",
          replacePattern: { pattern: "[invalid", replacement: "x" },
          createBackup: false,
        }),
        /Invalid regex pattern/,
      );
    });

    it("rejects nested quantifiers (ReDoS protection)", async () => {
      const filePath = join(configDir, "pattern.txt");
      writeFileSync(filePath, "test", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/pattern.txt",
          replacePattern: { pattern: "(a+)+", replacement: "x" },
          createBackup: false,
        }),
        /nested quantifiers/,
      );
    });
  });

  describe("jsonPath mode", () => {
    it("updates a top-level key", async () => {
      const filePath = join(configDir, "config.json");
      writeFileSync(filePath, '{"version": "1.0.0", "name": "app"}', "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/config.json",
        jsonPath: "version",
        jsonValue: "2.0.0",
        createBackup: false,
      });

      assert.equal(response.mode, "jsonPath");
      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      assert.equal(content.version, "2.0.0");
      assert.equal(content.name, "app");
    });

    it("updates a nested key", async () => {
      const filePath = join(configDir, "config.json");
      writeFileSync(
        filePath,
        '{"server": {"port": 3000, "host": "localhost"}}',
        "utf-8",
      );

      await handleFileWrite({
        repoId,
        filePath: "config/config.json",
        jsonPath: "server.port",
        jsonValue: 8080,
        createBackup: false,
      });

      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      assert.equal(content.server.port, 8080);
      assert.equal(content.server.host, "localhost");
    });

    it("creates intermediate objects", async () => {
      const filePath = join(configDir, "config.json");
      writeFileSync(filePath, "{}", "utf-8");

      await handleFileWrite({
        repoId,
        filePath: "config/config.json",
        jsonPath: "deep.nested.value",
        jsonValue: 42,
        createBackup: false,
      });

      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      assert.equal(content.deep.nested.value, 42);
    });

    it("blocks prototype pollution paths", async () => {
      const filePath = join(configDir, "config.json");
      writeFileSync(filePath, "{}", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/config.json",
          jsonPath: "__proto__.polluted",
          jsonValue: true,
          createBackup: false,
        }),
        /Blocked path segment/,
      );
    });

    it("throws for non-JSON files", async () => {
      const filePath = join(configDir, "config.txt");
      writeFileSync(filePath, "not json", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/config.txt",
          jsonPath: "key",
          jsonValue: "value",
          createBackup: false,
        }),
        /jsonPath mode only supports .json files/,
      );
    });
  });

  describe("insertAt mode", () => {
    it("inserts at the beginning", async () => {
      const filePath = join(configDir, "insert.txt");
      writeFileSync(filePath, "line1\nline2", "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/insert.txt",
        insertAt: { line: 0, content: "inserted" },
        createBackup: false,
      });

      assert.equal(response.mode, "insertAt");
      assert.equal(readFileSync(filePath, "utf-8"), "inserted\nline1\nline2");
    });

    it("inserts in the middle", async () => {
      const filePath = join(configDir, "insert.txt");
      writeFileSync(filePath, "line1\nline2\nline3", "utf-8");

      await handleFileWrite({
        repoId,
        filePath: "config/insert.txt",
        insertAt: { line: 1, content: "inserted" },
        createBackup: false,
      });

      assert.equal(
        readFileSync(filePath, "utf-8"),
        "line1\ninserted\nline2\nline3",
      );
    });

    it("inserts at the end", async () => {
      const filePath = join(configDir, "insert.txt");
      writeFileSync(filePath, "line1\nline2", "utf-8");

      await handleFileWrite({
        repoId,
        filePath: "config/insert.txt",
        insertAt: { line: 2, content: "inserted" },
        createBackup: false,
      });

      assert.equal(readFileSync(filePath, "utf-8"), "line1\nline2\ninserted");
    });

    it("throws when line exceeds file length", async () => {
      const filePath = join(configDir, "insert.txt");
      writeFileSync(filePath, "line1\nline2", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/insert.txt",
          insertAt: { line: 10, content: "test" },
          createBackup: false,
        }),
        /Insert line 10 exceeds file length/,
      );
    });
  });

  describe("append mode", () => {
    it("appends to file with newline separator", async () => {
      const filePath = join(configDir, "append.txt");
      writeFileSync(filePath, "existing content", "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/append.txt",
        append: "appended content",
        createBackup: false,
      });

      assert.equal(response.mode, "append");
      assert.equal(
        readFileSync(filePath, "utf-8"),
        "existing content\nappended content",
      );
    });

    it("appends without extra newline if file ends with newline", async () => {
      const filePath = join(configDir, "append.txt");
      writeFileSync(filePath, "existing content\n", "utf-8");

      await handleFileWrite({
        repoId,
        filePath: "config/append.txt",
        append: "appended content",
        createBackup: false,
      });

      assert.equal(
        readFileSync(filePath, "utf-8"),
        "existing content\nappended content",
      );
    });
  });

  describe("validation", () => {
    it("throws when no write mode specified", async () => {
      const filePath = join(configDir, "test.txt");
      writeFileSync(filePath, "test", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/test.txt",
        }),
        /Must specify exactly one write mode/,
      );
    });

    it("throws when multiple write modes specified", async () => {
      const filePath = join(configDir, "test.txt");
      writeFileSync(filePath, "test", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/test.txt",
          content: "new",
          append: "more",
        }),
        /Only one write mode allowed/,
      );
    });

    it("throws when jsonPath specified without jsonValue", async () => {
      const filePath = join(configDir, "config.json");
      writeFileSync(filePath, "{}", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/config.json",
          jsonPath: "key",
        }),
        /jsonValue is required when jsonPath is specified/,
      );
    });

    it("blocks path traversal attempts", async () => {
      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "../../../etc/passwd",
          content: "malicious",
          createIfMissing: true,
          createBackup: false,
        }),
        /path/i,
      );
    });
  });

  describe("token usage metadata", () => {
    it("attaches raw context for targeted writes", async () => {
      const filePath = join(configDir, "token.txt");
      const originalContent = "line1\nline2\nline3\nline4\nline5";
      writeFileSync(filePath, originalContent, "utf-8");

      const response = (await handleFileWrite({
        repoId,
        filePath: "config/token.txt",
        replaceLines: { start: 1, end: 2, content: "replaced" },
        createBackup: false,
      })) as Record<string, unknown>;

      assert.ok(response._rawContext);
      const rawContext = response._rawContext as { rawTokens: number };
      // Raw tokens based on max of original and new content
      assert.ok(rawContext.rawTokens > 0);
    });
  });
});
