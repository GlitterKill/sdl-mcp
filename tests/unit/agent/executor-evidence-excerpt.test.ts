import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeCardRungSymbolLimit,
  buildSkeletonEvidenceExcerpt,
  computeEvidenceRungSymbolLimit,
  selectBoundedCardEvidenceItems,
} from "../../../dist/agent/executor.js";
import type {
  AgentTask,
  ContextSeedCandidate,
} from "../../../dist/agent/types.js";
import { estimateTokens } from "../../../dist/util/tokenize.js";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    taskType: "review",
    taskText: "Find tests for deterministic tool output",
    repoId: "repo-1",
    ...overrides,
  };
}

function lexicalSeeds(count: number): ContextSeedCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    contextRef: `symbol:seed-${index}`,
    source: "lexical" as const,
    score: 0.9,
    sourceRank: index,
    expansionReason: "namedConcept",
  }));
}

describe("executor evidence excerpts", () => {
  it("summarizes useful imports and late declarations within bounded output", () => {
    const skeleton = `
      import { describe, it, before, after } from "node:test";
      import assert from "node:assert/strict";
      import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
      import { projectToolResultForModelContent } from "../../dist/mcp/context-response-projection.js";
      import { handleSearchEdit } from "../../dist/mcp/tools/search-edit/index.js";

      interface ServerHandle {}
      interface Leg {}
      interface VolatileFinding {}
      function writeConfig(): void {}
      function ensureBuiltServer(): void {}
      async function spawnServer(): Promise<ServerHandle> {}
      function canonical(): string { return ""; }
      function sha256(): string { return ""; }
      function callKey(): string { return ""; }
      function materializeArgs(): unknown { return null; }
      async function callToolStrict(): Promise<void> {}
      async function setupFixtureRepo(): Promise<void> {}
      async function runLeg(): Promise<Leg> {}
      function reportMismatch(): string { return ""; }
    `;

    const excerpt = buildSkeletonEvidenceExcerpt(skeleton);

    assert.match(excerpt, /projectToolResultForModelContent/);
    assert.match(excerpt, /handleSearchEdit/);
    assert.match(excerpt, /runLeg/);
    assert.ok(excerpt.length <= 480, `excerpt was ${excerpt.length} chars`);
  });

  it("retains bounded structural signatures and members", () => {
    const excerpt = buildSkeletonEvidenceExcerpt(
      "export interface Service { run(input: Request): Promise<Response>; stop(): void; }",
      "Review Service behavior",
    );

    assert.match(excerpt, /run\(input: Request\): Promise<Response>/);
    assert.match(excerpt, /stop\(\): void/);
  });

  it("promotes task-affine declarations from late in a file skeleton", () => {
    const genericDeclarations = Array.from(
      { length: 80 },
      (_, index) => `function ToolHelper${index}(): void {}`,
    ).join("\n");
    const excerpt = buildSkeletonEvidenceExcerpt(
      `${genericDeclarations}\nexport class MCPServer {}`,
      "Review MCP tool dispatch and formatting",
    );

    assert.match(excerpt, /MCPServer/);
    assert.ok(excerpt.length <= 480, `excerpt was ${excerpt.length} chars`);
  });

  it("keeps eight precise skeleton excerpts inside a response budget", () => {
    const skeleton = `${Array.from(
      { length: 20 },
      (_, index) => `interface Contract${index} { run${index}(): void; }`,
    ).join("\n")}\nasync function runLeg(): Promise<void> {}`;
    const combined = Array.from({ length: 8 }, () =>
      buildSkeletonEvidenceExcerpt(skeleton, "Review deterministic output"),
    ).join("\n");

    assert.ok(
      estimateTokens(combined) <= 1400,
      `eight excerpts used ~${estimateTokens(combined)} tokens`,
    );
  });

  it("adapts only forced precise explicit-scope skeleton coverage", () => {
    const forcedPrecise = task({
      options: {
        contextMode: "precise",
        focusPaths: ["tests"],
        semantic: true,
      },
    });

    assert.equal(
      computeEvidenceRungSymbolLimit(forcedPrecise, lexicalSeeds(7), 5),
      7,
    );
    assert.equal(
      computeEvidenceRungSymbolLimit(
        forcedPrecise,
        lexicalSeeds(7).map((candidate) => ({
          ...candidate,
          source: "semantic",
          score: 0.35,
        })),
        5,
      ),
      7,
      "semantic-first duplicates retain named-concept coverage",
    );
    assert.equal(
      computeEvidenceRungSymbolLimit(forcedPrecise, lexicalSeeds(12), 5),
      8,
    );
    assert.equal(
      computeEvidenceRungSymbolLimit(
        task({ options: { contextMode: "broad", focusPaths: ["tests"] } }),
        lexicalSeeds(7),
        5,
      ),
      5,
    );
  });

  it("bounds multi-concept precise cards after named coverage is complete", () => {
    const forcedPrecise = task({
      options: {
        contextMode: "precise",
        focusPaths: ["tests"],
        semantic: true,
      },
    });

    assert.equal(
      computeCardRungSymbolLimit(forcedPrecise, lexicalSeeds(7)),
      9,
    );
    assert.equal(
      computeCardRungSymbolLimit(forcedPrecise, lexicalSeeds(4)),
      20,
    );
    assert.equal(
      computeCardRungSymbolLimit(
        task({
          options: {
            contextMode: "precise",
            focusPaths: ["tests"],
            semantic: false,
          },
        }),
        lexicalSeeds(7),
      ),
      10,
    );
  });

  it("caps repeated card files while retaining a preserved named seed", () => {
    const items = [
      { symbolId: "a", fileId: "shared" },
      { symbolId: "b", fileId: "shared" },
      { symbolId: "c", fileId: "shared" },
      { symbolId: "named", fileId: "shared" },
      { symbolId: "other", fileId: "other" },
    ];

    assert.deepStrictEqual(
      selectBoundedCardEvidenceItems(items, new Set(["named"]), 2).map(
        ({ symbolId }) => symbolId,
      ),
      ["a", "named", "other"],
    );

    assert.deepStrictEqual(
      selectBoundedCardEvidenceItems(
        items,
        new Set(items.map(({ symbolId }) => symbolId)),
        2,
      ).map(({ symbolId }) => symbolId),
      ["a", "b", "other"],
      "the same-file cap stays hard when several lexical items are preserved",
    );
  });
});
