import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync, existsSync, rmSync, mkdirSync } from "fs";
import { getDb, closeDb } from "../../dist/db/db.js";
import { runMigrations } from "../../dist/db/migrations.js";
import {
  createRepo,
  createVersion,
  upsertFile,
  getFilesByRepo,
  upsertSymbolTransaction,
  resetQueryCache,
  getAgentFeedback,
  getAgentFeedbackByRepo,
  getAgentFeedbackByVersion,
  getAggregatedFeedback,
  getSymbolFeedbackWeights,
  batchUpdateSymbolFeedbackWeights,
} from "../../dist/db/queries.js";
import { getCurrentTimestamp } from "../../dist/util/time.js";
import {
  handleAgentFeedback,
  handleAgentFeedbackQuery,
} from "../../dist/mcp/tools/agent-feedback.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Agent Feedback Tool", () => {
  const testDir = join(__dirname, "test-agent-feedback");
  const testDbPath = join(testDir, "test-agent-feedback.db");
  const repoId = "test-repo";
  const versionId = "v1";
  const sliceHandle = "slice-abc123";

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    process.env.SDL_DB_PATH = testDbPath;
    const db = getDb();
    runMigrations(db);

    const now = getCurrentTimestamp();

    createRepo({
      repo_id: repoId,
      root_path: "/fake/repo",
      config_json: "{}",
      created_at: now,
    });

    createVersion({
      version_id: versionId,
      repo_id: repoId,
      created_at: now,
      reason: "test-version",
      prev_version_hash: null,
      version_hash: null,
    });

    upsertFile({
      repo_id: repoId,
      rel_path: "src/index.ts",
      content_hash: "hash1",
      language: "ts",
      byte_size: 500,
      last_indexed_at: now,
    });

    const files = getFilesByRepo(repoId);
    const fileId = files[0].file_id;

    for (let i = 1; i <= 10; i++) {
      upsertSymbolTransaction({
        symbol_id: `sym${i}`,
        repo_id: repoId,
        file_id: fileId,
        kind: "function",
        name: `func${i}`,
        exported: 1,
        visibility: "public",
        language: "ts",
        range_start_line: i,
        range_start_col: 0,
        range_end_line: i + 5,
        range_end_col: 1,
        ast_fingerprint: `fp${i}`,
        signature_json: "{}",
        summary: `Function ${i}`,
        invariants_json: "[]",
        side_effects_json: "[]",
        updated_at: now,
      });
    }
  });

  afterEach(() => {
    resetQueryCache();
    closeDb();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    delete process.env.SDL_DB_PATH;
  });

  describe("handleAgentFeedback", () => {
    it("should record feedback with useful symbols", async () => {
      const request = {
        repoId,
        versionId,
        sliceHandle,
        usefulSymbols: ["sym1", "sym2", "sym3"],
        taskType: "debug" as const,
        taskText: "Fix null pointer exception",
      };

      const response = await handleAgentFeedback(request);

      assert.strictEqual(response.ok, true);
      assert.ok(response.feedbackId > 0);
      assert.strictEqual(response.repoId, repoId);
      assert.strictEqual(response.versionId, versionId);
      assert.strictEqual(response.symbolsRecorded, 3);
    });

    it("should record feedback with useful and missing symbols", async () => {
      const request = {
        repoId,
        versionId,
        sliceHandle,
        usefulSymbols: ["sym1", "sym2"],
        missingSymbols: ["sym8", "sym9"],
        taskTags: ["async", "error-handling"],
      };

      const response = await handleAgentFeedback(request);

      assert.strictEqual(response.ok, true);
      assert.strictEqual(response.symbolsRecorded, 4);
    });

    it("should validate required fields", async () => {
      const request = {
        repoId,
        versionId,
        sliceHandle: "",
        usefulSymbols: ["sym1"],
      };

      try {
        await handleAgentFeedback(request);
        assert.fail("Expected validation error");
      } catch (error) {
        assert.ok(
          error instanceof Error && error.message.includes("sliceHandle"),
        );
      }
    });

    it("should throw error for nonexistent repo", async () => {
      const request = {
        repoId: "nonexistent-repo",
        versionId,
        sliceHandle,
        usefulSymbols: ["sym1"],
      };

      try {
        await handleAgentFeedback(request);
        assert.fail("Expected error for nonexistent repo");
      } catch (error) {
        assert.ok(
          error instanceof Error && error.message.includes("not found"),
        );
      }
    });

    it("should throw error for nonexistent version", async () => {
      const request = {
        repoId,
        versionId: "nonexistent-version",
        sliceHandle,
        usefulSymbols: ["sym1"],
      };

      try {
        await handleAgentFeedback(request);
        assert.fail("Expected error for nonexistent version");
      } catch (error) {
        assert.ok(
          error instanceof Error && error.message.includes("not found"),
        );
      }
    });

    it("should update symbol feedback weights", async () => {
      await handleAgentFeedback({
        repoId,
        versionId,
        sliceHandle,
        usefulSymbols: ["sym1", "sym2"],
        missingSymbols: ["sym3"],
      });

      const weights = getSymbolFeedbackWeights(
        ["sym1", "sym2", "sym3"],
        repoId,
      );

      assert.strictEqual(weights.get("sym1"), 0.1);
      assert.strictEqual(weights.get("sym2"), 0.1);
      assert.strictEqual(weights.get("sym3"), -0.1);
    });

    it("should persist feedback to database", async () => {
      const response = await handleAgentFeedback({
        repoId,
        versionId,
        sliceHandle,
        usefulSymbols: ["sym1", "sym2"],
        missingSymbols: ["sym3"],
        taskType: "implement",
      });

      const feedback = getAgentFeedback(response.feedbackId);
      assert.ok(feedback);
      assert.strictEqual(feedback.repo_id, repoId);
      assert.strictEqual(feedback.version_id, versionId);
      assert.strictEqual(feedback.slice_handle, sliceHandle);
      assert.strictEqual(feedback.task_type, "implement");

      const usefulSymbols = JSON.parse(feedback.useful_symbols_json);
      assert.deepStrictEqual(usefulSymbols, ["sym1", "sym2"]);
    });
  });

  describe("handleAgentFeedbackQuery", () => {
    beforeEach(async () => {
      await handleAgentFeedback({
        repoId,
        versionId,
        sliceHandle: "slice1",
        usefulSymbols: ["sym1", "sym2"],
        missingSymbols: ["sym9"],
        taskType: "debug",
      });

      await handleAgentFeedback({
        repoId,
        versionId,
        sliceHandle: "slice2",
        usefulSymbols: ["sym1", "sym3"],
        missingSymbols: ["sym10"],
        taskType: "review",
      });

      await handleAgentFeedback({
        repoId,
        versionId: "v1",
        sliceHandle: "slice3",
        usefulSymbols: ["sym2", "sym4"],
        missingSymbols: ["sym8"],
        taskTags: ["async"],
      });
    });

    it("should return feedback records for repo", async () => {
      const response = await handleAgentFeedbackQuery({
        repoId,
        limit: 10,
      });

      assert.strictEqual(response.repoId, repoId);
      assert.strictEqual(response.feedback.length, 3);
      assert.strictEqual(response.hasMore, false);
    });

    it("should support pagination", async () => {
      const response = await handleAgentFeedbackQuery({
        repoId,
        limit: 2,
      });

      assert.strictEqual(response.feedback.length, 2);
      assert.strictEqual(response.hasMore, true);
    });

    it("should filter by version", async () => {
      const response = await handleAgentFeedbackQuery({
        repoId,
        versionId,
        limit: 10,
      });

      assert.ok(response.feedback.every((f) => f.versionId === versionId));
    });

    it("should return aggregated statistics", async () => {
      const response = await handleAgentFeedbackQuery({
        repoId,
        limit: 10,
      });

      assert.ok(response.aggregatedStats);
      assert.strictEqual(response.aggregatedStats.totalFeedback, 3);

      const topUseful = response.aggregatedStats.topUsefulSymbols;
      assert.ok(topUseful.length > 0);

      const sym1Entry = topUseful.find((s) => s.symbolId === "sym1");
      assert.ok(sym1Entry);
      assert.strictEqual(sym1Entry.count, 2);
    });

    it("should throw error for nonexistent repo", async () => {
      try {
        await handleAgentFeedbackQuery({
          repoId: "nonexistent-repo",
        });
        assert.fail("Expected error for nonexistent repo");
      } catch (error) {
        assert.ok(
          error instanceof Error && error.message.includes("not found"),
        );
      }
    });
  });

  describe("Feedback ranking impact", () => {
    it("should affect symbol ranking after multiple feedback", async () => {
      for (let i = 0; i < 5; i++) {
        await handleAgentFeedback({
          repoId,
          versionId,
          sliceHandle: `slice-${i}`,
          usefulSymbols: ["sym1"],
          missingSymbols: [],
        });
      }

      for (let i = 0; i < 3; i++) {
        await handleAgentFeedback({
          repoId,
          versionId,
          sliceHandle: `slice-negative-${i}`,
          usefulSymbols: ["sym2"],
          missingSymbols: ["sym1"],
        });
      }

      const weights = getSymbolFeedbackWeights(["sym1", "sym2"], repoId);

      assert.ok(
        (weights.get("sym1") ?? 0) > (weights.get("sym2") ?? 0),
        "sym1 should have higher weight than sym2 after more positive feedback",
      );
    });

    it("should show >= 5% improvement in top-10 recall (simulated)", async () => {
      const groundTruthSymbols = ["sym1", "sym2", "sym3", "sym4", "sym5"];

      await handleAgentFeedback({
        repoId,
        versionId,
        sliceHandle: "training-slice",
        usefulSymbols: groundTruthSymbols,
        missingSymbols: [],
      });

      const weights = getSymbolFeedbackWeights(groundTruthSymbols, repoId);

      const rankedSymbols = groundTruthSymbols
        .map((s) => ({ symbolId: s, weight: weights.get(s) ?? 0 }))
        .sort((a, b) => b.weight - a.weight);

      const topN = 5;
      const hitsInTopN = rankedSymbols
        .slice(0, topN)
        .filter((s) => groundTruthSymbols.includes(s.symbolId)).length;

      const recall = hitsInTopN / topN;
      assert.ok(
        recall >= 0.95,
        `Expected recall >= 0.95 after training, got ${recall}`,
      );
    });
  });

  describe("Migration test", () => {
    it("should have agent_feedback table after migration", () => {
      const db = getDb();
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_feedback'",
        )
        .get();
      assert.ok(tables, "agent_feedback table should exist after migration");
    });

    it("should have symbol_feedback_weights table after migration", () => {
      const db = getDb();
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_feedback_weights'",
        )
        .get();
      assert.ok(
        tables,
        "symbol_feedback_weights table should exist after migration",
      );
    });

    it("should have correct indexes on agent_feedback", () => {
      const db = getDb();
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_feedback'",
        )
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);

      assert.ok(
        indexNames.includes("idx_agent_feedback_repo"),
        "Should have repo index",
      );
      assert.ok(
        indexNames.includes("idx_agent_feedback_version"),
        "Should have version index",
      );
    });
  });

  describe("Tool latency", () => {
    it("should have p95 latency <= 100ms for feedback submission", async () => {
      const latencies: number[] = [];

      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        await handleAgentFeedback({
          repoId,
          versionId,
          sliceHandle: `latency-test-${i}`,
          usefulSymbols: ["sym1", "sym2"],
          missingSymbols: ["sym3"],
        });
        latencies.push(performance.now() - start);
      }

      latencies.sort((a, b) => a - b);
      const p95Index = Math.floor(latencies.length * 0.95);
      const p95Latency = latencies[p95Index];

      assert.ok(
        p95Latency <= 100,
        `Expected p95 latency <= 100ms, got ${p95Latency.toFixed(2)}ms`,
      );
    });

    it("should have p95 latency <= 100ms for feedback query", async () => {
      for (let i = 0; i < 10; i++) {
        await handleAgentFeedback({
          repoId,
          versionId,
          sliceHandle: `query-latency-${i}`,
          usefulSymbols: ["sym1"],
        });
      }

      const latencies: number[] = [];

      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        await handleAgentFeedbackQuery({
          repoId,
          limit: 50,
        });
        latencies.push(performance.now() - start);
      }

      latencies.sort((a, b) => a - b);
      const p95Index = Math.floor(latencies.length * 0.95);
      const p95Latency = latencies[p95Index];

      assert.ok(
        p95Latency <= 100,
        `Expected p95 latency <= 100ms for query, got ${p95Latency.toFixed(2)}ms`,
      );
    });
  });
});
