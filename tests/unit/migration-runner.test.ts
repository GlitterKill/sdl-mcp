import { describe, it } from "node:test";
import assert from "node:assert";

// Import from dist/ (tests run against compiled output)
const {
  validateMigrationList,
  computePendingMigrations,
  IDEMPOTENT_DDL_ERROR_RE,
} =
  await import("../../dist/db/migration-runner.js");

describe("migration-runner", () => {
  describe("validateMigrationList", () => {
    it("accepts an empty list", () => {
      assert.doesNotThrow(() => validateMigrationList([], 4));
    });

    it("accepts a valid sequential list", () => {
      const migs = [
        { version: 5, description: "m005", up: async () => {} },
        { version: 6, description: "m006", up: async () => {} },
      ];
      assert.doesNotThrow(() => validateMigrationList(migs, 4));
    });

    it("rejects a gap in versions", () => {
      const migs = [
        { version: 5, description: "m005", up: async () => {} },
        { version: 7, description: "m007", up: async () => {} },
      ];
      assert.throws(() => validateMigrationList(migs, 4), /sequential/i);
    });

    it("rejects duplicate versions", () => {
      const migs = [
        { version: 5, description: "m005", up: async () => {} },
        { version: 5, description: "m005-dup", up: async () => {} },
      ];
      assert.throws(() => validateMigrationList(migs, 4), /sequential/i);
    });
  });

  describe("computePendingMigrations", () => {
    const allMigrations = [
      { version: 5, description: "m005", up: async () => {} },
      { version: 6, description: "m006", up: async () => {} },
      { version: 7, description: "m007", up: async () => {} },
    ];

    it("returns all migrations when DB is at base version", () => {
      const pending = computePendingMigrations(allMigrations, 4);
      assert.strictEqual(pending.length, 3);
      assert.strictEqual(pending[0].version, 5);
    });

    it("returns only newer migrations", () => {
      const pending = computePendingMigrations(allMigrations, 6);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].version, 7);
    });

    it("returns empty when DB is up to date", () => {
      const pending = computePendingMigrations(allMigrations, 7);
      assert.strictEqual(pending.length, 0);
    });

    it("returns empty when DB is newer than code", () => {
      const pending = computePendingMigrations(allMigrations, 10);
      assert.strictEqual(pending.length, 0);
    });
  });

  describe("IDEMPOTENT_DDL_ERROR_RE", () => {
    it("matches duplicate-column/idempotent DDL replay errors only", () => {
      assert.match("Column already exists", IDEMPOTENT_DDL_ERROR_RE);
      assert.match("duplicate column: packedEncodings", IDEMPOTENT_DDL_ERROR_RE);
      assert.match("table already has property embeddingNomicVec", IDEMPOTENT_DDL_ERROR_RE);
      assert.doesNotMatch("syntax error near ALTER", IDEMPOTENT_DDL_ERROR_RE);
    });
  });
});
