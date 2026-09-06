import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  resolve,
  relative,
  isAbsolute,
} from "node:path";
import {
  configureDefaultLiveIndexCoordinator,
  getDefaultLiveIndexCoordinator,
  waitForDefaultLiveIndexIdle,
  resetDefaultLiveIndexCoordinator,
} from "../../dist/live-index/coordinator.js";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { handleFileWrite } from "../../dist/mcp/tools/file-write.js";
import * as fileWriteInternals from "../../dist/mcp/tools/file-write-internals.js";
import { ValidationError } from "../../dist/domain/errors.js";
import { generateFileId } from "../../dist/util/hashing.js";
import {
  capturePersistedGraphIntegrity,
  compareGraphIntegrityExpectations,
  createGraphIntegrityExpectationFromManifest,
  createGraphIntegrityFileState,
} from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import {
  getDerivedState,
  markGraphIntegrityVerified,
} from "../../dist/db/ladybug-derived-state.js";
import { cancelAndWaitForGraphIntegrityVerifier } from "../../dist/indexer/provider-first/background-graph-integrity-verifier.js";
import { BUILTIN_TYPESCRIPT_PARSER_CONTRACT } from "../../dist/indexer/parser-provenance.js";

function getWindowsShortBasename(filePath: string): string | null {
  const longName = basename(filePath);
  const output = execFileSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", "for %I in (*) do @echo %~nxI^|%~snxI"],
    {
      cwd: dirname(filePath),
      encoding: "utf-8",
      windowsHide: true,
    },
  );
  const entry = output
    .split(/\r?\n/u)
    .map((line) => line.split("|"))
    .find(([name]) => name?.toLowerCase() === longName.toLowerCase());
  if (!entry?.[1]) {
    throw new Error(`Unable to resolve Windows short name for ${filePath}`);
  }
  return entry[1].toLowerCase() === longName.toLowerCase() ? null : entry[1];
}

async function establishCompleteParserProvenance(
  repoId: string,
  versionId: string,
  fileIds: readonly string[] = [],
): Promise<void> {
  const conn = await getLadybugConn();
  await ladybugDb.upsertFileParserStatesInTransaction(
    conn,
    fileIds.map((fileId) => ({
      stateId: JSON.stringify([repoId, fileId]),
      repoId,
      fileId,
      ...BUILTIN_TYPESCRIPT_PARSER_CONTRACT,
    })),
  );
  const coverageDigest = await ladybugDb.verifyExactParserCoverageInTransaction(
    conn,
    repoId,
  );
  await ladybugDb.upsertRepoParserStateInTransaction(conn, {
    repoId,
    coverageState: "complete",
    graphVersionId: versionId,
    graphRevision: 0,
    coverageDigest,
  });
}

