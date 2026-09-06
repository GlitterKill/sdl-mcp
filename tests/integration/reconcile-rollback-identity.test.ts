import assert from "node:assert/strict";
import { it } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import {
  initLadybugDb,
  getLadybugConn,
  closeLadybugDb,
} from "../../dist/db/ladybug.js";
import * as db from "../../dist/db/ladybug-queries.js";
import { RepoConfigSchema } from "../../dist/config/types.js";
import { InMemoryLiveIndexCoordinator } from "../../dist/live-index/coordinator.js";
import type { SavedFileOwnership } from "../../dist/live-index/types.js";
import { applyBatch } from "../../dist/mcp/tools/search-edit/batch-executor.js";
import { handleFileWrite } from "../../dist/mcp/tools/file-write.js";
import { hashContent } from "../../dist/util/hashing.js";

it(
  "rollback preserves equal-content files reached through a retargeted ancestor",
  { timeout: 20_000 },
  async (t) => {
    const root = await mkdtemp(
      join(tmpdir(), "sdl-reconcile-rollback-identity-"),
    );
    const repoRoot = join(root, "repo");
    const repoId = "rollback-identity";
    let coordinator: InMemoryLiveIndexCoordinator | undefined;
    try {
      await mkdir(repoRoot);
      for (const name of ["batch", "single", "victim"])
        await mkdir(join(repoRoot, name));
      await writeFile(join(repoRoot, "victim", "file.txt"), "same");
      await writeFile(join(repoRoot, "z.txt"), "old");
      // Probe the actual directory-link capability before running either mutation.
      try {
        await symlink(
          join(repoRoot, "victim"),
          join(repoRoot, "probe"),
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        if (
          !["EPERM", "ENOTSUP"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        t.skip("Directory symlinks are unavailable on this filesystem");
        return;
      }
      await initLadybugDb(join(root, "graph.lbug"));
      await db.upsertRepo(await getLadybugConn(), {
        repoId,
        rootPath: repoRoot,
        createdAt: "fixture",
        configJson: JSON.stringify(
          RepoConfigSchema.parse({ repoId, rootPath: repoRoot }),
        ),
      });
      coordinator = new InMemoryLiveIndexCoordinator({
        enabled: false,
        sweepIntervalMs: 0,
      });
      const original = coordinator.runSavedFileMutation.bind(coordinator);
      coordinator.runSavedFileMutation = async (input, operation) => {
        if (input.filePath === "z.txt") {
          await rename(
            join(repoRoot, "batch"),
            join(repoRoot, "retained-batch"),
          );
          await symlink(
            join(repoRoot, "victim"),
            join(repoRoot, "batch"),
            process.platform === "win32" ? "junction" : "dir",
          );
          throw new Error("later batch write failed");
        }
        return original(input, operation);
      };
      const result = await applyBatch(
        {
          repoId,
          planHandle: "rollback-identity",
          createdAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
          defaultCreateBackup: true,
          consumed: false,
          summary: {},
          edits: [
            {
              relPath: "batch/file.txt",
              absPath: join(repoRoot, "batch", "file.txt"),
              newContent: "same",
              createBackup: true,
              fileExists: false,
              indexedSource: false,
              matchCount: 1,
              editMode: "create",
            },
            {
              relPath: "z.txt",
              absPath: join(repoRoot, "z.txt"),
              newContent: "new",
              createBackup: true,
              fileExists: true,
              indexedSource: false,
              matchCount: 1,
              editMode: "overwrite",
            },
          ],
          preconditions: [
            {
              relPath: "batch/file.txt",
              absPath: join(repoRoot, "batch", "file.txt"),
              canonicalAbsPath: join(repoRoot, "batch", "file.txt"),
              sha256: null,
              mtimeMs: null,
            },
            {
              relPath: "z.txt",
              absPath: join(repoRoot, "z.txt"),
              canonicalAbsPath: join(repoRoot, "z.txt"),
              sha256: hashContent("old"),
              mtimeMs: null,
            },
          ],
        },
        true,
        coordinator,
      );
      assert.equal(result.rollback.triggered, true);
      assert.deepEqual(
        result.rollback.restoredFiles,
        [],
        "a different canonical file is not the rollback target",
      );
      assert.equal(
        await readFile(join(repoRoot, "victim", "file.txt"), "utf8"),
        "same",
      );

      coordinator.runSavedFileMutation = async (input, operation) => {
        const result = await original(input, operation);
        if (input.filePath === "single/file.txt") {
          await rename(
            join(repoRoot, "single"),
            join(repoRoot, "retained-single"),
          );
          await symlink(
            join(repoRoot, "victim"),
            join(repoRoot, "single"),
            process.platform === "win32" ? "junction" : "dir",
          );
          throw new Error("single-file admission failed after write");
        }
        return result;
      };
      await assert.rejects(
        handleFileWrite(
          {
            repoId,
            filePath: "single/file.txt",
            content: "same",
            createBackup: false,
          },
          undefined,
          coordinator,
        ),
        /identity changed/i,
      );
      assert.equal(
        await readFile(join(repoRoot, "victim", "file.txt"), "utf8"),
        "same",
      );
      assert.equal(
        await readFile(join(repoRoot, "retained-batch", "file.txt"), "utf8"),
        "same",
      );
      assert.equal(
        await readFile(join(repoRoot, "retained-single", "file.txt"), "utf8"),
        "same",
      );
    } finally {
      await coordinator?.close();
      await closeLadybugDb();
      const owned = resolve(root);
      const ownership = relative(resolve(tmpdir()), owned);
      assert.ok(
        ownership.startsWith("sdl-reconcile-rollback-identity-") &&
          !isAbsolute(ownership) &&
          !ownership.startsWith(".."),
      );
      await rm(owned, { recursive: true, force: true });
    }
  },
);

it(
  "rollback preserves newer managed saves even when their bytes return to the original write",
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "sdl-reconcile-rollback-aba-"));
    const repoRoot = join(root, "repo");
    const repoId = "rollback-aba";
    let coordinator: InMemoryLiveIndexCoordinator | undefined;
    try {
      await mkdir(repoRoot);
      for (const name of ["a.txt", "single.txt", "z.txt"])
        await writeFile(join(repoRoot, name), "old");
      await initLadybugDb(join(root, "graph.lbug"));
      await db.upsertRepo(await getLadybugConn(), {
        repoId,
        rootPath: repoRoot,
        createdAt: "fixture",
        configJson: JSON.stringify(
          RepoConfigSchema.parse({ repoId, rootPath: repoRoot }),
        ),
      });
      coordinator = new InMemoryLiveIndexCoordinator({
        enabled: false,
        sweepIntervalMs: 0,
      });
      const original = coordinator.runSavedFileMutation.bind(coordinator);
      coordinator.runSavedFileMutation = async (input, operation) => {
        if (input.filePath === "z.txt") {
          for (const content of ["B", "A"])
            await original(
              { repoId, filePath: "a.txt", reconcile: false },
              async (path) => {
                await writeFile(path, content);
              },
            );
          throw new Error("later batch write failed after newer saves");
        }
        return original(input, operation);
      };
      const batch = await applyBatch(
        {
          repoId,
          planHandle: "rollback-aba",
          createdAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
          defaultCreateBackup: true,
          consumed: false,
          summary: {},
          edits: ["a.txt", "z.txt"].map((name) => ({
            relPath: name,
            absPath: join(repoRoot, name),
            newContent: "A",
            createBackup: true,
            fileExists: true,
            indexedSource: false,
            matchCount: 1,
            editMode: "overwrite" as const,
          })),
          preconditions: ["a.txt", "z.txt"].map((name) => ({
            relPath: name,
            absPath: join(repoRoot, name),
            canonicalAbsPath: join(repoRoot, name),
            sha256: hashContent("old"),
            mtimeMs: null,
          })),
        },
        true,
        coordinator,
      );
      assert.equal(batch.rollback.triggered, true);
      assert.deepEqual(batch.rollback.restoredFiles, []);
      assert.equal(
        await readFile(join(repoRoot, "a.txt"), "utf8"),
        "A",
        "older rollback must not overwrite the newer A save",
      );

      coordinator.runSavedFileMutation = async (input, operation) => {
        await original(input, operation);
        for (const content of ["B", "A"])
          await original(
            { repoId, filePath: "single.txt", reconcile: false },
            async (path) => {
              await writeFile(path, content);
            },
          );
        throw new Error("single-file admission failed after newer saves");
      };
      await assert.rejects(
        handleFileWrite(
          { repoId, filePath: "single.txt", content: "A", createBackup: false },
          undefined,
          coordinator,
        ),
        /newer save owns the file/i,
      );
      assert.equal(await readFile(join(repoRoot, "single.txt"), "utf8"), "A");
      assert.equal(
        (
          coordinator as unknown as {
            savedMutationOwners: Map<string, unknown>;
          }
        ).savedMutationOwners.size,
        0,
        "completed attempts retain no rollback receipts",
      );

      // Ambiguous watcher input can represent an external same-path ABA save too.
      coordinator.setReconciliationReadiness(repoId, () => false);
      let pendingOwner: SavedFileOwnership | undefined;
      await original(
        {
          repoId,
          filePath: "a.txt",
          reconcile: false,
          captureOwnership: (receipt) => {
            pendingOwner = receipt;
          },
        },
        async () => undefined,
      );
      assert.equal(pendingOwner?.isCurrent(), true);
      coordinator.requestReconcileInventory(repoId);
      assert.equal(
        pendingOwner?.isCurrent(),
        false,
        "ambiguous newer input invalidates possible rollback owners",
      );
      pendingOwner?.release();
    } finally {
      await coordinator?.close();
      await closeLadybugDb();
      const owned = resolve(root);
      const ownership = relative(resolve(tmpdir()), owned);
      assert.ok(
        ownership.startsWith("sdl-reconcile-rollback-aba-") &&
          !isAbsolute(ownership) &&
          !ownership.startsWith(".."),
      );
      await rm(owned, { recursive: true, force: true });
    }
  },
);
