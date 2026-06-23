import assert from "node:assert/strict";
import test from "node:test";

import { resolveSelectedAgents } from "../../dist/cli/setup-wizard/recommendations.js";
import { SETUP_WIZARD_AGENT_CHOICES } from "../../dist/cli/setup-wizard/types.js";

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

test("skills-installer agent ids are accepted", () => {
  assert.deepEqual(resolveSelectedAgents({ agents: ["cursor", "windsurf"] }, []), [
    "cursor",
    "windsurf",
  ]);
});

test("no detected agents means no preselected default", () => {
  assert.deepEqual(resolveSelectedAgents({}, []), []);
});

test("agent choices are alphabetized by label", () => {
  const labels = SETUP_WIZARD_AGENT_CHOICES.map((choice) => choice.label);
  assert.deepEqual(
    labels,
    [...labels].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
  );
});
