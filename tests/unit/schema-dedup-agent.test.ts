import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * Validates that the AgentContextRequestSchema is defined only in
 * src/mcp/tools.ts (canonical) and not duplicated in src/mcp/tools/context.ts.
 *
 * Regression test for: duplicate schema definitions causing silent validation
 * drift between server registration (uses canonical) and handler parsing
 * (previously used local copy with weaker constraints).
 */
describe("AgentContextRequestSchema deduplication", () => {
  it("should export AgentContextRequestSchema from tools.ts", async () => {
    const tools = await import("../../dist/mcp/tools.js");
    assert.ok(
      tools.AgentContextRequestSchema,
      "tools.ts should export AgentContextRequestSchema",
    );
    assert.strictEqual(
      typeof tools.AgentContextRequestSchema.parse,
      "function",
      "Schema should have a parse method",
    );
  });

  it("should NOT export AgentContextRequestSchema from context.ts", async () => {
    const agent = await import("../../dist/mcp/tools/context.js");
    assert.strictEqual(
      agent.AgentContextRequestSchema,
      undefined,
      "context.ts should NOT export its own AgentContextRequestSchema",
    );
  });

  it("should export handleAgentContext from context.ts", async () => {
    const agent = await import("../../dist/mcp/tools/context.js");
    assert.ok(
      agent.handleAgentContext,
      "context.ts should still export handleAgentContext",
    );
    assert.strictEqual(
      typeof agent.handleAgentContext,
      "function",
      "handleAgentContext should be a function",
    );
  });

  it("canonical schema should have max constraints", async () => {
    const { AgentContextRequestSchema } = await import(
      "../../dist/mcp/tools.js"
    );

    // The canonical schema should reject overly long repoId
    const longRepoId = "x".repeat(200);
    const result = AgentContextRequestSchema.safeParse({
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
