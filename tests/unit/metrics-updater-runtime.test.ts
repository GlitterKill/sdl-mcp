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

  it("skips unchanged file summaries and preserves their timestamps", async () => {
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const queries = await import("../../dist/db/ladybug-queries.js");
    const { materializeFileSummaries } = await import(
      "../../dist/indexer/metrics-updater.js"
    );

    await resetTestDb();
    const conn = await getLadybugConn();
    const repoId = "metrics-summary-stable";
    const fileId = "file-stable";

    await queries.upsertRepo(conn, {
      repoId,
      rootPath: "C:/tmp/metrics-summary-stable",
      configJson: "{}",
      createdAt: "2026-04-02T00:00:00Z",
    });
    await queries.upsertFile(conn, {
      fileId,
      repoId,
      relPath: "src/stable.ts",
      contentHash: "stable-hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: null,
    });
    await queries.upsertSymbol(conn, {
      symbolId: "symbol-stable",
      repoId,
      fileId,
      kind: "function",
      name: "stableExport",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 10,
      astFingerprint: "stable-export",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: "2026-04-02T00:00:00Z",
    });

    const materialize = materializeFileSummaries as unknown as (
      conn: import("kuzu").Connection,
      repoId: string,
      options?: { changedFileIds?: Set<string>; includeTimings?: boolean },
    ) => Promise<{
      total: number;
      updated: number;
      timings?: Record<string, number>;
    }>;

    const first = await materialize(conn, repoId);
    assert.deepStrictEqual(first, { total: 1, updated: 1 });
    const firstSummary = await queries.getFileSummary(conn, fileId);
    assert.ok(firstSummary);

    const stableTimestamp = "2026-04-02T12:00:00.000Z";
    await queries.upsertFileSummaryBatch(conn, [
      {
        fileId,
        repoId,
        summary: firstSummary.summary,
        searchText: firstSummary.searchText,
        updatedAt: stableTimestamp,
      },
    ]);

    const second = await materialize(conn, repoId, { includeTimings: true });

    assert.equal(second.total, 1);
    assert.equal(second.updated, 0);
    assert.equal(typeof second.timings?.loadFiles, "number");
    assert.equal(typeof second.timings?.loadExistingSummaries, "number");
    assert.equal(typeof second.timings?.buildPayloads, "number");
    assert.equal(second.timings?.writeSummaries, 0);
    assert.equal(second.timings?.writeWait, 0);
    const secondSummary = await queries.getFileSummary(conn, fileId);
    assert.equal(secondSummary?.updatedAt, stableTimestamp);
  });

  it("skips full metrics row rewrite when the metrics payload is unchanged", async () => {
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const queries = await import("../../dist/db/ladybug-queries.js");
    const metrics = await import("../../dist/graph/metrics.js");

    await resetTestDb();
    const conn = await getLadybugConn();
    const repoId = "metrics-fingerprint-skip";
    const fileId = "file-fingerprint-skip";
    const symbolId = "symbol-fingerprint-skip";
    const repoRoot = join(tmpdir(), `sdl-mcp-${repoId}`);
    mkdirSync(repoRoot, { recursive: true });

    metrics._setMetricsGitHooksForTesting({
      getCurrentCommitHash: async () => "stable-head",
      getChurnByFile: async () => new Map(),
    });

    try {
      await queries.upsertRepo(conn, {
        repoId,
        rootPath: repoRoot,
        configJson: JSON.stringify({ languages: ["ts"] }),
        createdAt: "2026-04-02T00:00:00Z",
      });
      await queries.upsertFile(conn, {
        fileId,
        repoId,
        relPath: "src/fingerprint.ts",
        contentHash: "fingerprint-hash",
        language: "ts",
        byteSize: 10,
        lastIndexedAt: null,
      });
      await queries.upsertSymbol(conn, {
        symbolId,
        repoId,
        fileId,
        kind: "function",
        name: "fingerprintExport",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 10,
        astFingerprint: "fingerprint-export",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-04-02T00:00:00Z",
      });

      const first = await metrics.updateMetricsForRepo(repoId, undefined, {
        includeTimings: true,
      });
      assert.equal(typeof first.timings?.writeRows, "number");
      const firstMetric = await queries.getMetrics(conn, symbolId);
      assert.ok(firstMetric);
      const fingerprint = await queries.getMetricsFingerprint(conn, repoId);
      assert.ok(fingerprint);
      assert.equal(fingerprint.rowCount, 1);

      const second = await metrics.updateMetricsForRepo(repoId, undefined, {
        includeTimings: true,
      });
      assert.equal(second.timings?.writeMetrics, 0);
      assert.equal(second.timings?.writeRows, 0);
      assert.equal(second.timings?.writeWait, 0);
      assert.equal(typeof second.timings?.metricsFingerprint, "number");

      const secondMetric = await queries.getMetrics(conn, symbolId);
      assert.equal(secondMetric?.updatedAt, firstMetric.updatedAt);
    } finally {
      metrics._setMetricsGitHooksForTesting(null);
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("updates changed existing file summaries without relationship probes", async () => {
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const queries = await import("../../dist/db/ladybug-queries.js");
    const { materializeFileSummaries } = await import(
      "../../dist/indexer/metrics-updater.js"
    );

    await resetTestDb();
    const conn = await getLadybugConn();
    const repoId = "metrics-summary-existing";
    const fileId = "file-existing-summary";

    await queries.upsertRepo(conn, {
      repoId,
      rootPath: "C:/tmp/metrics-summary-existing",
      configJson: "{}",
      createdAt: "2026-04-02T00:00:00Z",
    });
    await queries.upsertFile(conn, {
      fileId,
      repoId,
      relPath: "src/existing.ts",
      contentHash: "existing-hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: null,
    });
    await queries.upsertSymbol(conn, {
      symbolId: "symbol-existing",
      repoId,
      fileId,
      kind: "function",
      name: "existingExport",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 10,
      astFingerprint: "existing-export",
      signatureJson: null,
      summary: "fresh summary",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: "2026-04-02T00:00:00Z",
    });
    await queries.upsertFileSummaryBatch(conn, [
      {
        fileId,
        repoId,
        summary: "stale summary",
        searchText: "file: src/existing.ts exports: stale summary: stale",
        updatedAt: "2026-04-02T00:00:00Z",
      },
    ]);

    const materialize = materializeFileSummaries as unknown as (
      conn: import("kuzu").Connection,
      repoId: string,
      options?: { includeTimings?: boolean },
    ) => Promise<{
      total: number;
      updated: number;
      timings?: Record<string, number>;
    }>;

    const result = await materialize(conn, repoId, { includeTimings: true });

    assert.equal(result.total, 1);
    assert.equal(result.updated, 1);
    assert.equal(typeof result.timings?.writeWait, "number");
    assert.equal(typeof result.timings?.writeExistingSummaries, "number");
    assert.equal(result.timings?.writeNewSummaries, 0);

    const summary = await queries.getFileSummary(conn, fileId);
    assert.ok(summary);
    assert.match(summary.summary ?? "", /existingExport/);
    assert.match(summary.searchText ?? "", /fresh summary/);

    const repoRelRow = await queries.querySingle<{ count: unknown }>(
      conn,
      `MATCH (fs:FileSummary {fileId: $fileId})-[rel:FILE_SUMMARY_IN_REPO]->(:Repo {repoId: $repoId})
       RETURN count(rel) AS count`,
      { fileId, repoId },
    );
    const fileRelRow = await queries.querySingle<{ count: unknown }>(
      conn,
      `MATCH (fs:FileSummary {fileId: $fileId})-[rel:SUMMARY_OF_FILE]->(:File {fileId: $fileId})
       RETURN count(rel) AS count`,
      { fileId },
    );
    assert.equal(queries.toNumber(repoRelRow?.count ?? 0), 1);
    assert.equal(queries.toNumber(fileRelRow?.count ?? 0), 1);
  });

  it("scopes full-refresh file summaries by Symbol.repoId", async () => {
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const queries = await import("../../dist/db/ladybug-queries.js");
    const { materializeFileSummaries } = await import(
      "../../dist/indexer/metrics-updater.js"
    );

    await resetTestDb();
    const conn = await getLadybugConn();
    const repoId = "metrics-summary-scope";
    const otherRepoId = "metrics-summary-other";
    const fileId = "file-summary-scope";
    const now = "2026-04-02T00:00:00Z";

    await queries.upsertRepo(conn, {
      repoId,
      rootPath: "C:/tmp/metrics-summary-scope",
      configJson: "{}",
      createdAt: now,
    });
    await queries.upsertRepo(conn, {
      repoId: otherRepoId,
      rootPath: "C:/tmp/metrics-summary-other",
      configJson: "{}",
      createdAt: now,
    });
    await queries.upsertFile(conn, {
      fileId,
      repoId,
      relPath: "src/scope.ts",
      contentHash: "scope-hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: null,
    });
    await queries.upsertSymbol(conn, {
      symbolId: "symbol-scope-local",
      repoId,
      fileId,
      kind: "function",
      name: "localExport",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 10,
      astFingerprint: "scope-local",
      signatureJson: null,
      summary: "local summary",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
    await queries.upsertSymbol(conn, {
      symbolId: "symbol-scope-foreign",
      repoId: otherRepoId,
      fileId,
      kind: "function",
      name: "foreignExport",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 2,
      rangeStartCol: 0,
      rangeEndLine: 2,
      rangeEndCol: 10,
      astFingerprint: "scope-foreign",
      signatureJson: null,
      summary: "foreign summary",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
    await queries.exec(
      conn,
      `MATCH (s:Symbol {symbolId: 'symbol-scope-foreign'})
       MATCH (r:Repo {repoId: $repoId})
       MERGE (s)-[:SYMBOL_IN_REPO]->(r)`,
      { repoId },
    );

    const materialize = materializeFileSummaries as unknown as (
      conn: import("kuzu").Connection,
      repoId: string,
    ) => Promise<{ total: number; updated: number }>;

    const result = await materialize(conn, repoId);

    assert.deepStrictEqual(result, { total: 1, updated: 1 });
    const summary = await queries.getFileSummary(conn, fileId);
    assert.ok(summary);
    assert.match(summary.searchText ?? "", /localExport/);
    assert.doesNotMatch(summary.searchText ?? "", /foreignExport/);
    assert.doesNotMatch(summary.searchText ?? "", /foreign summary/);
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

  it("uses preloaded provider symbol facts for full-repo file summaries", async () => {
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const queries = await import("../../dist/db/ladybug-queries.js");
    const { materializeFileSummaries } = await import(
      "../../dist/indexer/metrics-updater.js"
    );

    await resetTestDb();
    const conn = await getLadybugConn();
    const repoId = "metrics-preloaded-symbols";
    const fileId = "file-preloaded-symbols";

    await queries.upsertRepo(conn, {
      repoId,
      rootPath: "C:/tmp/metrics-preloaded-symbols",
      configJson: "{}",
      createdAt: "2026-04-02T00:00:00Z",
    });
    await queries.upsertFile(conn, {
      fileId,
      repoId,
      relPath: "src/preloaded.ts",
      contentHash: "preloaded-hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: null,
    });

    const materialize = materializeFileSummaries as unknown as (
      conn: import("kuzu").Connection,
      repoId: string,
      options?: {
        preloadedSymbolFactsByFile?: Map<
          string,
          Array<{
            fileId: string;
            name: string;
            kind: string;
            exported: boolean;
            signatureJson: string | null;
            summary: string | null;
            rangeStartLine: number;
          }>
        >;
      },
    ) => Promise<{ total: number; updated: number }>;

    const result = await materialize(conn, repoId, {
      preloadedSymbolFactsByFile: new Map([
        [
          fileId,
          [
            {
              fileId,
              name: "providerLoaded",
              kind: "function",
              exported: true,
              signatureJson: JSON.stringify({
                text: "function providerLoaded(): void",
              }),
              summary: "loaded from provider rows",
              rangeStartLine: 1,
            },
          ],
        ],
      ]),
    });

    assert.deepStrictEqual(result, { total: 1, updated: 1 });
    const summary = await queries.getFileSummary(conn, fileId);
    assert.ok(summary);
    assert.match(summary.summary ?? "", /providerLoaded/);
    assert.match(summary.summary ?? "", /loaded from provider rows/);
    assert.match(summary.searchText ?? "", /providerLoaded/);
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

describe("finalizeIndexing embedding model plan", () => {
  after(async () => {
    const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
    await closeLadybugDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  async function seedRepo(repoId: string): Promise<void> {
    await resetTestDb();
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const queries = await import("../../dist/db/ladybug-queries.js");
    const conn = await getLadybugConn();
    const now = "2026-05-21T00:00:00Z";

    await queries.upsertRepo(conn, {
      repoId,
      rootPath: `C:/tmp/${repoId}`,
      configJson: JSON.stringify({ languages: ["ts"] }),
      createdAt: now,
    });
    await queries.upsertFile(conn, {
      fileId: `${repoId}-file`,
      repoId,
      relPath: "src/entry.ts",
      contentHash: `${repoId}-hash`,
      language: "ts",
      byteSize: 128,
      lastIndexedAt: now,
    });
    await queries.upsertSymbol(conn, {
      symbolId: `${repoId}-symbol`,
      repoId,
      fileId: `${repoId}-file`,
      kind: "function",
      name: "entryPoint",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 5,
      rangeEndCol: 1,
      astFingerprint: `${repoId}-fingerprint`,
      signatureJson: JSON.stringify("() => void"),
      summary: "Entry point for semantic embedding model plan tests",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
  }

  function baseTelemetry(): FinalizeIndexingParams["callResolutionTelemetry"] {
    return {
      pass2EligibleFileCount: 0,
      pass2ProcessedFileCount: 0,
      pass2EdgesCreated: 0,
      pass2EdgesFailed: 0,
      pass2Duration: 0,
    };
  }

  it("uses specialized defaults for Symbol and FileSummary embedding lanes", async () => {
    const { finalizeIndexing } = await import(
      "../../dist/indexer/metrics-updater.js"
    );
    const repoId = "metrics-specialized-lanes";
    await seedRepo(repoId);

    const result = await finalizeIndexing({
      repoId,
      versionId: "v-specialized",
      appConfig: {
        repos: [],
        semantic: {
          enabled: true,
          provider: "mock",
          generateSummaries: false,
        },
      } as any,
      hasIndexMutations: true,
      includeTimings: true,
      callResolutionTelemetry: baseTelemetry(),
    });

    assert.ok(
      result.timings?.["semanticEmbeddings:jina-embeddings-v2-base-code"] !==
        undefined,
    );
    assert.equal(
      result.timings?.["semanticEmbeddings:nomic-embed-text-v1.5"],
      undefined,
    );
    assert.deepEqual(Object.keys(result.fileSummaryEmbeddingStats ?? {}), [
      "nomic-embed-text-v1.5",
    ]);
  });

  it("uses both models on both embedding lanes for max-recall", async () => {
    const { finalizeIndexing } = await import(
      "../../dist/indexer/metrics-updater.js"
    );
    const repoId = "metrics-max-recall-lanes";
    await seedRepo(repoId);

    const result = await finalizeIndexing({
      repoId,
      versionId: "v-max-recall",
      appConfig: {
        repos: [],
        semantic: {
          enabled: true,
          provider: "mock",
          embeddingProfile: "max-recall",
          generateSummaries: false,
        },
      } as any,
      hasIndexMutations: true,
      includeTimings: true,
      callResolutionTelemetry: baseTelemetry(),
    });

    assert.ok(
      result.timings?.["semanticEmbeddings:jina-embeddings-v2-base-code"] !==
        undefined,
    );
    assert.ok(
      result.timings?.["semanticEmbeddings:nomic-embed-text-v1.5"] !==
        undefined,
    );
    assert.deepEqual(
      Object.keys(result.fileSummaryEmbeddingStats ?? {}).sort(),
      ["jina-embeddings-v2-base-code", "nomic-embed-text-v1.5"],
    );
  });
});
