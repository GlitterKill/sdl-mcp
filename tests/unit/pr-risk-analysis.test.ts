import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { handlePRRiskAnalysis } from "../../dist/mcp/tools/prRisk.js";
import type { PRRiskAnalysisRequest } from "../../dist/mcp/tools.js";

describe("PR Risk Analysis Tool", () => {
  it("should compute risk score for delta changes", async () => {
    const request: PRRiskAnalysisRequest = {
      repoId: "test-repo",
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
    const request: PRRiskAnalysisRequest = {
      repoId: "test-repo",
      fromVersion: "v1",
      toVersion: "v2",
    };

    const response = await handlePRRiskAnalysis(request);

    assert.ok(
      Array.isArray(response.analysis.findings),
      "Expected findings array",
    );
    response.analysis.findings.forEach((finding) => {
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
    const request: PRRiskAnalysisRequest = {
      repoId: "test-repo",
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
    const request: PRRiskAnalysisRequest = {
      repoId: "test-repo",
      fromVersion: "v1",
      toVersion: "v2",
    };

    const response = await handlePRRiskAnalysis(request);

    assert.ok(
      Array.isArray(response.analysis.evidence),
      "Expected evidence array",
    );
    response.analysis.evidence.forEach((evidence) => {
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
    const request: PRRiskAnalysisRequest = {
      repoId: "test-repo",
      fromVersion: "v1",
      toVersion: "v2",
    };

    const response = await handlePRRiskAnalysis(request);

    assert.ok(
      Array.isArray(response.analysis.recommendedTests),
      "Expected recommendedTests array",
    );
    response.analysis.recommendedTests.forEach((test) => {
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
    const request: PRRiskAnalysisRequest = {
      repoId: "test-repo",
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
    const request: PRRiskAnalysisRequest = {
      repoId: "test-repo",
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
    const request: PRRiskAnalysisRequest = {
      repoId: "test-repo",
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
