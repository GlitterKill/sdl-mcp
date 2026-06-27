import { describe, it } from "node:test";
import assert from "node:assert";

const { installProcessHandlers } = await import(
  "../../dist/startup/process-handlers.js"
);

describe("process handler installer", () => {
  it("is idempotent and unregisters only its own listeners", () => {
    const beforeException = process.listenerCount("uncaughtException");
    const beforeRejection = process.listenerCount("unhandledRejection");
    const shutdownMgr = {
      shutdown: async () => {},
    };

    const uninstall = installProcessHandlers(shutdownMgr);
    const uninstallAgain = installProcessHandlers(shutdownMgr);

    assert.strictEqual(
      process.listenerCount("uncaughtException"),
      beforeException + 1,
    );
    assert.strictEqual(
      process.listenerCount("unhandledRejection"),
      beforeRejection + 1,
    );

    uninstallAgain();
    assert.strictEqual(
      process.listenerCount("uncaughtException"),
      beforeException + 1,
    );

    uninstall();
    assert.strictEqual(
      process.listenerCount("uncaughtException"),
      beforeException,
    );
    assert.strictEqual(
      process.listenerCount("unhandledRejection"),
      beforeRejection,
    );
  });

  it("turns stdio EPIPE into managed shutdown", async () => {
    const calls: Array<{ reason: string; code?: number }> = [];
    const shutdownMgr = {
      shutdown: async (reason: string, code?: number) => {
        calls.push({ reason, code });
      },
    };

    const uninstall = installProcessHandlers(shutdownMgr);
    try {
      const err = new Error("broken pipe") as NodeJS.ErrnoException;
      err.code = "EPIPE";

      assert.doesNotThrow(() => {
        process.stdout.emit("error", err);
      });

      await new Promise((resolve) => setImmediate(resolve));

      assert.deepStrictEqual(calls, [
        { reason: "stdio pipe error", code: 1 },
      ]);
    } finally {
      uninstall();
    }
  });
});
