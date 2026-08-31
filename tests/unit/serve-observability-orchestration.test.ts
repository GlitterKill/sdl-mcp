import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activateObservabilityAfterStart,
  registerServeFinalCleanups,
} from "../../dist/cli/commands/serve.js";
import { ShutdownManager } from "../../dist/util/shutdown.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("serve observability orchestration", () => {
  it("does not activate runtime surfaces when shutdown starts during service start", async () => {
    const starting = deferred();
    const shutdownComplete = deferred();
    const state = {
      isShuttingDown: false,
      shutdownComplete: shutdownComplete.promise,
    };
    let activated = false;
    let settled = false;
    let closed = 0;
    let timers = 1;
    let serviceRef: { stop: () => Promise<void> } | null = null;
    let cleanupPromise: Promise<void> | null = null;
    const stopObservability = (): Promise<void> => {
      if (serviceRef === null) return Promise.resolve();
      cleanupPromise ??= serviceRef.stop();
      return cleanupPromise;
    };
    await stopObservability();
    const service = {
      start: () => starting.promise,
      stop: async () => {
        closed += 1;
        timers = 0;
      },
    };
    serviceRef = service;
    const activation = activateObservabilityAfterStart(
      service,
      state,
      () => {
        activated = true;
      },
    ).then((result) => {
      settled = true;
      return result;
    });

    state.isShuttingDown = true;
    starting.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(activated, false);
    assert.equal(settled, false);
    assert.equal(closed, 1);
    assert.equal(timers, 0);

    shutdownComplete.resolve();
    assert.equal(await activation, false);
    assert.equal(activated, false);
    assert.equal(closed, 1);
    assert.equal(timers, 0);
  });

  it("retries a failed drain before checkpoint and still closes after stop rejection", async () => {
    const order: string[] = [];
    const logs: string[] = [];
    let drainAttempts = 0;
    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: string | number | null | undefined): never => {
      exitCode = typeof code === "number" ? code : Number(code ?? 0);
      return undefined as never;
    }) as NodeJS.Process["exit"];
    try {
      const manager = new ShutdownManager({
        forceTimeoutMs: 10_000,
        log: (message) => logs.push(message),
      });
      registerServeFinalCleanups(manager, {
        drainWork: async () => {
          drainAttempts += 1;
          order.push(`drain-${drainAttempts}`);
          if (drainAttempts === 1) throw new Error("drain failed");
        },
        persistUsage: async () => {},
        stopObservability: async () => {
          order.push("checkpoint");
          throw new Error("checkpoint failed");
        },
        closeDatabase: async () => {
          order.push("db");
        },
      });
      manager.addCleanup("logger", () => {
        order.push("logger");
      });

      await manager.shutdown("test", 1);

      assert.deepEqual(order, [
        "drain-1",
        "drain-2",
        "checkpoint",
        "db",
        "logger",
      ]);
      assert.equal(exitCode, 1);
      assert.ok(logs.some((line) => line.includes('Cleanup "workDrain" error')));
      assert.ok(logs.some((line) => line.includes('Cleanup "db" error')));
    } finally {
      process.exit = originalExit;
    }
  });

  it("does not hide a successful third drain inside database close", async () => {
    let checkpoints = 0;
    let drainAttempts = 0;
    let physicalCloses = 0;
    let loggerClosed = false;
    const originalExit = process.exit;
    process.exit = (() => undefined as never) as NodeJS.Process["exit"];
    try {
      const manager = new ShutdownManager({
        forceTimeoutMs: 10_000,
        log: () => {},
      });
      registerServeFinalCleanups(manager, {
        drainWork: async () => {
          drainAttempts += 1;
          throw new Error("still active");
        },
        persistUsage: async () => {},
        stopObservability: async () => {
          checkpoints += 1;
        },
        closeDatabase: async () => {
          drainAttempts += 1;
          assert.equal(drainAttempts, 3);
          physicalCloses += 1;
        },
      });
      manager.addCleanup("logger", () => {
        loggerClosed = true;
      });

      await manager.shutdown("test");

      assert.equal(checkpoints, 0);
      assert.equal(drainAttempts, 2);
      assert.equal(physicalCloses, 0);
      assert.equal(loggerClosed, true);
    } finally {
      process.exit = originalExit;
    }
  });

  it("does not invoke database close after three modeled drain failures", async () => {
    let drainAttempts = 0;
    let checkpoints = 0;
    let closeAttempts = 0;
    const originalExit = process.exit;
    process.exit = (() => undefined as never) as NodeJS.Process["exit"];
    try {
      const manager = new ShutdownManager({
        forceTimeoutMs: 10_000,
        log: () => {},
      });
      registerServeFinalCleanups(manager, {
        drainWork: async () => {
          drainAttempts += 1;
          throw new Error("still active");
        },
        persistUsage: async () => {},
        stopObservability: async () => {
          checkpoints += 1;
        },
        closeDatabase: async () => {
          closeAttempts += 1;
          throw new Error("third drain still active");
        },
      });

      await manager.shutdown("test");

      assert.equal(drainAttempts, 2);
      assert.equal(checkpoints, 0);
      assert.equal(closeAttempts, 0);
    } finally {
      process.exit = originalExit;
    }
  });

  it("drains accepted work before persisting usage and closing the database", async () => {
    const order: string[] = [];
    const originalExit = process.exit;
    process.exit = (() => undefined as never) as NodeJS.Process["exit"];
    try {
      const manager = new ShutdownManager({
        forceTimeoutMs: 10_000,
        log: () => {},
      });
      registerServeFinalCleanups(manager, {
        drainWork: async () => {
          order.push("drain");
        },
        persistUsage: async () => {
          order.push("usage");
        },
        stopObservability: async () => {
          order.push("checkpoint");
        },
        closeDatabase: async () => {
          order.push("db");
        },
      });

      await manager.shutdown("test");

      assert.deepEqual(order, ["drain", "usage", "checkpoint", "db"]);
    } finally {
      process.exit = originalExit;
    }
  });
});
