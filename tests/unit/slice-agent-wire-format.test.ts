import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toAgentGraphSlice } from "../../dist/mcp/tools/slice-wire-format.js";
import type { GraphSlice } from "../../dist/domain/types.js";

function makeMockSlice(overrides?: Partial<GraphSlice>): GraphSlice {
  return {
    repoId: "test-repo",
    versionId: "v123",
    budget: { maxCards: 10, maxEstimatedTokens: 2000 },
    startSymbols: ["sym-1"],
    symbolIndex: ["sym-1", "sym-2", "sym-3"],
    cards: [
      {
        symbolId: "sym-1",
        file: "src/foo.ts",
        range: { startLine: 10, startCol: 0, endLine: 20, endCol: 1 },
        kind: "function",
        name: "doSomething",
        exported: true,
        signature: { params: [{ name: "x", type: ": number" }] },
        summary: "Does something with a number",
        deps: {
          imports: [{ symbolId: "sym-2", confidence: 0.8 }],
          calls: [{ symbolId: "sym-3", confidence: 1.0 }],
        },
        metrics: { fanIn: 5, fanOut: 2, churn30d: 3, testRefs: [] },
        detailLevel: "full" as const,
        version: { astFingerprint: "abc123" },
      },
      {
        symbolId: "sym-2",
        file: "src/bar.ts",
        range: { startLine: 1, startCol: 0, endLine: 5, endCol: 1 },
        kind: "interface",
        name: "Config",
        exported: true,
        deps: { imports: [], calls: [] },
        metrics: { fanIn: 10, fanOut: 0, churn30d: 1, testRefs: [] },
        detailLevel: "full" as const,
        version: { astFingerprint: "def456" },
      },
      {
        symbolId: "sym-3",
        file: "src/foo.ts",
        range: { startLine: 25, startCol: 0, endLine: 30, endCol: 1 },
        kind: "function",
        name: "helper",
        exported: false,
        deps: { imports: [], calls: [] },
        metrics: { fanIn: 1, fanOut: 0, churn30d: 0, testRefs: [] },
        detailLevel: "full" as const,
        version: { astFingerprint: "ghi789" },
      },
    ],
    edges: [
      [0, 1, "import", 0.8],
      [0, 2, "call", 1.0],
    ] as GraphSlice["edges"],
    memories: [
      {
        memoryId: "mem-1",
        type: "bugfix" as const,
        title: "Fixed doSomething edge case",
        content: "Long detailed content about the bugfix...",
        confidence: 0.9,
        stale: false,
        linkedSymbols: ["sym-1"],
        tags: ["bugfix"],
      },
      {
        memoryId: "mem-2",
        type: "task_context" as const,
        title: "Unrelated review notes",
        content: "These notes are about something else entirely...",
        confidence: 0.8,
        stale: false,
        linkedSymbols: ["sym-999"],
        tags: ["review"],
      },
    ],
    ...overrides,
  } as GraphSlice;
}

describe("toAgentGraphSlice", () => {
  it("produces readable keys", () => {
    const result = toAgentGraphSlice(makeMockSlice());
    assert.equal(result.wireFormat, "agent");
    assert.ok(Array.isArray(result.cards));
    const card = result.cards[0];
    assert.equal(card.name, "doSomething");
    assert.equal(card.kind, "function");
    assert.equal(card.file, "src/foo.ts");
    assert.deepEqual(card.lines, { start: 10, end: 20 });
    assert.equal(card.exported, true);
    assert.ok(card.summary);
  });

  it("edges are objects not arrays", () => {
    const result = toAgentGraphSlice(makeMockSlice());
    assert.ok(Array.isArray(result.edges));
    for (const edge of result.edges) {
      assert.equal(typeof edge.from, "string");
      assert.equal(typeof edge.to, "string");
      assert.equal(typeof edge.type, "string");
      assert.equal(typeof edge.confidence, "number");
    }
    assert.equal(result.edges[0].from, "doSomething");
    assert.equal(result.edges[0].to, "Config");
    assert.equal(result.edges[0].type, "import");
    assert.equal(result.edges[0].confidence, 0.8);
  });

  it("file paths are inline on each card", () => {
    const result = toAgentGraphSlice(makeMockSlice());
    // No fp (file path index) array
    assert.equal((result as Record<string, unknown>).fp, undefined);
    // Each card has file string
    for (const card of result.cards) {
      assert.equal(typeof card.file, "string");
      assert.ok(card.file.length > 0);
    }
  });

  it("filters irrelevant memories", () => {
    const result = toAgentGraphSlice(makeMockSlice());
    // Only mem-1 should be included (linkedSymbols: ["sym-1"])
    // mem-2 linked to sym-999 which is not in the slice
    assert.ok(result.memories);
    assert.equal(result.memories!.length, 1);
    assert.equal(result.memories![0].memoryId, "mem-1");
  });

  it("memory content is excluded", () => {
    const result = toAgentGraphSlice(makeMockSlice());
    assert.ok(result.memories);
    for (const mem of result.memories!) {
      assert.equal((mem as Record<string, unknown>).content, undefined);
      assert.ok(mem.title);
      assert.ok(mem.type);
      assert.ok(mem.memoryId);
      assert.ok(Array.isArray(mem.tags));
    }
  });

  it("seed symbols use names", () => {
    const result = toAgentGraphSlice(makeMockSlice());
    assert.ok(Array.isArray(result.seedSymbols));
    assert.equal(result.seedSymbols[0], "doSomething");
  });

  it("handles empty slice", () => {
    const result = toAgentGraphSlice(
      makeMockSlice({ cards: [], edges: [], memories: [], startSymbols: [] }),
    );
    assert.deepEqual(result.cards, []);
    assert.deepEqual(result.edges, []);
    assert.equal(result.memories, undefined); // empty array -> omitted
    assert.deepEqual(result.seedSymbols, []);
  });

  it("handles cards with unresolved deps", () => {
    const slice = makeMockSlice();
    // Add a dep that references a symbol not in the slice
    (slice.cards[0].deps as { imports: Array<{ symbolId: string; confidence?: number }> }).imports.push({
      symbolId: "unknown-sym-id",
      confidence: 0.5,
    });
    const result = toAgentGraphSlice(slice);
    const card = result.cards[0];
    // The unresolved dep should use the raw symbolId as fallback
    const unresolvedImport = card.imports.find((i) => i.name === "unknown-sym-id");
    assert.ok(unresolvedImport, "unresolved dep should use raw symbolId as name");
  });

  it("flattens signature to readable string", () => {
    const result = toAgentGraphSlice(makeMockSlice());
    const card = result.cards[0];
    assert.equal(card.signature, "(x: number)");
  });

  it("omits confidence=1 from deps", () => {
    const result = toAgentGraphSlice(makeMockSlice());
    const card = result.cards[0];
    // calls have confidence 1.0, should not include confidence key
    assert.equal(card.calls[0].confidence, undefined);
    // imports have confidence 0.8, should include it
    assert.equal(card.imports[0].confidence, 0.8);
  });
});
