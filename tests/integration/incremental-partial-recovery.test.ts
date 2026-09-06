import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { getRepositorySymbolVectorHealthGeneration } from "../../dist/retrieval/health.js";

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
      join(repoDir, "src", "helper.ts"),
      [
        "export function helper(value: string): string {",
        "  return value.trim();",
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

  it("rejects no-op recovery when the latest integrity baseline is missing", async () => {
    const full = await indexRepo(REPO_ID, "full", undefined, undefined, {
      isolatedRebuild: true,
    });
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
    await assert.rejects(
      indexRepo(REPO_ID, "incremental"),
      /Incremental indexing requires a verified graph integrity baseline.*--safe-rebuild/i,
    );
    assert.equal(
      (await ladybugDb.getLatestVersion(await getLadybugConn(), REPO_ID))?.versionId,
      full.versionId,
      "failed no-op validation must not create a replacement version",
    );
    assert.equal(
      await getScipIngestionRecord(await getLadybugConn(), REPO_ID, "index.scip"),
      null,
    );
  });

  it("repairs only missing file summaries during no-op incremental recovery", async () => {
    await indexRepo(REPO_ID, "full", undefined, undefined, {
      isolatedRebuild: true,
    });
    const conn = await getLadybugConn();
    const summaries = await ladybugDb.queryAll<{
      fileId: string;
      relPath: string;
    }>(
      conn,
      `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
       MATCH (fs:FileSummary {repoId: $repoId})
       WHERE fs.fileId = f.fileId
       RETURN f.fileId AS fileId, f.relPath AS relPath
       ORDER BY f.relPath`,
      { repoId: REPO_ID },
    );
    const preserved = summaries.find((row) => row.relPath === "src/main.ts");
    const missing = summaries.find((row) => row.relPath === "src/helper.ts");
    assert.ok(preserved, "full index should create a main.ts file summary");
    assert.ok(missing, "full index should create a helper.ts file summary");

    const sentinelSummary = "sentinel summary must survive missing-row repair";
    const sentinelSearchText = "sentinel search text must survive repair";
    await withWriteConn(async (wConn) => {
      await exec(
        wConn,
        `MATCH (fs:FileSummary {fileId: $fileId})
         SET fs.summary = $summary,
             fs.searchText = $searchText,
             fs.updatedAt = $updatedAt`,
        {
          fileId: preserved.fileId,
          summary: sentinelSummary,
          searchText: sentinelSearchText,
          updatedAt: "2000-01-01T00:00:00.000Z",
        },
      );
      await exec(
        wConn,
        `MATCH (fs:FileSummary {fileId: $fileId})
         DETACH DELETE fs`,
        { fileId: missing.fileId },
      );
      await exec(
        wConn,
        `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
         SET f.lastIndexedAt = $lastIndexedAt`,
        {
          repoId: REPO_ID,
          lastIndexedAt: "2999-01-01T00:00:00.000Z",
        },
      );
    });

    const incremental = await indexRepo(REPO_ID, "incremental");

    assert.equal(incremental.changedFiles, 0);
    const repairedConn = await getLadybugConn();
    const preservedAfter = await ladybugDb.getFileSummary(
      repairedConn,
      preserved.fileId,
    );
    const missingAfter = await ladybugDb.getFileSummary(
      repairedConn,
      missing.fileId,
    );
    assert.equal(preservedAfter?.summary, sentinelSummary);
    assert.equal(preservedAfter?.searchText, sentinelSearchText);
    assert.ok(missingAfter, "no-op recovery should recreate the missing summary");
    assert.notEqual(missingAfter.summary, sentinelSummary);
  });

  it("preserves pending semantic state during no-change structural recovery", async () => {
    const full = await indexRepo(REPO_ID, "full", undefined, undefined, {
      isolatedRebuild: true,
    });
    const savedConfig = readFileSync(configPath, "utf8");
    const config = JSON.parse(savedConfig);
    config.semantic = {
      enabled: true,
      provider: "mock",
      generateSummaries: false,
      embeddingProfile: "specialized",
      symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
      fileSummaryEmbeddingModels: [],
    };
    writeFileSync(configPath, JSON.stringify(config), "utf8");
    try {
      for (const lifecycleState of ["steady", "refreshing"]) {
        // Missing metrics force structural repair while semantic work remains pending.
        await withWriteConn(async (conn) => {
          await exec(conn,
            `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
             MATCH (m:Metrics {symbolId: s.symbolId}) DELETE m`,
            { repoId: REPO_ID },
          );
          await exec(conn,
            `MATCH (d:DerivedState {repoId: $repoId})
             SET d.summariesDirty = true, d.embeddingsDirty = true,
                 d.embeddingLifecycleState = $lifecycleState,
                 d.lastError = $lastError`,
            { repoId: REPO_ID, lifecycleState, lastError: "pending semantic repair" },
          );
        });
        const generation = getRepositorySymbolVectorHealthGeneration(REPO_ID);
        const incremental = await indexRepo(REPO_ID, "incremental");
        assert.equal(incremental.changedFiles, 0);
        assert.equal(incremental.versionId, full.versionId);
        assert.equal((await ladybugDb.getSymbolsMissingMetricsByRepo(
          await getLadybugConn(), REPO_ID,
        )).length, 0, "structural recovery must repair missing metrics");
        const state = await getDerivedState(REPO_ID);
        assert.equal(state?.summariesDirty, true);
        assert.equal(state?.embeddingsDirty, true);
        assert.equal(state?.embeddingLifecycleState, lifecycleState);
        assert.equal(state?.lastError, "pending semantic repair");
        assert.equal(getRepositorySymbolVectorHealthGeneration(REPO_ID), generation);

        // Pending semantics alone must not rerun structural finalization.
        const repeated = await indexRepo(REPO_ID, "incremental");
        assert.equal(repeated.changedFiles, 0);
        assert.equal(repeated.algorithmRefresh, undefined);
        assert.equal(getRepositorySymbolVectorHealthGeneration(REPO_ID), generation);
      }
    } finally {
      writeFileSync(configPath, savedConfig, "utf8");
    }
  });
});
