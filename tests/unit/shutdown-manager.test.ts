import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DB_SHUTDOWN_DRAIN_TIMEOUT_MS,
  SHUTDOWN_FORCE_EXIT_TIMEOUT_MS,
} from "../../dist/config/constants.js";
import { ShutdownManager } from "../../dist/util/shutdown.js";

describe("ShutdownManager", () => {
  it("starts with isShuttingDown = false", () => {
    const mgr = new ShutdownManager();
    assert.strictEqual(mgr.isShuttingDown, false);
  });

  it("addCleanup does not throw", () => {
    const mgr = new ShutdownManager();
    assert.doesNotThrow(() => {
      mgr.addCleanup("test", () => {});
    });
  });

  it("setPidfilePath does not throw", () => {
    const mgr = new ShutdownManager();
    assert.doesNotThrow(() => {
      mgr.setPidfilePath("/tmp/test.pid");
    });
  });
});

describe("main.ts shutdown wiring", () => {
  it("uses ShutdownManager for signal handling", () => {
    const source = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");

    assert.match(
      source,
      /ShutdownManager/,
      "main.ts should use ShutdownManager",
    );
  });

  it("registers SIGHUP via ShutdownManager.registerSignals()", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "util", "shutdown.ts"),
      "utf8",
    );

    assert.match(
      source,
      /process\.once\("SIGHUP"/,
      "ShutdownManager should register SIGHUP handler",
    );
  });

  it("has a forced exit timeout safety net", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "util", "shutdown.ts"),
      "utf8",
    );

    assert.match(
      source,
      /forceTimer/,
      "ShutdownManager should have a forced exit timeout",
    );
  });

  it("keeps force-exit timeout above LadybugDB shutdown drain budget", () => {
    assert.ok(
      SHUTDOWN_FORCE_EXIT_TIMEOUT_MS >= DB_SHUTDOWN_DRAIN_TIMEOUT_MS * 8,
      "outer shutdown watchdog must leave headroom for audit flushes, write/read drains, connection close, and final checkpoint",
    );
  });

  it("logs the active cleanup name when the force timer fires", async () => {
    const logs: string[] = [];
    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code?: string | number | null | undefined): never => {
      exitCode = typeof code === "number" ? code : Number(code ?? 0);
      return undefined as never;
    }) as NodeJS.Process["exit"];

    try {
      const mgr = new ShutdownManager({
        forceTimeoutMs: 5,
        log: (msg) => logs.push(msg),
      });
      mgr.addCleanup("db", () => new Promise(() => {}));
      void mgr.shutdown("test");

      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          reject(new Error("force timer did not fire"));
        }, 100);
        const poll = (): void => {
          if (exitCode !== undefined) {
            clearTimeout(deadline);
            resolve();
            return;
          }
          setTimeout(poll, 1);
        };
        poll();
      });

      assert.strictEqual(exitCode, 1);
      assert.ok(
        logs.some((line) =>
          line.includes(
            'Cleanup did not finish within 5ms while running cleanup "db"',
          ),
        ),
        `expected force-exit log to include active cleanup name, got: ${logs.join(" | ")}`,
      );
    } finally {
      process.exit = originalExit;
    }
  });

  it("logs slow cleanup durations", async () => {
    const logs: string[] = [];
    const originalExit = process.exit;
    const originalNow = Date.now;
    const times = [1_000, 2_250];
    process.exit = (() => undefined as never) as NodeJS.Process["exit"];
    Date.now = () => times.shift() ?? 2_250;

    try {
      const mgr = new ShutdownManager({
        forceTimeoutMs: 10_000,
        log: (msg) => logs.push(msg),
      });
      mgr.addCleanup("db", () => {});

      await mgr.shutdown("test");

      assert.ok(
        logs.includes('Cleanup "db" completed in 1250ms'),
        `expected slow cleanup duration log, got: ${logs.join(" | ")}`,
      );
    } finally {
      Date.now = originalNow;
      process.exit = originalExit;
    }
  });

  it("unrefs the force timer so it does not keep the process alive", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "util", "shutdown.ts"),
      "utf8",
    );

    assert.match(
      source,
      /forceTimer\.unref\(\)/,
      "Force timer should be unref'd",
    );
  });

  it("writes and removes PID file on startup/shutdown", () => {
    const source = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");

    assert.match(source, /writePidfile/, "main.ts should write PID file");
    assert.match(
      source,
      /setPidfilePath/,
      "main.ts should register PID file path with shutdown manager",
    );
  });

  it("checks for existing process on startup", () => {
    const source = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");

    assert.match(
      source,
      /findExistingProcess/,
      "main.ts should check for existing process",
    );
  });

  it("monitors stdin for graceful shutdown on terminal close", () => {
    const source = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");

    assert.match(
      source,
      /monitorStdin/,
      "main.ts should monitor stdin for terminal close",
    );
  });

  it("unrefs cleanup interval so it cannot keep process alive", () => {
    const source = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");

    assert.match(
      source,
      /cleanupInterval\.unref\(\);/,
      "cleanup interval should be unref'd",
    );
  });
});

describe("serve.ts shutdown wiring", () => {
  it("uses ShutdownManager", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );

    assert.match(
      source,
      /ShutdownManager/,
      "serve.ts should use ShutdownManager",
    );
  });

  it("writes PID file with transport info", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );

    assert.match(source, /writePidfile/, "serve.ts should write PID file");
  });

  it("checks for existing process before starting", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );

    assert.match(
      source,
      /findExistingProcess/,
      "serve.ts should check for existing process",
    );
  });

  it("gates stdin monitoring on stdio transport only", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );

    // monitorStdin should be inside an if block for stdio transport
    const stdioBlock = source.match(
      /if\s*\(options\.transport\s*===\s*["']stdio["']\)\s*\{[^}]*monitorStdin/s,
    );

    assert.ok(
      stdioBlock,
      "stdin monitoring must be gated on options.transport === 'stdio'",
    );
  });
});
