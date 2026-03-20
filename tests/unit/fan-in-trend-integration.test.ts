/**
 * Integration tests for fan-in trend computation against LadybugDB.
 *
 * Covers:
 * - getFanInAtVersion counting only snapshotted callers at a version
 * - fanInTrend growthRate and amplifier flag
 * - computeBlastRadius attaching fanInTrend only when version IDs are provided
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { FAN_IN_AMPLIFIER_THRESHOLD } from "../../dist/config/constants.js";
import { computeBlastRadius } from "../../dist/delta/blastRadius.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-fan-in-trend-test-db.lbug");

interface LadybugConnection {
  query: (q: string) => Promise<{
    hasNext: () => boolean;
    getNext: () => Promise<Record<string, unknown>>;
    close: () => void;
  }>;
  close: () => Promise<void>;
}

interface LadybugDatabase {
  close: () => Promise<void>;
}

async function createTestDb(): Promise<{
  db: LadybugDatabase;
  conn: LadybugConnection;
}> {
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

  const kuzu = await import("kuzu");
  const db = new kuzu.Database(TEST_DB_PATH);
  const conn = new kuzu.Connection(db);

  return { db, conn: conn as unknown as LadybugConnection };
}

async function cleanupTestDb(
  db: LadybugDatabase,
  conn: LadybugConnection,
): Promise<void> {
  try {
    await conn.close();
  } catch {}
  try {
    await db.close();
  } catch {}
  try {
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  } catch {}
}

async function setupSchema(conn: LadybugConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/ladybug-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

describe("Fan-in trend integration tests (LadybugDB)", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let queries: typeof import("../../dist/db/ladybug-queries.js");
  let ladybugAvailable = true;

  const repoId = "test-fan-in-trend";
  const fileId = "file-1";
  const NOW = "2026-03-04T00:00:00.000Z";

  const kConn = (): import("kuzu").Connection =>
    conn as unknown as import("kuzu").Connection;

  const upsertBaseRepo = async (): Promise<void> => {
    await queries.upsertRepo(kConn(), {
      repoId,
      rootPath: "C:/fake/repo",
      configJson: "{}",
      createdAt: NOW,
    });
    await queries.upsertFile(kConn(), {
      fileId,
      repoId,
      relPath: "src/index.ts",
      contentHash: "hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: NOW,
    });
  };

  const upsertSymbol = async (
    symbolId: string,
    name: string,
  ): Promise<void> => {
    await queries.upsertSymbol(kConn(), {
      symbolId,
      repoId,
      fileId,
      kind: "function",
      name,
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 10,
      rangeEndCol: 1,
      astFingerprint: `fp-${symbolId}`,
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: NOW,
    });
  };

  const snapshot = async (
    versionId: string,
    symbolIds: string[],
  ): Promise<void> => {
    for (const symbolId of symbolIds) {
      await queries.snapshotSymbolVersion(kConn(), {
        versionId,
        symbolId,
        astFingerprint: `fp-${symbolId}`,
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
      });
    }
  };

  const computeFanInTrendForSymbol = async (
    symbolId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<
    | {
        previous: number;
        current: number;
        growthRate: number;
        isAmplifier: boolean;
      }
    | undefined
  > => {
    const previous = await queries.getFanInAtVersion(
      kConn(),
      repoId,
      symbolId,
      fromVersionId,
    );
    const current = await queries.getFanInAtVersion(
      kConn(),
      repoId,
      symbolId,
      toVersionId,
    );
    const growthRate = (current - previous) / Math.max(previous, 1);
    if (growthRate === 0) {
      return undefined;
    }
    return {
      previous,
      current,
      growthRate,
      isAmplifier: growthRate > FAN_IN_AMPLIFIER_THRESHOLD,
    };
  };

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/ladybug-queries.js");
      await upsertBaseRepo();
    } catch {
      ladybugAvailable = false;
    }
  });

  afterEach(async () => {
    if (!ladybugAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it(
    "Test 1: symbol gains 5 new callers → amplifier detected",
    { skip: !ladybugAvailable },
    async () => {
      const fooId = "sym-foo";
      await upsertSymbol(fooId, "foo");

      await queries.upsertMetrics(kConn(), {
        symbolId: fooId,
        fanIn: 0,
        fanOut: 0,
        churn30d: 0,
        testRefsJson: "[]",
        canonicalTestJson: null,
        updatedAt: NOW,
      });

      await queries.createVersion(kConn(), {
        versionId: "v1",
        repoId,
        createdAt: NOW,
        reason: "v1",
        prevVersionHash: null,
        versionHash: null,
      });
      await snapshot("v1", [fooId]);

      const callerIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const callerId = `sym-caller-${i}`;
        callerIds.push(callerId);
        await upsertSymbol(callerId, `caller${i}`);
        await queries.insertEdge(kConn(), {
          repoId,
          fromSymbolId: callerId,
          toSymbolId: fooId,
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: NOW,
        });
      }

      await queries.createVersion(kConn(), {
        versionId: "v2",
        repoId,
        createdAt: NOW,
        reason: "v2",
        prevVersionHash: null,
        versionHash: null,
      });
      await snapshot("v2", [fooId, ...callerIds]);

      const fanInV1 = await queries.getFanInAtVersion(
        kConn(),
        repoId,
        fooId,
        "v1",
      );
      const fanInV2 = await queries.getFanInAtVersion(
        kConn(),
        repoId,
        fooId,
        "v2",
      );
      assert.equal(fanInV1, 0);
      assert.equal(fanInV2, 5);

      const fanInTrend = await computeFanInTrendForSymbol(fooId, "v1", "v2");
      assert.ok(fanInTrend);
      assert.equal(fanInTrend.previous, 0);
      assert.equal(fanInTrend.current, 5);
      assert.equal(fanInTrend.isAmplifier, true);
    },
  );

  it(
    "Test 2: 10 existing callers + 1 new caller → not an amplifier",
    { skip: !ladybugAvailable },
    async () => {
      const barId = "sym-bar";
      await upsertSymbol(barId, "bar");

      await queries.upsertMetrics(kConn(), {
        symbolId: barId,
        fanIn: 10,
        fanOut: 0,
        churn30d: 0,
        testRefsJson: "[]",
        canonicalTestJson: null,
        updatedAt: NOW,
      });

      const originalCallers: string[] = [];
      for (let i = 0; i < 10; i++) {
        const callerId = `sym-orig-${i}`;
        originalCallers.push(callerId);
        await upsertSymbol(callerId, `orig${i}`);
        await queries.insertEdge(kConn(), {
          repoId,
          fromSymbolId: callerId,
          toSymbolId: barId,
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: NOW,
        });
      }

      await queries.createVersion(kConn(), {
        versionId: "v1",
        repoId,
        createdAt: NOW,
        reason: "v1",
        prevVersionHash: null,
        versionHash: null,
      });
      await snapshot("v1", [barId, ...originalCallers]);

      const newCaller = "sym-new";
      await upsertSymbol(newCaller, "newCaller");
      await queries.insertEdge(kConn(), {
        repoId,
        fromSymbolId: newCaller,
        toSymbolId: barId,
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "static",
        createdAt: NOW,
      });

      await queries.createVersion(kConn(), {
        versionId: "v2",
        repoId,
        createdAt: NOW,
        reason: "v2",
        prevVersionHash: null,
        versionHash: null,
      });
      await snapshot("v2", [barId, ...originalCallers, newCaller]);

      const fanInTrend = await computeFanInTrendForSymbol(barId, "v1", "v2");
      assert.ok(fanInTrend);
      assert.equal(fanInTrend.previous, 10);
      assert.equal(fanInTrend.current, 11);
      assert.equal(fanInTrend.isAmplifier, false);
    },
  );

  it(
    "Test 3: computeBlastRadius attaches fanInTrend only with version IDs",
    { skip: !ladybugAvailable },
    async () => {
      const changedId = "sym-changed";
      const depId = "sym-dep";
      await upsertSymbol(changedId, "changedFn");
      await upsertSymbol(depId, "depFn");

      await queries.insertEdge(kConn(), {
        repoId,
        fromSymbolId: depId,
        toSymbolId: changedId,
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "static",
        createdAt: NOW,
      });

      const withoutVersions = await computeBlastRadius(kConn(), [changedId], {
        repoId,
        maxHops: 2,
        maxResults: 20,
      });
      assert.ok(Array.isArray(withoutVersions));
      for (const item of withoutVersions) {
        assert.equal(item.fanInTrend, undefined);
      }

      // Make depId an amplifier between v1 and v2.
      await queries.createVersion(kConn(), {
        versionId: "v1",
        repoId,
        createdAt: NOW,
        reason: "v1",
        prevVersionHash: null,
        versionHash: null,
      });
      await queries.createVersion(kConn(), {
        versionId: "v2",
        repoId,
        createdAt: NOW,
        reason: "v2",
        prevVersionHash: null,
        versionHash: null,
      });
      await snapshot("v1", [changedId, depId]);

      const depCallers: string[] = [];
      for (let i = 0; i < 5; i++) {
        const callerId = `sym-dep-caller-${i}`;
        depCallers.push(callerId);
        await upsertSymbol(callerId, `depCaller${i}`);
        await queries.insertEdge(kConn(), {
          repoId,
          fromSymbolId: callerId,
          toSymbolId: depId,
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: NOW,
        });
      }
      await snapshot("v2", [changedId, depId, ...depCallers]);

      const withVersions = await computeBlastRadius(kConn(), [changedId], {
        repoId,
        maxHops: 2,
        maxResults: 20,
        fromVersionId: "v1",
        toVersionId: "v2",
      });

      const depItem = withVersions.find((item) => item.symbolId === depId);
      assert.ok(depItem);
      assert.ok(depItem.fanInTrend);
      assert.equal(depItem.fanInTrend.isAmplifier, true);
    },
  );
});
