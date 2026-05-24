import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { recoverMissingMetricsForRepo } from "../../dist/graph/metrics-recovery.js";

const REPO_ID = "metrics-recovery-unit-repo";

describe("recoverMissingMetricsForRepo", () => {
  let graphDbPath = "";

  beforeEach(async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-metrics-recovery-unit-"));
    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const now = "2024-01-01T00:00:00.000Z";
    await withWriteConn(async (wConn) => {
      await ladybugDb.upsertRepo(wConn, {
        repoId: REPO_ID,
        rootPath: graphDbPath,
        configJson: "{}",
        createdAt: now,
      });
      await ladybugDb.upsertFileBatch(wConn, [
        {
          fileId: `${REPO_ID}:src/main.ts`,
          repoId: REPO_ID,
          relPath: "src/main.ts",
          contentHash: "hash",
          language: "typescript",
          byteSize: 100,
          lastIndexedAt: now,
        },
      ]);
      await ladybugDb.upsertSymbolBatch(wConn, [
        "sym-a",
        "sym-b",
        "sym-c",
      ].map((symbolId, index) => ({
        symbolId,
        repoId: REPO_ID,
        fileId: `${REPO_ID}:src/main.ts`,
        kind: "function",
        name: symbolId,
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: index + 1,
        rangeStartCol: 0,
        rangeEndLine: index + 2,
        rangeEndCol: 0,
        astFingerprint: symbolId,
        signatureJson: "{}",
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      })));
      await ladybugDb.insertEdges(wConn, [
        {
          repoId: REPO_ID,
          fromSymbolId: "sym-a",
          toSymbolId: "sym-c",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: null,
          createdAt: now,
        },
        {
          repoId: REPO_ID,
          fromSymbolId: "sym-c",
          toSymbolId: "sym-b",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: null,
          createdAt: now,
        },
      ]);
      await ladybugDb.upsertMetricsBatch(wConn, [
        {
          symbolId: "sym-a",
          fanIn: 99,
          fanOut: 99,
          churn30d: 7,
          testRefsJson: "[\"existing\"]",
          canonicalTestJson: "{\"file\":\"existing.test.ts\"}",
          pageRank: 0.5,
          kCore: 2,
          updatedAt: now,
        },
        {
          symbolId: "sym-b",
          fanIn: 42,
          fanOut: 42,
          churn30d: 5,
          testRefsJson: "[\"existing-b\"]",
          canonicalTestJson: null,
          pageRank: 0.25,
          kCore: 1,
          updatedAt: now,
        },
      ]);
    });
  });

  afterEach(async () => {
    await closeLadybugDb();
    if (graphDbPath && existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
  });

  it("writes only missing rows and can use COPY for partial repair", async () => {
    const result = await recoverMissingMetricsForRepo(REPO_ID, {
      copyThresholdRows: 1,
      now: () => new Date("2024-01-02T00:00:00.000Z"),
    });

    assert.deepStrictEqual(result, {
      missingRows: 1,
      repairedRows: 1,
      writeMode: "copy",
    });
    const conn = await getLadybugConn();
    const existing = await ladybugDb.getMetrics(conn, "sym-a");
    assert.equal(existing?.fanIn, 99);
    assert.equal(existing?.testRefsJson, "[\"existing\"]");

    const repaired = await ladybugDb.getMetrics(conn, "sym-c");
    assert.ok(repaired);
    assert.equal(repaired.fanIn, 1);
    assert.equal(repaired.fanOut, 1);
    assert.equal(repaired.churn30d, 0);
    assert.equal(repaired.testRefsJson, "[]");
    assert.equal(repaired.canonicalTestJson, null);
    assert.equal(repaired.pageRank, 0);
    assert.equal(repaired.kCore, 0);
  });
});
