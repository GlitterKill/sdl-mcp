import assert from "node:assert/strict";
import test from "node:test";

import {
  colorize,
  parseConfirmAnswer,
  parseMultiSelectAnswer,
  timeoutConfirm,
} from "../../src/cli/setup-wizard/terminal.ts";

test("confirm parser uses defaults and yes/no answers", () => {
  assert.equal(parseConfirmAnswer("", true), true);
  assert.equal(parseConfirmAnswer("", false), false);
  assert.equal(parseConfirmAnswer("y", false), true);
  assert.equal(parseConfirmAnswer("no", true), false);
});

test("multi-select parser accepts numbers, names, and all", () => {
  const choices = ["codex", "claude-code", "gemini"];

  assert.deepEqual(parseMultiSelectAnswer("", choices, ["codex"]), ["codex"]);
  assert.deepEqual(parseMultiSelectAnswer("1,3", choices, []), ["codex", "gemini"]);
  assert.deepEqual(parseMultiSelectAnswer("claude-code", choices, []), ["claude-code"]);
  assert.deepEqual(parseMultiSelectAnswer("all", choices, []), choices);
});

test("NO_COLOR disables ANSI output", () => {
  assert.equal(colorize("cyan", "text", { noColor: true }), "text");
  assert.match(colorize("cyan", "text", { noColor: false }), /\u001b\[/);
});

test("timeout confirm resolves to default on timeout", async () => {
  const answer = await timeoutConfirm({
    question: "Run setup?",
    defaultValue: false,
    timeoutMs: 1,
    ask: () => new Promise<string>(() => {}),
  });

  assert.equal(answer, false);
});
