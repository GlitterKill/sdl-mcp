/**
 * Integration tests for the live file watcher (watchRepository).
 *
 * Uses real temp directories, real SQLite DB, and real chokidar/fs.watch
 * to verify end-to-end watcher behavior.
 *
 * Each test gets its own isolated repo ID so tests can share the global DB
 * instance without interfering with each other.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getDb } from "../../src/db/db.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  createRepo,
  getSymbolsByRepo,
  getFileByRepoPath,
  getSymbolsByFile,
} from "../../src/db/queries.js";
import {
  indexRepo,
  watchRepository,
  getWatcherHealth,
  type IndexWatchHandle,
} from "../../src/indexer/indexer.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Poll fn() every 100 ms until it returns true or timeoutMs elapses.
 * Resolves to true if the condition was met, false on timeout.
 */
function waitFor(
  fn: () => boolean,
  timeoutMs = 2000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (fn()) {
        clearInterval(interval);
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 100);
  });
}

/** Minimal repo config JSON accepted by indexRepo / watchRepository. */
function makeRepoConfig(repoId: string, rootPath: string): string {
  return JSON.stringify({
    repoId,
    rootPath,
    ignore: ["**/node_modules/**", "**/dist/**"],
    languages: ["ts", "tsx", "js", "jsx"],
    maxFileBytes: 2_000_000,
    includeNodeModulesTypes: false,
  });
}

