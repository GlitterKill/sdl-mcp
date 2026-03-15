import { describe, it } from "node:test";
import assert from "node:assert";

import {
  formatDuration,
  getCurrentTimestamp,
  sleep,
} from "../../src/util/time.js";

describe("time utilities", () => {
  describe("formatDuration", () => {
    it("formats zero milliseconds as 0s", () => {
      assert.strictEqual(formatDuration(0), "0s");
    });

    it("formats sub-second values as 0s", () => {
      assert.strictEqual(formatDuration(999), "0s");
    });

    it("formats exactly one second", () => {
      assert.strictEqual(formatDuration(1_000), "1s");
    });

    it("formats minutes and seconds", () => {
      assert.strictEqual(formatDuration(65_000), "1m 5s");
    });

    it("formats exact one hour", () => {
      assert.strictEqual(formatDuration(3_600_000), "1h 0m");
    });

    it("formats hours and minutes", () => {
      assert.strictEqual(formatDuration(5 * 3_600_000 + 7 * 60_000), "5h 7m");
    });

    it("formats exact one day", () => {
      assert.strictEqual(formatDuration(24 * 3_600_000), "1d 0h");
    });

    it("formats days and hours", () => {
      assert.strictEqual(formatDuration((2 * 24 + 3) * 3_600_000), "2d 3h");
    });
  });

  describe("getCurrentTimestamp", () => {
    it("returns an ISO 8601 UTC timestamp", () => {
      const timestamp = getCurrentTimestamp();
      assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("returns a parseable date", () => {
      const parsed = Date.parse(getCurrentTimestamp());
      assert.strictEqual(Number.isNaN(parsed), false);
    });
  });

  describe("sleep", () => {
    it("resolves after approximately the requested delay", async () => {
      const start = Date.now();
      await sleep(25);
      const elapsed = Date.now() - start;

      assert.ok(
        elapsed >= 15,
        `Expected at least 15ms delay, got ${elapsed}ms`,
      );
      assert.ok(
        elapsed < 1_000,
        `Expected less than 1000ms delay, got ${elapsed}ms`,
      );
    });

    it("resolves immediately for zero delay", async () => {
      await assert.doesNotReject(async () => sleep(0));
    });
  });
});
