import assert from "node:assert/strict";
import test from "node:test";

import { resolveSelectedAgents } from "../../src/cli/setup-wizard/recommendations.ts";

test("--agents wins over detected defaults", () => {
  assert.deepEqual(
    resolveSelectedAgents({ agents: ["codex", "claude-code"] }, ["gemini"]),
    ["codex", "claude-code"],
  );
});

test("--client remains a single-agent alias", () => {
  assert.deepEqual(resolveSelectedAgents({ client: "codex" }, ["gemini"]), [
    "codex",
  ]);
});

test("detected agents are the default", () => {
  assert.deepEqual(resolveSelectedAgents({}, ["codex", "claude-code"]), [
    "codex",
    "claude-code",
  ]);
});
