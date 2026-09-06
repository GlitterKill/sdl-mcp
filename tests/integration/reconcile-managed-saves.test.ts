import assert from "node:assert/strict";
import { it } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  stat,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryLiveIndexCoordinator } from "../../dist/live-index/coordinator.js";
import { handleFileWrite } from "../../dist/mcp/tools/file-write.js";
import { applyBatch } from "../../dist/mcp/tools/search-edit/batch-executor.js";
import {
  initLadybugDb,
  closeLadybugDb,
  getLadybugConn,
} from "../../dist/db/ladybug.js";
import * as db from "../../dist/db/ladybug-queries.js";
import { RepoConfigSchema } from "../../dist/config/types.js";
import { markGraphIntegrityVerified } from "../../dist/db/ladybug-derived-state.js";
import { capturePersistedGraphIntegrity } from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import { cancelAndWaitForGraphIntegrityVerifier } from "../../dist/indexer/provider-first/background-graph-integrity-verifier.js";
import { prepareReconcileFiles } from "../../dist/indexer/provider-first/reconcile-preparation.js";
import { publishReconcile } from "../../dist/live-index/reconcile-publisher.js";
import { hashContent } from "../../dist/util/hashing.js";
import { isIndexingActive } from "../../dist/mcp/indexing-gate.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it(
  "managed file and batch saves share buffer invalidation without waiting for preparation",
  { timeout: 40_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "sdl-managed-save-"));
    const repoRoot = join(root, "repo");
    const repoId = "managed-save";
    const oldConfig = process.env.SDL_CONFIG;
    let coordinator: InMemoryLiveIndexCoordinator | undefined;
    const entered = deferred();
    const release = deferred();
    const bufferEntered = deferred();
    const bufferRelease = deferred();
    const rollbackEntered = deferred();
    const rollbackRelease = deferred();
    const failedEntered = deferred();
    const failedRelease = deferred();
    const content = (n: number) => `export const save${n} = ${n};\n`;
    let failSameHash = false;
    const publications: string[] = [];
    const preparations: string[] = [];
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
        createdAt: "fixture",
        configJson: JSON.stringify(
          RepoConfigSchema.parse({
            repoId,
            rootPath: repoRoot,
            languages: ["ts"],
            scip: { enabled: false },
            semanticEnrichment: {
              providers: { scip: { enabled: false }, lsp: { enabled: false } },
            },
          }),
        ),
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
      coordinator = new InMemoryLiveIndexCoordinator({
        enabled: false,
        sweepIntervalMs: 0,
        reconcileDependencies: {
          prepareReconcileFiles: async (request) => {
            const source = request.files[0].content;
            preparations.push(source);
            const prepared = await prepareReconcileFiles(request);
            if (source === content(12)) {
              entered.resolve();
              await release.promise;
            }
            if (source === content(14)) {
              bufferEntered.resolve();
              await bufferRelease.promise;
            }
            if (source === content(20)) {
              failedEntered.resolve();
              await failedRelease.promise;
              throw new Error("provider unavailable");
            }
            return prepared;
          },
          publishReconcile: async (prepared) => {
            publications.push(prepared.sources[0]?.contentHash ?? "removed");
            return publishReconcile(prepared);
          },
        },
      });
      const first = await handleFileWrite(
        { repoId, filePath: "a.ts", content: content(12), createBackup: false },
        undefined,
        coordinator,
      );
      assert.deepEqual(first.indexUpdate, { applied: false, pending: true });
      await entered.promise;
      assert.equal(isIndexingActive(), false);
      assert.equal(await db.getFileByRepoPath(conn, repoId, "a.ts"), null);
      const path = realpathSync.native(join(repoRoot, "a.ts"));
      const batch = await applyBatch(
        {
          planHandle: "fixture",
          repoId,
          createdAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
          defaultCreateBackup: false,
          consumed: false,
          summary: {},
          edits: [
            {
              relPath: "a.ts",
              absPath: path,
              newContent: content(13),
              createBackup: false,
              fileExists: true,
              indexedSource: true,
              matchCount: 1,
              editMode: "overwrite",
            },
          ],
          preconditions: [
            {
              relPath: "a.ts",
              absPath: path,
              canonicalAbsPath: path,
              sha256: hashContent(content(12)),
              mtimeMs: null,
            },
          ],
        },
        false,
        coordinator,
      );
      assert.deepEqual(batch.results[0].indexUpdate, {
        applied: false,
        pending: true,
      });
      assert.equal(await readFile(path, "utf8"), content(13));
      assert.deepEqual(publications, []);
      release.resolve();
      await coordinator.waitForIdle();
      assert.equal(
        (await coordinator.getLiveStatus(repoId)).reconcileLastError,
        null,
      );
      assert.deepEqual(publications, [hashContent(content(13))]);
      assert.equal(
        (await db.getFileByRepoPath(conn, repoId, "a.ts"))?.contentHash,
        hashContent(content(13)),
      );
      await coordinator.close();

      // Buffer and managed file saves use one selected coordinator even at equal buffer versions.
      coordinator = new InMemoryLiveIndexCoordinator({
        debounceMs: 0,
        sweepIntervalMs: 0,
        reconcileDependencies: {
          prepareReconcileFiles: async (request) => {
            const prepared = await prepareReconcileFiles(request);
            preparations.push(request.files[0].content);
            if (request.files[0].content === content(16)) {
              rollbackEntered.resolve();
              await rollbackRelease.promise;
            }
            if (failSameHash && request.files[0].content === content(15))
              throw new Error("same-hash provider failure");
            if (request.files[0].content === content(14)) {
              bufferEntered.resolve();
              await bufferRelease.promise;
            }
            if (request.files[0].content === content(20)) {
              failedEntered.resolve();
              await failedRelease.promise;
              throw new Error("provider unavailable");
            }
            return prepared;
          },
          publishReconcile: async (prepared) => {
            publications.push(prepared.sources[0]?.contentHash ?? "removed");
            return publishReconcile(prepared);
          },
        },
      });
      const buffer = {
        repoId,
        filePath: "a.ts",
        content: content(14),
        language: "typescript",
        version: 14,
        dirty: true,
        timestamp: "fixture",
        eventType: "change" as const,
      };
      await coordinator.pushBufferUpdate(buffer);
      await writeFile(path, content(14));
      const saved = await coordinator.pushBufferUpdate({
        ...buffer,
        eventType: "save",
        dirty: false,
      });
      assert.equal(saved.accepted, true);
      await bufferEntered.promise;
      const next = await handleFileWrite(
        { repoId, filePath: "a.ts", content: content(15), createBackup: false },
        undefined,
        coordinator,
      );
      assert.deepEqual(next.indexUpdate, { applied: false, pending: true });
      await coordinator.pushBufferUpdate({
        ...buffer,
        content: content(99),
        version: 99,
      });
      bufferRelease.resolve();
      await coordinator.waitForIdle();
      assert.deepEqual(publications, [
        hashContent(content(13)),
        hashContent(content(15)),
      ]);
      assert.equal(
        coordinator.getOverlayStore().getDraft(repoId, "a.ts")?.dirty,
        true,
      );
      assert.equal(
        (await db.getFileByRepoPath(conn, repoId, "a.ts"))?.contentHash,
        hashContent(content(15)),
      );

      const cleanCommitted = await coordinator.pushBufferUpdate({
        ...buffer,
        eventType: "save",
        dirty: false,
        version: 100,
        content: content(15),
      });
      assert.equal(cleanCommitted.accepted, true);
      await coordinator.waitForIdle();
      const beforeCheckpoint = preparations.length;
      assert.equal(
        (await coordinator.checkpointRepo({ repoId })).checkpointedFiles,
        1,
      );
      assert.equal(
        preparations.length,
        beforeCheckpoint,
        "checkpoint reran providers for an already committed save",
      );

      // Mid-batch failure restores through the same ownership fence and supersedes prepared rows.
      const secondPath = join(repoRoot, "b.ts");
      await writeFile(secondPath, content(13));
      const originalMutation =
        coordinator.runSavedFileMutation.bind(coordinator);
      coordinator.runSavedFileMutation = async (input, operation) => {
        if (input.filePath === "b.ts") {
          await rollbackEntered.promise;
          throw new Error("second-file write failure");
        }
        return originalMutation(input, operation);
      };
      const rollback = await applyBatch(
        {
          planHandle: "rollback",
          repoId,
          createdAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
          defaultCreateBackup: true,
          consumed: false,
          summary: {},
          edits: [
            {
              relPath: "a.ts",
              absPath: path,
              newContent: content(16),
              createBackup: true,
              fileExists: true,
              indexedSource: true,
              matchCount: 1,
              editMode: "overwrite",
            },
            {
              relPath: "b.ts",
              absPath: secondPath,
              newContent: content(17),
              createBackup: true,
              fileExists: true,
              indexedSource: true,
              matchCount: 1,
              editMode: "overwrite",
            },
          ],
          preconditions: [
            {
              relPath: "a.ts",
              absPath: path,
              canonicalAbsPath: path,
              sha256: hashContent(content(15)),
              mtimeMs: null,
            },
            {
              relPath: "b.ts",
              absPath: secondPath,
              canonicalAbsPath: secondPath,
              sha256: hashContent(content(13)),
              mtimeMs: null,
            },
          ],
        },
        true,
        coordinator,
      );
      coordinator.runSavedFileMutation = originalMutation;
      assert.equal(rollback.rollback.triggered, true);
      assert.deepEqual(rollback.rollback.restoredFiles, ["a.ts"]);
      assert.equal(await readFile(path, "utf8"), content(15));
      rollbackRelease.resolve();
      await coordinator.waitForIdle();
      assert.ok(!publications.includes(hashContent(content(16))));

      // A failed asynchronous provider leaves the successfully saved source recoverable.
      const failed = await handleFileWrite(
        { repoId, filePath: "a.ts", content: content(20), createBackup: false },
        undefined,
        coordinator,
      );
      assert.deepEqual(failed.indexUpdate, { applied: false, pending: true });
      await failedEntered.promise;
      failedRelease.resolve();
      await coordinator.waitForIdle();
      assert.equal(await readFile(path, "utf8"), content(20));
      assert.match(
        (await coordinator.getLiveStatus(repoId)).reconcileLastError ?? "",
        /provider unavailable/,
      );
      assert.ok(preparations.includes(content(12)));

      failSameHash = true;
      await handleFileWrite(
        { repoId, filePath: "a.ts", content: content(15), createBackup: false },
        undefined,
        coordinator,
      );
      await coordinator.waitForIdle();
      assert.equal(
        (await db.getFileByRepoPath(conn, repoId, "a.ts"))?.contentHash,
        hashContent(content(15)),
      );
      const clean = await coordinator.pushBufferUpdate({
        ...buffer,
        eventType: "save",
        dirty: false,
        version: 100,
        content: content(15),
      });
      assert.equal(clean.accepted, true);
      const checkpoint = await coordinator.checkpointRepo({
        repoId,
        reason: "test",
      });
      assert.equal(checkpoint.checkpointedFiles, 0);
      assert.equal(checkpoint.failedFiles, 1);
      assert.equal(
        coordinator.getOverlayStore().getDraft(repoId, "a.ts")?.version,
        100,
      );

      const mismatched = await coordinator.pushBufferUpdate({
        ...buffer,
        eventType: "save",
        dirty: false,
        version: 101,
        content: content(101),
      });
      assert.equal(mismatched.accepted, false);
      assert.equal(
        coordinator.getOverlayStore().getDraft(repoId, "a.ts")?.version,
        100,
      );

      // The shared callback boundary also retains the final source after partial write failure.
      failSameHash = false;
      await assert.rejects(
        coordinator.runSavedFileMutation(
          { repoId, filePath: "a.ts" },
          async (target) => {
            await writeFile(target, content(21));
            throw new Error("partial callback failure");
          },
        ),
        /partial callback failure/,
      );
      await coordinator.waitForIdle();
      assert.equal(
        (await db.getFileByRepoPath(conn, repoId, "a.ts"))?.contentHash,
        hashContent(content(21)),
      );
      await coordinator.runSavedFileMutation(
        { repoId, filePath: "a.ts" },
        async (target) => {
          await writeFile(target, content(15));
        },
      );
      await coordinator.waitForIdle();
      assert.equal(
        (await db.getFileByRepoPath(conn, repoId, "a.ts"))?.contentHash,
        hashContent(content(15)),
      );

      const outside = join(root, "missing-outside");
      try {
        await symlink(
          outside,
          join(repoRoot, "dangling"),
          process.platform === "win32" ? "junction" : "dir",
        );
        let mutationEntered = false;
        await assert.rejects(
          coordinator.runSavedFileMutation(
            { repoId, filePath: "dangling/new.ts" },
            async () => {
              mutationEntered = true;
            },
          ),
          /Dangling symlink/,
        );
        assert.equal(mutationEntered, false);
        assert.equal(
          await stat(outside).then(
            () => true,
            () => false,
          ),
          false,
        );
      } catch (error) {
        if (
          !["EPERM", "ENOTSUP"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        t.diagnostic(
          "Dangling symlink regression unavailable on this filesystem",
        );
      }
    } finally {
      release.resolve();
      bufferRelease.resolve();
      rollbackRelease.resolve();
      failedRelease.resolve();
      await coordinator?.close();
      await cancelAndWaitForGraphIntegrityVerifier(repoId);
      await closeLadybugDb();
      if (oldConfig === undefined) delete process.env.SDL_CONFIG;
      else process.env.SDL_CONFIG = oldConfig;
      const owned = resolve(root);
      const rel = relative(owned, resolve(repoRoot));
      assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
      await rm(owned, { recursive: true, force: true });
    }
  },
);
