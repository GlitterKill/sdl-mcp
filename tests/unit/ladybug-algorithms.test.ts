import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  detectAlgoCapability,
  runPageRank,
  runKCore,
  runLouvain,
  shortestPath,
  clearAlgoCapabilityCache,
  graphProjectionName,
} from "../../dist/db/ladybug-algorithms.js";

const TEST_DB_PATH = join(tmpdir(), ".lbug-algorithms-test-db.lbug");

async function resetDb(): Promise<void> {
  await closeLadybugDb();
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
  await initLadybugDb(TEST_DB_PATH);
}

async function seedChain(repoId: string, symbolIds: string[]): Promise<void> {
  const conn = await getLadybugConn();
  const now = "2026-04-09T00:00:00.000Z";
  await ladybugDb.upsertRepo(conn, {
    repoId,
    rootPath: "C:/algo-test",
    configJson: JSON.stringify({ policy: {} }),
    createdAt: now,
  });
  await ladybugDb.upsertFile(conn, {
    fileId: `${repoId}-file`,
    repoId,
    relPath: "src/main.ts",
    contentHash: "hash",
    language: "ts",
    byteSize: 100,
    lastIndexedAt: now,
  });
  for (const symbolId of symbolIds) {
    await ladybugDb.upsertSymbol(conn, {
      symbolId,
      repoId,
      fileId: `${repoId}-file`,
      kind: "function",
      name: symbolId,
      exported: true,
      visibility: null,
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 4,
      rangeEndCol: 0,
      astFingerprint: `${symbolId}-fp`,
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
  }
  // Build call chain s0 -> s1 -> s2 -> ...
  for (let i = 0; i < symbolIds.length - 1; i++) {
    await ladybugDb.insertEdge(conn, {
      repoId,
      fromSymbolId: symbolIds[i],
      toSymbolId: symbolIds[i + 1],
      edgeType: "call",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      provenance: "test",
      createdAt: now,
    });
  }
}

describe("LadybugDB Algorithm Adapter", () => {
  before(() => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  describe("graphProjectionName", () => {
    it("is deterministic", () => {
      assert.strictEqual(
        graphProjectionName("sdl-mcp"),
        graphProjectionName("sdl-mcp"),
      );
    });
    it("sanitizes non-identifier characters", () => {
      assert.strictEqual(
        graphProjectionName("my/weird:repo.name"),
        "sdl_graph_my_weird_repo_name",
      );
    });
  });

  describe("detectAlgoCapability", () => {
    it("caches the outcome per-connection", async () => {
      await resetDb();
      const conn = await getLadybugConn();
      const first = await detectAlgoCapability(conn);
      const second = await detectAlgoCapability(conn);
      // Exact same object reference means the cache returned a hit.
      assert.strictEqual(first, second);
    });

    it("does not throw when extension unavailable", async () => {
      await resetDb();
      const conn = await getLadybugConn();
      clearAlgoCapabilityCache(conn);
      // Should resolve to either supported or {supported: false, reason}
      const cap = await detectAlgoCapability(conn);
      assert.ok(typeof cap.supported === "boolean");
    });
  });

  describe("fallback contract (no algo extension)", () => {
    it("runPageRank returns [] when unsupported", async () => {
      await resetDb();
      await seedChain("algo-repo-1", ["a", "b", "c"]);
      const conn = await getLadybugConn();
      clearAlgoCapabilityCache(conn);
      const rows = await runPageRank(conn, "algo-repo-1");
      assert.ok(Array.isArray(rows));
      // Extension is typically NOT available in CI; assert non-throw and
      // bail on content assertions when it happens to be supported.
      if ((await detectAlgoCapability(conn)).supported === false) {
        assert.strictEqual(rows.length, 0);
      }
    });

    it("runKCore returns [] when unsupported", async () => {
      await resetDb();
      await seedChain("algo-repo-2", ["a", "b", "c"]);
      const conn = await getLadybugConn();
      clearAlgoCapabilityCache(conn);
      const rows = await runKCore(conn, "algo-repo-2");
      assert.ok(Array.isArray(rows));
      if ((await detectAlgoCapability(conn)).supported === false) {
        assert.strictEqual(rows.length, 0);
      }
    });

    it("runLouvain returns [] when unsupported", async () => {
      await resetDb();
      await seedChain("algo-repo-3", ["a", "b", "c"]);
      const conn = await getLadybugConn();
      clearAlgoCapabilityCache(conn);
      const rows = await runLouvain(conn, "algo-repo-3");
      assert.ok(Array.isArray(rows));
      if ((await detectAlgoCapability(conn)).supported === false) {
        assert.strictEqual(rows.length, 0);
      }
    });
  });

  describe("shortestPath (native Cypher path syntax)", () => {
    it("returns [from] when from === to", async () => {
      await resetDb();
      await seedChain("algo-repo-4", ["a", "b", "c"]);
      const conn = await getLadybugConn();
      const path = await shortestPath(conn, "algo-repo-4", "a", "a", 5);
      assert.deepStrictEqual(path, ["a"]);
    });

    it("returns null when no path exists", async () => {
      await resetDb();
      await seedChain("algo-repo-5", ["a", "b"]);
      const conn = await getLadybugConn();
      // b has no outgoing edge → no path from b to a
      const path = await shortestPath(conn, "algo-repo-5", "b", "a", 5);
      assert.strictEqual(path, null);
    });

    it("respects the maxHops bound (returns null when hops exceed budget)", async () => {
      await resetDb();
      // 6-node chain: a -> b -> c -> d -> e -> f (5 hops total)
      await seedChain("algo-repo-6", ["a", "b", "c", "d", "e", "f"]);
      const conn = await getLadybugConn();
      const withinBudget = await shortestPath(conn, "algo-repo-6", "a", "f", 6);
      assert.ok(withinBudget !== null);
      assert.ok(withinBudget!.length >= 2);

      const overBudget = await shortestPath(conn, "algo-repo-6", "a", "f", 2);
      assert.strictEqual(overBudget, null);
    });
  });

  describe("supported algo path", () => {
    function createQueryResult(rows: unknown[]) {
      return {
        async getAll() {
          return rows;
        },
        close() {},
      };
    }

    function createFakeAlgoConn() {
      const calls: Array<{ statement: string; params: Record<string, unknown> }> =
        [];
      const conn = {
        async prepare(statement: string) {
          return statement;
        },
        async execute(
          prepared: string,
          params: Record<string, unknown>,
        ) {
          calls.push({ statement: prepared, params });

          if (prepared === "INSTALL algo" || prepared === "LOAD algo") {
            return createQueryResult([]);
          }
          if (prepared.includes("CALL PROJECT_GRAPH")) {
            return createQueryResult([]);
          }
          if (prepared.includes("CALL page_rank")) {
            return createQueryResult([{ symbolId: "sym-a", score: 0.5 }]);
          }
          if (prepared.includes("CALL k_core_decomposition")) {
            return createQueryResult([{ symbolId: "sym-a", coreness: 3 }]);
          }
          if (prepared.includes("CALL louvain")) {
            return createQueryResult([{ symbolId: "sym-a", communityId: 7 }]);
          }

          throw new Error(`Unexpected statement: ${prepared}`);
        },
      };

      return { conn, calls };
    }

    it("creates one repo-scoped projected graph and reuses it across algorithms", async () => {
      const { conn, calls } = createFakeAlgoConn();
      const repoId = "repo-with-projection";
      clearAlgoCapabilityCache(conn as unknown as import("kuzu").Connection);

      const pageRank = await runPageRank(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      const kCore = await runKCore(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      const louvain = await runLouvain(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );

      assert.deepStrictEqual(pageRank, [{ symbolId: "sym-a", score: 0.5 }]);
      assert.deepStrictEqual(kCore, [{ symbolId: "sym-a", coreness: 3 }]);
      assert.deepStrictEqual(louvain, [
        { symbolId: "sym-a", communityId: 7 },
      ]);

      const projectionCalls = calls.filter((call) =>
        call.statement.includes("CALL PROJECT_GRAPH"),
      );
      assert.strictEqual(projectionCalls.length, 1);
      assert.ok(
        projectionCalls[0]?.statement.includes(graphProjectionName(repoId)),
      );
      assert.ok(
        projectionCalls[0]?.statement.includes(`n.repoId = "${repoId}"`),
      );
      assert.ok(
        projectionCalls[0]?.statement.includes(`r.edgeType = "call"`),
      );

      const algoStatements = calls
        .map((call) => call.statement)
        .filter((statement) => statement.includes("CALL "));
      assert.ok(algoStatements.some((statement) => statement.includes("page_rank")));
      assert.ok(
        algoStatements.some((statement) =>
          statement.includes("k_core_decomposition"),
        ),
      );
      assert.ok(algoStatements.some((statement) => statement.includes("louvain")));
      assert.ok(
        algoStatements.every((statement) => !statement.includes("MATCH (s:Symbol")),
      );
    });
  });
});
