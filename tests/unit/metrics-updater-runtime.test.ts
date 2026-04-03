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
});
