import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * Validates that the SymbolGetCardRequestSchema is defined only in
 * src/mcp/tools.ts (canonical) and not duplicated in src/mcp/tools/context.ts.
 *
 * Regression test for: duplicate schema definitions causing silent validation
 * drift between server registration (uses canonical) and handler parsing
 * (previously used local copy with weaker constraints).
 */
describe("SymbolGetCardRequestSchema deduplication", () => {
  it("should export SymbolGetCardRequestSchema from tools.ts", async () => {
    const tools = await import("../../dist/mcp/tools.js");
    assert.ok(
      tools.SymbolGetCardRequestSchema,
      "tools.ts should export SymbolGetCardRequestSchema",
    );
    assert.strictEqual(
      typeof tools.SymbolGetCardRequestSchema.parse,
      "function",
      "Schema should have a parse method",
    );
  });

  it("should NOT export SymbolGetCardRequestSchema from context.ts", async () => {
    const agent = await import("../../dist/mcp/tools/symbol.js");
    assert.strictEqual(
      agent.SymbolGetCardRequestSchema,
      undefined,
      "context.ts should NOT export its own SymbolGetCardRequestSchema",
    );
  });

  it("should export handleSymbolGetCard from context.ts", async () => {
    const agent = await import("../../dist/mcp/tools/symbol.js");
    assert.ok(
      agent.handleSymbolGetCard,
      "symbol.ts should export handleSymbolGetCard",
    );
    assert.strictEqual(
      typeof agent.handleSymbolGetCard,
      "function",
      "handleSymbolGetCard should be a function",
    );
  });

  it("canonical schema should have max constraints", async () => {
    const { SymbolGetCardRequestSchema } = await import(
      "../../dist/mcp/tools.js"
    );

    // The canonical schema should reject overly long repoId
    const longRepoId = "x".repeat(200);
    const result = SymbolGetCardRequestSchema.safeParse({
      repoId: longRepoId,
      taskType: "debug",
      taskText: "test",
    });
    assert.strictEqual(
      result.success,
      false,
      "Canonical schema should reject repoId longer than MAX_REPO_ID_LENGTH",
    );
  });
});
