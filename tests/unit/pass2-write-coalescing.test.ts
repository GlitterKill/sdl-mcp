import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { EdgeRow } from "../../dist/db/ladybug-queries.js";

/**
 * Tests for the pass-2 dispatcher write helpers in
 * `src/indexer/indexer-pass2.ts`.
 *
 *   - `makeImmediateSubmit(mode)` → SubmitEdgeWrite that flushes via
 *     `withWriteConn` on each call. Sequential dispatch path.
 *   - `makeBatchAccumulator()` → returns `{ acc, submit }`; submit pushes
 *     into the in-memory accumulator without touching the DB.
 *   - `flushBatchAccumulator(acc, mode)` → issues the combined write.
 *
 * The in-memory accumulator paths (no DB) are testable directly. The
 * actual flush + immediate-submit paths require a DB connection and are
 * exercised end-to-end by the per-language pass-2 indexing integration
 * tests; here we cover the no-op early-return guards plus the
 * accumulator's collection invariants.
 */

const FAKE_EDGE = {
  repoId: "r1",
  fromSymbolId: "from-1",
  toSymbolId: "to-1",
  edgeType: "call",
  weight: 1.0,
  confidence: 0.9,
  resolution: "import-direct",
  resolverId: "pass2-test",
  resolutionPhase: "pass2",
  provenance: "test-provenance",
  createdAt: new Date().toISOString(),
};

class FakeQueryResult {
  close(): void {}

  async getAll(): Promise<unknown[]> {
    return [];
  }
}

function createFakeConnection(statements: string[]): import("kuzu").Connection {
  return {
    async prepare(statement: string) {
      return {
        statement,
        isSuccess() {
          return true;
        },
        getErrorMessage() {
          return "";
        },
      };
    },
    async execute(preparedStatement: { statement: string }) {
      statements.push(preparedStatement.statement);
      return new FakeQueryResult();
    },
    async query(statement: string) {
      statements.push(statement);
      return new FakeQueryResult();
    },
  } as unknown as import("kuzu").Connection;
}

function countStatementsContaining(
  statements: readonly string[],
  text: string,
): number {
  return statements.filter((statement) => statement.includes(text)).length;
}

