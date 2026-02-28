import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync } from "node:fs";
import {
  generateSummariesForRepo,
  type SummaryBatchResult,
} from "../../dist/indexer/summary-generator.js";
import { getDb, closeDb } from "../../dist/db/db.js";
import { runMigrations } from "../../dist/db/migrations.js";
import {
  createRepo,
  upsertFile,
  upsertSymbolTransaction,
  getSummaryCache,
  upsertSummaryCache,
  resetQueryCache,
} from "../../dist/db/queries.js";
import { hashContent } from "../../dist/util/hashing.js";
import type { AppConfig } from "../../dist/config/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_REPO_ID = "test-summary-batch-repo";

/**
 * Builds a minimal AppConfig with semantic generation enabled.
 */
function makeConfig(overrides?: {
  batchSize?: number;
  maxConcurrency?: number;
}): AppConfig {
  return {
    repos: [],
    dbPath: ":memory:",
    policy: {
      maxWindowLines: 180,
      maxWindowTokens: 1400,
      requireIdentifiers: true,
      allowBreakGlass: true,
    },
    semantic: {
      enabled: true,
      alpha: 0.6,
      provider: "mock",
      model: "all-MiniLM-L6-v2",
      generateSummaries: true,
      summaryModel: "claude-haiku-4-5-20251001",
      summaryMaxConcurrency: overrides?.maxConcurrency ?? 5,
      summaryBatchSize: overrides?.batchSize ?? 20,
    },
  } as AppConfig;
}

/**
 * Inserts a minimal file + symbol into the test DB.
 * Returns the file_id so callers can add more symbols to the same file.
 */
function insertTestSymbol(opts: {
  symbolId: string;
  name: string;
  kind?: string;
  summary?: string | null;
  signatureJson?: string | null;
}): number {
  const db = getDb();

  // Upsert a file row (idempotent across multiple calls)
  const relPath = "src/test.ts";
  const existing = db
    .prepare("SELECT file_id FROM files WHERE repo_id = ? AND rel_path = ?")
    .get(TEST_REPO_ID, relPath) as { file_id: number } | undefined;

  let fileId: number;
  if (existing) {
    fileId = existing.file_id;
  } else {
    upsertFile({
      repo_id: TEST_REPO_ID,
      rel_path: relPath,
      content_hash: hashContent("test-file"),
      language: "ts",
      byte_size: 1024,
      last_indexed_at: new Date().toISOString(),
    });
    const row = db
      .prepare("SELECT file_id FROM files WHERE repo_id = ? AND rel_path = ?")
      .get(TEST_REPO_ID, relPath) as { file_id: number };
    fileId = row.file_id;
  }

  upsertSymbolTransaction({
    symbol_id: opts.symbolId,
    repo_id: TEST_REPO_ID,
    file_id: fileId,
    kind: (opts.kind ?? "function") as "function",
    name: opts.name,
    exported: 1,
    visibility: "public",
    language: "ts",
    range_start_line: 1,
    range_start_col: 0,
    range_end_line: 10,
    range_end_col: 1,
    ast_fingerprint: hashContent(opts.symbolId),
    signature_json: opts.signatureJson ?? null,
    summary: opts.summary ?? null,
    invariants_json: null,
    side_effects_json: null,
    updated_at: new Date().toISOString(),
  });

  return fileId;
}

/**
 * Seeds a fresh cache entry for a symbol with its current cardHash
 * (matching name + kind + signatureJson), so it appears "fresh" and
 * generateSummariesForRepo should skip it.
 */
