import { describe, it } from "node:test";
import assert from "node:assert";
import {
  toCompactGraphSliceV2,
  toCompactGraphSliceV3,
  decodeCompactGraphSliceV3ToV2,
  decodeCompactEdgesV2ToV1,
  decodeCompactEdgesV3ToV1,
} from "../../src/mcp/tools/slice.js";
import {
  SliceBuildRequestSchema,
  CompactGraphSliceV2Schema,
  CompactGraphSliceV3Schema,
  CompactGroupedEdgeV3Schema,
} from "../../src/mcp/tools.js";
import type { GraphSlice, CompressedEdge } from "../../src/mcp/types.js";
import type {
  CompactGraphSliceV3,
  CompactGroupedEdgeV3,
} from "../../src/mcp/tools.js";

const SYM1_FULL =
  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const SYM2_FULL =
  "f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b9a0f1e2";
const SYM3_FULL =
  "0102030405060708091011121314151617181920212223242526272829303132";
const SYM4_FULL =
  "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const SYM1_SHORT = SYM1_FULL.slice(0, 16);

function makeSlice(edges: CompressedEdge[]): GraphSlice {
  return {
    repoId: "repo-1",
    versionId: "v1",
    budget: { maxCards: 10, maxEstimatedTokens: 5000 },
    startSymbols: [SYM1_FULL],
    symbolIndex: [SYM1_FULL, SYM2_FULL, SYM3_FULL, SYM4_FULL],
    cards: [
      {
        symbolId: SYM1_FULL,
        file: "src/a.ts",
        range: { startLine: 1, startCol: 0, endLine: 5, endCol: 1 },
        kind: "function",
        name: "alpha",
        exported: true,
        deps: { imports: [], calls: [] },
        detailLevel: "compact",
        version: { astFingerprint: "abcdef01" },
      },
      {
        symbolId: SYM2_FULL,
        file: "src/b.ts",
        range: { startLine: 1, startCol: 0, endLine: 5, endCol: 1 },
        kind: "function",
        name: "beta",
        exported: true,
        deps: { imports: [], calls: [] },
        detailLevel: "compact",
        version: { astFingerprint: "fedcba01" },
      },
    ],
    edges,
  } as unknown as GraphSlice;
}

describe("compact wire format v3", () => {
  it("groups edges by source symbol", () => {
    const slice = makeSlice([
      [0, 1, "call", 1],
      [0, 2, "call", 1],
      [0, 3, "import", 0.6],
      [1, 2, "import", 0.8],
    ]);

    const compact = toCompactGraphSliceV3(slice);

    assert.strictEqual(compact.wf, "compact");
    assert.strictEqual(compact.wv, 3);
    assert.strictEqual(compact.e.length, 2, "should have 2 grouped edges");

    const edge0 = compact.e.find((e) => e.from === 0);
    assert.ok(edge0, "should have edge from 0");
    assert.deepStrictEqual(edge0!.c, [1, 2], "calls from 0");
    assert.deepStrictEqual(edge0!.i, [3], "imports from 0");
    assert.ok(!edge0!.cf, "no config edges from 0");

    const edge1 = compact.e.find((e) => e.from === 1);
    assert.ok(edge1, "should have edge from 1");
    assert.deepStrictEqual(edge1!.i, [2], "imports from 1");
    assert.ok(!edge1!.c, "no calls from 1");
  });

  it("omits empty edge type arrays", () => {
    const slice = makeSlice([[0, 1, "call", 1]]);

    const compact = toCompactGraphSliceV3(slice);

    const edge0 = compact.e.find((e) => e.from === 0);
    assert.ok(edge0);
    assert.deepStrictEqual(edge0!.c, [1]);
    assert.ok(!edge0!.i, "should omit empty imports array");
    assert.ok(!edge0!.cf, "should omit empty config array");
  });

  it("produces smaller byte size on dense graphs", () => {
    const denseEdges: CompressedEdge[] = [];
    for (let from = 0; from < 20; from++) {
      for (let to = 0; to < 20; to++) {
        if (from !== to) {
          denseEdges.push([from, to, "call", 1]);
        }
      }
    }

    const symbolIndex = Array.from(
      { length: 20 },
      (_, i) => `sym${i.toString().padStart(60, "0")}`,
    );

    const denseSlice: GraphSlice = {
      repoId: "repo-1",
      versionId: "v1",
      budget: { maxCards: 100, maxEstimatedTokens: 50000 },
      startSymbols: [symbolIndex[0]],
      symbolIndex,
      cards: symbolIndex.map((id, i) => ({
        symbolId: id,
        file: `src/file${i}.ts`,
        range: { startLine: 1, startCol: 0, endLine: 5, endCol: 1 },
        kind: "function" as const,
        name: `func${i}`,
        exported: true,
        deps: { imports: [] as string[], calls: [] as string[] },
        detailLevel: "compact" as const,
        version: { astFingerprint: "abcdef01" },
      })),
      edges: denseEdges,
    } as unknown as GraphSlice;

    const v2 = toCompactGraphSliceV2(denseSlice);
    const v3 = toCompactGraphSliceV3(denseSlice);

    const v2Bytes = JSON.stringify(v2).length;
    const v3Bytes = JSON.stringify(v3).length;
    const reduction = ((v2Bytes - v3Bytes) / v2Bytes) * 100;

    assert.ok(
      reduction >= 35,
      `v3 should reduce byte size by >= 35%, got ${reduction.toFixed(1)}% (v2: ${v2Bytes}, v3: ${v3Bytes})`,
    );
  });

  it("validates against v3 schema", () => {
    const slice = makeSlice([[0, 1, "call", 1]]);
    const compact = toCompactGraphSliceV3(slice);

    const result = CompactGraphSliceV3Schema.safeParse(compact);
    assert.strictEqual(
      result.success,
      true,
      `Schema validation failed: ${result.success ? "" : JSON.stringify((result as any).error)}`,
    );
  });
});

