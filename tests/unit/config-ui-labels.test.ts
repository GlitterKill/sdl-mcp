import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  configControlLabelForTest,
  configFieldTooltipForTest,
} from "../../dist/ui/config.js";

test("config UI labels nested values by path instead of inherited section label", () => {
  assert.equal(
    configControlLabelForTest("/semantic/enabled", {
      path: "/semantic",
      label: "Semantic Retrieval",
    }),
    "semantic / enabled",
  );

  assert.equal(
    configControlLabelForTest("/httpAuth/token", {
      path: "/httpAuth/token",
      label: "HTTP Auth Token",
    }),
    "HTTP Auth Token",
  );
});

test("config UI tooltips explain field effects and valid entries", () => {
  const selectTooltip = configFieldTooltipForTest("/performanceTier", "auto", {
    path: "/performanceTier",
    label: "Performance Tier",
    description: "Auto-tune or pin concurrency defaults for the host.",
    options: ["auto", "mid", "high", "extreme"],
  });

  assert.match(selectTooltip, /Auto-tune or pin concurrency defaults/);
  assert.match(selectTooltip, /Valid entries: auto, mid, high, extreme/);

  const sliceTooltip = configFieldTooltipForTest("/slice/defaultMaxCards", 60, {
    path: "/slice",
    label: "Graph Slice",
    description: "Default card/token budgets and edge weights.",
  });

  assert.match(sliceTooltip, /Limits how many symbol cards a graph slice includes by default/);
  assert.doesNotMatch(sliceTooltip, /Nested value under|Path:/);
  assert.match(sliceTooltip, /Valid entries: a finite number/);

  const policyTooltip = configFieldTooltipForTest("/policy/maxWindowLines", 180, {
    path: "/policy",
    label: "Policy",
    description: "Code-window, break-glass, and token-budget policy.",
  });

  assert.match(policyTooltip, /Limits how many source lines a raw code window can return/);
  assert.doesNotMatch(policyTooltip, /Nested value under|Path:/);

  const nestedTooltip = configFieldTooltipForTest("/semantic/enabled", true, {
    path: "/semantic",
    label: "Semantic Retrieval",
    description: "Embedding and summary provider settings.",
  });

  assert.match(nestedTooltip, /Turns embedding-backed semantic retrieval features on or off/);
  assert.doesNotMatch(nestedTooltip, /Nested value under|Path:/);
  assert.match(nestedTooltip, /Valid entries: true or false/);
});

test("config UI tooltip CSS is not nested inside input control rule", () => {
  const css = readFileSync("src/ui/config.css", "utf8");

  assert.doesNotMatch(css, /input, textarea, select \{\s*\.field-title-wrap/s);
  assert.match(css, /\.field-help-tooltip \{[^}]*opacity: 0;[^}]*visibility: hidden;/s);
});
