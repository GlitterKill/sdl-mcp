import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  rankSymbols,
  scorePathAffinity,
  selectFinalSymbols,
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

  it("prefers behavioral declarations over equally relevant data shapes for reviews", () => {
    const symbols = new Map<string, RankableSymbol>([
      [
        "response-shape",
        createSymbol("repo:src/server.ts", {
          name: "ToolResponseEnvelope",
          kind: "class",
          exported: true,
          summary: "Defines the stable MCP tool response contract.",
        }),
      ],
      [
        "response-builder",
        createSymbol("repo:src/server.ts", {
          name: "buildToolResponseEnvelope",
          kind: "function",
          exported: false,
          summary: "Builds the stable MCP tool response contract.",
        }),
      ],
    ]);

    const result = rankSymbols(
      ["response-shape", "response-builder"],
      symbols,
      ["tool", "response", "contract"],
      {
        taskType: "review",
        taskText: "Review the tool response contract.",
        repoId: "repo",
      },
    );

    assert.equal(result.ranked[0]?.symbolId, "response-builder");
  });

  it("selects generic tool-review representatives without prompt-specific activation", () => {
    const accepted = new Set([
      "buildFlatToolDescriptors",
      "registerTool",
      "buildToolResponseEnvelope",
      "asStructuredContent",
      "handleRuntimeQueryOutput",
    ]);
    const prohibited = new Set([
      "renderMeta",
      "renderGrid",
      "evaluateSeedResolution",
      "evaluateCase",
    ]);
    const entries: Array<[string, RankableSymbol]> = [
      [
        "descriptor-build",
        createSymbol("repo:src/mcp/tools/tool-descriptors.ts", {
          name: "buildFlatToolDescriptors",
          summary: "Builds stable descriptors for the registered MCP tool surface.",
          searchText: "tool descriptors schema contract deterministic",
        }),
      ],
      [
        "descriptor-register",
        createSymbol("repo:src/mcp/tools/tool-descriptors.ts", {
          name: "registerTool",
          summary: "Registers a tool with its deterministic schema and handler.",
          searchText: "tool registration schema contract",
        }),
      ],
      [
        "server-envelope",
        createSymbol("repo:src/server.ts", {
          name: "buildToolResponseEnvelope",
          summary: "Builds the stable MCP tool response envelope.",
          searchText: "tool response envelope contract structured content",
        }),
      ],
      [
        "server-structured",
        createSymbol("repo:src/server.ts", {
          name: "asStructuredContent",
          summary: "Converts tool output into structured MCP response content.",
          searchText: "structured content response contract",
        }),
      ],
      [
        "runtime-handler",
        createSymbol("repo:src/mcp/tools/runtime-query.ts", {
          name: "handleRuntimeQueryOutput",
          summary: "Handles persisted runtime output queries and safe errors.",
          searchText: "runtime query output safe error response",
        }),
      ],
      ["logo-meta", createSymbol("repo:outputs/logos/meta.js", { name: "renderMeta" })],
      ["logo-grid", createSymbol("repo:outputs/logos/grid.js", { name: "renderGrid" })],
      ["seed-evaluation", createSymbol("repo:scripts/evaluate-seed-resolution.ts", { name: "evaluateSeedResolution" })],
      ["case-evaluation", createSymbol("repo:tests/benchmark/context-quality.test.ts", { name: "evaluateCase" })],
      ["unrelated-edit", createSymbol("repo:src/mcp/tools/search-edit/index.ts", { name: "applyFilePlan" })],
      ["unrelated-projection", createSymbol("repo:src/mcp/context-response-projection.ts", { name: "projectWorkflowResultForModel" })],
    ];
    const symbols = new Map(entries);
    const task = {
      taskType: "review" as const,
      taskText: "Review the current SDL-MCP tool surface for contracts, output noise, deterministic responses, and safe errors.",
      repoId: "repo",
      options: { contextMode: "broad" as const, semantic: true },
    };
    const ranking = rankSymbols(entries.map(([symbolId]) => symbolId), symbols, [], task, {
      seedCandidates: entries.map(([symbolId], sourceRank) => ({
        contextRef: `symbol:${symbolId}`,
        source: sourceRank < 5 ? ("lexical" as const) : ("semantic" as const),
        // The live graph reaches the desired declarations through lower-scored
        // file expansion, while direct semantic noise starts much higher.
        score: sourceRank < 5 ? 0.05 : 1 - (sourceRank - 5) / 20,
        sourceRank,
        ...(sourceRank < 5
          ? {
              expandedFrom: `fileSummary:${entries[sourceRank]?.[1].fileId}`,
              expansionReason: "fileSummary" as const,
            }
          : {}),
      })),
    });

    const selectedNames = selectFinalSymbols(ranking, symbols, task, 10)
      .map((symbolId) => symbols.get(symbolId)?.name);

    assert.ok(selectedNames.filter((name) => name && accepted.has(name)).length >= 4);
    assert.equal(selectedNames.filter((name) => name && prohibited.has(name)).length, 0);
  });

  it("keeps explicit focus below the generic adaptive cutoff", () => {
    const symbols = new Map<string, RankableSymbol>([
      ["generic", createSymbol("repo:src/generic.ts", { name: "genericCandidate" })],
      ["focused", createSymbol("repo:src/focused.ts", { name: "focusedCandidate" })],
    ]);
    const task = {
      taskType: "review" as const,
      taskText: "review contract behavior",
      repoId: "repo",
      options: { contextMode: "precise" as const, focusPaths: ["src/focused.ts"] },
    };
    const ranking = rankSymbols(["generic", "focused"], symbols, [], task, {
      seedCandidates: [
        { contextRef: "symbol:generic", source: "semantic", score: 1, sourceRank: 0 },
        { contextRef: "symbol:focused", source: "lexical", score: 0.01, sourceRank: 1 },
      ],
    });

    assert.deepEqual(selectFinalSymbols(ranking, symbols, task, 5), ["focused"]);
  });

  it("interleaves broad inferred-path coverage after the strongest retrieval seeds", () => {
    const semanticEntries: Array<[string, RankableSymbol]> = Array.from(
      { length: 16 },
      (_, index) => [
        `semantic-${index}`,
        createSymbol(`repo:src/unrelated-${index}.ts`, {
          name: `semanticCandidate${index}`,
        }),
      ],
    );
    const focusEntries: Array<[string, RankableSymbol]> = [
      ["server-a", createSymbol("repo:src/server.ts", { name: "serverBehaviorA" })],
      ["server-b", createSymbol("repo:src/server.ts", { name: "serverBehaviorB" })],
      ["tools-a", createSymbol("repo:src/mcp/tools.ts", { name: "toolsBehaviorA" })],
      ["tools-b", createSymbol("repo:src/mcp/tools.ts", { name: "toolsBehaviorB" })],
      [
        "handler-a",
        createSymbol("repo:src/mcp/tools/handler-a.ts", { name: "handlerBehaviorA" }),
      ],
      [
        "handler-b",
        createSymbol("repo:src/mcp/tools/handler-b.ts", { name: "handlerBehaviorB" }),
      ],
    ];
    const entries = [...semanticEntries, ...focusEntries];
    const symbols = new Map(entries);
    const task = {
      taskType: "review" as const,
      taskText: "Review behavior.",
      repoId: "repo",
      options: {
        contextMode: "broad" as const,
        semantic: true,
        inferredFocusPaths: ["src/server.ts", "src/mcp/tools.ts", "src/mcp/tools/"],
      },
    };
    const ranking = rankSymbols(
      entries.map(([symbolId]) => symbolId),
      symbols,
      [],
      {
        ...task,
        options: { contextMode: "broad" as const, semantic: true },
      },
      {
        seedCandidates: entries.map(([symbolId], sourceRank) => ({
          contextRef: `symbol:${symbolId}`,
          source: sourceRank < semanticEntries.length ? ("semantic" as const) : ("lexical" as const),
          score: sourceRank < semanticEntries.length ? 1 - sourceRank / 100 : 0.01,
          sourceRank,
        })),
      },
    );

    const selected = selectFinalSymbols(ranking, symbols, task, 16);
    const firstTen = selected.slice(0, 10);
    const focusedFirstTen = firstTen.filter((symbolId) =>
      focusEntries.some(([focusId]) => focusId === symbolId),
    );

    assert.equal(selected[0], "semantic-0");
    assert.ok(focusedFirstTen.length >= 4);
    assert.ok(firstTen.some((symbolId) => symbolId.startsWith("server-")));
    assert.ok(firstTen.some((symbolId) => symbolId.startsWith("tools-")));
    assert.ok(firstTen.some((symbolId) => symbolId.startsWith("handler-")));
  });

  it("orders inferred-path coverage by task relevance instead of retrieval prior", () => {
    const semanticEntries: Array<[string, RankableSymbol]> = Array.from(
      { length: 16 },
      (_, index) => [
        `semantic-${index}`,
        createSymbol(`repo:src/unrelated-${index}.ts`, {
          name: `semanticCandidate${index}`,
        }),
      ],
    );
    const focusEntries: Array<[string, RankableSymbol]> = [
      [
        "server-options",
        createSymbol("repo:src/server.ts", {
          name: "MCPServerOptions",
          kind: "class",
          exported: true,
        }),
      ],
      [
        "memory-schema",
        createSymbol("repo:src/server.ts", {
          name: "MemorySurfaceRequestSchema",
          kind: "class",
          exported: true,
        }),
      ],
      [
        "memory-response",
        createSymbol("repo:src/server.ts", {
          name: "MemorySurfaceResponse",
          kind: "class",
          exported: true,
        }),
      ],
      [
        "server-services",
        createSymbol("repo:src/server.ts", {
          name: "MCPServerServices",
          kind: "class",
          exported: true,
        }),
      ],
      [
        "response-builder",
        createSymbol("repo:src/server.ts", {
          name: "buildToolResponseEnvelope",
          kind: "function",
          exported: true,
        }),
      ],
    ];
    const entries = [...semanticEntries, ...focusEntries];
    const symbols = new Map(entries);
    const task = {
      taskType: "review" as const,
      taskText:
        "Review the current SDL-MCP tool surface for contracts, output noise, deterministic responses, and safe errors.",
      repoId: "repo",
      options: {
        contextMode: "broad" as const,
        semantic: true,
        inferredFocusPaths: ["src/server.ts"],
      },
    };
    const ranking = rankSymbols(
      entries.map(([symbolId]) => symbolId),
      symbols,
      ["tool", "surface", "contracts", "output", "deterministic", "responses", "safe", "errors"],
      {
        ...task,
        options: { contextMode: "broad" as const, semantic: true },
      },
      {
        seedCandidates: entries.map(([symbolId], sourceRank) => ({
          contextRef: `symbol:${symbolId}`,
          source: "semantic" as const,
          score:
            sourceRank < semanticEntries.length
              ? 1 - sourceRank / 100
              : symbolId === "response-builder"
                ? 0.01
                : 0.7,
          sourceRank,
        })),
      },
    );

    const selected = selectFinalSymbols(ranking, symbols, task, 16);

    assert.ok(selected.includes("response-builder"));
  });

  it("diversifies generic final cards toward declarations across files", () => {
    const entries: Array<[string, RankableSymbol]> = [
      ["server-module", createSymbol("repo:src/server.ts", { name: "`server.ts`", kind: "module" })],
      ["server-variable", createSymbol("repo:src/server.ts", { name: "progressToken", kind: "variable" })],
      ["server-register", createSymbol("repo:src/server.ts", { name: "registerTool", kind: "method" })],
      ["server-envelope", createSymbol("repo:src/server.ts", { name: "buildToolResponseEnvelope", kind: "function" })],
      ["descriptor-variable", createSymbol("repo:src/mcp/tools/tool-descriptors.ts", { name: "name", kind: "variable" })],
      ["descriptor-build", createSymbol("repo:src/mcp/tools/tool-descriptors.ts", { name: "buildFlatToolDescriptors", kind: "function" })],
      ["runtime-module", createSymbol("repo:src/mcp/tools/runtime-query.ts", { name: "`runtime-query.ts`", kind: "module" })],
      ["runtime-handler", createSymbol("repo:src/mcp/tools/runtime-query.ts", { name: "handleRuntimeQueryOutput", kind: "function" })],
    ];
    const symbols = new Map(entries);
    const task = {
      taskType: "review" as const,
      taskText: "Review tool response contracts.",
      repoId: "repo",
      options: { contextMode: "broad" as const, semantic: true },
    };
    const ranking = rankSymbols(entries.map(([symbolId]) => symbolId), symbols, [], task, {
      seedCandidates: entries.map(([symbolId], sourceRank) => ({
        contextRef: `symbol:${symbolId}`,
        source: "semantic" as const,
        score: 1 - sourceRank / 20,
        sourceRank,
      })),
    });

    const selected = selectFinalSymbols(ranking, symbols, task, 4);
    const selectedSymbols = selected.map((symbolId) => symbols.get(symbolId)!);
    const selectedByFile = new Map<string, number>();
    for (const symbol of selectedSymbols) {
      selectedByFile.set(symbol.fileId, (selectedByFile.get(symbol.fileId) ?? 0) + 1);
    }

    assert.equal(selectedSymbols.filter((symbol) => ["function", "method"].includes(symbol.kind)).length, 4);
    assert.ok([...selectedByFile.values()].every((count) => count <= 2));
  });

  it("rewards novel expansion categories during final selection", () => {
    const entries: Array<[string, RankableSymbol]> = [
      ["a-symbol", createSymbol("repo:src/a.ts")],
      ["b-symbol", createSymbol("repo:src/b.ts")],
      ["c-cluster", createSymbol("repo:src/c.ts")],
      ["d-process", createSymbol("repo:src/d.ts")],
      ["e-file-summary", createSymbol("repo:src/e.ts")],
    ];
    const symbols = new Map(entries);
    const task = {
      taskType: "review" as const,
      taskText: "review candidate behavior",
      repoId: "repo",
      options: { contextMode: "broad" as const },
    };
    const seedCandidates = [
      { contextRef: "symbol:a-symbol", source: "semantic" as const, score: 1, sourceRank: 0 },
      { contextRef: "symbol:b-symbol", source: "semantic" as const, score: 1, sourceRank: 0 },
      { contextRef: "symbol:c-cluster", source: "semantic" as const, score: 1, sourceRank: 0, expandedFrom: "cluster:one", expansionReason: "cluster" },
      { contextRef: "symbol:d-process", source: "semantic" as const, score: 1, sourceRank: 0, expandedFrom: "process:one", expansionReason: "process" },
      { contextRef: "symbol:e-file-summary", source: "semantic" as const, score: 1, sourceRank: 0, expandedFrom: "fileSummary:one", expansionReason: "fileSummary" },
    ];
    const ranking = rankSymbols(
      entries.map(([symbolId]) => symbolId),
      symbols,
      [],
      task,
      { seedCandidates },
    );

    assert.deepEqual(selectFinalSymbols(ranking, symbols, task, 4), [
      "a-symbol",
      "c-cluster",
      "d-process",
      "e-file-summary",
    ]);
  });
});
