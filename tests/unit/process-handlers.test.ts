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
});
