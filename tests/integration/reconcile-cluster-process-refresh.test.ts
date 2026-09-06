import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { ReconcileQueue } from "../../dist/live-index/reconcile-queue.js";
import { ReconcileWorker } from "../../dist/live-index/reconcile-worker.js";
import { prepareReconcileFiles } from "../../dist/indexer/provider-first/reconcile-preparation.js";
import { cancelAndWaitForGraphIntegrityVerifier } from "../../dist/indexer/provider-first/background-graph-integrity-verifier.js";
import { getDerivedState } from "../../dist/db/ladybug-derived-state.js";
import { isIndexingActive } from "../../dist/mcp/indexing-gate.js";
import { hashContent } from "../../dist/util/hashing.js";

describe("reconcile derived-data refresh", () => {
  const repoId = "reconcile-derived-data-repo";
  const ownedRoot = mkdtempSync(join(tmpdir(), "sdl-reconcile-derived-data-"));
  const dbPath = join(ownedRoot, "graph.lbug");
  const configPath = join(ownedRoot, "config.json");
  const repoDir = join(ownedRoot, "repo");
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "app.ts"),
      [
        "export function apphandler() {",
        "  return helper();",
        "}",
        "",
        "export function helper() {",
        "  return 1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [], policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
          scip: { enabled: false },
          semanticEnrichment: { providers: { scip: { enabled: false }, lsp: { enabled: false } } },
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    await closeLadybugDb();
    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const now = "2026-03-07T12:00:00.000Z";
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
      }),
      createdAt: now,
    });
    await indexRepo(repoId, "full");
  });

  after(async () => {
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    await closeLadybugDb();
    const ownedRelative = relative(resolve(tmpdir()), resolve(ownedRoot));
    assert.ok(ownedRelative.startsWith("sdl-reconcile-derived-data-") && !isAbsolute(ownedRelative) && !ownedRelative.includes(".."));
    if (existsSync(ownedRoot)) rmSync(ownedRoot, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = prevConfig;
    if (prevConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = prevConfigPath;
  });

  it("retains explicit derived maintenance instead of automatically rebuilding clusters/processes", async () => {
    const conn = await getLadybugConn();
    await ladybugDb.deleteClustersByRepo(conn, repoId);
    await ladybugDb.deleteProcessesByRepo(conn, repoId);

    const queue = new ReconcileQueue();
    let preparationCalls = 0;
    const worker = new ReconcileWorker(queue, {
      prepareReconcileFiles: async (request) => {
        preparationCalls++;
        assert.equal(isIndexingActive(), false, "provider preparation must not acquire index dispatch ownership");
        return prepareReconcileFiles(request);
      },
    });
    const content = "export function changedhandler() { return 2; }\n";
    writeFileSync(join(repoDir, "src", "app.ts"), content);
    worker.enqueue(
      repoId,
      {
        touchedSymbolIds: ["dummy"],
        dependentSymbolIds: [],
        dependentFilePaths: [],
        importedFilePaths: [],
        invalidations: ["clusters", "processes"],
      },
      "2026-03-07T12:10:00.000Z",
      { "src/app.ts": { kind: "saved", content, sourceHash: hashContent(content) } },
    );
    await worker.waitForIdle();
    assert.ok(preparationCalls > 0, "the worker must publish a real source change");
    assert.equal(queue.getStatus(repoId).queueDepth, 0, JSON.stringify(queue.getStatus(repoId)));
    assert.equal((await ladybugDb.getFileByRepoPath(conn, repoId, "src/app.ts"))!.contentHash, hashContent(content));
    const state = await getDerivedState(repoId);
    assert.equal(state?.clustersDirty, true);
    assert.equal(state?.processesDirty, true);
    assert.equal(state?.summariesDirty, true);
    assert.equal(state?.embeddingsDirty, true);
    assert.equal(isIndexingActive(), false);

    const clusters = await ladybugDb.getClustersForRepo(conn, repoId);
    const processStats = await ladybugDb.getProcessOverviewStats(conn, repoId);
    assert.equal(clusters.length, 0);
    assert.equal(processStats.totalProcesses, 0);
  });
});
