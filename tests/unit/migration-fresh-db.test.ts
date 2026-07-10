import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Migration {
  version: number;
  description: string;
  up(conn: import("kuzu").Connection): Promise<void>;
}

let initLadybugDb: (dbPath: string) => Promise<void>;
let closeLadybugDb: () => Promise<void>;
let getLadybugConn: () => Promise<import("kuzu").Connection>;
let getSchemaVersion: (
  conn: import("kuzu").Connection,
) => Promise<number | null>;
let exec: typeof import("../../dist/db/ladybug-core.js").exec;
let queryAll: typeof import("../../dist/db/ladybug-core.js").queryAll;
let migrations: Migration[];
let LADYBUG_SCHEMA_VERSION: number;
let ladybugAvailable = false;

try {
  const ladybugMod = await import("../../dist/db/ladybug.js");
  const coreMod = await import("../../dist/db/ladybug-core.js");
  const schemaMod = await import("../../dist/db/ladybug-schema.js");
  const migrationMod = await import("../../dist/db/migrations/index.js");
  initLadybugDb = ladybugMod.initLadybugDb;
  closeLadybugDb = ladybugMod.closeLadybugDb;
  getLadybugConn = ladybugMod.getLadybugConn;
  getSchemaVersion = schemaMod.getSchemaVersion;
  exec = coreMod.exec;
  queryAll = coreMod.queryAll;
  migrations = migrationMod.migrations;
  LADYBUG_SCHEMA_VERSION = migrationMod.LADYBUG_SCHEMA_VERSION;
  ladybugAvailable = true;
} catch {
  // Module not built or LadybugDB unavailable.
}

describe("migration: fresh database", { skip: !ladybugAvailable }, () => {
  const testRoot = join(
    tmpdir(),
    `sdl-mcp-mig-fresh-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("creates schema version 21 directly without numbered migrations", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "fresh.lbug");
    const original = migrations[0];
    migrations[0] = {
      ...original,
      async up() {
        throw new Error("numbered migration must not run for a fresh database");
      },
    };

    try {
      await initLadybugDb(dbPath);
      const conn = await getLadybugConn();

      assert.equal(LADYBUG_SCHEMA_VERSION, 21);
      assert.equal(await getSchemaVersion(conn), 21);

      await exec(
        conn,
        `CREATE (s:Symbol {
          symbolId: $symbolId,
          embeddingMiniLM: $embeddingMiniLM,
          embeddingMiniLMCardHash: $embeddingMiniLMCardHash,
          embeddingMiniLMUpdatedAt: $embeddingMiniLMUpdatedAt,
          embeddingNomic: $embeddingNomic,
          embeddingNomicCardHash: $embeddingNomicCardHash,
          embeddingNomicUpdatedAt: $embeddingNomicUpdatedAt
        })`,
        {
          symbolId: "fresh-symbol",
          embeddingMiniLM: "[0]",
          embeddingMiniLMCardHash: "mini-hash",
          embeddingMiniLMUpdatedAt: "mini-updated",
          embeddingNomic: "[1]",
          embeddingNomicCardHash: "nomic-hash",
          embeddingNomicUpdatedAt: "nomic-updated",
        },
      );

      const symbols = await queryAll<{
        symbolId: string;
        embeddingMiniLM: string;
        embeddingMiniLMCardHash: string;
        embeddingMiniLMUpdatedAt: string;
        embeddingNomic: string;
        embeddingNomicCardHash: string;
        embeddingNomicUpdatedAt: string;
      }>(
        conn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         RETURN s.symbolId AS symbolId,
                s.embeddingMiniLM AS embeddingMiniLM,
                s.embeddingMiniLMCardHash AS embeddingMiniLMCardHash,
                s.embeddingMiniLMUpdatedAt AS embeddingMiniLMUpdatedAt,
                s.embeddingNomic AS embeddingNomic,
                s.embeddingNomicCardHash AS embeddingNomicCardHash,
                s.embeddingNomicUpdatedAt AS embeddingNomicUpdatedAt`,
        { symbolId: "fresh-symbol" },
      );
      assert.deepEqual(symbols, [
        {
          symbolId: "fresh-symbol",
          embeddingMiniLM: "[0]",
          embeddingMiniLMCardHash: "mini-hash",
          embeddingMiniLMUpdatedAt: "mini-updated",
          embeddingNomic: "[1]",
          embeddingNomicCardHash: "nomic-hash",
          embeddingNomicUpdatedAt: "nomic-updated",
        },
      ]);

      assert.deepEqual(
        await queryAll(
          conn,
          "MATCH (se:SymbolEmbedding) RETURN se.symbolId AS symbolId",
        ),
        [],
      );
    } finally {
      migrations[0] = original;
    }
  });
});
