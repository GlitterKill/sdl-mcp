import { describe, it } from "node:test";
import assert from "node:assert";
import { parseWorkflowRequest } from "../../dist/code-mode/workflow-parser.js";

describe("code-mode workflow parser", () => {
  it("valid single-step chain parses successfully", () => {
    const result = parseWorkflowRequest({
      repoId: "test",
      steps: [{ fn: "symbolSearch", args: { query: "foo" } }],
    });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.request.steps[0].action, "symbol.search");
      assert.strictEqual(result.request.steps[0].fn, "symbolSearch");
    }
  });

  it("valid multi-step chain with $N refs parses", () => {
    const result = parseWorkflowRequest({
      repoId: "test",
      steps: [
        { fn: "symbolSearch", args: { query: "foo" } },
        { fn: "symbolGetCard", args: { symbolId: "$0.symbols[0].symbolId" } },
      ],
    });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.request.steps.length, 2);
    }
  });

  it("unknown function name rejected with clear error", () => {
    const result = parseWorkflowRequest({
      repoId: "test",
      steps: [{ fn: "unknownFn", args: {} }],
    });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors[0].includes("Unknown function 'unknownFn'"));
      assert.ok(result.errors[0].includes("Available:"));
    }
  });

  it("forward $N reference rejected", () => {
    const result = parseWorkflowRequest({
      repoId: "test",
      steps: [
        { fn: "symbolSearch", args: { query: "$1.foo" } },
        { fn: "symbolSearch", args: { query: "bar" } },
      ],
    });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes("Step 0 references $1")));
    }
  });

  it("self-reference rejected (step 0 referencing $0)", () => {
    const result = parseWorkflowRequest({
      repoId: "test",
      steps: [{ fn: "symbolSearch", args: { query: "$0.foo" } }],
    });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes("Step 0 references $0")));
    }
  });

  it("missing repoId rejected", () => {
    const result = parseWorkflowRequest({
      steps: [{ fn: "symbolSearch", args: {} }],
    });
    assert.strictEqual(result.ok, false);
  });

  it("empty steps array rejected", () => {
    const result = parseWorkflowRequest({ repoId: "test", steps: [] });
    assert.strictEqual(result.ok, false);
  });

  it("ParsedWorkflowStep contains correct action name mapping", () => {
    const result = parseWorkflowRequest({
      repoId: "test",
      steps: [{ fn: "codeSkeleton", args: { file: "test.ts" } }],
    });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.request.steps[0].action, "code.getSkeleton");
    }
  });

  it("args with no $N refs pass through unchanged", () => {
    const result = parseWorkflowRequest({
      repoId: "test",
      steps: [{ fn: "symbolSearch", args: { query: "hello", limit: 10 } }],
    });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.request.steps[0].args, {
        query: "hello",
        limit: 10,
      });
    }
  });

  it("onError defaults to 'continue'", () => {
    const result = parseWorkflowRequest({
      repoId: "test",
      steps: [{ fn: "repoStatus", args: {} }],
    });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.request.onError, "continue");
    }
  });
});
