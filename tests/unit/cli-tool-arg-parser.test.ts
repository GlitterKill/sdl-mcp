import { describe, it } from "node:test";
import assert from "node:assert";
import { parseToolArgs, buildParseArgsOptions } from "../../src/cli/commands/tool-arg-parser.js";
import type { ActionDefinition, ActionArgDef } from "../../src/cli/commands/tool-actions.js";

describe("cli-tool-arg-parser", () => {
  const mockDef: ActionDefinition = {
    action: "test.action",
    namespace: "query",
    description: "Test action",
    examples: [],
    args: [
      { flag: "--repo-id", field: "repoId", type: "string", required: true, description: "Repo ID" },
      { flag: "--limit", field: "limit", type: "number", description: "Limit" },
      { flag: "--active", field: "active", type: "boolean", description: "Active flag" },
      { flag: "--tags", field: "tags", type: "string[]", description: "Tags list" },
      { flag: "--config", field: "config", type: "json", description: "JSON config" },
    ],
  };

  const budgetDef: ActionDefinition = {
    action: "test.budget",
    namespace: "query",
    description: "Test budget",
    examples: [],
    args: [
      { flag: "--max-cards", field: "_budgetMaxCards", type: "number", description: "Max cards" },
      { flag: "--max-tokens", field: "_budgetMaxTokens", type: "number", description: "Max tokens" },
    ],
  };

  it("builds correct options for parseArgs", () => {
    const opts = buildParseArgsOptions(mockDef);
    assert.deepStrictEqual(opts, {
      "repo-id": { type: "string" },
      limit: { type: "string" }, // numbers use string in parseArgs
      active: { type: "boolean" },
      tags: { type: "string", multiple: true }, // arrays use string in parseArgs
      config: { type: "string" }, // json uses string in parseArgs
    });
  });

  describe("parseToolArgs type coercion", () => {
    it("coerces strings", () => {
      const result = parseToolArgs(mockDef, { "repo-id": "my-repo" });
      assert.strictEqual(result.repoId, "my-repo");
    });

    it("coerces numbers", () => {
      const result = parseToolArgs(mockDef, { "repo-id": "r", limit: "42" });
      assert.strictEqual(result.limit, 42);
    });

    it("throws on invalid numbers", () => {
      assert.throws(
        () => parseToolArgs(mockDef, { "repo-id": "r", limit: "not-a-number" }),
        /must be a number/,
      );
    });

    it("coerces booleans", () => {
      let result = parseToolArgs(mockDef, { "repo-id": "r", active: true });
      assert.strictEqual(result.active, true);

      result = parseToolArgs(mockDef, { "repo-id": "r", active: "true" });
      assert.strictEqual(result.active, true);

      result = parseToolArgs(mockDef, { "repo-id": "r", active: "false" });
      assert.strictEqual(result.active, false);
    });

    it("coerces string arrays", () => {
      let result = parseToolArgs(mockDef, { "repo-id": "r", tags: "a,b, c" });
      assert.deepStrictEqual(result.tags, ["a", "b", "c"]);

      // If parseArgs gave an array (e.g. repeated flags)
      result = parseToolArgs(mockDef, { "repo-id": "r", tags: ["a", "b,c"] });
      assert.deepStrictEqual(result.tags, ["a", "b", "c"]);
    });

    it("coerces JSON", () => {
      const result = parseToolArgs(mockDef, { "repo-id": "r", config: '{"key":"value"}' });
      assert.deepStrictEqual(result.config, { key: "value" });
    });

    it("throws on invalid JSON", () => {
      assert.throws(
        () => parseToolArgs(mockDef, { "repo-id": "r", config: '{"key":"value"' }),
        /must be valid JSON/,
      );
    });
  });

  describe("parseToolArgs budget merging", () => {
    it("merges _budgetMaxCards and _budgetMaxTokens into budget object", () => {
      const result = parseToolArgs(budgetDef, { "max-cards": "100", "max-tokens": "5000" });
      assert.deepStrictEqual(result.budget, { maxCards: 100, maxEstimatedTokens: 5000 });
      assert.strictEqual(result._budgetMaxCards, undefined);
      assert.strictEqual(result._budgetMaxTokens, undefined);
    });

    it("handles partial budget fields", () => {
      const result = parseToolArgs(budgetDef, { "max-cards": "100" });
      assert.deepStrictEqual(result.budget, { maxCards: 100 });
    });
  });

  describe("parseToolArgs required validation", () => {
    it("throws if required arg is missing", () => {
      assert.throws(
        () => parseToolArgs(mockDef, { limit: "10" }),
        /Missing required argument\(s\): --repo-id/,
      );
    });

    it("does not throw if required arg is present", () => {
      assert.doesNotThrow(() => parseToolArgs(mockDef, { "repo-id": "repo1" }));
    });
  });

  describe("parseToolArgs stdin merging", () => {
    it("merges stdin args with CLI flags taking precedence", () => {
      const stdinArgs = { repoId: "from-stdin", limit: 20 };
      const cliFlags = { "repo-id": "from-cli", active: true };

      const result = parseToolArgs(mockDef, cliFlags, stdinArgs);

      assert.strictEqual(result.repoId, "from-cli"); // CLI wins
      assert.strictEqual(result.limit, 20); // from stdin
      assert.strictEqual(result.active, true); // from CLI
    });

    // To test this interaction, we need the mockDef to define flags for the stdin fields so type coercion applies properly, 
    // but the stdin fields are already typed correctly. The mapper uses definition args.
    it("uses stdin values even if not provided as flag", () => {
      const result = parseToolArgs(mockDef, {}, { repoId: "from-stdin" });
      assert.strictEqual(result.repoId, "from-stdin");
    });
  });
});
