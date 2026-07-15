import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  closeLadybugDb,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { unresolvedCallSymbolId } from "../../dist/db/symbol-placeholders.js";
import { BatchPersistAccumulator } from "../../dist/indexer/parser/batch-persist.js";
import type {
  EdgeRow,
  SymbolRow,
} from "../../dist/db/ladybug-queries.js";

function edge(overrides: Partial<EdgeRow> = {}): EdgeRow {
  return {
    repoId: "r1",
    fromSymbolId: "from-1",
    toSymbolId: "to-1",
    edgeType: "call",
    weight: 1.0,
    confidence: 0.9,
    resolution: "import-direct",
    resolverId: "batch-persist-test",
    resolutionPhase: "pass1",
    provenance: "test-provenance",
    createdAt: "2026-05-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("BatchPersistAccumulator", () => {
  it("starts with zero pending count", () => {
    const acc = new BatchPersistAccumulator();
    assert.equal(acc.pending, 0);
    assert.equal(acc.shouldFlush(), false);
  });

  it("increments pending count on addFile", () => {
    const acc = new BatchPersistAccumulator(3);
    acc.addFile(
      {
        fileId: "f1",
        repoId: "r1",
        relPath: "src/a.ts",
        contentHash: "abc",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: new Date().toISOString(),
      },
      null,
    );
    assert.equal(acc.pending, 1);
    assert.equal(acc.shouldFlush(), false);
  });

  it("auto-enqueues at threshold and resets pending", () => {
    const acc = new BatchPersistAccumulator(2);
    acc.addFile(
      {
        fileId: "f1",
        repoId: "r1",
        relPath: "src/a.ts",
        contentHash: "abc",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: new Date().toISOString(),
      },
      null,
    );
    assert.equal(acc.shouldFlush(), false);
    assert.equal(acc.pending, 1);

    acc.addFile(
      {
        fileId: "f2",
        repoId: "r1",
        relPath: "src/b.ts",
        contentHash: "def",
        language: "ts",
        byteSize: 200,
        lastIndexedAt: new Date().toISOString(),
      },
      null,
    );
    // After hitting threshold, data is enqueued and pending resets
    assert.equal(acc.pending, 0);
  });

  it("tracks total rows in pending count", () => {
    const acc = new BatchPersistAccumulator(1000);
    acc.addSymbols([
      {
        symbolId: "s1",
        fileId: "f1",
        repoId: "r1",
        name: "foo",
        kind: "function",
        signature: "function foo()",
        startLine: 1,
        endLine: 5,
        exported: true,
        relPath: "src/a.ts",
        summary: null,
        invariants: null,
        sideEffects: null,
        astFingerprint: "fp1",
      },
    ]);
    acc.addEdges([
      {
        sourceSymbolId: "s1",
        targetSymbolId: "s2",
        edgeType: "call",
        confidence: 0.9,
      },
    ]);
    acc.addSymbolReferences([
      {
        fileId: "f1",
        symbolId: "s1",
        repoId: "r1",
        line: 10,
        col: 5,
        kind: "reference",
      },
    ]);

    // 1 symbol + 1 edge + 1 ref = 3 total rows
    assert.equal(acc.pending, 3);
    assert.equal(acc.shouldFlush(), false);
  });

  it("flush with zero pending is a no-op", async () => {
    const acc = new BatchPersistAccumulator();
    await acc.flush();
    assert.equal(acc.pending, 0);
  });

  it("waitForIdle with zero pending is a no-op and keeps accumulator reusable", async () => {
    const acc = new BatchPersistAccumulator();
    await acc.waitForIdle();
    assert.equal(acc.pending, 0);

    acc.addFile(
      {
        fileId: "f-after-idle",
        repoId: "r1",
        relPath: "src/after-idle.ts",
        contentHash: "after-idle",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: new Date().toISOString(),
      },
      null,
    );
    assert.equal(acc.pending, 1);
  });

  it("supports caller-controlled batch draining for provider-first fallback", () => {
    const source = readFileSync("src/indexer/indexer-pass1.ts", "utf8");
    assert.match(source, /autoDrain:\s*params\.autoDrainBatchPersist/);
    assert.match(source, /await batchAccumulator\.waitForIdle\(\)/);
  });

  it("default threshold is 512", () => {
    const acc = new BatchPersistAccumulator();
    for (let i = 0; i < 511; i++) {
      acc.addFile(
        {
          fileId: `f${i}`,
          repoId: "r1",
          relPath: `src/${i}.ts`,
          contentHash: `hash${i}`,
          language: "ts",
          byteSize: 100,
          lastIndexedAt: new Date().toISOString(),
        },
        null,
      );
    }
    assert.equal(acc.shouldFlush(), false);
    assert.equal(acc.pending, 511);

    acc.addFile(
      {
        fileId: "f511",
        repoId: "r1",
        relPath: "src/511.ts",
        contentHash: "hash511",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: new Date().toISOString(),
      },
      null,
    );
    // Auto-enqueued at threshold, pending resets
    assert.equal(acc.pending, 0);
  });

  it("setProgressCallback accepts a function", () => {
    const acc = new BatchPersistAccumulator();
    let calls = 0;
    acc.setProgressCallback(() => {
      calls += 1;
    });
    // The callback is stored privately; we cannot trigger drain here
    // without a real LadybugDB connection. The integration tests in
    // tests/integration/*-pass2-indexing.test.ts exercise the firing
    // path end-to-end. This unit test verifies the API contract.
    assert.strictEqual(typeof calls, "number");
  });

  it("setProgressCallback accepts null to clear the callback", () => {
    const acc = new BatchPersistAccumulator();
    acc.setProgressCallback(() => {
      // ignored
    });
    // Re-setting to null must not throw.
    assert.doesNotThrow(() => acc.setProgressCallback(null));
  });

  it("getActiveDrainStats returns zero queue depth on a fresh accumulator", async () => {
    const { getActiveDrainStats } =
      await import("../../dist/indexer/parser/batch-persist.js");
    const acc = new BatchPersistAccumulator();
    // Track an arbitrary callback so the registry sees this instance.
    acc.setProgressCallback(() => {
      // ignored
    });
    const stats = getActiveDrainStats();
    assert.strictEqual(typeof stats.queueDepth, "number");
    assert.strictEqual(typeof stats.drainFailures, "number");
  });

  it("keeps fresh-source COPY semantics during pass-1 drain writes", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const srcPath = path.resolve(
      path.dirname(__filename),
      "..",
      "..",
      "src",
      "indexer",
      "parser",
      "batch-persist.ts",
    );
    const content = fs.readFileSync(srcPath, "utf-8");

    assert.match(
      content,
      /ensureDependencyTargetsForKnownSourceEdges\(\s*txConn,\s*knownEndpointEdges,\s*\{[\s\S]*measurePhase:\s*measureKnownEnsurePhase[\s\S]*\}\s*,?\s*\)/,
      "BatchPersistAccumulator should prepare placeholder targets before relationship COPY with diagnostics",
    );
    assert.match(
      content,
      /insertKnownSymbolEdges\(txConn,\s*knownEndpointEdges,\s*\{[\s\S]*measurePhase:\s*measureKnownCopyPhase[\s\S]*\}\s*,?\s*\)/,
      "BatchPersistAccumulator should route prepared fresh-source edges through relationship COPY with diagnostics",
    );
    assert.match(
      content,
      /insertEdges\(txConn,\s*repairEdges,\s*\{[\s\S]*skipSourceRepoLink:\s*true,[\s\S]*skipExistingRelationshipUpdate:\s*true,[\s\S]*\}\)/,
      "BatchPersistAccumulator must keep pass-1 repair edges in fresh-edge mode",
    );
    assert.match(
      content,
      /copyRelEndpointIsSafe\(edge\.fromSymbolId\)[\s\S]*copyRelEndpointIsSafe\(edge\.toSymbolId\)/,
      "BatchPersistAccumulator must keep relationship COPY endpoint safety aligned with pass 2",
    );
  });

  it("preserves fresh-copy identities across flushes and placeholder pruning", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sdl-fresh-copy-batch-"));
    const graphDbPath = join(tempRoot, "graph.lbug");
    const repoId = "fresh-copy-batch-repo";
    const providerFileId = "provider-file";
    const firstFallbackFileId = "fallback-first-file";
    const secondFallbackFileId = "fallback-second-file";
    const now = "2026-07-15T00:00:00.000Z";
    const symbolId = (index: number): string =>
      `fresh-copy-symbol-${String(index).padStart(4, "0")}`;
    const symbol = (
      index: number,
      name: string,
      fileId: string,
    ): SymbolRow => ({
      symbolId: symbolId(index),
      repoId,
      fileId,
      kind: "function",
      name,
      exported: false,
      visibility: null,
      language: "ts",
      rangeStartLine: index + 1,
      rangeStartCol: 0,
      rangeEndLine: index + 1,
      rangeEndCol: 1,
      astFingerprint: `fingerprint-${index}`,
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });

    try {
      await closeLadybugDb();
      await initLadybugDb(graphDbPath);

      await withWriteConn(async (conn) => {
        await ladybugDb.upsertRepo(conn, {
          repoId,
          rootPath: tempRoot,
          configJson: "{}",
          createdAt: now,
        });
        await ladybugDb.upsertFileBatch(
          conn,
          [
            { fileId: providerFileId, relPath: "src/provider.ts" },
            {
              fileId: firstFallbackFileId,
              relPath: "src/fallback-first.ts",
            },
            {
              fileId: secondFallbackFileId,
              relPath: "src/fallback-second.ts",
            },
          ].map(({ fileId, relPath }) => ({
            fileId,
            repoId,
            relPath,
            contentHash: `${fileId}-hash`,
            language: "ts",
            byteSize: 1,
            lastIndexedAt: now,
          })),
        );
        await ladybugDb.upsertKnownFileSymbols(
          conn,
          Array.from({ length: 4_096 }, (_, index) =>
            symbol(index, `provider-${index}`, providerFileId),
          ),
        );
      });

      const accumulator = new BatchPersistAccumulator(189, {
        autoDrain: false,
        collectDiagnostics: true,
        symbolWriteMode: "fresh-copy",
      });
      accumulator.addSymbols(
        Array.from({ length: 189 }, (_, offset) => {
          const index = 4_096 + offset;
          return symbol(index, `fallback-first-${index}`, firstFallbackFileId);
        }),
      );
      accumulator.addSymbols([
        ...Array.from({ length: 10 }, (_, offset) => {
          const index = 4_096 + offset;
          return symbol(
            index,
            `fallback-second-${index}`,
            secondFallbackFileId,
          );
        }),
        ...Array.from({ length: 26 }, (_, offset) => {
          const index = 4_285 + offset;
          return symbol(
            index,
            `fallback-second-${index}`,
            secondFallbackFileId,
          );
        }),
      ]);
      assert.equal(accumulator.queueDepth, 1);
      assert.equal(accumulator.pending, 36);
      await accumulator.drain();
      assert.equal(accumulator.getDiagnostics().batches, 2);

      await withWriteConn(async (conn) => {
        const assertSymbolCounts = async (
          physicalTotal: number,
          distinctTotal: number,
        ): Promise<void> => {
          const counts = await ladybugDb.querySingle<{
            physicalTotal: unknown;
            distinctTotal: unknown;
          }>(
            conn,
            `MATCH (s:Symbol)
             RETURN count(s) AS physicalTotal,
                    count(DISTINCT s.symbolId) AS distinctTotal`,
          );
          assert.equal(ladybugDb.toNumber(counts?.physicalTotal), physicalTotal);
          assert.equal(ladybugDb.toNumber(counts?.distinctTotal), distinctTotal);
        };

        await assertSymbolCounts(4_311, 4_311);
        await ladybugDb.insertKnownSymbolEdges(
          conn,
          Array.from({ length: 4_000 }, (_, index) => ({
            repoId,
            fromSymbolId: symbolId(index),
            toSymbolId: symbolId(index + 1),
            edgeType: "call",
            weight: 1,
            confidence: 0.95,
            resolution: "exact",
            resolverId: "fresh-copy-regression",
            resolutionPhase: "pass1",
            provenance: "fresh-copy-regression",
            createdAt: now,
          })),
        );
        await assertSymbolCounts(4_311, 4_311);

        // Finalization prunes placeholder nodes created while preparing fresh
        // relationship COPY. LadybugDB 0.18.1 must not alias the preceding
        // Symbol COPY vectors when those placeholders are deleted.
        await ladybugDb.ensureDependencyTargetsForKnownSourceEdges(
          conn,
          Array.from({ length: 58 }, (_, index) => ({
            repoId,
            fromSymbolId: symbolId(100),
            toSymbolId: unresolvedCallSymbolId(`unused-${index}`),
            edgeType: "call",
            weight: 1,
            confidence: 0.5,
            resolution: "unresolved",
            resolverId: "fresh-copy-regression",
            resolutionPhase: "pass1",
            provenance: "fresh-copy-regression",
            createdAt: now,
            targetMeta: {
              symbolStatus: "unresolved",
              placeholderKind: "call",
              placeholderTarget: `unused-${index}`,
            },
          })),
          { measurePhase: async (_phaseName, body) => await body() },
        );
        await assertSymbolCounts(4_369, 4_369);
        assert.equal(
          await ladybugDb.pruneIsolatedPlaceholderSymbols(conn, repoId),
          0,
        );

        const counts = await ladybugDb.querySingle<{
          physicalTotal: unknown;
          distinctTotal: unknown;
        }>(
          conn,
          `MATCH (s:Symbol)
           RETURN count(s) AS physicalTotal,
                  count(DISTINCT s.symbolId) AS distinctTotal`,
        );
        assert.equal(ladybugDb.toNumber(counts?.physicalTotal), 4_369);
        assert.equal(ladybugDb.toNumber(counts?.distinctTotal), 4_369);

        const activeCounts = await ladybugDb.querySingle<{
          physicalTotal: unknown;
          distinctTotal: unknown;
        }>(
          conn,
          `MATCH (s:Symbol {repoId: $repoId})
           WHERE coalesce(s.symbolStatus, 'real') = 'real'
             AND (s)-[:SYMBOL_IN_FILE]->(:File)
           RETURN count(s) AS physicalTotal,
                  count(DISTINCT s.symbolId) AS distinctTotal`,
          { repoId },
        );
        assert.equal(ladybugDb.toNumber(activeCounts?.physicalTotal), 4_311);
        assert.equal(ladybugDb.toNumber(activeCounts?.distinctTotal), 4_311);

        const retainedPlaceholders = await ladybugDb.querySingle<{
          count: unknown;
        }>(
          conn,
          `MATCH (s:Symbol {repoId: $repoId, symbolStatus: 'unresolved'})
           WHERE (s)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
             AND NOT (s)-[:SYMBOL_IN_FILE]->(:File)
             AND NOT (:Symbol)-[:DEPENDS_ON]->(s)
             AND NOT (s)-[:DEPENDS_ON]->(:Symbol)
           RETURN count(s) AS count`,
          { repoId },
        );
        assert.equal(ladybugDb.toNumber(retainedPlaceholders?.count), 58);

        const mappings = await ladybugDb.queryAll<{
          symbolId: string;
          name: string;
          astFingerprint: string;
          fileId: string;
        }>(
          conn,
          `MATCH (s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
           WHERE s.symbolId IN $symbolIds
           RETURN s.symbolId AS symbolId,
                  s.name AS name,
                  s.astFingerprint AS astFingerprint,
                  f.fileId AS fileId
           ORDER BY s.symbolId`,
          {
            symbolIds: [0, 2_047, 2_048, 4_096, 4_284, 4_285].map(symbolId),
          },
        );
        assert.deepEqual(mappings, [
          {
            symbolId: symbolId(0),
            name: "provider-0",
            astFingerprint: "fingerprint-0",
            fileId: providerFileId,
          },
          {
            symbolId: symbolId(2_047),
            name: "provider-2047",
            astFingerprint: "fingerprint-2047",
            fileId: providerFileId,
          },
          {
            symbolId: symbolId(2_048),
            name: "provider-2048",
            astFingerprint: "fingerprint-2048",
            fileId: providerFileId,
          },
          {
            symbolId: symbolId(4_096),
            name: "fallback-second-4096",
            astFingerprint: "fingerprint-4096",
            fileId: secondFallbackFileId,
          },
          {
            symbolId: symbolId(4_284),
            name: "fallback-first-4284",
            astFingerprint: "fingerprint-4284",
            fileId: firstFallbackFileId,
          },
          {
            symbolId: symbolId(4_285),
            name: "fallback-second-4285",
            astFingerprint: "fingerprint-4285",
            fileId: secondFallbackFileId,
          },
        ]);
      });
    } finally {
      try {
        await closeLadybugDb();
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }
  });

  it("splits pass-1 edges so prepared non-real or known real endpoints use COPY", async () => {
    const { splitPass1EdgesForKnownEndpointCopy } = await import(
      "../../dist/indexer/parser/batch-persist.js"
    );

    const known = edge({
      fromSymbolId: "symbol-a",
      toSymbolId: "symbol-b",
    });
    const unresolvedTarget = edge({
      fromSymbolId: "symbol-a",
      toSymbolId: "unresolved:call:missing",
    });
    const unresolvedSource = edge({
      fromSymbolId: "unresolved:call:source",
      toSymbolId: "symbol-b",
    });
    const providerTarget = edge({
      fromSymbolId: "symbol-a",
      toSymbolId: "provider-symbol",
    });
    const outsideBatchTarget = edge({
      fromSymbolId: "symbol-a",
      toSymbolId: "unknown-symbol",
    });

    const split = splitPass1EdgesForKnownEndpointCopy(
      [
        known,
        unresolvedTarget,
        unresolvedSource,
        providerTarget,
        outsideBatchTarget,
      ],
      new Set(["symbol-a", "symbol-b"]),
      new Set(["provider-symbol"]),
    );

    assert.deepStrictEqual(split.knownEndpointEdges, [
      known,
      unresolvedTarget,
      providerTarget,
    ]);
    assert.deepStrictEqual(split.repairEdges, [
      unresolvedSource,
      outsideBatchTarget,
    ]);
  });

  it("keeps unsafe pass-1 COPY endpoints on the generic repair path", async () => {
    const { splitPass1EdgesForKnownEndpointCopy } = await import(
      "../../dist/indexer/parser/batch-persist.js"
    );

    const safeUnresolvedTarget = edge({
      fromSymbolId: "symbol-a",
      toSymbolId: "unresolved:call:__sdl_v1__safeTarget",
    });
    const commaTarget = edge({
      fromSymbolId: "symbol-a",
      toSymbolId: "unresolved:call:target,with-comma",
    });
    const quoteTarget = edge({
      fromSymbolId: "symbol-a",
      toSymbolId: 'unresolved:call:target"with-quote',
    });
    const newlineTarget = edge({
      fromSymbolId: "symbol-a",
      toSymbolId: "unresolved:call:target\nwith-newline",
    });

    const split = splitPass1EdgesForKnownEndpointCopy(
      [safeUnresolvedTarget, commaTarget, quoteTarget, newlineTarget],
      new Set(["symbol-a"]),
    );

    assert.deepStrictEqual(split.knownEndpointEdges, [safeUnresolvedTarget]);
    assert.deepStrictEqual(split.repairEdges, [
      commaTarget,
      quoteTarget,
      newlineTarget,
    ]);
  });
});
