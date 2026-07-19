import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  rankSymbols,
  scorePathAffinity,
} from "../../../dist/agent/context-ranking.js";
import type { RankableSymbol } from "../../../dist/agent/context-ranking.js";

const NO_FOCUS = { explicit: [], inferred: [] };

function createSymbol(
  fileId: string,
  overrides: Partial<RankableSymbol> = {},
): RankableSymbol {
  return {
    name: "candidate",
    kind: "function",
    fileId,
    ...overrides,
  };
}

describe("context ranking relevance", () => {
  it("does not penalize source files whose names contain output", () => {
    assert.equal(
      scorePathAffinity(
        createSymbol("repo:src/mcp/tools/output.ts"),
        NO_FOCUS,
        "review output noise",
        false,
      ),
      0,
    );
  });

  it("penalizes top-level generated outputs without path intent", () => {
    assert.equal(
      scorePathAffinity(
        createSymbol("repo:outputs/logos/app.js"),
        NO_FOCUS,
        "review tool contracts",
        false,
      ),
      -6,
    );
  });

  it("does not treat the phrase output noise as generated-output path intent", () => {
    assert.equal(
      scorePathAffinity(
        createSymbol("repo:outputs/logos/app.js"),
        NO_FOCUS,
        "review output noise",
        false,
      ),
      -6,
    );
  });

  it("recognizes slash and backslash generated-output path intent", () => {
    const symbol = createSymbol("repo:outputs/logos/app.js");

    assert.equal(
      scorePathAffinity(symbol, NO_FOCUS, "review outputs/logos", false),
      0,
    );
    assert.equal(
      scorePathAffinity(symbol, NO_FOCUS, "review outputs\\logos", false),
      0,
    );
  });

  it("keeps explicitly focused generated outputs retrievable", () => {
    assert.equal(
      scorePathAffinity(
        createSymbol("repo:outputs/logos/app.js"),
        { explicit: ["outputs/logos"], inferred: [] },
        "review tool contracts",
        false,
      ),
      10,
    );
  });

  it("keeps the existing unfocused scripts baseline", () => {
    assert.equal(
      scorePathAffinity(
        createSymbol("repo:scripts/evaluate-seed-resolution.ts"),
        NO_FOCUS,
        "review tool contracts",
        false,
      ),
      -6,
    );
  });

  it("keeps explicit script focus and script intent behavior", () => {
    const script = createSymbol("repo:scripts/evaluate-seed-resolution.ts");

    assert.equal(
      scorePathAffinity(
        script,
        { explicit: ["scripts"], inferred: [] },
        "review tool contracts",
        false,
      ),
      10,
    );
    assert.equal(
      scorePathAffinity(script, NO_FOCUS, "review benchmark script", false),
      0,
    );
  });

  it("uses symbolId as the deterministic tie-break", () => {
    const symbols = new Map<string, RankableSymbol>([
      ["z-symbol", createSymbol("repo:src/z.ts")],
      ["a-symbol", createSymbol("repo:src/a.ts")],
    ]);
    const result = rankSymbols(
      ["z-symbol", "a-symbol"],
      symbols,
      [],
      {
        taskType: "review",
        taskText: "review tool contracts",
        repoId: "repo",
      },
    );

    assert.deepEqual(
      result.ranked.map(({ symbolId }) => symbolId),
      ["a-symbol", "z-symbol"],
    );
  });
});
