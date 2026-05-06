import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { FinalizeIndexingParams } from "../../dist/indexer/metrics-updater.js";

const TEST_DB_PATH = join(
  tmpdir(),
  `.lbug-metrics-updater-${process.pid}.lbug`,
);

async function resetTestDb(): Promise<void> {
  const { closeLadybugDb, initLadybugDb } = await import("../../dist/db/ladybug.js");
  await closeLadybugDb();
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
  await initLadybugDb(TEST_DB_PATH);
}

describe("finalizeIndexing runtime fast paths", () => {
  it("skips expensive work for incremental no-op refreshes", async () => {
    const { finalizeIndexing } = await import("../../dist/indexer/metrics-updater.js");

    const params = {
      repoId: "no-op-repo",
      versionId: "v-noop",
      appConfig: { repos: [] },
      changedFileIds: new Set<string>(),
      hasIndexMutations: false,
      callResolutionTelemetry: {
        pass2EligibleFileCount: 0,
        pass2ProcessedFileCount: 0,
        pass2EdgesCreated: 0,
        pass2EdgesFailed: 0,
        pass2Duration: 0,
      },
    } satisfies FinalizeIndexingParams & { hasIndexMutations: boolean };

    const result = await finalizeIndexing(params);
    assert.deepStrictEqual(result, { timings: undefined });
  });
});