describe("v3 to v2 decode", () => {
  it("round-trips edges correctly", () => {
    const originalEdges: CompressedEdge[] = [
      [0, 1, "call", 1],
      [0, 2, "import", 0.6],
      [1, 2, "config", 0.8],
    ];

    const slice = makeSlice(originalEdges);
    const v3 = toCompactGraphSliceV3(slice);
    const v2 = decodeCompactGraphSliceV3ToV2(v3);

    assert.strictEqual(v2.wf, "compact");
    assert.strictEqual(v2.wv, 2);
    assert.strictEqual(v2.e.length, 3, "should have 3 expanded edges");

    const decodedEdges = v2.e.map(([from, to, type, weight]) => [
      from,
      to,
      type,
      weight,
    ]);
    assert.ok(
      decodedEdges.some(([f, t, type]) => f === 0 && t === 1 && type === 1),
    );
    assert.ok(
      decodedEdges.some(([f, t, type]) => f === 0 && t === 2 && type === 0),
    );
    assert.ok(
      decodedEdges.some(([f, t, type]) => f === 1 && t === 2 && type === 2),
    );
  });

  it("preserves all other fields", () => {
    const slice = makeSlice([[0, 1, "call", 1]]);
    slice.truncation = {
      truncated: true,
      droppedCards: 5,
      droppedEdges: 3,
      howToResume: { type: "token", value: 1000 },
    };
    slice.frontier = [{ symbolId: SYM1_FULL, score: 0.9, why: "calls" }];
    slice.cardRefs = [
      { symbolId: SYM1_FULL, etag: "etag-1", detailLevel: "full" },
    ];

    const v3 = toCompactGraphSliceV3(slice);
    const v2 = decodeCompactGraphSliceV3ToV2(v3);

    assert.strictEqual(v2.vid, v3.vid);
    assert.deepStrictEqual(v2.b, v3.b);
    assert.deepStrictEqual(v2.ss, v3.ss);
    assert.deepStrictEqual(v2.si, v3.si);
    assert.deepStrictEqual(v2.fp, v3.fp);
    assert.deepStrictEqual(v2.cr, v3.cr);
    assert.deepStrictEqual(v2.f, v3.f);
    assert.deepStrictEqual(v2.t, v3.t);
  });
});

describe("v2/v3 to v1 edge decode", () => {
  it("decodes v2 edges to v1 format", () => {
    const v2Edges: Array<[number, number, number, number]> = [
      [0, 1, 0, 0.6],
      [0, 2, 1, 1],
      [1, 2, 2, 0.8],
    ];

    const v1Edges = decodeCompactEdgesV2ToV1(v2Edges);

    assert.deepStrictEqual(v1Edges[0], [0, 1, "import", 0.6]);
    assert.deepStrictEqual(v1Edges[1], [0, 2, "call", 1]);
    assert.deepStrictEqual(v1Edges[2], [1, 2, "config", 0.8]);
  });

  it("decodes v2 edges with custom type order", () => {
    const v2Edges: Array<[number, number, number, number]> = [[0, 1, 1, 1]];
    const customTypes = ["config", "import", "call"];

    const v1Edges = decodeCompactEdgesV2ToV1(v2Edges, customTypes);

    assert.deepStrictEqual(v1Edges[0], [0, 1, "import", 1]);
  });

  it("decodes v3 grouped edges to v1 format", () => {
    const v3Edges: CompactGroupedEdgeV3[] = [
      { from: 0, c: [1, 2], i: [3] },
      { from: 1, cf: [2] },
    ];

    const v1Edges = decodeCompactEdgesV3ToV1(v3Edges);

    assert.strictEqual(v1Edges.length, 4);
    assert.deepStrictEqual(v1Edges[0], [0, 3, "import", 1]);
    assert.deepStrictEqual(v1Edges[1], [0, 1, "call", 1]);
    assert.deepStrictEqual(v1Edges[2], [0, 2, "call", 1]);
    assert.deepStrictEqual(v1Edges[3], [1, 2, "config", 1]);
  });
});

