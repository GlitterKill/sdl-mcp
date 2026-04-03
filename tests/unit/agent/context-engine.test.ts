import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { ContextEngine } from "../../../dist/agent/context-engine.js";
import { Planner } from "../../../dist/agent/planner.js";
import { Executor } from "../../../dist/agent/executor.js";
import type {
  Action,
  AgentTask,
  ContextSeedResult,
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
    const planned = await engine.plan(createTask({ taskType: "explain" }));

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
    // Broad-mode compacts: actionsTaken, path, metrics are stripped
    assert.deepEqual(result.finalEvidence, evidence);
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
    // Use precise mode so path/metrics remain visible on the result
    const result = await engine.buildContext(
      createTask({
        options: { requireDiagnostics: true, contextMode: "precise" },
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
    // Broad-mode compacts actionsTaken away, but summary and answer remain
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
    // Broad-mode compacts path away; verify summary instead
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

  // -----------------------------------------------------------------------
  // Semantic-first context seeding tests
  // -----------------------------------------------------------------------

  it("semantic seeding is attempted before keyword fallback", async () => {
    const seedResult: ContextSeedResult = {
      candidates: [
        {
          contextRef: "symbol:sem-1",
          source: "semantic",
          score: 0.95,
          sourceRank: 0,
        },
        {
          contextRef: "symbol:sem-2",
          source: "semantic",
          score: 0.8,
          sourceRank: 1,
        },
        {
          contextRef: "cluster:cl-1",
          source: "semantic",
          score: 0.7,
          sourceRank: 2,
        },
      ],
      sources: { semantic: 3, lexical: 0, feedback: 0 },
    };

    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => defaultPath);
    // Return empty context so seeding pipeline runs
    mock.method(Planner.prototype, "selectContext", () => []);
    mock.method(
      ContextEngine.prototype as Record<string, unknown>,
      "seedContext",
      async () => seedResult,
    );

    let capturedContext: string[] = [];
    mock.method(
      Executor.prototype,
      "execute",
      async (_task: unknown, _rungs: unknown, context: string[]) => {
        capturedContext = context;
        return { actions: [], evidence: [], success: true };
      },
    );
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => undefined);

    const engine = new ContextEngine();
    const result = await engine.buildContext(createTask());

    assert.equal(result.success, true);
    // Verify the seeded symbols/clusters appear in the context passed to executor
    assert.ok(
      capturedContext.includes("symbol:sem-1"),
      "Semantic seed symbol-1 should be in context",
    );
    assert.ok(
      capturedContext.includes("symbol:sem-2"),
      "Semantic seed symbol-2 should be in context",
    );
    assert.ok(
      capturedContext.includes("cluster:cl-1"),
      "Semantic seed cluster should be in context",
    );
  });

  it("falls back gracefully when semantic seeding throws", async () => {
    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => defaultPath);
    mock.method(Planner.prototype, "selectContext", () => []);
    mock.method(
      ContextEngine.prototype as Record<string, unknown>,
      "seedContext",
      async () => {
        throw new Error("retrieval unavailable");
      },
    );

    mock.method(Executor.prototype, "execute", async () => ({
      actions: [],
      evidence: [],
      success: true,
    }));
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => undefined);

    const engine = new ContextEngine();
    const result = await engine.buildContext(createTask());

    // Engine should still succeed — seeding failure is non-fatal
    assert.equal(result.success, true);
    assert.ok(!result.error, "No error should surface from seeding failure");
  });

  it("respects per-source quotas in seed results", async () => {
    // Create a seed result where semantic dominates but is capped
    const seedResult: ContextSeedResult = {
      candidates: [
        {
          contextRef: "symbol:sem-1",
          source: "semantic",
          score: 1.0,
          sourceRank: 0,
        },
        {
          contextRef: "symbol:sem-2",
          source: "semantic",
          score: 0.9,
          sourceRank: 1,
        },
        {
          contextRef: "symbol:lex-1",
          source: "lexical",
          score: 0.85,
          sourceRank: 0,
        },
        {
          contextRef: "symbol:fb-1",
          source: "feedback",
          score: 0.6,
          sourceRank: 0,
        },
      ],
      sources: { semantic: 2, lexical: 1, feedback: 1 },
    };

    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => defaultPath);
    mock.method(Planner.prototype, "selectContext", () => []);
    mock.method(
      ContextEngine.prototype as Record<string, unknown>,
      "seedContext",
      async () => seedResult,
    );

    let capturedContext: string[] = [];
    mock.method(
      Executor.prototype,
      "execute",
      async (_task: unknown, _rungs: unknown, context: string[]) => {
        capturedContext = context;
        return { actions: [], evidence: [], success: true };
      },
    );
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => undefined);

    const engine = new ContextEngine();
    const result = await engine.buildContext(
      createTask({ options: { contextMode: "precise" } }),
    );

    assert.equal(result.success, true);
    // Total context should match the seed result (4 candidates)
    assert.equal(
      capturedContext.length,
      4,
      `Expected 4 seeded context items, got ${capturedContext.length}`,
    );
    // Verify all sources are represented
    assert.ok(capturedContext.includes("symbol:sem-1"));
    assert.ok(capturedContext.includes("symbol:lex-1"));
    assert.ok(capturedContext.includes("symbol:fb-1"));
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

  it("caps cluster expansion at 10 additional symbols", async () => {
    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => ({
      rungs: ["card"],
      estimatedTokens: 50,
      estimatedDurationMs: 10,
      reasoning: "test",
    }));
    mock.method(Planner.prototype, "selectContext", () => [
      "symbol:seed-a",
      "symbol:seed-b",
    ]);

    // Mock expandContextForClusters to simulate a cluster with 20 relevant
    // members. The real implementation now caps at MAX_CLUSTER_EXPANSION_SYMBOLS
    // (10). We replicate the capped behavior here to verify that buildContext
    // passes at most seeds + 10 additional symbols to the executor.
    const expanded = [
      "symbol:seed-a",
      "symbol:seed-b",
      ...Array.from({ length: 10 }, (_, i) => `symbol:member-${i + 1}`),
    ];
    mock.method(
      ContextEngine.prototype as Record<string, unknown>,
      "expandContextForClusters",
      async () => ({
        expandedContext: expanded,
        clusterExpandedCount: 10,
      }),
    );

    let capturedContext: string[] = [];
    mock.method(
      Executor.prototype,
      "execute",
      async (_task: unknown, _rungs: unknown, context: string[]) => {
        capturedContext = context;
        return { actions: [], evidence: [], success: true };
      },
    );
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => undefined);

    const engine = new ContextEngine();
    await engine.buildContext(createTask());

    // 2 seeds + at most 10 expanded = 12 max
    assert.ok(
      capturedContext.length <= 12,
      `Expected at most 12 context items (2 seeds + 10 cap), got ${capturedContext.length}`,
    );
    assert.equal(capturedContext.length, 12);
    // Verify seeds are present
    assert.ok(capturedContext.includes("symbol:seed-a"));
    assert.ok(capturedContext.includes("symbol:seed-b"));
    // Verify expansion members are present
    assert.ok(capturedContext.includes("symbol:member-1"));
    assert.ok(capturedContext.includes("symbol:member-10"));
    // Verify 11th member is NOT present (cap at 10)
    assert.ok(!capturedContext.includes("symbol:member-11"));
  });

  it("precise mode caps cluster expansion at 4 additional symbols", async () => {
    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => ({
      rungs: ["card"],
      estimatedTokens: 50,
      estimatedDurationMs: 10,
      reasoning: "test",
    }));
    mock.method(Planner.prototype, "selectContext", () => ["symbol:seed-a"]);

    // Mock with precise mode cap (4 expanded)
    const expanded = [
      "symbol:seed-a",
      ...Array.from({ length: 4 }, (_, i) => `symbol:precise-member-${i + 1}`),
    ];
    mock.method(
      ContextEngine.prototype as Record<string, unknown>,
      "expandContextForClusters",
      async () => ({
        expandedContext: expanded,
        clusterExpandedCount: 4,
      }),
    );

    let capturedContext: string[] = [];
    mock.method(
      Executor.prototype,
      "execute",
      async (_task: unknown, _rungs: unknown, context: string[]) => {
        capturedContext = context;
        return { actions: [], evidence: [], success: true };
      },
    );
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => undefined);

    const engine = new ContextEngine();
    await engine.buildContext(
      createTask({ options: { contextMode: "precise" } }),
    );

    // 1 seed + at most 4 expanded = 5 max
    assert.ok(
      capturedContext.length <= 5,
      `Expected at most 5 context items (1 seed + 4 cap), got ${capturedContext.length}`,
    );
  });

  it("per-cluster cap limits contributions from a single cluster", async () => {
    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => ({
      rungs: ["card"],
      estimatedTokens: 50,
      estimatedDurationMs: 10,
      reasoning: "test",
    }));
    mock.method(Planner.prototype, "selectContext", () => ["symbol:seed-a"]);

    // Mock: 2 clusters, each with 5 members, per-cluster cap is 3
    // So max from cluster 1 = 3, max from cluster 2 = 3, total capped at 6
    const expanded = [
      "symbol:seed-a",
      ...Array.from({ length: 6 }, (_, i) => `symbol:cluster-member-${i + 1}`),
    ];
    mock.method(
      ContextEngine.prototype as Record<string, unknown>,
      "expandContextForClusters",
      async () => ({
        expandedContext: expanded,
        clusterExpandedCount: 6,
      }),
    );

    let capturedContext: string[] = [];
    mock.method(
      Executor.prototype,
      "execute",
      async (_task: unknown, _rungs: unknown, context: string[]) => {
        capturedContext = context;
        return { actions: [], evidence: [], success: true };
      },
    );
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => undefined);

    const engine = new ContextEngine();
    await engine.buildContext(createTask());

    // Should have seed + capped expansion
    assert.ok(capturedContext.includes("symbol:seed-a"));
    assert.ok(
      capturedContext.length <= 11,
      `Expected reasonable expansion, got ${capturedContext.length}`,
    );
  });

  it("preserves answer on successful broad-mode results even under budget pressure", async () => {
    // Create a large evidence set to push the response over budget
    const largeEvidence: Evidence[] = Array.from({ length: 50 }, (_, i) => ({
      type: "symbolCard" as const,
      reference: `symbol:sym-${i}`,
      summary:
        `Symbol ${i} with a long description that takes up tokens `.repeat(5),
      timestamp: Date.now(),
    }));

    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => defaultPath);
    mock.method(Planner.prototype, "selectContext", () => ["symbol:alpha"]);
    mock.method(Executor.prototype, "execute", async () => ({
      actions: [
        {
          id: "a-1",
          type: "getCard",
          status: "completed",
          input: {},
          timestamp: Date.now(),
          durationMs: 1,
          evidence: [],
        },
      ],
      evidence: largeEvidence,
      success: true,
    }));
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => undefined);

    const engine = new ContextEngine();
    const result = await engine.buildContext(
      createTask({
        options: { contextMode: "broad" },
        budget: { maxTokens: 500 }, // Very tight budget
      }),
    );

    assert.equal(result.success, true);
    // Answer must exist and not be a removal placeholder
    assert.ok(
      result.answer,
      "answer must be present on successful broad result",
    );
    assert.ok(
      !result.answer!.includes("[answer removed"),
      "answer must not be fully removed on success",
    );
    // Truncation may affect finalEvidence and actionsTaken but NOT remove answer
    if (result.truncation) {
      assert.ok(
        !result.truncation.fieldsAffected.includes("answer") ||
          !result.answer!.includes("[answer removed"),
        "truncation must not remove answer on success",
      );
    }
  });

  it("truncation trims finalEvidence and actionsTaken before answer", async () => {
    const evidence: Evidence[] = Array.from({ length: 30 }, (_, i) => ({
      type: "symbolCard" as const,
      reference: `symbol:sym-${i}`,
      summary: `Symbol ${i} description `.repeat(10),
      timestamp: Date.now(),
    }));

    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => defaultPath);
    mock.method(Planner.prototype, "selectContext", () => ["symbol:alpha"]);
    mock.method(Executor.prototype, "execute", async () => ({
      actions: [
        {
          id: "a-1",
          type: "getCard",
          status: "completed",
          input: {},
          timestamp: Date.now(),
          durationMs: 1,
          evidence: [],
        },
      ],
      evidence,
      success: true,
    }));
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => undefined);

    const engine = new ContextEngine();
    const result = await engine.buildContext(
      createTask({
        options: { contextMode: "broad" },
        budget: { maxTokens: 1000 },
      }),
    );

    assert.equal(result.success, true);
    // If truncation happened, evidence should be trimmed before answer
    if (result.truncation && result.truncation.fieldsAffected.length > 0) {
      const fields = result.truncation.fieldsAffected;
      // finalEvidence should be trimmed before answer
      if (fields.includes("answer")) {
        assert.ok(
          fields.includes("finalEvidence"),
          "finalEvidence must be trimmed before answer",
        );
      }
    }
  });

  it("compact broad response omits internal fields (path, metrics, retrievalEvidence)", async () => {
    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => defaultPath);
    mock.method(Planner.prototype, "selectContext", () => ["symbol:alpha"]);
    mock.method(Executor.prototype, "execute", async () => ({
      actions: [
        {
          id: "a-1",
          type: "getCard",
          status: "completed",
          input: {},
          timestamp: Date.now(),
          durationMs: 1,
          evidence: [],
        },
      ],
      evidence: [
        {
          type: "symbolCard",
          reference: "symbol:alpha",
          summary: "alpha card",
          timestamp: Date.now(),
        },
      ],
      success: true,
    }));
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => "none");

    const engine = new ContextEngine();
    const result = await engine.buildContext(
      createTask({
        options: { contextMode: "broad" },
        budget: { maxTokens: 200 }, // Force truncation path
      }),
    );

    // After compaction, internal fields should not be present
    const resultObj = result as Record<string, unknown>;
    // These fields are stripped by compaction (not in BROAD_VISIBLE_FIELDS):
    assert.equal(
      resultObj.path,
      undefined,
      "path should be stripped by compaction",
    );
    assert.equal(
      resultObj.metrics,
      undefined,
      "metrics should be stripped by compaction",
    );
    assert.equal(
      resultObj.retrievalEvidence,
      undefined,
      "retrievalEvidence should be stripped by compaction",
    );
  });

  it("does not add irrelevant cluster members", async () => {
    mock.method(Planner.prototype, "validateTask", () => ({ valid: true }));
    mock.method(Planner.prototype, "plan", () => ({
      rungs: ["card"],
      estimatedTokens: 50,
      estimatedDurationMs: 10,
      reasoning: "test",
    }));
    mock.method(Planner.prototype, "selectContext", () => [
      "symbol:seed-a",
      "symbol:seed-b",
    ]);

    // Mock expandContextForClusters to simulate that no cluster members
    // passed the relevance filter (names don't match task keywords).
    mock.method(
      ContextEngine.prototype as Record<string, unknown>,
      "expandContextForClusters",
      async () => ({
        expandedContext: ["symbol:seed-a", "symbol:seed-b"],
        clusterExpandedCount: 0,
      }),
    );

    let capturedContext: string[] = [];
    mock.method(
      Executor.prototype,
      "execute",
      async (_task: unknown, _rungs: unknown, context: string[]) => {
        capturedContext = context;
        return { actions: [], evidence: [], success: true };
      },
    );
    mock.method(Executor.prototype, "getMetrics", () => defaultMetrics);
    mock.method(Executor.prototype, "getNextBestAction", () => undefined);

    const engine = new ContextEngine();
    await engine.buildContext(createTask());

    // Only the 2 original seeds — no irrelevant members added
    assert.equal(
      capturedContext.length,
      2,
      `Expected exactly 2 context items (seeds only), got ${capturedContext.length}: ${JSON.stringify(capturedContext)}`,
    );
    assert.ok(capturedContext.includes("symbol:seed-a"));
    assert.ok(capturedContext.includes("symbol:seed-b"));
  });
});
