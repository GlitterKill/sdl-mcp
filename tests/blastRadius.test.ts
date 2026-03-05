import { describe, it } from "node:test";
import assert from "node:assert";
import { computeBlastRadius } from "../dist/delta/blastRadius.js";
import type { Connection } from "kuzu";
import type { SymbolId } from "../dist/db/schema.js";

describe("BlastRadius Edge Cases", () => {
  describe("maxHops validation", () => {
    it("should handle maxHops=0 gracefully (AC1)", async () => {
      const changedSymbols: SymbolId[] = ["symbol-1"];
      const conn = {} as unknown as Connection;

      const result = await computeBlastRadius(conn, changedSymbols, {
        repoId: "test-repo",
        maxHops: 0,
      });

      assert.strictEqual(
        result.length,
        0,
        "Should return empty array for maxHops=0",
      );
    });

    it("should handle negative maxHops gracefully", async () => {
      const changedSymbols: SymbolId[] = ["symbol-1"];
      const conn = {} as unknown as Connection;

      const result = await computeBlastRadius(conn, changedSymbols, {
        repoId: "test-repo",
        maxHops: -1,
      });

      assert.strictEqual(
        result.length,
        0,
        "Should return empty array for negative maxHops",
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
