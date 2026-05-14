import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Connection } from "kuzu";
import {
  _captureCallSiteForTesting,
  isConnStuck,
  queryAll,
  runExclusive,
} from "../../dist/db/ladybug-core.js";
import { getReadPoolHealth } from "../../dist/db/ladybug.js";
import { logger } from "../../dist/util/logger.js";

// These tests verify the per-conn watchdog wiring added in fix #3 and the
// pool-health snapshot used by the watcher in fix #5. The watchdog threshold
// is normally 30s; the SDL_STUCK_TASK_WARN_MS env var lets tests shrink it
// without 30-second sleeps.
const ORIGINAL_THRESHOLD = process.env.SDL_STUCK_TASK_WARN_MS;

function captureFromWatchdogTestHelper(): string | undefined {
  return _captureCallSiteForTesting();
}

describe("ladybug-core: stuck-conn watchdog", () => {
  before(() => {
    process.env.SDL_STUCK_TASK_WARN_MS = "50";
  });

  after(() => {
    if (ORIGINAL_THRESHOLD === undefined) {
      delete process.env.SDL_STUCK_TASK_WARN_MS;
    } else {
      process.env.SDL_STUCK_TASK_WARN_MS = ORIGINAL_THRESHOLD;
    }
  });

  it("flags conn stuck after threshold then clears once task completes", async () => {
    const fakeConn = { _watchdogTest: 1 } as unknown as Connection;
    assert.equal(isConnStuck(fakeConn), false, "fresh conn must not be stuck");

    const taskPromise = runExclusive(
      fakeConn,
      () =>
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(42), 220);
        }),
    );

    // Wait past the 50ms threshold so the watchdog timer fires while the
    // task is still running.
    await new Promise((r) => setTimeout(r, 130));
    assert.equal(
      isConnStuck(fakeConn),
      true,
      "conn must be flagged stuck once watchdog fires",
    );

    const result = await taskPromise;
    assert.equal(result, 42);
    assert.equal(
      isConnStuck(fakeConn),
      false,
      "stuck flag must clear after the task settles",
    );
  });

  it("does not flag conn stuck for fast-completing tasks", async () => {
    const fakeConn = { _watchdogTest: 2 } as unknown as Connection;
    const result = await runExclusive(fakeConn, async () => 7);
    assert.equal(result, 7);
    assert.equal(isConnStuck(fakeConn), false);
  });

  it("captures workspace call sites before framework internals", () => {
    assert.match(
      String(captureFromWatchdogTestHelper()),
      /ladybug-core-watchdog\.test\.ts/,
    );
  });

  it("logs query fingerprint and caller site when a query task is stuck", async () => {
    const fakeResult = {
      getAll: async () => [],
      close: () => undefined,
    };
    const fakeConn = {
      prepare: async () => ({}),
      execute: async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(fakeResult), 140);
        }),
    } as unknown as Connection;

    const originalWarn = logger.warn.bind(logger);
    let captured:
      | { message: string; meta?: Record<string, unknown> }
      | undefined;
    logger.warn = (message: string, meta?: Record<string, unknown>): void => {
      if (message.includes("DB task running")) {
        captured = { message, meta };
      }
      originalWarn(message, meta);
    };
    try {
      await queryAll(fakeConn, "MATCH (n) RETURN n", {});
    } finally {
      logger.warn = originalWarn;
    }

    assert.ok(captured, "watchdog should log a stuck query warning");
    assert.equal(captured.meta?.label, "queryAll");
    assert.match(String(captured.meta?.statementFingerprint), /^[a-f0-9]{16}$/);
    assert.match(
      String(captured.meta?.callSite),
      /ladybug-core-watchdog\.test\.ts/,
    );
  });

  it("clears stuck flag even when task throws after threshold", async () => {
    const fakeConn = { _watchdogTest: 3 } as unknown as Connection;
    let caught: unknown;
    try {
      await runExclusive(fakeConn, async () => {
        await new Promise((r) => setTimeout(r, 120));
        throw new Error("boom");
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error && caught.message === "boom");
    assert.equal(
      isConnStuck(fakeConn),
      false,
      "stuck flag must clear on the error path too",
    );
  });
});

describe("getReadPoolHealth", () => {
  it("returns the documented shape", () => {
    const health = getReadPoolHealth();
    assert.equal(typeof health.total, "number");
    assert.equal(typeof health.stuck, "number");
    assert.equal(typeof health.healthy, "boolean");
    assert.ok(health.total >= 0);
    assert.ok(health.stuck >= 0);
    assert.ok(health.stuck <= health.total);
  });

  it("treats an empty pool as healthy (startup-friendly)", () => {
    const health = getReadPoolHealth();
    if (health.total === 0) {
      assert.equal(
        health.healthy,
        true,
        "empty pool must report healthy so callers don't pre-emptively back off",
      );
    }
  });
});