describe("wire format negotiation", () => {
  it("accepts compact wire format with version 3", () => {
    const result = SliceBuildRequestSchema.safeParse({
      repoId: "repo-1",
      taskText: "review code",
      wireFormat: "compact",
      wireFormatVersion: 3,
    });
    assert.strictEqual(result.success, true);
  });

  it("defaults to v2 when wireFormatVersion not specified", () => {
    const result = SliceBuildRequestSchema.safeParse({
      repoId: "repo-1",
      taskText: "review code",
      wireFormat: "compact",
    });
    assert.strictEqual(result.success, true);
    if (result.success) {
      assert.strictEqual(result.data.wireFormatVersion, undefined);
    }
  });

  it("rejects invalid wire format versions", () => {
    const result = SliceBuildRequestSchema.safeParse({
      repoId: "repo-1",
      taskText: "review code",
      wireFormat: "compact",
      wireFormatVersion: 4,
    });
    assert.strictEqual(result.success, false);
  });
});

describe("malformed payload rejection", () => {
  it("rejects invalid grouped edge format - missing from", () => {
    const payload = { c: [1, 2], i: [3] };
    const result = CompactGroupedEdgeV3Schema.safeParse(payload);
    assert.strictEqual(result.success, false);
  });

  it("rejects invalid grouped edge format - negative from", () => {
    const payload = { from: -1, c: [1, 2] };
    const result = CompactGroupedEdgeV3Schema.safeParse(payload);
    assert.strictEqual(result.success, false);
  });

  it("rejects invalid grouped edge format - negative targets", () => {
    const payload = { from: 0, c: [-1] };
    const result = CompactGroupedEdgeV3Schema.safeParse(payload);
    assert.strictEqual(result.success, false);
  });

  it("rejects non-integer from", () => {
    const payload = { from: 1.5, c: [1] };
    const result = CompactGroupedEdgeV3Schema.safeParse(payload);
    assert.strictEqual(result.success, false);
  });

  it("accepts valid grouped edge with only from", () => {
    const payload = { from: 0 };
    const result = CompactGroupedEdgeV3Schema.safeParse(payload);
    assert.strictEqual(result.success, true);
  });

  it("rejects v3 slice with wrong wire format marker", () => {
    const slice = makeSlice([[0, 1, "call", 1]]);
    const compact = toCompactGraphSliceV3(slice);
    (compact as any).wf = "standard";

    const result = CompactGraphSliceV3Schema.safeParse(compact);
    assert.strictEqual(result.success, false);
  });

  it("rejects v3 slice with wrong version", () => {
    const slice = makeSlice([[0, 1, "call", 1]]);
    const compact = toCompactGraphSliceV3(slice);
    (compact as any).wv = 2;

    const result = CompactGraphSliceV3Schema.safeParse(compact);
    assert.strictEqual(result.success, false);
  });
});

describe("backward compatibility", () => {
  it("v1/v2 clients can still parse responses when v3 is default", () => {
    const v2Request = SliceBuildRequestSchema.safeParse({
      repoId: "repo-1",
      taskText: "review",
      wireFormat: "compact",
      wireFormatVersion: 2,
    });
    const v1Request = SliceBuildRequestSchema.safeParse({
      repoId: "repo-1",
      taskText: "review",
      wireFormat: "compact",
      wireFormatVersion: 1,
    });

    assert.strictEqual(v2Request.success, true);
    assert.strictEqual(v1Request.success, true);
  });

  it("v2 decode produces valid v2 schema output", () => {
    const slice = makeSlice([
      [0, 1, "call", 1],
      [0, 2, "import", 0.6],
      [1, 2, "config", 0.8],
    ]);

    const v3 = toCompactGraphSliceV3(slice);
    const v2 = decodeCompactGraphSliceV3ToV2(v3);

    const result = CompactGraphSliceV2Schema.safeParse(v2);
    assert.strictEqual(result.success, true);
  });
});

describe("edge cases", () => {
  it("handles empty edges", () => {
    const slice = makeSlice([]);
    const compact = toCompactGraphSliceV3(slice);

    assert.deepStrictEqual(compact.e, []);
    assert.ok(!compact.et, "should omit et when no edges");
  });

  it("handles single edge", () => {
    const slice = makeSlice([[0, 1, "call", 1]]);
    const compact = toCompactGraphSliceV3(slice);

    assert.strictEqual(compact.e.length, 1);
    assert.strictEqual(compact.e[0].from, 0);
    assert.deepStrictEqual(compact.e[0].c, [1]);
  });

  it("handles all edge types from single source", () => {
    const slice = makeSlice([
      [0, 1, "import", 1],
      [0, 2, "call", 1],
      [0, 3, "config", 1],
    ]);
    const compact = toCompactGraphSliceV3(slice);

    assert.strictEqual(compact.e.length, 1);
    assert.deepStrictEqual(compact.e[0].i, [1]);
    assert.deepStrictEqual(compact.e[0].c, [2]);
    assert.deepStrictEqual(compact.e[0].cf, [3]);
  });
});
