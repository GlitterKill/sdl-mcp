import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  initLadybugDb,
  runWalCheckpoint,
  withExclusiveReadConnection,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import {
  exec,
  execDdl,
  queryAll,
  withReadOnlyTransaction,
  withTransaction,
} from "../../dist/db/ladybug-core.js";

interface SnapshotRow {
  id: bigint | number;
  value: string;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("background graph integrity snapshot", () => {
  const dbDir = mkdtempSync(join(tmpdir(), "sdl-graph-snapshot-"));
  const dbPath = join(dbDir, "snapshot.lbug");

  before(async () => {
    await initLadybugDb(dbPath);
    await withWriteConn(async (conn) => {
      await execDdl(
        conn,
        "CREATE NODE TABLE SnapshotProbe (id INT64 PRIMARY KEY, value STRING)",
      );
      await exec(
        conn,
        `UNWIND $rows AS row
         CREATE (n:SnapshotProbe {id: row.id, value: row.value})`,
        {
          rows: [
            { id: 1, value: "one" },
            { id: 2, value: "two" },
            { id: 3, value: "three" },
            { id: 4, value: "four" },
          ],
        },
      );
    });
  });

  after(async () => {
    await closeLadybugDb();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("keeps deterministic pages stable across a concurrent writer commit", async () => {
    const firstPageRead = deferred();
    const continueSnapshot = deferred();

    const snapshot = withExclusiveReadConnection((conn) =>
      withReadOnlyTransaction(conn, async () => {
        const first = await queryAll<SnapshotRow>(
          conn,
          `MATCH (n:SnapshotProbe)
           RETURN n.id AS id, n.value AS value
           ORDER BY n.id
           SKIP $offset LIMIT $limit`,
          { offset: 0, limit: 2 },
        );
        firstPageRead.resolve();
        await continueSnapshot.promise;
        const second = await queryAll<SnapshotRow>(
          conn,
          `MATCH (n:SnapshotProbe)
           RETURN n.id AS id, n.value AS value
           ORDER BY n.id
           SKIP $offset LIMIT $limit`,
          { offset: 2, limit: 10 },
        );
        return { first, second };
      }),
    );

    try {
      await Promise.race([firstPageRead.promise, snapshot]);
      await withWriteConn((conn) =>
        withTransaction(conn, async () => {
          await exec(
            conn,
            "MATCH (n:SnapshotProbe {id: $id}) SET n.value = $value",
            { id: 4, value: "four-updated" },
          );
          await exec(
            conn,
            "CREATE (n:SnapshotProbe {id: $id, value: $value})",
            { id: 5, value: "five" },
          );
        }),
      );
      continueSnapshot.resolve();

      const pages = await snapshot;
      assert.deepStrictEqual(
        pages.first.map((row) => [Number(row.id), row.value]),
        [
          [1, "one"],
          [2, "two"],
        ],
      );
      assert.deepStrictEqual(
        pages.second.map((row) => [Number(row.id), row.value]),
        [
          [3, "three"],
          [4, "four"],
        ],
      );

      const nextSnapshot = await withExclusiveReadConnection((conn) =>
        withReadOnlyTransaction(conn, () =>
          queryAll<SnapshotRow>(
            conn,
            `MATCH (n:SnapshotProbe)
             RETURN n.id AS id, n.value AS value
             ORDER BY n.id`,
          ),
        ),
      );
      assert.deepStrictEqual(
        nextSnapshot.map((row) => [Number(row.id), row.value]),
        [
          [1, "one"],
          [2, "two"],
          [3, "three"],
          [4, "four-updated"],
          [5, "five"],
        ],
      );
    } finally {
      continueSnapshot.resolve();
      await Promise.allSettled([snapshot]);
    }
  });

  it("composes publication after a held read-only snapshot releases", async () => {
    const events: string[] = [];
    const snapshotHeld = deferred();
    const releaseSnapshot = deferred();

    const scanThenPublication = (async () => {
      await withExclusiveReadConnection((conn) =>
        withReadOnlyTransaction(conn, async () => {
          events.push("snapshot:started");
          await queryAll(
            conn,
            "MATCH (n:SnapshotProbe) RETURN count(n) AS count",
          );
          events.push("snapshot:page-complete");
          snapshotHeld.resolve();
          await releaseSnapshot.promise;
        }),
      );
      events.push("snapshot:ended");

      await withWriteConn(async (conn) => {
        events.push("publication:started");
        await exec(
          conn,
          "MATCH (n:SnapshotProbe {id: $id}) SET n.value = $value",
          { id: 1, value: "one-published" },
        );
        events.push("publication:completed");
      });
    })();

    try {
      await Promise.race([snapshotHeld.promise, scanThenPublication]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(events, [
        "snapshot:started",
        "snapshot:page-complete",
      ]);

      releaseSnapshot.resolve();
      await scanThenPublication;
      assert.deepStrictEqual(events, [
        "snapshot:started",
        "snapshot:page-complete",
        "snapshot:ended",
        "publication:started",
        "publication:completed",
      ]);
    } finally {
      releaseSnapshot.resolve();
      await Promise.allSettled([scanThenPublication]);
    }
  });

  it("allows a delayed checkpoint to succeed after the snapshot releases", async () => {
    const snapshotStarted = deferred();
    const releaseSnapshot = deferred();
    const snapshot = withExclusiveReadConnection((conn) =>
      withReadOnlyTransaction(conn, async () => {
        await queryAll(conn, "MATCH (n:SnapshotProbe) RETURN count(n) AS count");
        snapshotStarted.resolve();
        await releaseSnapshot.promise;
      }),
    );

    let checkpoint: Promise<boolean> | undefined;
    try {
      await Promise.race([snapshotStarted.promise, snapshot]);
      let checkpointCompleted = false;
      checkpoint = runWalCheckpoint("held-graph-integrity-snapshot").then(
        (result) => {
          checkpointCompleted = true;
          return result;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(checkpointCompleted, false);

      releaseSnapshot.resolve();
      await snapshot;
      assert.strictEqual(await checkpoint, true);
    } finally {
      releaseSnapshot.resolve();
      await Promise.allSettled(
        checkpoint ? [snapshot, checkpoint] : [snapshot],
      );
    }
  });
});
