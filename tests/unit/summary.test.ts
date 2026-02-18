import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildContextSummary,
  detectSummaryScope,
  renderContextSummary,
} from "../../src/mcp/summary.js";

describe("context summary", () => {
  it("auto-detects summary scope from query patterns", () => {
    assert.strictEqual(detectSummaryScope("src/mcp/tools/repo.ts"), "file");
    assert.strictEqual(detectSummaryScope("analyze stale watcher issue"), "task");
    assert.strictEqual(detectSummaryScope("handleRepoStatus"), "symbol");
  });

  it("builds deterministic summary output for identical inputs", () => {
    const input = {
      repoId: "sdl-mcp",
      query: "repo status",
      scope: "task" as const,
      budget: 600,
      indexVersion: "v1",
      keySymbols: [
        {
          symbolId: "a",
          name: "handleRepoStatus",
          kind: "function" as const,
          signature: "handleRepoStatus(args): RepoStatusResponse",
          summary: "Returns repository indexing status.",
        },
      ],
      dependencyGraph: [
        {
          fromSymbolId: "a",
          toSymbolIds: ["b", "c"],
        },
      ],
      riskAreas: [
        {
          symbolId: "a",
          name: "handleRepoStatus",
          reasons: ["high fan-in"],
        },
      ],
      filesTouched: [
        {
          file: "src/mcp/tools/repo.ts",
          symbolCount: 1,
        },
      ],
    };

    const first = buildContextSummary(input);
    const second = buildContextSummary(input);

    assert.deepStrictEqual(first, second);
  });

  it("enforces token budget within 5 percent", () => {
    const summary = buildContextSummary({
      repoId: "sdl-mcp",
      query: "repo",
      scope: "symbol",
      budget: 120,
      indexVersion: "v1",
      keySymbols: Array.from({ length: 15 }).map((_, idx) => ({
        symbolId: `s-${idx}`,
        name: `symbol${idx}`,
        kind: "function" as const,
        signature: `symbol${idx}(): void`,
        summary: "Generated test summary text.",
      })),
      dependencyGraph: [],
      riskAreas: [],
      filesTouched: [],
    });

    assert.ok(summary.metadata.summaryTokens <= Math.ceil(120 * 1.05));
    assert.ok(summary.metadata.truncated);
  });

  it("renders markdown with expected section headers", () => {
    const summary = buildContextSummary({
      repoId: "sdl-mcp",
      query: "repo",
      scope: "symbol",
      budget: 600,
      indexVersion: "v1",
      keySymbols: [],
      dependencyGraph: [],
      riskAreas: [],
      filesTouched: [],
    });

    const rendered = renderContextSummary(summary, "markdown");
    assert.match(rendered, /^# Context:/);
    assert.match(rendered, /## Key Symbols/);
    assert.match(rendered, /## Dependency Graph/);
    assert.match(rendered, /## Risk Areas/);
    assert.match(rendered, /## Files Touched/);
  });
});
