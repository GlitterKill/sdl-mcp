import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryLiveIndexCoordinator } from "../../dist/live-index/coordinator.js";
import * as db from "../../dist/db/ladybug-queries.js";
import {
  initLadybugDb,
  closeLadybugDb,
  getLadybugConn,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import {
  markGraphIntegrityVerified,
  getDerivedState,
  advanceGraphIntegrityRevisionInTransaction,
} from "../../dist/db/ladybug-derived-state.js";
import { capturePersistedGraphIntegrity } from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import { cancelAndWaitForGraphIntegrityVerifier } from "../../dist/indexer/provider-first/background-graph-integrity-verifier.js";
import { providerFactsToGraphRows } from "../../dist/indexer/provider-first/materializer.js";
import { RepoConfigSchema } from "../../dist/config/types.js";
import {
  generateFileId,
  hashContent,
  hashValue,
} from "../../dist/util/hashing.js";
import { isIndexingActive } from "../../dist/mcp/indexing-gate.js";
import { withRepoWriteHeavyLock } from "../../dist/indexer/derived-refresh-queue.js";
import { runToolDispatch } from "../../dist/mcp/dispatch-limiter.js";

import { withTransaction } from "../../dist/db/ladybug-core.js";
import { beginRepoRemoval } from "../../dist/services/repo-lifecycle.js";
import { publishReconcile, subscribeReconcilePublication } from "../../dist/live-index/reconcile-publisher.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it(
  "save 13 is admitted during provider 12 and only 13 publishes",
  { timeout: 30_000 },
  async () => {
    assert.equal(
      typeof InMemoryLiveIndexCoordinator.prototype.acceptSavedFile,
      "function",
    );
    const root = await mkdtemp(join(tmpdir(), "sdl-save-supersession-"));
    const repoRoot = join(root, "repo");
    const repoId = "save-supersession";
    const oldConfig = process.env.SDL_CONFIG;
    let coordinator: InMemoryLiveIndexCoordinator | undefined;
    const release = deferred();
    const contextEntered = deferred();
    const contextRelease = deferred();
    const removalEntered = deferred();
    const removalRelease = deferred();
    let contextRuns = 0;
    let configRuns = 0;
    let revisionRuns = 0;
    let publishingSourceHash: string | undefined;
    const notifications: Array<{ sourceHash: string | undefined; phase: string }> = [];
    const unsubscribe = subscribeReconcilePublication((event) => {
      if (event.repoId === repoId) notifications.push({ sourceHash: publishingSourceHash, phase: event.phase });
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
      const entered = deferred();
      const prepared: string[] = [];
      const publications: string[] = [];
      const commits: string[] = [];
      const writerQueued = deferred();
      coordinator = new InMemoryLiveIndexCoordinator({
        enabled: false,
        sweepIntervalMs: 0,
        reconcileDependencies: {
          prepareReconcileFiles: async (request) => {
            const file = request.files[0];
            prepared.push(file.content);
            if (file.content === "save12") {
              entered.resolve();
              await release.promise;
            }
            const name =
              file.path === "a.ts"
                ? file.content
                : "b-" +
                  (await readFile(join(repoRoot, "a.ts"), "utf8").catch(
                    () => "baseline",
                  ));
            const id = file.path === "a.ts" ? "a" : "b";
            const target = id === "a" ? "b" : "a";
            if (file.content === "save30")
              throw new Error("configured provider unavailable");
            if (file.content === "save40" && contextRuns++ === 0) {
              contextEntered.resolve();
              await contextRelease.promise;
              request.assertCurrent();
            }
            if (file.content === "save45" && configRuns++ === 0) {
              await writeFile(
                join(repoRoot, "tsconfig.json"),
                '{"compilerOptions":{"strict":true}}',
              );
            }
            if (file.content === "save46" && revisionRuns++ === 0) {
              await withWriteConn((conn) =>
                withTransaction(conn, async (tx) => {
                  const current = await getDerivedState(repoId);
                  const revision =
                    await advanceGraphIntegrityRevisionInTransaction(
                      tx,
                      repoId,
                      "v1",
                      current!.graphIntegrityRevision!,
                    );
                  const parser = await db.getRepoParserState(tx, repoId);
                  await db.upsertRepoParserStateInTransaction(tx, {
                    ...parser!,
                    graphRevision: revision!,
                  });
                }),
              );
            }
            if (file.content === "save50") {
              removalEntered.resolve();
              await removalRelease.promise;
            }
            const base = {
              repoId,
              generationId: file.content,
              providerType: "scip" as const,
              providerId: "fixture",
              emittedAt: "fixture",
            };
            const facts = {
              files: [
                {
                  ...base,
                  kind: "file" as const,
                  fileId: generateFileId(repoId, file.path),
                  relPath: file.path,
                  languageId: "typescript",
                  contentHash: file.contentHash,
                  byteSize: file.size,
                },
              ],
              symbols: [
                {
                  ...base,
                  kind: "symbol" as const,
                  symbolId: id,
                  providerSymbolId: id,
                  name,
                  symbolKind: "function" as const,
                  relPath: file.path,
                  range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
                  documentation: [],
                  external: false,
                },
              ],
              edges:
                name === "b-baseline"
                  ? []
                  : [
                      {
                        ...base,
                        kind: "edge" as const,
                        sourceSymbolId: id,
                        targetSymbolId: target,
                        edgeType: "import" as const,
                        resolution: "scip" as const,
                        confidence: 1,
                        dedupeKey: id + target,
                        relPath: file.path,
                      },
                    ],
              externalSymbols: [],
              occurrences: [],
              diagnostics: [],
              coverage: [],
              providerRuns: [],
            };
            return {
              kind: "provider" as const,
              files: [...request.files],
              dependencyInputs: [...request.dependencyInputs],
              configurationHash: hashValue({
                repoConfig: request.repoConfig,
                appConfig: request.appConfig,
              }),
              uncoveredPaths: [],
              result: { facts, rows: providerFactsToGraphRows({ facts }) },
            };
          },
          publishReconcile: async (prepared) => {
            const label = prepared.sources[0]?.contentHash ?? "removed";
            publications.push(label);
            publishingSourceHash = label;
            if (label === hashContent("save21")) writerQueued.resolve();
            const result = await publishReconcile(prepared);
            if (result.kind === "published") commits.push(label);
            return result;
          },
        },
      });
      await writeFile(join(repoRoot, "b.ts"), "b");
      await coordinator.acceptSavedFile({
        repoId,
        filePath: "b.ts",
        content: "b",
      });
      await coordinator.waitForIdle();
      assert.equal(
        (await getDerivedState(repoId))!.graphIntegrityRevision,
        1,
        JSON.stringify(await coordinator.getLiveStatus(repoId)),
      );
      await writeFile(join(repoRoot, "a.ts"), "save12");
      assert.equal(
        await coordinator.acceptSavedFile({
          repoId,
          filePath: "a.ts",
          content: "save12",
        }),
        true,
      );
      await Promise.race([
        entered.promise,
        new Promise((_, reject) =>
          setTimeout(
            async () =>
              reject(
                new Error(
                  JSON.stringify(await coordinator!.getLiveStatus(repoId)),
                ),
              ),
            2000,
          ),
        ),
      ]);
      assert.equal(isIndexingActive(), false);
      await withRepoWriteHeavyLock(repoId, async () => {});
      await runToolDispatch(async () => {
        assert.equal((await db.getFilesByRepo(conn, repoId)).length, 1);
        assert.equal(
          (await coordinator!.getLiveStatus(repoId)).reconcileInflight,
          true,
        );
      });
      await writeFile(join(repoRoot, "a.ts"), "save13");
      assert.equal(
        await coordinator.acceptSavedFile({
          repoId,
          filePath: "a.ts",
          content: "save13",
        }),
        true,
      );
      release.resolve();
      await coordinator.waitForIdle();
      assert.deepEqual(prepared, ["b", "save12", "save13", "b", "save13"]);
      assert.equal(
        publications.includes(hashContent("save12")),
        false,
        "superseded successful provider never enters publisher",
      );
      assert.equal(commits.includes(hashContent("save12")), false);
      assert.deepEqual(notifications.filter((notice) => notice.sourceHash === hashContent("save12")), []);
      assert.deepEqual(notifications.filter((notice) => notice.sourceHash === hashContent("save13")).map((notice) => notice.phase), ["started", "completed"]);
      assert.equal((await getDerivedState(repoId))!.graphIntegrityRevision, 3);
      assert.deepEqual(
        (await db.getSymbolsByRepo(conn, repoId)).map((s) => s.name).sort(),
        ["b-save13", "save13"],
      );
      assert.deepEqual(
        [...(await db.getEdgesFromSymbols(conn, ["a", "b"]))]
          .flatMap(([from, edges]) =>
            edges.map((edge) => [from, edge.toSymbolId, edge.edgeType]),
          )
          .sort(),
        [
          ["a", "b", "import"],
          ["b", "a", "import"],
        ],
      );
      assert.equal(
        (await db.getGraphIntegrityFileState(
          conn,
          repoId,
          generateFileId(repoId, "a.ts"),
        ))!.symbolCount,
        1,
      );
      assert.equal(
        (await db.getGraphIntegrityFileState(
          conn,
          repoId,
          generateFileId(repoId, "b.ts"),
        ))!.symbolCount,
        1,
      );
      assert.equal(
        (await db.getFileByRepoPath(conn, repoId, "a.ts"))!.contentHash,
        hashContent("save13"),
      );
      assert.equal(
        (await coordinator.getLiveStatus(repoId)).reconcileQueueDepth,
        0,
      );
      // A second edit must propagate again: convergence is full no-op, not suppression.
      const beforeSecond = prepared.length;
      await writeFile(join(repoRoot, "a.ts"), "save14");
      await coordinator.acceptSavedFile({
        repoId,
        filePath: "a.ts",
        content: "save14",
      });
      await coordinator.waitForIdle();
      assert.deepEqual(prepared.slice(beforeSecond), ["save14", "b", "save14"]);
      assert.equal((await getDerivedState(repoId))!.graphIntegrityRevision, 5);
      // Completed preparation must still lose ownership while waiting for the actual writer.
      const writerEntered = deferred();
      const writerRelease = deferred();
      const heldWriter = withWriteConn(async () => {
        writerEntered.resolve();
        await writerRelease.promise;
      });
      await writerEntered.promise;
      try {
        await writeFile(join(repoRoot, "a.ts"), "save21");
        await coordinator.acceptSavedFile({
          repoId,
          filePath: "a.ts",
          content: "save21",
        });
        await writerQueued.promise;
        await writeFile(join(repoRoot, "a.ts"), "save22");
        await coordinator.acceptSavedFile({
          repoId,
          filePath: "a.ts",
          content: "save22",
        });
      } finally {
        writerRelease.resolve();
      }
      await heldWriter;
      await coordinator.waitForIdle();
      assert.equal(commits.includes(hashContent("save21")), false);
      assert.deepEqual(notifications.filter((notice) => notice.sourceHash === hashContent("save21")), []);
      assert.equal(
        (await db.getFileByRepoPath(conn, repoId, "a.ts"))!.contentHash,
        hashContent("save22"),
      );
      assert.equal((await getDerivedState(repoId))!.graphIntegrityRevision, 7);
      // Failed latest work is retained without a provider hot loop; another save wakes it.
      await writeFile(join(repoRoot, "a.ts"), "save30");
      await coordinator.acceptSavedFile({
        repoId,
        filePath: "a.ts",
        content: "save30",
      });
      await coordinator.waitForIdle();
      assert.equal(prepared.filter((value) => value === "save30").length, 1);
      assert.match(
        (await coordinator.getLiveStatus(repoId)).reconcileLastError!,
        /configured provider unavailable/,
      );
      assert.equal(
        (await coordinator.getLiveStatus(repoId)).reconcileQueueDepth,
        1,
      );
      await writeFile(join(repoRoot, "a.ts"), "save31");
      await coordinator.acceptSavedFile({
        repoId,
        filePath: "a.ts",
        content: "save31",
      });
      await coordinator.waitForIdle();
      assert.equal(
        (await coordinator.getLiveStatus(repoId)).reconcileQueueDepth,
        0,
      );
      // Project/source context invalidates opaque provider reads even for the same file generation.
      await writeFile(join(repoRoot, "a.ts"), "save40");
      await coordinator.acceptSavedFile({
        repoId,
        filePath: "a.ts",
        content: "save40",
      });
      await contextEntered.promise;
      await writeFile(join(repoRoot, "tsconfig.json"), "{}");
      coordinator.invalidateSourceContext(repoId);
      contextRelease.resolve();
      await coordinator.waitForIdle();
      assert.equal(
        contextRuns,
        3,
        "obsolete preparation retries, then A-B-A reaches no-op",
      );
      assert.equal(
        commits.filter((value) => value === hashContent("save40")).length,
        1,
      );
      // Concrete config hashes catch changes before the watcher delivers an event.
      await writeFile(join(repoRoot, "a.ts"), "save45");
      await coordinator.acceptSavedFile({
        repoId,
        filePath: "./a.ts",
        content: "save45",
      });
      await coordinator.waitForIdle();
      assert.equal(configRuns, 3);
      assert.equal(
        commits.filter((value) => value === hashContent("save45")).length,
        1,
      );
      // Unrelated committed graph ownership changes require fresh provider preparation.
      await writeFile(join(repoRoot, "a.ts"), "save46");
      await coordinator.acceptSavedFile({
        repoId,
        filePath: "a.ts",
        content: "save46",
      });
      await coordinator.waitForIdle();
      assert.equal(revisionRuns, 3);
      assert.equal(
        commits.filter((value) => value === hashContent("save46")).length,
        1,
      );
      // Removal and close retain the admitted provider until its real promise settles.
      await writeFile(join(repoRoot, "a.ts"), "save50");
      await coordinator.acceptSavedFile({
        repoId,
        filePath: "a.ts",
        content: "save50",
      });
      await removalEntered.promise;
      let removed = false;
      let closed = false;
      const removing = beginRepoRemoval(repoId).then((value) => {
        removed = true;
        return value;
      });
      const closing = coordinator.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(removed, false);
      assert.equal(closed, false);
      assert.equal(
        await coordinator.acceptSavedFile({
          repoId,
          filePath: "a.ts",
          content: "late",
        }),
        false,
      );
      removalRelease.resolve();
      (await removing).commitTombstone();
      await closing;
      assert.equal(commits.includes(hashContent("save50")), false);
    } finally {
      release.resolve();
      contextRelease.resolve();
      removalRelease.resolve();
      await coordinator?.close();
      unsubscribe();
      await cancelAndWaitForGraphIntegrityVerifier(repoId);
      await closeLadybugDb();
      if (oldConfig === undefined) delete process.env.SDL_CONFIG;
      else process.env.SDL_CONFIG = oldConfig;
      assert.ok(root.startsWith(join(tmpdir(), "sdl-save-supersession-")));
      await rm(root, { recursive: true, force: true });
    }
  },
);
