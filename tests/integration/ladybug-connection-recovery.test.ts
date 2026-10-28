import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

import { getExtensionCapabilities } from "../../dist/db/extension-caps.js";
import {
  closeLadybugDb,
  getLadybugReadConn,
  getReadPool,
  initLadybugDb,
  recycleReadConnection,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import { exec } from "../../dist/db/ladybug-core.js";
import {
  withExclusiveLadybugOperation,
  withSharedLadybugOperation,
} from "../../dist/db/ladybug-operation-gate.js";

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

type PromiseSettlement<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "timeout" };

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<PromiseSettlement<T>> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then<PromiseSettlement<T>>(
        (value) => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason }),
      ),
      new Promise<PromiseSettlement<T>>((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve({ status: "timeout" }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

const require = createRequire(import.meta.url);
const { Connection: KuzuConnection } = require("kuzu") as typeof import("kuzu");
const originalQuery = KuzuConnection.prototype.query;
const extensionStatements: string[] = [];
let initializedCapabilities: ReturnType<typeof getExtensionCapabilities>;

describe("Ladybug connection recovery", { timeout: 15_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "sdl-connection-recovery-"));
  const dbPath = join(root, "recovery.lbug");

  before(async () => {
    KuzuConnection.prototype.query = async function (
      statement,
      progressCallback,
    ) {
      if (/^(?:INSTALL|LOAD EXTENSION)\b/i.test(statement.trim())) {
        extensionStatements.push(statement);
        return {
          hasNext: () => false,
          getNext: async () => ({}),
          getAll: async () => [],
          close: () => {},
        };
      }
      return originalQuery.call(this, statement, progressCallback);
    };
    await initLadybugDb(dbPath);
    const firstReadConn = await getLadybugReadConn();
    assert.equal(
      Object.getPrototypeOf(firstReadConn),
      KuzuConnection.prototype,
    );
    assert.ok(extensionStatements.length > 0);
    initializedCapabilities = getExtensionCapabilities();
  });

  after(async () => {
    try {
      await closeLadybugDb();
    } finally {
      KuzuConnection.prototype.query = originalQuery;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces a poisoned writer only after extension reload completes", async () => {
    const beforeCapabilities = getExtensionCapabilities();
    assert.deepEqual(beforeCapabilities, initializedCapabilities);

    await assert.rejects(
      withWriteConn(async (conn) => {
        await conn.close();
        throw new Error("forced write failure");
      }),
      /forced write failure/,
    );

    assert.deepEqual(getExtensionCapabilities(), beforeCapabilities);
    await withWriteConn((conn) => exec(conn, "RETURN 1"));
  });

  it("does not await fresh-exclusive writer recovery inside an outer shared root", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const outcome = await withSharedLadybugOperation(async () => {
        const failedWrite = withWriteConn(async (conn) => {
          await conn.close();
          throw new Error("nested write failure");
        });
        return await settleWithin(failedWrite, 50);
      });

      await withWriteConn((conn) => exec(conn, "RETURN 1"));
      if (outcome.status !== "rejected") {
        assert.fail(`nested write should reject promptly, got ${outcome.status}`);
      }
      assert.match(
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason),
        /nested write failure/,
      );
      await nextTurn();
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps read replacement close and publication exclusively admitted", async () => {
    const beforeCapabilities = getExtensionCapabilities();
    assert.deepEqual(beforeCapabilities, initializedCapabilities);
    const unhealthy = await getLadybugReadConn();
    const closeEntered = deferred();
    const releaseClose = deferred();
    const originalClose = unhealthy.close.bind(unhealthy);
    let sharedEntered = false;

    unhealthy.close = async () => {
      closeEntered.resolve();
      await releaseClose.promise;
      await originalClose();
    };

    const recycling = recycleReadConnection(unhealthy);
    await closeEntered.promise;
    const shared = withSharedLadybugOperation(async () => {
      sharedEntered = true;
    });
    await nextTurn();
    assert.equal(sharedEntered, false);

    releaseClose.resolve();
    await Promise.all([recycling, shared]);
    assert.equal(getReadPool().includes(unhealthy), false);
    assert.deepEqual(getExtensionCapabilities(), beforeCapabilities);
  });

  it("reuses an outer exclusive admission for read recovery", async () => {
    const beforeCapabilities = getExtensionCapabilities();
    const unhealthy = await getLadybugReadConn();
    const originalClose = unhealthy.close.bind(unhealthy);
    const events: string[] = [];
    const closeEntered = deferred();
    let recycling!: Promise<void>;

    unhealthy.close = async () => {
      events.push("connection-close");
      closeEntered.resolve();
      // Admission must be prompt even when native connection close is slow.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await originalClose();
    };

    const outcome = await withExclusiveLadybugOperation(async () => {
      events.push("exclusive-enter");
      recycling = recycleReadConnection(unhealthy);
      // Observe recovery admission before native close and extension reload.
      const admission = await settleWithin(closeEntered.promise, 1_000);
      if (admission.status === "fulfilled") {
        await recycling;
      }
      events.push(`recycle-${admission.status}`);
      return admission;
    });

    await recycling;
    if (outcome.status !== "fulfilled") {
      assert.fail(`exclusive recovery should enter promptly, got ${outcome.status}`);
    }
    assert.deepEqual(events, [
      "exclusive-enter",
      "connection-close",
      "recycle-fulfilled",
    ]);
    assert.equal(getReadPool().includes(unhealthy), false);
    assert.deepEqual(getExtensionCapabilities(), beforeCapabilities);
  });

  it("keeps detached outer-exclusive read recovery admitted until settlement", async () => {
    const beforeCapabilities = getExtensionCapabilities();
    const unhealthy = await getLadybugReadConn();
    const closeEntered = deferred();
    const releaseClose = deferred();
    const originalClose = unhealthy.close.bind(unhealthy);
    let outerExclusive: Promise<void> | undefined;
    let recycling: Promise<void> | undefined;
    let laterShared: Promise<void> | undefined;
    let sharedEntered = false;

    unhealthy.close = async () => {
      closeEntered.resolve();
      await releaseClose.promise;
      await originalClose();
    };

    try {
      outerExclusive = withExclusiveLadybugOperation(async () => {
        recycling = recycleReadConnection(unhealthy);
      });
      await closeEntered.promise;

      laterShared = withSharedLadybugOperation(async () => {
        sharedEntered = true;
      });
      await nextTurn();
      assert.equal(sharedEntered, false);

      releaseClose.resolve();
      await Promise.all([outerExclusive, recycling, laterShared]);
      assert.equal(getReadPool().includes(unhealthy), false);
      assert.deepEqual(getExtensionCapabilities(), beforeCapabilities);
    } finally {
      releaseClose.resolve();
      await Promise.allSettled(
        [outerExclusive, recycling, laterShared].filter(
          (promise): promise is Promise<void> => promise !== undefined,
        ),
      );
    }
  });

  it("does not await read recovery inside an outer shared root", async () => {
    const beforeCapabilities = getExtensionCapabilities();
    const unhealthy = await getLadybugReadConn();
    const closeEntered = deferred();
    const releaseClose = deferred();
    const originalClose = unhealthy.close.bind(unhealthy);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    let laterShared: Promise<void> | undefined;

    unhealthy.close = async () => {
      closeEntered.resolve();
      await releaseClose.promise;
      await originalClose();
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const outcome = await withSharedLadybugOperation(async () => {
        const recycling = recycleReadConnection(unhealthy);
        return await settleWithin(recycling, 50);
      });

      await closeEntered.promise;
      let laterSharedEntered = false;
      laterShared = withSharedLadybugOperation(async () => {
        laterSharedEntered = true;
      });
      await nextTurn();
      assert.equal(laterSharedEntered, false);

      releaseClose.resolve();
      await laterShared;
      if (outcome.status !== "rejected") {
        assert.fail(`read recycle should reject promptly, got ${outcome.status}`);
      }
      assert.match(
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason),
        /recovery is pending|shared operation.*unwind/i,
      );
      assert.equal(getReadPool().includes(unhealthy), false);
      assert.deepEqual(getExtensionCapabilities(), beforeCapabilities);
      await nextTurn();
      assert.deepEqual(unhandled, []);
    } finally {
      releaseClose.resolve();
      if (laterShared) await Promise.allSettled([laterShared]);
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
