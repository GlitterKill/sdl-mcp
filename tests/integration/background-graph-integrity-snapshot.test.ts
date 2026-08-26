import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Connection, QueryResult } from "kuzu";

import {
  closeLadybugDb,
  getLadybugDb,
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
import { withExclusiveLadybugOperation } from "../../dist/db/ladybug-operation-gate.js";
import { withPostIndexWriteSession } from "../../dist/db/write-session.js";
import { verifyPersistedGraphIntegrityRevision } from "../../dist/indexer/provider-first/persisted-graph-integrity.js";

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

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeResult(
  getAll: () => Promise<unknown[]> = async () => [],
  close: () => void = () => undefined,
): QueryResult {
  return { getAll, close } as unknown as QueryResult;
}

function fakeConnection(
  executeStatement: (statement: string) => Promise<QueryResult>,
): Connection {
  const statements = new WeakMap<object, string>();
  return {
    prepare: async (statement: string) => {
      const prepared = {};
      statements.set(prepared, statement);
      return prepared;
    },
    execute: async (prepared: object) =>
      executeStatement(statements.get(prepared) ?? ""),
    query: executeStatement,
  } as unknown as Connection;
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
      await exec(
        conn,
        `CREATE (e:SymbolVectorEmbedding {
           embeddingId: $embeddingId,
           repoId: $repoId,
           symbolId: $symbolId,
           model: $model,
           embeddingVector: $embeddingVector,
           cardHash: $cardHash,
           updatedAt: $updatedAt,
           embeddingJinaCodeVec: $vector
         })`,
        {
          embeddingId: "jina-embeddings-v2-base-code:snapshot-symbol",
          repoId: "snapshot-embedding-repo",
          symbolId: "snapshot-symbol",
          model: "jina-embeddings-v2-base-code",
          embeddingVector: "snapshot-vector",
          cardHash: "snapshot-card-hash",
          updatedAt: "2026-08-26T00:00:00.000Z",
          vector: new Array<number>(768).fill(0).map((_, index) => index / 768),
        },
      );
    });
  });

  after(async () => {
    await closeLadybugDb();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("leaves persisted embedding bytes unchanged after the read-only verifier", async () => {
    const readEmbeddingBytes = () =>
      withExclusiveReadConnection(async (conn) =>
        JSON.stringify(
          await queryAll(
            conn,
            `MATCH (e:SymbolVectorEmbedding)
            WHERE e.embeddingId = $embeddingId
            RETURN e.embeddingId AS embeddingId,
                   e.repoId AS repoId,
                   e.symbolId AS symbolId,
                   e.model AS model,
                   e.embeddingVector AS embeddingVector,
                   e.cardHash AS cardHash,
                   e.updatedAt AS updatedAt,
                   e.embeddingJinaCodeVec AS vector`,
            {
              embeddingId: "jina-embeddings-v2-base-code:snapshot-symbol",
            },
          ),
        ),
      );
    const before = await readEmbeddingBytes();

    const result = await verifyPersistedGraphIntegrityRevision(
      "snapshot-embedding-repo",
      "snapshot-version",
      1,
      { persistSuccessState: async () => true },
    );

    assert.strictEqual(result, "verified");
    assert.strictEqual(await readEmbeddingBytes(), before);
  });

  it("keeps timed-out session work admitted until the body actually settles", async () => {
    const bodyEntered = deferred();
    const releaseBody = deferred();
    const events: string[] = [];
    const session = withPostIndexWriteSession(
      async () => {
        events.push("body-start");
        bodyEntered.resolve();
        await releaseBody.promise;
        events.push("body-end");
      },
      { timeoutMs: 60 },
    );

    await bodyEntered.promise;
    let timeoutReported = false;
    const timeoutAssertion = assert
      .rejects(session, /timed out after 60ms/)
      .then(() => {
        timeoutReported = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.strictEqual(timeoutReported, false);
    const competingWrite = withWriteConn(async () => {
      events.push("competing-write");
    });
    const exclusive = withExclusiveLadybugOperation(async () => {
      events.push("exclusive");
    });

    try {
      await nextTurn();
      await nextTurn();
      assert.deepStrictEqual(events, ["body-start"]);
    } finally {
      releaseBody.resolve();
    }

    await Promise.all([timeoutAssertion, competingWrite, exclusive]);
    assert.strictEqual(events[1], "body-end");
    assert.ok(events.includes("competing-write"));
    assert.ok(events.includes("exclusive"));
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

  it("keeps materialization admitted through result close and gives a queued checkpoint priority", async () => {
    const materializationStarted = deferred();
    const releaseMaterialization = deferred();
    const nativeCheckpointStarted = deferred();
    const releaseNativeCheckpoint = deferred();
    let firstResultClosed = false;
    let secondReadStarted = false;

    const firstConn = fakeConnection(async () =>
      fakeResult(
        async () => {
          materializationStarted.resolve();
          await releaseMaterialization.promise;
          return [];
        },
        () => {
          firstResultClosed = true;
        },
      ),
    );
    const secondConn = fakeConnection(async () =>
      fakeResult(async () => {
        secondReadStarted = true;
        return [];
      }),
    );

    let writeConn!: Connection;
    await withWriteConn(async (conn) => {
      writeConn = conn;
    });
    const originalQuery = writeConn.query.bind(writeConn);
    writeConn.query = (async (...args: Parameters<Connection["query"]>) => {
      if (String(args[0]).trim().toUpperCase() === "CHECKPOINT") {
        nativeCheckpointStarted.resolve();
        await releaseNativeCheckpoint.promise;
      }
      return originalQuery(...args);
    }) as Connection["query"];

    const firstRead = queryAll(firstConn, "RETURN 1");
    let checkpoint: Promise<boolean> | undefined;
    let secondRead: Promise<unknown[]> | undefined;
    try {
      await materializationStarted.promise;
      checkpoint = runWalCheckpoint("materialization-admission", 2_000);
      secondRead = queryAll(secondConn, "RETURN 2");
      await nextTurn();
      assert.strictEqual(secondReadStarted, false);

      releaseMaterialization.resolve();
      await nativeCheckpointStarted.promise;
      assert.strictEqual(firstResultClosed, true);
      assert.strictEqual(secondReadStarted, false);

      const callerTimedOut = await Promise.race([
        checkpoint.then(() => false),
        new Promise<true>((resolve) => {
          const timer = setTimeout(() => resolve(true), 20);
          timer.unref();
        }),
      ]);
      assert.strictEqual(callerTimedOut, true);
      assert.strictEqual(secondReadStarted, false);

      releaseNativeCheckpoint.resolve();
      assert.strictEqual(await checkpoint, true);
      await secondRead;
      assert.strictEqual(secondReadStarted, true);
    } finally {
      writeConn.query = originalQuery as Connection["query"];
      releaseMaterialization.resolve();
      releaseNativeCheckpoint.resolve();
      await Promise.allSettled(
        [firstRead, checkpoint, secondRead].filter(
          (promise): promise is Promise<unknown> => promise !== undefined,
        ),
      );
    }
  });

  for (const [label, operation] of [
    [
      "write callback",
      (entered: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>) =>
        withWriteConn(async (conn) => {
          await queryAll(conn, "RETURN 1");
          entered.resolve();
          await release.promise;
          await queryAll(conn, "RETURN 2");
        }),
    ],
    [
      "post-index session",
      (entered: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>) =>
        withPostIndexWriteSession(async () => {
          entered.resolve();
          await release.promise;
        }),
    ],
  ] as const) {
    it(`holds shared admission across a ${label}`, async () => {
      const entered = deferred();
      const release = deferred();
      let exclusiveEntered = false;
      const active = operation(entered, release);
      await entered.promise;
      const exclusive = withExclusiveLadybugOperation(async () => {
        exclusiveEntered = true;
      });
      await nextTurn();
      assert.strictEqual(exclusiveEntered, false);
      release.resolve();
      await Promise.all([active, exclusive]);
      assert.strictEqual(exclusiveEntered, true);
    });
  }

  it("preserves queued write admission when nested queries run ahead of an exclusive", async () => {
    const writerOneEntered = deferred();
    const releaseWriterOne = deferred();
    const events: string[] = [];

    const writerOne = withWriteConn(async () => {
      writerOneEntered.resolve();
      await releaseWriterOne.promise;
    });
    await writerOneEntered.promise;

    const writerTwo = withWriteConn(async (conn) => {
      await queryAll(conn, "RETURN 1");
      events.push("writer-2");
    });
    const writerThree = withWriteConn(async (conn) => {
      await queryAll(conn, "RETURN 1");
      events.push("writer-3");
    });
    await nextTurn();
    await nextTurn();

    const exclusive = withExclusiveLadybugOperation(async () => {
      events.push("exclusive");
    }, 500);
    releaseWriterOne.resolve();

    const settled = await Promise.allSettled([
      writerOne,
      writerTwo,
      writerThree,
      exclusive,
    ]);
    assert.deepStrictEqual(
      settled.map((result) => result.status),
      ["fulfilled", "fulfilled", "fulfilled", "fulfilled"],
    );
    assert.deepStrictEqual(events, ["writer-2", "writer-3", "exclusive"]);
  });

  it("preserves queued session write admission when nested queries run ahead of an exclusive", async () => {
    const writerOneEntered = deferred();
    const writersQueued = deferred();
    const releaseWriterOne = deferred();
    const events: string[] = [];

    const session = withPostIndexWriteSession(async () => {
      const writerOne = withWriteConn(async () => {
        writerOneEntered.resolve();
        await releaseWriterOne.promise;
      });
      await writerOneEntered.promise;

      const writerTwo = withWriteConn(async (conn) => {
        await queryAll(conn, "RETURN 1");
        events.push("writer-2");
      });
      const writerThree = withWriteConn(async (conn) => {
        await queryAll(conn, "RETURN 1");
        events.push("writer-3");
      });
      await nextTurn();
      await nextTurn();
      writersQueued.resolve();
      await Promise.all([writerOne, writerTwo, writerThree]);
    });
    await writersQueued.promise;

    const exclusive = withExclusiveLadybugOperation(async () => {
      events.push("exclusive");
    }, 500);
    releaseWriterOne.resolve();

    const settled = await Promise.allSettled([session, exclusive]);
    assert.deepStrictEqual(
      settled.map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );
    assert.deepStrictEqual(events, ["writer-2", "writer-3", "exclusive"]);
  });

  for (const [kind, transaction] of [
    [
      "read-only",
      (conn: Connection, body: () => Promise<void>) =>
        withReadOnlyTransaction(conn, body),
    ],
    [
      "write",
      (conn: Connection, body: () => Promise<void>) =>
        withTransaction(conn, body),
    ],
  ] as const) {
    for (const outcome of ["commit", "rollback"] as const) {
      it(`${kind} transaction holds shared admission through ${outcome}`, async () => {
        const phaseStarted = deferred();
        const releasePhase = deferred();
        const conn = fakeConnection(async (statement) => {
          if (statement === outcome.toUpperCase()) {
            phaseStarted.resolve();
            await releasePhase.promise;
          }
          return fakeResult();
        });
        const expected = new Error("rollback probe");
        const active = transaction(conn, async () => {
          if (outcome === "rollback") throw expected;
        });
        await phaseStarted.promise;

        let exclusiveEntered = false;
        const exclusive = withExclusiveLadybugOperation(async () => {
          exclusiveEntered = true;
        });
        await nextTurn();
        assert.strictEqual(exclusiveEntered, false);

        releasePhase.resolve();
        if (outcome === "rollback") {
          await assert.rejects(active, expected);
        } else {
          await active;
        }
        await exclusive;
        assert.strictEqual(exclusiveEntered, true);
      });
    }
  }

  it("does not start Database.close while a native operation is admitted", async (t) => {
    const materializationStarted = deferred();
    const releaseMaterialization = deferred();
    const conn = fakeConnection(async () =>
      fakeResult(async () => {
        materializationStarted.resolve();
        await releaseMaterialization.promise;
        return [];
      }),
    );
    const db = await getLadybugDb();
    const originalClose = db.close.bind(db);
    const closeStarted = deferred();
    let databaseCloseStarted = false;
    t.mock.method(db, "close", async () => {
      databaseCloseStarted = true;
      closeStarted.resolve();
      await originalClose();
    });

    const active = queryAll(conn, "RETURN 1");
    await materializationStarted.promise;
    const closing = closeLadybugDb();
    const overlapped = await Promise.race([
      closeStarted.promise.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2_500);
        timer.unref();
      }),
    ]);
    assert.strictEqual(overlapped, false);
    assert.strictEqual(databaseCloseStarted, false);

    releaseMaterialization.resolve();
    await Promise.all([active, closing]);
    assert.strictEqual(databaseCloseStarted, true);
    await initLadybugDb(dbPath);
  });

  it("rejects raw CHECKPOINT execution", async () => {
    let queried = false;
    const conn = fakeConnection(async () => {
      queried = true;
      return fakeResult();
    });
    await assert.rejects(execDdl(conn, "  CHECKPOINT;  "), /checkpoint/i);
    await assert.rejects(exec(conn, "checkpoint"), /checkpoint/i);
    assert.strictEqual(queried, false);
  });

  it("keeps a low-threshold WAL until the gated explicit checkpoint", async () => {
    await closeLadybugDb();
    const thresholdBytes = 16 * 1024 * 1024;
    await initLadybugDb(dbPath, { checkpointThresholdBytes: thresholdBytes });
    const rows = Array.from({ length: 18 }, (_, id) => ({
      id: id + 10_000,
      value: randomBytes(1024 * 1024).toString("base64"),
    }));
    await withWriteConn((conn) =>
      exec(
        conn,
        "UNWIND $rows AS row CREATE (n:SnapshotProbe {id: row.id, value: row.value})",
        { rows },
      ),
    );

    const walPath = `${dbPath}.wal`;
    assert.strictEqual(existsSync(walPath), true);
    const beforeCheckpoint = statSync(walPath).size;
    assert.ok(beforeCheckpoint > thresholdBytes, `WAL was ${beforeCheckpoint} bytes`);

    assert.strictEqual(await runWalCheckpoint("low-threshold-proof", 5_000), true);
    const afterCheckpoint = existsSync(walPath) ? statSync(walPath).size : 0;
    assert.ok(afterCheckpoint < beforeCheckpoint);
  });

});
