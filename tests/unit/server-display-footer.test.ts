import { describe, it } from "node:test";
import assert from "node:assert";
import { attachDisplayFooter } from "../../dist/server.js";

describe("attachDisplayFooter", () => {
  it("adds _displayFooter to object payloads", () => {
    const input = { ok: true };
    const output = attachDisplayFooter(input, "footer text") as Record<
      string,
      unknown
    >;

    assert.strictEqual(output.ok, true);
    assert.strictEqual(output._displayFooter, "footer text");
    assert.ok(
      !("_displayFooter" in input),
      "should not mutate original object",
    );
  });

  it("merges with existing _displayFooter", () => {
    const input = { ok: true, _displayFooter: "existing" };
    const output = attachDisplayFooter(input, "new") as Record<string, unknown>;

    assert.strictEqual(output._displayFooter, "existing\n\nnew");
  });

  it("returns non-object payloads unchanged", () => {
    assert.strictEqual(attachDisplayFooter("x", "footer"), "x");
    assert.strictEqual(attachDisplayFooter(42, "footer"), 42);
    assert.strictEqual(attachDisplayFooter(null, "footer"), null);
  });

  it("returns arrays unchanged", () => {
    const arr = [1, 2, 3];
    const output = attachDisplayFooter(arr, "footer");
    assert.strictEqual(output, arr);
  });

  it("works correctly with projected broad context results", () => {
    // Simulates what server.ts does: project then attach footer
    const projected = {
      taskId: "task-1",
      taskType: "explain",
      success: true,
      summary: "done",
      answer: "results",
      finalEvidence: [],
    };
    const output = attachDisplayFooter(
      projected,
      "📊 1k / 5k tokens",
    ) as Record<string, unknown>;

    assert.strictEqual(output.taskId, "task-1");
    assert.strictEqual(output._displayFooter, "📊 1k / 5k tokens");
    // Ensure no actionsTaken, path, metrics leaked back
    assert.strictEqual(output.actionsTaken, undefined);
    assert.strictEqual(output.path, undefined);
    assert.strictEqual(output.metrics, undefined);
  });
});
