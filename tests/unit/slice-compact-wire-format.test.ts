import { describe, it } from "node:test";
import assert from "node:assert";
import { toCompactGraphSlice } from "../../src/mcp/tools/slice.js";
import { SliceBuildRequestSchema } from "../../src/mcp/tools.js";

describe("slice compact wire format", () => {
  it("serializes a standard slice to abbreviated compact keys", () => {
    const slice = {
      repoId: "repo-1",
      versionId: "v1",
      budget: { maxCards: 20, maxEstimatedTokens: 12000 },
      startSymbols: ["sym-1"],
      symbolIndex: ["sym-1", "sym-2"],
      cards: [
        {
          symbolId: "sym-1",
          file: "src/a.ts",
          range: { startLine: 1, startCol: 0, endLine: 5, endCol: 1 },
          kind: "function",
          name: "alpha",
          exported: true,
          deps: { imports: ["x"], calls: ["sym-2"] },
          detailLevel: "compact",
          version: { astFingerprint: "abcdef0123456789" },
        },
      ],
      edges: [[0, 1, "call", 1]],
    } as const;

    const compact = toCompactGraphSlice(slice as any);

    assert.strictEqual(compact.wf, "compact");
    assert.strictEqual(compact.wv, 1);
    assert.strictEqual(compact.rid, "repo-1");
    assert.strictEqual(compact.vid, "v1");
    assert.deepStrictEqual(compact.b, { mc: 20, mt: 12000 });
    assert.deepStrictEqual(compact.ss, ["sym-1"]);
    assert.deepStrictEqual(compact.si, ["sym-1", "sym-2"]);
    assert.deepStrictEqual(compact.e, [[0, 1, "call", 1]]);
    assert.ok(!("cr" in compact), "compact format should omit empty card refs");
    assert.ok(!("f" in compact), "compact format should omit empty frontier");
    assert.ok(!("t" in compact), "compact format should omit empty truncation");

    const card = compact.c[0];
    assert.strictEqual(card.sid, "sym-1");
    assert.strictEqual(card.f, "src/a.ts");
    assert.deepStrictEqual(card.r, [1, 0, 5, 1]);
    assert.strictEqual(card.k, "function");
    assert.strictEqual(card.n, "alpha");
    assert.strictEqual(card.x, true);
    assert.deepStrictEqual(card.d, { i: ["x"], c: ["sym-2"] });
    assert.strictEqual(card.af, "abcdef0123456789");
    assert.ok(!("sig" in card), "signature should be omitted when absent");
    assert.ok(!("sum" in card), "summary should be omitted when absent");
    assert.ok(!("m" in card), "metrics should be omitted when absent");
    assert.ok(!("dl" in card), "compact detail level should be omitted");
  });

  it("includes optional compact fields only when present", () => {
    const slice = {
      repoId: "repo-1",
      versionId: "v1",
      budget: { maxCards: 10, maxEstimatedTokens: 5000 },
      startSymbols: ["sym-1"],
      symbolIndex: ["sym-1"],
      cards: [
        {
          symbolId: "sym-1",
          file: "src/a.ts",
          range: { startLine: 1, startCol: 0, endLine: 5, endCol: 1 },
          kind: "function",
          name: "alpha",
          exported: true,
          visibility: "public",
          summary: "hello",
          invariants: ["i1"],
          sideEffects: ["s1"],
          deps: { imports: [], calls: [] },
          metrics: { fanIn: 1, fanOut: 2, churn30d: 3, testRefs: ["t1"] },
          detailLevel: "full",
          version: { astFingerprint: "abcdef0123456789" },
        },
      ],
      cardRefs: [{ symbolId: "sym-1", etag: "etag-1", detailLevel: "full" }],
      edges: [] as Array<[number, number, "import" | "call" | "config", number]>,
      frontier: [{ symbolId: "sym-1", score: 0.9, why: "calls" }],
      truncation: {
        truncated: true,
        droppedCards: 1,
        droppedEdges: 2,
        howToResume: { type: "token", value: 1234 },
      },
    } as const;

    const compact = toCompactGraphSlice(slice as any);
    const card = compact.c[0];

    assert.strictEqual(card.v, "public");
    assert.strictEqual(card.sum, "hello");
    assert.deepStrictEqual(card.inv, ["i1"]);
    assert.deepStrictEqual(card.se, ["s1"]);
    assert.deepStrictEqual(card.m, { fi: 1, fo: 2, ch: 3, t: ["t1"] });
    assert.strictEqual(card.dl, "full");
    assert.deepStrictEqual(compact.cr, [{ sid: "sym-1", e: "etag-1", dl: "full" }]);
    assert.deepStrictEqual(compact.f, [{ sid: "sym-1", s: 0.9, w: "calls" }]);
    assert.deepStrictEqual(compact.t, {
      tr: true,
      dc: 1,
      de: 2,
      res: { t: "token", v: 1234 },
    });
  });
});

describe("slice build request wire-format negotiation", () => {
  it("requires version=1 for compact wire format", () => {
    const withoutVersion = SliceBuildRequestSchema.safeParse({
      repoId: "repo-1",
      taskText: "review slice behavior",
      wireFormat: "compact",
    });
    assert.strictEqual(withoutVersion.success, false);

    const withVersion = SliceBuildRequestSchema.safeParse({
      repoId: "repo-1",
      taskText: "review slice behavior",
      wireFormat: "compact",
      wireFormatVersion: 1,
    });
    assert.strictEqual(withVersion.success, true);
  });

  it("keeps standard wire format backward compatible", () => {
    const standard = SliceBuildRequestSchema.safeParse({
      repoId: "repo-1",
      taskText: "review slice behavior",
    });
    assert.strictEqual(standard.success, true);
  });
});