describe("materializeFileSummaries incremental targeting", () => {
  before(async () => {
    await resetTestDb();
  });

  after(async () => {
    const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
    await closeLadybugDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  it("materializes only changed files during incremental refreshes", async () => {
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const queries = await import("../../dist/db/ladybug-queries.js");
    const { materializeFileSummaries } = await import(
      "../../dist/indexer/metrics-updater.js"
    );

    await resetTestDb();
    const conn = await getLadybugConn();
    const repoId = "metrics-repo";
    const changedFileId = "file-changed";
    const unchangedFileId = "file-unchanged";

    await queries.upsertRepo(conn, {
      repoId,
      rootPath: "C:/tmp/metrics-repo",
      configJson: "{}",
      createdAt: "2026-04-02T00:00:00Z",
    });
    await queries.upsertFile(conn, {
      fileId: changedFileId,
      repoId,
      relPath: "src/changed.ts",
      contentHash: "changed-hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: null,
    });
    await queries.upsertFile(conn, {
      fileId: unchangedFileId,
      repoId,
      relPath: "src/unchanged.ts",
      contentHash: "unchanged-hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: null,
    });
    await queries.upsertSymbol(conn, {
      symbolId: "symbol-changed",
      repoId,
      fileId: changedFileId,
      kind: "function",
      name: "changedExport",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 10,
      astFingerprint: "changed-export",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: "2026-04-02T00:00:00Z",
    });
    await queries.upsertSymbol(conn, {
      symbolId: "symbol-unchanged",
      repoId,
      fileId: unchangedFileId,
      kind: "function",
      name: "unchangedExport",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 10,
      astFingerprint: "unchanged-export",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: "2026-04-02T00:00:00Z",
    });

    const materializeIncremental = materializeFileSummaries as unknown as (
      conn: import("kuzu").Connection,
      repoId: string,
      options?: { changedFileIds?: Set<string> },
    ) => Promise<{ total: number; updated: number }>;

    const result = await materializeIncremental(conn, repoId, {
      changedFileIds: new Set([changedFileId]),
    });

    assert.deepStrictEqual(result, { total: 1, updated: 1 });

    const changedSummary = await queries.getFileSummary(conn, changedFileId);
    const unchangedSummary = await queries.getFileSummary(conn, unchangedFileId);
    assert.ok(changedSummary);
    assert.match(changedSummary.searchText ?? "", /changedExport/);
    assert.equal(unchangedSummary, null);
  });

  it("treats an empty changed-file set as a no-op", async () => {
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const queries = await import("../../dist/db/ladybug-queries.js");
    const { materializeFileSummaries } = await import(
      "../../dist/indexer/metrics-updater.js"
    );

    await resetTestDb();
    const conn = await getLadybugConn();
    const repoId = "metrics-empty";
    const fileId = "file-empty";

    await queries.upsertRepo(conn, {
      repoId,
      rootPath: "C:/tmp/metrics-empty",
      configJson: "{}",
      createdAt: "2026-04-02T00:00:00Z",
    });
    await queries.upsertFile(conn, {
      fileId,
      repoId,
      relPath: "src/empty.ts",
      contentHash: "empty-hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: null,
    });
    await queries.upsertSymbol(conn, {
      symbolId: "symbol-empty",
      repoId,
      fileId,
      kind: "function",
      name: "emptyExport",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 10,
      astFingerprint: "empty-export",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: "2026-04-02T00:00:00Z",
    });

    const materializeIncremental = materializeFileSummaries as unknown as (
      conn: import("kuzu").Connection,
      repoId: string,
      options?: { changedFileIds?: Set<string> },
    ) => Promise<{ total: number; updated: number }>;

    const result = await materializeIncremental(conn, repoId, {
      changedFileIds: new Set(),
    });

    assert.deepStrictEqual(result, { total: 0, updated: 0 });
    const summary = await queries.getFileSummary(conn, fileId);
    assert.equal(summary, null);
  });

  it("normalizes file-backed symbols before derived metrics run", async () => {
    const { finalizeIndexing } = await import(
      "../../dist/indexer/metrics-updater.js"
    );
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const queries = await import("../../dist/db/ladybug-queries.js");

    await resetTestDb();
    const conn = await getLadybugConn();
    const repoId = "metrics-normalize";
    const fileId = "file-normalize";
    const symbolId = "symbol-normalize";

    await queries.upsertRepo(conn, {
      repoId,
      rootPath: "C:/tmp/metrics-normalize",
      configJson: JSON.stringify({ languages: ["ts"] }),
      createdAt: "2026-04-02T00:00:00Z",
    });
    await queries.upsertFile(conn, {
      fileId,
      repoId,
      relPath: "src/normalize.ts",
      contentHash: "normalize-hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: null,
    });
    await queries.upsertSymbol(conn, {
      symbolId,
      repoId,
      fileId,
      kind: "function",
      name: "normalizeMe",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 10,
      astFingerprint: "normalize-symbol",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: "2026-04-02T00:00:00Z",
    });
    await queries.exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})
       SET s.symbolStatus = 'unresolved',
           s.placeholderKind = 'call',
           s.placeholderTarget = 'stale.call'`,
      { symbolId },
    );

    await finalizeIndexing({
      repoId,
      versionId: "v-normalize",
      appConfig: { repos: [], semantic: { enabled: false } } as any,
      hasIndexMutations: true,
      callResolutionTelemetry: {
        pass2EligibleFileCount: 0,
        pass2ProcessedFileCount: 0,
        pass2EdgesCreated: 0,
        pass2EdgesFailed: 0,
        pass2Duration: 0,
      } as any,
    });

    const statusRow = await queries.querySingle<{
      status: string;
      placeholderKind: string;
      placeholderTarget: string;
    }>(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})
       RETURN s.symbolStatus AS status,
              s.placeholderKind AS placeholderKind,
              s.placeholderTarget AS placeholderTarget`,
      { symbolId },
    );
    const metricsRow = await queries.querySingle<{ count: unknown }>(
      conn,
      `MATCH (m:Metrics {symbolId: $symbolId}) RETURN count(m) AS count`,
      { symbolId },
    );

    assert.equal(statusRow?.status, "real");
    assert.equal(statusRow?.placeholderKind, "");
    assert.equal(statusRow?.placeholderTarget, "");
    assert.equal(queries.toNumber(metricsRow?.count ?? 0), 1);
  });

  it("repairs and audits dependency placeholder quality before reporting success", async () => {
    const { finalizeIndexing } = await import(
      "../../dist/indexer/metrics-updater.js"
    );
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const queries = await import("../../dist/db/ladybug-queries.js");

    await resetTestDb();
    const conn = await getLadybugConn();
    const repoId = "metrics-placeholder-quality";
    const fileId = "file-placeholder-quality";
    const sourceSymbolId = "symbol-placeholder-source";

    await queries.upsertRepo(conn, {
      repoId,
      rootPath: "C:/tmp/metrics-placeholder-quality",
      configJson: JSON.stringify({ languages: ["ts"] }),
      createdAt: "2026-04-02T00:00:00Z",
    });
    await queries.upsertFile(conn, {
      fileId,
      repoId,
      relPath: "src/source.ts",
      contentHash: "source-hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: null,
    });
    await queries.upsertSymbol(conn, {
      symbolId: sourceSymbolId,
      repoId,
      fileId,
      kind: "function",
      name: "source",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 10,
      astFingerprint: "source-symbol",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: "2026-04-02T00:00:00Z",
    });
    await queries.exec(
      conn,
      `MATCH (r:Repo {repoId: $repoId})
       MATCH (source:Symbol {symbolId: $sourceSymbolId})
       CREATE (external:Symbol {
         symbolId: 'unresolved:zod:z',
         repoId: $repoId,
         symbolStatus: 'unresolved',
         placeholderKind: 'import',
         placeholderTarget: 'wrong target',
         external: false
       })
       CREATE (unresolved:Symbol {
         symbolId: 'unresolved:call:makeThing',
         repoId: $repoId,
         symbolStatus: 'external',
         placeholderKind: 'import',
         placeholderTarget: 'wrong call',
         external: true
       })
       CREATE (isolated:Symbol {
         symbolId: 'unresolved:call:staleThing',
         repoId: $repoId,
         symbolStatus: 'unresolved',
         placeholderKind: 'call',
         placeholderTarget: 'staleThing',
         external: false
       })
       CREATE (external)-[:SYMBOL_IN_REPO]->(r)
       CREATE (unresolved)-[:SYMBOL_IN_REPO]->(r)
       CREATE (isolated)-[:SYMBOL_IN_REPO]->(r)
       CREATE (source)-[:DEPENDS_ON {
         edgeType: 'import',
         weight: 0.6,
         confidence: 1.0,
         resolution: 'exact',
         resolverId: 'pass1-generic',
         resolutionPhase: 'pass1',
         provenance: 'import:zod:z',
         createdAt: '2026-04-02T00:00:00Z'
       }]->(external)
       CREATE (source)-[:DEPENDS_ON {
         edgeType: 'call',
         weight: 0.5,
         confidence: 0.7,
         resolution: 'unresolved',
         resolverId: 'pass2-ts',
         resolutionPhase: 'pass2',
         provenance: 'unresolved-call:makeThing',
         createdAt: '2026-04-02T00:00:00Z'
       }]->(unresolved)`,
      { repoId, sourceSymbolId },
    );

    const result = await finalizeIndexing({
      repoId,
      versionId: "v-placeholder-quality",
      appConfig: { repos: [], semantic: { enabled: false } } as any,
      hasIndexMutations: true,
      callResolutionTelemetry: {
        pass2EligibleFileCount: 0,
        pass2ProcessedFileCount: 0,
        pass2EdgesCreated: 0,
        pass2EdgesFailed: 0,
        pass2Duration: 0,
      } as any,
    });

    const rows = await queries.queryAll<{
      symbolId: string;
      status: string;
      placeholderKind: string;
      placeholderTarget: string;
      external: unknown;
    }>(
      conn,
      `MATCH (s:Symbol {repoId: $repoId})
       WHERE s.symbolId STARTS WITH 'unresolved:'
       RETURN s.symbolId AS symbolId,
              s.symbolStatus AS status,
              s.placeholderKind AS placeholderKind,
              s.placeholderTarget AS placeholderTarget,
              coalesce(s.external, false) AS external
       ORDER BY symbolId`,
      { repoId },
    );

    assert.deepEqual(rows, [
      {
        symbolId: "unresolved:call:makeThing",
        status: "unresolved",
        placeholderKind: "call",
        placeholderTarget: "makeThing",
        external: false,
      },
      {
        symbolId: "unresolved:zod:z",
        status: "external",
        placeholderKind: "import",
        placeholderTarget: "z (from zod)",
        external: true,
      },
    ]);
    assert.equal(result.qualityStats?.unresolvedTargets, 1);
    assert.equal(result.qualityStats?.externalTargets, 1);
    assert.equal(result.qualityStats?.untypedPlaceholderTargets, 0);
    assert.equal((result.qualityStats as any)?.placeholderTargetMismatches, 0);
    assert.equal((result.qualityStats as any)?.isolatedPlaceholders, 0);
    assert.deepEqual((result.qualityStats as any)?.placeholderCounts, {
      "external:import": 1,
      "unresolved:call": 1,
    });
  });
});
