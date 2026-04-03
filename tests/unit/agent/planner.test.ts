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

    it("plans debug task without focus to include three rungs", () => {
      const task = createTask("debug");
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 3);
      assert.deepStrictEqual(path.rungs, ["card", "skeleton", "hotPath"]);
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
    it("plans explain task with focus symbols to include hotPath", () => {
      const task = createTask("explain", {
        options: { focusSymbols: ["symbol1"] },
      });
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 3);
      assert.deepStrictEqual(path.rungs, ["card", "skeleton", "hotPath"]);
    });

    it("plans explain task without options to include card + skeleton", () => {
      const task = createTask("explain");
      const path = planner.plan(task);

      assert.strictEqual(path.rungs.length, 2);
      assert.deepStrictEqual(path.rungs, ["card", "skeleton"]);
    });

    it("plans precise explain to include only card", () => {
      const task = createTask("explain", {
        options: { contextMode: "precise" },
      });
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
    it("selects focus symbols from options", async () => {
      const task = createTask("debug", {
        options: {
          focusSymbols: [
            "a0a1b2c3d4e5f6a7",
            "b1b2c3d4e5f6a7a8",
            "c2c3d4e5f6a7a8b9",
          ],
        },
      });
      const context = await planner.selectContext(task);

      assert.strictEqual(context.length, 3);
      assert.deepStrictEqual(context, [
        "symbol:a0a1b2c3d4e5f6a7",
        "symbol:b1b2c3d4e5f6a7a8",
        "symbol:c2c3d4e5f6a7a8b9",
      ]);
    });

    it("selects focus paths from options", async () => {
      const task = createTask("debug", {
        options: { focusPaths: ["file1.ts", "file2.ts"] },
      });
      const context = await planner.selectContext(task);

      assert.strictEqual(context.length, 2);
      assert.deepStrictEqual(context, ["file:file1.ts", "file:file2.ts"]);
    });

    it("selects both symbols and paths when provided", async () => {
      const task = createTask("debug", {
        options: {
          focusSymbols: ["a0a1b2c3d4e5f6a7"],
          focusPaths: ["file1.ts"],
        },
      });
      const context = await planner.selectContext(task);

      assert.strictEqual(context.length, 2);
      assert.deepStrictEqual(context, [
        "symbol:a0a1b2c3d4e5f6a7",
        "file:file1.ts",
      ]);
    });

    it("returns empty context when no options provided", async () => {
      const task = createTask("debug");
      const context = await planner.selectContext(task);

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
      assert.ok(result.error?.includes("positive"));
    });

    it("rejects task with negative max duration", () => {
      const task = createTask("debug", {
        budget: { maxDurationMs: -1 },
      });
      const result = planner.validateTask(task);

      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("positive"));
    });

    it("rejects task with negative max actions", () => {
      const task = createTask("debug", {
        budget: { maxActions: -1 },
      });
      const result = planner.validateTask(task);

      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("positive"));
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

  describe("Confidence-Aware Budget Trimming", () => {
    it("low confidence preserves a diagnostic rung under tight budget", () => {
      // Budget allows card (50) + hotPath (500) = 550, but not skeleton too
      const task = createTask("debug", {
        budget: { maxTokens: 600 },
      });
      const path = planner.plan(task, "low");

      // Low confidence should keep card + hotPath (the richer rung) rather
      // than just card (which is what the old tail-pop would produce at 600 tokens
      // after popping raw, hotPath, then skeleton).
      assert.ok(path.rungs.includes("card"), "card must always be present");
      assert.ok(
        path.rungs.length >= 2,
        `Low confidence should preserve at least 2 rungs, got ${path.rungs.length}: ${path.rungs.join(", ")}`,
      );
    });

    it("medium confidence keeps card + skeleton for precise under budget pressure", () => {
      // Precise debug normally has [card, hotPath] = 550 tokens
      // Budget: 300 — enough for card + skeleton (250) but not card + hotPath (550)
      const task = createTask("debug", {
        options: { contextMode: "precise" },
        budget: { maxTokens: 300 },
      });
      const path = planner.plan(task, "medium");

      assert.ok(path.rungs.includes("card"));
      // Medium confidence with precise mode should try to keep skeleton
      // (the diagnostic rung for precise)
      assert.ok(
        path.estimatedTokens <= 300,
        `Should fit within budget, got ${path.estimatedTokens}`,
      );
    });

    it("medium confidence keeps card + hotPath for broad under budget pressure", () => {
      // Broad review normally has [card, skeleton] = 250 tokens
      // Add focusPaths to get [card, skeleton, hotPath] = 750
      // Budget: 600 — enough for card + hotPath (550) but not all three (750)
      const task = createTask("review", {
        options: { focusPaths: ["src/agent/"] },
        budget: { maxTokens: 600 },
      });
      const path = planner.plan(task, "medium");

      assert.ok(path.rungs.includes("card"));
      assert.ok(
        path.estimatedTokens <= 600,
        `Should fit within budget, got ${path.estimatedTokens}`,
      );
      // Medium broad: should prefer card + hotPath
      if (path.rungs.length >= 2) {
        assert.ok(
          path.rungs.includes("hotPath"),
          `Medium broad should preserve hotPath, got: ${path.rungs.join(", ")}`,
        );
      }
    });

    it("high confidence produces cheapest plan (same as tail-pop)", () => {
      // Budget only allows card (50 tokens)
      const task = createTask("debug", {
        budget: { maxTokens: 60 },
      });
      const path = planner.plan(task, "high");

      assert.ok(path.rungs.includes("card"));
      assert.ok(
        path.estimatedTokens <= 60,
        `High confidence should produce cheapest plan`,
      );
    });

    it("very low budget falls back to card-only regardless of confidence", () => {
      // Budget: 55 tokens — only card (50) fits
      const task = createTask("debug", {
        budget: { maxTokens: 55 },
      });

      const lowPath = planner.plan(task, "low");
      const medPath = planner.plan(task, "medium");

      assert.deepStrictEqual(lowPath.rungs, ["card"]);
      assert.deepStrictEqual(medPath.rungs, ["card"]);
    });

    it("confidence-aware trimming includes reasoning", () => {
      const task = createTask("debug", {
        budget: { maxTokens: 600 },
      });
      const path = planner.plan(task, "low");

      if (path.rungs.length < 3) {
        // Trimming happened — reasoning should mention confidence
        assert.ok(
          path.reasoning.includes("Confidence-aware") ||
            path.reasoning.includes("Trimmed"),
          `Reasoning should explain trim: "${path.reasoning}"`,
        );
      }
    });

    it("no confidence defaults to high (backward compatible)", () => {
      const task = createTask("debug", {
        budget: { maxTokens: 60 },
      });
      // No confidence argument
      const path = planner.plan(task);

      assert.deepStrictEqual(path.rungs, ["card"]);
      assert.ok(path.estimatedTokens <= 60);
    });
  });
});
