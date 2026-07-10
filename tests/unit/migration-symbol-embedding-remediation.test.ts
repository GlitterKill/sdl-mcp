import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exec,
  execDdl,
  queryAll,
} from "../../dist/db/ladybug-core.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import { upsertSymbolEmbedding } from "../../dist/db/ladybug-embeddings.js";
import { getSchemaVersion } from "../../dist/db/ladybug-schema.js";
import {
  LADYBUG_SCHEMA_VERSION,
  migrations,
} from "../../dist/db/migrations/index.js";
import * as m007 from "../../dist/db/migrations/m007-copy-embeddings-to-symbol.js";
import { computePendingMigrations } from "../../dist/db/migration-runner.js";

interface LegacyEmbeddingRow {
  symbolId: string;
  model: string;
  embeddingVector: string;
  version: string | null;
  cardHash: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface DestinationRow {
  symbolId: string;
  embeddingMiniLM: string | null;
  embeddingMiniLMCardHash: string | null;
  embeddingMiniLMUpdatedAt: string | null;
  embeddingNomic: string | null;
  embeddingNomicCardHash: string | null;
  embeddingNomicUpdatedAt: string | null;
}

interface RawHandle {
  db: import("kuzu").Database;
  conn: import("kuzu").Connection;
}

const testRoot = join(
  tmpdir(),
  `sdl-mcp-symbol-embedding-remediation-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`,
);
const rawHandles: RawHandle[] = [];

const vector = (dimension: number, value = 0): number[] =>
  Array.from({ length: dimension }, () => value);

const encoded = (dimension: number, value = 0): string =>
  JSON.stringify(vector(dimension, value));

const exponentEncoded = (dimension: number, value = "1e0"): string =>
  "[" + Array.from({ length: dimension }, () => value).join(", ") + "]";

const legacyRow = (
  symbolId: string,
  overrides: Partial<LegacyEmbeddingRow> = {},
): LegacyEmbeddingRow => ({
  symbolId,
  model: "all-MiniLM-L6-v2",
  embeddingVector: encoded(384),
  version: null,
  cardHash: null,
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

async function createRawDatabase(name: string): Promise<RawHandle> {
  mkdirSync(testRoot, { recursive: true });
  const kuzu = await import("kuzu");
  const db = new kuzu.Database(join(testRoot, `${name}.lbug`));
  const conn = new kuzu.Connection(db);
  const handle = { db, conn };
  rawHandles.push(handle);
  return handle;
}

async function createCompatibilityTable(
  conn: import("kuzu").Connection,
): Promise<void> {
  await execDdl(
    conn,
    `CREATE NODE TABLE SymbolEmbedding (
      symbolId STRING PRIMARY KEY,
      model STRING,
      embeddingVector STRING,
      version STRING,
      cardHash STRING,
      createdAt STRING,
      updatedAt STRING
    )`,
  );
}

async function seedLegacyEmbedding(
  conn: import("kuzu").Connection,
  row: LegacyEmbeddingRow,
): Promise<void> {
  await exec(
    conn,
    `CREATE (se:SymbolEmbedding {
      symbolId: $symbolId,
      model: $model,
      embeddingVector: $embeddingVector,
      version: $version,
      cardHash: $cardHash,
      createdAt: $createdAt,
      updatedAt: $updatedAt
    })`,
    row,
  );
}

async function readSourceIds(
  conn: import("kuzu").Connection,
): Promise<string[]> {
  const rows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (se:SymbolEmbedding)
     RETURN se.symbolId AS symbolId
     ORDER BY symbolId`,
  );
  return rows.map(({ symbolId }) => symbolId);
}

async function readDestinationRows(
  conn: import("kuzu").Connection,
): Promise<DestinationRow[]> {
  return queryAll<DestinationRow>(
    conn,
    `MATCH (s:Symbol)
     RETURN s.symbolId AS symbolId,
            s.embeddingMiniLM AS embeddingMiniLM,
            s.embeddingMiniLMCardHash AS embeddingMiniLMCardHash,
            s.embeddingMiniLMUpdatedAt AS embeddingMiniLMUpdatedAt,
            s.embeddingNomic AS embeddingNomic,
            s.embeddingNomicCardHash AS embeddingNomicCardHash,
            s.embeddingNomicUpdatedAt AS embeddingNomicUpdatedAt
     ORDER BY symbolId`,
  );
}

async function setSchemaVersion(
  conn: import("kuzu").Connection,
  version: number,
): Promise<void> {
  await exec(
    conn,
    `MATCH (sv:SchemaVersion {id: 'current'})
     SET sv.schemaVersion = $version, sv.updatedAt = $updatedAt`,
    { version, updatedAt: "2026-07-10T00:00:00.000Z" },
  );
}

async function seedLatestResidual(
  conn: import("kuzu").Connection,
  symbolId: string,
): Promise<void> {
  await exec(
    conn,
    `CREATE (s:Symbol {
      symbolId: $symbolId,
      embeddingMiniLM: null,
      embeddingMiniLMCardHash: null,
      embeddingMiniLMUpdatedAt: null,
      embeddingNomic: null,
      embeddingNomicCardHash: null,
      embeddingNomicUpdatedAt: null
    })`,
    { symbolId },
  );
  await seedLegacyEmbedding(conn, legacyRow(symbolId));
}

afterEach(async () => {
  await closeLadybugDb();
  for (const { conn, db } of rawHandles.splice(0).reverse()) {
    await conn.close();
    await db.close();
  }
  if (existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("SymbolEmbedding compatibility identity", () => {
  it("keeps one physical row per symbol across model updates", async () => {
    const { conn } = await createRawDatabase("identity");
    await createCompatibilityTable(conn);

    await upsertSymbolEmbedding(conn, {
      symbolId: "symbol-1",
      model: "all-MiniLM-L6-v2",
      embeddingVector: encoded(384),
      version: "v1",
      cardHash: "mini-hash",
      createdAt: "created",
      updatedAt: "updated-1",
    });
    await upsertSymbolEmbedding(conn, {
      symbolId: "symbol-1",
      model: "nomic-embed-text-v1.5",
      embeddingVector: encoded(768),
      version: "v2",
      cardHash: "nomic-hash",
      createdAt: "created",
      updatedAt: "updated-2",
    });

    const rows = await queryAll<{ symbolId: string; model: string }>(
      conn,
      `MATCH (se:SymbolEmbedding)
       RETURN se.symbolId AS symbolId, se.model AS model`,
    );
    assert.deepEqual(rows, [
      { symbolId: "symbol-1", model: "nomic-embed-text-v1.5" },
    ]);

    await assert.rejects(
      exec(
        conn,
        `CREATE (se:SymbolEmbedding {
          symbolId: $symbolId,
          model: $model,
          embeddingVector: $embeddingVector
        })`,
        {
          symbolId: "symbol-1",
          model: "all-MiniLM-L6-v2",
          embeddingVector: encoded(384),
        },
      ),
      /primary key|constraint|duplicate/i,
    );
  });
});

describe("m007 safe SymbolEmbedding remediation", () => {
  it("copies only verified rows, retains unsafe rows, and reruns idempotently", async () => {
    const { conn } = await createRawDatabase("m007-partial");
    await execDdl(
      conn,
      `CREATE NODE TABLE Symbol (
        symbolId STRING PRIMARY KEY,
        embeddingMiniLM STRING,
        embeddingMiniLMCardHash STRING,
        embeddingMiniLMUpdatedAt STRING
      )`,
    );
    await createCompatibilityTable(conn);

    const symbolIds = [
      "conflict",
      "current",
      "malformed",
      "mini-copy",
      "mock",
      "nomic-copy",
      "unknown",
    ];
    for (const symbolId of symbolIds) {
      await exec(
        conn,
        `CREATE (s:Symbol {
          symbolId: $symbolId,
          embeddingMiniLM: $vector,
          embeddingMiniLMCardHash: null,
          embeddingMiniLMUpdatedAt: null
        })`,
        {
          symbolId,
          vector:
            symbolId === "current"
              ? exponentEncoded(384)
              : symbolId === "conflict"
                ? encoded(384, 2)
                : null,
        },
      );
    }

    const rows = [
      legacyRow("mini-copy"),
      legacyRow("nomic-copy", {
        model: "nomic-embed-text-v1.5",
        embeddingVector: encoded(768),
      }),
      legacyRow("current", { embeddingVector: encoded(384, 1) }),
      legacyRow("conflict"),
      legacyRow("orphan"),
      legacyRow("malformed", { embeddingVector: "not-json" }),
      legacyRow("mock", { model: "mock-fallback" }),
      legacyRow("unknown", { model: "future-model" }),
    ];
    for (const row of rows) {
      await seedLegacyEmbedding(conn, row);
    }

    await m007.up(conn);

    const destinations = await readDestinationRows(conn);
    const byId = new Map(destinations.map((row) => [row.symbolId, row]));
    assert.equal(byId.get("mini-copy")?.embeddingMiniLM, encoded(384));
    assert.equal(byId.get("nomic-copy")?.embeddingNomic, encoded(768));
    assert.equal(byId.get("current")?.embeddingMiniLM, exponentEncoded(384));
    assert.equal(byId.get("conflict")?.embeddingMiniLM, encoded(384, 2));
    assert.deepEqual(await readSourceIds(conn), [
      "conflict",
      "malformed",
      "mock",
      "orphan",
      "unknown",
    ]);

    const beforeRerun = {
      destinations: await readDestinationRows(conn),
      sourceIds: await readSourceIds(conn),
    };
    await m007.up(conn);
    assert.deepEqual(
      {
        destinations: await readDestinationRows(conn),
        sourceIds: await readSourceIds(conn),
      },
      beforeRerun,
    );
  });
});

describe("SymbolEmbedding migration registry and initializer paths", () => {
  it("registers m021 as the only migration after version 20", () => {
    assert.equal(LADYBUG_SCHEMA_VERSION, 21);
    assert.deepEqual(
      computePendingMigrations(migrations, 20).map(({ version }) => version),
      [21],
    );
    assert.deepEqual(
      computePendingMigrations(migrations, 7).map(({ version }) => version),
      Array.from({ length: 14 }, (_, index) => index + 8),
    );
  });

  it("remediates residual rows when reopening a version-20 database", async () => {
    const dbPath = join(testRoot, "version-20.lbug");
    mkdirSync(testRoot, { recursive: true });
    await initLadybugDb(dbPath);
    let conn = await getLadybugConn();
    await seedLatestResidual(conn, "version-20-symbol");
    await setSchemaVersion(conn, 20);
    await closeLadybugDb();

    await initLadybugDb(dbPath);
    conn = await getLadybugConn();

    assert.equal(await getSchemaVersion(conn), 21);
    assert.deepEqual(await readSourceIds(conn), []);
    assert.equal(
      (await readDestinationRows(conn))[0]?.embeddingMiniLM,
      encoded(384),
    );
  });

  it("runs versions 8 through 21 in order from a recorded version 7", async () => {
    const dbPath = join(testRoot, "version-7.lbug");
    mkdirSync(testRoot, { recursive: true });
    await initLadybugDb(dbPath);
    let conn = await getLadybugConn();
    await seedLatestResidual(conn, "version-7-symbol");
    await setSchemaVersion(conn, 7);
    await closeLadybugDb();

    const invoked: number[] = [];
    const originals = migrations.map((migration) => migration);
    for (let index = 0; index < migrations.length; index++) {
      const original = migrations[index];
      if (original.version >= 8) {
        migrations[index] = {
          ...original,
          async up(writeConn) {
            invoked.push(original.version);
            await original.up(writeConn);
          },
        };
      }
    }

    try {
      await initLadybugDb(dbPath);
      conn = await getLadybugConn();
      assert.deepEqual(
        invoked,
        Array.from({ length: 14 }, (_, index) => index + 8),
      );
      assert.equal(await getSchemaVersion(conn), 21);
      assert.deepEqual(await readSourceIds(conn), []);
      assert.equal(
        (await readDestinationRows(conn))[0]?.embeddingMiniLM,
        encoded(384),
      );
    } finally {
      for (let index = 0; index < migrations.length; index++) {
        migrations[index] = originals[index];
      }
    }
  });

  it("preserves a future schema version without running migrations", async () => {
    const dbPath = join(testRoot, "version-22.lbug");
    mkdirSync(testRoot, { recursive: true });
    await initLadybugDb(dbPath);
    let conn = await getLadybugConn();
    await setSchemaVersion(conn, 22);
    await closeLadybugDb();

    const lastIndex = migrations.length - 1;
    const original = migrations[lastIndex];
    migrations[lastIndex] = {
      ...original,
      async up() {
        throw new Error("numbered migration must not run");
      },
    };

    try {
      await initLadybugDb(dbPath);
      conn = await getLadybugConn();
      assert.equal(await getSchemaVersion(conn), 22);
    } finally {
      migrations[lastIndex] = original;
    }
  });
});
