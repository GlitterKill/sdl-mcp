import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for the CLI progress renderer in `src/cli/commands/index.ts`.
 *
 * Covers:
 *   - `shortModelLabel` — abbreviates model names for the multi-model
 *     embedding line.
 *   - `renderIndexProgress` per-model embedding accumulation, stage
 *     transitions, and the pass-1 drain bar substage path.
 *
 * Renders are captured by replacing `process.stdout.write` with a buffer.
 * `isTty()` defaults to false outside a TTY so we exercise the non-TTY
 * code path; TTY-specific cursor-positioning behaviour is out of scope
 * for unit tests.
 */

// Capture writes to stdout so renderIndexProgress output is observable.
let captured: string[] = [];
const origWrite = process.stdout.write.bind(process.stdout);
const origLog = console.log;

beforeEach(() => {
  captured = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string | Uint8Array): boolean => {
    captured.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  };
  console.log = (...args: unknown[]): void => {
    captured.push(args.map(String).join(" ") + "\n");
  };
});

function restoreStdout(): void {
  process.stdout.write = origWrite;
  console.log = origLog;
}

describe("shortModelLabel", () => {
  it("abbreviates jina to first segment", async () => {
    const { shortModelLabel } =
      await import("../../dist/cli/commands/index.js");
    assert.strictEqual(shortModelLabel("jina-embeddings-v2-base-code"), "jina");
  });

  it("abbreviates nomic to first segment", async () => {
    const { shortModelLabel } =
      await import("../../dist/cli/commands/index.js");
    assert.strictEqual(shortModelLabel("nomic-embed-text-v1.5"), "nomic");
  });

  it("preserves single-token model names", async () => {
    const { shortModelLabel } =
      await import("../../dist/cli/commands/index.js");
    assert.strictEqual(shortModelLabel("bge"), "bge");
  });

  it("lower-cases mixed-case input", async () => {
    const { shortModelLabel } =
      await import("../../dist/cli/commands/index.js");
    assert.strictEqual(shortModelLabel("Jina-Embeddings"), "jina");
  });
});

describe("renderIndexProgress — embeddings stage", () => {
  it("populates per-model map for each event", async () => {
    const { createProgressState, renderIndexProgress } =
      await import("../../dist/cli/commands/index.js");
    try {
      const state = createProgressState();
      renderIndexProgress(state, {
        stage: "embeddings",
        current: 100,
        total: 1000,
        model: "jina-embeddings-v2-base-code",
      });
      assert.strictEqual(state.embeddingsByModel.size, 1);
      renderIndexProgress(state, {
        stage: "embeddings",
        current: 200,
        total: 1000,
        model: "nomic-embed-text-v1.5",
      });
      assert.strictEqual(
        state.embeddingsByModel.size,
        2,
        "second model should be registered in the per-model map",
      );
      const jina = state.embeddingsByModel.get("jina-embeddings-v2-base-code");
      const nomic = state.embeddingsByModel.get("nomic-embed-text-v1.5");
      assert.deepStrictEqual(jina, { current: 100, total: 1000 });
      assert.deepStrictEqual(nomic, { current: 200, total: 1000 });
    } finally {
      restoreStdout();
    }
  });

  it("renders a combined line containing both model segments", async () => {
    const { createProgressState, renderIndexProgress } =
      await import("../../dist/cli/commands/index.js");
    try {
      const state = createProgressState();
      // Pre-populate one model so the rendered event can trigger output
      // without crossing the non-TTY 10% throttle. Then a single render
      // call produces the combined line we want to inspect.
      state.embeddingsByModel.set("jina-embeddings-v2-base-code", {
        current: 50,
        total: 100,
      });
      renderIndexProgress(state, {
        stage: "embeddings",
        current: 50,
        total: 100,
        model: "nomic-embed-text-v1.5",
      });
      const output = captured.join("");
      assert.ok(
        output.includes("jina"),
        `combined line should mention jina: ${output}`,
      );
      assert.ok(
        output.includes("nomic"),
        `combined line should mention nomic: ${output}`,
      );
      assert.ok(
        /jina[\s\S]+nomic|nomic[\s\S]+jina/.test(output),
        "both model segments should appear in one rendered line",
      );
    } finally {
      restoreStdout();
    }
  });

  it("labels summary and symbol embedding phases separately", async () => {
    const { createProgressState, renderIndexProgress } =
      await import("../../dist/cli/commands/index.js");
    try {
      const state = createProgressState();
      renderIndexProgress(state, {
        stage: "embeddings",
        substage: "fileSummaryEmbeddings",
        current: 100,
        total: 100,
        model: "jina-embeddings-v2-base-code",
      });
      const summaryOutput = captured.join("");
      assert.ok(
        summaryOutput.includes("Summary Embeddings:"),
        `FileSummary phase should use summary label: ${summaryOutput}`,
      );

      captured = [];
      renderIndexProgress(state, {
        stage: "embeddings",
        current: 200,
        total: 200,
        model: "nomic-embed-text-v1.5",
      });
      const symbolOutput = captured.join("");
      assert.ok(
        symbolOutput.includes("Symbol Embeddings:"),
        `symbol phase should use symbol label: ${symbolOutput}`,
      );
      assert.equal(
        state.embeddingsByModel.has("jina-embeddings-v2-base-code"),
        false,
        "transition from summary to symbol embeddings should not keep stale model columns",
      );
    } finally {
      restoreStdout();
    }
  });

  it("clears per-model state on transition away from embeddings", async () => {
    const { createProgressState, renderIndexProgress } =
      await import("../../dist/cli/commands/index.js");
    try {
      const state = createProgressState();
      renderIndexProgress(state, {
        stage: "embeddings",
        current: 100,
        total: 1000,
        model: "jina-embeddings-v2-base-code",
      });
      assert.strictEqual(
        state.embeddingsByModel.size,
        1,
        "embeddings stage must populate per-model map",
      );
      renderIndexProgress(state, {
        stage: "pass2",
        current: 50,
        total: 100,
      });
      assert.strictEqual(
        state.embeddingsByModel.size,
        0,
        "transition away from embeddings must clear the per-model map",
      );
    } finally {
      restoreStdout();
    }
  });

  it("renders a single model under 'default' key when model field is absent", async () => {
    const { createProgressState, renderIndexProgress } =
      await import("../../dist/cli/commands/index.js");
    try {
      const state = createProgressState();
      renderIndexProgress(state, {
        stage: "embeddings",
        current: 50,
        total: 200,
      });
      assert.strictEqual(state.embeddingsByModel.size, 1);
      assert.ok(
        state.embeddingsByModel.has("default"),
        "missing model field must map to 'default' key",
      );
    } finally {
      restoreStdout();
    }
  });
});

