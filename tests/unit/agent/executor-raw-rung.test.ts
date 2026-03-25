import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Executor } from "../../../dist/agent/executor.js";
import type { GateEvaluator } from "../../../dist/agent/executor.js";
import type { AgentTask } from "../../../dist/agent/types.js";
import { PolicyEngine } from "../../../dist/policy/engine.js";

describe("executor raw rung", () => {
  it("captures bounded code-window evidence via evaluateRequest", async () => {
    const mockGate: GateEvaluator = async () => ({
      approved: true,
      repoId: "test-repo",
      symbolId: "symbol-1",
      file: "src/test.ts",
      range: { startLine: 1, startCol: 0, endLine: 10, endCol: 0 },
      code: "function test() { return 42; }",
      whyApproved: ["identifiers-match"],
      whyDenied: [],
      estimatedTokens: 50,
    });

    const executor = new Executor(
      new PolicyEngine({ defaultDenyRaw: false }),
      mockGate,
    );
    const task: AgentTask = {
      taskType: "debug",
      taskText: "Inspect raw context",
      repoId: "test-repo",
    };

    const result = await executor.execute(task, ["raw"], ["symbol:symbol-1"]);
    const rawAction = result.actions.find((a) => a.type === "needWindow");

    assert.ok(rawAction, "Should have a needWindow action");
    assert.equal(rawAction.status, "completed");
    assert.deepEqual(rawAction.output, { symbolsProcessed: 1 });

    const codeEvidence = result.evidence.filter(
      (e) => e.type === "codeWindow",
    );
    assert.ok(codeEvidence.length > 0, "Should capture code window evidence");
    assert.ok(
      codeEvidence[0].summary.includes("Code window"),
      "Evidence summary should describe code window",
    );
  });

  it("records policy denial as diagnostic evidence without aborting", async () => {
    const mockGate: GateEvaluator = async () => ({
      approved: false,
      repoId: "test-repo",
      symbolId: "symbol-1",
      file: "src/test.ts",
      range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
      code: "",
      whyApproved: [],
      whyDenied: ["identifiers-not-found"],
      estimatedTokens: 0,
    });

    const executor = new Executor(
      new PolicyEngine({ defaultDenyRaw: false }),
      mockGate,
    );
    const task: AgentTask = {
      taskType: "review",
      taskText: "Inspect raw context",
      repoId: "test-repo",
    };

    const result = await executor.execute(task, ["raw"], ["symbol:symbol-1"]);
    const action = result.actions[0];

    assert.equal(action.status, "failed");
    assert.deepEqual(action.output, { symbolsProcessed: 0 });
  });
});

describe("executor escalation", () => {
  it("escalates to next rung when last planned rung produces no evidence", async () => {
    // Use a gate evaluator that always approves (for raw rung if escalation reaches it)
    const mockGate: GateEvaluator = async () => ({
      approved: true,
      repoId: "test-repo",
      symbolId: "symbol-1",
      file: "src/test.ts",
      range: { startLine: 1, startCol: 0, endLine: 5, endCol: 0 },
      code: "const x = 1;",
      whyApproved: ["break-glass"],
      whyDenied: [],
      estimatedTokens: 20,
    });

    const executor = new Executor(
      new PolicyEngine({ defaultDenyRaw: false }),
      mockGate,
    );
    const noEvidenceError = new Error("forced empty rung");
    const testExecutor = executor as unknown as {
      executeCardRung: (task: AgentTask, context: string[]) => Promise<void>;
      executeSkeletonRung: (task: AgentTask, context: string[]) => Promise<void>;
      executeHotPathRung: (task: AgentTask, context: string[]) => Promise<void>;
    };
    testExecutor.executeCardRung = async () => {
      throw noEvidenceError;
    };
    testExecutor.executeSkeletonRung = async () => {
      throw noEvidenceError;
    };
    testExecutor.executeHotPathRung = async () => {
      throw noEvidenceError;
    };

    const task: AgentTask = {
      taskType: "debug",
      taskText: "Investigate issue",
      repoId: "test-repo",
    };

    // Start with just "card" rung. Each non-raw rung is forced to fail without
    // recording evidence so escalation is driven purely by the ladder logic.
    const result = await executor.execute(task, ["card"], []);

    assert.deepStrictEqual(
      result.actions.map((action) => action.type),
      ["getCard", "getSkeleton", "getHotPath"],
      `Expected rung escalation through hotPath, got ${result.actions.map((a) => a.type).join(", ")}`,
    );
  });

  it("does not escalate when evidence is produced", async () => {
    const mockGate: GateEvaluator = async () => ({
      approved: true,
      repoId: "test-repo",
      symbolId: "sym-1",
      file: "src/test.ts",
      range: { startLine: 1, startCol: 0, endLine: 5, endCol: 0 },
      code: "const x = 1;",
      whyApproved: ["break-glass"],
      whyDenied: [],
      estimatedTokens: 20,
    });

    const executor = new Executor(
      new PolicyEngine({ defaultDenyRaw: false }),
      mockGate,
    );
    const task: AgentTask = {
      taskType: "debug",
      taskText: "Investigate handleRequest",
      repoId: "test-repo",
    };

    // raw rung with a valid symbol should produce evidence (via mock gate)
    const result = await executor.execute(task, ["raw"], ["symbol:sym-1"]);

    // Should only have the single raw action — no escalation needed
    const needWindowActions = result.actions.filter(
      (a) => a.type === "needWindow",
    );
    assert.equal(
      needWindowActions.length,
      1,
      "Should have exactly 1 needWindow action (no escalation)",
    );
  });
});

