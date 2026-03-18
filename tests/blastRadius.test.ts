import { describe, it } from "node:test";
import assert from "node:assert";
import { computeBlastRadius } from "../dist/delta/blastRadius.js";
import type { Connection } from "kuzu";
import type { SymbolId } from "../dist/db/schema.js";

describe("BlastRadius Edge Cases", () => {
  describe("maxHops validation", () => {
    it("should correct maxHops=0 to default of 3 and proceed (AC1)", async () => {
      // maxHops <= 0 is now corrected to 3 (not returning []),
      // so with a real connection this would compute blast radius.
      // With a mock connection, it will throw because it tries to query.
      const changedSymbols: SymbolId[] = ["symbol-1"];
      const conn = {} as unknown as Connection;

      await assert.rejects(
        () => computeBlastRadius(conn, changedSymbols, {
          repoId: "test-repo",
          maxHops: 0,
        }),
        /prepare is not a function/,
        "Should attempt to compute blast radius (maxHops corrected to 3)",
      );
    });

    it("should correct negative maxHops to default of 3 and proceed", async () => {
      const changedSymbols: SymbolId[] = ["symbol-1"];
      const conn = {} as unknown as Connection;

      await assert.rejects(
        () => computeBlastRadius(conn, changedSymbols, {
          repoId: "test-repo",
          maxHops: -1,
        }),
        /prepare is not a function/,
        "Should attempt to compute blast radius (maxHops corrected to 3)",
      );
    });
  });

  describe("edge case combinations", () => {
    it("should handle empty changed symbols list", async () => {
      const changedSymbols: SymbolId[] = [];
      const conn = {} as unknown as Connection;

      const result = await computeBlastRadius(conn, changedSymbols, {
        repoId: "test-repo",
      });

      assert.strictEqual(
        result.length,
        0,
        "Should return empty array for no changed symbols",
      );
    });
  });
});
