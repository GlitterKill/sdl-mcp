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
import { Executor, type ExecutorDbQueries } from "../../../dist/agent/executor.js";

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

    it("symbols under focus paths get file affinity bonus", () => {
      const symbolMap = new Map<string, RankableSymbol>([
        [
          "sym-focused",
          createSymbol({
            name: "parseSkeleton",
            kind: "function",
            fileId: "repo-1:src/code/skeleton.ts",
            exported: false,
          }),
        ],
        [
          "sym-other",
          createSymbol({
            name: "parseSkeleton",
            kind: "function",
            fileId: "repo-1:scripts/skeleton-report.ts",
            exported: false,
          }),
        ],
      ]);

      const result = rankSymbols(
        ["sym-focused", "sym-other"],
        symbolMap,
        ["parseSkeleton"],
        createTask({ options: { focusPaths: ["src/code/"] } }),
      );

      const focused = result.ranked.find(
        (s) => s.symbolId === "sym-focused",
      )!;
      const other = result.ranked.find((s) => s.symbolId === "sym-other")!;

      assert.ok(focused.pathAffinity > other.pathAffinity);
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

describe("Executor focus selection", () => {
  interface ExecutorSelectionPrivate {
    connPromise: Promise<unknown> | null;
    selectTopSymbols(
      symbolIds: string[],
      task: AgentTask,
      maxCount: number,
      seedCandidates?: ContextSeedCandidate[],
    ): Promise<string[]>;
    finalizeSelection(
      candidates: string[],
      rankedIds: string[],
      symbolMap: Map<string, ReturnType<typeof createExecutorSymbol>>,
      task: AgentTask,
      maxCount: number,
    ): string[];
    buildRelatedSymbolNameMap(
      conn: unknown,
      selectedSymbols: Array<ReturnType<typeof createExecutorSymbol>>,
      task: AgentTask,
    ): Promise<Map<string, string[]>>;
  }

  function createExecutorSymbol(symbolId: string, fileId: string) {
    return {
      symbolId,
      repoId: "repo-1",
      fileId,
      kind: "function",
      name: `sharedHandler${symbolId}`,
      exported: true,
      visibility: null,
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 2,
      rangeEndCol: 0,
      astFingerprint: symbolId,
      signatureJson: null,
      summary: "Shared handler behavior",
      invariantsJson: null,
      sideEffectsJson: null,
      roleTagsJson: null,
      searchText: null,
      external: undefined,
      packageName: null,
      packageVersion: null,
      scipSymbol: null,
      updatedAt: "now",
    };
  }

  function createSelectionFixture() {
    const symbolIds = [
      "src-alpha",
      "test-alpha",
      "src-beta",
      "test-beta",
      "src-gamma",
      "test-gamma",
    ];
    const symbolMap = new Map([
      ["src-alpha", createExecutorSymbol("src-alpha", "repo-1:src/alpha.ts")],
      [
        "test-alpha",
        createExecutorSymbol("test-alpha", "repo-1:tests/alpha.test.ts"),
      ],
      ["src-beta", createExecutorSymbol("src-beta", "repo-1:src/beta.ts")],
      [
        "test-beta",
        createExecutorSymbol("test-beta", "repo-1:tests/beta.test.ts"),
      ],
      ["src-gamma", createExecutorSymbol("src-gamma", "repo-1:src/gamma.ts")],
      [
        "test-gamma",
        createExecutorSymbol("test-gamma", "repo-1:tests/gamma.test.ts"),
      ],
    ]);
    const dbQueries: ExecutorDbQueries = {
      getFileByRepoPath: async () => null,
      getSymbolIdsByFile: async () => [],
      getFilesByPrefix: async () => [],
      getSymbolsByFile: async () => [],
      getClusterMembers: async () => [],
      getProcessStepsByIds: async () => [],
      getSymbolsByIds: async () => symbolMap,
      getFilesByIds: async () => new Map(),
      searchSymbols: async () => [],
    };
    const executor = new Executor(undefined, dbQueries);
    const privateExecutor = executor as unknown as ExecutorSelectionPrivate;
    privateExecutor.connPromise = Promise.resolve({});
    return { privateExecutor, symbolIds, symbolMap };
  }

  function srcSeeds(): ContextSeedCandidate[] {
    return ["src-alpha", "src-beta", "src-gamma"].map((symbolId, index) => ({
      contextRef: `symbol:${symbolId}`,
      source: "semantic",
      score: 1 - index * 0.05,
      sourceRank: index,
    }));
  }

  function assertOnlyTests(
    selected: string[],
    symbolMap: ReturnType<typeof createSelectionFixture>["symbolMap"],
  ): void {
    assert.ok(selected.length > 0, "Expected at least one focused symbol");
    assert.ok(
      selected.every((symbolId) =>
        symbolMap.get(symbolId)?.fileId.includes(":tests/"),
      ),
      `Expected only tests/ symbols, got ${selected.join(", ")}`,
    );
  }

  it("strictly scopes precise selection to explicit focus paths", async () => {
    const { privateExecutor, symbolIds, symbolMap } = createSelectionFixture();

    const selected = await privateExecutor.selectTopSymbols(
      symbolIds,
      createTask({ options: { contextMode: "precise", focusPaths: ["tests"] } }),
      4,
    );

    assertOnlyTests(selected, symbolMap);
  });

  it("resolves opaque file IDs before enforcing explicit focus paths", async () => {
    const sourceSymbol = {
      ...createExecutorSymbol("src-symbol", "opaque-src-file"),
      repoId: "org:repo",
    };
    const testSymbol = {
      ...createExecutorSymbol("test-symbol", "opaque-test-file"),
      repoId: "org:repo",
    };
    const symbolMap = new Map([
      ["src-symbol", sourceSymbol],
      ["test-symbol", testSymbol],
    ]);
    const dbQueries = {
      getFileByRepoPath: async () => null,
      getSymbolIdsByFile: async () => [],
      getFilesByPrefix: async () => [],
      getSymbolsByFile: async () => [],
      getClusterMembers: async () => [],
      getProcessStepsByIds: async () => [],
      getSymbolsByIds: async () => symbolMap,
      getFilesByIds: async () =>
        new Map([
          [
            "opaque-src-file",
            {
              fileId: "opaque-src-file",
              repoId: "repo-1",
              relPath: "src/handler.ts",
              contentHash: "src-hash",
              language: "typescript",
              byteSize: 1,
              lastIndexedAt: "now",
              directory: "src",
            },
          ],
          [
            "opaque-test-file",
            {
              fileId: "opaque-test-file",
              repoId: "repo-1",
              relPath: "tests/handler.test.ts",
              contentHash: "test-hash",
              language: "typescript",
              byteSize: 1,
              lastIndexedAt: "now",
              directory: "tests",
            },
          ],
        ]),
      searchSymbols: async () => [],
    } as unknown as ExecutorDbQueries;
    const executor = new Executor(undefined, dbQueries);
    const privateExecutor = executor as unknown as ExecutorSelectionPrivate;
    privateExecutor.connPromise = Promise.resolve({});

    const selected = await privateExecutor.selectTopSymbols(
      [...symbolMap.keys()],
      createTask({ options: { contextMode: "precise", focusPaths: ["tests"] } }),
      4,
    );

    assert.deepEqual(selected, ["test-symbol"]);
  });

  it("resolves opaque file IDs for unscoped path and language affinity", async () => {
    const scriptSymbol = {
      ...createExecutorSymbol("a-script", "opaque-script-file"),
      name: "sharedHandler",
    };
    const sourceSymbol = {
      ...createExecutorSymbol("z-typescript", "opaque-source-file"),
      name: "sharedHandler",
    };
    const symbolMap = new Map([
      [scriptSymbol.symbolId, scriptSymbol],
      [sourceSymbol.symbolId, sourceSymbol],
    ]);
    let fileLookupCount = 0;
    let requestedFileIds: string[] = [];
    const dbQueries = {
      getFileByRepoPath: async () => null,
      getSymbolIdsByFile: async () => [],
      getFilesByPrefix: async () => [],
      getSymbolsByFile: async () => [],
      getClusterMembers: async () => [],
      getProcessStepsByIds: async () => [],
      getSymbolsByIds: async () => symbolMap,
      getFilesByIds: async (_conn: unknown, fileIds: string[]) => {
        fileLookupCount++;
        requestedFileIds = fileIds;
        return new Map([
          [
            "opaque-script-file",
            {
              fileId: "opaque-script-file",
              repoId: "repo-1",
              relPath: "scripts/check.py",
              contentHash: "script-hash",
              language: "python",
              byteSize: 1,
              lastIndexedAt: "now",
              directory: "scripts",
            },
          ],
          [
            "opaque-source-file",
            {
              fileId: "opaque-source-file",
              repoId: "repo-1",
              relPath: "src/handler.ts",
              contentHash: "source-hash",
              language: "typescript",
              byteSize: 1,
              lastIndexedAt: "now",
              directory: "src",
            },
          ],
        ]);
      },
      searchSymbols: async () => [],
    } as unknown as ExecutorDbQueries;
    const executor = new Executor(undefined, dbQueries);
    const privateExecutor = executor as unknown as ExecutorSelectionPrivate;
    privateExecutor.connPromise = Promise.resolve({});

    const selected = await privateExecutor.selectTopSymbols(
      [...symbolMap.keys()],
      createTask({ taskText: "Review TypeScript shared handler behavior" }),
      1,
    );

    assert.deepEqual(selected, ["z-typescript"]);
    assert.equal(fileLookupCount, 1);
    assert.deepEqual(requestedFileIds, [
      "opaque-script-file",
      "opaque-source-file",
    ]);
  });

  it("intersects precise focus paths with out-of-path symbol seeds", async () => {
    const { privateExecutor, symbolIds, symbolMap } = createSelectionFixture();

    const selected = await privateExecutor.selectTopSymbols(
      symbolIds,
      createTask({
        taskText: "Investigate src-alpha shared handler behavior",
        options: {
          contextMode: "precise",
          focusPaths: ["tests"],
          focusSymbols: ["src-alpha"],
        },
      }),
      4,
      srcSeeds(),
    );

    assert.ok(!selected.includes("src-alpha"));
    assertOnlyTests(selected, symbolMap);
  });

  it("returns no precise symbols when an explicit focus path has no matches", async () => {
    const { privateExecutor, symbolIds } = createSelectionFixture();

    const selected = await privateExecutor.selectTopSymbols(
      symbolIds,
      createTask({
        options: { contextMode: "precise", focusPaths: ["does-not-exist"] },
      }),
      4,
    );

    assert.deepEqual(selected, []);
  });

  it("prioritizes explicit focus paths in broad mode before spillover", async () => {
    const { privateExecutor, symbolIds, symbolMap } = createSelectionFixture();

    const selected = await privateExecutor.selectTopSymbols(
      symbolIds,
      createTask({ options: { contextMode: "broad", focusPaths: ["tests"] } }),
      4,
      srcSeeds(),
    );

    assert.equal(selected.length, 4);
    assert.ok(
      selected.slice(0, 2).every((symbolId) =>
        symbolMap.get(symbolId)?.fileId.includes(":tests/"),
      ),
    );
    assert.ok(
      selected.filter((symbolId) =>
        symbolMap.get(symbolId)?.fileId.includes(":tests/"),
      ).length >= 2,
    );
  });

  it("does not hard-filter inferred focus paths in precise mode", async () => {
    const { privateExecutor, symbolIds, symbolMap } = createSelectionFixture();

    const selected = await privateExecutor.selectTopSymbols(
      symbolIds,
      createTask({
        options: {
          contextMode: "precise",
          focusPaths: ["tests"],
          inferredFocusPaths: ["tests"],
        },
      }),
      4,
      srcSeeds(),
    );

    assert.ok(
      selected.some((symbolId) =>
        symbolMap.get(symbolId)?.fileId.includes(":src/"),
      ),
    );
  });

  it("enforces explicit focus paths when no identifiers or seeds are available", async () => {
    const { privateExecutor, symbolIds, symbolMap } = createSelectionFixture();

    const selected = await privateExecutor.selectTopSymbols(
      symbolIds,
      createTask({
        taskText: "-",
        options: { contextMode: "precise", focusPaths: ["tests"] },
      }),
      4,
    );

    assertOnlyTests(selected, symbolMap);
  });

  it("enforces explicit focus paths when task text is empty", async () => {
    const { privateExecutor, symbolIds, symbolMap } = createSelectionFixture();

    const selected = await privateExecutor.selectTopSymbols(
      symbolIds,
      createTask({
        taskText: "",
        options: { contextMode: "precise", focusPaths: ["tests"] },
      }),
      4,
    );

    assertOnlyTests(selected, symbolMap);
  });

  it("preserves the max count and ordering for unscoped early returns", async () => {
    const { privateExecutor, symbolIds } = createSelectionFixture();

    const selected = await privateExecutor.selectTopSymbols(
      symbolIds,
      createTask({ taskText: "" }),
      4,
    );

    assert.deepEqual(selected, symbolIds.slice(0, 4));
  });

  it("caps inferred early returns without hard-filtering their soft scope", async () => {
    const { privateExecutor, symbolMap } = createSelectionFixture();
    const inferredLast = [
      "src-alpha",
      "src-beta",
      "src-gamma",
      "test-alpha",
      "test-beta",
      "test-gamma",
    ];

    const selected = await privateExecutor.selectTopSymbols(
      inferredLast,
      createTask({
        taskText: "-",
        options: {
          contextMode: "precise",
          focusPaths: ["tests"],
          inferredFocusPaths: ["tests"],
        },
      }),
      3,
    );

    assert.ok(
      inferredLast.slice(0, 3).every((symbolId) =>
        symbolMap.get(symbolId)?.fileId.includes(":src/"),
      ),
    );
    assert.equal(selected.length, 3);
    assert.ok(
      selected.some((symbolId) =>
        symbolMap.get(symbolId)?.fileId.includes(":tests/"),
      ),
    );
    assert.ok(
      selected.some((symbolId) =>
        symbolMap.get(symbolId)?.fileId.includes(":src/"),
      ),
    );
  });

  it("returns an empty selection without hydrating an empty symbol list", async () => {
    const { privateExecutor } = createSelectionFixture();

    const selected = await privateExecutor.selectTopSymbols(
      [],
      createTask({ options: { contextMode: "precise", focusPaths: ["tests"] } }),
      4,
    );

    assert.deepEqual(selected, []);
  });

  it("bounds cumulative inferred replacements only for forced semantic", () => {
    const { privateExecutor, symbolMap } = createSelectionFixture();
    const ranked = [
      "src-alpha",
      "src-beta",
      "src-gamma",
      "test-alpha",
      "test-beta",
      "test-gamma",
    ];
    const selected = ranked.slice(0, 3);
    const inferredFocusPaths = [
      "tests/alpha.test.ts",
      "tests/beta.test.ts",
      "tests/gamma.test.ts",
    ];
    const finalize = (semantic: boolean | undefined) =>
      privateExecutor.finalizeSelection(
        selected,
        ranked,
        symbolMap,
        createTask({
          options: {
            contextMode: "precise",
            inferredFocusPaths,
            ...(semantic === undefined ? {} : { semantic }),
          },
        }),
        3,
      );

    const forced = finalize(true);
    assert.equal(
      forced.filter((symbolId) => symbolId.startsWith("test-")).length,
      2,
    );
    assert.equal(
      forced.filter((symbolId) => symbolId.startsWith("src-")).length,
      1,
    );
    for (const semantic of [undefined, false] as const) {
      assert.ok(finalize(semantic).every((symbolId) => symbolId.startsWith("test-")));
    }
  });

  it("ranks forced semantic retrieval before bounded inferred coverage", async () => {
    const { privateExecutor, symbolIds, symbolMap } = createSelectionFixture();
    symbolMap.get("src-alpha")!.name = "adjustForBudget";
    symbolMap.get("src-beta")!.name = "maxTokens";
    symbolMap.get("src-gamma")!.name = "estimateTokens";
    symbolMap.get("test-alpha")!.name = "HotPathOptions";
    symbolMap.get("test-beta")!.name = "buildHotPathExcerpt";
    symbolMap.get("test-gamma")!.name = "executeHotPathRung";
    const inferredFocusPaths = [
      "tests/alpha.test.ts",
      "tests/beta.test.ts",
      "tests/gamma.test.ts",
    ];
    const competitionSeeds: ContextSeedCandidate[] = [
      {
        contextRef: "symbol:src-alpha",
        source: "lexical",
        score: 1,
        sourceRank: 0,
      },
      ...["test-alpha", "test-beta", "test-gamma"].map(
        (symbolId, index): ContextSeedCandidate => ({
          contextRef: `symbol:${symbolId}`,
          source: "semantic",
          score: 0.95 - index * 0.05,
          sourceRank: index,
        }),
      ),
    ];
    const select = (semantic: boolean | undefined) =>
      privateExecutor.selectTopSymbols(
        symbolIds,
        createTask({
          taskText:
            "adjustForBudget trims rungs when maxTokens is small but debug needs hotPath",
          options: {
            contextMode: "precise",
            focusPaths: inferredFocusPaths,
            inferredFocusPaths,
            ...(semantic === undefined ? {} : { semantic }),
          },
        }),
        3,
        competitionSeeds,
      );

    const forced = await select(true);
    assert.equal(
      forced.filter((symbolId) => symbolMap.get(symbolId)?.fileId.includes(":src/"))
        .length,
      1,
      `Expected one lexical source symbol, got ${forced.join(", ")}`,
    );
    assert.equal(
      forced.filter((symbolId) => symbolMap.get(symbolId)?.fileId.includes(":tests/"))
        .length,
      2,
    );
    for (const semantic of [undefined, false] as const) {
      assertOnlyTests(await select(semantic), symbolMap);
    }
  });

  it("surfaces one compact file outline only for forced semantic", async () => {
    const fileSymbols = Array.from({ length: 90 }, (_, index) => ({
      ...createExecutorSymbol(`sym-${index}`, "repo-1:src/focus.ts"),
      name: `symbol${String(index).padStart(3, "0")}`,
      rangeStartLine: index + 1,
    }));
    let dependencySources: string[] = [];
    let dependencyLimit = 0;
    const dbQueries = {
      getFileByRepoPath: async () => null,
      getSymbolIdsByFile: async () => [],
      getFilesByPrefix: async () => [],
      getSymbolsByFile: async () => fileSymbols,
      getClusterMembers: async () => [],
      getProcessStepsByIds: async () => [],
      getSymbolsByIds: async () => new Map(),
      getFilesByIds: async () => new Map(),
      searchSymbols: async () => [],
      getBoundedDependencySymbolsFromSources: async (
        _conn: unknown,
        sourceSymbolIds: string[],
        limit: number,
      ) => {
        dependencySources = sourceSymbolIds;
        dependencyLimit = limit;
        return new Map([
          [
            "dep-estimate-tokens",
            {
              symbolId: "dep-estimate-tokens",
              name: "estimateTokens",
              kind: "function",
              fileId: "repo-1:src/util/tokenize.ts",
            },
          ],
        ]);
      },
    } as unknown as ExecutorDbQueries;
    const executor = new Executor(undefined, dbQueries);
    const privateExecutor = executor as unknown as ExecutorSelectionPrivate;
    const selected = [fileSymbols[45]!];
    const build = (semantic: boolean | undefined) =>
      privateExecutor.buildRelatedSymbolNameMap(
        {},
        selected,
        createTask({
          taskText: "Inspect symbol089 behavior",
          options: {
            inferredFocusPaths: ["src/focus.ts"],
            ...(semantic === undefined ? {} : { semantic }),
          },
        }),
      );

    const forced = (await build(true)).get("repo-1:src/focus.ts")!;
    assert.equal(dependencySources.length, 80);
    assert.equal(dependencyLimit, 512);
    assert.equal(forced.length, 90);
    assert.equal(forced[0], "symbol089");
    assert.ok(forced.includes("symbol000"));
    assert.ok(forced.includes("estimateTokens"));
    for (const semantic of [undefined, false] as const) {
      assert.equal((await build(semantic)).get("repo-1:src/focus.ts")!.length, 14);
    }
  });

  it("keeps forced semantic outlines when selected symbols use opaque file IDs", async () => {
    const selected = createExecutorSymbol("selected", "opaque-file-id");
    const related = createExecutorSymbol("related", "opaque-file-id");
    related.name = "RelatedHelper";
    const dbQueries: ExecutorDbQueries = {
      getFileByRepoPath: async () => null,
      getSymbolIdsByFile: async () => [],
      getFilesByPrefix: async () => [],
      getSymbolsByFile: async () => [selected, related],
      getClusterMembers: async () => [],
      getProcessStepsByIds: async () => [],
      getSymbolsByIds: async () => new Map(),
      getFilesByIds: async () => new Map(),
      searchSymbols: async () => [],
    };
    const privateExecutor = new Executor(
      undefined,
      dbQueries,
    ) as unknown as ExecutorSelectionPrivate;
    const build = (semantic: boolean | undefined) =>
      privateExecutor.buildRelatedSymbolNameMap(
        {},
        [selected],
        createTask({
          options: {
            inferredFocusPaths: ["src/focus.ts"],
            ...(semantic === undefined ? {} : { semantic }),
          },
        }),
      );

    assert.deepEqual(
      (await build(true)).get("opaque-file-id"),
      ["RelatedHelper"],
    );
    for (const semantic of [undefined, false] as const) {
      assert.equal((await build(semantic)).size, 0);
    }
  });
});


describe("Executor seed expansion", () => {
  interface ExecutorPrivate {
    connPromise: Promise<unknown> | null;
    resolveContextToSymbols(
      context: string[],
      task: AgentTask,
      seedCandidates: ContextSeedCandidate[],
    ): Promise<{ symbolIds: string[]; seedCandidates: ContextSeedCandidate[] }>;
  }

  it("expands fileSummary, cluster, and process candidates into weighted symbol seeds", async () => {
    const dbQueries: ExecutorDbQueries = {
      getFileByRepoPath: async () =>
        null as Awaited<ReturnType<ExecutorDbQueries["getFileByRepoPath"]>>,
      getSymbolIdsByFile: async () => ["sym-file-a", "sym-file-b"],
      getFilesByPrefix: async () => [],
      getSymbolsByFile: async () =>
        [
          {
            symbolId: "sym-file-a",
            repoId: "repo-1",
            fileId: "file-1",
            kind: "function",
            name: "fileSymbolA",
            exported: true,
            visibility: null,
            language: "ts",
            rangeStartLine: 1,
            rangeStartCol: 0,
            rangeEndLine: 2,
            rangeEndCol: 0,
            astFingerprint: "a",
            signatureJson: null,
            summary: null,
            invariantsJson: null,
            sideEffectsJson: null,
            roleTagsJson: null,
            searchText: null,
            external: undefined,
            packageName: null,
            packageVersion: null,
            scipSymbol: null,
            updatedAt: "now",
          },
          {
            symbolId: "sym-file-b",
            repoId: "repo-1",
            fileId: "file-1",
            kind: "function",
            name: "fileSymbolB",
            exported: true,
            visibility: null,
            language: "ts",
            rangeStartLine: 3,
            rangeStartCol: 0,
            rangeEndLine: 4,
            rangeEndCol: 0,
            astFingerprint: "b",
            signatureJson: null,
            summary: null,
            invariantsJson: null,
            sideEffectsJson: null,
            roleTagsJson: null,
            searchText: null,
            external: undefined,
            packageName: null,
            packageVersion: null,
            scipSymbol: null,
            updatedAt: "now",
          },
        ] as Awaited<ReturnType<ExecutorDbQueries["getSymbolsByFile"]>>,
      getClusterMembers: async () =>
        [
          { symbolId: "sym-cluster", membershipScore: 0.95 },
        ] as Awaited<ReturnType<ExecutorDbQueries["getClusterMembers"]>>,
      getProcessStepsByIds: async () =>
        [
          { processId: "proc-1", symbolId: "sym-process", stepOrder: 1, role: "step" },
          { processId: "other", symbolId: "sym-other", stepOrder: 1, role: "step" },
        ] as Awaited<ReturnType<ExecutorDbQueries["getProcessStepsByIds"]>>,
      getSymbolsByIds: async () =>
        new Map() as Awaited<ReturnType<ExecutorDbQueries["getSymbolsByIds"]>>,
      getFilesByIds: async () =>
        new Map() as Awaited<ReturnType<ExecutorDbQueries["getFilesByIds"]>>,
      searchSymbols: async () =>
        [] as Awaited<ReturnType<ExecutorDbQueries["searchSymbols"]>>,
    };

    const executor = new Executor(undefined, dbQueries);
    const privateExecutor = executor as unknown as ExecutorPrivate;
    privateExecutor.connPromise = Promise.resolve({});

    const seeds: ContextSeedCandidate[] = [
      {
        contextRef: "fileSummary:file-1",
        source: "semantic",
        score: 1,
        sourceRank: 0,
        entityType: "fileSummary",
      },
      {
        contextRef: "cluster:cluster-1",
        source: "semantic",
        score: 0.9,
        sourceRank: 1,
        entityType: "cluster",
      },
      {
        contextRef: "process:proc-1",
        source: "semantic",
        score: 0.8,
        sourceRank: 2,
        entityType: "process",
      },
    ];

    const result = await privateExecutor.resolveContextToSymbols(
      ["fileSummary:file-1", "cluster:cluster-1", "process:proc-1"],
      createTask(),
      seeds,
    );

    assert.deepEqual(result.symbolIds, [
      "sym-file-a",
      "sym-file-b",
      "sym-cluster",
      "sym-process",
    ]);
    assert.ok(
      result.seedCandidates.some(
        (candidate) =>
          candidate.contextRef === "symbol:sym-file-a" &&
          candidate.expandedFrom === "fileSummary:file-1" &&
          candidate.score === 0.92,
      ),
    );
    assert.ok(
      result.seedCandidates.some(
        (candidate) =>
          candidate.contextRef === "symbol:sym-cluster" &&
          candidate.expandedFrom === "cluster:cluster-1",
      ),
    );
    assert.ok(
      result.seedCandidates.some(
        (candidate) =>
          candidate.contextRef === "symbol:sym-process" &&
          candidate.expandedFrom === "process:proc-1",
      ),
    );
  });
});