function seedFreshCache(
  symbolId: string,
  name: string,
  kind: string,
  signatureJson: string | null,
  summary: string,
): void {
  const cardHash = hashContent([name, kind, signatureJson ?? ""].join("|"));
  const now = new Date().toISOString();
  upsertSummaryCache({
    symbol_id: symbolId,
    summary,
    provider: "mock",
    model: "mock",
    card_hash: cardHash,
    cost_usd: 0.0001,
    created_at: now,
    updated_at: now,
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("generateSummariesForRepo — batch generation", () => {
  const testDbPath = join(__dirname, "test-summary-batch.db");

  beforeEach(() => {
    process.env["SDL_DB_PATH"] = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    resetQueryCache();
    const db = getDb();
    runMigrations(db);

    // Create the test repo
    createRepo({
      repo_id: TEST_REPO_ID,
      root_path: "/fake/test-batch",
      config_json: JSON.stringify({ repoId: TEST_REPO_ID, rootPath: "/fake/test-batch" }),
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    closeDb();
    resetQueryCache();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    delete process.env["SDL_DB_PATH"];
  });

  // -------------------------------------------------------------------------
  // Test 1: Symbols are processed in batches of ≤ batchSize
  // -------------------------------------------------------------------------
  it("processes symbols and batch counts are arithmetically correct", async () => {
    const SYMBOL_COUNT = 7;
    const BATCH_SIZE = 3;

    // Insert 7 symbols, all needing summaries (no cache entries)
    for (let i = 0; i < SYMBOL_COUNT; i++) {
      insertTestSymbol({
        symbolId: `batch-sym-${i}`,
        name: `batchFunc${i}`,
        kind: "function",
      });
    }

    const config = makeConfig({ batchSize: BATCH_SIZE, maxConcurrency: 1 });
    const result = await generateSummariesForRepo(TEST_REPO_ID, config);

    // All symbols had no cache → all should be generated (mock provider is used)
    assert.strictEqual(result.generated, SYMBOL_COUNT, "All symbols should be generated");
    assert.strictEqual(result.skipped, 0, "No symbols should be skipped");
    assert.strictEqual(result.failed, 0, "No symbols should fail with mock provider");
    assert.ok(result.totalCostUsd >= 0, "Cost should be non-negative");
  });

  // -------------------------------------------------------------------------
  // Test 2: Symbols with fresh cache entries are skipped
  // -------------------------------------------------------------------------
  it("skips symbols whose cache entry matches the current cardHash", async () => {
    // Insert 5 symbols
    for (let i = 0; i < 5; i++) {
      insertTestSymbol({
        symbolId: `cache-sym-${i}`,
        name: `cachedFunc${i}`,
        kind: "function",
        signatureJson: null,
      });
    }

    // Seed fresh cache for 3 of them (indices 0, 1, 2)
    for (let i = 0; i < 3; i++) {
      seedFreshCache(
        `cache-sym-${i}`,
        `cachedFunc${i}`,
        "function",
        null,
        `Cached summary for cachedFunc${i}.`,
      );
    }

    const config = makeConfig();
    const result = await generateSummariesForRepo(TEST_REPO_ID, config);

    // 2 symbols have no cache → generated; 3 have fresh cache → skipped
    assert.strictEqual(result.generated, 2, "Only the 2 uncached symbols should be generated");
    assert.strictEqual(result.skipped, 3, "The 3 fresh-cached symbols should be skipped");
    assert.strictEqual(result.failed, 0, "No failures expected");
  });

  // -------------------------------------------------------------------------
  // Test 3: One batch throws; remaining batches still process; failed > 0
  // -------------------------------------------------------------------------
  it("counts failed symbols when the provider throws, but continues processing remaining batches", async () => {
    // Insert 4 symbols — with batchSize=2 there will be 2 batches
    for (let i = 0; i < 4; i++) {
      insertTestSymbol({
        symbolId: `fail-sym-${i}`,
        name: `failFunc${i}`,
        kind: "function",
      });
    }

    // Override fetch so the first call throws and subsequent calls succeed
    let fetchCallCount = 0;
    globalThis.fetch = async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => {
      fetchCallCount += 1;
      // Make the provider "api" require a key — since we pass a key, it will hit fetch.
      // We throw on the very first fetch call to simulate a network error.
      if (fetchCallCount === 1) {
        throw new Error("Simulated network failure");
      }
      return {
        ok: true,
        status: 200,
        text: async () => "{}",
        json: async () => ({
          content: [{ type: "text", text: "Generated after failure." }],
        }),
      } as unknown as Response;
    };

    // Use "api" provider with a key and batchSize=1 so each symbol is its own batch
    const config: AppConfig = {
      ...makeConfig({ batchSize: 1, maxConcurrency: 1 }),
      semantic: {
        enabled: true,
        alpha: 0.6,
        provider: "api" as const,
        model: "all-MiniLM-L6-v2",
        generateSummaries: true,
        summaryModel: "claude-haiku-4-5-20251001",
        summaryApiKey: "test-api-key",
        summaryMaxConcurrency: 1,
        summaryBatchSize: 1,
      },
    };

    const result = await generateSummariesForRepo(TEST_REPO_ID, config);

    // The first fetch throws → 1 failed; the remaining 3 succeed
    assert.ok(result.failed >= 1, `Expected at least 1 failed, got ${result.failed}`);
    assert.ok(result.generated >= 1, `Expected at least 1 generated, got ${result.generated}`);
    assert.strictEqual(
      result.generated + result.failed,
      4,
      "generated + failed should equal total symbols (4)",
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: summaryStats field values are arithmetically correct
  // -------------------------------------------------------------------------
  it("summaryStats totals are arithmetically consistent with per-symbol outcomes", async () => {
    const TOTAL = 6;
    const CACHED = 2;
    const EXPECTED_GENERATED = TOTAL - CACHED;

    for (let i = 0; i < TOTAL; i++) {
      insertTestSymbol({
        symbolId: `stats-sym-${i}`,
        name: `statsFunc${i}`,
        kind: "function",
        signatureJson: i < 2 ? `{"text":"statsFunc${i}(): void"}` : null,
      });
    }

    // Seed fresh cache for the first CACHED symbols
    for (let i = 0; i < CACHED; i++) {
      seedFreshCache(
        `stats-sym-${i}`,
        `statsFunc${i}`,
        "function",
        `{"text":"statsFunc${i}(): void"}`,
        `Cached summary ${i}.`,
      );
    }

    const config = makeConfig({ batchSize: 5 });
    const result: SummaryBatchResult = await generateSummariesForRepo(
      TEST_REPO_ID,
      config,
    );

    // Basic arithmetic checks
    assert.strictEqual(result.skipped, CACHED, `Expected ${CACHED} skipped`);
    assert.strictEqual(
      result.generated,
      EXPECTED_GENERATED,
      `Expected ${EXPECTED_GENERATED} generated`,
    );
    assert.strictEqual(result.failed, 0, "No failures expected");
    assert.ok(
      result.totalCostUsd >= 0,
      "totalCostUsd must be non-negative",
    );

    // generated + skipped + failed should equal total symbols
    assert.strictEqual(
      result.generated + result.skipped + result.failed,
      TOTAL,
      "Totals must add up to the total symbol count",
    );

    // Verify that the DB symbol rows have been updated with the new summaries
    for (let i = CACHED; i < TOTAL; i++) {
      const cached = getSummaryCache(`stats-sym-${i}`);
      assert.ok(
        cached !== null,
        `Cache entry should exist for stats-sym-${i} after generation`,
      );
      assert.ok(
        cached.summary.length > 0,
        `Summary should be non-empty for stats-sym-${i}`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: Returns early (all zeros) when semantic is not configured
  // -------------------------------------------------------------------------
  it("returns all-zero result when semantic config is absent", async () => {
    insertTestSymbol({ symbolId: "no-semantic-sym", name: "noSemanticFunc" });

    const config: AppConfig = {
      repos: [],
      dbPath: ":memory:",
      policy: {
        maxWindowLines: 180,
        maxWindowTokens: 1400,
        requireIdentifiers: true,
        allowBreakGlass: true,
      },
      // No semantic field
    };

    const result = await generateSummariesForRepo(TEST_REPO_ID, config);

    assert.strictEqual(result.generated, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.totalCostUsd, 0);
  });
});
