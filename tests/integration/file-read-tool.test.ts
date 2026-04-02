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

  it("attaches full-file raw token baseline for targeted reads", async () => {
    const response = await handleFileRead({
      repoId,
      filePath: "docs/guide.md",
      offset: 2,
      limit: 1,
    }) as Record<string, unknown>;

    assert.equal(response.content, "3: alpha line");
    assert.equal(response.returnedLines, 1);
    assert.equal(response.truncated, false);
    assert.deepEqual(response._rawContext, {
      rawTokens: Math.ceil(Buffer.byteLength(fileContent, "utf-8") / 4),
    });
  });
});
