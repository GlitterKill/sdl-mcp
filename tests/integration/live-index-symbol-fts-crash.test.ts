import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const fixturePath = process.env.SDL_LIVE_INDEX_FTS_FIXTURE;

it(
  "patches planner.ts with an active Symbol FTS fixture",
  { skip: fixturePath ? false : "set SDL_LIVE_INDEX_FTS_FIXTURE to a crash DB copy" },
  () => {
    assert.ok(fixturePath);
    assert.ok(existsSync(fixturePath), `fixture not found: ${fixturePath}`);

    const tempDir = mkdtempSync(join(tmpdir(), "sdl-live-index-fts-"));
    const dbCopy = join(tempDir, "sdl-mcp-graph.lbug");
    try {
      const fixtureStat = statSync(fixturePath);
      cpSync(fixturePath, dbCopy, { recursive: fixtureStat.isDirectory() });

      const childScript = `
import { readFileSync } from "node:fs";
import { closeLadybugDb, getLadybugConn, initLadybugDb } from "./dist/db/ladybug.js";
import { patchSavedFile } from "./dist/live-index/file-patcher.js";
import { indexExistsForTable, showIndexes, SYMBOL_FTS_INDEX_NAME } from "./dist/retrieval/index-lifecycle.js";

process.env.SDL_GRAPH_DB_PATH = ${JSON.stringify(dbCopy)};
await initLadybugDb(${JSON.stringify(dbCopy)});
const conn = await getLadybugConn();
const indexes = await showIndexes(conn);
if (!indexExistsForTable(indexes, "Symbol", SYMBOL_FTS_INDEX_NAME, "fts")) {
  throw new Error("fixture is missing active Symbol FTS index");
}
const content = readFileSync("src/agent/planner.ts", "utf8");
await patchSavedFile({
  repoId: "sdl-mcp",
  filePath: "src/agent/planner.ts",
  content,
  language: "typescript",
  version: Date.now(),
});
await closeLadybugDb();
`;

      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", childScript],
        {
          cwd: resolve("."),
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            SDL_GRAPH_DB_PATH: dbCopy,
            SDL_LOG_LEVEL: "error",
          },
        },
      );

      assert.equal(
        result.status,
        0,
        [
          `child exited with ${result.status}`,
          result.error?.stack ?? result.error?.message ?? "",
          result.stdout,
          result.stderr,
        ].join("\n"),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