function edge(overrides: Partial<EdgeRow> = {}): EdgeRow {
  return {
    repoId: "r1",
    fromSymbolId: "from-1",
    toSymbolId: "to-1",
    edgeType: "call",
    weight: 1.0,
    confidence: 0.9,
    resolution: "import-direct",
    resolverId: "pass2-test",
    resolutionPhase: "pass2",
    provenance: "test-provenance",
    createdAt: "2026-05-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("makeBatchAccumulator", () => {
  it("starts with empty arrays", async () => {
    const { makeBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    const { acc } = makeBatchAccumulator();
    assert.deepStrictEqual(acc.symbolIdsToRefresh, []);
    assert.deepStrictEqual(acc.edges, []);
  });

  it("submit pushes symbolIds into the accumulator", async () => {
    const { makeBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    const { acc, submit } = makeBatchAccumulator();
    await submit({ symbolIdsToRefresh: ["a", "b"], edges: [] });
    assert.deepStrictEqual(acc.symbolIdsToRefresh, ["a", "b"]);
    assert.deepStrictEqual(acc.edges, []);
  });

  it("submit pushes edges into the accumulator", async () => {
    const { makeBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    const { acc, submit } = makeBatchAccumulator();
    await submit({ symbolIdsToRefresh: [], edges: [FAKE_EDGE] });
    assert.deepStrictEqual(acc.symbolIdsToRefresh, []);
    assert.strictEqual(acc.edges.length, 1);
    assert.strictEqual(acc.edges[0].fromSymbolId, "from-1");
  });

  it("multiple submits accumulate across both arrays", async () => {
    const { makeBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    const { acc, submit } = makeBatchAccumulator();
    await submit({ symbolIdsToRefresh: ["a"], edges: [FAKE_EDGE] });
    await submit({ symbolIdsToRefresh: ["b", "c"], edges: [FAKE_EDGE] });
    assert.deepStrictEqual(acc.symbolIdsToRefresh, ["a", "b", "c"]);
    assert.strictEqual(acc.edges.length, 2);
  });

  it("submit with empty inputs is a no-op on the accumulator", async () => {
    const { makeBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    const { acc, submit } = makeBatchAccumulator();
    await submit({ symbolIdsToRefresh: [], edges: [] });
    assert.strictEqual(acc.symbolIdsToRefresh.length, 0);
    assert.strictEqual(acc.edges.length, 0);
  });
});

describe("flushBatchAccumulator — no-op guards", () => {
  it("returns immediately when both arrays are empty (no DB call)", async () => {
    const { flushBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    // A real withWriteConn would throw without an initialised LadybugDB
    // connection, so the fact that this resolves cleanly proves the
    // empty-acc early return fires before any DB work happens.
    const acc = { symbolIdsToRefresh: [], edges: [] };
    await assert.doesNotReject(
      async () => await flushBatchAccumulator(acc, "incremental"),
    );
  });

  it("returns immediately for full-mode + empty edges (no DB call)", async () => {
    const { flushBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    // When both arrays are empty the early return fires regardless of
    // mode — the full-mode DELETE-skip optimisation kicks in only when
    // we have symbolIdsToRefresh, but no edges either means no work.
    const acc = { symbolIdsToRefresh: [], edges: [] };
    await assert.doesNotReject(
      async () => await flushBatchAccumulator(acc, "full"),
    );
  });
});

describe("makeImmediateSubmit — early-return guard", () => {
  it("returns immediately when both arrays are empty (no DB call)", async () => {
    const { makeImmediateSubmit } =
      await import("../../dist/indexer/indexer-pass2.js");
    const submit = makeImmediateSubmit("incremental");
    // The early return inside makeImmediateSubmit must fire before any
    // withWriteConn call that would otherwise need a real DB.
    await assert.doesNotReject(
      async () => await submit({ symbolIdsToRefresh: [], edges: [] }),
    );
  });

  it("returns a function for both 'full' and 'incremental' modes", async () => {
    const { makeImmediateSubmit } =
      await import("../../dist/indexer/indexer-pass2.js");
    assert.strictEqual(typeof makeImmediateSubmit("full"), "function");
    assert.strictEqual(typeof makeImmediateSubmit("incremental"), "function");
  });
});

describe("insertPass2Edges", () => {
  it("splits full-mode known endpoints from unresolved endpoints", async () => {
    const { splitPass2EdgesForFullMode } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );

    const known = edge({ toSymbolId: "known-target" });
    const unresolved = edge({
      fromSymbolId: "from-2",
      toSymbolId: "unresolved:call:missing",
    });

    const split = splitPass2EdgesForFullMode([known, unresolved]);

    assert.deepStrictEqual(split.knownEndpointEdges, [known]);
    assert.deepStrictEqual(split.repairEdges, [unresolved]);
  });

  it("uses the generic skip-refresh path for small full-mode resolved pass-2 edge batches", async () => {
    const { insertPass2Edges } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const statements: string[] = [];

    await insertPass2Edges(createFakeConnection(statements), [edge()], "full");

    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      0,
      "small full-mode pass-2 batches should avoid COPY setup overhead",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (a)-[:DEPENDS_ON"),
      1,
      "small full-mode pass-2 batches should still create DEPENDS_ON through generic MERGE semantics",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "SET d.weight = row.weight"),
      0,
      "full-mode pass-2 writes should not refresh pre-existing relationship props",
    );
  });

  it("uses the known-symbol COPY path for large full-mode resolved pass-2 edge batches", async () => {
    const { insertPass2Edges } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const statements: string[] = [];
    const edges = Array.from({ length: 512 }, (_, index) =>
      edge({
        fromSymbolId: `from-${index}`,
        toSymbolId: `to-${index}`,
      }),
    );

    await insertPass2Edges(createFakeConnection(statements), edges, "full");

    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      1,
      "large full-mode resolved pass-2 batches should use the relationship COPY path",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "MERGE (a:Symbol"),
      0,
      "known endpoint COPY writes should not run generic endpoint repair",
    );
  });

  it("keeps CSV-quoted provenance off the full-mode pass-2 COPY path", async () => {
    const { insertPass2Edges, splitPass2EdgesForFullMode } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const statements: string[] = [];
    const unsafe = edge({
      fromSymbolId: "from-unsafe",
      toSymbolId: "to-unsafe",
      provenance:
        'cpp-call:Accesses[MemAccessInfo(Ptr, false)].insert("x")',
    });
    const edges = [
      unsafe,
      ...Array.from({ length: 512 }, (_, index) =>
        edge({
          fromSymbolId: `from-${index}`,
          toSymbolId: `to-${index}`,
        }),
      ),
    ];

    const split = splitPass2EdgesForFullMode(edges);
    assert.strictEqual(split.knownEndpointEdges.length, 512);
    assert.deepStrictEqual(split.repairEdges, [unsafe]);

    await insertPass2Edges(createFakeConnection(statements), edges, "full");

    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      1,
      "clean rows should still use the fast relationship COPY path",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (a)-[:DEPENDS_ON"),
      1,
      "unsafe provenance rows should use the parameterized fallback writer",
    );
  });

  it("keeps the generic repair path for full-mode unresolved pass-2 targets", async () => {
    const { insertPass2Edges } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const statements: string[] = [];

    await insertPass2Edges(
      createFakeConnection(statements),
      [edge({ toSymbolId: "unresolved:call:missing" })],
      "full",
    );

    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      0,
      "unresolved targets still need generic placeholder repair",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (a)-[:DEPENDS_ON"),
      1,
      "unresolved targets should still create DEPENDS_ON through generic MERGE semantics",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "row.targetStatus"),
      1,
      "unresolved targets should still run placeholder metadata repair",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "SET d.weight = row.weight"),
      0,
      "full-mode unresolved writes should skip existing relationship refresh",
    );
  });

  it("keeps incremental pass-2 on the generic refresh-capable writer", async () => {
    const { insertPass2Edges } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const statements: string[] = [];

    await insertPass2Edges(
      createFakeConnection(statements),
      [edge()],
      "incremental",
    );

    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      0,
      "incremental pass-2 must keep generic endpoint repair semantics",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "SET d.weight = row.weight"),
      1,
      "incremental pass-2 must refresh pre-existing call relationship props",
    );
  });
});