async function waitForVerifiedRevision(
  repoId: string,
  revision: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await getDerivedState(repoId);
    if (
      state?.graphIntegrityState === "verified" &&
      state.graphIntegrityVerifiedRevision === revision
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for graph integrity revision ${revision}`);
}

describe("sdl.file.write", () => {
  let ownedRoot: string;
  let testDir: string;
  let graphDbPath: string;
  let priorConfig: string | undefined;
  const repoId = "test-file-write-repo";
  let configDir: string;

  beforeEach(async () => {
    ownedRoot = mkdtempSync(join(tmpdir(), "sdl-file-write-"));
    testDir = join(ownedRoot, "repo");
    graphDbPath = join(ownedRoot, "graph");
    configDir = join(testDir, "config");
    mkdirSync(configDir, { recursive: true });
    priorConfig = process.env.SDL_CONFIG;
    const configPath = join(ownedRoot, "sdl-config.json");
    writeFileSync(
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
    await configureDefaultLiveIndexCoordinator({
      enabled: false,
      sweepIntervalMs: 0,
    });

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);

    const conn = await getLadybugConn();
    const now = new Date().toISOString();
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: testDir,
      configJson: JSON.stringify({
        repoId,
        rootPath: testDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: false,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });
  });

  afterEach(async () => {
    await waitForDefaultLiveIndexIdle();
    resetDefaultLiveIndexCoordinator();
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    await closeLadybugDb();
    if (priorConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = priorConfig;
    const child = relative(resolve(ownedRoot), resolve(testDir));
    assert.ok(child && !child.startsWith("..") && !isAbsolute(child));
    rmSync(resolve(ownedRoot), { recursive: true, force: true });
  });

  describe("content mode (create/overwrite)", () => {
    it("creates a new file with createIfMissing", async () => {
      const response = await handleFileWrite({
        repoId,
        filePath: "config/new.json",
        content: '{"version": 1}',
        createIfMissing: true,
        createBackup: false,
      });

      assert.equal(response.mode, "create");
      assert.equal(response.bytesWritten, 14);
      assert.equal(existsSync(join(configDir, "new.json")), true);
      assert.equal(
        readFileSync(join(configDir, "new.json"), "utf-8"),
        '{"version": 1}',
      );
    });

    it("overwrites existing file and creates backup", async () => {
      const filePath = join(configDir, "existing.json");
      writeFileSync(filePath, '{"old": true}', "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/existing.json",
        content: '{"new": true}',
        createBackup: true,
      });

      assert.equal(response.mode, "overwrite");
      assert.equal(response.backupPath, "config/existing.json.bak");
      assert.match(response.snippets?.before ?? "", /old/);
      assert.match(response.snippets?.after ?? "", /new/);
      assert.equal(readFileSync(filePath, "utf-8"), '{"new": true}');
      assert.equal(readFileSync(filePath + ".bak", "utf-8"), '{"old": true}');
    });

    it("rejects a canonical target identity change", () => {
      const guard = Reflect.get(
        fileWriteInternals,
        "assertStableCanonicalIdentity",
      ) as ((preparedPath: string, currentPath: string) => void) | undefined;
      assert.ok(guard, "expected shared canonical identity guard");

      const preparedPath = join(testDir, "StableTarget.ts");
      const caseDistinctPath = join(testDir, "stableTarget.ts");
      assert.doesNotThrow(() => guard(preparedPath, preparedPath));
      assert.throws(
        () => guard(preparedPath, caseDistinctPath),
        (error: unknown) =>
          error instanceof ValidationError &&
          /target identity changed after validation/i.test(error.message),
      );
    });

    it("routes backups through the validated canonical target identity", async (t) => {
      const canonicalPath = join(configDir, "canonical-backup-target.json");
      const lexicalParent = join(testDir, "retargeted-parent");
      const outsideRoot = join(
        dirname(testDir),
        `file-write-backup-route-${process.pid}`,
      );
      const lexicalPath = join(lexicalParent, "canonical-backup-target.json");
      const outsidePath = join(outsideRoot, "canonical-backup-target.json");
      const canonicalBackupPath = `${canonicalPath}.bak`;
      const outsideBackupPath = `${outsidePath}.bak`;
      const canonicalContent = '{"canonical": true}';
      const outsideContent = '{"outside": true}';

      mkdirSync(outsideRoot, { recursive: true });
      writeFileSync(canonicalPath, canonicalContent, "utf-8");
      writeFileSync(outsidePath, outsideContent, "utf-8");
      try {
        symlinkSync(
          outsideRoot,
          lexicalParent,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          process.platform === "win32" &&
          (code === "EPERM" || code === "EACCES")
        ) {
          rmSync(outsideRoot, { recursive: true, force: true });
          t.skip("directory junction creation is unavailable on this host");
          return;
        }
        throw error;
      }

      try {
        const backupPath = await fileWriteInternals.writeWithBackup(
          lexicalPath,
          '{"updated": true}',
          true,
          true,
          undefined,
          canonicalPath,
        );

        assert.equal(backupPath, canonicalBackupPath);
        assert.equal(
          readFileSync(canonicalBackupPath, "utf-8"),
          canonicalContent,
        );
        assert.equal(readFileSync(canonicalPath, "utf-8"), '{"updated": true}');
        assert.equal(readFileSync(outsidePath, "utf-8"), outsideContent);
        assert.equal(existsSync(outsideBackupPath), false);
      } finally {
        rmSync(outsideRoot, { recursive: true, force: true });
      }
    });

    it("refuses an existing hardlinked backup destination", async () => {
      const filePath = join(configDir, "hardlink-target.json");
      const backupPath = `${filePath}.bak`;
      const outsidePath = join(
        dirname(testDir),
        `file-write-hardlink-outside-${process.pid}.json`,
      );
      const originalContent = '{"original": true}';
      const outsideContent = '{"outside": true}';
      writeFileSync(filePath, originalContent, "utf-8");
      writeFileSync(outsidePath, outsideContent, "utf-8");
      linkSync(outsidePath, backupPath);

      try {
        await assert.rejects(
          handleFileWrite({
            repoId,
            filePath: "config/hardlink-target.json",
            content: '{"changed": true}',
            createBackup: true,
          }),
          (error: unknown) => {
            assert.ok(error instanceof ValidationError);
            assert.match(error.message, /backup destination already exists/i);
            assert.match(error.message, /remove or move/i);
            assert.match(error.message, /createBackup: false/);
            return true;
          },
        );
        assert.equal(readFileSync(outsidePath, "utf-8"), outsideContent);
        assert.equal(readFileSync(filePath, "utf-8"), originalContent);
      } finally {
        rmSync(outsidePath, { force: true });
      }
    });

    it("refuses writes through final-path symlinks", async (t) => {
      const symlinkDir = join(testDir, "symlink-target");
      const targetPath = join(symlinkDir, "real.txt");
      const linkPath = join(symlinkDir, "linked.txt");
      const originalContent = "original";
      mkdirSync(symlinkDir, { recursive: true });
      writeFileSync(targetPath, originalContent, "utf-8");

      try {
        symlinkSync(targetPath, linkPath, "file");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          process.platform === "win32" &&
          (code === "EPERM" || code === "EACCES")
        ) {
          t.skip("file symlink creation is unavailable on this Windows host");
          return;
        }
        throw error;
      }

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "symlink-target/linked.txt",
          content: "changed",
          createBackup: false,
        }),
        /Symlink detected at write target; refusing write/,
      );
      assert.equal(readFileSync(targetPath, "utf-8"), originalContent);
    });

    it(
      "uses canonical Windows 8.3 identity for write policy and indexing",
      { skip: process.platform !== "win32" },
      async (t) => {
        const aliasRoot = mkdtempSync(join(tmpdir(), "sdl-file-write-8dot3-"));
        const deniedName = "LongNotebookFilenameForAlias.ipynb";
        const sourceName = "LongTypescriptSourceFilename.ts";
        const deniedPath = join(aliasRoot, deniedName);
        const sourcePath = join(aliasRoot, sourceName);
        const deniedContent = '{"original": true}';
        const sourceContent =
          "export const longTypescriptSourceFilename = 1;\n";
        const conn = await getLadybugConn();
        const priorRepo = await ladybugDb.getRepo(conn, repoId);
        assert.ok(priorRepo);

        try {
          writeFileSync(deniedPath, deniedContent, "utf-8");
          writeFileSync(sourcePath, sourceContent, "utf-8");
          const deniedShortName = getWindowsShortBasename(deniedPath);
          const sourceShortName = getWindowsShortBasename(sourcePath);
          if (!deniedShortName || !sourceShortName) {
            t.skip("8.3 filename aliases are unavailable on the test volume");
            return;
          }

          const now = "2026-08-04T16:00:00.000Z";
          await ladybugDb.upsertRepo(conn, {
            ...priorRepo,
            rootPath: aliasRoot,
          });
          await ladybugDb.createVersion(conn, {
            versionId: "v-eight-dot-three-source",
            repoId,
            createdAt: now,
            reason: "8.3 canonical identity baseline",
            prevVersionHash: null,
            versionHash: null,
          });
          const baseline = await capturePersistedGraphIntegrity(conn, repoId);
          await ladybugDb.replaceGraphIntegrityManifestInTransaction(
            conn,
            repoId,
            { files: [], fileless: [] },
          );
          await establishCompleteParserProvenance(
            repoId,
            "v-eight-dot-three-source",
          );
          await markGraphIntegrityVerified(
            repoId,
            "v-eight-dot-three-source",
            baseline.digest,
          );

          await assert.rejects(
            handleFileWrite({
              repoId,
              filePath: deniedShortName,
              content: '{"changed": true}',
              createBackup: false,
            }),
            /Write denied for extension "\.ipynb"/,
          );
          assert.equal(readFileSync(deniedPath, "utf-8"), deniedContent);

          await assert.rejects(
            handleFileWrite({
              repoId,
              filePath: sourceShortName,
              content: "class {",
              createBackup: false,
            }),
            new RegExp(
              `Parse validation failed for indexed source: ${sourceName.replace(".", "\\.")}`,
            ),
          );
          assert.equal(readFileSync(sourcePath, "utf-8"), sourceContent);

          const response = await handleFileWrite({
            repoId,
            filePath: sourceShortName,
            content: "export const longTypescriptSourceFilename = 2;\n",
            createBackup: false,
          });
          assert.equal(
            response.indexUpdate?.pending,
            true,
            response.indexUpdate?.error,
          );
          await waitForDefaultLiveIndexIdle();
          assert.ok(
            await ladybugDb.getFileByRepoPath(conn, repoId, sourceName),
          );
          assert.equal(
            await ladybugDb.getFileByRepoPath(conn, repoId, sourceShortName),
            null,
          );
          await waitForVerifiedRevision(repoId, 1);
        } finally {
          await ladybugDb.upsertRepo(conn, priorRepo);
          rmSync(aliasRoot, { recursive: true, force: true });
        }
      },
    );

    it("queues an indexed TypeScript graph update through shared reconciliation", async () => {
      const relPath = "src/indexed.ts";
      const filePath = join(testDir, relPath);
      const fileId = generateFileId(repoId, relPath);
      const baselineContent = "export function alpha() { return 1; }";
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, baselineContent, "utf-8");

      const conn = await getLadybugConn();
      const now = "2026-07-21T12:00:00.000Z";
      await ladybugDb.upsertFile(conn, {
        fileId,
        repoId,
        relPath,
        contentHash: "baseline",
        language: "typescript",
        byteSize: Buffer.byteLength(baselineContent),
        lastIndexedAt: now,
      });
      await ladybugDb.upsertSymbolBatch(conn, [
        {
          symbolId: "scip-indexed-alpha",
          repoId,
          fileId,
          kind: "function",
          name: "alpha",
          exported: true,
          visibility: "public",
          language: "typescript",
          rangeStartLine: 1,
          rangeStartCol: 0,
          rangeEndLine: 1,
          rangeEndCol: baselineContent.length,
          astFingerprint: "baseline-alpha",
          signatureJson: JSON.stringify({ name: "alpha" }),
          summary: null,
          invariantsJson: null,
          sideEffectsJson: null,
          source: "scip",
          scipSymbol: "scip-indexed-alpha",
          updatedAt: now,
        },
      ]);
      await ladybugDb.createVersion(conn, {
        versionId: "v-indexed",
        repoId,
        createdAt: now,
        reason: "indexed file.write baseline",
        prevVersionHash: null,
        versionHash: null,
      });
      const baseline = await capturePersistedGraphIntegrity(conn, repoId);
      const baselineSymbols = await ladybugDb.getSymbolsByFile(conn, fileId);
      await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, repoId, {
        files: [
          createGraphIntegrityFileState(
            repoId,
            fileId,
            relPath,
            baselineSymbols,
            [],
          ),
        ],
        fileless: [],
      });
      await establishCompleteParserProvenance(repoId, "v-indexed", [fileId]);
      await markGraphIntegrityVerified(repoId, "v-indexed", baseline.digest);

      const response = await handleFileWrite({
        repoId,
        filePath: relPath,
        content: "export function alpha() { return 2; }",
        createBackup: false,
      });

      assert.deepStrictEqual(response.indexUpdate, {
        applied: false,
        pending: true,
      });
      await waitForDefaultLiveIndexIdle();
      const committedState = await getDerivedState(repoId);
      assert.equal(committedState?.graphIntegrityVersionId, "v-indexed");
      assert.equal(
        committedState?.graphIntegrityRevision,
        1,
        JSON.stringify(
          await getDefaultLiveIndexCoordinator().getLiveStatus(repoId),
        ),
      );
      const manifest = createGraphIntegrityExpectationFromManifest(
        await ladybugDb.listGraphIntegrityFileStates(conn, repoId),
        await ladybugDb.listGraphIntegrityFilelessStates(conn, repoId),
      );
      const graph = await capturePersistedGraphIntegrity(conn, repoId);
      assert.equal(
        graph.digest,
        manifest.digest,
        JSON.stringify(compareGraphIntegrityExpectations(manifest, graph)),
      );
      await waitForVerifiedRevision(repoId, 1);
      assert.equal(
        (await getDerivedState(repoId))?.graphIntegrityDigest,
        graph.digest,
      );
    });

    it("writes ignored TypeScript without updating the graph", async () => {
      const relPath = "ignored/indexed.ts";
      const filePath = join(testDir, relPath);
      const fileId = generateFileId(repoId, relPath);
      const conn = await getLadybugConn();
      const now = "2026-08-04T12:00:00.000Z";
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "export const ignored = 1;", "utf-8");

      await ladybugDb.upsertRepo(conn, {
        repoId,
        rootPath: testDir,
        configJson: JSON.stringify({
          repoId,
          rootPath: testDir,
          ignore: ["ignored"],
          languages: ["ts"],
          maxFileBytes: 2_000_000,
          includeNodeModulesTypes: false,
          packageJsonPath: null,
          tsconfigPath: null,
          workspaceGlobs: null,
        }),
        createdAt: now,
      });
      await ladybugDb.createVersion(conn, {
        versionId: "v-ignored",
        repoId,
        createdAt: now,
        reason: "ignored file.write baseline",
        prevVersionHash: null,
        versionHash: null,
      });
      const baselineGraph = await capturePersistedGraphIntegrity(conn, repoId);
      await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, repoId, {
        files: [],
        fileless: [],
      });
      await markGraphIntegrityVerified(
        repoId,
        "v-ignored",
        baselineGraph.digest,
      );
      const baseline = {
        derivedState: await getDerivedState(repoId),
        file: await ladybugDb.getFileByRepoPath(conn, repoId, relPath),
        symbols: await ladybugDb.getSymbolsByFile(conn, fileId),
        manifestFiles: await ladybugDb.listGraphIntegrityFileStates(
          conn,
          repoId,
        ),
        manifestFileless: await ladybugDb.listGraphIntegrityFilelessStates(
          conn,
          repoId,
        ),
        graphDigest: baselineGraph.digest,
      };

      const response = await handleFileWrite({
        repoId,
        filePath: relPath,
        content: "export const ignored = 2;",
        createBackup: false,
      });

      assert.equal(
        readFileSync(filePath, "utf-8"),
        "export const ignored = 2;",
      );
      assert.deepStrictEqual(
        {
          derivedState: await getDerivedState(repoId),
          file: await ladybugDb.getFileByRepoPath(conn, repoId, relPath),
          symbols: await ladybugDb.getSymbolsByFile(conn, fileId),
          manifestFiles: await ladybugDb.listGraphIntegrityFileStates(
            conn,
            repoId,
          ),
          manifestFileless: await ladybugDb.listGraphIntegrityFilelessStates(
            conn,
            repoId,
          ),
          graphDigest: (await capturePersistedGraphIntegrity(conn, repoId)).digest,
        },
        baseline,
      );
      assert.equal(response.indexUpdate, undefined);
    });

    it(
      "uses canonical Windows path casing before applying ignore rules",
      { skip: process.platform !== "win32" },
      async () => {
        const canonicalRelPath = "Ignored/windows-casing.ts";
        const requestRelPath = "ignored/windows-casing.ts";
        const filePath = join(testDir, canonicalRelPath);
        const fileId = generateFileId(repoId, requestRelPath);
        const conn = await getLadybugConn();
        const now = "2026-08-04T13:00:00.000Z";
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, "export const casing = 1;", "utf-8");

        await ladybugDb.upsertRepo(conn, {
          repoId,
          rootPath: testDir,
          configJson: JSON.stringify({
            repoId,
            rootPath: testDir,
            ignore: ["Ignored"],
            languages: ["ts"],
            maxFileBytes: 2_000_000,
            includeNodeModulesTypes: false,
            packageJsonPath: null,
            tsconfigPath: null,
            workspaceGlobs: null,
          }),
          createdAt: now,
        });
        await ladybugDb.createVersion(conn, {
          versionId: "v-ignored-windows-casing",
          repoId,
          createdAt: now,
          reason: "ignored Windows casing baseline",
          prevVersionHash: null,
          versionHash: null,
        });
        const baselineGraph = await capturePersistedGraphIntegrity(
          conn,
          repoId,
        );
        await ladybugDb.replaceGraphIntegrityManifestInTransaction(
          conn,
          repoId,
          {
            files: [],
            fileless: [],
          },
        );
        await markGraphIntegrityVerified(
          repoId,
          "v-ignored-windows-casing",
          baselineGraph.digest,
        );
        const baseline = {
          derivedState: await getDerivedState(repoId),
          file: await ladybugDb.getFileByRepoPath(conn, repoId, requestRelPath),
          symbols: await ladybugDb.getSymbolsByFile(conn, fileId),
          manifestFiles: await ladybugDb.listGraphIntegrityFileStates(
            conn,
            repoId,
          ),
          manifestFileless: await ladybugDb.listGraphIntegrityFilelessStates(
            conn,
            repoId,
          ),
          graphDigest: baselineGraph.digest,
        };

        const response = await handleFileWrite({
          repoId,
          filePath: requestRelPath,
          content: "export const casing = 2;",
          createBackup: false,
        });

        assert.equal(
          readFileSync(filePath, "utf-8"),
          "export const casing = 2;",
        );
        assert.deepStrictEqual(
          {
            derivedState: await getDerivedState(repoId),
            file: await ladybugDb.getFileByRepoPath(
              conn,
              repoId,
              requestRelPath,
            ),
            symbols: await ladybugDb.getSymbolsByFile(conn, fileId),
            manifestFiles: await ladybugDb.listGraphIntegrityFileStates(
              conn,
              repoId,
            ),
            manifestFileless: await ladybugDb.listGraphIntegrityFilelessStates(
              conn,
              repoId,
            ),
            graphDigest: (await capturePersistedGraphIntegrity(conn, repoId))
              .digest,
          },
          baseline,
        );
        assert.equal(response.indexUpdate, undefined);
      },
    );

    it(
      "syncs eligible TypeScript through a Windows junction repo root",
      { skip: process.platform !== "win32" },
      async () => {
        const realRoot = join(testDir, "real-root");
        const junctionRoot = join(testDir, "junction-root");
        const relPath = "junction-write.ts";
        const content = "export const junctionWrite = 1;";
        mkdirSync(realRoot, { recursive: true });
        symlinkSync(realRoot, junctionRoot, "junction");

        const conn = await getLadybugConn();
        const now = "2026-08-04T14:00:00.000Z";
        await ladybugDb.upsertRepo(conn, {
          repoId,
          rootPath: junctionRoot,
          configJson: JSON.stringify({
            repoId,
            rootPath: junctionRoot,
            ignore: [],
            languages: ["ts"],
            maxFileBytes: 2_000_000,
            includeNodeModulesTypes: false,
            packageJsonPath: null,
            tsconfigPath: null,
            workspaceGlobs: null,
          }),
          createdAt: now,
        });
        await ladybugDb.createVersion(conn, {
          versionId: "v-junction-root",
          repoId,
          createdAt: now,
          reason: "junction-root file.write baseline",
          prevVersionHash: null,
          versionHash: null,
        });
        const baseline = await capturePersistedGraphIntegrity(conn, repoId);
        await ladybugDb.replaceGraphIntegrityManifestInTransaction(
          conn,
          repoId,
          {
            files: [],
            fileless: [],
          },
        );
        await establishCompleteParserProvenance(repoId, "v-junction-root");
        await markGraphIntegrityVerified(
          repoId,
          "v-junction-root",
          baseline.digest,
        );
        assert.equal(
          (await getDerivedState(repoId))?.graphIntegrityState,
          "verified",
        );
        assert.deepStrictEqual(
          await ladybugDb.listGraphIntegrityFileStates(conn, repoId),
          [],
        );

        const response = await handleFileWrite({
          repoId,
          filePath: relPath,
          content,
          createIfMissing: true,
          createBackup: false,
        });

        assert.equal(readFileSync(join(realRoot, relPath), "utf-8"), content);
        assert.equal(
          response.indexUpdate?.pending,
          true,
          response.indexUpdate?.error,
        );
        await waitForDefaultLiveIndexIdle();
        const persistedFile = await ladybugDb.getFileByRepoPath(
          conn,
          repoId,
          relPath,
        );
        assert.equal(persistedFile?.relPath, relPath);
        assert.ok(persistedFile);
        assert.ok(
          (await ladybugDb.getSymbolsByFile(conn, persistedFile.fileId)).length >
            0,
        );
        assert.equal(
          await ladybugDb.getFileByRepoPath(
            conn,
            repoId,
            `../real-root/${relPath}`,
          ),
          null,
        );
        const committedState = await getDerivedState(repoId);
        assert.equal(
          committedState?.graphIntegrityVersionId,
          "v-junction-root",
        );
        assert.equal(
          committedState?.graphIntegrityRevision,
          1,
          JSON.stringify(
            await getDefaultLiveIndexCoordinator().getLiveStatus(repoId),
          ),
        );
        const manifest = createGraphIntegrityExpectationFromManifest(
          await ladybugDb.listGraphIntegrityFileStates(conn, repoId),
          await ladybugDb.listGraphIntegrityFilelessStates(conn, repoId),
        );
        const graph = await capturePersistedGraphIntegrity(conn, repoId);
        assert.equal(
          graph.digest,
          manifest.digest,
          JSON.stringify(compareGraphIntegrityExpectations(manifest, graph)),
        );
        await waitForVerifiedRevision(repoId, 1);
        assert.equal(
          (await getDerivedState(repoId))?.graphIntegrityDigest,
          graph.digest,
        );

        const overwriteContent = "export const junctionWrite = 2;";
        const overwriteResponse = await handleFileWrite({
          repoId,
          filePath: relPath,
          content: overwriteContent,
          createBackup: true,
        });

        assert.equal(overwriteResponse.mode, "overwrite");
        assert.equal(overwriteResponse.backupPath, `${relPath}.bak`);
        assert.ok(!overwriteResponse.backupPath.includes(".."));
        assert.equal(
          readFileSync(
            join(junctionRoot, overwriteResponse.backupPath),
            "utf-8",
          ),
          content,
        );
        assert.equal(
          overwriteResponse.indexUpdate?.pending,
          true,
          overwriteResponse.indexUpdate?.error,
        );
        await waitForDefaultLiveIndexIdle();
        assert.equal(
          readFileSync(join(realRoot, relPath), "utf-8"),
          overwriteContent,
        );
        await waitForVerifiedRevision(repoId, 2);
        const overwrittenManifest = createGraphIntegrityExpectationFromManifest(
          await ladybugDb.listGraphIntegrityFileStates(conn, repoId),
          await ladybugDb.listGraphIntegrityFilelessStates(conn, repoId),
        );
        const overwrittenGraph = await capturePersistedGraphIntegrity(
          conn,
          repoId,
        );
        assert.equal(
          overwrittenGraph.digest,
          overwrittenManifest.digest,
          JSON.stringify(
            compareGraphIntegrityExpectations(
              overwrittenManifest,
              overwrittenGraph,
            ),
          ),
        );
      },
    );

    it(
      "rejects missing writes through an escaping Windows junction",
      { skip: process.platform !== "win32" },
      async () => {
        const outsideRoot = join(testDir, "..", "test-file-write-tool-outside");
        const outsideFile = join(outsideRoot, "nested", "new.ts");
        rmSync(outsideRoot, { recursive: true, force: true });
        mkdirSync(outsideRoot, { recursive: true });
        symlinkSync(outsideRoot, join(testDir, "escape"), "junction");

        try {
          await assert.rejects(
            handleFileWrite({
              repoId,
              filePath: "escape/nested/new.ts",
              content: "export const escaped = true;",
              createIfMissing: true,
              createBackup: false,
            }),
            (error: unknown) => {
              assert.equal(
                (error as { code?: string }).code,
                "VALIDATION_ERROR",
              );
              return true;
            },
          );
          assert.equal(existsSync(outsideFile), false);
          assert.equal(existsSync(join(outsideRoot, "nested")), false);
        } finally {
          rmSync(outsideRoot, { recursive: true, force: true });
        }
      },
    );

    it("keeps graph integrity available when creating a new indexed file", async () => {
      const relPath = "src/new-indexed.ts";
      mkdirSync(join(testDir, "src"), { recursive: true });

      const conn = await getLadybugConn();
      const now = "2026-07-21T12:00:00.000Z";
      await ladybugDb.createVersion(conn, {
        versionId: "v-new-indexed",
        repoId,
        createdAt: now,
        reason: "new indexed file.write baseline",
        prevVersionHash: null,
        versionHash: null,
      });
      const baseline = await capturePersistedGraphIntegrity(conn, repoId);
      await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, repoId, {
        files: [],
        fileless: [],
      });
      await establishCompleteParserProvenance(repoId, "v-new-indexed");
      await markGraphIntegrityVerified(
        repoId,
        "v-new-indexed",
        baseline.digest,
      );

      const response = await handleFileWrite({
        repoId,
        filePath: relPath,
        content: "export function created() { return 1; }",
        createIfMissing: true,
        createBackup: false,
      });

      assert.equal(response.mode, "create");
      assert.equal(response.indexUpdate?.pending, true);
      await waitForDefaultLiveIndexIdle();
      const committedState = await getDerivedState(repoId);
      assert.equal(committedState?.graphIntegrityVersionId, "v-new-indexed");
      assert.equal(
        committedState?.graphIntegrityRevision,
        1,
        JSON.stringify(
          await getDefaultLiveIndexCoordinator().getLiveStatus(repoId),
        ),
      );
      assert.equal(committedState?.graphIntegrityManifestEstablished, true);
      const manifest = createGraphIntegrityExpectationFromManifest(
        await ladybugDb.listGraphIntegrityFileStates(conn, repoId),
        await ladybugDb.listGraphIntegrityFilelessStates(conn, repoId),
      );
      const graph = await capturePersistedGraphIntegrity(conn, repoId);
      assert.equal(
        graph.digest,
        manifest.digest,
        JSON.stringify(compareGraphIntegrityExpectations(manifest, graph)),
      );
      await waitForVerifiedRevision(repoId, 1);
      assert.equal(
        (await getDerivedState(repoId))?.graphIntegrityDigest,
        graph.digest,
      );
    });

    it("keeps graph integrity available when a symbol-free indexed file gains symbols", async () => {
      const relPath = "src/symbol-free.ts";
      const filePath = join(testDir, relPath);
      const fileId = generateFileId(repoId, relPath);
      const baselineContent = "// no declarations";
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, baselineContent, "utf-8");

      const conn = await getLadybugConn();
      const now = "2026-07-21T12:00:00.000Z";
      await ladybugDb.upsertFile(conn, {
        fileId,
        repoId,
        relPath,
        contentHash: "symbol-free-baseline",
        language: "typescript",
        byteSize: Buffer.byteLength(baselineContent),
        lastIndexedAt: now,
      });
      await ladybugDb.createVersion(conn, {
        versionId: "v-symbol-free",
        repoId,
        createdAt: now,
        reason: "symbol-free indexed file.write baseline",
        prevVersionHash: null,
        versionHash: null,
      });
      const baseline = await capturePersistedGraphIntegrity(conn, repoId);
      await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, repoId, {
        files: [createGraphIntegrityFileState(repoId, fileId, relPath, [], [])],
        fileless: [],
      });
      await establishCompleteParserProvenance(repoId, "v-symbol-free", [
        fileId,
      ]);
      await markGraphIntegrityVerified(
        repoId,
        "v-symbol-free",
        baseline.digest,
      );

      const response = await handleFileWrite({
        repoId,
        filePath: relPath,
        content: "export function created() { return 1; }",
        createBackup: false,
      });

      assert.equal(response.mode, "overwrite");
      assert.equal(response.indexUpdate?.pending, true);
      await waitForDefaultLiveIndexIdle();
      const committedState = await getDerivedState(repoId);
      assert.equal(committedState?.graphIntegrityVersionId, "v-symbol-free");
      assert.equal(
        committedState?.graphIntegrityRevision,
        1,
        JSON.stringify(
          await getDefaultLiveIndexCoordinator().getLiveStatus(repoId),
        ),
      );
      assert.equal(committedState?.graphIntegrityManifestEstablished, true);
      const manifest = createGraphIntegrityExpectationFromManifest(
        await ladybugDb.listGraphIntegrityFileStates(conn, repoId),
        await ladybugDb.listGraphIntegrityFilelessStates(conn, repoId),
      );
      const graph = await capturePersistedGraphIntegrity(conn, repoId);
      assert.equal(
        graph.digest,
        manifest.digest,
        JSON.stringify(compareGraphIntegrityExpectations(manifest, graph)),
      );
      await waitForVerifiedRevision(repoId, 1);
    });

    it("rejects invalid reconciliation configuration before changing indexed source", async () => {
      const relPath = "src/reconcile-failure.ts";
      const filePath = join(testDir, relPath);
      const original = "export const stable = 1;";
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, original, "utf-8");

      await ladybugDb.upsertRepo(await getLadybugConn(), {
        repoId,
        rootPath: testDir,
        configJson: "{",
        createdAt: "2026-07-31T00:00:00.000Z",
      });

      await assert.rejects(
        () =>
          handleFileWrite({
            repoId,
            filePath: relPath,
            content: "export const stable = 2;",
            createBackup: false,
          }),
        (error: unknown) => (error as { code?: string }).code === "INDEX_ERROR",
      );
      assert.equal(readFileSync(filePath, "utf-8"), original);
    });

    it("rejects invalid indexed source before changing the file or graph", async () => {
      const relPath = "src/stable.ts";
      const filePath = join(testDir, relPath);
      const fileId = generateFileId(repoId, relPath);
      const content = "export const stable = 1;";
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf-8");

      const conn = await getLadybugConn();
      await ladybugDb.upsertFile(conn, {
        fileId,
        repoId,
        relPath,
        contentHash: "stable-baseline",
        language: "typescript",
        byteSize: Buffer.byteLength(content),
        lastIndexedAt: "2026-07-31T00:00:00.000Z",
      });
      await ladybugDb.upsertSymbol(conn, {
        symbolId: "stable-symbol",
        repoId,
        fileId,
        kind: "variable",
        name: "stable",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: content.length,
        astFingerprint: "stable-fingerprint",
        signatureJson: "{}",
        summary: "Stable fixture",
        invariantsJson: "[]",
        sideEffectsJson: "[]",
        roleTagsJson: "[]",
        testCaseJson: null,
        searchText: "stable",
        summaryQuality: 1,
        summarySource: "test",
        updatedAt: "2026-07-31T00:00:00.000Z",
      });

      await assert.rejects(
        () =>
          handleFileWrite({
            repoId,
            filePath: relPath,
            content: "export const stable = ;",
            createBackup: false,
          }),
        (error: unknown) =>
          (error as { code?: string }).code === "VALIDATION_ERROR",
      );
      assert.equal(readFileSync(filePath, "utf-8"), content);
      assert.deepEqual(
        (await ladybugDb.getSymbolsByFile(conn, fileId)).map(
          (symbol) => symbol.name,
        ),
        ["stable"],
      );
    });

    it("throws when file does not exist and createIfMissing is false", async () => {
      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/nonexistent.json",
          replaceLines: { start: 0, end: 1, content: "test" },
        }),
        /File not found.*createIfMissing/,
      );
    });
  });

  describe("replaceLines mode", () => {
    it("replaces a line range", async () => {
      const filePath = join(configDir, "lines.txt");
      writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5", "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/lines.txt",
        replaceLines: { start: 1, end: 3, content: "replaced" },
        createBackup: false,
      });

      assert.equal(response.mode, "replaceLines");
      const content = readFileSync(filePath, "utf-8");
      assert.equal(content, "line1\nreplaced\nline4\nline5");
    });

    it("throws when start exceeds file length", async () => {
      const filePath = join(configDir, "short.txt");
      writeFileSync(filePath, "line1\nline2", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/short.txt",
          replaceLines: { start: 10, end: 11, content: "test" },
          createBackup: false,
        }),
        /Start line 10 exceeds file length/,
      );
    });

    it("throws when end exceeds file length", async () => {
      const filePath = join(configDir, "short.txt");
      writeFileSync(filePath, "line1\nline2", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/short.txt",
          replaceLines: { start: 0, end: 100, content: "test" },
          createBackup: false,
        }),
        /End line 100 exceeds file length/,
      );
    });

    it("throws when end < start", async () => {
      const filePath = join(configDir, "lines.txt");
      writeFileSync(filePath, "line1\nline2\nline3", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/lines.txt",
          replaceLines: { start: 2, end: 1, content: "test" },
          createBackup: false,
        }),
        /End line 1 must be >= start line 2/,
      );
    });
  });

  describe("replacePattern mode", () => {
    it("replaces first occurrence by default", async () => {
      const filePath = join(configDir, "pattern.txt");
      writeFileSync(filePath, "foo bar foo baz foo", "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/pattern.txt",
        replacePattern: { pattern: "foo", replacement: "FOO" },
        createBackup: false,
      });

      assert.equal(response.mode, "replacePattern");
      assert.equal(response.replacementCount, 1);
      assert.equal(readFileSync(filePath, "utf-8"), "FOO bar foo baz foo");
    });

    it("replaces all occurrences with global flag", async () => {
      const filePath = join(configDir, "pattern.txt");
      writeFileSync(filePath, "foo bar foo baz foo", "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/pattern.txt",
        replacePattern: { pattern: "foo", replacement: "FOO", global: true },
        createBackup: false,
      });

      assert.equal(response.replacementCount, 3);
      assert.equal(readFileSync(filePath, "utf-8"), "FOO bar FOO baz FOO");
    });

    it("throws on invalid regex pattern", async () => {
      const filePath = join(configDir, "pattern.txt");
      writeFileSync(filePath, "test", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/pattern.txt",
          replacePattern: { pattern: "[invalid", replacement: "x" },
          createBackup: false,
        }),
        /Invalid regex pattern/,
      );
    });

    it("rejects nested quantifiers (ReDoS protection)", async () => {
      const filePath = join(configDir, "pattern.txt");
      writeFileSync(filePath, "test", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/pattern.txt",
          replacePattern: { pattern: "(a+)+", replacement: "x" },
          createBackup: false,
        }),
        /nested quantifiers/,
      );
    });
  });

  describe("jsonPath mode", () => {
    it("updates a top-level key", async () => {
      const filePath = join(configDir, "config.json");
      writeFileSync(filePath, '{"version": "1.0.0", "name": "app"}', "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/config.json",
        jsonPath: "version",
        jsonValue: "2.0.0",
        createBackup: false,
      });

      assert.equal(response.mode, "jsonPath");
      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      assert.equal(content.version, "2.0.0");
      assert.equal(content.name, "app");
    });

    it("updates a nested key", async () => {
      const filePath = join(configDir, "config.json");
      writeFileSync(
        filePath,
        '{"server": {"port": 3000, "host": "localhost"}}',
        "utf-8",
      );

      await handleFileWrite({
        repoId,
        filePath: "config/config.json",
        jsonPath: "server.port",
        jsonValue: 8080,
        createBackup: false,
      });

      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      assert.equal(content.server.port, 8080);
      assert.equal(content.server.host, "localhost");
    });

    it("creates intermediate objects", async () => {
      const filePath = join(configDir, "config.json");
      writeFileSync(filePath, "{}", "utf-8");

      await handleFileWrite({
        repoId,
        filePath: "config/config.json",
        jsonPath: "deep.nested.value",
        jsonValue: 42,
        createBackup: false,
      });

      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      assert.equal(content.deep.nested.value, 42);
    });

    it("blocks prototype pollution paths", async () => {
      const filePath = join(configDir, "config.json");
      writeFileSync(filePath, "{}", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/config.json",
          jsonPath: "__proto__.polluted",
          jsonValue: true,
          createBackup: false,
        }),
        /Blocked path segment/,
      );
    });

    it("throws for non-JSON files", async () => {
      const filePath = join(configDir, "config.txt");
      writeFileSync(filePath, "not json", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/config.txt",
          jsonPath: "key",
          jsonValue: "value",
          createBackup: false,
        }),
        /jsonPath mode only supports .json files/,
      );
    });
  });

  describe("insertAt mode", () => {
    it("inserts at the beginning", async () => {
      const filePath = join(configDir, "insert.txt");
      writeFileSync(filePath, "line1\nline2", "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/insert.txt",
        insertAt: { line: 0, content: "inserted" },
        createBackup: false,
      });

      assert.equal(response.mode, "insertAt");
      assert.equal(readFileSync(filePath, "utf-8"), "inserted\nline1\nline2");
    });

    it("inserts in the middle", async () => {
      const filePath = join(configDir, "insert.txt");
      writeFileSync(filePath, "line1\nline2\nline3", "utf-8");

      await handleFileWrite({
        repoId,
        filePath: "config/insert.txt",
        insertAt: { line: 1, content: "inserted" },
        createBackup: false,
      });

      assert.equal(
        readFileSync(filePath, "utf-8"),
        "line1\ninserted\nline2\nline3",
      );
    });

    it("inserts at the end", async () => {
      const filePath = join(configDir, "insert.txt");
      writeFileSync(filePath, "line1\nline2", "utf-8");

      await handleFileWrite({
        repoId,
        filePath: "config/insert.txt",
        insertAt: { line: 2, content: "inserted" },
        createBackup: false,
      });

      assert.equal(readFileSync(filePath, "utf-8"), "line1\nline2\ninserted");
    });

    it("throws when line exceeds file length", async () => {
      const filePath = join(configDir, "insert.txt");
      writeFileSync(filePath, "line1\nline2", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/insert.txt",
          insertAt: { line: 10, content: "test" },
          createBackup: false,
        }),
        /Insert line 10 exceeds file length/,
      );
    });
  });

  describe("append mode", () => {
    it("appends to file with newline separator", async () => {
      const filePath = join(configDir, "append.txt");
      writeFileSync(filePath, "existing content", "utf-8");

      const response = await handleFileWrite({
        repoId,
        filePath: "config/append.txt",
        append: "appended content",
        createBackup: false,
      });

      assert.equal(response.mode, "append");
      assert.equal(
        readFileSync(filePath, "utf-8"),
        "existing content\nappended content",
      );
    });

    it("appends without extra newline if file ends with newline", async () => {
      const filePath = join(configDir, "append.txt");
      writeFileSync(filePath, "existing content\n", "utf-8");

      await handleFileWrite({
        repoId,
        filePath: "config/append.txt",
        append: "appended content",
        createBackup: false,
      });

      assert.equal(
        readFileSync(filePath, "utf-8"),
        "existing content\nappended content",
      );
    });
  });

  describe("validation", () => {
    it("throws when no write mode specified", async () => {
      const filePath = join(configDir, "test.txt");
      writeFileSync(filePath, "test", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/test.txt",
        }),
        /Must specify exactly one write mode/,
      );
    });

    it("throws when multiple write modes specified", async () => {
      const filePath = join(configDir, "test.txt");
      writeFileSync(filePath, "test", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/test.txt",
          content: "new",
          append: "more",
        }),
        /Only one write mode allowed/,
      );
    });

    it("throws when jsonPath specified without jsonValue", async () => {
      const filePath = join(configDir, "config.json");
      writeFileSync(filePath, "{}", "utf-8");

      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "config/config.json",
          jsonPath: "key",
        }),
        /jsonValue is required when jsonPath is specified/,
      );
    });

    it("blocks path traversal attempts", async () => {
      await assert.rejects(
        handleFileWrite({
          repoId,
          filePath: "../../../etc/passwd",
          content: "malicious",
          createIfMissing: true,
          createBackup: false,
        }),
        /path/i,
      );
    });
  });

  describe("token usage metadata", () => {
    it("attaches raw context for targeted writes", async () => {
      const filePath = join(configDir, "token.txt");
      const originalContent = "line1\nline2\nline3\nline4\nline5";
      writeFileSync(filePath, originalContent, "utf-8");

      const response = (await handleFileWrite({
        repoId,
        filePath: "config/token.txt",
        replaceLines: { start: 1, end: 2, content: "replaced" },
        createBackup: false,
      })) as Record<string, unknown>;

      assert.ok(response._rawContext);
      const rawContext = response._rawContext as { rawTokens: number };
      // Raw tokens based on max of original and new content
      assert.ok(rawContext.rawTokens > 0);
    });
  });
});
