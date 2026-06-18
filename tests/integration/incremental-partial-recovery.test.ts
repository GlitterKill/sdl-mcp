import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import { exec } from "../../dist/db/ladybug-core.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { getDerivedState } from "../../dist/db/ladybug-derived-state.js";
import { getScipIngestionRecord } from "../../dist/db/ladybug-scip.js";
import { indexRepo } from "../../dist/indexer/indexer.js";

const REPO_ID = "incremental-partial-recovery-repo";

describe("incremental index partial-run recovery", () => {
  let graphDbPath = "";
  let repoDir = "";
  let configPath = "";
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  const prevDisableNative = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;

  before(async () => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-partial-recovery-db-"));
    repoDir = mkdtempSync(join(tmpdir(), "sdl-partial-recovery-repo-"));
    configPath = join(graphDbPath, "test-config.json");

    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "main.ts"),
      [
        "export function greet(name: string): string {",
        '  return "hello " + name;',
        "}",
        "",
        "export function farewell(name: string): string {",
        '  return "goodbye " + name;',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(repoDir, "index.scip"),
      "disabled legacy SCIP input should not be ingested",
      "utf8",
    );
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "partial-recovery-fixture", version: "1.0.0" }),
      "utf8",
    );

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: {
            pipeline: "legacy",
            engine: "typescript",
            enableFileWatching: false,
          },
          semantic: { enabled: false },
          liveIndex: { enabled: false },
          scip: {
            enabled: false,
            indexes: [{ path: "index.scip" }],
            externalSymbols: { enabled: true, maxPerIndex: 10_000 },
            confidence: 0.95,
            autoIngestOnRefresh: true,
            generator: {
              enabled: false,
              binary: "scip-io",
              args: [],
              autoInstall: false,
              timeoutMs: 600_000,
            },
          },
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
        ignore: ["**/*.scip"],
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

  it("recovers derived state during no-op incremental refresh without legacy SCIP ingestion", async () => {
    const full = await indexRepo(REPO_ID, "full");
    assert.ok(full.versionId.length > 0);
    assert.equal(
      await getScipIngestionRecord(await getLadybugConn(), REPO_ID, "index.scip"),
      null,
      "legacy full indexing should not ingest SCIP indexes when SCIP is disabled",
    );

    await withWriteConn(async (wConn) => {
      await exec(wConn, "MATCH (d:DerivedState {repoId: $repoId}) DETACH DELETE d", {
        repoId: REPO_ID,
      });
    });
    assert.equal(await getDerivedState(REPO_ID), null);

    const connBeforeDamage = await getLadybugConn();
    const removedSnapshot = await ladybugDb.querySingle<{ id: string }>(
      connBeforeDamage,
      `MATCH (sv:SymbolVersion {versionId: $versionId})
       RETURN sv.id AS id
       LIMIT 1`,
      { versionId: full.versionId },
    );
    assert.ok(removedSnapshot, "fixture full index should create a snapshot row");
    const removedMetrics = await ladybugDb.querySingle<{ symbolId: string }>(
      connBeforeDamage,
      `MATCH (m:Metrics)
       RETURN m.symbolId AS symbolId
       LIMIT 1`,
      {},
    );
    assert.ok(removedMetrics, "fixture full index should create a metrics row");
    await withWriteConn(async (wConn) => {
      await exec(wConn, "MATCH (sv:SymbolVersion {id: $id}) DELETE sv", {
        id: removedSnapshot.id,
      });
      await exec(wConn, "MATCH (m:Metrics {symbolId: $symbolId}) DELETE m", {
        symbolId: removedMetrics.symbolId,
      });
    });

    assert.equal(
      await getScipIngestionRecord(await getLadybugConn(), REPO_ID, "index.scip"),
      null,
    );

    const incremental = await indexRepo(REPO_ID, "incremental");

    assert.equal(incremental.changedFiles, 0);
    const conn = await getLadybugConn();
    assert.equal(
      await getScipIngestionRecord(conn, REPO_ID, "index.scip"),
      null,
      "legacy no-op incremental recovery should not ingest SCIP indexes",
    );
    const derived = await getDerivedState(REPO_ID);
    assert.ok(derived, "no-op incremental recovery should recreate DerivedState");
    assert.equal(derived.computedVersionId, incremental.versionId);

    const finalConn = await getLadybugConn();
    const symbolCount = await ladybugDb.getSymbolCount(finalConn, REPO_ID);
    const snapshotCount = await ladybugDb.querySingle<{ count: unknown }>(
      finalConn,
      `MATCH (sv:SymbolVersion {versionId: $versionId})
       RETURN count(sv) AS count`,
      { versionId: incremental.versionId },
    );
    assert.equal(ladybugDb.toNumber(snapshotCount?.count ?? 0), symbolCount);
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
