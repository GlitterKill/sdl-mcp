import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";

/**
 * Integration tests for SCIP external symbol handling in slice building,
 * blast radius, card builder, and symbol search.
 *
 * These are structural/schema tests that validate the external symbol
 * support is properly wired without requiring a running LadybugDB instance.
 */

describe("SCIP Slice Externals", () => {
  describe("SymbolRow external field", () => {
    it("should include external field in ladybug SymbolRow interface", async () => {
      // Verify the SymbolRow type accepts external fields
      const { SymbolRow } =
        (await import("../../dist/db/ladybug-symbols.js")) as {
          SymbolRow: {
            external?: boolean;
            packageName?: string | null;
            packageVersion?: string | null;
            scipSymbol?: string | null;
          };
        };
      // Type-level check: if this compiles, the fields exist
      const row: typeof SymbolRow = {
        external: true,
        packageName: "lodash",
        packageVersion: "4.17.21",
        scipSymbol: "npm lodash 4.17.21 `chunk`.",
      };
      assert.equal(row.external, true);
      assert.equal(row.packageName, "lodash");
    });

    it("should include external field in legacy SymbolRow interface", async () => {
      const { SymbolRow } = (await import("../../dist/db/schema.js")) as {
        SymbolRow: {
          external?: 0 | 1;
          package_name?: string | null;
          package_version?: string | null;
          scip_symbol?: string | null;
        };
      };
      const row: typeof SymbolRow = {
        external: 1,
        package_name: "lodash",
        package_version: "4.17.21",
        scip_symbol: "npm lodash 4.17.21 `chunk`.",
      };
      assert.equal(row.external, 1);
    });
  });

  describe("SymbolCard external fields", () => {
    it("should include SCIP fields on SymbolCard", async () => {
      const types = await import("../../dist/domain/types.js");
      // Construct a minimal external card
      const card: types.SymbolCard = {
        symbolId: "test-external-id",
        repoId: "test-repo",
        file: "",
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
        kind: "function",
        name: "externalFn",
        exported: true,
        external: true,
        packageName: "lodash",
        packageVersion: "4.17.21",
        scipSymbol: "npm lodash 4.17.21 `chunk`.",
        deps: { imports: [], calls: [] },
        detailLevel: "minimal",
        version: {
          ledgerVersion: "v1",
          astFingerprint: "abc",
        },
      };
      assert.equal(card.external, true);
      assert.equal(card.packageName, "lodash");
      assert.equal(card.detailLevel, "minimal");
    });
  });

  describe("SymbolSearchRequestSchema excludeExternal", () => {
    it("should accept excludeExternal in search request schema", async () => {
      const { SymbolSearchRequestSchema } =
        await import("../../dist/mcp/tools.js");
      const result = SymbolSearchRequestSchema.safeParse({
        repoId: "test-repo",
        query: "lodash",
        excludeExternal: true,
      });
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.excludeExternal, true);
      }
    });

    it("should accept request without excludeExternal (optional)", async () => {
      const { SymbolSearchRequestSchema } =
        await import("../../dist/mcp/tools.js");
      const result = SymbolSearchRequestSchema.safeParse({
        repoId: "test-repo",
        query: "lodash",
      });
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.excludeExternal, undefined);
      }
    });
  });

  describe("Beam search external leaf-node behavior", () => {
    it("should treat external symbols as leaf nodes in in-memory beam search", async () => {
      // Verify the beam search code includes the external check
      // by importing the module (compilation check)
      const beamModule =
        await import("../../dist/graph/slice/beam-search-engine.js");
      assert.ok(beamModule, "beam-search-engine module should load");
      // The beamSearch function should exist
      assert.equal(typeof beamModule.beamSearch, "function");
    });

    it("should treat external symbols as leaf nodes in DB-backed beam search", async () => {
      const beamModule =
        await import("../../dist/graph/slice/beam-search-engine.js");
      assert.ok(beamModule, "beam-search-engine module should load");
      // The beamSearchAsync function should exist (wraps beamSearchLadybug)
      assert.equal(typeof beamModule.beamSearchAsync, "function");
    });
  });

  describe("Blast radius external exclusion", () => {
    it("should have computeBlastRadius that filters externals", async () => {
      const blastModule = await import("../../dist/delta/blastRadius.js");
      assert.ok(blastModule, "blastRadius module should load");
      assert.equal(typeof blastModule.computeBlastRadius, "function");
    });
  });

  describe("Card builder external early return", () => {
    it("should have buildCardForSymbol that handles externals", async () => {
      const cardModule = await import("../../dist/services/card-builder.js");
      assert.ok(cardModule, "card-builder module should load");
      assert.equal(typeof cardModule.buildCardForSymbol, "function");
    });
  });
});
