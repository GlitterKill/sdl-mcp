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
import { handleFileRead } from "../../dist/mcp/tools/file-read.js";
import { handleResponseGet } from "../../dist/mcp/tools/response.js";

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
  });

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
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
