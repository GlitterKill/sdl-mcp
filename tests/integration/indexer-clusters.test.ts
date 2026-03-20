import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ID = "test-indexer-clusters-repo";

describe("Indexer cluster/process integration", () => {
  const graphDbPath = join(tmpdir(), ".lbug-indexer-clusters-test-db");
  const configPath = join(graphDbPath, "test-config.json");
  let repoDir: string | null = null;
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    mkdirSync(graphDbPath, { recursive: true });

    repoDir = mkdtempSync(join(tmpdir(), "sdl-mcp-indexer-clusters-repo-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });

    writeFileSync(
      join(repoDir, "src", "app.ts"),
      [
        "export function main() {",
        "  return foo();",
        "}",
        "",
        "export function foo() {",
        "  return bar();",
        "}",
        "",
        "export function bar() {",
        "  return 123;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
        },
        null,
        2,
      ),
      "utf8",
    );

    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();

    const now = new Date().toISOString();
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoDir,
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
  });

  after(async () => {
    await closeLadybugDb();
    if (prevSDL_CONFIG === undefined) {
      delete process.env.SDL_CONFIG;
    } else {
      process.env.SDL_CONFIG = prevSDL_CONFIG;
    }
    if (prevSDL_CONFIG_PATH === undefined) {
      delete process.env.SDL_CONFIG_PATH;
    } else {
      process.env.SDL_CONFIG_PATH = prevSDL_CONFIG_PATH;
    }
    try {
      rmSync(graphDbPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (repoDir) {
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      repoDir = null;
    }
  });

  it("computes clusters and processes during a full index", async () => {
    const result = await indexRepo(REPO_ID, "full");

    assert.ok(result.versionId.length > 0);
    assert.ok(result.clustersComputed >= 1);
    assert.ok(result.processesTraced >= 1);

    const conn = await getLadybugConn();
    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);
    assert.ok(symbols.length >= 3);

    const main = symbols.find((s) => s.name === "main" && s.kind === "function");
    const foo = symbols.find((s) => s.name === "foo" && s.kind === "function");
    const bar = symbols.find((s) => s.name === "bar" && s.kind === "function");
    assert.ok(main && foo && bar);

    const cluster = await ladybugDb.getClusterForSymbol(conn, main.symbolId);
    assert.ok(cluster);

    const members = await ladybugDb.getClusterMembers(conn, cluster.clusterId);
    assert.ok(members.length >= 3);

    const procsForMain = await ladybugDb.getProcessesForSymbol(conn, main.symbolId);
    assert.ok(procsForMain.length >= 1);

    const flow = await ladybugDb.getProcessFlow(conn, procsForMain[0]!.processId);
    const symbolNameById = new Map(symbols.map((s) => [s.symbolId, s.name] as const));
    const flowNames = flow.map((step) => symbolNameById.get(step.symbolId));
    assert.deepStrictEqual(flowNames.slice(0, 3), ["main", "foo", "bar"]);
  });
});
