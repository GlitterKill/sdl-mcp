import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  rankSymbols,
  applyAdaptiveCutoff,
} from "../../../dist/agent/context-ranking.js";
import type {
  AgentTask,
  ContextSeedCandidate,
} from "../../../dist/agent/types.js";
import type { RankableSymbol } from "../../../dist/agent/context-ranking.js";

function createTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    taskType: "debug",
    taskText: "Investigate the buildContext method in ContextEngine",
    repoId: "repo-1",
    ...overrides,
  };
}

function createSymbol(overrides: Partial<RankableSymbol> = {}): RankableSymbol {
  return {
    name: "unknownSymbol",
    kind: "function",
    exported: false,
    ...overrides,
  };
}

describe("context-ranking", () => {
  describe("rankSymbols", () => {
    it("semantic prior outranks lexical overlap alone", () => {
      const symbolMap = new Map<string, RankableSymbol>([
        [
          "sym-semantic",
          createSymbol({ name: "unrelatedName", kind: "function" }),
        ],
        [
          "sym-lexical",
          createSymbol({
            name: "buildContext",
            kind: "method",
            summary: "Builds context for agent tasks",
          }),
        ],
      ]);

      const seeds: ContextSeedCandidate[] = [
        {
          contextRef: "symbol:sym-semantic",
          source: "semantic",
          score: 0.95,
          sourceRank: 0,
        },
      ];

      const result = rankSymbols(
        ["sym-semantic", "sym-lexical"],
        symbolMap,
        ["buildContext", "ContextEngine"],
        createTask(),
        { seedCandidates: seeds },
      );

      assert.ok(result.ranked.length === 2);
      // Semantic seed (0.95 * 40 = 38) should beat lexical-only
      assert.equal(
        result.ranked[0]!.symbolId,
        "sym-semantic",
        "Semantic prior should outrank pure lexical overlap",
      );
      assert.ok(result.ranked[0]!.retrievalPrior > 30);
      assert.equal(result.ranked[0]!.lexicalOverlap, 0);
    });

    it("anchor symbols get graph proximity bonus", () => {
      const symbolMap = new Map<string, RankableSymbol>([
        [
          "sym-anchor",
          createSymbol({ name: "helperFn", kind: "function", fileId: "f1" }),
        ],
        [
          "sym-distant",
          createSymbol({ name: "helperFn2", kind: "function", fileId: "f2" }),
        ],
      ]);

      const result = rankSymbols(
        ["sym-anchor", "sym-distant"],
        symbolMap,
        ["helperFn"],
        createTask(),
        { anchorSymbolIds: ["sym-anchor"] },
      );

      const anchor = result.ranked.find((s) => s.symbolId === "sym-anchor")!;
      const distant = result.ranked.find((s) => s.symbolId === "sym-distant")!;

      assert.equal(anchor.graphProximity, 20, "Anchor gets full proximity");
      assert.equal(distant.graphProximity, 0, "Non-anchor gets no proximity");
      assert.ok(anchor.totalScore > distant.totalScore);
    });

    it("file co-location gives partial graph proximity", () => {
      const symbolMap = new Map<string, RankableSymbol>([
        [
          "sym-anchor",
          createSymbol({ name: "main", kind: "function", fileId: "f1" }),
        ],
        [
          "sym-colocated",
          createSymbol({ name: "helper", kind: "function", fileId: "f1" }),
        ],
        [
          "sym-distant",
          createSymbol({ name: "other", kind: "function", fileId: "f2" }),
        ],
      ]);

      const result = rankSymbols(
        ["sym-anchor", "sym-colocated", "sym-distant"],
        symbolMap,
        ["main"],
        createTask(),
        { anchorSymbolIds: ["sym-anchor"] },
      );

      const colocated = result.ranked.find(
        (s) => s.symbolId === "sym-colocated",
      )!;
      const distant = result.ranked.find((s) => s.symbolId === "sym-distant")!;

      assert.equal(colocated.graphProximity, 10, "Co-located gets partial");
      assert.equal(distant.graphProximity, 0, "Different file gets none");
    });

    it("feedback priors help within close score range but do not dominate", () => {
      const symbolMap = new Map<string, RankableSymbol>([
        [
          "sym-feedback",
          createSymbol({ name: "someFunction", kind: "function" }),
        ],
        [
          "sym-retrieval",
          createSymbol({ name: "buildContext", kind: "method" }),
        ],
      ]);

      const seeds: ContextSeedCandidate[] = [
        {
          contextRef: "symbol:sym-retrieval",
          source: "semantic",
          score: 0.8,
          sourceRank: 0,
        },
      ];
      const feedbackBoosts = new Map([["sym-feedback", 1.0]]);

      const result = rankSymbols(
        ["sym-feedback", "sym-retrieval"],
        symbolMap,
        ["buildContext"],
        createTask(),
        { seedCandidates: seeds, feedbackBoosts },
      );

      // sym-retrieval has retrieval prior (0.8*40=32) + lexical overlap
      // sym-feedback has feedback prior (1.0*10=10) only
      const retrieval = result.ranked.find(
        (s) => s.symbolId === "sym-retrieval",
      )!;
      const feedback = result.ranked.find(
        (s) => s.symbolId === "sym-feedback",
      )!;

      assert.ok(
        retrieval.totalScore > feedback.totalScore,
        "Strong retrieval+lexical should beat feedback-only",
      );
      assert.equal(feedback.feedbackPrior, 10, "Max feedback prior is 10");
    });

    it("exported behavioral symbols get structural bonus", () => {
      const symbolMap = new Map<string, RankableSymbol>([
        [
          "sym-exported",
          createSymbol({
            name: "processData",
            kind: "function",
            exported: true,
          }),
        ],
        [
          "sym-private",
          createSymbol({
            name: "processData2",
            kind: "variable",
            exported: false,
          }),
        ],
      ]);

      const result = rankSymbols(
        ["sym-exported", "sym-private"],
        symbolMap,
        ["processData"],
        createTask(),
      );

      const exported = result.ranked.find(
        (s) => s.symbolId === "sym-exported",
      )!;
      const priv = result.ranked.find((s) => s.symbolId === "sym-private")!;

      // exported function: +2 (exported) + 1 (behavioral kind) = 3
      assert.equal(exported.structuralBonus, 3);
      // private variable: 0
      assert.equal(priv.structuralBonus, 0);
    });

    it("confidence tier reflects score gap", () => {
      const symbolMap = new Map<string, RankableSymbol>([
        ["sym-top", createSymbol({ name: "buildContext", kind: "method" })],
        ["sym-low", createSymbol({ name: "unrelated", kind: "variable" })],
      ]);

      const seeds: ContextSeedCandidate[] = [
        {
          contextRef: "symbol:sym-top",
          source: "semantic",
          score: 1.0,
          sourceRank: 0,
        },
      ];

      const result = rankSymbols(
        ["sym-top", "sym-low"],
        symbolMap,
        ["buildContext"],
        createTask(),
        { seedCandidates: seeds },
      );

      // top has retrieval (40) + lexical overlap, low has ~0
      assert.equal(
        result.confidenceTier,
        "high",
        "Large gap with high score should be high confidence",
      );
      assert.ok(result.topScore >= 40);
      assert.ok(result.topScore - result.secondScore >= 15);
    });

    it("returns low confidence when all scores are similar", () => {
      const symbolMap = new Map<string, RankableSymbol>([
        ["sym-a", createSymbol({ name: "foo", kind: "function" })],
        ["sym-b", createSymbol({ name: "bar", kind: "function" })],
      ]);

      const result = rankSymbols(
        ["sym-a", "sym-b"],
        symbolMap,
        ["unrelated"],
        createTask({ taskText: "something unrelated" }),
      );

      assert.equal(result.confidenceTier, "low");
    });

    it("handles empty symbol list", () => {
      const result = rankSymbols([], new Map(), ["test"], createTask());

      assert.equal(result.ranked.length, 0);
      assert.equal(result.topScore, 0);
      assert.equal(result.confidenceTier, "low");
    });
  });

  describe("applyAdaptiveCutoff", () => {
    it("precise-mode caps at 5 symbols", () => {
      const symbolMap = new Map<string, RankableSymbol>();
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const id = `sym-${i}`;
        ids.push(id);
        symbolMap.set(
          id,
          createSymbol({
            name: `buildContext${i}`,
            kind: "function",
            exported: true,
          }),
        );
      }

      const ranking = rankSymbols(
        ids,
        symbolMap,
        ["buildContext"],
        createTask({
          options: { contextMode: "precise" },
        }),
      );

      const selected = applyAdaptiveCutoff(ranking, 20, true, false);
      assert.ok(
        selected.length <= 5,
        `Precise should cap at 5, got ${selected.length}`,
      );
      assert.ok(selected.length >= 1, "Should return at least 1");
    });

    it("broad-mode returns more symbols than precise", () => {
      const symbolMap = new Map<string, RankableSymbol>();
      const ids: string[] = [];
      for (let i = 0; i < 15; i++) {
        const id = `sym-${i}`;
        ids.push(id);
        symbolMap.set(
          id,
          createSymbol({
            name: `handler${i}`,
            kind: "function",
            exported: true,
            summary: "Handles buildContext requests",
          }),
        );
      }

      const task = createTask();
      const ranking = rankSymbols(
        ids,
        symbolMap,
        ["handler", "buildContext"],
        task,
      );

      const precise = applyAdaptiveCutoff(ranking, 20, true, false);
      const broad = applyAdaptiveCutoff(ranking, 20, false, false);

      assert.ok(
        broad.length >= precise.length,
        `Broad (${broad.length}) should return >= precise (${precise.length})`,
      );
    });

    it("always returns at least 1 symbol when available", () => {
      const symbolMap = new Map<string, RankableSymbol>([
        ["sym-1", createSymbol({ name: "x", kind: "variable" })],
      ]);

      const ranking = rankSymbols(
        ["sym-1"],
        symbolMap,
        ["unrelated"],
        createTask(),
      );

      const selected = applyAdaptiveCutoff(ranking, 10, true, false);
      assert.equal(selected.length, 1, "Should return at least 1");
    });

    it("returns empty array when no symbols available", () => {
      const ranking = rankSymbols([], new Map(), [], createTask());
      const selected = applyAdaptiveCutoff(ranking, 10, false, false);
      assert.equal(selected.length, 0);
    });
  });
});
