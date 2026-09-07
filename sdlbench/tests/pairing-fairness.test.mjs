import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSessions } from "../src/sdlbench.mjs";

function record(variant, extra = {}) {
  return {
    repoId: "repo-a", taskId: "task", agent: "codex", model: "model",
    variant, quality: { passed: true }, tokens: { total: 100 },
    workflow: { executionMode: "behavior" }, ...extra,
  };
}

test("pairing separates repositories and warm-session conditions", () => {
  for (const extra of [{ repoId: "repo-b" }, { warmSession: true }]) {
    assert.equal(analyzeSessions([record("baseline"), record("sdl", extra)]).paired.length, 0);
  }
});

test("pairing rejects ambiguous repeats, including unsuccessful attempts", () => {
  for (const passed of [true, false]) {
    assert.throws(() => analyzeSessions([
      record("baseline"), record("sdl"), record("sdl", { quality: { passed } }),
    ]), /Ambiguous benchmark pair/);
  }
});

test("pairing retains independent repositories with the same task name", () => {
  const summary = analyzeSessions([
    record("baseline"), record("sdl", { tokens: { total: 60 } }),
    record("baseline", { repoId: "repo-b" }),
    record("sdl", { repoId: "repo-b", tokens: { total: 80 } }),
  ]);
  assert.equal(summary.paired.length, 2);
  assert.equal(summary.deltas.sdl.tokensSaved, 60);
});
