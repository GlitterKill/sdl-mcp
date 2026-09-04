import { describe, it } from "node:test";
import assert from "node:assert";

const {
  validateMigrationList,
  computePendingMigrations,
  runPendingMigrations,
  IDEMPOTENT_DDL_ERROR_RE,
} = await import("../../dist/db/migration-runner.js");
const { SafeRebuildRequiredError } = await import(
  "../../dist/domain/errors.js"
);
const { migrations } = await import("../../dist/db/migrations/index.js");

function fakeConnection(onSchemaVersion: (version: number) => void) {
  return {
    prepare: async (statement: string) => ({ statement }),
    execute: async (
      _prepared: unknown,
      params: Record<string, unknown>,
    ) => {
      if (typeof params.version === "number") {
        onSchemaVersion(params.version);
      }
      return { close() {} };
    },
  } as unknown as import("kuzu").Connection;
}

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

  describe("safe-rebuild boundary", () => {
    it("checks the complete pending set before applying an earlier migration", async () => {
      let schemaVersion = 25;
      const applied: number[] = [];
      const conn = fakeConnection((version) => {
        schemaVersion = version;
      });
      const pending = [
        {
          version: 26,
          description: "ordinary migration",
          up: async () => {
            applied.push(26);
          },
        },
        {
          version: 27,
          description: "fresh database required",
          requiresFreshDatabase: true,
          up: async () => {
            applied.push(27);
          },
        },
      ];

      await assert.rejects(
        () => runPendingMigrations(conn, schemaVersion, pending),
        (error: unknown) => {
          assert.ok(error instanceof SafeRebuildRequiredError);
          assert.match(error.message, /stop the service/i);
          assert.match(error.message, /safe-rebuild workflow/i);
          return true;
        },
      );
      assert.deepStrictEqual(applied, []);
      assert.strictEqual(schemaVersion, 25);
    });

    it("still applies migrations wholly below the boundary in order", async () => {
      let schemaVersion = 24;
      const applied: number[] = [];
      const conn = fakeConnection((version) => {
        schemaVersion = version;
      });
      const belowBoundary = [
        {
          version: 25,
          description: "first",
          up: async () => {
            applied.push(25);
          },
        },
        {
          version: 26,
          description: "second",
          up: async () => {
            applied.push(26);
          },
        },
      ];

      assert.strictEqual(
        await runPendingMigrations(conn, schemaVersion, belowBoundary),
        26,
      );
      assert.deepStrictEqual(applied, [25, 26]);
      assert.strictEqual(schemaVersion, 26);
    });

    it("keeps migration 27 defensive when invoked directly", async () => {
      const boundary = migrations.find((migration) => migration.version === 27);
      assert.ok(boundary);
      const conn = fakeConnection(() => {});

      await assert.rejects(
        () => boundary.up(conn),
        SafeRebuildRequiredError,
      );
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
