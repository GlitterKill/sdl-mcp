import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * Validates that the AgentOrchestrateRequestSchema is defined only in
 * src/mcp/tools.ts (canonical) and not duplicated in src/mcp/tools/agent.ts.
 *
 * Regression test for: duplicate schema definitions causing silent validation
 * drift between server registration (uses canonical) and handler parsing
 * (previously used local copy with weaker constraints).
 */
describe("AgentOrchestrateRequestSchema deduplication", () => {
  it("should export AgentOrchestrateRequestSchema from tools.ts", async () => {
    const tools = await import("../../dist/mcp/tools.js");
    assert.ok(
      tools.AgentOrchestrateRequestSchema,
      "tools.ts should export AgentOrchestrateRequestSchema",
    );
    assert.strictEqual(
      typeof tools.AgentOrchestrateRequestSchema.parse,
      "function",
      "Schema should have a parse method",
    );
  });

  it("should NOT export AgentOrchestrateRequestSchema from agent.ts", async () => {
    const agent = await import("../../dist/mcp/tools/agent.js");
    assert.strictEqual(
      agent.AgentOrchestrateRequestSchema,
      undefined,
      "agent.ts should NOT export its own AgentOrchestrateRequestSchema",
    );
  });

  it("should export handleAgentOrchestrate from agent.ts", async () => {
    const agent = await import("../../dist/mcp/tools/agent.js");
    assert.ok(
      agent.handleAgentOrchestrate,
      "agent.ts should still export handleAgentOrchestrate",
    );
    assert.strictEqual(
      typeof agent.handleAgentOrchestrate,
      "function",
      "handleAgentOrchestrate should be a function",
    );
  });

  it("canonical schema should have max constraints", async () => {
    const { AgentOrchestrateRequestSchema } = await import(
      "../../dist/mcp/tools.js"
    );

    // The canonical schema should reject overly long repoId
    const longRepoId = "x".repeat(200);
    const result = AgentOrchestrateRequestSchema.safeParse({
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
