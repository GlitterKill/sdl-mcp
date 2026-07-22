import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import { getDerivedState } from "../../dist/db/ladybug-derived-state.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { ProviderFirstIncrementalReplacementError } from "../../dist/indexer/indexer-pass1-policy.js";
import { writeTestScipIndex } from "../fixtures/scip/builder.ts";

const EXISTING_PROVIDER_SYMBOLS = 2_049;
const REPO_ID = "provider-first-incremental-safety-repo";

function providerSymbol(index: number, pathStem = "huge"): string {
  return `scip-typescript npm safety-fixture 1.0.0 src/${pathStem}/fn${index}().`;
}

function sourceLines(symbolCount: number): string[] {
  return Array.from(
    { length: symbolCount },
    (_, index) => `export function fn${index}() { return ${index}; }`,
  );
}

async function writeProviderFixture(
  repoDir: string,
  symbolCount: number,
  relativePath = "src/huge.ts",
  pathStem = "huge",
): Promise<void> {
  const lines = sourceLines(symbolCount);
  writeFileSync(join(repoDir, relativePath), lines.join("\n"), "utf8");
  await writeTestScipIndex(join(repoDir, "index.scip"), {
    metadata: {
      version: 0,
      toolName: "scip-typescript",
      toolVersion: "test",
      textDocumentEncoding: 1,
    },
    documents: [
      {
        language: "typescript",
        relativePath,
        symbols: lines.map((_, index) => ({
          symbol: providerSymbol(index, pathStem),
          kind: 17,
          displayName: `fn${index}`,
        })),
        occurrences: lines.map((_, index) => ({
          range: [index, 16, 18 + String(index).length],
          symbol: providerSymbol(index, pathStem),
          symbolRoles: 1,
          syntaxKind: 16,
        })),
      },
    ],
  });
}

describe("provider-first incremental replacement safety — integration", () => {
  const dbPath = join(
    tmpdir(),
    `.lbug-provider-first-incremental-safety-${process.pid}.lbug`,
  );
  const configPath = join(
    tmpdir(),
    `sdl-provider-first-incremental-safety-${process.pid}.json`,
  );
  const previousConfig = process.env.SDL_CONFIG;
  const previousConfigPath = process.env.SDL_CONFIG_PATH;
  const previousNativeSetting = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
  let repoDir = "";
  let fakeGeneratorBinary = "";

  before(async () => {
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    if (existsSync(`${dbPath}.wal`)) {
      rmSync(`${dbPath}.wal`, { recursive: true, force: true });
    }
    repoDir = mkdtempSync(join(tmpdir(), "sdl-provider-first-safety-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    await writeProviderFixture(repoDir, EXISTING_PROVIDER_SYMBOLS);

    const generatorScriptPath = join(repoDir, "fake-scip-io.mjs");
    writeFileSync(
      generatorScriptPath,
      [
        "import { copyFileSync } from \"node:fs\";",
        "import { join } from \"node:path\";",
        "const args = process.argv.slice(2);",
        "if (args.includes(\"--version\")) { console.log(\"scip-io 0.0.0-test\"); process.exit(0); }",
        "const outputIndex = args.indexOf(\"--output\");",
        "if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error(\"missing --output\");",
        "copyFileSync(join(process.cwd(), \"index.scip\"), args[outputIndex + 1]);",
      ].join("\n"),
      "utf8",
    );
    fakeGeneratorBinary = join(
      repoDir,
      process.platform === "win32" ? "fake-scip-io.cmd" : "fake-scip-io",
    );
    const launcher =
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${generatorScriptPath}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${generatorScriptPath}" "$@"\n`;
    writeFileSync(fakeGeneratorBinary, launcher, "utf8");
    if (process.platform !== "win32") chmodSync(fakeGeneratorBinary, 0o755);
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: {
            engine: "typescript",
            pipeline: "auto",
            enableFileWatching: false,
            providerFirst: { stagingFormat: "csv" },
          },
          scip: {
            enabled: true,
            indexes: [{ path: "index.scip" }],
            generator: {
              enabled: true,
              binary: fakeGeneratorBinary,
              args: [],
              autoInstall: false,
              cacheGeneratedIndexes: false,
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
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";

    await closeLadybugDb();
    await initLadybugDb(dbPath);
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
        includeNodeModulesTypes: true,
      }),
      createdAt: "2026-07-22T00:00:00.000Z",
    });
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    if (existsSync(`${dbPath}.wal`)) {
      rmSync(`${dbPath}.wal`, { recursive: true, force: true });
    }
    if (existsSync(configPath)) rmSync(configPath, { force: true });
    if (repoDir && existsSync(repoDir)) {
      rmSync(repoDir, { recursive: true, force: true });
    }

    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    if (previousConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = previousConfigPath;
    if (previousNativeSetting === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = previousNativeSetting;
    }
  });

  it(
    "rejects unsafe auto-mode incremental replacement without mutation or legacy fallback",
    async () => {
      const fullResult = await indexRepo(REPO_ID, "full");
      assert.equal(fullResult.providerFirst.selectedPipeline, "providerFirst");

      const conn = await getLadybugConn();
      const symbolsBefore = (await ladybugDb.getSymbolsByRepo(conn, REPO_ID))
        .map((symbol) => symbol.symbolId)
        .sort();
      const filesBefore = (await ladybugDb.getFilesByRepo(conn, REPO_ID))
        .map((file) => ({
          fileId: file.fileId,
          relPath: file.relPath,
          contentHash: file.contentHash,
        }))
        .sort((left, right) => left.fileId.localeCompare(right.fileId));
      assert.ok(symbolsBefore.length > 2_048);
      const derivedStateBefore = await getDerivedState(REPO_ID);
      assert.equal(derivedStateBefore?.graphIntegrityState, "verified");

      const assertUnsafeIncrementalPreservesGraph = async (): Promise<void> => {
        await assert.rejects(
          indexRepo(REPO_ID, "incremental"),
          (error: unknown) => {
            assert.ok(
              error instanceof ProviderFirstIncrementalReplacementError,
            );
            assert.match(error.message, /existing scoped Symbol rows/);
            assert.match(error.message, /fresh database rebuild is required/i);
            return true;
          },
        );

        const symbolsAfter = (
          await ladybugDb.getSymbolsByRepo(conn, REPO_ID)
        )
          .map((symbol) => symbol.symbolId)
          .sort();
        const filesAfter = (await ladybugDb.getFilesByRepo(conn, REPO_ID))
          .map((file) => ({
            fileId: file.fileId,
            relPath: file.relPath,
            contentHash: file.contentHash,
          }))
          .sort((left, right) => left.fileId.localeCompare(right.fileId));
        const derivedStateAfter = await getDerivedState(REPO_ID);

        assert.deepEqual(symbolsAfter, symbolsBefore);
        assert.deepEqual(filesAfter, filesBefore);
        assert.deepEqual(derivedStateAfter, derivedStateBefore);
        assert.equal(derivedStateAfter?.graphIntegrityState, "verified");
      };

      // Changed-file replacement must fail before provider or legacy writes.
      await writeProviderFixture(repoDir, 1);
      await assertUnsafeIncrementalPreservesGraph();

      // Removed-only replacement must pass through the same read-only guard.
      rmSync(join(repoDir, "src", "huge.ts"), { force: true });
      await assertUnsafeIncrementalPreservesGraph();

      // Mixed changed-plus-removed work must count both file sets as one union.
      await writeProviderFixture(repoDir, 1, "src/new.ts", "new");
      await assertUnsafeIncrementalPreservesGraph();
    },
  );
});