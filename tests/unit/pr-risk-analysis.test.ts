import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync, existsSync } from "fs";
import { getDb, closeDb } from "../../dist/db/db.js";
import { runMigrations } from "../../dist/db/migrations.js";
import {
  createRepo,
  createVersion,
  upsertFile,
  getFilesByRepo,
  upsertSymbolTransaction,
  snapshotSymbolVersion,
  resetQueryCache,
} from "../../dist/db/queries.js";
import { getCurrentTimestamp } from "../../dist/util/time.js";
import { handlePRRiskAnalysis } from "../../dist/mcp/tools/prRisk.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("PR Risk Analysis Tool", () => {
  const testDbPath = join(__dirname, "test-pr-risk.db");
  const repoId = "test-repo";

  beforeEach(() => {
    process.env.SDL_DB_PATH = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    const db = getDb();
    runMigrations(db);

    const now = getCurrentTimestamp();

    createRepo({
      repo_id: repoId,
      root_path: "/fake/repo",
      config_json: "{}",
      created_at: now,
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
    const symId = "sym1";

    upsertSymbolTransaction({
      symbol_id: symId,
      repo_id: repoId,
      file_id: fileId,
      kind: "function",
      name: "testFunc",
      exported: 1,
      visibility: "public",
      language: "ts",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 10,
      range_end_col: 1,
      ast_fingerprint: "fp1",
      signature_json: '{"params":["a","b"],"returnType":"number"}',
      summary: "A test function",
      invariants_json: "[]",
      side_effects_json: "[]",
      updated_at: now,
    });

    createVersion({
      version_id: "v1",
      repo_id: repoId,
      created_at: now,
      reason: "test-v1",
    });

    createVersion({
      version_id: "v2",
      repo_id: repoId,
      created_at: now,
      reason: "test-v2",
    });

    snapshotSymbolVersion("v1", symId, {
      version_id: "v1",
      symbol_id: symId,
      ast_fingerprint: "fp1",
      signature_json: '{"params":["a","b"],"returnType":"number"}',
      summary: "A test function",
      invariants_json: "[]",
      side_effects_json: "[]",
    });

    snapshotSymbolVersion("v2", symId, {
      version_id: "v2",
      symbol_id: symId,
      ast_fingerprint: "fp2",
      signature_json: '{"params":["a","b","c"],"returnType":"string"}',
      summary: "Modified test function",
      invariants_json: "[]",
      side_effects_json: '["writes-log"]',
    });
  });

  afterEach(() => {
    resetQueryCache();
    closeDb();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    delete process.env.SDL_DB_PATH;
  });

  it("should compute risk score for delta changes", async () => {
    const request = {
      repoId,
      fromVersion: "v1",
      toVersion: "v2",
      riskThreshold: 70,
    };

    const response = await handlePRRiskAnalysis(request);

    assert.ok(response.analysis, "Expected analysis to be present");
    assert.ok(
      typeof response.analysis.riskScore === "number",
      "Expected riskScore to be a number",
    );
    assert.ok(
      response.analysis.riskScore >= 0 && response.analysis.riskScore <= 100,
      "Expected riskScore to be between 0 and 100",
    );
    assert.ok(
      ["low", "medium", "high"].includes(response.analysis.riskLevel),
      "Expected riskLevel to be one of: low, medium, high",
    );
  });

  it("should return findings array with severity levels", async () => {
    const request = {
      repoId,
      fromVersion: "v1",
      toVersion: "v2",
    };

    const response = await handlePRRiskAnalysis(request);

    assert.ok(
      Array.isArray(response.analysis.findings),
      "Expected findings array",
    );
    response.analysis.findings.forEach((finding: any) => {
      assert.ok(
        ["low", "medium", "high"].includes(finding.severity),
        `Expected finding severity to be one of: low, medium, high, got: ${finding.severity}`,
      );
      assert.ok(
        typeof finding.message === "string",
        "Expected finding message to be a string",
      );
      assert.ok(
        Array.isArray(finding.affectedSymbols),
        "Expected affectedSymbols to be an array",
      );
    });
  });

  it("should return impactedSymbols from blast radius", async () => {
    const request = {
      repoId,
      fromVersion: "v1",
      toVersion: "v2",
    };

    const response = await handlePRRiskAnalysis(request);

    assert.ok(
      Array.isArray(response.analysis.impactedSymbols),
      "Expected impactedSymbols array",
    );
  });

  it("should return evidence array", async () => {
    const request = {
      repoId,
      fromVersion: "v1",
      toVersion: "v2",
    };

    const response = await handlePRRiskAnalysis(request);

    assert.ok(
      Array.isArray(response.analysis.evidence),
      "Expected evidence array",
    );
    response.analysis.evidence.forEach((evidence: any) => {
      assert.ok(
        typeof evidence.type === "string",
        "Expected evidence type to be a string",
      );
      assert.ok(
        typeof evidence.description === "string",
        "Expected evidence description to be a string",
      );
    });
  });

  it("should return recommendedTests with priorities", async () => {
    const request = {
      repoId,
      fromVersion: "v1",
      toVersion: "v2",
    };

    const response = await handlePRRiskAnalysis(request);

    assert.ok(
      Array.isArray(response.analysis.recommendedTests),
      "Expected recommendedTests array",
    );
    response.analysis.recommendedTests.forEach((test: any) => {
      assert.ok(
        ["high", "medium", "low"].includes(test.priority),
        `Expected test priority to be one of: high, medium, low, got: ${test.priority}`,
      );
      assert.ok(
        typeof test.type === "string",
        "Expected test type to be a string",
      );
      assert.ok(
        typeof test.description === "string",
        "Expected test description to be a string",
      );
      assert.ok(
        Array.isArray(test.targetSymbols),
        "Expected targetSymbols to be an array",
      );
    });
  });

  it("should set escalationRequired based on risk threshold", async () => {
    const request = {
      repoId,
      fromVersion: "v1",
      toVersion: "v2",
      riskThreshold: 90,
    };

    const response = await handlePRRiskAnalysis(request);

    assert.ok(
      typeof response.escalationRequired === "boolean",
      "Expected escalationRequired to be a boolean",
    );
  });

  it("should include policyDecision when escalation required", async () => {
    const request = {
      repoId,
      fromVersion: "v1",
      toVersion: "v2",
      riskThreshold: 0,
    };

    const response = await handlePRRiskAnalysis(request);

    if (response.escalationRequired) {
      assert.ok(
        response.policyDecision,
        "Expected policyDecision to be present when escalation required",
      );
      assert.ok(
        typeof response.policyDecision.decision === "string",
        "Expected policyDecision.decision to be a string",
      );
      assert.ok(
        typeof response.policyDecision.auditHash === "string",
        "Expected policyDecision.auditHash to be a string",
      );
    }
  });

  it("should handle missing versions gracefully", async () => {
    const request = {
      repoId,
      fromVersion: "nonexistent-v1",
      toVersion: "nonexistent-v2",
    };

    try {
      await handlePRRiskAnalysis(request);
      assert.fail("Expected error to be thrown for nonexistent versions");
    } catch (error) {
      assert.ok(
        error instanceof Error && error.message.includes("Delta pack error"),
        `Expected delta error, got: ${error}`,
      );
    }
  });
});
