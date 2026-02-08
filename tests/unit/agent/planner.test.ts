import assert from "node:assert";
import { describe, it } from "node:test";
import { Planner } from "../../../dist/agent/planner.js";
import type { AgentTask } from "../../../dist/agent/types.js";

describe("Agent Planner", () => {
  const planner = new Planner();

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

  describe("Debug Task Planning", () => {
    it("plans debug task with diagnostics to include all rungs", () => {
      const task = createTask("debug", {
        options: { requireDiagnostics: true },
      });
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 4);
      assert.deepStrictEqual(path.rungs, [
        "card",
        "skeleton",
        "hotPath",
        "raw",
      ]);
      assert.ok(path.estimatedTokens > 0);
      assert.ok(path.estimatedDurationMs > 0);
    });

    it("plans debug task with focus symbols to include three rungs", () => {
      const task = createTask("debug", {
        options: { focusSymbols: ["symbol1", "symbol2"] },
      });
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 3);
      assert.deepStrictEqual(path.rungs, ["card", "skeleton", "hotPath"]);
    });

    it("plans debug task without focus to include two rungs", () => {
      const task = createTask("debug");
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 2);
      assert.deepStrictEqual(path.rungs, ["card", "skeleton"]);
    });
  });

  describe("Review Task Planning", () => {
    it("plans review task with focus symbols to include three rungs", () => {
      const task = createTask("review", {
        options: { focusSymbols: ["symbol1"] },
      });
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 3);
      assert.deepStrictEqual(path.rungs, ["card", "skeleton", "hotPath"]);
    });

    it("plans review task with tests to include hot path", () => {
      const task = createTask("review", {
        options: { includeTests: true },
      });
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 3);
      assert.deepStrictEqual(path.rungs, ["card", "skeleton", "hotPath"]);
    });

    it("plans review task without options to include two rungs", () => {
      const task = createTask("review");
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 2);
      assert.deepStrictEqual(path.rungs, ["card", "skeleton"]);
    });
  });

  describe("Implement Task Planning", () => {
    it("plans implement task with focus paths to include hot path", () => {
      const task = createTask("implement", {
        options: { focusPaths: ["file1.ts", "file2.ts"] },
      });
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 3);
      assert.deepStrictEqual(path.rungs, ["card", "skeleton", "hotPath"]);
    });

    it("plans implement task without options to include two rungs", () => {
      const task = createTask("implement");
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 2);
      assert.deepStrictEqual(path.rungs, ["card", "skeleton"]);
    });
  });

  describe("Explain Task Planning", () => {
    it("plans explain task with focus symbols to include skeleton", () => {
      const task = createTask("explain", {
        options: { focusSymbols: ["symbol1"] },
      });
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 2);
      assert.deepStrictEqual(path.rungs, ["card", "skeleton"]);
    });

    it("plans explain task without options to include only card", () => {
      const task = createTask("explain");
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 1);
      assert.deepStrictEqual(path.rungs, ["card"]);
    });
  });

  describe("Budget Constraints", () => {
    it("reduces rungs when token budget is exceeded", () => {
      const task = createTask("debug", {
        options: { requireDiagnostics: true },
        budget: { maxTokens: 100 },
      });
      const path = planner.plan(task);

      assert.ok(path.estimatedTokens <= 100);
      assert.ok(path.rungs.length < 4);
      assert.ok(path.reasoning.includes("token budget"));
    });

    it("reduces rungs when duration budget is exceeded", () => {
      const task = createTask("debug", {
        options: { requireDiagnostics: true },
        budget: { maxDurationMs: 200 },
      });
      const path = planner.plan(task);

      assert.ok(path.estimatedDurationMs <= 200);
      assert.ok(path.rungs.length < 4);
      assert.ok(path.reasoning.includes("duration budget"));
    });

    it("keeps minimum one rung when budget is very low", () => {
      const task = createTask("debug", {
        options: { requireDiagnostics: true },
        budget: { maxTokens: 10 },
      });
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 1);
    });
  });

  describe("Context Selection", () => {
    it("selects focus symbols from options", () => {
      const task = createTask("debug", {
        options: { focusSymbols: ["symbol1", "symbol2", "symbol3"] },
      });
      const context = planner.selectContext(task);

      assert.strictEqual(context.length, 3);
      assert.deepStrictEqual(context, ["symbol1", "symbol2", "symbol3"]);
    });

    it("selects focus paths from options", () => {
      const task = createTask("debug", {
        options: { focusPaths: ["file1.ts", "file2.ts"] },
      });
      const context = planner.selectContext(task);

      assert.strictEqual(context.length, 2);
      assert.deepStrictEqual(context, ["file1.ts", "file2.ts"]);
    });

    it("selects both symbols and paths when provided", () => {
      const task = createTask("debug", {
        options: {
          focusSymbols: ["symbol1"],
          focusPaths: ["file1.ts"],
        },
      });
      const context = planner.selectContext(task);

      assert.strictEqual(context.length, 2);
      assert.deepStrictEqual(context, ["symbol1", "file1.ts"]);
    });

    it("returns empty context when no options provided", () => {
      const task = createTask("debug");
      const context = planner.selectContext(task);

      assert.strictEqual(context.length, 0);
    });
  });

  describe("Task Validation", () => {
    it("validates task with all required fields", () => {
      const task = createTask("debug");
      const result = planner.validateTask(task);

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.error, undefined);
    });

    it("rejects task with empty task text", () => {
      const task = createTask("debug", { taskText: "" });
      const result = planner.validateTask(task);

      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("empty"));
    });

    it("rejects task with empty repo id", () => {
      const task = createTask("debug", { repoId: "" });
      const result = planner.validateTask(task);

      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("empty"));
    });

    it("rejects task with negative max tokens", () => {
      const task = createTask("debug", {
        budget: { maxTokens: -1 },
      });
      const result = planner.validateTask(task);

      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("negative"));
    });

    it("rejects task with negative max duration", () => {
      const task = createTask("debug", {
        budget: { maxDurationMs: -1 },
      });
      const result = planner.validateTask(task);

      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("negative"));
    });

    it("rejects task with negative max actions", () => {
      const task = createTask("debug", {
        budget: { maxActions: -1 },
      });
      const result = planner.validateTask(task);

      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("negative"));
    });

    it("validates task with valid budget constraints", () => {
      const task = createTask("debug", {
        budget: {
          maxTokens: 1000,
          maxDurationMs: 5000,
          maxActions: 10,
        },
      });
      const result = planner.validateTask(task);

      assert.strictEqual(result.valid, true);
    });
  });

  describe("Path Estimation", () => {
    it("estimates tokens correctly for different rungs", () => {
      const task = createTask("debug");
      const path = planner.plan(task);

      assert.ok(path.estimatedTokens > 0);
      const expectedTokens = path.rungs.reduce((sum, rung) => {
        const estimates: Record<string, number> = {
          card: 50,
          skeleton: 200,
          hotPath: 500,
          raw: 2000,
        };
        return sum + (estimates[rung] ?? 0);
      }, 0);
      assert.strictEqual(path.estimatedTokens, expectedTokens);
    });

    it("estimates duration correctly for different rungs", () => {
      const task = createTask("debug");
      const path = planner.plan(task);

      assert.ok(path.estimatedDurationMs > 0);
      const expectedDuration = path.rungs.reduce((sum, rung) => {
        const estimates: Record<string, number> = {
          card: 10,
          skeleton: 50,
          hotPath: 100,
          raw: 500,
        };
        return sum + (estimates[rung] ?? 0);
      }, 0);
      assert.strictEqual(path.estimatedDurationMs, expectedDuration);
    });

    it("includes reasoning in path", () => {
      const task = createTask("debug");
      const path = planner.plan(task);

      assert.ok(path.reasoning.length > 0);
      assert.ok(path.reasoning.toLowerCase().includes("debug"));
    });
  });
});
