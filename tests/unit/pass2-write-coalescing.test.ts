import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EdgeRow } from "../../dist/db/ladybug-queries.js";
import type { RepoConfig } from "../../dist/config/types.js";
import type { SymbolIndex } from "../../dist/indexer/edge-builder.js";
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

function symbolIndexForFiles(
  files: readonly Array<{ path: string }>,
): SymbolIndex {
  const index: SymbolIndex = new Map();
  for (const file of files) {
    index.set(
      file.path,
      new Map([["__pass2_test__", new Map([["function", [`sym:${file.path}`]]])]]),
    );
  }
  return index;
}

class FakeSubmittingResolver implements Pass2Resolver {
  readonly id = "fake-pass2";

  private readonly submissionForTarget: (
    target: Pass2Target,
    context: Pass2ResolverContext,
  ) => { symbolIdsToRefresh: string[]; edges: EdgeRow[] };
  readonly warmupTargets: string[] = [];

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

  async warmup(
    targets: Pass2Target[],
    _context: Pass2ResolverContext,
  ): Promise<void> {
    this.warmupTargets.push(...targets.map((target) => target.filePath));
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
  symbolIndex?: SymbolIndex;
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
    symbolIndex: params.symbolIndex ?? symbolIndexForFiles(params.files),
    tsResolver: null,
    config: { languages: ["typescript"] } as RepoConfig,
    pass2Concurrency: 1,
    createdCallEdges: new Set(),
    globalNameToSymbolIds: new Map(),
    globalPreferredSymbolId: new Map(),
    callResolutionTelemetry: telemetry,
    onProgress: undefined,
    recordTiming: undefined,
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
    const result = submit({ symbolIdsToRefresh: ["a", "b"], edges: [] });
    assert.strictEqual(
      result,
      undefined,
      "batch accumulator submit should be synchronous",
    );
    assert.deepStrictEqual(acc.symbolIdsToRefresh, ["a", "b"]);
    assert.deepStrictEqual(acc.edges, []);
  });

  it("awaits an async lifecycle hook before buffering the write", async () => {
    const { makeBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    let releaseHook!: () => void;
    const hookBarrier = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const { acc, submit } = makeBatchAccumulator(async () => {
      await hookBarrier;
    });

    const submitted = submit({ symbolIdsToRefresh: ["a"], edges: [] });
    assert.ok(submitted instanceof Promise);
    assert.deepStrictEqual(acc.symbolIdsToRefresh, []);
    releaseHook();
    await submitted;
    assert.deepStrictEqual(acc.symbolIdsToRefresh, ["a"]);
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
      const files = Array.from({ length: 257 }, (_, index) =>
        fileMeta(`src/file-${index}.ts`),
      );
      const resolver = new FakeSubmittingResolver((target) => {
        const index = target.filePath.match(/file-(\d+)\.ts$/)?.[1] ?? "x";
        const sourceSymbolId = `from-${index}`;
        return {
          symbolIdsToRefresh: [sourceSymbolId],
          edges: [
            edge({
              repoId,
              fromSymbolId: sourceSymbolId,
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

      assert.equal(edgesCreated, 257);
      assert.equal(
        after - before,
        1,
        "257 sequential full-mode COPY-safe files should coalesce into one final write",
      );
      assert.equal(telemetry.pass2FilesProcessed, 257);
      assert.equal(telemetry.resolverBreakdown["fake-pass2"]?.targets, 257);
      assert.equal(
        telemetry.resolverBreakdown["fake-pass2"]?.edgesCreated,
        257,
      );

      const { getLadybugConn } = await import("../../dist/db/ladybug.js");
      const ladybugDb = await import("../../dist/db/ladybug-queries.js");
      const conn = await getLadybugConn();
      const tailEdgesBySymbol = await ladybugDb.getEdgesFromSymbolsLite(conn, [
        "from-256",
      ]);
      const tailEdges = tailEdgesBySymbol.get("from-256") ?? [];
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

  it("skips files with no source symbols before resolver warmup and dispatch", async () => {
    await withTempPass2Db(async ({ repoId }) => {
      const files = [fileMeta("src/has-symbol.ts"), fileMeta("src/no-symbol.ts")];
      const resolver = new FakeSubmittingResolver((target) => ({
        symbolIdsToRefresh: [`from-${target.filePath}`],
        edges: [
          edge({
            repoId,
            fromSymbolId: `from-${target.filePath}`,
            toSymbolId: `to-${target.filePath}`,
          }),
        ],
      }));
      const timings = new Map<string, number>();
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
        repoId,
        mode: "full",
        pass2EligibleFileCount: files.length,
        registeredResolvers: [resolver.id],
      });
      const symbolIndex = symbolIndexForFiles([files[0]]);

      const edgesCreated = await runPass2Resolvers({
        repoId,
        repoRoot: tmpdir(),
        mode: "full",
        pass2EligibleFiles: files,
        changedPass2FilePaths: new Set(),
        supportsPass2FilePath: () => true,
        pass2ResolverRegistry: createPass2ResolverRegistry([resolver]),
        symbolIndex,
        tsResolver: null,
        config: { languages: ["typescript"] } as RepoConfig,
        pass2Concurrency: 1,
        createdCallEdges: new Set(),
        globalNameToSymbolIds: new Map(),
        globalPreferredSymbolId: new Map(),
        callResolutionTelemetry: telemetry,
        onProgress: undefined,
        recordTiming: (phase, elapsedMs) => timings.set(phase, elapsedMs),
      });

      assert.equal(edgesCreated, 1);
      assert.deepEqual(resolver.warmupTargets, ["src/has-symbol.ts"]);
      assert.equal(telemetry.pass2FilesProcessed, 1);
      assert.equal(telemetry.pass2FilesSkippedNoExistingSymbols, 1);
      assert.equal(telemetry.resolverBreakdown["fake-pass2"]?.targets, 1);
      assert.equal(
        timings.get("pass2.dispatch.skippedNoExistingSymbols"),
        1,
      );
    });
  });
});

describe("makeImmediateSubmit — early-return guard", () => {
  it("returns immediately when both arrays are empty (no DB call)", async () => {
    const { makeImmediateSubmit } =
      await import("../../dist/indexer/indexer-pass2.js");
    const submit = makeImmediateSubmit("incremental");
    const result = submit({ symbolIdsToRefresh: [], edges: [] });
    assert.ok(result instanceof Promise);
    // The early return inside makeImmediateSubmit must fire before any
    // withWriteConn call that would otherwise need a real DB.
    await assert.doesNotReject(async () => await result);
  });

  it("returns a function for both 'full' and 'incremental' modes", async () => {
    const { makeImmediateSubmit } =
      await import("../../dist/indexer/indexer-pass2.js");
    assert.strictEqual(typeof makeImmediateSubmit("full"), "function");
    assert.strictEqual(typeof makeImmediateSubmit("incremental"), "function");
  });
});

describe("insertPass2Edges", () => {
  it("keeps full-mode unsafe source endpoints off the COPY path", async () => {
    const { splitPass2EdgesForFullMode } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );

    const known = edge({ toSymbolId: "known-target" });
    const unresolvedSource = edge({
      fromSymbolId: "unresolved:call:caller",
      toSymbolId: "known-target-2",
    });

    const split = splitPass2EdgesForFullMode([known, unresolvedSource]);

    assert.deepStrictEqual(split.knownEndpointEdges, [known]);
    assert.deepStrictEqual(split.repairEdges, [unresolvedSource]);
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

  it("macro-buffers full-mode resolved batches until the COPY cap", async () => {
    const {
      DEFAULT_PASS2_KNOWN_ENDPOINT_COPY_BUFFER_MAX_EDGES,
      createPass2WriteStats,
      insertPass2Edges,
    } = await import("../../dist/indexer/indexer-pass2.js");
    const statements: string[] = [];
    const stats = createPass2WriteStats();
    const smallKnownEndpointBuffer = { edges: [] };
    const cap = DEFAULT_PASS2_KNOWN_ENDPOINT_COPY_BUFFER_MAX_EDGES;

    const firstResult = await insertPass2Edges(
      createFakeConnection(statements),
      [edge({ fromSymbolId: "from-buffered-0", toSymbolId: "to-buffered-0" })],
      "full",
      stats,
      smallKnownEndpointBuffer,
    );
    assert.deepStrictEqual(firstResult, {
      persistedEdges: 0,
      deferredEdges: 1,
      flushedBufferedEdges: 0,
    });
    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      0,
      "below-threshold coalesced rows should not write immediately",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (a)-[:DEPENDS_ON"),
      0,
      "below-threshold coalesced rows should not fall back to generic repair",
    );

    const thresholdResult = await insertPass2Edges(
      createFakeConnection(statements),
      Array.from({ length: cap - 1 }, (_, index) =>
        edge({
          fromSymbolId: `from-buffered-${index + 1}`,
          toSymbolId: `to-buffered-${index + 1}`,
        }),
      ),
      "full",
      stats,
      smallKnownEndpointBuffer,
    );

    assert.deepStrictEqual(thresholdResult, {
      persistedEdges: cap,
      deferredEdges: 0,
      flushedBufferedEdges: cap,
    });
    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      1,
      "coalesced rows should flush through relationship COPY at the macro cap",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (a)-[:DEPENDS_ON"),
      0,
      "coalesced COPY-safe rows should avoid generic relationship create",
    );
    assert.strictEqual(stats.smallKnownEndpointFlushes, 1);
    assert.strictEqual(stats.smallKnownEndpointEdges, 1);
    assert.strictEqual(stats.copyFlushes, 1);
    assert.strictEqual(stats.copyEdges, cap);
    assert.strictEqual(stats.repairInsertEdges, 0);
  });

  it("allows benchmark runs to override the pass-2 COPY macro-buffer cap", async () => {
    const {
      DEFAULT_PASS2_KNOWN_ENDPOINT_COPY_BUFFER_MAX_EDGES,
      resolvePass2KnownEndpointCopyBufferMaxEdges,
    } = await import("../../dist/indexer/indexer-pass2.js");

    assert.strictEqual(
      resolvePass2KnownEndpointCopyBufferMaxEdges({}),
      DEFAULT_PASS2_KNOWN_ENDPOINT_COPY_BUFFER_MAX_EDGES,
    );
    assert.strictEqual(
      resolvePass2KnownEndpointCopyBufferMaxEdges({
        SDL_MCP_PASS2_COPY_BUFFER_MAX_EDGES: "8192",
      }),
      8192,
    );
    assert.strictEqual(
      resolvePass2KnownEndpointCopyBufferMaxEdges({
        SDL_MCP_PASS2_COPY_BUFFER_MAX_EDGES: "511",
      }),
      DEFAULT_PASS2_KNOWN_ENDPOINT_COPY_BUFFER_MAX_EDGES,
    );
  });

  it("drains pending COPY-safe rows before a mixed repair batch", async () => {
    const { createPass2WriteStats, insertPass2Edges } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const statements: string[] = [];
    const stats = createPass2WriteStats();
    const smallKnownEndpointBuffer = { edges: [] };

    const bufferedResult = await insertPass2Edges(
      createFakeConnection(statements),
      Array.from({ length: 600 }, (_, index) =>
        edge({
          fromSymbolId: `from-pending-${index}`,
          toSymbolId: `to-pending-${index}`,
        }),
      ),
      "full",
      stats,
      smallKnownEndpointBuffer,
    );

    assert.deepStrictEqual(bufferedResult, {
      persistedEdges: 0,
      deferredEdges: 600,
      flushedBufferedEdges: 0,
    });
    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      0,
      "pending macro-buffer rows should not write before the cap or a forced drain",
    );

    const mixedResult = await insertPass2Edges(
      createFakeConnection(statements),
      [
        edge({
          fromSymbolId: "from-safe-after-pending",
          toSymbolId: "to-safe-after-pending",
        }),
        edge({
          fromSymbolId: 'from-"unsafe"',
          toSymbolId: "to-repair",
        }),
      ],
      "full",
      stats,
      smallKnownEndpointBuffer,
    );

    assert.deepStrictEqual(mixedResult, {
      persistedEdges: 602,
      deferredEdges: 0,
      flushedBufferedEdges: 600,
    });
    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      1,
      "pending COPY-safe rows should drain through relationship COPY before repair rows persist",
    );
    assert.strictEqual(stats.copyFlushes, 1);
    assert.strictEqual(stats.copyEdges, 600);
    assert.strictEqual(stats.repairFlushes, 1);
    assert.strictEqual(stats.repairInsertEdges, 2);
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
    assert.strictEqual(
      countStatementsContaining(
        statements,
        "OPTIONAL MATCH (a)-[existing:DEPENDS_ON",
      ),
      0,
      "full-mode pass-2 repair should not probe existing call edges for fresh source symbols",
    );
  });

  it("bulk-repairs safe unresolved full-mode pass-2 targets before COPY", async () => {
    const { insertPass2Edges, splitPass2EdgesForFullMode } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const statements: string[] = [];
    const unresolved = edge({
      fromSymbolId: "from-unresolved-target",
      toSymbolId: "unresolved:call:missing",
    });
    const edges = [
      unresolved,
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

    await insertPass2Edges(createFakeConnection(statements), edges, "full");

    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      1,
      "safe unresolved targets should still use relationship COPY after placeholder repair",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "row.targetStatus"),
      1,
      "safe unresolved targets should run bulk placeholder metadata repair before COPY",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (a)-[:DEPENDS_ON"),
      0,
      "safe unresolved targets should not use generic relationship create statements",
    );
  });

  it("MERGEs missing versioned unresolved call targets before relationship COPY", async () => {
    const { insertPass2Edges, createPass2WriteStats } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const { unresolvedCallSymbolId } = await import(
      "../../dist/db/symbol-placeholders.js"
    );
    const statements: string[] = [];
    const stats = createPass2WriteStats();
    const versionedTarget = unresolvedCallSymbolId("missing, quoted\ncall");
    const edges = [
      edge({
        fromSymbolId: "from-versioned-unresolved-target",
        toSymbolId: versionedTarget,
      }),
      ...Array.from({ length: 512 }, (_, index) =>
        edge({
          fromSymbolId: `from-${index}`,
          toSymbolId: `to-${index}`,
        }),
      ),
    ];

    await insertPass2Edges(createFakeConnection(statements), edges, "full", stats);

    assert.strictEqual(
      countStatementsContaining(statements, "COPY Symbol FROM"),
      0,
      "active placeholder targets must not use Symbol COPY",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "COPY SYMBOL_IN_REPO FROM"),
      0,
      "new placeholder targets should use parameterized repo links",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "MERGE (b:Symbol"),
      1,
      "versioned unresolved-call targets should use generic placeholder MERGE",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      1,
      "relationship COPY should still load known-endpoint edges",
    );
    assert.ok(stats.copyEnsureSymbolProbeMs >= 0);
    assert.strictEqual(stats.copyEnsureSymbolCopyMissingCsvMs, 0);
    assert.strictEqual(stats.copyEnsureSymbolCopyMissingFromMs, 0);
    assert.ok(stats.copyEnsureSymbolMergeFallbackMs >= 0);
  });

  it("records pass-2 write attribution counters for mixed full-mode batches", async () => {
    const { createPass2WriteStats, insertPass2Edges } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const statements: string[] = [];
    const stats = createPass2WriteStats();
    const edges = [
      edge({
        fromSymbolId: "from-unresolved-target",
        toSymbolId: "unresolved:call:missing",
      }),
      edge({
        fromSymbolId: 'from-"unsafe"',
        toSymbolId: "to-unsafe",
      }),
      ...Array.from({ length: 512 }, (_, index) =>
        edge({
          fromSymbolId: `from-${index}`,
          toSymbolId: `to-${index}`,
        }),
      ),
    ];

    await insertPass2Edges(createFakeConnection(statements), edges, "full", stats);

    assert.strictEqual(stats.flushes, 1);
    assert.strictEqual(stats.totalEdges, 514);
    assert.strictEqual(stats.knownEndpointEdges, 513);
    assert.strictEqual(stats.repairEdges, 1);
    assert.strictEqual(stats.copyFlushes, 1);
    assert.strictEqual(stats.copyEdges, 513);
    assert.strictEqual(stats.copyPlaceholderTargets, 1);
    assert.strictEqual(stats.copyPlaceholderRows, 1);
    assert.strictEqual(stats.copyEnsuredPlaceholderRows, 1);
    assert.strictEqual(stats.copySkippedPlaceholderRows, 0);
    assert.strictEqual(stats.copyUnresolvedPlaceholderRows, 1);
    assert.strictEqual(stats.copyExternalPlaceholderRows, 0);
    assert.strictEqual(stats.repairFlushes, 1);
    assert.strictEqual(stats.repairInsertEdges, 1);
    assert.strictEqual(stats.repairUnsafeSourceEndpointEdges, 1);
    assert.strictEqual(stats.repairUnsafeTargetEndpointEdges, 0);
    assert.strictEqual(stats.repairUnsafeBothEndpointEdges, 0);
    assert.strictEqual(stats.repairUnresolvedSourceEdges, 0);
    assert.strictEqual(stats.repairOtherCauseEdges, 0);
    assert.ok(stats.copyEnsureMs >= 0);
    assert.ok(stats.copyEnsureSymbolMetadataMs >= 0);
    assert.ok(stats.copyInsertMs >= 0);
    assert.ok(stats.copyInsertCsvMaterializeMs >= 0);
    assert.ok(stats.copyInsertCopyFromMs >= 0);
    assert.ok(stats.repairInsertMs >= 0);
  });

  it("skips repeated full-mode placeholder repairs after a successful pass-2 ensure", async () => {
    const { createPass2WriteStats, insertPass2Edges } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const stats = createPass2WriteStats();
    const makeEdges = (prefix: string) => [
      edge({
        fromSymbolId: `${prefix}-placeholder-source`,
        toSymbolId: "unresolved:call:reused",
      }),
      ...Array.from({ length: 512 }, (_, index) =>
        edge({
          fromSymbolId: `${prefix}-from-${index}`,
          toSymbolId: `${prefix}-to-${index}`,
        }),
      ),
    ];

    await insertPass2Edges(
      createFakeConnection([]),
      makeEdges("first"),
      "full",
      stats,
    );
    await insertPass2Edges(
      createFakeConnection([]),
      makeEdges("second"),
      "full",
      stats,
    );

    assert.strictEqual(stats.copyPlaceholderRows, 2);
    assert.strictEqual(stats.copyEnsuredPlaceholderRows, 1);
    assert.strictEqual(stats.copySkippedPlaceholderRows, 1);
  });

  it("records primary repair causes before small COPY-safe rows are folded into repair", async () => {
    const { createPass2WriteStats, insertPass2Edges } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const stats = createPass2WriteStats();
    const edges = [
      edge({
        fromSymbolId: "unresolved:call:caller",
        toSymbolId: "target",
      }),
      edge({
        fromSymbolId: 'from-"unsafe"',
        toSymbolId: "target",
      }),
      edge({
        fromSymbolId: "from-safe",
        toSymbolId: "target,unsafe",
      }),
      edge({
        fromSymbolId: 'from-"unsafe-both"',
        toSymbolId: "target,unsafe-both",
      }),
      edge({
        fromSymbolId: "small-copy-safe",
        toSymbolId: "small-copy-target",
      }),
    ];

    await insertPass2Edges(createFakeConnection([]), edges, "full", stats);

    assert.strictEqual(stats.repairEdges, 4);
    assert.strictEqual(stats.smallKnownEndpointEdges, 1);
    assert.strictEqual(stats.repairInsertEdges, 5);
    assert.strictEqual(stats.repairUnresolvedSourceEdges, 1);
    assert.strictEqual(stats.repairUnsafeSourceEndpointEdges, 1);
    assert.strictEqual(stats.repairUnsafeTargetEndpointEdges, 1);
    assert.strictEqual(stats.repairUnsafeBothEndpointEdges, 1);
    assert.strictEqual(stats.repairOtherCauseEdges, 0);
  });

  it("keeps unsafe unresolved full-mode pass-2 targets on the generic repair path", async () => {
    const { insertPass2Edges, splitPass2EdgesForFullMode } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const statements: string[] = [];
    const unsafeUnresolved = edge({
      fromSymbolId: "from-unsafe-unresolved",
      toSymbolId: "unresolved:call:getMemoryEffects(Call,AAQIP).getModRef",
    });
    const edges = [
      unsafeUnresolved,
      ...Array.from({ length: 512 }, (_, index) =>
        edge({
          fromSymbolId: `from-${index}`,
          toSymbolId: `to-${index}`,
        }),
      ),
    ];

    const split = splitPass2EdgesForFullMode(edges);
    assert.strictEqual(split.knownEndpointEdges.length, 512);
    assert.deepStrictEqual(split.repairEdges, [unsafeUnresolved]);

    await insertPass2Edges(createFakeConnection(statements), edges, "full");

    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      1,
      "safe rows should still use relationship COPY",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (a)-[:DEPENDS_ON"),
      1,
      "unsafe unresolved target rows should use generic relationship create statements",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "SET d.weight = row.weight"),
      0,
      "full-mode unresolved writes should skip existing relationship refresh",
    );
  });

  it("keeps COPY-safe unresolved call IDs with unsafe labels on the COPY path", async () => {
    const { insertPass2Edges, splitPass2EdgesForFullMode } = await import(
      "../../dist/indexer/indexer-pass2.js"
    );
    const { unresolvedCallDependencyTarget, unresolvedCallSymbolId } =
      await import("../../dist/db/symbol-placeholders.js");
    const statements: string[] = [];
    const targetName = 'getMemoryEffects(Call,AAQIP).getModRef\r\n.unwrap("x")';
    const safeUnresolved = edge({
      fromSymbolId: "from-safe-encoded-unresolved",
      toSymbolId: unresolvedCallSymbolId(targetName),
      targetMeta: unresolvedCallDependencyTarget(targetName),
    });
    const edges = [
      safeUnresolved,
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

    await insertPass2Edges(createFakeConnection(statements), edges, "full");

    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      1,
      "encoded unresolved call IDs should stay relationship-COPY eligible",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (a)-[:DEPENDS_ON"),
      0,
      "encoded unresolved call IDs should not require generic repair create",
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