describe("executor identifier extraction (via raw rung)", () => {
  // extractIdentifiersFromTask is private, so we test it indirectly via the
  // raw rung. The mock gate captures the CodeWindowRequest to expose the
  // identifiersToFind array, which contains the extracted identifiers.

  /** Helper: create a capturing mock gate that records identifiersToFind. */
  function createCapturingGate() {
    const captured: string[][] = [];
    const gate: GateEvaluator = async (req) => {
      captured.push([...(req.identifiersToFind ?? [])]);
      return {
        approved: true,
        repoId: req.repoId,
        symbolId: req.symbolId,
        file: "src/test.ts",
        range: { startLine: 1, startCol: 0, endLine: 5, endCol: 0 },
        code: "const x = 1;",
        whyApproved: ["break-glass"],
        whyDenied: [],
        estimatedTokens: 20,
      };
    };
    return { gate, captured };
  }

  it("extracts camelCase and PascalCase identifiers from task text", async () => {
    const { gate, captured } = createCapturingGate();
    const executor = new Executor(
      new PolicyEngine({ defaultDenyRaw: false }),
      gate,
    );
    const task: AgentTask = {
      taskType: "debug",
      taskText: "Fix the handleRequest and processData methods, check IndexError",
      repoId: "test-repo",
    };

    await executor.execute(task, ["raw"], ["symbol:sym-1"]);

    assert.ok(captured.length > 0, "Gate should have been called");
    const ids = captured[0];
    assert.ok(ids.includes("handleRequest"), "Should extract camelCase: handleRequest");
    assert.ok(ids.includes("processData"), "Should extract camelCase: processData");
    assert.ok(ids.includes("IndexError"), "Should extract PascalCase: IndexError");
  });

  it("extracts snake_case identifiers from task text", async () => {
    const { gate, captured } = createCapturingGate();
    const executor = new Executor(
      new PolicyEngine({ defaultDenyRaw: false }),
      gate,
    );
    const task: AgentTask = {
      taskType: "debug",
      taskText: "Check the max_window_lines and parse_config values",
      repoId: "test-repo",
    };

    await executor.execute(task, ["raw"], ["symbol:sym-1"]);

    assert.ok(captured.length > 0, "Gate should have been called");
    const ids = captured[0];
    assert.ok(ids.includes("max_window_lines"), "Should extract snake_case: max_window_lines");
    assert.ok(ids.includes("parse_config"), "Should extract snake_case: parse_config");
  });

  it("filters out STOP_WORDS in fallback extraction", async () => {
    const { gate, captured } = createCapturingGate();
    const executor = new Executor(
      new PolicyEngine({ defaultDenyRaw: false }),
      gate,
    );
    const task: AgentTask = {
      taskType: "explain",
      // All words are either too short or in STOP_WORDS — except "validation"
      taskText: "find the code that does validation",
      repoId: "test-repo",
    };

    await executor.execute(task, ["raw"], ["symbol:sym-1"]);

    assert.ok(captured.length > 0, "Gate should have been called");
    const ids = captured[0];
    assert.ok(ids.includes("validation"), "Should include non-stop-word: validation");
    // STOP_WORDS: "find", "the", "code", "that", "does" should be filtered
    assert.ok(!ids.includes("find"), "Should filter STOP_WORD: find");
    assert.ok(!ids.includes("the"), "Should filter STOP_WORD: the");
    assert.ok(!ids.includes("code"), "Should filter STOP_WORD: code");
  });

  it("handles task text with no extractable identifiers", async () => {
    const { gate, captured } = createCapturingGate();
    const executor = new Executor(
      new PolicyEngine({ defaultDenyRaw: false }),
      gate,
    );
    const task: AgentTask = {
      taskType: "explain",
      // Only stop words and short words
      taskText: "the and for",
      repoId: "test-repo",
    };

    await executor.execute(task, ["raw"], ["symbol:sym-1"]);

    assert.ok(captured.length > 0, "Gate should have been called");
    const ids = captured[0];
    assert.equal(ids.length, 0, "Should produce empty identifiers for all-stop-word text");
  });

  it("caps identifiers at MAX_IDENTIFIERS (10)", async () => {
    const { gate, captured } = createCapturingGate();
    const executor = new Executor(
      new PolicyEngine({ defaultDenyRaw: false }),
      gate,
    );
    const task: AgentTask = {
      taskType: "debug",
      // 12 distinct camelCase identifiers — should be capped at 10
      taskText: "fix handleAlpha handleBeta handleGamma handleDelta handleEpsilon handleZeta handleEta handleTheta handleIota handleKappa handleLambda handleMu",
      repoId: "test-repo",
    };

    await executor.execute(task, ["raw"], ["symbol:sym-1"]);

    assert.ok(captured.length > 0, "Gate should have been called");
    const ids = captured[0];
    assert.ok(ids.length <= 10, `Should cap at 10 identifiers, got ${ids.length}`);
  });

  it("bounds identifier extraction on very long task text", async () => {
    const { gate, captured } = createCapturingGate();
    const executor = new Executor(
      new PolicyEngine({ defaultDenyRaw: false }),
      gate,
    );
    const task: AgentTask = {
      taskType: "debug",
      // 7000+ chars — should be sliced to 2000 before regex
      taskText: "handleRequest ".repeat(500),
      repoId: "test-repo",
    };

    await executor.execute(task, ["raw"], ["symbol:sym-1"]);

    assert.ok(captured.length > 0, "Gate should have been called");
    const ids = captured[0];
    // handleRequest should still be extracted from the first 2000 chars
    assert.ok(ids.includes("handleRequest"), "Should extract handleRequest from bounded text");
    assert.ok(ids.length <= 10, "Should respect MAX_IDENTIFIERS cap");
  });
});