describe("renderIndexProgress — pass-1 drain substage", () => {
  it("renders a progress bar with stageCurrent/stageTotal", async () => {
    const { createProgressState, renderIndexProgress } =
      await import("../../dist/cli/commands/index.js");
    try {
      const state = createProgressState();
      renderIndexProgress(state, {
        stage: "finalizing",
        current: 0,
        total: 0,
        substage: "pass1Drain",
        stageCurrent: 3,
        stageTotal: 10,
      });
      const output = captured.join("");
      assert.ok(
        output.includes("Flushing pass 1 writes"),
        `output should label the drain substage: ${output}`,
      );
      assert.ok(
        output.includes("30%"),
        `output should compute 3/10 = 30%: ${output}`,
      );
      assert.ok(
        output.includes("(3/10)"),
        `output should include the raw counter: ${output}`,
      );
    } finally {
      restoreStdout();
    }
  });

  it("falls back to message form when stageTotal is 0", async () => {
    const { createProgressState, renderIndexProgress } =
      await import("../../dist/cli/commands/index.js");
    try {
      const state = createProgressState();
      renderIndexProgress(state, {
        stage: "finalizing",
        current: 0,
        total: 0,
        substage: "pass1Drain",
        message: "preparing",
      });
      const output = captured.join("");
      assert.ok(
        output.includes("preparing"),
        "should surface the message when no stage counter is set",
      );
    } finally {
      restoreStdout();
    }
  });
});

describe("renderIndexProgress — known stages have user-facing labels", () => {
  it("scanning, parsing, pass1, scipIngest, pass2 each render", async () => {
    const { createProgressState, renderIndexProgress } =
      await import("../../dist/cli/commands/index.js");
    try {
      const stages = [
        "scanning",
        "parsing",
        "pass1",
        "scipIngest",
        "pass2",
      ] as const;
      for (const stage of stages) {
        captured = [];
        const state = createProgressState();
        renderIndexProgress(state, {
          stage,
          current: 1,
          total: 10,
        });
        const output = captured.join("");
        assert.ok(
          output.length > 0,
          `${stage} must produce some rendered output`,
        );
      }
    } finally {
      restoreStdout();
    }
  });
});

// Silence unused warning for `mock` import; kept for future tests that need
// explicit ORT/DB mocks.
void mock;
