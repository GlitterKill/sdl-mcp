import assert from "node:assert/strict";

const dbPath = process.argv[2];
assert.ok(dbPath, "expected a disposable LadybugDB path");

const { closeLadybugDb, initLadybugDb, withWriteConn } = await import(
  "../../../dist/db/ladybug.js"
);
const { getMetricsBySymbolIds, upsertMetricsBatch } = await import(
  "../../../dist/db/ladybug-queries.js"
);
const { querySingle, toNumber } = await import(
  "../../../dist/db/ladybug-core.js"
);

const makeRow = (index) => ({
  symbolId: `typed-metric-${String(index).padStart(4, "0")}`,
  fanIn: index,
  fanOut: index + 1,
  churn30d: index + 2,
  testRefsJson: null,
  canonicalTestJson: null,
  pageRank: index % 2 === 0 ? index : index + 0.5,
  kCore: index % 7,
  updatedAt: "2026-07-18T00:00:00.000Z",
});

const rows = Array.from({ length: 640 }, (_, index) => makeRow(index));
const preseed = rows
  .filter((_, index) => index % 10 === 0)
  .map((row) => ({
    ...row,
    fanIn: -1,
    fanOut: -1,
    churn30d: -1,
    pageRank: -1,
    updatedAt: "2026-07-17T00:00:00.000Z",
  }));
assert.strictEqual(preseed.length, 64);

const updated = rows.slice(0, 64).map((row, index) => ({
  ...row,
  fanIn: 10_000 + index,
  fanOut: 20_000 + index,
  churn30d: 30_000 + index,
  pageRank: index % 2 === 0 ? 40_000 + index : 40_000 + index + 0.5,
  kCore: 100 + index,
  updatedAt: "2026-07-19T00:00:00.000Z",
}));
updated[0] = {
  ...updated[0],
  testRefsJson: "",
  canonicalTestJson: "",
};
updated[1] = {
  ...updated[1],
  testRefsJson: "null",
  canonicalTestJson: "null",
};

async function countedUpsert(conn, batch) {
  let mergeStatements = 0;
  await upsertMetricsBatch(conn, batch, {
    measurePhase: async (phaseName, fn) => {
      if (phaseName === "mergeExisting") mergeStatements += 1;
      return await fn();
    },
  });
  return mergeStatements;
}

await initLadybugDb(dbPath);
try {
  const statementCounts = await withWriteConn(async (conn) => {
    const counts = [];
    counts.push(await countedUpsert(conn, preseed));
    counts.push(await countedUpsert(conn, rows));
    counts.push(await countedUpsert(conn, rows));
    counts.push(await countedUpsert(conn, updated));

    const allIds = rows.map((row) => row.symbolId);
    const physicalCount = await querySingle(
      conn,
      `MATCH (m:Metrics)
       WHERE m.symbolId IN $symbolIds
       RETURN count(m) AS count`,
      { symbolIds: allIds },
    );
    assert.ok(physicalCount);
    assert.strictEqual(toNumber(physicalCount.count), 640);

    const actual = await getMetricsBySymbolIds(conn, allIds);
    assert.strictEqual(actual.size, 640);

    const expected = new Map(rows.map((row) => [row.symbolId, row]));
    for (const row of updated) expected.set(row.symbolId, row);

    for (const [symbolId, expectedRow] of expected) {
      const actualRow = actual.get(symbolId);
      assert.ok(actualRow, `missing Metrics row ${symbolId}`);
      assert.strictEqual(actualRow.fanIn, expectedRow.fanIn);
      assert.strictEqual(actualRow.fanOut, expectedRow.fanOut);
      assert.strictEqual(actualRow.churn30d, expectedRow.churn30d);
      assert.strictEqual(actualRow.testRefsJson, expectedRow.testRefsJson);
      assert.strictEqual(
        actualRow.canonicalTestJson,
        expectedRow.canonicalTestJson,
      );
      assert.strictEqual(actualRow.pageRank, expectedRow.pageRank);
      assert.strictEqual(actualRow.kCore, expectedRow.kCore);
      assert.strictEqual(actualRow.updatedAt, expectedRow.updatedAt);
    }

    return counts;
  });

  assert.deepStrictEqual(statementCounts, [1, 3, 3, 2]);
  process.stdout.write(
    JSON.stringify({
      ok: true,
      count: 640,
      fullBatchChunks: [256, 256, 128],
      statementCounts,
      updated: 64,
    }) + "\n",
  );
} finally {
  await closeLadybugDb();
}
