import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Executor } from "../../../src/agent/executor.js";
import type { AgentTask } from "../../../src/agent/types.js";
import { PolicyEngine } from "../../../src/policy/engine.js";
import {
  DEFAULT_MAX_WINDOW_LINES,
  DEFAULT_MAX_WINDOW_TOKENS,
} from "../../../src/config/constants.js";

describe("executor raw rung", () => {
  it("captures bounded code-window evidence instead of claiming raw access", async () => {
    const executor = new Executor(
      new PolicyEngine({ defaultDenyRaw: false }),
    );
    const task: AgentTask = {
      taskType: "review",
      taskText: "Inspect raw context",
      repoId: "test-repo",
    };

    const result = await executor.execute(task, ["raw"], ["symbol:symbol-1"]);
    const action = result.actions[0];

    assert.equal(action.status, "completed");
    assert.deepEqual(action.output, {
      message: "Raw code window request approved",
      identifiersToFind: ["symbol-1"],
      maxWindowLines: DEFAULT_MAX_WINDOW_LINES,
      maxWindowTokens: DEFAULT_MAX_WINDOW_TOKENS,
    });
    assert.equal(action.evidence.length, 1);
    assert.equal(action.evidence[0]?.type, "codeWindow");
    assert.match(action.evidence[0]?.reference ?? "", /^window:symbol:symbol-1:/);

    const decision = executor.getPolicyDecision(action.id);
    assert.ok(decision);
    assert.equal(decision?.decision, "approve");
    assert.ok(
      decision?.evidenceUsed.some((entry) => entry.type === "identifiers-provided"),
    );
    assert.ok(
      decision?.evidenceUsed.some((entry) => entry.type === "window-size-check"),
    );
  });
});
