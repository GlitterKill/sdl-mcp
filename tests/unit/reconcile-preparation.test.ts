import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { it } from "node:test";
import { hashContent } from "../../dist/util/hashing.js";
import { AppConfigSchema, RepoConfigSchema } from "../../dist/config/types.js";
import { runToolDispatch } from "../../dist/mcp/dispatch-limiter.js";
import { isIndexingActive } from "../../dist/mcp/indexing-gate.js";
import { withRepoWriteHeavyLock } from "../../dist/indexer/derived-refresh-queue.js";
import { ReconcileQueue } from "../../dist/live-index/reconcile-queue.js";
import { writeTestScipIndex } from "../fixtures/scip/builder.ts";

const preparation =
  await import("../../dist/indexer/provider-first/reconcile-preparation.js");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(route: "scip" | "lsp") {
  const repoRoot = await mkdtemp(join(tmpdir(), "sdl-reconcile-preparation-"));
  const content = "export function fresh() { return 1; }";
  await writeFile(join(repoRoot, "file.ts"), content);
  await writeFile(join(repoRoot, "project.json"), "{}");
  const repoConfig = RepoConfigSchema.parse({
    repoId: "repo",
    rootPath: repoRoot,
    languages: ["ts"],
  });
  const appConfig = AppConfigSchema.parse({
    repos: [repoConfig],
    policy: {},
    indexing: { pipeline: "auto" },
    ...(route === "scip"
      ? { scip: { enabled: true, generator: { enabled: true } } }
      : {
          semanticEnrichment: {
            enabled: true,
            providers: {
              lsp: {
                enabled: true,
                servers: {
                  fixture: {
                    command: "fixture",
                    serverId: "fixture",
                    languages: ["typescript"],
                    filePatterns: ["**/*.ts"],
                  },
                },
              },
            },
          },
        }),
  });
  return {
    repoId: "repo",
    repoRoot,
    repoConfig,
    appConfig,
    files: [
      {
        path: "file.ts",
        content,
        contentHash: hashContent(content),
        size: Buffer.byteLength(content),
      },
    ],
    dependencyInputs: [
      { path: "project.json", contentHash: hashContent("{}") },
    ],
    assertCurrent: () => {},
  };
}

for (const route of ["scip", "lsp"] as const) {
  it(
    `${route} preparation leaves dispatch and new saves available while the provider is held`,
    { timeout: 15_000 },
    async () => {
      assert.equal(
        typeof preparation.prepareReconcileFiles,
        "function",
        "read-only preparation API is required",
      );
      const params = await fixture(route);
      const entered = deferred();
      const release = deferred();
      let manifestPath = "";
      let outputPath = "";
      let disposed = false;
      const dependencies = {
        runScipIo: async (options) => {
          manifestPath = options.filesFromPath;
          outputPath = options.outputPath;
          assert.equal(await readFile(manifestPath, "utf8"), "file.ts\n");
          entered.resolve();
          await release.promise;
          const symbol = "scip-typescript npm fixture 1.0.0 file.ts/fresh().";
          await writeTestScipIndex(outputPath, {
            metadata: { toolName: "fixture", toolVersion: "1" },
            documents: [
              {
                relativePath: "file.ts",
                language: "typescript",
                occurrences: [
                  {
                    range: [0, 16, 21],
                    enclosingRange: [0, 0, 0, 37],
                    symbol,
                    symbolRoles: 1,
                  },
                ],
                symbols: [{ symbol, kind: 12, displayName: "fresh" }],
              },
            ],
          });
          return {
            failures: [],
            generatedIndexes: [
              {
                path: relative(params.repoRoot, outputPath).replaceAll(
                  "\\",
                  "/",
                ),
                label: "fixture",
                mode: "merged",
                sizeBytes: (await readFile(outputPath)).length,
              },
            ],
          };
        },
        clientFactory: () => ({
          start: async () => ({
            capabilities: { documentSymbolProvider: true },
          }),
          openDocument: async () => {},
          documentSymbol: async () => {
            entered.resolve();
            await release.promise;
            return [
              {
                name: "fresh",
                kind: 12,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 37 },
                },
                selectionRange: {
                  start: { line: 0, character: 16 },
                  end: { line: 0, character: 21 },
                },
              },
            ];
          },
          diagnostics: () => [],
          dispose: async () => {
            disposed = true;
          },
        }),
      };
      const pending = preparation.prepareReconcileFiles(params, dependencies);
      try {
        await entered.promise;
        assert.equal(isIndexingActive(), false);
        await runToolDispatch(async () =>
          assert.equal(isIndexingActive(), false),
        );
        await withRepoWriteHeavyLock("repo", async () => {});
        const queue = new ReconcileQueue();
        const frontier = {
          touchedSymbolIds: [],
          dependentSymbolIds: [],
          dependentFilePaths: [],
          importedFilePaths: [],
          invalidations: [],
        };
        queue.enqueue("repo", frontier, "1", {
          "file.ts": {
            kind: "saved",
            content: params.files[0].content,
            sourceHash: params.files[0].contentHash,
          },
        });
        const older = queue.claimNext()!;
        assert.equal(
          queue.enqueue("repo", frontier, "2", {
            "file.ts": {
              kind: "saved",
              content: "newer",
              sourceHash: hashContent("newer"),
            },
          }),
          true,
        );
        assert.equal(queue.isCurrent(older), false);
        if (route === "scip")
          assert.equal(await readFile(manifestPath, "utf8"), "file.ts\n");
        release.resolve();
        const result = await pending;
        assert.equal(result.kind, "provider");
        assert.equal(result.result.summary.executor, `${route}Incremental`);
        assert.deepEqual(
          result.result.rows.symbols.map((s) => s.name),
          ["fresh"],
        );
        assert.equal(result.files[0].contentHash, params.files[0].contentHash);
        if (route === "scip") {
          await assert.rejects(readFile(manifestPath), { code: "ENOENT" });
          await assert.rejects(readFile(outputPath), { code: "ENOENT" });
        } else assert.equal(disposed, true);
      } finally {
        release.resolve();
        await pending.catch(() => {});
        await rm(params.repoRoot, { recursive: true, force: true });
      }
    },
  );
}

