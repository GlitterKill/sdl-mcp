/**
 * Integration tests for Pass 2 parallelisation (Task 2.1/2.2).
 *
 * Verifies:
 *  - pass2Concurrency=1  produces the same edge set as the default sequential path.
 *  - pass2Concurrency>1  (value of 4) produces the same edge set without races.
 *  - Progress reporting fires correctly under concurrent completion.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import type { IndexProgress } from "../../dist/indexer/indexer-init.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function writeRepoFile(
  repoRoot: string,
  relPath: string,
  content: string,
): void {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

/**
 * Build a small multi-file Go repo that produces at least 3 cross-file call
 * edges so we can verify dedup correctness under concurrency.
 */
function createGoRepo(repoRoot: string): void {
  writeRepoFile(repoRoot, "go.mod", "module github.com/acme/concurrent\n");

  writeRepoFile(
    repoRoot,
    "app/main.go",
    [
      "package app",
      "",
      'import "github.com/acme/concurrent/pkg/alpha"',
      'import "github.com/acme/concurrent/pkg/beta"',
      'import "github.com/acme/concurrent/pkg/gamma"',
      "",
      "func Run() {",
      "  alpha.A()",
      "  beta.B()",
      "  gamma.C()",
      "  LocalHelper()",
      "}",
      "",
    ].join("\n"),
  );

  writeRepoFile(
    repoRoot,
    "app/helpers.go",
    ["package app", "", "func LocalHelper() {}", ""].join("\n"),
  );

  writeRepoFile(
    repoRoot,
    "pkg/alpha/alpha.go",
    ["package alpha", "", "func A() {}", ""].join("\n"),
  );

  writeRepoFile(
    repoRoot,
    "pkg/beta/beta.go",
    ["package beta", "", "func B() {}", ""].join("\n"),
  );

  writeRepoFile(
    repoRoot,
    "pkg/gamma/gamma.go",
    ["package gamma", "", "func C() {}", ""].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pass2Concurrency — parity and progress", () => {
  const graphDbPath = join(tmpdir(), ".lbug-pass2-concurrency-test.lbug");
  const configPath = join(tmpdir(), "sdl-pass2-concurrency-config.json");
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  let repoDir: string | null = null;

  const REPO_ID = "test-pass2-concurrency";

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }

    repoDir = mkdtempSync(join(tmpdir(), "sdl-mcp-pass2-concurrent-"));
    createGoRepo(repoDir);

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
      rootPath: repoDir!,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoDir!,
        ignore: [],
        languages: ["go"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: false,
        packageJsonPath: null,
        tsconfigPath: null,
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
    try {
      rmSync(graphDbPath, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(configPath, { recursive: true, force: true });
    } catch {}
    if (repoDir) {
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch {}
      repoDir = null;
    }
  });

  // -------------------------------------------------------------------------
  // Helper: collect call edges for "Run" after an indexRepo run.
  // -------------------------------------------------------------------------

  async function getRunCallEdges(): Promise<
    { fromName: string; toName: string; resolution: string }[]
  > {
    const conn = await getLadybugConn();
    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);
    const run = symbols.find(
      (s) => s.name === "Run" && s.kind === "function",
    );
    if (!run) return [];
    const edges = await ladybugDb.getEdgesFrom(conn, run.symbolId);
    const symbolById = new Map(symbols.map((s) => [s.symbolId, s]));
    return edges
      .filter((e) => e.edgeType === "call")
      .map((e) => ({
        fromName: "Run",
        toName: symbolById.get(e.toSymbolId)?.name ?? e.toSymbolId,
        resolution: e.resolution ?? "",
      }));
  }

  // -------------------------------------------------------------------------
  // Test 1: pass2Concurrency=1 produces correct edges (parity with default).
  // -------------------------------------------------------------------------

  it("pass2Concurrency=1 creates all expected call edges (sequential parity)", async () => {
    // Rewrite config with concurrency=1 explicitly.
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: {
            engine: "typescript",
            enableFileWatching: false,
            pass2Concurrency: 1,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0, "indexRepo should return a versionId");

    const callEdges = await getRunCallEdges();
    const toNames = new Set(callEdges.map((e) => e.toName));

    assert.ok(toNames.has("A"), "Should have edge to A()");
    assert.ok(toNames.has("B"), "Should have edge to B()");
    assert.ok(toNames.has("C"), "Should have edge to C()");
    assert.ok(toNames.has("LocalHelper"), "Should have edge to LocalHelper()");
    // No duplicates.
    assert.equal(
      callEdges.length,
      toNames.size,
      "No duplicate call edges should exist",
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: pass2Concurrency=4 produces the same stable edge set.
  // -------------------------------------------------------------------------

  it("pass2Concurrency=4 produces the same edge count and targets as sequential", async () => {
    // Re-index with concurrency=4.
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: {
            engine: "typescript",
            enableFileWatching: false,
            pass2Concurrency: 4,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0, "indexRepo should return a versionId");

    const callEdges = await getRunCallEdges();
    const toNames = new Set(callEdges.map((e) => e.toName));

    assert.ok(toNames.has("A"), "Should have edge to A() under concurrency=4");
    assert.ok(toNames.has("B"), "Should have edge to B() under concurrency=4");
    assert.ok(toNames.has("C"), "Should have edge to C() under concurrency=4");
    assert.ok(
      toNames.has("LocalHelper"),
      "Should have edge to LocalHelper() under concurrency=4",
    );
    // Dedup: no duplicates even with parallel execution.
    assert.equal(
      callEdges.length,
      toNames.size,
      "No duplicate call edges should exist under concurrency=4",
    );
    // Same count as sequential (4 outgoing call edges from Run).
    assert.equal(callEdges.length, 4, "Run should have exactly 4 call edges");
  });

  // -------------------------------------------------------------------------
  // Test 3: Progress events are emitted for each pass2 file under concurrency.
  // -------------------------------------------------------------------------

  it("progress reporting fires for all pass2 files under concurrency=4", async () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: {
            engine: "typescript",
            enableFileWatching: false,
            pass2Concurrency: 4,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const progressEvents: IndexProgress[] = [];
    await indexRepo(REPO_ID, "full", (p) => progressEvents.push(p));

    const pass2Events = progressEvents.filter((p) => p.stage === "pass2");
    assert.ok(
      pass2Events.length >= 2,
      `Expected at least 2 pass2 progress events, got ${pass2Events.length}`,
    );

    // The final event should have current === total.
    const finalEvent = pass2Events[pass2Events.length - 1];
    assert.ok(finalEvent, "Should have at least one pass2 progress event");
    assert.equal(
      finalEvent.current,
      finalEvent.total,
      "Final pass2 progress event should have current === total",
    );
  });
});
