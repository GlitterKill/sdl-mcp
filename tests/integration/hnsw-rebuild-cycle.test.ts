import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseError } from "../../dist/domain/errors.js";
import {
  closeLadybugDb,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import { exec, execDdl, querySingle } from "../../dist/db/ladybug-core.js";
import { withPostIndexWriteSession } from "../../dist/db/write-session.js";
import { runHnswRebuildCycle } from "../../dist/indexer/hnsw-rebuild-cycle.js";
import {
  installObservabilityTap,
  resetObservabilityTap,
  type ObservabilityTap,
  type PostIndexSessionTapEvent,
} from "../../dist/observability/event-tap.js";

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

describe("HNSW rebuild lifecycle", () => {
  const dbDir = mkdtempSync(join(tmpdir(), "sdl-hnsw-cycle-"));
  const dbPath = join(dbDir, "cycle.lbug");
  const walPath = dbPath + ".wal";

  before(async () => {
    await initLadybugDb(dbPath);
    await withWriteConn(async (conn) => {
      await execDdl(
        conn,
        "CREATE NODE TABLE HnswCycleProbe (id INT64 PRIMARY KEY, value STRING)",
      );
      await exec(
        conn,
        [
          "UNWIND $rows AS row",
          "CREATE (n:HnswCycleProbe {id: row.id, value: row.value})",
        ].join("\n"),
        {
          rows: Array.from({ length: 64 }, (_, id) => ({
            id,
            value: "seed-" + id + "-" + "x".repeat(512),
          })),
        },
      );
    });
  });

  after(async () => {
    await closeLadybugDb();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("orders successful checkpoints around one non-interleaved rebuild session", async () => {
    const beforePreCheckpoint = statSync(walPath).size;
    assert.ok(beforePreCheckpoint > 0);
    const bodyEntered = deferred();
    const releaseBody = deferred();
    const events: string[] = [];
    let competitorCompleted = false;
    const competitor = (async () => {
      await bodyEntered.promise;
      await withWriteConn(async (conn) => {
        await exec(
          conn,
          "MATCH (n:HnswCycleProbe {id: $id}) SET n.value = $value",
          { id: 63, value: "competitor" },
        );
        events.push("competitor");
        competitorCompleted = true;
      });
    })();

    const result = await runHnswRebuildCycle({
      preCheckpointPhase: "test-hnsw-pre",
      postCheckpointPhase: "test-hnsw-post",
      body: async () => {
        const afterPreCheckpoint = existsSync(walPath) ? statSync(walPath).size : 0;
        assert.ok(afterPreCheckpoint < beforePreCheckpoint);
        events.push("drop");
        bodyEntered.resolve();
        await nextTurn();
        await nextTurn();
        assert.equal(competitorCompleted, false);
        await withWriteConn(async (conn) => {
          await exec(
            conn,
            "MATCH (n:HnswCycleProbe {id: $id}) SET n.value = $value",
            { id: 0, value: "rebuild-write" },
          );
        });
        events.push("write");
        releaseBody.resolve();
        events.push("create");
        return "rebuilt";
      },
      onSuccess: async () => {
        events.push("success");
      },
    });

    await competitor;
    assert.equal(result, "rebuilt");
    assert.deepEqual(events.slice(0, 4), ["drop", "write", "create", "success"]);
    assert.equal(events[4], "competitor");
    const afterPostCheckpoint = existsSync(walPath) ? statSync(walPath).size : 0;
    assert.ok(afterPostCheckpoint < beforePreCheckpoint);
  });

  it("keeps a competitor queued when it arrives during the pre-checkpoint", async () => {
    const checkpointEntered = deferred();
    const releaseCheckpoint = deferred();
    const events: string[] = [];
    let checkpointConn!: import("kuzu").Connection;
    await withWriteConn(async (conn) => {
      checkpointConn = conn;
    });
    const originalQuery = checkpointConn.query.bind(checkpointConn);
    let blockNextCheckpoint = true;

    checkpointConn.query = async function (
      statement,
      progressCallback,
    ) {
      if (blockNextCheckpoint && /^CHECKPOINT\s*;?$/i.test(statement.trim())) {
        blockNextCheckpoint = false;
        checkpointEntered.resolve();
        await releaseCheckpoint.promise;
      }
      return originalQuery(statement, progressCallback);
    };

    try {
      const cycle = runHnswRebuildCycle({
        preCheckpointPhase: "queued-during-pre",
        postCheckpointPhase: "queued-during-post",
        body: async () => {
          events.push("body");
        },
      });
      await checkpointEntered.promise;

      const competitor = withWriteConn(async () => {
        events.push("competitor");
      });
      await nextTurn();
      assert.deepEqual(events, []);

      releaseCheckpoint.resolve();
      await Promise.all([cycle, competitor]);
      assert.deepEqual(events, ["body", "competitor"]);
    } finally {
      releaseCheckpoint.resolve();
      checkpointConn.query = originalQuery;
    }
  });

  it("preserves both rebuild and post-checkpoint failures", async () => {
    let checkpointConn!: import("kuzu").Connection;
    await withWriteConn(async (conn) => {
      checkpointConn = conn;
    });
    const originalQuery = checkpointConn.query.bind(checkpointConn);
    let checkpointCount = 0;

    checkpointConn.query = async function (
      statement,
      progressCallback,
    ) {
      if (/^CHECKPOINT\s*;?$/i.test(statement.trim())) {
        checkpointCount += 1;
        if (checkpointCount === 2) {
          throw new Error("forced post-checkpoint failure");
        }
      }
      return originalQuery(statement, progressCallback);
    };

    try {
      await assert.rejects(
        runHnswRebuildCycle({
          preCheckpointPhase: "aggregate-pre",
          postCheckpointPhase: "aggregate-post",
          body: async () => {
            throw new Error("forced rebuild failure");
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          const messages = error.errors.map((entry) =>
            entry instanceof Error ? entry.message : String(entry),
          );
          assert.ok(messages.some((message) => /forced rebuild failure/.test(message)));
          assert.ok(messages.some((message) => /post-checkpoint/i.test(message)));
          return true;
        },
      );
    } finally {
      checkpointConn.query = originalQuery;
    }
  });

  it("serializes complete checkpoint-rebuild-checkpoint cycles", async () => {
    const firstBodyEntered = deferred();
    const releaseFirstBody = deferred();
    const events: string[] = [];

    const firstCycle = runHnswRebuildCycle({
      preCheckpointPhase: "serialized-first-pre",
      postCheckpointPhase: "serialized-first-post",
      body: async () => {
        events.push("first-body");
        firstBodyEntered.resolve();
        await releaseFirstBody.promise;
      },
    }).then(() => {
      events.push("first-complete");
    });

    await firstBodyEntered.promise;
    const secondCycle = runHnswRebuildCycle({
      preCheckpointPhase: "serialized-second-pre",
      postCheckpointPhase: "serialized-second-post",
      body: async () => {
        events.push("second-body");
      },
    }).then(() => {
      events.push("second-complete");
    });

    await nextTurn();
    assert.deepEqual(events, ["first-body"]);
    releaseFirstBody.resolve();
    await Promise.all([firstCycle, secondCycle]);

    assert.deepEqual(events, [
      "first-body",
      "first-complete",
      "second-body",
      "second-complete",
    ]);
  });

  it("turns a rejected pre-checkpoint into a typed database failure", async () => {
    let bodyRan = false;
    await withPostIndexWriteSession(async () => {
      await assert.rejects(
        runHnswRebuildCycle({
          preCheckpointPhase: "nested-hnsw-pre",
          postCheckpointPhase: "nested-hnsw-post",
          body: async () => {
            bodyRan = true;
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof DatabaseError);
          assert.match(error.message, /Cannot upgrade/i);
          return true;
        },
      );
    });
    assert.equal(bodyRan, false);
  });

  it("forwards explicit repository identity through the rebuild write session", async () => {
    const events: PostIndexSessionTapEvent[] = [];
    installObservabilityTap(new Proxy({} as ObservabilityTap, {
      get: (_target, property) => property === "postIndexSession"
        ? (event: PostIndexSessionTapEvent) => events.push(event)
        : () => {},
    }));
    try {
      await runHnswRebuildCycle({
        preCheckpointPhase: "attributed-hnsw-pre",
        postCheckpointPhase: "attributed-hnsw-post",
        body: async () => undefined,
        repoId: "repo-hnsw",
      });
    } finally {
      resetObservabilityTap();
    }
    assert.deepEqual(events.map(({ repoId }) => repoId), ["repo-hnsw"]);
  });

  it("finishes failure finalization before admission reopens for every cycle phase", async () => {
    for (const phase of ["pre", "body", "post", "success"] as const) {
      let checkpointConn!: import("kuzu").Connection;
      await withWriteConn(async (conn) => {
        checkpointConn = conn;
      });
      const originalQuery = checkpointConn.query.bind(checkpointConn);
      let checkpointCount = 0;
      checkpointConn.query = async function (statement, progressCallback) {
        if (/^CHECKPOINT\s*;?$/i.test(statement.trim())) {
          checkpointCount += 1;
          if (
            (phase === "pre" && checkpointCount === 1) ||
            (phase === "post" && checkpointCount === 2)
          ) {
            throw new Error(`forced ${phase} failure`);
          }
        }
        return originalQuery(statement, progressCallback);
      };

      const failureEntered = deferred();
      const releaseFailure = deferred();
      const events: string[] = [];
      let competitorCompleted = false;
      try {
        const cycle = runHnswRebuildCycle({
          preCheckpointPhase: `failure-${phase}-pre`,
          postCheckpointPhase: `failure-${phase}-post`,
          body: async () => {
            events.push("body");
            if (phase === "body") throw new Error("forced body failure");
          },
          onSuccess: async () => {
            events.push("success");
            if (phase === "success") throw new Error("forced success failure");
          },
          onFailureInsideGate: async (error) => {
            assert.ok(error instanceof Error || error instanceof AggregateError);
            events.push("failure-start");
            failureEntered.resolve();
            await releaseFailure.promise;
            events.push("failure-end");
          },
        });
        const rejected = assert.rejects(cycle, /failure/i);
        await failureEntered.promise;

        const competitor = withWriteConn(async () => {
          events.push("competitor");
          competitorCompleted = true;
        });
        await nextTurn();
        await nextTurn();
        assert.equal(
          competitorCompleted,
          false,
          `${phase} failure reopened admission before its finalizer finished`,
        );

        releaseFailure.resolve();
        await rejected;
        await competitor;
        assert.deepEqual(events.slice(-3), [
          "failure-start",
          "failure-end",
          "competitor",
        ]);
      } finally {
        releaseFailure.resolve();
        checkpointConn.query = originalQuery;
      }
    }
  });

  it("persists rebuild state after the post-checkpoint and before admission reopens", async () => {
    const successEntered = deferred();
    const releaseSuccess = deferred();
    const events: string[] = [];
    let checkpointConn!: import("kuzu").Connection;
    await withWriteConn(async (conn) => {
      checkpointConn = conn;
    });
    const originalQuery = checkpointConn.query.bind(checkpointConn);
    let checkpointCount = 0;

    checkpointConn.query = async function (statement, progressCallback) {
      if (/^CHECKPOINT\s*;?$/i.test(statement.trim())) {
        checkpointCount += 1;
        events.push(`checkpoint:${checkpointCount}:start`);
        const result = await originalQuery(statement, progressCallback);
        events.push(`checkpoint:${checkpointCount}:end`);
        return result;
      }
      return originalQuery(statement, progressCallback);
    };

    try {
      const cycle = runHnswRebuildCycle({
        preCheckpointPhase: "durable-order-pre",
        postCheckpointPhase: "durable-order-post",
        body: async () => {
          await withWriteConn(async (conn) => {
            await exec(
              conn,
              "MATCH (n:HnswCycleProbe {id: $id}) SET n.value = $value",
              { id: 1, value: "durable-after-post-checkpoint" },
            );
          });
          events.push("body:write");
        },
        onSuccess: async () => {
          events.push("gate:success");
          successEntered.resolve();
          await releaseSuccess.promise;
        },
      });

      await successEntered.promise;
      assert.deepEqual(events, [
        "checkpoint:1:start",
        "checkpoint:1:end",
        "body:write",
        "checkpoint:2:start",
        "checkpoint:2:end",
        "gate:success",
      ]);

      let competitorCompleted = false;
      const competitor = withWriteConn(async () => {
        competitorCompleted = true;
        events.push("competitor");
      });
      await nextTurn();
      await nextTurn();
      assert.equal(competitorCompleted, false);

      releaseSuccess.resolve();
      await Promise.all([cycle, competitor]);
      assert.equal(checkpointCount, 2);
      assert.equal(events.at(-1), "competitor");
    } finally {
      releaseSuccess.resolve();
      checkpointConn.query = originalQuery;
    }

    await closeLadybugDb({ strict: true });
    await initLadybugDb(dbPath);
    const reopened = await withWriteConn((conn) =>
      querySingle<{ value: string }>(
        conn,
        "MATCH (n:HnswCycleProbe {id: $id}) RETURN n.value AS value",
        { id: 1 },
      ),
    );
    assert.equal(reopened?.value, "durable-after-post-checkpoint");
  });

});
