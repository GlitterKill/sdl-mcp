import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ShutdownManager } from "../../src/util/shutdown.js";

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
