import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { ContextEngine } from "../../../dist/agent/context-engine.js";
import { Planner } from "../../../dist/agent/planner.js";
import { Executor } from "../../../dist/agent/executor.js";
import type {
  Action,
  AgentTask,
  Evidence,
  ExecutionMetrics,
  RungPath,
} from "../../../dist/agent/types.js";

function createTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    taskType: "debug",
    taskText: "Investigate failing behavior",
    repoId: "repo-1",
    ...overrides,
  };
}

const defaultPath: RungPath = {
  rungs: ["card", "skeleton"],
  estimatedTokens: 250,
  estimatedDurationMs: 60,
  reasoning: "default",
};

const defaultMetrics: ExecutionMetrics = {
  totalDurationMs: 25,
  totalTokens: 0,
  totalActions: 2,
  successfulActions: 2,
  failedActions: 0,
  cacheHits: 0,
};

afterEach(() => {
  mock.restoreAll();
});

describe("ContextEngine", () => {
  it("constructs and can plan a valid task", async () => {
    const engine = new ContextEngine();
    const planned = await engine.plan(createTask());

    assert.equal(planned.task.taskType, "debug");
    assert.ok(planned.path.rungs.length > 0);
    assert.deepEqual(planned.sequence, []);
  });

  it("uses planner output when generating plans", async () => {
    const expectedPath: RungPath = {
      rungs: ["card"],
      estimatedTokens: 50,
      estimatedDurationMs: 10,
      reasoning: "mocked",
    };

    const validateMock = mock.method(Planner.prototype, "validateTask", () => ({
      valid: true,
    }));
    const planMock = mock.method(Planner.prototype, "plan", () => expectedPath);

    const engine = new ContextEngine();
    const planned = await engine.plan(
      createTask({ taskType: "explain" }),
    );

    assert.equal(validateMock.mock.callCount(), 1);
    assert.equal(planMock.mock.callCount(), 1);
    assert.equal(planned.path.reasoning, "mocked");
    assert.deepEqual(planned.path.rungs, ["card"]);
  });

  it("executes planner -> context -> executor flow", async () => {
    const actions: Action[] = [
      {
        id: "a-1",
        type: "getCard",
        status: "completed",
        input: { test: true },
        output: { ok: true },
        timestamp: Date.now(),
        durationMs: 1,
        evidence: [],
      },
    ];
    const evidence: Evidence[] = [
      {
        type: "symbolCard",
        reference: "symbol:alpha",
        summary: "alpha card",
        timestamp: Date.now(),
      },
    ];

    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => defaultPath);
    mock.method(Planner.prototype, "selectContext", () => ["symbol:alpha"]);

    const executeMock = mock.method(
      Executor.prototype,
      "execute",
      async (_task, rungs, context) => {
        assert.deepEqual(rungs, ["card", "skeleton"]);
        assert.deepEqual(context, ["symbol:alpha"]);
        return { actions, evidence, success: true };
      },
    );
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => "none");

    const engine = new ContextEngine();
    const result = await engine.buildContext(createTask());

    assert.equal(executeMock.mock.callCount(), 1);
    assert.equal(result.success, true);
    assert.equal(result.taskType, "debug");
    assert.deepEqual(result.actionsTaken, actions);
    assert.deepEqual(result.finalEvidence, evidence);
    assert.equal(result.metrics.totalActions, 2);
    assert.equal(result.nextBestAction, "none");
    assert.match(result.answer ?? "", /## Symbols Found \(1\)/);
  });

  it("enforces planner budget constraints for token and duration", async () => {
    mock.method(Executor.prototype, "execute", async () => ({
      actions: [],
      evidence: [],
      success: true,
    }));
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => undefined);

    const engine = new ContextEngine();
    const result = await engine.buildContext(
      createTask({
        options: { requireDiagnostics: true },
        budget: {
          maxTokens: 100,
          maxDurationMs: 40,
          maxActions: 1,
        },
      }),
    );

    assert.equal(result.success, true);
    assert.ok(result.path.estimatedTokens <= 100);
    assert.ok(result.path.estimatedDurationMs <= 40);
    assert.ok(result.path.rungs.length >= 1);
  });

  it("returns validation errors before planning/execution", async () => {
    const engine = new ContextEngine();
    const result = await engine.buildContext(
      createTask({
        budget: { maxActions: -1 },
      }),
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /maxActions must be positive/);
    assert.deepEqual(result.actionsTaken, []);
    assert.deepEqual(result.finalEvidence, []);
  });

  it("returns structured error result when planner throws", async () => {
    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => {
      throw new Error("planner exploded");
    });

    const engine = new ContextEngine();
    const result = await engine.buildContext(createTask());

    assert.equal(result.success, false);
    assert.equal(result.path.rungs.length, 0);
    assert.equal(result.metrics.failedActions, 0);
    assert.match(result.summary, /Task failed: planner exploded/);
    assert.equal(result.nextBestAction, "retryWithDifferentInputs");
  });

  it("surfaces failed execution result and failure answer", async () => {
    const failedAction: Action = {
      id: "a-failed",
      type: "analyze",
      status: "failed",
      input: { rung: "raw" },
      error: "denied",
      timestamp: Date.now(),
      durationMs: 0,
      evidence: [],
    };

    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => defaultPath);
    mock.method(Planner.prototype, "selectContext", () => []);
    mock.method(Executor.prototype, "execute", async () => ({
      actions: [failedAction],
      evidence: [],
      success: false,
    }));
    mock.method(Executor.prototype, "getMetrics", () => ({
      ...defaultMetrics,
      totalActions: 1,
      successfulActions: 0,
      failedActions: 1,
    }));
    mock.method(Executor.prototype, "getNextBestAction", () => "refineRequest");

    const engine = new ContextEngine();
    const result = await engine.buildContext(createTask());

    assert.equal(result.success, false);
    assert.equal(result.actionsTaken.length, 1);
    assert.match(result.summary, /completed with errors/);
    assert.equal(
      result.answer,
      "Task execution failed. Review actions and errors for details.",
    );
    assert.equal(result.nextBestAction, "refineRequest");
  });

  it("handles empty plans and empty context", async () => {
    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => ({
      rungs: [],
      estimatedTokens: 0,
      estimatedDurationMs: 0,
      reasoning: "empty",
    }));
    mock.method(Planner.prototype, "selectContext", () => []);
    mock.method(Executor.prototype, "execute", async () => ({
      actions: [],
      evidence: [],
      success: true,
    }));
    mock.method(Executor.prototype, "getMetrics", () => ({
      ...defaultMetrics,
      totalActions: 0,
      successfulActions: 0,
    }));
    mock.method(Executor.prototype, "getNextBestAction", () => undefined);

    const engine = new ContextEngine();
    const result = await engine.buildContext(createTask());

    assert.equal(result.success, true);
    assert.deepEqual(result.path.rungs, []);
    assert.match(
      result.summary,
      /Executed 0 action\(s\), collected 0 evidence item\(s\)\./,
    );
  });

  it("keeps summary stable when context has no symbols", async () => {
    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => defaultPath);
    mock.method(Planner.prototype, "selectContext", () => ["file:src/main.ts"]);

    mock.method(
      Executor.prototype,
      "execute",
      async (_task, _rungs, context) => {
        assert.deepEqual(context, ["file:src/main.ts"]);
        return { actions: [], evidence: [], success: true };
      },
    );
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => undefined);

    const engine = new ContextEngine();
    const result = await engine.buildContext(createTask());

    assert.equal(result.success, true);
    assert.ok(!result.summary.includes("expanded"));
  });

  it("keeps original symbol context even if cluster expansion is unavailable", async () => {
    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => defaultPath);
    mock.method(Planner.prototype, "selectContext", () => ["symbol:alpha"]);

    mock.method(
      Executor.prototype,
      "execute",
      async (_task, _rungs, context) => {
        assert.ok(context.includes("symbol:alpha"));
        return { actions: [], evidence: [], success: true };
      },
    );
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => undefined);

    const engine = new ContextEngine();
    const result = await engine.buildContext(createTask());

    assert.equal(result.success, true);
  });
});
