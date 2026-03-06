import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeKuzuDb,
  getKuzuConn,
  initKuzuDb,
} from "../../dist/db/kuzu.js";
import * as kuzuDb from "../../dist/db/kuzu-queries.js";
import { handleSymbolGetCard } from "../../dist/mcp/tools/symbol.js";
import { handleSliceBuild } from "../../dist/mcp/tools/slice.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(
  __dirname,
  "..",
  "..",
  ".kuzu-mcp-confidence-filtering-test-db.kuzu",
);

describe("MCP confidence-aware filtering", () => {
  const repoId = "mcp-confidence-repo";

  before(async () => {
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
    mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

    await closeKuzuDb();
    await initKuzuDb(TEST_DB_PATH);
    const conn = await getKuzuConn();
    const now = "2026-03-05T14:00:00.000Z";

    await kuzuDb.upsertRepo(conn, {
      repoId,
      rootPath: "C:/repo",
      configJson: JSON.stringify({ policy: {} }),
      createdAt: now,
    });

    await kuzuDb.createVersion(conn, {
      versionId: "v1",
      repoId,
      createdAt: now,
      reason: "integration",
      prevVersionHash: null,
      versionHash: "v1-hash",
    });

    await kuzuDb.upsertFile(conn, {
      fileId: "file-1",
      repoId,
      relPath: "src/app.ts",
      contentHash: "hash-1",
      language: "ts",
      byteSize: 150,
      lastIndexedAt: now,
    });

    const symbols = [
      { symbolId: "sym-entry", name: "entry" },
      { symbolId: "sym-high", name: "highConfidence" },
      { symbolId: "sym-low", name: "lowConfidence" },
    ];

    for (const symbol of symbols) {
      await kuzuDb.upsertSymbol(conn, {
        symbolId: symbol.symbolId,
        repoId,
        fileId: "file-1",
        kind: "function",
        name: symbol.name,
        exported: true,
        visibility: "public",
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

    await kuzuDb.insertEdges(conn, [
      {
        repoId,
        fromSymbolId: "sym-entry",
        toSymbolId: "sym-high",
        edgeType: "call",
        weight: 1,
        confidence: 0.94,
        resolution: "exact",
        resolverId: "pass2-ts",
        resolutionPhase: "pass2",
        provenance: "ts-compiler",
        createdAt: now,
      },
      {
        repoId,
        fromSymbolId: "sym-entry",
        toSymbolId: "sym-low",
        edgeType: "call",
        weight: 1,
        confidence: 0.33,
        resolution: "global-fallback",
        resolverId: "pass1-generic",
        resolutionPhase: "pass1",
        provenance: "heuristic",
        createdAt: now,
      },
    ]);
  });

  after(async () => {
    await closeKuzuDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  it("threads minCallConfidence through symbol and slice MCP handlers", async () => {
    const cardResponse = await handleSymbolGetCard({
      repoId,
      symbolId: "sym-entry",
      minCallConfidence: 0.9,
      includeResolutionMetadata: true,
    });

    assert.ok(!("notModified" in cardResponse));
    assert.deepStrictEqual(cardResponse.card.deps.calls, ["highConfidence"]);
    assert.equal(cardResponse.card.callResolution?.calls.length, 1);

    const sliceResponse = await handleSliceBuild({
      repoId,
      entrySymbols: ["sym-entry"],
      wireFormat: "standard",
      budget: { maxCards: 10, maxEstimatedTokens: 10_000 },
      minConfidence: 0,
      minCallConfidence: 0.9,
      includeResolutionMetadata: true,
    });

    assert.ok("slice" in sliceResponse);
    const entryCard = sliceResponse.slice.cards.find(
      (card) => card.symbolId === "sym-entry",
    );
    assert.ok(entryCard);
    assert.deepStrictEqual(entryCard?.deps.calls, [
      { symbolId: "sym-high", confidence: 0.94 },
    ]);
    assert.deepStrictEqual(entryCard?.callResolution?.calls, [
      {
        symbolId: "sym-high",
        label: "highConfidence",
        confidence: 0.94,
        resolutionReason: "exact",
        resolverId: "pass2-ts",
        resolutionPhase: "pass2",
      },
    ]);
  });
});
