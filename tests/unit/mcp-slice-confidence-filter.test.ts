import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSlice } from "../../src/graph/slice.js";
import { createSchema } from "../../src/db/ladybug-schema.js";
import { SliceBuildRequestSchema } from "../../src/mcp/tools.js";
import * as ladybugDb from "../../src/db/ladybug-queries.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(
  __dirname,
  "..",
  "..",
  ".lbug-mcp-slice-confidence-test-db.lbug",
);

interface LadybugConnection {
  close: () => Promise<void>;
}

interface LadybugDatabase {
  close: () => Promise<void>;
}

async function createTestDb(): Promise<{
  conn: import("kuzu").Connection;
  db: LadybugDatabase;
}> {
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

  const kuzu = await import("kuzu");
  const db = new kuzu.Database(TEST_DB_PATH);
  const conn = new kuzu.Connection(db);
  await createSchema(conn);
  return { conn, db: db as unknown as LadybugDatabase };
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

describe("slice confidence-aware filtering", () => {
  let conn: import("kuzu").Connection;
  let db: LadybugDatabase;

  beforeEach(async () => {
    ({ conn, db } = await createTestDb());
  });

  afterEach(async () => {
    await cleanupTestDb(db, conn as unknown as LadybugConnection);
  });

  it("accepts minCallConfidence and includeResolutionMetadata in slice.build requests", () => {
    const parsed = SliceBuildRequestSchema.safeParse({
      repoId: "repo-1",
      entrySymbols: ["sym-entry"],
      minConfidence: 0.2,
      minCallConfidence: 0.9,
      includeResolutionMetadata: true,
    });

    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.minCallConfidence, 0.9);
      assert.equal(parsed.data.includeResolutionMetadata, true);
    }
  });

  it("filters low-confidence call edges while preserving imports and metadata", async () => {
    const now = "2026-03-05T12:00:00.000Z";

    await ladybugDb.upsertRepo(conn, {
      repoId: "repo",
      rootPath: "C:/repo",
      configJson: JSON.stringify({ policy: {} }),
      createdAt: now,
    });

    await ladybugDb.upsertFile(conn, {
      fileId: "file-1",
      repoId: "repo",
      relPath: "src/app.ts",
      contentHash: "hash-1",
      language: "ts",
      byteSize: 100,
      lastIndexedAt: now,
    });

    const symbols = [
      { symbolId: "sym-entry", name: "entry" },
      { symbolId: "sym-high", name: "highConfidence" },
      { symbolId: "sym-low", name: "lowConfidence" },
      { symbolId: "sym-import", name: "importedHelper" },
    ];

    for (const symbol of symbols) {
      await ladybugDb.upsertSymbol(conn, {
        symbolId: symbol.symbolId,
        repoId: "repo",
        fileId: "file-1",
        kind: "function",
        name: symbol.name,
        exported: true,
        visibility: "public",
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 2,
        rangeEndCol: 1,
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
        confidence: 0.96,
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
        confidence: 0.35,
        resolution: "global-fallback",
        resolverId: "pass1-generic",
        resolutionPhase: "pass1",
        provenance: "heuristic",
        createdAt: now,
      },
      {
        repoId: "repo",
        fromSymbolId: "sym-entry",
        toSymbolId: "sym-import",
        edgeType: "import",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "pass1-generic",
        resolutionPhase: "pass1",
        provenance: "static",
        createdAt: now,
      },
    ]);

    const slice = await buildSlice({
      repoId: "repo",
      versionId: "v1",
      conn,
      entrySymbols: ["sym-entry"],
      budget: { maxCards: 10, maxEstimatedTokens: 10_000 },
      cardDetail: "deps",
      minConfidence: 0,
      minCallConfidence: 0.9,
      includeResolutionMetadata: true,
    });

    assert.deepStrictEqual(
      slice.symbolIndex.sort(),
      ["sym-entry", "sym-high", "sym-import"].sort(),
    );
    assert.ok(!slice.symbolIndex.includes("sym-low"));

    const fromIndex = slice.symbolIndex.indexOf("sym-entry");
    const highIndex = slice.symbolIndex.indexOf("sym-high");
    const importIndex = slice.symbolIndex.indexOf("sym-import");

    assert.ok(
      slice.edges.some(
        ([from, to, type]) =>
          from === fromIndex && to === highIndex && type === "call",
      ),
    );
    assert.ok(
      slice.edges.some(
        ([from, to, type]) =>
          from === fromIndex && to === importIndex && type === "import",
      ),
    );
    assert.ok(
      !slice.edges.some(([_from, _to, type]) => type === "call" && _to === -1),
    );

    const entryCard = slice.cards.find((card) => card.symbolId === "sym-entry");
    assert.ok(entryCard);
    assert.deepStrictEqual(entryCard?.deps.calls, [
      { symbolId: "sym-high", confidence: 0.96 },
    ]);
    assert.deepStrictEqual(entryCard?.deps.imports, [
      { symbolId: "sym-import", confidence: 1 },
    ]);
    assert.ok(entryCard?.callResolution);
    assert.deepStrictEqual(entryCard?.callResolution?.calls, [
      {
        symbolId: "sym-high",
        label: "highConfidence",
        confidence: 0.96,
        resolutionReason: "exact",
        resolverId: "pass2-ts",
        resolutionPhase: "pass2",
      },
    ]);
  });
});
