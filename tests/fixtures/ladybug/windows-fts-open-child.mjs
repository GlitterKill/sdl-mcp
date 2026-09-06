import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const [mode, dbPath, ...extraArgs] = process.argv.slice(2);
assert.ok(
  (mode === "seed" || mode === "open") && dbPath && extraArgs.length === 0,
  "expected seed|open and a database path",
);
assert.equal(process.env.SDL_GRAPH_DB_PATH, dbPath);

async function execute(conn, query, rows = false) {
  const result = await conn.query(query);
  const results = Array.isArray(result) ? result : [result];
  try {
    return rows ? await results[0].getAll() : undefined;
  } finally {
    for (const item of results) item.close();
  }
}

async function seedFtsDatabase() {
  const { initLadybugDb, getLadybugConn, closeLadybugDb, initValidatedLadybugClone } =
    await import("../../../dist/db/ladybug.js");
  const { isWindowsFtsRuntimeUnavailable, withWindowsFtsRuntime } =
    await import("../../../dist/db/ladybug-windows-fts-runtime.js");
  const seedPath = join(dirname(dbPath), ".fts-seed", basename(dbPath));
  mkdirSync(dirname(seedPath), { recursive: true });
  // Clone validation requires a current SDL schema alongside the FTS index.
  await initLadybugDb(seedPath);
  const conn = await getLadybugConn();
  try {
    await execute(conn, "INSTALL fts");
    const loaded = await withWindowsFtsRuntime(() =>
      execute(conn, "LOAD EXTENSION fts"),
    );
    assert.equal(
      isWindowsFtsRuntimeUnavailable(loaded),
      false,
      isWindowsFtsRuntimeUnavailable(loaded) ? loaded.recovery : undefined,
    );
    await execute(
      conn,
      "CREATE NODE TABLE FtsReopenProbe(id INT64, text STRING, PRIMARY KEY(id))",
    );
    await execute(
      conn,
      "CREATE (:FtsReopenProbe {id: 1, text: 'fts reopen boundary'})",
    );
    await execute(
      conn,
      "CALL CREATE_FTS_INDEX('FtsReopenProbe', 'fts_reopen_probe_idx', ['text'], stemmer := 'none')",
    );
    const rows = await execute(
      conn,
      "CALL QUERY_FTS_INDEX('FtsReopenProbe', 'fts_reopen_probe_idx', 'reopen') RETURN node.id AS id",
      true,
    );
    assert.deepEqual(
      rows.map((row) => Number(row.id)),
      [1],
    );
  } finally {
    await closeLadybugDb({ strict: true });
  }

  const { copyLadybugFamilyForValidatedClone } = await import(
    "../../../dist/db/ladybug-family-files.js"
  );
  const capability = copyLadybugFamilyForValidatedClone(seedPath, dbPath);
  await initValidatedLadybugClone(dbPath, capability);
  await closeLadybugDb({ strict: true });
}

async function openWithProductionDatabase() {
  const { closeLadybugDb, getLadybugConn, initLadybugDb } =
    await import("../../../dist/db/ladybug.js");
  await initLadybugDb(dbPath);
  try {
    const conn = await getLadybugConn();
    const rows = await execute(
      conn,
      "CALL QUERY_FTS_INDEX('FtsReopenProbe', 'fts_reopen_probe_idx', 'reopen') RETURN node.id AS id",
      true,
    );
    assert.deepEqual(rows.map((row) => Number(row.id)), [1]);
  } finally {
    await closeLadybugDb({ strict: true });
  }
}

if (mode === "seed") await seedFtsDatabase();
else await openWithProductionDatabase();