/** Delete all DB rows belonging to a test repo (best-effort). */
function cleanupRepoData(repoId: string): void {
  try {
    const db = getDb();
    db.prepare(
      "DELETE FROM symbol_versions WHERE version_id IN (SELECT version_id FROM versions WHERE repo_id = ?)",
    ).run(repoId);
    db.prepare("DELETE FROM versions WHERE repo_id = ?").run(repoId);
    db.prepare(
      "DELETE FROM metrics WHERE symbol_id IN (SELECT symbol_id FROM symbols WHERE repo_id = ?)",
    ).run(repoId);
    db.prepare("DELETE FROM edges WHERE repo_id = ?").run(repoId);
    db.prepare("DELETE FROM symbols WHERE repo_id = ?").run(repoId);
    db.prepare("DELETE FROM files WHERE repo_id = ?").run(repoId);
    db.prepare("DELETE FROM repos WHERE repo_id = ?").run(repoId);
  } catch {
    // ignore – DB may already be closed during teardown
  }
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

// Per-test state
let repoId = "";
let repoRoot = "";
let watcher: IndexWatchHandle | null = null;

// ---------------------------------------------------------------------------
// Suite-level setup: write a temp config and DB, run migrations
// ---------------------------------------------------------------------------

// We create a single config file and DB for the entire suite to avoid
// the overhead of re-opening/closing SQLite for every test.
// A minimal config file is required so that watchRepository can call
// loadConfig() and read watchDebounceMs.

const suiteConfigDir = mkdtempSync(join(tmpdir(), "sdl-watch-cfg-"));
const configFilePath = join(suiteConfigDir, "sdlmcp.config.json");
const testDbPath = join(suiteConfigDir, "test-watch.db");

writeFileSync(
  configFilePath,
  JSON.stringify({
    repos: [],
    dbPath: testDbPath,
    policy: {
      maxWindowLines: 180,
      maxWindowTokens: 1400,
      requireIdentifiers: true,
      allowBreakGlass: true,
    },
    indexing: {
      concurrency: 2,
      enableFileWatching: true,
      maxWatchedFiles: 25000,
      engine: "typescript",
      watchDebounceMs: 150,
    },
    slice: {
      defaultMaxCards: 60,
      defaultMaxTokens: 12000,
      edgeWeights: { call: 1.0, import: 0.6, config: 0.8 },
    },
  }),
  "utf-8",
);

// Point SDL to our test config + DB
process.env.SDL_CONFIG = configFilePath;
process.env.SDL_DB_PATH = testDbPath;

// Open DB and run migrations once for the suite
const db = getDb(testDbPath);
runMigrations(db);

// ---------------------------------------------------------------------------
// describe block
// ---------------------------------------------------------------------------

describe("file-watch-live", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    // Unique repo ID per test to avoid cross-test pollution
    repoId = `test-watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    repoRoot = mkdtempSync(join(tmpdir(), "sdl-watch-repo-"));
    watcher = null;

    // Create src subdirectory
    mkdirSync(join(repoRoot, "src"), { recursive: true });
  });

  afterEach(async () => {
    // Always close watcher first
    try {
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
    } catch {
      // ignore
    }

    // Clean up DB rows for this test's repo
    cleanupRepoData(repoId);

    // Remove temp directory
    try {
      if (repoRoot && existsSync(repoRoot)) {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // Test 1: New .ts file added
  // -------------------------------------------------------------------------
  it("detects a newly added .ts file and indexes its symbols", async () => {
    // Write and index an initial file
    writeFileSync(
      join(repoRoot, "src", "util.ts"),
      "export function greet(name: string): string { return `Hello, ${name}`; }\n",
      "utf-8",
    );

    cleanupRepoData(repoId);
    createRepo({
      repo_id: repoId,
      root_path: repoRoot,
      config_json: makeRepoConfig(repoId, repoRoot),
      created_at: new Date().toISOString(),
    });

    await indexRepo(repoId, "full");

    const symbolsBefore = getSymbolsByRepo(repoId);
    const countBefore = symbolsBefore.length;
    assert.ok(countBefore > 0, "expected at least one symbol before adding file");

    // Start watcher
    watcher = watchRepository(repoId);

    // Add a new file
    writeFileSync(
      join(repoRoot, "src", "parser.ts"),
      "export function parse(input: string): string[] { return input.split(','); }\n",
      "utf-8",
    );

    const found = await waitFor(() => {
      const health = getWatcherHealth(repoId);
      return (health?.eventsProcessed ?? 0) >= 1;
    }, 2000);

    assert.ok(found, "watcher did not process the new file event within 2s");

    const symbolsAfter = getSymbolsByRepo(repoId);
    const parserFile = getFileByRepoPath(repoId, "src/parser.ts");
    assert.ok(parserFile !== null, "expected parser.ts to be indexed in DB");

    const parserSymbols = getSymbolsByFile(parserFile!.file_id);
    assert.ok(
      parserSymbols.length > 0,
      "expected at least one symbol from parser.ts",
    );
    assert.ok(
      symbolsAfter.length > countBefore,
      "symbol count should have increased",
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: Existing function signature changed
  // -------------------------------------------------------------------------
  it("re-indexes when a function signature changes", async () => {
    const filePath = join(repoRoot, "src", "util.ts");
    writeFileSync(
      filePath,
      "export function add(a: number, b: number): number { return a + b; }\n",
      "utf-8",
    );

    cleanupRepoData(repoId);
    createRepo({
      repo_id: repoId,
      root_path: repoRoot,
      config_json: makeRepoConfig(repoId, repoRoot),
      created_at: new Date().toISOString(),
    });

    await indexRepo(repoId, "full");

    // Capture the original signature
    const fileRowBefore = getFileByRepoPath(repoId, "src/util.ts");
    assert.ok(fileRowBefore, "expected src/util.ts to be indexed");
    const symbolsBefore = getSymbolsByFile(fileRowBefore!.file_id);
    const addBefore = symbolsBefore.find((s) => s.name === "add");
    assert.ok(addBefore, "expected symbol 'add' to exist");

    // Start watcher
    watcher = watchRepository(repoId);

    // Modify the file — add a third parameter
    writeFileSync(
      filePath,
      "export function add(a: number, b: number, c: number): number { return a + b + c; }\n",
      "utf-8",
    );

    const processed = await waitFor(() => {
      const health = getWatcherHealth(repoId);
      return (health?.eventsProcessed ?? 0) >= 1;
    }, 2000);

    assert.ok(processed, "watcher did not process file change within 2s");

    // Verify signature changed in DB
    const fileRowAfter = getFileByRepoPath(repoId, "src/util.ts");
    assert.ok(fileRowAfter, "expected src/util.ts to still be indexed");
    const symbolsAfter = getSymbolsByFile(fileRowAfter!.file_id);
    const addAfter = symbolsAfter.find((s) => s.name === "add");
    assert.ok(addAfter, "expected symbol 'add' to still exist after update");

    // The signature JSON should now reflect 3 parameters
    const sigAfter = addAfter.signature_json ?? "";
    assert.ok(
      sigAfter.includes("c") || sigAfter !== (addBefore.signature_json ?? ""),
      `expected signature to change; got: ${sigAfter}`,
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: File deleted
  // -------------------------------------------------------------------------
  it("removes symbols when a file is deleted", async () => {
    const filePath = join(repoRoot, "src", "util.ts");
    writeFileSync(
      filePath,
      "export function toDelete(): void {}\n",
      "utf-8",
    );

    cleanupRepoData(repoId);
    createRepo({
      repo_id: repoId,
      root_path: repoRoot,
      config_json: makeRepoConfig(repoId, repoRoot),
      created_at: new Date().toISOString(),
    });

    await indexRepo(repoId, "full");

    const fileRowBefore = getFileByRepoPath(repoId, "src/util.ts");
    assert.ok(fileRowBefore, "expected src/util.ts to be indexed before deletion");
    const symbolsBefore = getSymbolsByFile(fileRowBefore!.file_id);
    assert.ok(symbolsBefore.length > 0, "expected symbols before deletion");

    // Start watcher
    watcher = watchRepository(repoId);

    // Delete the file
    unlinkSync(filePath);

    const processed = await waitFor(() => {
      const health = getWatcherHealth(repoId);
      return (health?.eventsProcessed ?? 0) >= 1;
    }, 2000);

    assert.ok(processed, "watcher did not process file deletion within 2s");

    // Symbols from util.ts should be gone
    const fileRowAfter = getFileByRepoPath(repoId, "src/util.ts");
    if (fileRowAfter) {
      const symbolsAfter = getSymbolsByFile(fileRowAfter.file_id);
      assert.strictEqual(
        symbolsAfter.length,
        0,
        "expected no symbols after file deletion",
      );
    } else {
      // File row itself was removed – also acceptable
      assert.ok(true, "file row removed from DB on deletion");
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: Files matching ignorePatterns are not reindexed
  // -------------------------------------------------------------------------
  it("does not process files matching ignorePatterns (node_modules)", async () => {
    // Start with an empty but indexed repo
    writeFileSync(
      join(repoRoot, "src", "util.ts"),
      "export const x = 1;\n",
      "utf-8",
    );

    cleanupRepoData(repoId);
    createRepo({
      repo_id: repoId,
      root_path: repoRoot,
      config_json: makeRepoConfig(repoId, repoRoot),
      created_at: new Date().toISOString(),
    });

    await indexRepo(repoId, "full");

    // Start watcher
    watcher = watchRepository(repoId);

    const healthBefore = getWatcherHealth(repoId);
    const eventsProcessedBefore = healthBefore?.eventsProcessed ?? 0;

    // Write a file inside node_modules (should be ignored)
    const nmDir = join(repoRoot, "node_modules", "foo");
    mkdirSync(nmDir, { recursive: true });
    writeFileSync(
      join(nmDir, "index.ts"),
      "export function foo(): void {}\n",
      "utf-8",
    );

    // Wait long enough that the watcher could theoretically fire
    await new Promise<void>((resolve) => setTimeout(resolve, 600));

    const healthAfter = getWatcherHealth(repoId);
    const eventsProcessedAfter = healthAfter?.eventsProcessed ?? 0;

    assert.strictEqual(
      eventsProcessedAfter,
      eventsProcessedBefore,
      "eventsProcessed should not have incremented for node_modules file",
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: Rapid burst debounced to 1 reindex
  // -------------------------------------------------------------------------
  it("debounces rapid writes to a single reindex event", async () => {
    const filePath = join(repoRoot, "src", "util.ts");
    writeFileSync(filePath, "export const v = 0;\n", "utf-8");

    cleanupRepoData(repoId);
    createRepo({
      repo_id: repoId,
      root_path: repoRoot,
      config_json: makeRepoConfig(repoId, repoRoot),
      created_at: new Date().toISOString(),
    });

    await indexRepo(repoId, "full");

    // Start watcher
    watcher = watchRepository(repoId);

    // Write 10 rapid changes within ~100ms (debounce is 150ms)
    for (let i = 0; i < 10; i++) {
      writeFileSync(filePath, `export const v = ${i};\n`, "utf-8");
      // tiny delay between writes so the OS actually sees them as changes
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    // Wait for the debounce to fire and the reindex to complete
    const processed = await waitFor(() => {
      const health = getWatcherHealth(repoId);
      return (health?.eventsProcessed ?? 0) >= 1;
    }, 2000);

    assert.ok(processed, "watcher did not process debounced event within 2s");

    // Give a bit more time to see if additional events get processed
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    const finalHealth = getWatcherHealth(repoId);
    const eventsProcessed = finalHealth?.eventsProcessed ?? 0;

    // Should be exactly 1 (debounced from 10 writes)
    assert.strictEqual(
      eventsProcessed,
      1,
      `expected exactly 1 processed event after debounce, got ${eventsProcessed}`,
    );
  });

  // -------------------------------------------------------------------------
  // Test 6: Watcher.close() stops processing
  // -------------------------------------------------------------------------
  it("stops processing file events after close()", async () => {
    const filePath = join(repoRoot, "src", "util.ts");
    writeFileSync(filePath, "export const initial = true;\n", "utf-8");

    cleanupRepoData(repoId);
    createRepo({
      repo_id: repoId,
      root_path: repoRoot,
      config_json: makeRepoConfig(repoId, repoRoot),
      created_at: new Date().toISOString(),
    });

    await indexRepo(repoId, "full");

    // Start and immediately close watcher
    watcher = watchRepository(repoId);
    await watcher.close();
    watcher = null;

    const healthAfterClose = getWatcherHealth(repoId);
    const eventsProcessedAfterClose = healthAfterClose?.eventsProcessed ?? 0;

    // Modify the file after close
    writeFileSync(filePath, "export const initial = false;\n", "utf-8");

    // Wait long enough for a watcher to fire if it were still active
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));

    const finalHealth = getWatcherHealth(repoId);
    const finalEventsProcessed = finalHealth?.eventsProcessed ?? 0;

    assert.strictEqual(
      finalEventsProcessed,
      eventsProcessedAfterClose,
      "eventsProcessed should not have changed after watcher was closed",
    );
  });
});
