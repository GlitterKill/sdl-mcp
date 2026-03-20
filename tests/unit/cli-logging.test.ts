import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

describe("CLI logging", () => {
  let capturedStderr: string[];
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    capturedStderr = [];
    originalStderrWrite = process.stderr.write;
    process.stderr.write = ((data: string | Uint8Array) => {
      capturedStderr.push(String(data));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  describe("configureLogger", () => {
    it("sets the log level and format", async () => {
      const { configureLogger, logger } = await import(
        "../../src/cli/logging.js"
      );

      // Set to error level - debug and info should be suppressed
      configureLogger("error", "pretty");

      capturedStderr = [];
      logger.debug("debug msg");
      logger.info("info msg");
      logger.warn("warn msg");
      logger.error("error msg");

      const output = capturedStderr.join("");
      assert.ok(
        !output.includes("debug msg"),
        "debug should be suppressed at error level",
      );
      assert.ok(
        !output.includes("info msg"),
        "info should be suppressed at error level",
      );
      assert.ok(
        !output.includes("warn msg"),
        "warn should be suppressed at error level",
      );
      assert.ok(
        output.includes("error msg"),
        "error should be logged at error level",
      );

      // Restore to info
      configureLogger("info", "pretty");
    });

    it("allows debug messages at debug level", async () => {
      const { configureLogger, logger } = await import(
        "../../src/cli/logging.js"
      );

      configureLogger("debug", "pretty");

      capturedStderr = [];
      logger.debug("debug visible");
      logger.info("info visible");

      const output = capturedStderr.join("");
      assert.ok(
        output.includes("debug visible"),
        "debug should be visible at debug level",
      );
      assert.ok(
        output.includes("info visible"),
        "info should be visible at debug level",
      );

      // Restore to info
      configureLogger("info", "pretty");
    });

    it("suppresses debug at info level", async () => {
      const { configureLogger, logger } = await import(
        "../../src/cli/logging.js"
      );

      configureLogger("info", "pretty");

      capturedStderr = [];
      logger.debug("should be hidden");
      logger.info("should be visible");

      const output = capturedStderr.join("");
      assert.ok(
        !output.includes("should be hidden"),
        "debug should be suppressed at info level",
      );
      assert.ok(
        output.includes("should be visible"),
        "info should be visible at info level",
      );
    });

    it("suppresses debug and info at warn level", async () => {
      const { configureLogger, logger } = await import(
        "../../src/cli/logging.js"
      );

      configureLogger("warn", "pretty");

      capturedStderr = [];
      logger.debug("debug hidden");
      logger.info("info hidden");
      logger.warn("warn visible");
      logger.error("error visible");

      const output = capturedStderr.join("");
      assert.ok(!output.includes("debug hidden"), "debug suppressed at warn");
      assert.ok(!output.includes("info hidden"), "info suppressed at warn");
      assert.ok(output.includes("warn visible"), "warn visible at warn");
      assert.ok(output.includes("error visible"), "error visible at warn");

      // Restore to info
      configureLogger("info", "pretty");
    });
  });

  describe("pretty format", () => {
    it("includes timestamp, level, and message", async () => {
      const { configureLogger, logger } = await import(
        "../../src/cli/logging.js"
      );

      configureLogger("info", "pretty");

      capturedStderr = [];
      logger.info("test message");

      const output = capturedStderr.join("");
      // Pretty format: [<timestamp>] [INFO] test message
      assert.match(
        output,
        /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
        "Should include ISO timestamp",
      );
      assert.ok(
        output.includes("[INFO]"),
        "Should include level tag",
      );
      assert.ok(
        output.includes("test message"),
        "Should include the message",
      );
    });

    it("includes meta data in pretty format", async () => {
      const { configureLogger, logger } = await import(
        "../../src/cli/logging.js"
      );

      configureLogger("info", "pretty");

      capturedStderr = [];
      logger.info("with meta", { key: "value" });

      const output = capturedStderr.join("");
      assert.ok(
        output.includes('"key"') || output.includes("key"),
        "Should include meta key",
      );
    });

    it("includes requestId in pretty format when present", async () => {
      const { configureLogger, logger } = await import(
        "../../src/cli/logging.js"
      );

      configureLogger("info", "pretty");

      capturedStderr = [];
      logger.info("with request id", { requestId: "req_123" });

      const output = capturedStderr.join("");
      assert.ok(
        output.includes("req_123"),
        "Should include requestId in output",
      );
    });
  });

  describe("json format", () => {
    it("outputs valid JSON", async () => {
      const { configureLogger, logger } = await import(
        "../../src/cli/logging.js"
      );

      configureLogger("info", "json");

      capturedStderr = [];
      logger.info("json test");

      const output = capturedStderr.join("").trim();
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(output) as Record<string, unknown>;
      } catch {
        assert.fail(`Output should be valid JSON, got: ${output}`);
      }
      assert.ok(parsed, "Should parse as JSON");
      assert.strictEqual(parsed.level, "info");
      assert.strictEqual(parsed.message, "json test");
      assert.ok(typeof parsed.timestamp === "string", "Should have timestamp");

      // Restore to pretty
      configureLogger("info", "pretty");
    });

    it("includes meta fields in JSON output", async () => {
      const { configureLogger, logger } = await import(
        "../../src/cli/logging.js"
      );

      configureLogger("info", "json");

      capturedStderr = [];
      logger.info("json meta test", { repoId: "test-repo", count: 42 });

      const output = capturedStderr.join("").trim();
      const parsed = JSON.parse(output) as Record<string, unknown>;
      assert.strictEqual(parsed.repoId, "test-repo");
      assert.strictEqual(parsed.count, 42);

      // Restore to pretty
      configureLogger("info", "pretty");
    });

    it("includes requestId in JSON output", async () => {
      const { configureLogger, logger } = await import(
        "../../src/cli/logging.js"
      );

      configureLogger("info", "json");

      capturedStderr = [];
      logger.info("json req test", { requestId: "req_456" });

      const output = capturedStderr.join("").trim();
      const parsed = JSON.parse(output) as Record<string, unknown>;
      assert.strictEqual(parsed.requestId, "req_456");

      // Restore to pretty
      configureLogger("info", "pretty");
    });
  });

  describe("generateRequestId", () => {
    it("generates unique request IDs", async () => {
      const { generateRequestId } = await import(
        "../../src/cli/logging.js"
      );

      const id1 = generateRequestId();
      const id2 = generateRequestId();

      assert.ok(id1.startsWith("req_"), "Should start with req_ prefix");
      assert.ok(id2.startsWith("req_"), "Should start with req_ prefix");
      assert.notStrictEqual(id1, id2, "IDs should be unique");
    });

    it("includes timestamp component", async () => {
      const { generateRequestId } = await import(
        "../../src/cli/logging.js"
      );

      const id = generateRequestId();
      // Format: req_<timestamp>_<counter>
      const parts = id.split("_");
      assert.strictEqual(parts[0], "req");
      assert.ok(parts.length >= 3, "Should have at least 3 parts");
      const ts = parseInt(parts[1], 10);
      assert.ok(!isNaN(ts), "Second part should be a timestamp number");
      assert.ok(ts > 1000000000000, "Timestamp should be in milliseconds");
    });
  });

  describe("log level ordering", () => {
    it("debug < info < warn < error", async () => {
      const { configureLogger, logger } = await import(
        "../../src/cli/logging.js"
      );

      const levels = ["debug", "info", "warn", "error"] as const;
      const results: Record<string, string[]> = {};

      for (const level of levels) {
        configureLogger(level, "pretty");
        capturedStderr = [];

        logger.debug("d");
        logger.info("i");
        logger.warn("w");
        logger.error("e");

        results[level] = [...capturedStderr];
      }

      // At debug level, all messages visible (4 lines)
      assert.strictEqual(
        results.debug.length,
        4,
        "All 4 levels should log at debug",
      );
      // At info level, 3 messages visible
      assert.strictEqual(
        results.info.length,
        3,
        "3 levels should log at info",
      );
      // At warn level, 2 messages visible
      assert.strictEqual(
        results.warn.length,
        2,
        "2 levels should log at warn",
      );
      // At error level, 1 message visible
      assert.strictEqual(
        results.error.length,
        1,
        "1 level should log at error",
      );

      // Restore to info
      configureLogger("info", "pretty");
    });
  });
});
