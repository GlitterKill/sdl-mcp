import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  handlePRRiskAnalysis,
  selectBlastRadiusSeedSymbols,
} from "../../dist/mcp/tools/prRisk.js";
import { PRRiskAnalysisResponseSchema } from "../../dist/mcp/tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("PR Risk Analysis Tool", () => {
  const kuzuDbPath = join(tmpdir(), ".lbug-pr-risk-test-db");
  const repoId = "test-repo";
  const callerSymId = "sym-caller";

  it("limits blast-radius seeds for large deltas by risk and budget", () => {
    const changedSymbols = Array.from({ length: 600 }, (_, index) => ({
      symbolId: `sym-${index}`,
      changeType: "modified",
      tiers: { riskScore: index % 100 },
    }));

    const seeds = selectBlastRadiusSeedSymbols(changedSymbols, {
      riskThreshold: 80,
      maxChangedSymbols: 5,
      maxBlastRadius: 5,
    });

    assert.strictEqual(seeds.length, 50);
    assert.ok(
      seeds.every((symbolId) => {
        const index = Number(symbolId.replace("sym-", ""));
        return index % 100 >= 80;
      }),
    );
  });

  it("skips blast-radius seed work when the caller requests no blast radius", () => {
    const seeds = selectBlastRadiusSeedSymbols(
      [{ symbolId: "sym-1", tiers: { riskScore: 100 } }],
      { maxChangedSymbols: 5, maxBlastRadius: 0 },
    );

    assert.deepStrictEqual(seeds, []);
  });

  beforeEach(async () => {
    if (existsSync(kuzuDbPath)) {
      rmSync(kuzuDbPath, { recursive: true, force: true });
    }
    mkdirSync(kuzuDbPath, { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(kuzuDbPath);
    const conn = await getLadybugConn();

    const now = new Date().toISOString();
    const symId = "sym1";

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

    await ladybugDb.upsertFile(conn, {
      fileId: "file-1",
      repoId,
      relPath: "src/index.ts",
      contentHash: "hash1",
      language: "ts",
      byteSize: 500,
      lastIndexedAt: now,
    });

    await ladybugDb.upsertSymbol(conn, {
      symbolId: symId,
      repoId,
      fileId: "file-1",
      kind: "function",
      name: "testFunc",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 10,
      rangeEndCol: 1,
      astFingerprint: "fp1",
      signatureJson: '{"params":["a","b"],"returnType":"number"}',
      summary: "A test function",
      invariantsJson: "[]",
      sideEffectsJson: "[]",
      updatedAt: now,
    });

    await ladybugDb.upsertSymbol(conn, {
      symbolId: callerSymId,
      repoId,
      fileId: "file-1",
      kind: "function",
      name: "callerFunc",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 11,
      rangeStartCol: 0,
      rangeEndLine: 20,
      rangeEndCol: 1,
      astFingerprint: "fp-caller",
      signatureJson: '{"params":[],"returnType":"void"}',
      summary: "Calls the changed function",
      invariantsJson: "[]",
      sideEffectsJson: "[]",
      updatedAt: now,
    });

    await ladybugDb.insertEdge(conn, {
      repoId,
      fromSymbolId: callerSymId,
      toSymbolId: symId,
      edgeType: "call",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      provenance: "static",
      createdAt: now,
    });

    await ladybugDb.createVersion(conn, {
      versionId: "v1",
      repoId,
      createdAt: now,
      reason: "test-v1",
      prevVersionHash: null,
      versionHash: null,
    });

    await ladybugDb.createVersion(conn, {
      versionId: "v2",
      repoId,
      createdAt: now,
      reason: "test-v2",
      prevVersionHash: null,
      versionHash: null,
    });

    await ladybugDb.snapshotSymbolVersion(conn, {
      versionId: "v1",
      symbolId: symId,
      astFingerprint: "fp1",
      signatureJson: '{"params":["a","b"],"returnType":"number"}',
      summary: "A test function",
      invariantsJson: "[]",
      sideEffectsJson: "[]",
    });

    await ladybugDb.snapshotSymbolVersion(conn, {
      versionId: "v2",
      symbolId: symId,
      astFingerprint: "fp2",
      signatureJson: '{"params":["a","b","c"],"returnType":"string"}',
      summary: "Modified test function",
      invariantsJson: "[]",
      sideEffectsJson: '["writes-log"]',
    });
  });

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(kuzuDbPath)) {
      rmSync(kuzuDbPath, { recursive: true, force: true });
    }
  });

  it("computes risk score for delta changes", async () => {
    const request = {
      repoId,
      fromVersion: "v1",
      toVersion: "v2",
      riskThreshold: 70,
    };

    const response = await handlePRRiskAnalysis(request);
    PRRiskAnalysisResponseSchema.parse(response);

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

  it("returns findings collection with severity levels", async () => {
    const request = {
      repoId,
      detail: "full",
      fromVersion: "v1",
      toVersion: "v2",
    };

    const response = await handlePRRiskAnalysis(request);
    PRRiskAnalysisResponseSchema.parse(response);

    assert.ok(
      response.analysis.findings &&
        typeof response.analysis.findings === "object",
      "Expected findings collection",
    );
    assert.ok(
      Array.isArray(response.analysis.findings.items),
      "Expected findings.items array",
    );
    response.analysis.findings.items.forEach((finding: any) => {
      assert.ok(
        ["low", "medium", "high"].includes(finding.severity),
        `Expected finding severity to be one of: low, medium, high, got: ${finding.severity}`,
      );
      assert.ok(typeof finding.message === "string");
      assert.ok(Array.isArray(finding.affectedSymbols));
    });
  });

  it("returns changedSymbols with items array", async () => {
    const response = await handlePRRiskAnalysis({
      repoId,
      detail: "full",
      fromVersion: "v1",
      toVersion: "v2",
    });

    assert.ok(response.analysis.changedSymbols, "Expected changedSymbols in analysis");
    assert.ok(Array.isArray(response.analysis.changedSymbols.items), "Expected changedSymbols.items array");
  });

  it("returns evidence collection", async () => {
    const response = await handlePRRiskAnalysis({
      repoId,
      detail: "full",
      fromVersion: "v1",
      toVersion: "v2",
    });

    assert.ok(
      response.analysis.evidence &&
        typeof response.analysis.evidence === "object",
      "Expected evidence collection",
    );
    assert.ok(
      Array.isArray(response.analysis.evidence.items),
      "Expected evidence.items array",
    );
    response.analysis.evidence.items.forEach((evidence: any) => {
      assert.ok(typeof evidence.type === "string");
      assert.ok(typeof evidence.description === "string");
    });
  });

  it("omits empty evidence entries when no symbols changed", async () => {
    const response = await handlePRRiskAnalysis({
      repoId,
      detail: "full",
      fromVersion: "v1",
      toVersion: "v1",
    });

    assert.deepStrictEqual(response.analysis.evidence.items, []);
    assert.strictEqual(response.analysis.evidence.totalCount, 0);
  });

  it("reports blast-radius truncation when more impacts exist than the display budget", async () => {
    const conn = await getLadybugConn();
    const now = new Date().toISOString();
    for (const [symbolId, name] of [
      ["sym-caller-2", "callerTwo"],
      ["sym-caller-3", "callerThree"],
    ] as const) {
      await ladybugDb.upsertSymbol(conn, {
        symbolId,
        repoId,
        fileId: "file-1",
        kind: "function",
        name,
        exported: true,
        visibility: "public",
        language: "ts",
        rangeStartLine: 21,
        rangeStartCol: 0,
        rangeEndLine: 30,
        rangeEndCol: 1,
        astFingerprint: `${symbolId}-fp`,
        signatureJson: '{"params":[],"returnType":"void"}',
        summary: "Additional caller",
        invariantsJson: "[]",
        sideEffectsJson: "[]",
        updatedAt: now,
      });
      await ladybugDb.insertEdge(conn, {
        repoId,
        fromSymbolId: symbolId,
        toSymbolId: "sym1",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "static",
        createdAt: now,
      });
    }

    const response = await handlePRRiskAnalysis({
      repoId,
      detail: "full",
      fromVersion: "v1",
      toVersion: "v2",
      budget: { maxBlastRadius: 1 },
    });

    assert.strictEqual(response.analysis.blastRadius.items.length, 1);
    assert.ok(response.analysis.blastRadius.totalCount > 1);
    assert.strictEqual(response.analysis.blastRadius.truncated, true);
  });

  it("surfaces dependency chains in blast-radius evidence and recommended tests", async () => {
    const response = await handlePRRiskAnalysis({
      repoId,
      detail: "full",
      fromVersion: "v1",
      toVersion: "v2",
    });

    const blastRadiusEvidence = response.analysis.evidence.items.find(
      (item: any) => item.type === "blast-radius",
    );
    assert.ok(blastRadiusEvidence);

    const impacted = blastRadiusEvidence.data?.topImpacted;
    assert.ok(Array.isArray(impacted));
    const callerItem = impacted.find((item: any) => item.symbolId === callerSymId);
    assert.deepStrictEqual(callerItem?.explanationPath, [callerSymId, "sym1"]);
    assert.strictEqual(callerItem?.dependencyChain, `${callerSymId} -> sym1`);

    const regressionTest = response.analysis.recommendedTests.items.find(
      (item: any) => item.type === "regression-tests",
    );
    assert.ok(regressionTest);
    assert.ok(regressionTest.description.includes(`${callerSymId} -> sym1`));
    assert.strictEqual(regressionTest.targetSymbols[0], callerSymId);
  });
});