describe("buildPreloadedPass2ExportedSymbolsFromRows", () => {
  it("preloads exported real symbols in both lite and full pass-2 cache shapes", async () => {
    const { buildPreloadedPass2ExportedSymbolsFromRows } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );

    const preloaded = buildPreloadedPass2ExportedSymbolsFromRows({
      files: [{ fileId: "provider-file" }, { fileId: "empty-provider-file" }],
      symbols: [
        {
          symbolId: "class-1",
          repoId: "repo",
          fileId: "provider-file",
          kind: "class",
          name: "Client",
          exported: true,
          language: "python",
          rangeStartLine: 1,
          rangeStartCol: 0,
          rangeEndLine: 20,
          rangeEndCol: 0,
          symbolStatus: "real",
        },
        {
          symbolId: "method-1",
          repoId: "repo",
          fileId: "provider-file",
          kind: "method",
          name: "Client.run",
          exported: true,
          language: "python",
          rangeStartLine: 4,
          rangeStartCol: 2,
          rangeEndLine: 8,
          rangeEndCol: 0,
          symbolStatus: "real",
        },
        {
          symbolId: "local-1",
          repoId: "repo",
          fileId: "provider-file",
          kind: "function",
          name: "helper",
          exported: false,
          language: "python",
          rangeStartLine: 30,
          rangeStartCol: 0,
          rangeEndLine: 33,
          rangeEndCol: 0,
          symbolStatus: "real",
        },
        {
          symbolId: "placeholder-1",
          repoId: "repo",
          fileId: "provider-file",
          kind: "function",
          name: "placeholder",
          exported: true,
          language: "python",
          rangeStartLine: 40,
          rangeStartCol: 0,
          rangeEndLine: 41,
          rangeEndCol: 0,
          symbolStatus: "unresolved",
        },
      ],
    });

    assert.deepStrictEqual(preloaded.lite.get("provider-file"), [
      { symbolId: "class-1", name: "Client" },
      { symbolId: "method-1", name: "Client.run" },
    ]);
    assert.deepStrictEqual(
      preloaded.full.get("provider-file")?.map((symbol) => ({
        symbolId: symbol.symbolId,
        kind: symbol.kind,
        name: symbol.name,
        fileId: symbol.fileId,
      })),
      [
        {
          symbolId: "class-1",
          kind: "class",
          name: "Client",
          fileId: "provider-file",
        },
        {
          symbolId: "method-1",
          kind: "method",
          name: "Client.run",
          fileId: "provider-file",
        },
      ],
    );
    assert.deepStrictEqual(preloaded.lite.get("empty-provider-file"), []);
    assert.deepStrictEqual(preloaded.full.get("empty-provider-file"), []);
  });
});
