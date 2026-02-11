import { describe, it } from "node:test";
import assert from "node:assert";
import {
  toCompactGraphSlice,
  toCompactGraphSliceV2,
} from "../../src/mcp/tools/slice.js";
import { SliceBuildRequestSchema } from "../../src/mcp/tools.js";

describe("slice compact wire format v1", () => {
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

describe("slice compact wire format v2", () => {
  it("serializes with file path lookup, integer edge types, and no sid/rid", () => {
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
          version: { astFingerprint: "abcdef0123456789abcdef0123456789" },
        },
        {
          symbolId: "sym-2",
          file: "src/a.ts",
          range: { startLine: 10, startCol: 0, endLine: 15, endCol: 1 },
          kind: "function",
          name: "beta",
          exported: false,
          deps: { imports: [], calls: [] },
          detailLevel: "compact",
          version: { astFingerprint: "fedcba9876543210fedcba9876543210" },
        },
      ],
      edges: [[0, 1, "call", 1]],
    } as const;

    const compact = toCompactGraphSliceV2(slice as any);

    assert.strictEqual(compact.wf, "compact");
    assert.ok(!("wv" in compact), "v2 should omit wv (inferred from wf:compact)");
    assert.ok(!("rid" in compact), "v2 should omit rid");
    assert.strictEqual(compact.vid, "v1");
    assert.deepStrictEqual(compact.b, { mc: 20, mt: 12000 });
    assert.deepStrictEqual(compact.ss, ["sym-1"]);
    assert.deepStrictEqual(compact.si, ["sym-1", "sym-2"]);

    // File path lookup table - deduplicated
    assert.deepStrictEqual(compact.fp, ["src/a.ts"]);

    // Edge type lookup table - present when edges exist
    assert.deepStrictEqual(compact.et, ["import", "call", "config"]);

    // Edges use integer edge type index (call = 1)
    assert.deepStrictEqual(compact.e, [[0, 1, 1, 1]]);

    // Cards use fi (file index) instead of f (file path), no sid
    const card0 = compact.c[0];
    assert.ok(!("sid" in card0), "v2 card should not have sid");
    assert.ok(!("f" in card0), "v2 card should not have f (file path)");
    assert.strictEqual(card0.fi, 0);
    assert.strictEqual(card0.n, "alpha");
    assert.strictEqual(card0.x, true);

    // astFingerprint omitted for compact cards (only included for full detail)
    assert.ok(!("af" in card0), "v2 compact card should omit af");

    const card1 = compact.c[1];
    assert.strictEqual(card1.fi, 0); // Same file
    assert.strictEqual(card1.n, "beta");
    assert.ok(!("af" in card1), "v2 compact card should omit af");
  });

  it("uses card index for frontier and abbreviates why codes", () => {
    const slice = {
      repoId: "repo-1",
      versionId: "v1",
      budget: { maxCards: 10, maxEstimatedTokens: 5000 },
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
          deps: { imports: [], calls: [] },
          detailLevel: "compact",
          version: { astFingerprint: "abcdef0123456789" },
        },
      ],
      edges: [] as Array<[number, number, "import" | "call" | "config", number]>,
      frontier: [
        { symbolId: "sym-1", score: 0.9, why: "calls" },
        { symbolId: "sym-2", score: 0.5, why: "entry symbol" },
      ],
      cardRefs: [{ symbolId: "sym-1", etag: "etag-1", detailLevel: "full" }],
    } as const;

    const compact = toCompactGraphSliceV2(slice as any);

    // Frontier uses ci (card index) and abbreviated why codes
    assert.ok(compact.f, "frontier should be present");
    assert.strictEqual(compact.f![0].ci, 0); // sym-1 is at index 0 in symbolIndex
    assert.strictEqual(compact.f![0].w, "c"); // "calls" -> "c"
    assert.strictEqual(compact.f![1].ci, 1); // sym-2 is at index 1
    assert.strictEqual(compact.f![1].w, "e"); // "entry symbol" -> "e"

    // Card refs use ci (card index)
    assert.ok(compact.cr, "card refs should be present");
    assert.strictEqual(compact.cr![0].ci, 0);
    assert.strictEqual(compact.cr![0].e, "etag-1");
    assert.strictEqual(compact.cr![0].dl, "full");
  });

  it("omits truncation when not truncated", () => {
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
          deps: { imports: [], calls: [] },
          detailLevel: "compact",
          version: { astFingerprint: "abcdef01" },
        },
      ],
      edges: [] as Array<[number, number, "import" | "call" | "config", number]>,
      truncation: {
        truncated: false,
        droppedCards: 0,
        droppedEdges: 0,
        howToResume: null,
      },
    } as const;

    const compact = toCompactGraphSliceV2(slice as any);
    assert.ok(!("t" in compact), "v2 should omit truncation when not truncated");
  });

  it("includes truncation when actually truncated", () => {
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
          deps: { imports: [], calls: [] },
          detailLevel: "compact",
          version: { astFingerprint: "abcdef01" },
        },
      ],
      edges: [] as Array<[number, number, "import" | "call" | "config", number]>,
      truncation: {
        truncated: true,
        droppedCards: 5,
        droppedEdges: 3,
        howToResume: { type: "token", value: 2000 },
      },
    } as const;

    const compact = toCompactGraphSliceV2(slice as any);
    assert.ok(compact.t, "v2 should include truncation when truncated");
    assert.deepStrictEqual(compact.t, {
      tr: true,
      dc: 5,
      de: 3,
      res: { t: "token", v: 2000 },
    });
  });

  it("deduplicates file paths across cards from different files", () => {
    const slice = {
      repoId: "repo-1",
      versionId: "v1",
      budget: { maxCards: 10, maxEstimatedTokens: 5000 },
      startSymbols: ["sym-1"],
      symbolIndex: ["sym-1", "sym-2", "sym-3"],
      cards: [
        {
          symbolId: "sym-1",
          file: "src/a.ts",
          range: { startLine: 1, startCol: 0, endLine: 5, endCol: 1 },
          kind: "function",
          name: "alpha",
          exported: true,
          deps: { imports: [], calls: [] },
          detailLevel: "compact",
          version: { astFingerprint: "aaaa0000" },
        },
        {
          symbolId: "sym-2",
          file: "src/b.ts",
          range: { startLine: 1, startCol: 0, endLine: 5, endCol: 1 },
          kind: "function",
          name: "beta",
          exported: true,
          deps: { imports: [], calls: [] },
          detailLevel: "compact",
          version: { astFingerprint: "bbbb0000" },
        },
        {
          symbolId: "sym-3",
          file: "src/a.ts",
          range: { startLine: 10, startCol: 0, endLine: 15, endCol: 1 },
          kind: "function",
          name: "gamma",
          exported: true,
          deps: { imports: [], calls: [] },
          detailLevel: "compact",
          version: { astFingerprint: "cccc0000" },
        },
      ],
      edges: [] as Array<[number, number, "import" | "call" | "config", number]>,
    } as const;

    const compact = toCompactGraphSliceV2(slice as any);
    assert.deepStrictEqual(compact.fp, ["src/a.ts", "src/b.ts"]);
    assert.strictEqual(compact.c[0].fi, 0); // src/a.ts
    assert.strictEqual(compact.c[1].fi, 1); // src/b.ts
    assert.strictEqual(compact.c[2].fi, 0); // src/a.ts (deduplicated)
  });
});

describe("slice build request wire-format negotiation", () => {
  it("accepts compact wire format without version (defaults to v2)", () => {
    const withoutVersion = SliceBuildRequestSchema.safeParse({
      repoId: "repo-1",
      taskText: "review slice behavior",
      wireFormat: "compact",
    });
    assert.strictEqual(withoutVersion.success, true);
  });

  it("accepts compact wire format with version 1", () => {
    const withVersion = SliceBuildRequestSchema.safeParse({
      repoId: "repo-1",
      taskText: "review slice behavior",
      wireFormat: "compact",
      wireFormatVersion: 1,
    });
    assert.strictEqual(withVersion.success, true);
  });

  it("accepts compact wire format with version 2", () => {
    const withVersion2 = SliceBuildRequestSchema.safeParse({
      repoId: "repo-1",
      taskText: "review slice behavior",
      wireFormat: "compact",
      wireFormatVersion: 2,
    });
    assert.strictEqual(withVersion2.success, true);
  });

  it("keeps standard wire format backward compatible", () => {
    const standard = SliceBuildRequestSchema.safeParse({
      repoId: "repo-1",
      taskText: "review slice behavior",
    });
    assert.strictEqual(standard.success, true);
  });
});
