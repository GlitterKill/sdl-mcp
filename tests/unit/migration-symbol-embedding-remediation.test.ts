import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exec,
  execDdl,
  isConnectionPoisoned,
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
import * as m021 from "../../dist/db/migrations/m021-remediate-symbol-embeddings.js";
import { remediateSymbolEmbeddings } from "../../dist/db/migrations/symbol-embedding-remediation.js";
import {
  computePendingMigrations,
  runPendingMigrations,
} from "../../dist/db/migration-runner.js";

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
  it("keeps m021 before the graph-integrity migration", () => {
    assert.equal(LADYBUG_SCHEMA_VERSION, 22);
    assert.deepEqual(
      computePendingMigrations(migrations, 20).map(({ version }) => version),
      [21, 22],
    );
    assert.deepEqual(
      computePendingMigrations(migrations, 7).map(({ version }) => version),
      Array.from({ length: 15 }, (_, index) => index + 8),
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

    assert.equal(await getSchemaVersion(conn), 22);
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
        Array.from({ length: 15 }, (_, index) => index + 8),
      );
      assert.equal(await getSchemaVersion(conn), 22);
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


interface InterceptContext {
  statement: string;
  params: Record<string, unknown>;
}

interface InterceptRule {
  match: string;
  occurrence?: number;
  beforeExecute?: (context: InterceptContext) => void | Promise<void>;
  afterExecute?: (context: InterceptContext) => void | Promise<void>;
  afterSettle?: (context: InterceptContext) => void | Promise<void>;
}

interface ExecutedStatement extends InterceptContext {}

function interceptConnection(
  real: import("kuzu").Connection,
  rules: readonly InterceptRule[] = [],
  executions: ExecutedStatement[] = [],
  lifecycle: string[] = [],
): import("kuzu").Connection {
  const preparedSql = new Map<import("kuzu").PreparedStatement, string>();
  const states = rules.map((rule) => ({
    ...rule,
    occurrence: rule.occurrence ?? 1,
    matches: 0,
    fired: false,
  }));

  return new Proxy(real, {
    get(target, property) {
      if (property === "prepare") {
        return async (statement: string) => {
          lifecycle.push(`prepare:${statement}`);
          const prepared = await target.prepare(statement);
          preparedSql.set(prepared, statement);
          return prepared;
        };
      }

      if (property === "execute") {
        return async (
          prepared: import("kuzu").PreparedStatement,
          rawParams: Parameters<import("kuzu").Connection["execute"]>[1],
        ) => {
          const statement = preparedSql.get(prepared) ?? "";
          const params = (rawParams ?? {}) as Record<string, unknown>;
          const context = { statement, params };
          executions.push(context);
          lifecycle.push(`execute:start:${statement}`);

          const activeRule = states.find((state) => {
            if (state.fired || !statement.includes(state.match)) return false;
            state.matches++;
            if (state.matches !== state.occurrence) return false;
            state.fired = true;
            return true;
          });
          await activeRule?.beforeExecute?.(context);

          try {
            const result = await target.execute(prepared, rawParams);
            await activeRule?.afterExecute?.(context);
            return result;
          } finally {
            await activeRule?.afterSettle?.(context);
            lifecycle.push(`execute:settled:${statement}`);
          }
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function createFullRemediationDatabase(
  name: string,
): Promise<import("kuzu").Connection> {
  const { conn } = await createRawDatabase(name);
  await execDdl(
    conn,
    `CREATE NODE TABLE Symbol (
      symbolId STRING PRIMARY KEY,
      embeddingMiniLM STRING,
      embeddingMiniLMCardHash STRING,
      embeddingMiniLMUpdatedAt STRING,
      embeddingNomic STRING,
      embeddingNomicCardHash STRING,
      embeddingNomicUpdatedAt STRING
    )`,
  );
  await createCompatibilityTable(conn);
  return conn;
}

async function seedEmptyDestination(
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
}

function executedStatementCount(
  executions: readonly ExecutedStatement[],
  fragment: string,
): number {
  return executions.filter(({ statement }) => statement.includes(fragment))
    .length;
}

describe("SymbolEmbedding remediation failure boundaries", () => {
  it("rolls back the copy transaction and never enters deletion", async () => {
    const real = await createFullRemediationDatabase("copy-rollback");
    await seedEmptyDestination(real, "copy-rollback-symbol");
    await seedLegacyEmbedding(real, legacyRow("copy-rollback-symbol"));

    const executions: ExecutedStatement[] = [];
    const proxy = interceptConnection(
      real,
      [
        {
          match: "SET s.embeddingMiniLM =",
          beforeExecute() {
            throw new Error("copy-sentinel");
          },
        },
      ],
      executions,
    );

    await assert.rejects(
      remediateSymbolEmbeddings(proxy, "copy-rollback"),
      /copy-sentinel/,
    );
    assert.deepEqual(await readDestinationRows(real), [
      {
        symbolId: "copy-rollback-symbol",
        embeddingMiniLM: null,
        embeddingMiniLMCardHash: null,
        embeddingMiniLMUpdatedAt: null,
        embeddingNomic: null,
        embeddingNomicCardHash: null,
        embeddingNomicUpdatedAt: null,
      },
    ]);
    assert.deepEqual(await readSourceIds(real), ["copy-rollback-symbol"]);
    assert.equal(executedStatementCount(executions, "DELETE se"), 0);
  });

  it("rolls back a missing-table read before returning an empty summary", async () => {
    const { conn: real } = await createRawDatabase("missing-table");
    await execDdl(
      real,
      `CREATE NODE TABLE Symbol (
        symbolId STRING PRIMARY KEY,
        embeddingMiniLM STRING,
        embeddingMiniLMCardHash STRING,
        embeddingMiniLMUpdatedAt STRING,
        embeddingNomic STRING,
        embeddingNomicCardHash STRING,
        embeddingNomicUpdatedAt STRING
      )`,
    );

    const lifecycle: string[] = [];
    const proxy = interceptConnection(
      real,
      [
        {
          match: "ROLLBACK",
          afterSettle() {
            lifecycle.push("rollback-settled");
          },
        },
      ],
      [],
      lifecycle,
    );

    const summary = await remediateSymbolEmbeddings(proxy, "missing-table");
    lifecycle.push("returned");

    assert.deepEqual(summary, {
      scanned: 0,
      copied: 0,
      alreadyCurrent: 0,
      deleted: 0,
      retained: {
        conflict: 0,
        duplicateQueryResult: 0,
        malformed: 0,
        mock: 0,
        orphan: 0,
        unknownModel: 0,
      },
    });
    const sourceReadIndex = lifecycle.findIndex((entry) =>
      entry.includes("prepare:MATCH (se:SymbolEmbedding)"),
    );
    const rollbackIndex = lifecycle.indexOf("rollback-settled");
    assert.ok(sourceReadIndex >= 0);
    assert.ok(sourceReadIndex < rollbackIndex);
    assert.ok(rollbackIndex < lifecycle.indexOf("returned"));
  });

  it("propagates rollback failures instead of treating them as missing-table no-ops", async () => {
    const { conn: real } = await createRawDatabase("rollback-failure");
    await execDdl(
      real,
      `CREATE NODE TABLE Symbol (
        symbolId STRING PRIMARY KEY,
        embeddingMiniLM STRING,
        embeddingMiniLMCardHash STRING,
        embeddingMiniLMUpdatedAt STRING,
        embeddingNomic STRING,
        embeddingNomicCardHash STRING,
        embeddingNomicUpdatedAt STRING
      )`,
    );

    const proxy = interceptConnection(real, [
      {
        match: "ROLLBACK",
        beforeExecute() {
          throw new Error("rollback-sentinel");
        },
      },
    ]);

    await assert.rejects(
      remediateSymbolEmbeddings(proxy, "rollback-failure"),
      /rollback-sentinel/,
    );
    assert.equal(isConnectionPoisoned(proxy), true);
  });

  it("propagates non-table source read failures after rollback", async () => {
    const real = await createFullRemediationDatabase("source-read-failure");
    const lifecycle: string[] = [];
    const proxy = interceptConnection(
      real,
      [
        {
          match: "ORDER BY se.symbolId, se.model",
          beforeExecute() {
            throw new Error("source-read-sentinel");
          },
        },
        {
          match: "ROLLBACK",
          afterSettle() {
            lifecycle.push("rollback-settled");
          },
        },
      ],
      [],
      lifecycle,
    );

    await assert.rejects(
      remediateSymbolEmbeddings(proxy, "source-read-failure"),
      /source-read-sentinel/,
    );
    assert.ok(lifecycle.includes("rollback-settled"));
  });

  it("revalidates destination and source fingerprints before copying", async () => {
    for (const mutation of ["destination", "source"] as const) {
      const real = await createFullRemediationDatabase(
        `copy-revalidation-${mutation}`,
      );
      const symbolId = `copy-revalidation-${mutation}`;
      await seedEmptyDestination(real, symbolId);
      await seedLegacyEmbedding(real, legacyRow(symbolId));

      const proxy = interceptConnection(real, [
        {
          match: "SET s.embeddingMiniLM =",
          async beforeExecute() {
            if (mutation === "destination") {
              await exec(
                real,
                `MATCH (s:Symbol {symbolId: $symbolId})
                 SET s.embeddingMiniLM = $vector`,
                { symbolId, vector: encoded(384, 9) },
              );
            } else {
              await exec(
                real,
                `MATCH (se:SymbolEmbedding {symbolId: $symbolId})
                 SET se.cardHash = $cardHash`,
                { symbolId, cardHash: "mutated-source-hash" },
              );
            }
          },
        },
      ]);

      const summary = await remediateSymbolEmbeddings(
        proxy,
        `copy-revalidation-${mutation}`,
      );
      assert.equal(summary.copied, 0);
      assert.deepEqual(await readSourceIds(real), [symbolId]);
      const destination = (await readDestinationRows(real))[0];
      assert.equal(
        destination?.embeddingMiniLM,
        mutation === "destination" ? encoded(384, 9) : null,
      );
    }
  });

  it("revalidates source and destination immediately before deletion begins", async () => {
    for (const mutation of ["source", "destination"] as const) {
      const real = await createFullRemediationDatabase(
        `delete-revalidation-${mutation}`,
      );
      const symbolId = `delete-revalidation-${mutation}`;
      await seedEmptyDestination(real, symbolId);
      await seedLegacyEmbedding(real, legacyRow(symbolId));

      const proxy = interceptConnection(real, [
        {
          match: "BEGIN TRANSACTION",
          occurrence: 2,
          async beforeExecute() {
            if (mutation === "source") {
              await exec(
                real,
                `MATCH (se:SymbolEmbedding {symbolId: $symbolId})
                 SET se.cardHash = $cardHash`,
                { symbolId, cardHash: "changed-after-copy" },
              );
            } else {
              await exec(
                real,
                `MATCH (s:Symbol {symbolId: $symbolId})
                 SET s.embeddingMiniLMCardHash = $cardHash`,
                { symbolId, cardHash: "changed-after-copy" },
              );
            }
          },
        },
      ]);

      const summary = await remediateSymbolEmbeddings(
        proxy,
        `delete-revalidation-${mutation}`,
      );
      assert.equal(summary.copied, 1);
      assert.equal(summary.deleted, 0);
      assert.deepEqual(await readSourceIds(real), [symbolId]);
    }
  });

  it("keeps committed copies when deletion fails and deletes on safe rerun", async () => {
    const real = await createFullRemediationDatabase("deletion-failure");
    const symbolId = "deletion-failure-symbol";
    await seedEmptyDestination(real, symbolId);
    await seedLegacyEmbedding(real, legacyRow(symbolId));

    const proxy = interceptConnection(real, [
      {
        match: "DELETE se",
        beforeExecute() {
          throw new Error("delete-sentinel");
        },
      },
    ]);

    await assert.rejects(
      remediateSymbolEmbeddings(proxy, "deletion-failure"),
      /delete-sentinel/,
    );
    assert.equal(
      (await readDestinationRows(real))[0]?.embeddingMiniLM,
      encoded(384),
    );
    assert.deepEqual(await readSourceIds(real), [symbolId]);

    const retrySummary = await remediateSymbolEmbeddings(
      real,
      "deletion-retry",
    );
    assert.equal(retrySummary.copied, 0);
    assert.equal(retrySummary.alreadyCurrent, 1);
    assert.equal(retrySummary.deleted, 1);
    assert.deepEqual(await readSourceIds(real), []);
  });

  it("safely retries m021 after the final SchemaVersion write fails", async () => {
    const dbPath = join(testRoot, "schema-version-retry.lbug");
    mkdirSync(testRoot, { recursive: true });
    await initLadybugDb(dbPath);
    const real = await getLadybugConn();
    const symbolId = "schema-version-retry-symbol";
    await seedLatestResidual(real, symbolId);
    await setSchemaVersion(real, 20);

    const wrappedM021 = {
      ...m021,
      async up(writeConn: import("kuzu").Connection) {
        await m021.up(writeConn);
      },
    };
    const proxy = interceptConnection(real, [
      {
        match: "MERGE (sv:SchemaVersion",
        beforeExecute() {
          throw new Error("schema-version-sentinel");
        },
      },
    ]);

    await assert.rejects(
      runPendingMigrations(proxy, 20, [wrappedM021]),
      /schema-version-sentinel/,
    );
    assert.equal(await getSchemaVersion(real), 20);
    assert.equal(
      (await readDestinationRows(real))[0]?.embeddingMiniLM,
      encoded(384),
    );
    assert.deepEqual(await readSourceIds(real), []);

    await runPendingMigrations(real, 20, [m021]);
    assert.equal(await getSchemaVersion(real), 21);
    assert.deepEqual(await readSourceIds(real), []);
  });
});

type BatchCategory =
  | "sourceRead"
  | "destinationRead"
  | "miniCopy"
  | "nomicCopy"
  | "miniDeleteVerify"
  | "miniDelete"
  | "nomicDeleteVerify"
  | "nomicDelete";

function batchCategory(statement: string): BatchCategory | null {
  if (statement.includes("ORDER BY se.symbolId, se.model")) {
    return "sourceRead";
  }
  if (statement.includes("UNWIND $symbolIds AS symbolId")) {
    return "destinationRead";
  }
  if (statement.includes("SET s.embeddingMiniLM =")) return "miniCopy";
  if (statement.includes("SET s.embeddingNomic =")) return "nomicCopy";

  const isDelete = statement.includes("DELETE se");
  const isVerify = statement.includes("RETURN se.symbolId AS symbolId");
  if (statement.includes("s.embeddingMiniLM = r.destinationVector")) {
    if (isDelete) return "miniDelete";
    if (isVerify) return "miniDeleteVerify";
  }
  if (statement.includes("s.embeddingNomic = r.destinationVector")) {
    if (isDelete) return "nomicDelete";
    if (isVerify) return "nomicDeleteVerify";
  }
  return null;
}

function executionIds(execution: ExecutedStatement): string[] {
  const values = execution.params.symbolIds ?? execution.params.rows;
  if (!Array.isArray(values)) return [];

  return values.flatMap((value) => {
    if (typeof value === "string") return [value];
    if (
      value &&
      typeof value === "object" &&
      "symbolId" in value &&
      typeof value.symbolId === "string"
    ) {
      return [value.symbolId];
    }
    return [];
  });
}

function categorizeExecutions(
  executions: readonly ExecutedStatement[],
): Record<BatchCategory, string[][]> {
  const categories: Record<BatchCategory, string[][]> = {
    sourceRead: [],
    destinationRead: [],
    miniCopy: [],
    nomicCopy: [],
    miniDeleteVerify: [],
    miniDelete: [],
    nomicDeleteVerify: [],
    nomicDelete: [],
  };
  for (const execution of executions) {
    const category = batchCategory(execution.statement);
    if (category) categories[category].push(executionIds(execution));
  }
  return categories;
}

async function seedMultiBatchRows(
  conn: import("kuzu").Connection,
): Promise<void> {
  const rows = [
    ...Array.from({ length: 257 }, (_, index) => ({
      symbolId: `mini-${String(index).padStart(3, "0")}`,
      model: "all-MiniLM-L6-v2",
      embeddingVector: encoded(384),
    })),
    ...Array.from({ length: 257 }, (_, index) => ({
      symbolId: `nomic-${String(index).padStart(3, "0")}`,
      model: "nomic-embed-text-v1.5",
      embeddingVector: encoded(768),
    })),
  ];

  for (let offset = 0; offset < rows.length; offset += 256) {
    const batch = rows.slice(offset, offset + 256);
    await exec(
      conn,
      `UNWIND $rows AS r
       CREATE (s:Symbol {
         symbolId: r.symbolId,
         embeddingMiniLM: null,
         embeddingMiniLMCardHash: null,
         embeddingMiniLMUpdatedAt: null,
         embeddingNomic: null,
         embeddingNomicCardHash: null,
         embeddingNomicUpdatedAt: null
       })`,
      { rows: batch },
    );
    await exec(
      conn,
      `UNWIND $rows AS r
       CREATE (se:SymbolEmbedding {
         symbolId: r.symbolId,
         model: r.model,
         embeddingVector: r.embeddingVector,
         version: null,
         cardHash: null,
         createdAt: null,
         updatedAt: null
       })`,
      { rows: batch },
    );
  }
}

async function runMultiBatchCase(name: string): Promise<{
  categories: Record<BatchCategory, string[][]>;
  copied: number;
  deleted: number;
  destinationCount: number;
  sourceIds: string[];
}> {
  const real = await createFullRemediationDatabase(name);
  await seedMultiBatchRows(real);
  const executions: ExecutedStatement[] = [];
  const proxy = interceptConnection(real, [], executions);
  const summary = await remediateSymbolEmbeddings(proxy, name);

  return {
    categories: categorizeExecutions(executions),
    copied: summary.copied,
    deleted: summary.deleted,
    destinationCount: (await readDestinationRows(real)).length,
    sourceIds: await readSourceIds(real),
  };
}

describe("SymbolEmbedding remediation batching", () => {
  it("uses deterministic bounded batches for 257 rows in each lane", async () => {
    const expectedMiniIds = Array.from(
      { length: 257 },
      (_, index) => `mini-${String(index).padStart(3, "0")}`,
    );
    const expectedNomicIds = Array.from(
      { length: 257 },
      (_, index) => `nomic-${String(index).padStart(3, "0")}`,
    );
    const expectedDestinationIds = [
      ...expectedMiniIds,
      ...expectedNomicIds,
    ].sort();

    const first = await runMultiBatchCase("batch-first");
    const second = await runMultiBatchCase("batch-second");

    for (const result of [first, second]) {
      assert.equal(result.copied, 514);
      assert.equal(result.deleted, 514);
      assert.equal(result.destinationCount, 514);
      assert.deepEqual(result.sourceIds, []);

      assert.equal(result.categories.sourceRead.length, 1);
      assert.equal(result.categories.destinationRead.length, Math.ceil(514 / 256));
      for (const category of [
        "miniCopy",
        "nomicCopy",
        "miniDeleteVerify",
        "miniDelete",
        "nomicDeleteVerify",
        "nomicDelete",
      ] as const) {
        assert.equal(result.categories[category].length, Math.ceil(257 / 256));
      }

      assert.deepEqual(
        result.categories.destinationRead.map(({ length }) => length),
        [256, 256, 2],
      );
      assert.deepEqual(
        result.categories.destinationRead.flat(),
        expectedDestinationIds,
      );

      for (const category of [
        "miniCopy",
        "miniDeleteVerify",
        "miniDelete",
      ] as const) {
        assert.deepEqual(
          result.categories[category].map(({ length }) => length),
          [256, 1],
        );
        assert.deepEqual(result.categories[category].flat(), expectedMiniIds);
      }
      for (const category of [
        "nomicCopy",
        "nomicDeleteVerify",
        "nomicDelete",
      ] as const) {
        assert.deepEqual(
          result.categories[category].map(({ length }) => length),
          [256, 1],
        );
        assert.deepEqual(result.categories[category].flat(), expectedNomicIds);
      }
    }

    assert.deepEqual(second, first);
  });
});
