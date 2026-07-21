import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  explicitFocusPaths,
  pathMatchesFocus,
  rankSymbols,
  scorePathAffinity,
} from "../../../dist/agent/context-ranking.js";
import type { RankableSymbol } from "../../../dist/agent/context-ranking.js";

const NO_FOCUS: { explicit: string[]; inferred: string[] } = {
  explicit: [],
  inferred: [],
};

function createSymbol(
  overrides: Partial<RankableSymbol> = {},
): RankableSymbol {
  return {
    name: "candidate",
    kind: "function",
    ...overrides,
  };
}

describe("path affinity", () => {
  it("keeps caller focus paths authoritative when inferred paths exist", () => {
    assert.deepEqual(explicitFocusPaths({ focusPaths: ["tests"] }), ["tests"]);
    assert.deepEqual(
      explicitFocusPaths({
        focusPaths: ["tests"],
        inferredFocusPaths: ["src"],
      }),
      ["tests"],
    );
    assert.deepEqual(explicitFocusPaths(undefined), []);
  });

  it("filters blank explicit focus paths without mutating caller entries", () => {
    const focusPaths = ["", "  ", "src"];

    assert.deepEqual(explicitFocusPaths({ focusPaths }), ["src"]);
    assert.deepEqual(focusPaths, ["", "  ", "src"]);
    assert.deepEqual(explicitFocusPaths({ focusPaths: ["", " \t"] }), []);
  });

  it("matches exact file focus paths", () => {
    assert.equal(
      pathMatchesFocus("src/agent/context-ranking.ts", [
        "SRC/agent/context-ranking.ts",
      ]),
      true,
    );
  });

  it("treats dot focus as repo root and blank focus as no match", () => {
    assert.equal(pathMatchesFocus("src/agent/context-ranking.ts", ["."]), true);
    assert.equal(pathMatchesFocus("src/agent/context-ranking.ts", ["", "  "]), false);
  });

  it("matches directory focus paths without matching sibling prefixes", () => {
    assert.equal(
      pathMatchesFocus("src/agent/context-ranking.ts", ["SRC/agent"]),
      true,
    );
    assert.equal(pathMatchesFocus("src/agentic/example.ts", ["src/agent"]), false);
  });

  it("gives explicit focus an in-scope boost and out-of-scope penalty", () => {
    const scope = { explicit: ["tests"], inferred: [] };

    assert.equal(
      scorePathAffinity(
        createSymbol({ fileId: "repo:tests/unit/example.test.ts" }),
        scope,
        "",
        false,
      ),
      10,
    );
    assert.equal(
      scorePathAffinity(
        createSymbol({ fileId: "repo:src/example.ts" }),
        scope,
        "",
        false,
      ),
      -8,
    );
  });

  it("gives inferred focus an in-scope boost without an out-of-scope penalty", () => {
    const scope = { explicit: [], inferred: ["src/agent"] };

    assert.equal(
      scorePathAffinity(
        createSymbol({ fileId: "repo:src/agent/context-ranking.ts" }),
        scope,
        "",
        false,
      ),
      6,
    );
    assert.equal(
      scorePathAffinity(
        createSymbol({ fileId: "repo:src/retrieval/query.ts" }),
        scope,
        "",
        false,
      ),
      0,
    );
  });

  it("composes inferred focus with test priors and clamps the result", () => {
    const symbol = createSymbol({ fileId: "repo:tests/unit/example.test.ts" });
    const scope = { explicit: [], inferred: ["tests"] };

    assert.equal(scorePathAffinity(symbol, scope, "find implementation", false), 2);
    assert.equal(scorePathAffinity(symbol, scope, "find tests", true), 10);
  });

  it("penalizes scripts and dist paths unless the task mentions the category", () => {
    const script = createSymbol({
      fileId: "repo:scripts/evaluate-seed-resolution.ts",
    });
    const dist = createSymbol({ fileId: "repo:dist/agent/context-ranking.js" });

    assert.equal(
      scorePathAffinity(script, NO_FOCUS, "evaluate seed resolution", false),
      -6,
    );
    assert.equal(
      scorePathAffinity(dist, NO_FOCUS, "inspect generated files", false),
      -6,
    );
    assert.equal(
      scorePathAffinity(
        script,
        NO_FOCUS,
        "evaluate seed resolution script",
        false,
      ),
      0,
    );
    assert.equal(
      scorePathAffinity(dist, NO_FOCUS, "inspect compiled output", false),
      0,
    );
  });

  it("does not infer script or dist intent from longer words", () => {
    const script = createSymbol({ fileId: "repo:scripts/check.ts" });
    const dist = createSymbol({ fileId: "repo:dist/check.js" });
    const taskText = "inspect description and distance handling";

    assert.equal(scorePathAffinity(script, NO_FOCUS, taskText, false), -6);
    assert.equal(scorePathAffinity(dist, NO_FOCUS, taskText, false), -6);
  });

  it("boosts test paths for test intent or includeTests and penalizes them otherwise", () => {
    const symbol = createSymbol({ fileId: "repo:src/example.test.ts" });

    assert.equal(scorePathAffinity(symbol, NO_FOCUS, "add tests", false), 6);
    assert.equal(
      scorePathAffinity(symbol, NO_FOCUS, "inspect implementation", true),
      6,
    );
    assert.equal(
      scorePathAffinity(symbol, NO_FOCUS, "inspect implementation", false),
      -4,
    );
  });

  it("treats dot focus as in scope and blank-only focus as unscoped", () => {
    const symbol = createSymbol({
      kind: "function",
      exported: true,
      fileId: "repo:src/example.ts",
    });
    const rootFocused = rankSymbols(
      ["candidate"],
      new Map([["candidate", symbol]]),
      [],
      {
        taskType: "debug",
        taskText: "inspect implementation",
        repoId: "repo",
        options: { focusPaths: ["."] },
      },
    );
    const blankFocused = rankSymbols(
      ["candidate"],
      new Map([["candidate", symbol]]),
      [],
      {
        taskType: "debug",
        taskText: "inspect implementation",
        repoId: "repo",
        options: { focusPaths: ["", "  "] },
      },
    );

    assert.equal(
      scorePathAffinity(
        symbol,
        { explicit: ["."], inferred: [] },
        "inspect implementation",
        false,
      ),
      10,
    );
    assert.equal(rootFocused.ranked[0]!.pathAffinity, 10);
    assert.equal(rootFocused.ranked[0]!.totalScore, 13);
    assert.equal(blankFocused.ranked[0]!.pathAffinity, 0);
    assert.equal(blankFocused.ranked[0]!.totalScore, 3);
  });

  it("includes path affinity in rankSymbols total score", () => {
    const symbol = createSymbol({
      kind: "variable",
      fileId: "repo:src/example.ts",
    });
    const focused = rankSymbols(
      ["candidate"],
      new Map([["candidate", symbol]]),
      [],
      {
        taskType: "debug",
        taskText: "inspect implementation",
        repoId: "repo",
        options: { focusPaths: ["src"] },
      },
    );
    const unscoped = rankSymbols(
      ["candidate"],
      new Map([["candidate", symbol]]),
      [],
      {
        taskType: "debug",
        taskText: "inspect implementation",
        repoId: "repo",
      },
    );

    assert.equal(focused.ranked[0]!.pathAffinity, 10);
    assert.equal(focused.ranked[0]!.totalScore, 10);
    assert.equal(unscoped.ranked[0]!.totalScore, 0);
  });

  it("does not count focus-path membership as structural bonus", () => {
    const result = rankSymbols(
      ["candidate"],
      new Map([
        [
          "candidate",
          createSymbol({
            kind: "function",
            fileId: "repo:src/example.ts",
          }),
        ],
      ]),
      [],
      {
        taskType: "debug",
        taskText: "inspect implementation",
        repoId: "repo",
        options: { focusPaths: ["src"] },
      },
    );

    assert.equal(result.ranked[0]!.structuralBonus, 1);
    assert.equal(result.ranked[0]!.pathAffinity, 10);
  });

  it("keeps name-in-path affinity in the structural bonus", () => {
    const result = rankSymbols(
      ["candidate"],
      new Map([
        [
          "candidate",
          createSymbol({
            kind: "variable",
            fileId: "repo:other.ts",
          }),
        ],
      ]),
      [],
      {
        taskType: "debug",
        taskText: "inspect implementation",
        repoId: "repo",
        options: { focusPaths: ["src/candidate"] },
      },
    );

    assert.equal(result.ranked[0]!.structuralBonus, 2);
  });

  it("clamps rankSymbols total score at zero for explicit out-of-scope paths", () => {
    const symbol = createSymbol({
      kind: "variable",
      fileId: "repo:src/example.ts",
    });
    const result = rankSymbols(
      ["candidate"],
      new Map([["candidate", symbol]]),
      [],
      {
        taskType: "debug",
        taskText: "inspect implementation",
        repoId: "repo",
        options: { focusPaths: ["tests"] },
      },
    );

    assert.equal(result.ranked[0]!.pathAffinity, -8);
    assert.equal(result.ranked[0]!.totalScore, 0);
  });

  it("returns zero when the symbol has no file id", () => {
    assert.equal(
      scorePathAffinity(
        createSymbol(),
        { explicit: ["src"], inferred: ["tests"] },
        "find tests and scripts",
        true,
      ),
      0,
    );
  });
});