it("rejects stale source before starting a configured provider", async () => {
  assert.equal(typeof preparation.prepareReconcileFiles, "function");
  const params = await fixture("scip");
  try {
    await writeFile(join(params.repoRoot, "file.ts"), "newer");
    await assert.rejects(
      preparation.prepareReconcileFiles(params, {
        runScipIo: async () => assert.fail("provider must not run"),
      }),
      /changed|stale/i,
    );
  } finally {
    await rm(params.repoRoot, { recursive: true, force: true });
  }
});

for (const changed of ["file.ts", "project.json", "ownership"]) {
  it(`rejects a provider result when ${changed} changes during execution`, async () => {
    assert.equal(typeof preparation.prepareReconcileFiles, "function");
    const params = await fixture("lsp");
    let current = true;
    params.assertCurrent = () => {
      assert.ok(current, "stale ownership");
    };
    try {
      await assert.rejects(
        preparation.prepareReconcileFiles(params, {
          clientFactory: () => ({
            start: async () => ({
              capabilities: { documentSymbolProvider: true },
            }),
            openDocument: async () => {},
            documentSymbol: async () => {
              if (changed === "ownership") current = false;
              else await writeFile(join(params.repoRoot, changed), "changed");
              return [];
            },
            diagnostics: () => [],
            dispose: async () => {},
          }),
        }),
        /changed|stale/i,
      );
    } finally {
      await rm(params.repoRoot, { recursive: true, force: true });
    }
  });
}

it("cleans owned temporary files after a failed configured generator without parser fallback", async () => {
  assert.equal(typeof preparation.prepareReconcileFiles, "function");
  const params = await fixture("scip");
  try {
    await assert.rejects(
      preparation.prepareReconcileFiles(params, {
        runScipIo: async () => {
          throw new Error("configured provider failed");
        },
      }),
      /configured provider failed/,
    );
    assert.deepEqual(
      await readdir(
        join(params.repoRoot, ".sdl-mcp", "provider-first-incremental"),
      ),
      [],
    );
  } finally {
    await rm(params.repoRoot, { recursive: true, force: true });
  }
});

it("reports omitted selected files separately from valid zero-symbol file facts", async () => {
  const params = await fixture("lsp");
  params.appConfig.semanticEnrichment!.providers.lsp.servers.fixture.filePatterns =
    ["file.ts"];
  params.files.push({
    path: "omitted.ts",
    content: "",
    contentHash: hashContent(""),
    size: 0,
  });
  await writeFile(join(params.repoRoot, "omitted.ts"), "");
  try {
    const prepared = await preparation.prepareReconcileFiles(params, {
      clientFactory: () => ({
        start: async () => ({ capabilities: { documentSymbolProvider: true } }),
        openDocument: async () => {},
        documentSymbol: async () => [],
        diagnostics: () => [],
        dispose: async () => {},
      }),
    });
    assert.equal(prepared.kind, "provider");
    assert.deepEqual(prepared.uncoveredPaths, ["omitted.ts"]);
    assert.equal(prepared.result.rows.symbols.length, 0);
    assert.deepEqual(
      prepared.result.facts.files.map((file) => file.relPath),
      ["file.ts"],
    );
    assert.equal(prepared.result.facts.coverage.length, 1);
  } finally {
    await rm(params.repoRoot, { recursive: true, force: true });
  }
});

for (const failure of [
  "documentSymbol",
  "openDocument",
  "unsupported",
] as const) {
  for (const session of ["workspace", "document"] as const) {
    it(`rejects ${failure} collection in an LSP ${session} session rather than preparing a clear`, async () => {
      const params = await fixture("lsp");
      params.appConfig.semanticEnrichment!.providers.lsp.servers.fixture.documentSessionMode =
        session;
      try {
        await assert.rejects(
          preparation.prepareReconcileFiles(params, {
            clientFactory: () => ({
              start: async () => ({
                capabilities: {
                  documentSymbolProvider: failure !== "unsupported",
                },
              }),
              openDocument: async () => {
                if (failure === "openDocument")
                  throw new Error("fixture document open failed");
              },
              documentSymbol: async () => {
                throw new Error("fixture symbol collection failed");
              },
              diagnostics: () => [],
              dispose: async () => {},
            }),
          }),
          /symbol collection|provider failed/i,
        );
      } finally {
        await rm(params.repoRoot, { recursive: true, force: true });
      }
    });
  }
}
