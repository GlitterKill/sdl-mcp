import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EdgeRow } from "../../dist/db/ladybug-queries.js";
import type { RepoConfig } from "../../dist/config/types.js";
import type {
  Pass2Resolver,
  Pass2ResolverContext,
  Pass2Target,
} from "../../dist/indexer/pass2/types.js";

/**
 * Tests for the pass-2 dispatcher write helpers in
 * `src/indexer/indexer-pass2.ts`.
 *
 *   - `makeImmediateSubmit(mode)` → SubmitEdgeWrite that flushes via
 *     `withWriteConn` on each call. Kept as a direct helper for small
 *     call sites and no-op guards.
 *   - `makeBatchAccumulator()` → returns `{ acc, submit }`; submit pushes
 *     into the in-memory accumulator without touching the DB.
 *   - `flushBatchAccumulator(acc, mode)` → issues the combined write.
 *   - `shouldFlushBatchAccumulator(acc, filesSinceFlush)` → controls
 *     bounded sequential dispatch drains.
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

function fileMeta(path: string): { path: string; size: number; mtime: number } {
  return { path, size: 1, mtime: 1 };
}

class FakeSubmittingResolver implements Pass2Resolver {
  readonly id = "fake-pass2";

  private readonly submissionForTarget: (
    target: Pass2Target,
    context: Pass2ResolverContext,
  ) => { symbolIdsToRefresh: string[]; edges: EdgeRow[] };

  constructor(
    submissionForTarget: (
      target: Pass2Target,
      context: Pass2ResolverContext,
    ) => { symbolIdsToRefresh: string[]; edges: EdgeRow[] },
  ) {
    this.submissionForTarget = submissionForTarget;
  }

  supports(target: Pass2Target): boolean {
    return target.extension === ".ts";
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<{ edgesCreated: number }> {
    const submission = this.submissionForTarget(target, context);
    await context.submitEdgeWrite?.(submission);
    return { edgesCreated: submission.edges.length };
  }
}

async function withTempPass2Db<T>(
  fn: (params: {
    repoId: string;
    getWriteRuns: () => number;
  }) => Promise<T>,
): Promise<T> {
  const { closeLadybugDb, getLadybugConn, getPoolStats, initLadybugDb } =
    await import("../../dist/db/ladybug.js");
  const ladybugDb = await import("../../dist/db/ladybug-queries.js");

  const tempDir = mkdtempSync(join(tmpdir(), "sdl-pass2-dispatch-"));
  const graphDbPath = join(tempDir, "graph.lbug");
  const repoId = `pass2-dispatch-${Date.now()}`;
  try {
    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: tempDir,
      configJson: "{}",
      createdAt: new Date().toISOString(),
    });
    return await fn({
      repoId,
      getWriteRuns: () => getPoolStats().writeTotalRuns,
    });
  } finally {
    await closeLadybugDb();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runFakeSequentialPass2(params: {
  repoId: string;
  mode: "full" | "incremental";
  files: Array<{ path: string; size: number; mtime: number }>;
  resolver: Pass2Resolver;
  changedPaths?: string[];
}): Promise<{
  edgesCreated: number;
  telemetry: import("../../dist/indexer/edge-builder.js").CallResolutionTelemetry;
}> {
  const { runPass2Resolvers } = await import(
    "../../dist/indexer/indexer-pass2.js"
  );
  const { createCallResolutionTelemetry } = await import(
    "../../dist/indexer/edge-builder.js"
  );
  const { createPass2ResolverRegistry } = await import(
    "../../dist/indexer/pass2/registry.js"
  );
  const telemetry = createCallResolutionTelemetry({
    repoId: params.repoId,
    mode: params.mode,
    pass2EligibleFileCount: params.files.length,
    registeredResolvers: [params.resolver.id],
  });
  const edgesCreated = await runPass2Resolvers({
    repoId: params.repoId,
    repoRoot: tmpdir(),
    mode: params.mode,
    pass2EligibleFiles: params.files,
    changedPass2FilePaths: new Set(params.changedPaths ?? []),
    supportsPass2FilePath: () => true,
    pass2ResolverRegistry: createPass2ResolverRegistry([params.resolver]),
    symbolIndex: new Map(),
    tsResolver: null,
    config: { languages: ["typescript"] } as RepoConfig,
    pass2Concurrency: 1,
    createdCallEdges: new Set(),
    globalNameToSymbolIds: new Map(),
    globalPreferredSymbolId: new Map(),
    callResolutionTelemetry: telemetry,
    onProgress: undefined,
  });
  return { edgesCreated, telemetry };
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

describe("shouldFlushBatchAccumulator", () => {
  it("does not flush empty accumulators even when the file threshold is reached", async () => {
    const { shouldFlushBatchAccumulator } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );

    assert.equal(
      shouldFlushBatchAccumulator(
        { symbolIdsToRefresh: [], edges: [] },
        64,
        { maxFiles: 64, maxEdges: 10 },
      ),
      false,
    );
  });

  it("flushes symbol-only work at the file threshold", async () => {
    const { shouldFlushBatchAccumulator } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );

    assert.equal(
      shouldFlushBatchAccumulator(
        { symbolIdsToRefresh: ["from-1"], edges: [] },
        4,
        { maxFiles: 4, maxEdges: 10 },
      ),
      true,
    );
  });

  it("flushes edge-heavy work at the edge threshold", async () => {
    const { shouldFlushBatchAccumulator } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );

    assert.equal(
      shouldFlushBatchAccumulator(
        {
          symbolIdsToRefresh: [],
          edges: [FAKE_EDGE, FAKE_EDGE, FAKE_EDGE],
        },
        1,
        { maxFiles: 64, maxEdges: 3 },
      ),
      true,
    );
  });

  it("keeps non-empty work buffered below both thresholds", async () => {
    const { shouldFlushBatchAccumulator } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );

    assert.equal(
      shouldFlushBatchAccumulator(
        { symbolIdsToRefresh: ["from-1"], edges: [FAKE_EDGE] },
        2,
        { maxFiles: 4, maxEdges: 3 },
      ),
      false,
    );
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
    const acc = { symbolIdsToRefresh: [], edges: [] };
    await assert.doesNotReject(
      async () => await flushBatchAccumulator(acc, "full"),
    );
  });

  it("returns immediately for full-mode + symbol-only work (no DB call)", async () => {
    const { flushBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    // Full-mode pass-2 does not need the incremental outgoing-edge delete,
    // so symbolIds without new edges would otherwise open a no-op write conn.
    const acc = { symbolIdsToRefresh: ["from-1"], edges: [] };
    await assert.doesNotReject(
      async () => await flushBatchAccumulator(acc, "full"),
    );
  });
});

describe("runPass2Resolvers — sequential dispatcher write batching", () => {
  it("drains sequential writes at the file threshold and final tail", async () => {
    await withTempPass2Db(async ({ repoId, getWriteRuns }) => {
      const files = Array.from({ length: 65 }, (_, index) =>
        fileMeta(`src/file-${index}.ts`),
      );
      const resolver = new FakeSubmittingResolver((target) => {
        const index = target.filePath.match(/file-(\d+)\.ts$/)?.[1] ?? "x";
        return {
          symbolIdsToRefresh: [`from-${index}`],
          edges: [
            edge({
              repoId,
              fromSymbolId: `from-${index}`,
              toSymbolId: `to-${index}`,
            }),
          ],
        };
      });

      const before = getWriteRuns();
      const { edgesCreated, telemetry } = await runFakeSequentialPass2({
        repoId,
        mode: "full",
        files,
        resolver,
      });
      const after = getWriteRuns();

      assert.equal(edgesCreated, 65);
      assert.equal(
        after - before,
        2,
        "65 sequential files should flush once at 64 files and once for the final tail",
      );
      assert.equal(telemetry.pass2FilesProcessed, 65);
      assert.equal(telemetry.resolverBreakdown["fake-pass2"]?.targets, 65);
      assert.equal(
        telemetry.resolverBreakdown["fake-pass2"]?.edgesCreated,
        65,
      );

      const { getLadybugConn } = await import("../../dist/db/ladybug.js");
      const ladybugDb = await import("../../dist/db/ladybug-queries.js");
      const conn = await getLadybugConn();
      const tailEdgesBySymbol = await ladybugDb.getEdgesFromSymbolsLite(conn, [
        "from-64",
      ]);
      const tailEdges = tailEdgesBySymbol.get("from-64") ?? [];
      assert.equal(
        tailEdges.filter((candidate) => candidate.edgeType === "call").length,
        1,
        "the final tail batch should be persisted",
      );
    });
  });

  it("keeps incremental symbol-only submissions as delete writes", async () => {
    await withTempPass2Db(async ({ repoId, getWriteRuns }) => {
      const { getLadybugConn } = await import("../../dist/db/ladybug.js");
      const ladybugDb = await import("../../dist/db/ladybug-queries.js");
      const conn = await getLadybugConn();
      await ladybugDb.insertEdges(conn, [
        edge({
          repoId,
          fromSymbolId: "from-stale",
          toSymbolId: "to-stale",
        }),
      ]);
      assert.equal(
        (await ladybugDb.getEdgesFrom(conn, "from-stale")).filter(
          (candidate) => candidate.edgeType === "call",
        ).length,
        1,
      );

      const resolver = new FakeSubmittingResolver(() => ({
        symbolIdsToRefresh: ["from-stale"],
        edges: [],
      }));
      const before = getWriteRuns();
      const { edgesCreated, telemetry } = await runFakeSequentialPass2({
        repoId,
        mode: "incremental",
        files: [fileMeta("src/changed.ts")],
        changedPaths: ["src/changed.ts"],
        resolver,
      });
      const after = getWriteRuns();

      assert.equal(edgesCreated, 0);
      assert.equal(
        after - before,
        1,
        "incremental symbol-only submissions must still run the stale-call delete",
      );
      assert.equal(telemetry.pass2FilesProcessed, 1);
      assert.equal(
        (await ladybugDb.getEdgesFrom(conn, "from-stale")).filter(
          (candidate) => candidate.edgeType === "call",
        ).length,
        0,
        "incremental symbol-only pass-2 should delete stale outgoing call edges",
      );
    });
  });

  it("skips full-mode symbol-only submissions without opening a write run", async () => {
    await withTempPass2Db(async ({ repoId, getWriteRuns }) => {
      const resolver = new FakeSubmittingResolver(() => ({
        symbolIdsToRefresh: ["from-noop"],
        edges: [],
      }));

      const before = getWriteRuns();
      const { edgesCreated, telemetry } = await runFakeSequentialPass2({
        repoId,
        mode: "full",
        files: [fileMeta("src/noop.ts")],
        resolver,
      });
      const after = getWriteRuns();

      assert.equal(edgesCreated, 0);
      assert.equal(
        after - before,
        0,
        "full-mode symbol-only submissions should not open a no-op write run",
      );
      assert.equal(telemetry.pass2FilesProcessed, 1);
      assert.equal(telemetry.resolverBreakdown["fake-pass2"]?.targets, 1);
    });
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

  it("sanitizes CSV-quoted provenance for the full-mode pass-2 COPY path", async () => {
    const {
      insertPass2Edges,
      splitPass2EdgesForFullMode,
      toPass2KnownEndpointCopyEdge,
    } = await import("../../dist/indexer/indexer-pass2.js");
    const statements: string[] = [];
    const quotedProvenance = edge({
      fromSymbolId: "from-quoted-provenance",
      toSymbolId: "to-quoted-provenance",
      provenance:
        'cpp-call:Accesses[MemAccessInfo(Ptr, false)].insert("x")',
    });
    const edges = [
      quotedProvenance,
      ...Array.from({ length: 512 }, (_, index) =>
        edge({
          fromSymbolId: `from-${index}`,
          toSymbolId: `to-${index}`,
        }),
      ),
    ];

    const split = splitPass2EdgesForFullMode(edges);
    assert.strictEqual(split.knownEndpointEdges.length, 513);
    assert.deepStrictEqual(split.repairEdges, []);
    assert.equal(
      toPass2KnownEndpointCopyEdge(quotedProvenance).provenance,
      "cpp-call:Accesses[MemAccessInfo(Ptr false)].insert( x )",
    );

    await insertPass2Edges(createFakeConnection(statements), edges, "full");

    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      1,
      "known endpoint rows should stay on the fast relationship COPY path after provenance sanitization",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (a)-[:DEPENDS_ON"),
      0,
      "known endpoint provenance punctuation should not force generic endpoint repair",
    );
  });

  it("keeps unsafe full-mode pass-2 endpoints on the generic repair path", async () => {
    const { insertPass2Edges, splitPass2EdgesForFullMode } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const statements: string[] = [];
    const unsafeEndpoint = edge({
      fromSymbolId: 'from-"unsafe"',
      toSymbolId: "to-unsafe",
    });
    const edges = [
      unsafeEndpoint,
      ...Array.from({ length: 512 }, (_, index) =>
        edge({
          fromSymbolId: `from-${index}`,
          toSymbolId: `to-${index}`,
        }),
      ),
    ];

    const split = splitPass2EdgesForFullMode(edges);
    assert.strictEqual(split.knownEndpointEdges.length, 512);
    assert.deepStrictEqual(split.repairEdges, [unsafeEndpoint]);

    await insertPass2Edges(createFakeConnection(statements), edges, "full");

    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      1,
      "safe known endpoint rows should still use relationship COPY",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (a)-[:DEPENDS_ON"),
      1,
      "unsafe endpoint rows should use generic endpoint repair",
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
