import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../../dist/db/ladybug-queries.js";
import {
  initLadybugDb,
  closeLadybugDb,
  getLadybugConn,
} from "../../dist/db/ladybug.js";
import { markGraphIntegrityVerified } from "../../dist/db/ladybug-derived-state.js";
import { capturePersistedGraphIntegrity } from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import { cancelAndWaitForGraphIntegrityVerifier } from "../../dist/indexer/provider-first/background-graph-integrity-verifier.js";
import { RepoConfigSchema } from "../../dist/config/types.js";
import { scanRepoForIndex } from "../../dist/indexer/scanner.js";
import { prepareReconcileFiles } from "../../dist/indexer/provider-first/reconcile-preparation.js";
import { ReconcileQueue } from "../../dist/live-index/reconcile-queue.js";
import { ReconcileWorker } from "../../dist/live-index/reconcile-worker.js";
import { hashContent } from "../../dist/util/hashing.js";

it(
  "strict inventory retains unreadable work, rejects obsolete removals, and wakes at readiness",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "sdl-reconcile-inventory-"));
    const repoRoot = join(root, "repo");
    const repoId = "inventory-recovery";
    const previousConfig = process.env.SDL_CONFIG;
    const queue = new ReconcileQueue();
    let scans = 0;
    let preparations = 0;
    let failScan = false;
    let holdScan = false;
    let entered!: () => void;
    let release!: () => void;
    const scanEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const scanRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new ReconcileWorker(queue, {
      scanRepoForIndex: async (input) => {
        scans++;
        assert.equal(input.deleteRemovedFiles, false);
        assert.equal(input.requireComplete, true);
        if (failScan) throw new Error("unreadable inventory directory");
        const result = await scanRepoForIndex(input);
        if (holdScan) {
          holdScan = false;
          entered();
          await scanRelease;
        }
        return result;
      },
      prepareReconcileFiles: async (input) => {
        preparations++;
        return prepareReconcileFiles(input);
      },
    });
    try {
      await mkdir(repoRoot);
      const configPath = join(root, "config.json");
      await writeFile(
        configPath,
        JSON.stringify({
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
          scip: { enabled: false },
          semanticEnrichment: {
            providers: { scip: { enabled: false }, lsp: { enabled: false } },
          },
        }),
      );
      process.env.SDL_CONFIG = configPath;
      await initLadybugDb(join(root, "graph.lbug"));
      const conn = await getLadybugConn();
      await db.upsertRepo(conn, {
        repoId,
        rootPath: repoRoot,
        configJson: JSON.stringify(
          RepoConfigSchema.parse({
            repoId,
            rootPath: repoRoot,
            languages: ["ts"],
          }),
        ),
        createdAt: "fixture",
      });
      await db.createVersion(conn, {
        repoId,
        versionId: "v1",
        createdAt: "fixture",
        reason: "test",
        prevVersionHash: null,
        versionHash: null,
      });
      await db.replaceGraphIntegrityManifestInTransaction(conn, repoId, {
        files: [],
        fileless: [],
      });
      await db.upsertRepoParserStateInTransaction(conn, {
        repoId,
        graphVersionId: "v1",
        graphRevision: 0,
        ...(await db.summarizeParserCoverageInTransaction(conn, repoId)),
      });
      await markGraphIntegrityVerified(
        repoId,
        "v1",
        (await capturePersistedGraphIntegrity(conn, repoId)).digest,
      );
      const sourcePath = join(repoRoot, "a.ts");
      const original = "export const original = 12;\n";
      await writeFile(sourcePath, original);
      let ready = false;
      worker.setReadiness(repoId, () => ready);
      worker.requestInventory(repoId);
      await worker.waitForIdle();
      assert.equal(scans, 0);
      assert.equal(queue.getStatus(repoId).queueDepth, 1);
      ready = true;
      worker.wake(repoId);
      await worker.waitForIdle();
      assert.equal(
        (await db.getFileByRepoPath(conn, repoId, "a.ts"))?.contentHash,
        hashContent(original),
      );

      await unlink(sourcePath);
      failScan = true;
      worker.requestInventory(repoId);
      await worker.waitForIdle();
      assert.match(queue.getStatus(repoId).lastError!, /unreadable inventory/);
      assert.ok(
        await db.getFileByRepoPath(conn, repoId, "a.ts"),
        "incomplete scan must not delete",
      );
      failScan = false;
      holdScan = true;
      worker.requestInventory(repoId);
      await scanEntered;
      const latest = "export const latest = 13;\n";
      await writeFile(sourcePath, latest);
      worker.enqueue(
        repoId,
        {
          touchedSymbolIds: [],
          dependentSymbolIds: [],
          dependentFilePaths: [],
          importedFilePaths: [],
          invalidations: [],
        },
        undefined,
        { "a.ts": { kind: "disk-change" } },
      );
      release();
      await worker.waitForIdle();
      assert.equal(
        (await db.getFileByRepoPath(conn, repoId, "a.ts"))?.contentHash,
        hashContent(latest),
      );
      assert.equal(queue.getStatus(repoId).queueDepth, 0);

      const beforeForce = preparations;
      worker.requestInventory(repoId, true);
      await worker.waitForIdle();
      assert.equal(
        preparations,
        beforeForce + 1,
        "config recovery prepares unchanged source",
      );
      await unlink(sourcePath);
      worker.enqueue(
        repoId,
        {
          touchedSymbolIds: [],
          dependentSymbolIds: [],
          dependentFilePaths: [],
          importedFilePaths: [],
          invalidations: [],
        },
        undefined,
        { "a.ts": { kind: "disk-change" } },
      );
      await worker.waitForIdle();
      assert.equal(
        await db.getFileByRepoPath(conn, repoId, "a.ts"),
        null,
        "precise missing-path event retires only its file",
      );
      assert.equal(queue.getStatus(repoId).queueDepth, 0);
    } finally {
      release();
      await worker.waitForIdle();
      await cancelAndWaitForGraphIntegrityVerifier(repoId);
      await closeLadybugDb();
      if (previousConfig === undefined) delete process.env.SDL_CONFIG;
      else process.env.SDL_CONFIG = previousConfig;
      assert.ok(root.startsWith(join(tmpdir(), "sdl-reconcile-inventory-")));
      await rm(root, { recursive: true, force: true });
    }
  },
);
