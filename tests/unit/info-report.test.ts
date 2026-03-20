import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  collectInfoReport,
} from "../../src/info/report.js";
import {
  disableFileLogging,
  enableFileLogging,
  setConsoleMirroring,
} from "../../src/util/logger.js";

describe("collectInfoReport", () => {
  afterEach(() => {
    disableFileLogging();
    setConsoleMirroring(false);
    delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
  });

  it("reports version, config path, log path, Ladybug, and native status", async () => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    const tempDir = mkdtempSync(join(tmpdir(), "sdl-info-"));
    const configPath = join(tempDir, "sdlmcp.config.json");
    const logPath = join(tempDir, "sdl-mcp.log");

    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [],
        policy: {},
      }),
      "utf-8",
    );
    enableFileLogging(logPath);
    setConsoleMirroring(true);

    const report = await collectInfoReport({ config: configPath });

    assert.ok(report.version.length > 0);
    assert.strictEqual(report.config.path, configPath);
    assert.strictEqual(report.config.exists, true);
    assert.strictEqual(report.logging.path, logPath);
    assert.strictEqual(report.logging.consoleMirroring, true);
    assert.strictEqual(typeof report.ladybug.available, "boolean");
    assert.strictEqual(typeof report.config.loaded, "boolean");
    assert.strictEqual(report.native.available, false);
    assert.strictEqual(report.native.disabledByEnv, true);
    assert.match(report.native.reason, /disabled/i);
  });
});
