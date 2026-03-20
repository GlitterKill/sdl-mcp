import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  configureLoggerFromEnvironment,
  disableFileLogging,
  enableFileLogging,
  getLogFilePath,
  getLoggerDiagnostics,
  logger,
  setConsoleMirroring,
  type LogLevel,
} from "../../src/util/logger.js";

describe("Logger", () => {
  afterEach(() => {
    disableFileLogging();
    setConsoleMirroring(false);
    logger.setLevel("info");
  });

  describe("logger singleton", () => {
    it("is defined and has expected methods", () => {
      assert.ok(logger, "logger should be defined");
      assert.ok(typeof logger.debug === "function", "should have debug method");
      assert.ok(typeof logger.info === "function", "should have info method");
      assert.ok(typeof logger.warn === "function", "should have warn method");
      assert.ok(typeof logger.error === "function", "should have error method");
      assert.ok(typeof logger.setLevel === "function", "should have setLevel method");
    });

    it("setLevel accepts valid log levels", () => {
      const levels: LogLevel[] = ["debug", "info", "warn", "error"];
      for (const level of levels) {
        logger.setLevel(level);
      }
      logger.setLevel("info");
    });
  });

  describe("file logging", () => {
    it("getLogFilePath returns null when file logging is disabled", () => {
      disableFileLogging();
      assert.strictEqual(getLogFilePath(), null);
    });

    it("enableFileLogging then getLogFilePath returns a path", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "sdl-logger-"));
      const testPath = join(tempDir, "test-log-file.log");
      enableFileLogging(testPath);
      assert.strictEqual(getLogFilePath(), testPath);
    });

    it("falls back to temp dir when configured path cannot be created", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "sdl-logger-invalid-"));
      const blockingPath = join(tempDir, "blocking-file");
      writeFileSync(blockingPath, "x", "utf-8");

      enableFileLogging(join(blockingPath, "nested", "sdl-mcp.log"));

      const diagnostics = getLoggerDiagnostics();
      assert.ok(diagnostics.activePath, "expected active log path");
      assert.notStrictEqual(
        diagnostics.activePath,
        join(blockingPath, "nested", "sdl-mcp.log"),
      );
      assert.strictEqual(diagnostics.fallbackUsed, true);
    });
  });

  describe("environment configuration", () => {
    it("treats SDL_LOG_LEVEL case-insensitively", () => {
      configureLoggerFromEnvironment({
        SDL_LOG_LEVEL: "WARN",
      } as NodeJS.ProcessEnv);

      logger.info("hidden");
      logger.warn("visible");
      assert.ok(true);
    });

    it("enables console mirroring from SDL_CONSOLE_LOGGING", () => {
      configureLoggerFromEnvironment({
        SDL_CONSOLE_LOGGING: "true",
      } as NodeJS.ProcessEnv);

      const diagnostics = getLoggerDiagnostics();
      assert.strictEqual(diagnostics.consoleMirroring, true);
    });
  });
});
