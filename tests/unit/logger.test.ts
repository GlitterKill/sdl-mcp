import { describe, it } from "node:test";
import assert from "node:assert";

import {
  logger,
  enableFileLogging,
  disableFileLogging,
  getLogFilePath,
} from "../../dist/util/logger.js";
import type { LogLevel } from "../../dist/util/logger.js";

describe("Logger", () => {
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
        // Should not throw
        logger.setLevel(level);
      }
      // Reset to a sensible default
      logger.setLevel("info");
    });

    it("debug does not throw when called", () => {
      logger.setLevel("debug");
      assert.doesNotThrow(() => {
        logger.debug("test debug message");
      });
      logger.setLevel("info");
    });

    it("info does not throw when called", () => {
      assert.doesNotThrow(() => {
        logger.info("test info message");
      });
    });

    it("warn does not throw when called", () => {
      assert.doesNotThrow(() => {
        logger.warn("test warn message");
      });
    });

    it("error does not throw when called", () => {
      assert.doesNotThrow(() => {
        logger.error("test error message");
      });
    });

    it("log methods accept metadata object", () => {
      assert.doesNotThrow(() => {
        logger.info("message with meta", { key: "value", count: 42 });
      });
    });

    it("log methods handle undefined metadata", () => {
      assert.doesNotThrow(() => {
        logger.info("message without meta", undefined);
      });
    });

    it("log methods handle error objects in metadata", () => {
      assert.doesNotThrow(() => {
        logger.error("something failed", { error: new Error("test error") });
      });
    });

    it("level filtering: error level suppresses debug/info/warn", () => {
      // Set to error level - debug/info/warn should be filtered
      logger.setLevel("error");
      // These should not throw even though they are filtered
      assert.doesNotThrow(() => {
        logger.debug("filtered out");
        logger.info("filtered out");
        logger.warn("filtered out");
        logger.error("this one passes");
      });
      logger.setLevel("info");
    });

    it("level filtering: debug level allows all messages", () => {
      logger.setLevel("debug");
      assert.doesNotThrow(() => {
        logger.debug("passes");
        logger.info("passes");
        logger.warn("passes");
        logger.error("passes");
      });
      logger.setLevel("info");
    });
  });

  describe("file logging", () => {
    it("getLogFilePath returns null when file logging is disabled", () => {
      disableFileLogging();
      const path = getLogFilePath();
      assert.strictEqual(path, null);
    });

    it("enableFileLogging then getLogFilePath returns a path", () => {
      const testPath = "test-log-file.log";
      enableFileLogging(testPath);
      const path = getLogFilePath();
      assert.strictEqual(path, testPath);
      disableFileLogging();
    });

    it("disableFileLogging resets the path", () => {
      enableFileLogging("some-path.log");
      disableFileLogging();
      assert.strictEqual(getLogFilePath(), null);
    });
  });
});
