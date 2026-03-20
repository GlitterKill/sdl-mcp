import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { clearAllCaches } from "../../src/graph/cache.js";
import { clearSnapshotCache } from "../../src/live-index/overlay-reader.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../src/db/ladybug.js";
import * as ladybugDb from "../../src/db/ladybug-queries.js";
import { buildCardForSymbol } from "../../src/services/card-builder.js";
import { DatabaseError } from "../../src/domain/errors.js";
import { PolicyEngine } from "../../src/policy/engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-card-builder-unit-test-db.lbug");

async function resetDb(): Promise<void> {
  clearAllCaches();
  clearSnapshotCache();
  await closeLadybugDb();
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
  await initLadybugDb(TEST_DB_PATH);
}

async function seedRepoAndFile(repoId: string, fileId: string): Promise<void> {
  const conn = await getLadybugConn();
  const now = "2026-03-19T08:00:00.000Z";
  await ladybugDb.upsertRepo(conn, {
    repoId,
    rootPath: "C:/card-builder-test",
    configJson: JSON.stringify({ policy: {} }),
    createdAt: now,
  });
  await ladybugDb.upsertFile(conn, {
    fileId,
    repoId,
    relPath: "src/service.ts",
    contentHash: `${fileId}-hash`,
    language: "ts",
    byteSize: 200,
    lastIndexedAt: now,
  });
}

async function seedSymbol(params: {
  repoId: string;
  fileId: string;
  symbolId: string;
  name: string;
}): Promise<void> {
  const conn = await getLadybugConn();
  await ladybugDb.upsertSymbol(conn, {
    symbolId: params.symbolId,
    repoId: params.repoId,
    fileId: params.fileId,
    kind: "function",
    name: params.name,
    exported: true,
    visibility: "public",
    language: "ts",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 5,
    rangeEndCol: 0,
    astFingerprint: `${params.symbolId}-fp`,
    signatureJson: JSON.stringify({
      name: params.name,
      params: [],
      returns: "void",
    }),
    summary: `${params.name} summary`,
    invariantsJson: null,
    sideEffectsJson: null,
    updatedAt: "2026-03-19T08:00:00.000Z",
  });
}

describe("card-builder", () => {
  before(async () => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
  });

  after(async () => {
    clearAllCaches();
    clearSnapshotCache();
    await closeLadybugDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  it("exports buildCardForSymbol and returns a full card", async () => {
    await resetDb();
    await seedRepoAndFile("repo-a", "file-a");
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-a",
      name: "buildThing",
    });

    const card = await buildCardForSymbol("repo-a", "sym-a", undefined);

    assert.equal(typeof buildCardForSymbol, "function");
    assert.ok(!("notModified" in card));
    assert.equal(card.symbolId, "sym-a");
    assert.equal(card.repoId, "repo-a");
    assert.equal(card.name, "buildThing");
    assert.equal(card.detailLevel, "full");
    assert.equal(typeof card.etag, "string");
  });

  it("throws DatabaseError when symbol does not exist", async () => {
    await resetDb();
    await seedRepoAndFile("repo-a", "file-a");

    await assert.rejects(
      () => buildCardForSymbol("repo-a", "missing-symbol", undefined),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseError);
        assert.match(
          (error as Error).message,
          /Symbol not found: missing-symbol/,
        );
        return true;
      },
    );
  });

  it("returns notModified when ifNoneMatch matches computed etag", async () => {
    await resetDb();
    await seedRepoAndFile("repo-a", "file-a");
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-a",
      name: "buildThing",
    });

    const conn = await getLadybugConn();
    await ladybugDb.createVersion(conn, {
      versionId: "v-test-1",
      repoId: "repo-a",
      createdAt: "2026-03-19T08:00:00.000Z",
      reason: "unit-test",
      prevVersionHash: null,
      versionHash: "hash-v-test-1",
    });

    const first = await buildCardForSymbol("repo-a", "sym-a", undefined);
    assert.ok(!("notModified" in first));

    const second = await buildCardForSymbol("repo-a", "sym-a", first.etag);
    assert.ok("notModified" in second);
    assert.equal(second.notModified, true);
    assert.equal(second.etag, first.etag);
    assert.equal(second.ledgerVersion, "v-test-1");
  });

  it("filters call deps by minCallConfidence and includes resolution metadata", async () => {
    await resetDb();
    await seedRepoAndFile("repo-a", "file-a");
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-entry",
      name: "entry",
    });
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-stable",
      name: "stableCall",
    });
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-guess",
      name: "guessCall",
    });

    const conn = await getLadybugConn();
    await ladybugDb.insertEdges(conn, [
      {
        repoId: "repo-a",
        fromSymbolId: "sym-entry",
        toSymbolId: "sym-stable",
        edgeType: "call",
        weight: 1,
        confidence: 0.95,
        resolution: "exact",
        resolverId: "pass2-ts",
        resolutionPhase: "pass2",
        provenance: "ts-compiler",
        createdAt: "2026-03-19T08:00:00.000Z",
      },
      {
        repoId: "repo-a",
        fromSymbolId: "sym-entry",
        toSymbolId: "sym-guess",
        edgeType: "call",
        weight: 1,
        confidence: 0.33,
        resolution: "global-fallback",
        resolverId: "pass1",
        resolutionPhase: "pass1",
        provenance: "heuristic",
        createdAt: "2026-03-19T08:00:00.000Z",
      },
    ]);

    const card = await buildCardForSymbol("repo-a", "sym-entry", undefined, {
      minCallConfidence: 0.8,
      includeResolutionMetadata: true,
    });

    assert.ok(!("notModified" in card));
    assert.deepStrictEqual(card.deps.calls, ["stableCall"]);
    assert.deepStrictEqual(card.callResolution, {
      minCallConfidence: 0.8,
      calls: [
        {
          symbolId: "sym-stable",
          label: "stableCall",
          confidence: 0.95,
          resolutionReason: "exact",
          resolverId: "pass2-ts",
          resolutionPhase: "pass2",
        },
      ],
    });
  });

  it("throws policy denial when policy engine denies card request", async () => {
    await resetDb();
    await seedRepoAndFile("repo-a", "file-a");
    await seedSymbol({
      repoId: "repo-a",
      fileId: "file-a",
      symbolId: "sym-a",
      name: "blockedFn",
    });

    const originalEvaluate = PolicyEngine.prototype.evaluate;
    const originalNextBest = PolicyEngine.prototype.generateNextBestAction;

    PolicyEngine.prototype.evaluate = function evaluateDeny() {
      return {
        decision: "deny",
        evidenceUsed: [],
        auditHash: "forced-deny",
        deniedReasons: ["forced deny for test"],
      };
    };
    PolicyEngine.prototype.generateNextBestAction =
      function generateNextBest() {
        return {
          nextBestAction: "requestSkeleton",
          requiredFieldsForNext: {
            requestSkeleton: {
              repoId: "repo-a",
              symbolId: "sym-a",
            },
          },
        };
      };

    try {
      await assert.rejects(
        () => buildCardForSymbol("repo-a", "sym-a", undefined),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, "PolicyDenialError");
          assert.match(error.message, /Policy denied symbol card request/);
          return true;
        },
      );
    } finally {
      PolicyEngine.prototype.evaluate = originalEvaluate;
      PolicyEngine.prototype.generateNextBestAction = originalNextBest;
    }
  });
});
