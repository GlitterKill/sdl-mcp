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

  it("does not let stderr EPIPE abort shutdown logging", async () => {
    const originalExit = process.exit;
    const originalWrite = process.stderr.write;
    let exitCode: number | undefined;
    process.exit = ((code?: string | number | null | undefined): never => {
      exitCode = typeof code === "number" ? code : Number(code ?? 0);
      return undefined as never;
    }) as NodeJS.Process["exit"];
    process.stderr.write = (() => {
      const err = new Error("broken pipe") as NodeJS.ErrnoException;
      err.code = "EPIPE";
      throw err;
    }) as typeof process.stderr.write;

    try {
      const mgr = new ShutdownManager({ forceTimeoutMs: 10_000 });

      await assert.doesNotReject(() => mgr.shutdown("test"));

      assert.strictEqual(exitCode, 0);
    } finally {
      process.stderr.write = originalWrite;
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

  it("registers DB cleanup before opening LadybugDB", () => {
    const source = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");
    const initIndex = source.indexOf("await initGraphDb(");
    const cleanupIndex = source.indexOf(
      'shutdownMgr.addCleanup("db", closeLadybugDbAfterDrainingWork)',
    );
    const signalsIndex = source.indexOf("shutdownMgr.registerSignals()");
    const stdinIndex = source.indexOf("shutdownMgr.monitorStdin()");

    assert.ok(cleanupIndex >= 0, "main.ts should register DB cleanup");
    assert.ok(signalsIndex >= 0, "main.ts should register signal handlers");
    assert.ok(stdinIndex >= 0, "main.ts should monitor stdin");
    assert.ok(cleanupIndex < initIndex, "DB cleanup must precede DB init");
    assert.ok(signalsIndex < initIndex, "signals must precede DB init");
    assert.ok(stdinIndex < initIndex, "stdin monitoring must precede DB init");
  });

  it("cancels graph verification before DB cleanup", () => {
    const source = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");
    const verifierCleanup = source.indexOf(
      'shutdownMgr.addCleanup("graphIntegrityVerifier"',
    );
    const dbCleanup = source.indexOf(
      'shutdownMgr.addCleanup("db", closeLadybugDbAfterDrainingWork)',
    );

    assert.ok(verifierCleanup >= 0, "main.ts should register verifier cleanup");
    assert.ok(verifierCleanup < dbCleanup, "verifier cleanup must run before DB cleanup");
    assert.match(source, /await stopGraphIntegrityVerifierRecovery\(\)/);
  });

  it("closes LadybugDB when startup fails after DB init", () => {
    const source = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");
    const closeIndex = source.indexOf("await closeDbAfterStartupFailure()");
    const exitIndex = source.indexOf("process.exit(1)", closeIndex);

    assert.ok(closeIndex >= 0, "startup catch should close DB");
    assert.ok(closeIndex < exitIndex, "DB close must happen before exit");
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

  it("installs process handlers before first startup stderr write", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );
    const installIndex = source.indexOf("installProcessHandlers(shutdownMgr)");
    const firstConfigLogIndex = source.indexOf(
      'writeServeStderrLine(`[sdl-mcp] Config:',
    );

    assert.ok(installIndex >= 0, "serve.ts should install process handlers");
    assert.ok(firstConfigLogIndex >= 0, "serve.ts should log config source");
    assert.ok(
      installIndex < firstConfigLogIndex,
      "stdio pipe errors must be handled before startup writes to stderr",
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

  it("registers stdio shutdown before opening LadybugDB", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );
    const initIndex = source.indexOf("await initGraphDb(");
    const cleanupIndex = source.indexOf(
      'shutdownMgr.addCleanup("db", closeLadybugDbAfterDrainingWork)',
    );
    const signalsIndex = source.indexOf("shutdownMgr.registerSignals()");
    const stdinIndex = source.indexOf("shutdownMgr.monitorStdin()");

    assert.ok(cleanupIndex >= 0, "serve.ts should register DB cleanup");
    assert.ok(signalsIndex >= 0, "serve.ts should register signal handlers");
    assert.ok(stdinIndex >= 0, "serve.ts should monitor stdin");
    assert.ok(cleanupIndex < initIndex, "DB cleanup must precede DB init");
    assert.ok(signalsIndex < initIndex, "signals must precede DB init");
    assert.ok(stdinIndex < initIndex, "stdin monitoring must precede DB init");
  });

  it("cancels graph verification before serve DB cleanup", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );
    const verifierCleanup = source.indexOf(
      'shutdownMgr.addCleanup("graphIntegrityVerifier"',
    );
    const dbCleanup = source.indexOf(
      'shutdownMgr.addCleanup("db", closeLadybugDbAfterDrainingWork)',
    );

    assert.ok(verifierCleanup >= 0, "serve.ts should register verifier cleanup");
    assert.ok(verifierCleanup < dbCleanup, "verifier cleanup must run before DB cleanup");
    assert.match(source, /await stopGraphIntegrityVerifierRecovery\(\)/);
  });

  it("checks for early stdio shutdown before opening LadybugDB", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );
    const pidfileIndex = source.indexOf("shutdownMgr.setPidfilePath(pidfilePath)");
    const earlyShutdownIndex = source.indexOf("shutdownMgr.isShuttingDown", pidfileIndex);
    const initIndex = source.indexOf("await initGraphDb(");

    assert.ok(pidfileIndex >= 0, "serve.ts should register pidfile");
    assert.ok(
      earlyShutdownIndex >= 0,
      "serve.ts should check for early shutdown",
    );
    assert.ok(
      pidfileIndex < earlyShutdownIndex && earlyShutdownIndex < initIndex,
      "early stdio shutdown check must happen after pidfile registration and before DB init",
    );
  });

  it("closes LadybugDB when serve startup fails after DB init", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );
    const closeIndex = source.indexOf("await closeDbAfterStartupFailure()");
    const exitIndex = source.indexOf("process.exit(1)", closeIndex);

    assert.ok(closeIndex >= 0, "startup catch should close DB");
    assert.ok(closeIndex < exitIndex, "DB close must happen before exit");
  });

  it("wraps serve DB init in the startup cleanup catch", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "serve.ts"),
      "utf8",
    );
    const pidfileIndex = source.indexOf("shutdownMgr.setPidfilePath(pidfilePath)");
    const tryIndex = source.indexOf("try {", pidfileIndex);
    const initIndex = source.indexOf("await initGraphDb(");
    const closeIndex = source.indexOf("await closeDbAfterStartupFailure()");

    assert.ok(pidfileIndex >= 0, "serve.ts should register pidfile");
    assert.ok(tryIndex >= 0, "serve.ts should have startup try/catch");
    assert.ok(initIndex >= 0, "serve.ts should initialize DB");
    assert.ok(closeIndex >= 0, "serve.ts should close DB in catch");
    assert.ok(
      tryIndex < initIndex && initIndex < closeIndex,
      "DB init must be inside the startup cleanup catch",
    );
  });
});
