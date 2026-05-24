import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import { exec } from "../../dist/db/ladybug-core.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";

const REPO_ID = "metrics-recovery-repo";

describe("metrics recovery", () => {
  let graphDbPath = "";
  let repoDir = "";
  let configPath = "";
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  const prevDisableNative = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;

  before(async () => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-metrics-recovery-db-"));
    repoDir = mkdtempSync(join(tmpdir(), "sdl-metrics-recovery-repo-"));
    configPath = join(graphDbPath, "test-config.json");

    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "main.ts"),
      [
        "export function greet(name: string): string {",
        '  return "hello " + name;',
        "}",
        "",
        "export function shout(name: string): string {",
        "  return greet(name).toUpperCase();",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "metrics-recovery-fixture", version: "1.0.0" }),
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
          semantic: { enabled: false },
          liveIndex: { enabled: false },
          scip: { enabled: false, indexes: [] },
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
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: false,
        packageJsonPath: "package.json",
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: new Date().toISOString(),
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
    if (prevDisableNative === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = prevDisableNative;
    }
    for (const p of [graphDbPath, repoDir]) {
      if (p && existsSync(p)) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  it("repairs missing Metrics rows during no-op incremental refresh", async () => {
    const full = await indexRepo(REPO_ID, "full");
    assert.ok(full.versionId.length > 0);

    const connBeforeDamage = await getLadybugConn();
    const symbolCount = await ladybugDb.getSymbolCount(connBeforeDamage, REPO_ID);
    assert.ok(symbolCount > 0, "fixture full index should create symbols");
    await withWriteConn(async (wConn) => {
      await exec(
        wConn,
        `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
         MATCH (m:Metrics {symbolId: s.symbolId})
         DELETE m`,
        { repoId: REPO_ID },
      );
    });
    const missingBefore = await ladybugDb.getSymbolsMissingMetricsByRepo(
      await getLadybugConn(),
      REPO_ID,
    );
    assert.equal(missingBefore.length, symbolCount);

    const incremental = await indexRepo(
      REPO_ID,
      "incremental",
      undefined,
      undefined,
      { includeTimings: true },
    );

    assert.equal(incremental.changedFiles, 0);
    assert.ok(
      incremental.timings?.phases.recoverMissingMetrics !== undefined,
      "no-op recovery should use the missing-metrics repair path",
    );
    assert.equal(
      incremental.timings?.phases["finalizeIndexing.metrics"],
      undefined,
      "no-op recovery should not enter full metrics recomputation",
    );

    const finalConn = await getLadybugConn();
    const missingAfter = await ladybugDb.getSymbolsMissingMetricsByRepo(
      finalConn,
      REPO_ID,
    );
    assert.equal(missingAfter.length, 0);
    const metricsCount = await ladybugDb.querySingle<{ count: unknown }>(
      finalConn,
      `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
       WHERE coalesce(s.symbolStatus, 'real') = 'real'
       MATCH (m:Metrics)
       WHERE m.symbolId = s.symbolId
       RETURN count(m) AS count`,
      { repoId: REPO_ID },
    );
    assert.equal(ladybugDb.toNumber(metricsCount?.count ?? 0), symbolCount);
  });
});
