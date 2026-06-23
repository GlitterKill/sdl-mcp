import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  colorize,
  parseConfirmAnswer,
  parseMultiSelectAnswer,
  parseOptionalTextAnswer,
  parseSingleSelectAnswer,
  timeoutConfirm,
} from "../../src/cli/setup-wizard/terminal.ts";

test("line prompts are written explicitly before waiting for input", () => {
  const source = readFileSync("src/cli/setup-wizard/terminal.ts", "utf8");

  assert.match(source, /output\.write\(question\);[\s\S]*rl\.question\(""\)/);
});

test("choice prompts use the skills installer shell instead of the old key reducer", () => {
  const source = readFileSync("src/cli/setup-wizard/terminal.ts", "utf8");

  assert.doesNotMatch(
    source,
    /applyChoiceKey|ChoiceState|renderChoices|setRawMode|emitKeypressEvents/,
  );
  assert.match(source, /@clack\/prompts/);
  assert.match(source, /space to toggle/);
});

test("confirm parser uses defaults and yes/no answers", () => {
  assert.equal(parseConfirmAnswer("", true), true);
  assert.equal(parseConfirmAnswer("", false), false);
  assert.equal(parseConfirmAnswer("y", false), true);
  assert.equal(parseConfirmAnswer("N", false), false);
  assert.equal(parseConfirmAnswer("no", true), false);
});

test("multi-select parser accepts numbers, names, and all", () => {
  const choices = ["codex", "claude-code", "gemini"];

  assert.deepEqual(parseMultiSelectAnswer("", choices, ["codex"]), ["codex"]);
  assert.deepEqual(parseMultiSelectAnswer("1,3", choices, []), [
    "codex",
    "gemini",
  ]);
  assert.deepEqual(parseMultiSelectAnswer("claude-code", choices, []), [
    "claude-code",
  ]);
  assert.deepEqual(parseMultiSelectAnswer("all", choices, []), choices);
});

test("single-select parser accepts numbers, names, and defaults", () => {
  const choices = ["code", "enhanced", "off"];

  assert.equal(parseSingleSelectAnswer("", choices, "code"), "code");
  assert.equal(parseSingleSelectAnswer("2", choices, "code"), "enhanced");
  assert.equal(parseSingleSelectAnswer("off", choices, "code"), "off");
});

test("optional text parser treats blank clack answers as empty string", () => {
  assert.equal(parseOptionalTextAnswer(undefined), "");
  assert.equal(parseOptionalTextAnswer("  C:\\repo  "), "C:\\repo");
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
