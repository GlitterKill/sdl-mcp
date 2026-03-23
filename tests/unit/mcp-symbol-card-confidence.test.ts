import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { clearAllCaches } from "../../dist/graph/cache.js";
import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { SymbolGetCardRequestSchema } from "../../dist/mcp/tools.js";
import { handleSymbolGetCard } from "../../dist/mcp/tools/symbol.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-mcp-symbol-card-confidence-test-db.lbug");

describe("symbol card confidence-aware filtering", () => {
  beforeEach(async () => {
    clearAllCaches();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
    mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(TEST_DB_PATH);
    const conn = await getLadybugConn();
    const now = "2026-03-05T13:00:00.000Z";

    await ladybugDb.upsertRepo(conn, {
      repoId: "repo",
      rootPath: "C:/repo",
      configJson: JSON.stringify({ policy: {} }),
      createdAt: now,
    });

    await ladybugDb.createVersion(conn, {
      versionId: "v1",
      repoId: "repo",
      createdAt: now,
      reason: "test",
      prevVersionHash: null,
      versionHash: "hash-v1",
    });

    await ladybugDb.upsertFile(conn, {
      fileId: "file-1",
      repoId: "repo",
      relPath: "src/service.ts",
      contentHash: "hash-file",
      language: "ts",
      byteSize: 120,
      lastIndexedAt: now,
    });

    const symbols = [
      { symbolId: "sym-entry", name: "entry" },
      { symbolId: "sym-high", name: "stableCall" },
      { symbolId: "sym-low", name: "guessCall" },
    ];

    for (const symbol of symbols) {
      await ladybugDb.upsertSymbol(conn, {
        symbolId: symbol.symbolId,
        repoId: "repo",
        fileId: "file-1",
        kind: "function",
        name: symbol.name,
        exported: false,
        visibility: null,
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 4,
        rangeEndCol: 0,
        astFingerprint: `${symbol.symbolId}-fp`,
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }

    await ladybugDb.insertEdges(conn, [
      {
        repoId: "repo",
        fromSymbolId: "sym-entry",
        toSymbolId: "sym-high",
        edgeType: "call",
        weight: 1,
        confidence: 0.97,
        resolution: "exact",
        resolverId: "pass2-ts",
        resolutionPhase: "pass2",
        provenance: "ts-compiler",
        createdAt: now,
      },
      {
        repoId: "repo",
        fromSymbolId: "sym-entry",
        toSymbolId: "sym-low",
        edgeType: "call",
        weight: 1,
        confidence: 0.41,
        resolution: "global-fallback",
        resolverId: "pass1-generic",
        resolutionPhase: "pass1",
        provenance: "heuristic",
        createdAt: now,
      },
    ]);
  });

  afterEach(async () => {
    clearAllCaches();
    await closeLadybugDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  it("accepts symbol.getCard confidence controls", () => {
    const parsed = SymbolGetCardRequestSchema.safeParse({
      repoId: "repo",
      symbolId: "sym-entry",
      minCallConfidence: 0.9,
      includeResolutionMetadata: true,
    });

    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.minCallConfidence, 0.9);
      assert.equal(parsed.data.includeResolutionMetadata, true);
    }
  });

  it("keeps default symbol card behavior unchanged", async () => {
    const response = await handleSymbolGetCard({
      repoId: "repo",
      symbolId: "sym-entry",
    });

    assert.ok(!("notModified" in response));
    assert.deepStrictEqual(response.card.deps.calls.sort(), [
      "guessCall",
      "stableCall",
    ]);
    assert.equal(response.card.callResolution, undefined);
  });

  it("filters low-confidence calls and includes resolution metadata when requested", async () => {
    const response = await handleSymbolGetCard({
      repoId: "repo",
      symbolId: "sym-entry",
      minCallConfidence: 0.9,
      includeResolutionMetadata: true,
    });

    assert.ok(!("notModified" in response));
    assert.deepStrictEqual(response.card.deps.calls, ["stableCall"]);
    assert.deepStrictEqual(response.card.callResolution, {
      minCallConfidence: 0.9,
      calls: [
        {
          symbolId: "sym-high",
          label: "stableCall",
          confidence: 0.97,
          resolutionReason: "exact",
          resolverId: "pass2-ts",
          resolutionPhase: "pass2",
        },
      ],
    });
  });
});
