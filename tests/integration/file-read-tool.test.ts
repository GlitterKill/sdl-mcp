import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { handleFileGateway } from "../../dist/mcp/tools/file-gateway.js";
import { handleFileRead } from "../../dist/mcp/tools/file-read.js";
import { handleResponseGet } from "../../dist/mcp/tools/response.js";
import { registerCodeModeTools } from "../../dist/code-mode/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("sdl.file.read token usage metadata", () => {
  const testDir = join(__dirname, "test-file-read-tool");
  const graphDbPath = join(testDir, "graph");
  const repoId = "test-file-read-repo";
  const docsDir = join(testDir, "docs");
  const readmePath = join(docsDir, "guide.md");
  const fileContent = [
    "# Guide",
    "",
    "alpha line",
    "beta line",
    "gamma line",
  ].join("\n");

  beforeEach(async () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(readmePath, fileContent, "utf-8");

    const sourceDir = join(testDir, "src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "parseable.ts"),
      "export const value = 1;\n",
      "utf-8",
    );
    writeFileSync(
      join(sourceDir, "unparseable.mjs"),
      "export default function () {\n",
      "utf-8",
    );

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
        languages: ["md"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: false,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: "parseable-file",
      repoId,
      relPath: "src/parseable.ts",
      contentHash: "parseable",
      language: "typescript",
      byteSize: Buffer.byteLength("export const value = 1;\n", "utf-8"),
      lastIndexedAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: "unparseable-file",
      repoId,
      relPath: "src/unparseable.mjs",
      contentHash: "unparseable",
      language: "javascript",
      byteSize: Buffer.byteLength("export default function () {\n", "utf-8"),
      lastIndexedAt: now,
    });
    await ladybugDb.upsertFileParserStatesInTransaction(conn, [{
      stateId: JSON.stringify([repoId, "parseable-file"]),
      repoId,
      fileId: "parseable-file",
      engine: "typescript",
      engineContract: "typescript:1",
      adapterKey: "builtin:typescript:typescript:1",
      language: "typescript",
    }]);
  });

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("allows a bounded indexed source read when parser retrieval is unavailable", async () => {
    const response = await handleFileRead({
      repoId,
      filePath: "src/unparseable.mjs",
      maxTokens: 100,
    }) as Record<string, unknown>;

    assert.equal(response.retrievalFallback, "indexed-unparseable");
    assert.match(String(response.content), /export default/);
  });

  it("rejects an unbounded indexed source fallback", async () => {
    await assert.rejects(
      () => handleFileRead({
        repoId,
        filePath: "src/unparseable.mjs",
      }),
      /structured retrieval is unavailable.*maxTokens|maxBytes|offset|limit|search/i,
    );
  });

  it("keeps parseable indexed source on structured retrieval", async () => {
    await assert.rejects(
      () => handleFileGateway({
        op: "read",
        repoId,
        filePath: "src/parseable.ts",
        maxTokens: 100,
      }),
      /Use sdl\.context.*sdl\.retrieve/i,
    );
  });

  it("keeps sdl.file traversal errors free of host paths", async () => {
    let fileHandler: ((args: unknown) => Promise<unknown>) | undefined;
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        if (name === "sdl.file") fileHandler = handler;
      },
    };

    registerCodeModeTools(
      fakeServer as never,
      { liveIndex: undefined } as never,
      {
        enabled: true,
        exclusive: true,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 30_000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    );

    assert.ok(fileHandler);
    await assert.rejects(
      () => fileHandler?.({ op: "read", repoId, filePath: "../outside.md" }) as Promise<unknown>,
      (error: unknown) => {
        const modelFacing = JSON.stringify({
          name: (error as Error).name,
          message: (error as Error).message,
          code: (error as { code?: string }).code,
        });
        assert.match(modelFacing, /ValidationError/);
        assert.match(
          modelFacing,
          /Path traversal detected: target escapes repository root/,
        );
        assert.doesNotMatch(modelFacing, /test-file-read-tool|outside\.md|[A-Z]:[\\\\/]/i);
        return true;
      },
    );
  });

  it("attaches sliced-range raw token baseline for targeted reads", async () => {
    const response = await handleFileRead({
      repoId,
      filePath: "docs/guide.md",
      offset: 2,
      limit: 1,
    }) as Record<string, unknown>;

    assert.equal(response.content, "3: alpha line");
    assert.equal(response.returnedLines, 1);
    assert.equal(response.truncated, false);
    // Raw tokens now based on sliced content, not full file
    assert.deepEqual(response._rawContext, {
      rawTokens: Math.ceil(Buffer.byteLength("3: alpha line", "utf-8") / 4),
    });
  });

  it("adds a targeted-mode hint to large untargeted reads", async () => {
    const longPath = join(docsDir, "untargeted.md");
    const content = Array.from({ length: 200 }, (_, index) =>
      `line ${index + 1}`,
    ).join("\n");
    writeFileSync(longPath, content, "utf-8");

    const response = await handleFileRead({
      repoId,
      filePath: "docs/untargeted.md",
    }) as Record<string, unknown>;

    assert.equal(
      response.hint,
      "Large untargeted read. Use search+searchContext, offset+limit, or maxTokens to fetch only what you need.",
    );
  });

  it("omits the targeted-mode hint when a targeting arg is provided", async () => {
    const longPath = join(docsDir, "targeted.md");
    const content = Array.from({ length: 200 }, (_, index) =>
      index === 150 ? "needle" : `line ${index + 1}`,
    ).join("\n");
    writeFileSync(longPath, content, "utf-8");

    const response = await handleFileRead({
      repoId,
      filePath: "docs/targeted.md",
      search: "needle",
    }) as Record<string, unknown>;

    assert.equal(response.hint, undefined);
  });

  it("searches the whole file before applying the returned line limit", async () => {
    const longPath = join(docsDir, "long.md");
    const content = Array.from({ length: 40 }, (_, index) =>
      index === 29 ? "needle appears here" : `ordinary line ${index + 1}`,
    ).join("\n");
    writeFileSync(longPath, content, "utf-8");

    const response = await handleFileRead({
      repoId,
      filePath: "docs/long.md",
      search: "needle",
      limit: 10,
      searchContext: 0,
    }) as Record<string, unknown>;

    assert.match(String(response.content), />30: needle appears here/);
    assert.equal(response.matchCount, 1);
    assert.equal(response.returnedLines, 1);
  });

  it("keeps the matching line when returned line limit is smaller than context", async () => {
    const longPath = join(docsDir, "context-limit.md");
    const content = [
      "before one",
      "before two",
      "needle appears here",
      "after one",
      "after two",
    ].join("\n");
    writeFileSync(longPath, content, "utf-8");

    const response = await handleFileRead({
      repoId,
      filePath: "docs/context-limit.md",
      search: "needle",
      limit: 1,
      searchContext: 2,
    }) as Record<string, unknown>;

    assert.match(String(response.content), />3: needle appears here/);
    assert.doesNotMatch(String(response.content), /before one/);
    assert.equal(response.matchCount, 1);
    assert.equal(response.returnedLines, 1);
  });

  it("applies maxBytes after line-range extraction", async () => {
    const longPath = join(docsDir, "late-range.md");
    const content = Array.from({ length: 120 }, (_, index) =>
      "line " + (index + 1),
    ).join("\n");
    writeFileSync(longPath, content, "utf-8");

    const response = await handleFileRead({
      repoId,
      filePath: "docs/late-range.md",
      offset: 99,
      limit: 1,
      maxBytes: 20,
    }) as Record<string, unknown>;

    assert.equal(response.content, "100: line 100");
    assert.equal(response.totalLines, 120);
    assert.equal(response.truncated, false);
  });

  it("honors maxTokens for gateway reads", async () => {
    const longPath = join(docsDir, "token-limited.md");
    const content = Array.from({ length: 400 }, () => "abcde").join("\n");
    writeFileSync(longPath, content, "utf-8");

    const response = await handleFileGateway({
      op: "read",
      repoId,
      filePath: "docs/token-limited.md",
      maxTokens: 500,
    }) as Record<string, unknown>;

    assert.ok(Buffer.byteLength(String(response.content), "utf-8") <= 2_000);
    assert.equal(response.truncated, true);
    assert.equal(response.truncatedAt, 2_000);
    assert.equal(response.hint, undefined);
  });

  it("uses the tighter read bound when maxBytes and maxTokens are both set", async () => {
    const response = await handleFileGateway({
      op: "read",
      repoId,
      filePath: "docs/guide.md",
      maxBytes: 20,
      maxTokens: 100,
    }) as Record<string, unknown>;

    assert.ok(Buffer.byteLength(String(response.content), "utf-8") <= 20);
    assert.equal(response.truncated, true);
    assert.equal(response.truncatedAt, 20);
  });

  it("searches past maxBytes before applying response limits", async () => {
    const longPath = join(docsDir, "late-search.md");
    const content = Array.from({ length: 120 }, (_, index) =>
      index === 99 ? "needle appears late" : "ordinary line " + (index + 1),
    ).join("\n");
    writeFileSync(longPath, content, "utf-8");

    const response = await handleFileRead({
      repoId,
      filePath: "docs/late-search.md",
      search: "needle",
      searchContext: 0,
      maxBytes: 40,
    }) as Record<string, unknown>;

    assert.match(String(response.content), />100: needle appears late/);
    assert.equal(response.totalLines, 120);
    assert.equal(response.matchCount, 1);
  });

  it("caps search response content after matching", async () => {
    const longPath = join(docsDir, "wide-search.md");
    writeFileSync(longPath, "needle " + "x".repeat(200), "utf-8");

    const response = await handleFileRead({
      repoId,
      filePath: "docs/wide-search.md",
      search: "needle",
      searchContext: 0,
      maxBytes: 40,
    }) as Record<string, unknown>;

    assert.ok(Buffer.byteLength(String(response.content), "utf-8") <= 40);
    assert.match(String(response.content), /^>1: needle/);
    assert.ok(Number(response.bytes) > 40);
    assert.equal(response.truncated, true);
    assert.equal(response.truncatedAt, 40);
    assert.equal(response.matchCount, 1);
  });

  it("defaults file gateway reads to auto response handling", async () => {
    const largePath = join(docsDir, "gateway-large.md");
    writeFileSync(largePath, "gateway-preview\n" + "g".repeat(50_000), "utf-8");

    const response = await handleFileGateway({
      op: "read",
      repoId,
      filePath: "docs/gateway-large.md",
    }) as Record<string, unknown>;

    assert.equal(response.responseMode, "handle");
    assert.equal(response.kind, "responseArtifact");
    assert.match(
      String((response.preview as Record<string, unknown>).content),
      /gateway-preview/,
    );
  });

  it("returns a response artifact handle when responseMode is handle", async () => {
    const response = await handleFileRead({
      repoId,
      filePath: "docs/guide.md",
      responseMode: "handle",
    }) as Record<string, unknown>;

    assert.equal(response.responseMode, "handle");
    assert.equal(response.kind, "responseArtifact");
    assert.equal(response.action, "response.get");
    assert.equal(
      (response.metadata as Record<string, unknown>).toolName,
      "sdl.file.read",
    );

    const full = await handleResponseGet({
      repoId,
      handle: response.handle,
      full: true,
    }) as Record<string, unknown>;
    const content = full.content as Record<string, unknown>;
    assert.equal(content.filePath, "docs/guide.md");
    assert.equal(content.content, fileContent);
  });

  it("returns same-session deltas for repeated opted-in reads", async () => {
    const context = {
      sessionId: "file-read-delta-session",
      sendNotification: async () => {},
      signal: new AbortController().signal,
    };

    const first = await handleFileRead(
      {
        repoId,
        filePath: "docs/guide.md",
        deltaMode: "auto",
      },
      context,
    ) as Record<string, unknown>;
    const second = await handleFileRead(
      {
        repoId,
        filePath: "docs/guide.md",
        deltaMode: "auto",
      },
      context,
    ) as Record<string, unknown>;

    assert.equal(first.content, fileContent);
    assert.equal(second.content, "");
    assert.equal((second.sessionDelta as Record<string, unknown>).cacheHit, true);
    assert.equal((second.delta as Record<string, unknown>).status, "unchanged");
  });
});
