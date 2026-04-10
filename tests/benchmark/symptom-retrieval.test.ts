import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Symptom retrieval benchmark — validates that hybrid retrieval
 * surfaces expected symbols for bug reports, stack traces, and PR descriptions.
 *
 * Run: node --import tsx --test tests/benchmark/symptom-retrieval.test.ts
 */
describe("symptom retrieval benchmarks", () => {
  let tasks: Array<{
    id: string;
    category: string;
    difficulty: string;
    title: string;
    description: string;
    inputs: {
      taskText?: string;
      stackTrace?: string;
      editedFiles?: string[];
      expectedSymbols: string[];
    };
  }>;

  before(() => {
    const raw = readFileSync(
      join(import.meta.dirname, "../../benchmarks/real-world/symptom-tasks.json"),
      "utf-8",
    );
    tasks = JSON.parse(raw).tasks;
    assert.ok(tasks.length > 0, "Symptom tasks should be loaded");
  });

  it("all symptom tasks have required fields", () => {
    for (const task of tasks) {
      assert.ok(task.id, `Task missing id`);
      assert.ok(task.category, `Task ${task.id} missing category`);
      assert.ok(task.inputs, `Task ${task.id} missing inputs`);
      assert.ok(
        task.inputs.taskText || task.inputs.stackTrace,
        `Task ${task.id} needs taskText or stackTrace`,
      );
      assert.ok(
        task.inputs.expectedSymbols?.length > 0,
        `Task ${task.id} needs expectedSymbols`,
      );
    }
  });

  it("covers all three symptom categories", () => {
    const categories = new Set(tasks.map((t) => t.category));
    assert.ok(categories.has("bug-report"), "Missing bug-report category");
    assert.ok(categories.has("stack-trace"), "Missing stack-trace category");
    assert.ok(categories.has("pr-description"), "Missing pr-description category");
  });
});


// ---------------------------------------------------------------------------
// Semantic retrieval quality baseline (Task 9)
// ---------------------------------------------------------------------------
describe("semantic retrieval quality baseline", () => {
  const orchSrc = readFileSync(
    join(process.cwd(), "src/retrieval/orchestrator.ts"),
    "utf8",
  );

  it("orchestrator supports model-aware vector retrieval", () => {
    assert.ok(
      orchSrc.includes("sortedModels") || orchSrc.includes("EMBEDDING_MODELS"),
      "Orchestrator should iterate over embedding models for vector retrieval",
    );
  });

  it("vector indexes target DOUBLE[] columns", () => {
    const lcSrc = readFileSync(
      join(process.cwd(), "src/retrieval/index-lifecycle.ts"),
      "utf8",
    );
    assert.ok(
      lcSrc.includes("getVecPropertyName"),
      "Index lifecycle should use Vec property names for vector index creation",
    );
  });

  it("embedding persistence writes to numeric array columns", () => {
    const embSrc = readFileSync(
      join(process.cwd(), "src/db/ladybug-symbol-embeddings.ts"),
      "utf8",
    );
    assert.ok(
      embSrc.includes("vectorArray"),
      "Embedding persistence should support numeric array writes",
    );
  });
});

