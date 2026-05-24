import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { handleIndexRefresh } from "../../dist/mcp/tools/repo.js";

const REPO_ID = "test-index-refresh-diagnostics";

describe("index.refresh diagnostics", () => {
  let graphDbPath = "";
  let configPath = "";
  let repoDir = "";
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;

  before(async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-index-refresh-diag-db-"));
    configPath = join(graphDbPath, "test-config.json");
    repoDir = mkdtempSync(join(tmpdir(), "sdl-index-refresh-diag-repo-"));

    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "index.ts"),
      [
        "export function greet(name: string): string {",
        "  return `hello ${name}`;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: "index-refresh-diagnostics-test",
          version: "1.0.0",
          type: "module",
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      join(repoDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ),
      "utf8",
    );

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
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
    const now = new Date().toISOString();
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
        packageJsonPath: "package.json",
        tsconfigPath: "tsconfig.json",
        workspaceGlobs: null,
      }),
      createdAt: now,
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

    if (repoDir && existsSync(repoDir)) {
      rmSync(repoDir, { recursive: true, force: true });
    }
    if (graphDbPath && existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
  });

  it("includes opt-in timing diagnostics in the tool response", async () => {
    // Seed the repo with a full index first so the subsequent incremental
    // run is genuinely incremental — indexRepo auto-upgrades incremental
    // → full when fileCount===0, which would defeat the deferred-cluster
    // assertion below.
    await handleIndexRefresh({
      repoId: REPO_ID,
      mode: "full",
      includeDiagnostics: false,
    });
    // Modify the source file so the incremental run does real work;
    // otherwise it short-circuits and most phases are skipped.
    writeFileSync(
      join(repoDir, "src", "index.ts"),
      [
        "export function greet(name: string): string {",
        "  return `hello ${name}!`;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    // Bump mtime so incremental scan sees the change. We avoid setting mtime
    // far into the future, which would make the file *permanently* look newer
    // than lastIndexedAt and break the no-op short-circuit assertions in
    // sibling tests.
    const { utimes } = await import("node:fs/promises");
    const slightlyAfter = new Date(Date.now() + 1);
    await utimes(
      join(repoDir, "src", "index.ts"),
      slightlyAfter,
      slightlyAfter,
    );
    // Wait so that subsequent indexes record a `lastIndexedAt` strictly after
    // the bumped mtime; otherwise mtime===lastIndexedAt could go either way
    // depending on filesystem timestamp resolution.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await handleIndexRefresh({
      repoId: REPO_ID,
      mode: "incremental",
      includeDiagnostics: true,
    });

    assert.equal(result.ok, true);
    assert.ok(result.versionId, "expected versionId to be present");
    assert.ok(
      result.diagnostics,
      "expected diagnostics when includeDiagnostics=true",
    );
    assert.ok(result.diagnostics.timings, "expected timings diagnostics");
    assert.ok(
      result.diagnostics.timings.totalMs >= 0,
      "expected timings.totalMs to be non-negative",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases.scanRepo,
      "number",
      "expected scanRepo phase timing",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases.pass1,
      "number",
      "expected pass1 phase timing",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases.pass1Drain,
      "number",
      "expected pass1Drain phase timing",
    );
    const pass1Drain = result.diagnostics.timings.pass1Drain;
    assert.ok(pass1Drain, "expected pass1 drain write diagnostics");
    assert.ok(pass1Drain.batches > 0, "expected at least one pass1 flush batch");
    assert.ok(
      pass1Drain.rows.total >= pass1Drain.rows.files,
      "expected aggregate pass1 row counts",
    );
    for (const phase of [
      "deleteOldSymbols",
      "upsertFiles",
      "insertSymbolReferences",
      "upsertSymbols",
      "insertEdges",
    ] as const) {
      assert.equal(
        typeof pass1Drain.phases[phase].totalMs,
        "number",
        `expected pass1Drain.${phase} timing`,
      );
      assert.equal(
        typeof pass1Drain.phases[phase].rows,
        "number",
        `expected pass1Drain.${phase} row count`,
      );
    }
    assert.equal(
      typeof result.diagnostics.timings.phases["initSharedState.tsResolver"],
      "number",
      "expected initSharedState.tsResolver timing",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases[
        "initSharedState.tsResolver.sourceFiles"
      ],
      "number",
      "expected initSharedState.tsResolver.sourceFiles timing",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases[
        "initSharedState.tsResolver.programBuild"
      ],
      "number",
      "expected initSharedState.tsResolver.programBuild timing",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases["initSharedState.symbolMaps"],
      "number",
      "expected initSharedState.symbolMaps timing",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases["initSharedState.pass2Context"],
      "number",
      "expected initSharedState.pass2Context timing",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases["finalizeIndexing.metrics"],
      "number",
      "expected finalizeIndexing.metrics timing",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases[
        "finalizeIndexing.metrics.testRefs"
      ],
      "number",
      "expected finalizeIndexing.metrics.testRefs timing",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases[
        "finalizeIndexing.fileSummaries"
      ],
      "number",
      "expected finalizeIndexing.fileSummaries timing",
    );
    // Incremental runs now compute derived state inline before returning, so
    // status cannot report stale derived state because a background refresh
    // failed or timed out after the index call completed.
    assert.equal(
      typeof result.diagnostics.timings.phases[
        "clustersAndProcesses.loadSymbols"
      ],
      "number",
      "expected clustersAndProcesses.loadSymbols to run inline on incremental",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases.clustersAndProcesses,
      "number",
      "expected clustersAndProcesses phase to run inline on incremental",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases[
        "finalizeEdges.resolvePendingCalls"
      ],
      "number",
      "expected finalizeEdges.resolvePendingCalls timing",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases[
        "finalizeEdges.cleanupUnresolvedBuiltins"
      ],
      "number",
      "expected finalizeEdges.cleanupUnresolvedBuiltins timing",
    );
    assert.equal(
      typeof result.diagnostics.timings.phases[
        "finalizeEdges.insertConfigEdges"
      ],
      "number",
      "expected finalizeEdges.insertConfigEdges timing",
    );
  });

  it("pre-deletes existing symbols once for full diagnostic refreshes", async () => {
    const result = await handleIndexRefresh({
      repoId: REPO_ID,
      mode: "full",
      includeDiagnostics: true,
    });

    assert.equal(result.ok, true);
    assert.ok(result.diagnostics?.timings, "expected timing diagnostics");
    assert.equal(
      typeof result.diagnostics.timings.phases.preDeleteExistingSymbols,
      "number",
      "expected full refresh to report upfront stale-symbol deletion",
    );
    const pass1Drain = result.diagnostics.timings.pass1Drain;
    assert.ok(pass1Drain, "expected pass1 drain diagnostics");
    assert.equal(
      pass1Drain.rows.existingFiles,
      0,
      "full pre-delete should prevent per-batch stale symbol deletion",
    );
    assert.equal(
      pass1Drain.phases.deleteOldSymbols.rows,
      0,
      "full pre-delete should remove deleteOldSymbols work from pass1 drain",
    );
  });

  it("omits diagnostics when the flag is not set", async () => {
    const result = await handleIndexRefresh({
      repoId: REPO_ID,
      mode: "incremental",
    });

    assert.equal(result.ok, true);
    assert.equal("diagnostics" in result, false);
  });

  it("short-circuits unchanged incremental refreshes after scan/version/memory sync", async () => {
    const initial = await handleIndexRefresh({
      repoId: REPO_ID,
      mode: "incremental",
      includeDiagnostics: true,
    });
    const noop = await handleIndexRefresh({
      repoId: REPO_ID,
      mode: "incremental",
      includeDiagnostics: true,
    });

    assert.equal(initial.ok, true);
    assert.equal(noop.ok, true);
    assert.equal(noop.versionId, initial.versionId);
    assert.equal(noop.changedFiles, 0);
    assert.ok(noop.diagnostics?.timings);

    const phases = noop.diagnostics!.timings.phases;
    assert.equal(typeof phases.scanRepo, "number");
    assert.equal(typeof phases.shortCircuitNoOp, "number");
    assert.equal(typeof phases.versioning, "number");
    assert.equal(typeof phases.memorySync, "number");
    assert.equal("pass1" in phases, false);
    assert.equal("initSharedState" in phases, false);
    assert.equal("resolveUnresolvedImports" in phases, false);
    assert.equal("finalizeEdges" in phases, false);
  });
});
