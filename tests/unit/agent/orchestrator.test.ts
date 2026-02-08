import assert from "node:assert";
import { describe, it } from "node:test";
import { Orchestrator } from "../../../dist/agent/orchestrator.js";
import type { AgentTask } from "../../../dist/agent/types.js";

describe("Orchestrator", () => {
  const orchestrator = new Orchestrator();

  function createTask(
    taskType: AgentTask["taskType"],
    overrides: Partial<AgentTask> = {},
  ): AgentTask {
    return {
      taskType,
      taskText: "Test task",
      repoId: "test-repo",
      ...overrides,
    };
  }

  describe("Task Orchestration", () => {
    it("orchestrates debug task successfully", async () => {
      const task = createTask("debug");
      const result = await orchestrator.orchestrate(task);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.taskType, "debug");
      assert.strictEqual(result.error, undefined);
      assert.ok(result.taskId.length > 0);
    });

    it("orchestrates review task successfully", async () => {
      const task = createTask("review");
      const result = await orchestrator.orchestrate(task);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.taskType, "review");
    });

    it("orchestrates implement task successfully", async () => {
      const task = createTask("implement");
      const result = await orchestrator.orchestrate(task);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.taskType, "implement");
    });

    it("orchestrates explain task successfully", async () => {
      const task = createTask("explain");
      const result = await orchestrator.orchestrate(task);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.taskType, "explain");
    });

    it("returns error for invalid task", async () => {
      const task = createTask("debug", { taskText: "" });
      const result = await orchestrator.orchestrate(task);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.length > 0);
      assert.strictEqual(result.actionsTaken.length, 0);
    });
  });

  describe("Result Structure", () => {
    it("includes taskId in result", async () => {
      const task = createTask("debug");
      const result = await orchestrator.orchestrate(task);

      assert.ok(typeof result.taskId === "string");
      assert.ok(result.taskId.length > 0);
      assert.ok(result.taskId.startsWith("task-"));
    });

    it("includes actionsTaken array", async () => {
      const task = createTask("debug");
      const result = await orchestrator.orchestrate(task);

      assert.ok(Array.isArray(result.actionsTaken));
    });

    it("includes path with rungs", async () => {
      const task = createTask("debug");
      const result = await orchestrator.orchestrate(task);

      assert.ok(result.path);
      assert.ok(Array.isArray(result.path.rungs));
      assert.ok(result.path.rungs.length > 0);
    });

    it("includes finalEvidence array", async () => {
      const task = createTask("debug");
      const result = await orchestrator.orchestrate(task);

      assert.ok(Array.isArray(result.finalEvidence));
    });

    it("includes summary", async () => {
      const task = createTask("debug");
      const result = await orchestrator.orchestrate(task);

      assert.ok(typeof result.summary === "string");
      assert.ok(result.summary.length > 0);
    });

    it("includes metrics", async () => {
      const task = createTask("debug");
      const result = await orchestrator.orchestrate(task);

      assert.ok(result.metrics);
      assert.strictEqual(typeof result.metrics.totalDurationMs, "number");
      assert.strictEqual(typeof result.metrics.totalTokens, "number");
      assert.strictEqual(typeof result.metrics.totalActions, "number");
      assert.strictEqual(typeof result.metrics.successfulActions, "number");
      assert.strictEqual(typeof result.metrics.failedActions, "number");
    });
  });

  describe("Task Planning", () => {
    it("plans task with valid path", async () => {
      const task = createTask("debug");
      const plan = await orchestrator.plan(task);

      assert.ok(plan.task);
      assert.ok(plan.path);
      assert.ok(Array.isArray(plan.path.rungs));
      assert.ok(plan.path.rungs.length > 0);
    });

    it("throws error for invalid task", async () => {
      const task = createTask("debug", { taskText: "" });

      await assert.rejects(
        async () => await orchestrator.plan(task),
        /Task validation failed/,
      );
    });
  });

  describe("Path Selection", () => {
    it("selects minimal rungs for explain task", async () => {
      const task = createTask("explain");
      const result = await orchestrator.orchestrate(task);

      assert.ok(result.path.rungs.length <= 2);
      assert.strictEqual(result.path.rungs[0], "card");
    });

    it("selects more rungs for debug task with diagnostics", async () => {
      const task = createTask("debug", {
        options: { requireDiagnostics: true },
      });
      const result = await orchestrator.orchestrate(task);

      assert.ok(result.path.rungs.length >= 2);
    });
  });

  describe("Budget Respect", () => {
    it("respects token budget", async () => {
      const task = createTask("debug", {
        budget: { maxTokens: 100 },
      });
      const result = await orchestrator.orchestrate(task);

      assert.ok(result.path.estimatedTokens <= 100);
    });

    it("respects duration budget", async () => {
      const task = createTask("debug", {
        budget: { maxDurationMs: 200 },
      });
      const result = await orchestrator.orchestrate(task);

      assert.ok(result.path.estimatedDurationMs <= 200);
    });
  });

  describe("Evidence Collection", () => {
    it("collects evidence during orchestration", async () => {
      const task = createTask("debug");
      const result = await orchestrator.orchestrate(task);

      assert.ok(Array.isArray(result.finalEvidence));
    });

    it("evidence is empty on error", async () => {
      const task = createTask("debug", { taskText: "" });
      const result = await orchestrator.orchestrate(task);

      assert.strictEqual(result.finalEvidence.length, 0);
    });
  });

  describe("Error Handling", () => {
    it("handles missing repoId", async () => {
      const task = createTask("debug", { repoId: "" });
      const result = await orchestrator.orchestrate(task);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("empty"));
    });

    it("handles missing taskText", async () => {
      const task = createTask("debug", { taskText: "" });
      const result = await orchestrator.orchestrate(task);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("empty"));
    });
  });

  describe("Summary Generation", () => {
    it("includes task type in summary", async () => {
      const task = createTask("debug");
      const result = await orchestrator.orchestrate(task);

      assert.ok(result.summary.toLowerCase().includes("debug"));
    });

    it("includes success status in summary", async () => {
      const task = createTask("debug");
      const result = await orchestrator.orchestrate(task);

      assert.ok(result.summary.toLowerCase().includes("completed"));
    });

    it("includes action count in summary", async () => {
      const task = createTask("debug");
      const result = await orchestrator.orchestrate(task);

      assert.ok(/\d+ action/.test(result.summary));
    });
  });

  describe("Determinism", () => {
    it("produces consistent results for same task", async () => {
      const task = createTask("debug");
      const result1 = await orchestrator.orchestrate(task);
      const result2 = await orchestrator.orchestrate(task);

      assert.strictEqual(result1.taskType, result2.taskType);
      assert.strictEqual(result1.path.rungs.length, result2.path.rungs.length);
    });
  });
});
