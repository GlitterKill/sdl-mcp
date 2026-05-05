import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("main stdio shutdown wiring", () => {
  it("unrefs cleanup interval so it cannot keep process alive", () => {
    const source = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");

    assert.match(
      source,
      /cleanupInterval\.unref\(\);/,
      "cleanup interval should be unref'd",
    );
  });

  it("uses ShutdownManager to handle stdio transport close for graceful shutdown", () => {
    const source = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");

    // Direct stdio owns stdin through StdioServerTransport, so main.ts should
    // shut down from the MCP transport close callback rather than also
    // registering raw stdin listeners.
    assert.match(
      source,
      /server\.getServer\(\)\.onclose\s*=/,
      "main.ts should register a transport-close shutdown callback",
    );
    assert.match(
      source,
      /shutdownMgr\.shutdown\("transport closed"\)/,
      "main.ts should use ShutdownManager when the transport closes",
    );
  });

  it("ShutdownManager.monitorStdin registers stdin end/close handlers", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "util", "shutdown.ts"),
      "utf8",
    );

    assert.match(
      source,
      /process\.stdin\.once\("end",/,
      "ShutdownManager.monitorStdin must register stdin 'end' handler",
    );
    assert.match(
      source,
      /process\.stdin\.once\("close",/,
      "ShutdownManager.monitorStdin must register stdin 'close' handler",
    );
  });

  it("registers SIGHUP for terminal close detection", () => {
    const source = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");

    assert.match(
      source,
      /registerSignals/,
      "main.ts should call shutdownMgr.registerSignals()",
    );

    const shutdownSource = readFileSync(
      join(process.cwd(), "src", "util", "shutdown.ts"),
      "utf8",
    );
    assert.match(
      shutdownSource,
      /process\.once\("SIGHUP"/,
      "ShutdownManager should handle SIGHUP",
    );
  });
});
