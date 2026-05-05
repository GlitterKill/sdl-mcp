import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync, mkdirSync } from "node:fs";

import { initLadybugDb, closeLadybugDb, getLadybugConn } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  handleAgentFeedback,
  handleAgentFeedbackQuery,
  resetAgentFeedbackRateLimitForTests,
} from "../../dist/mcp/tools/agent-feedback.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Agent Feedback Tool", () => {
  const testDir = join(__dirname, "test-agent-feedback");
  const graphDbPath = join(testDir, "graph");

  const repoId = "test-repo";
  const versionId = "v1";
  const sliceHandle = "slice-abc123";

  beforeEach(async () => {
    resetAgentFeedbackRateLimitForTests();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();

    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: "/fake/repo",
      configJson: JSON.stringify({
        repoId,
        rootPath: "/fake/repo",
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });

    await ladybugDb.createVersion(conn, {
      versionId,
      repoId,
      createdAt: now,
      reason: "test-version",
      prevVersionHash: null,
      versionHash: null,
    });

    await ladybugDb.upsertFile(conn, {
      fileId: "file1",
      repoId,
      relPath: "src/index.ts",
      contentHash: "hash1",
      language: "ts",
      byteSize: 500,
      lastIndexedAt: now,
    });

    for (let i = 1; i <= 10; i++) {
      await ladybugDb.upsertSymbol(conn, {
        symbolId: `sym${i}`,
        repoId,
        fileId: "file1",
        kind: "function",
        name: `func${i}`,
        exported: true,
        visibility: "public",
        language: "ts",
        rangeStartLine: i,
        rangeStartCol: 0,
        rangeEndLine: i + 5,
        rangeEndCol: 1,
        astFingerprint: `fp${i}`,
        signatureJson: "{}",
        summary: `Function ${i}`,
        invariantsJson: "[]",
        sideEffectsJson: "[]",
        updatedAt: now,
      });
    }
  });

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("handleAgentFeedback", () => {
    it("records feedback with useful symbols", async () => {
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
      assert.strictEqual(response.repoId, repoId);
      assert.strictEqual(response.versionId, versionId);
      assert.strictEqual(response.symbolsRecorded, 3);
      assert.ok(typeof response.feedbackId === "string");
      assert.ok(response.feedbackId.length > 0);

      const conn = await getLadybugConn();
      const row = await ladybugDb.getAgentFeedback(conn, response.feedbackId);
      assert.ok(row);
      assert.strictEqual(row.repoId, repoId);
      assert.strictEqual(row.versionId, versionId);
      assert.strictEqual(row.sliceHandle, sliceHandle);
      assert.deepStrictEqual(JSON.parse(row.usefulSymbolsJson), ["sym1", "sym2", "sym3"]);
      assert.deepStrictEqual(JSON.parse(row.missingSymbolsJson), []);
    });

    it("records feedback with useful and missing symbols", async () => {
      const response = await handleAgentFeedback({
        repoId,
        versionId,
        sliceHandle,
        usefulSymbols: ["sym1", "sym2"],
        missingSymbols: ["sym8", "sym9"],
        taskTags: ["async", "error-handling"],
      });

      assert.strictEqual(response.ok, true);
      assert.strictEqual(response.symbolsRecorded, 4);
    });

    it("validates required fields", async () => {
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
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("sliceHandle"));
      }
    });

    it("throws error for nonexistent repo", async () => {
      try {
        await handleAgentFeedback({
          repoId: "nonexistent-repo",
          versionId,
          sliceHandle,
          usefulSymbols: ["sym1"],
        });
        assert.fail("Expected error for nonexistent repo");
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("not found"));
      }
    });

    it("throws error for nonexistent version", async () => {
      try {
        await handleAgentFeedback({
          repoId,
          versionId: "nonexistent-version",
          sliceHandle,
          usefulSymbols: ["sym1"],
        });
        assert.fail("Expected error for nonexistent version");
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("not found"));
      }
    });

    it("rate limits repeated feedback writes for the same repo", async () => {
      for (let i = 0; i < 30; i++) {
        const response = await handleAgentFeedback({
          repoId,
          versionId,
          sliceHandle: `slice-rate-${i}`,
          usefulSymbols: ["sym1"],
        });
        assert.strictEqual(response.ok, true);
      }

      await assert.rejects(
        handleAgentFeedback({
          repoId,
          versionId,
          sliceHandle: "slice-rate-overflow",
          usefulSymbols: ["sym1"],
        }),
        (error) =>
          error instanceof Error &&
          error.message.toLowerCase().includes("rate limit"),
      );
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
        versionId,
        sliceHandle: "slice3",
        usefulSymbols: ["sym2", "sym4"],
        missingSymbols: ["sym8"],
        taskTags: ["async"],
      });
    });

    it("returns feedback records for repo", async () => {
      const response = await handleAgentFeedbackQuery({
        repoId,
        limit: 10,
      });

      assert.strictEqual(response.repoId, repoId);
      assert.strictEqual(response.feedback.length, 3);
      assert.strictEqual(response.hasMore, false);
    });

    it("supports pagination via hasMore", async () => {
      const response = await handleAgentFeedbackQuery({
        repoId,
        limit: 2,
      });

      assert.strictEqual(response.feedback.length, 2);
      assert.strictEqual(response.hasMore, true);
    });

    it("filters by version", async () => {
      const response = await handleAgentFeedbackQuery({
        repoId,
        versionId,
        limit: 10,
      });

      assert.ok(response.feedback.every((f) => f.versionId === versionId));
    });

    it("applies since consistently when versionId is also provided", async () => {
      const conn = await getLadybugConn();
      const since = new Date(Date.now() + 5_000).toISOString();
      const createdAt = new Date(Date.parse(since) + 1_000).toISOString();

      await ladybugDb.upsertAgentFeedback(conn, {
        feedbackId: "fb-since-version",
        repoId,
        versionId,
        sliceHandle: "slice-since-version",
        usefulSymbolsJson: JSON.stringify(["sym-future"]),
        missingSymbolsJson: JSON.stringify([]),
        taskTagsJson: null,
        taskType: "debug",
        taskText: "future entry",
        createdAt,
      });

      const response = await handleAgentFeedbackQuery({
        repoId,
        versionId,
        since,
        limit: 10,
      });

      assert.strictEqual(response.feedback.length, 1);
      assert.strictEqual(response.feedback[0]?.feedbackId, "fb-since-version");
      assert.strictEqual(response.aggregatedStats.totalFeedback, 1);
      assert.deepStrictEqual(response.aggregatedStats.topUsefulSymbols, [
        { symbolId: "sym-future", count: 1 },
      ]);
    });

    it("returns aggregated statistics", async () => {
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

    it("throws error for nonexistent repo", async () => {
      try {
        await handleAgentFeedbackQuery({ repoId: "nonexistent-repo" });
        assert.fail("Expected error for nonexistent repo");
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("not found"));
      }
    });
  });
});
