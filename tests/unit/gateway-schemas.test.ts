import { describe, it } from "node:test";
import assert from "node:assert";
import {
  QueryGatewaySchema,
  CodeGatewaySchema,
  RepoGatewaySchema,
  AgentGatewaySchema,
  QUERY_ACTIONS,
  CODE_ACTIONS,
  REPO_ACTIONS,
  AGENT_ACTIONS,
  ALL_ACTIONS,
} from "../../dist/gateway/schemas.js";

describe("Gateway schemas", () => {
  describe("QueryGatewaySchema", () => {
    it("validates symbol.search action", () => {
      const result = QueryGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "symbol.search",
        query: "routeGatewayCall",
      });
      assert.strictEqual(result.success, true);
    });

    it("validates symbol.getCard action", () => {
      const result = QueryGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "symbol.getCard",
        symbolId: "src/server.ts::MCPServer",
      });
      assert.strictEqual(result.success, true);
    });

    it("validates symbol.getCard action with symbolRef", () => {
      const result = QueryGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "symbol.getCard",
        symbolRef: {
          name: "MCPServer",
          file: "src/server.ts",
        },
      });
      assert.strictEqual(result.success, true);
    });

    it("validates symbol.getCards action", () => {
      const result = QueryGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "symbol.getCards",
        symbolIds: ["sym1", "sym2"],
      });
      assert.strictEqual(result.success, true);
    });

    it("validates symbol.getCards action with symbolRefs", () => {
      const result = QueryGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "symbol.getCards",
        symbolRefs: [{ name: "handleRequest" }],
      });
      assert.strictEqual(result.success, true);
    });

    it("validates slice.build action", () => {
      const result = QueryGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "slice.build",
        taskText: "Implement gateway",
        budget: { maxCards: 50 },
      });
      assert.strictEqual(result.success, true);
    });

    it("validates delta.get action", () => {
      const result = QueryGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "delta.get",
        fromVersion: "v1",
        toVersion: "v2",
      });
      assert.strictEqual(result.success, true);
    });

    it("rejects missing repoId", () => {
      const result = QueryGatewaySchema.safeParse({
        action: "symbol.search",
        query: "test",
      });
      assert.strictEqual(result.success, false);
    });

    it("rejects unknown action", () => {
      const result = QueryGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "unknown.action",
        query: "test",
      });
      assert.strictEqual(result.success, false);
    });
  });

  describe("CodeGatewaySchema", () => {
    it("validates code.needWindow action", () => {
      const result = CodeGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "code.needWindow",
        symbolId: "sym1",
        reason: "debugging",
        expectedLines: 50,
        identifiersToFind: ["foo"],
      });
      assert.strictEqual(result.success, true);
    });

    it("validates code.getSkeleton action", () => {
      const result = CodeGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "code.getSkeleton",
        file: "src/server.ts",
      });
      assert.strictEqual(result.success, true);
    });

    it("validates code.getHotPath action", () => {
      const result = CodeGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "code.getHotPath",
        symbolId: "sym1",
        identifiersToFind: ["handleRequest"],
      });
      assert.strictEqual(result.success, true);
    });
  });

  describe("RepoGatewaySchema", () => {
    it("validates repo.register action", () => {
      const result = RepoGatewaySchema.safeParse({
        repoId: "new-repo",
        action: "repo.register",
        rootPath: "/path/to/repo",
      });
      assert.strictEqual(result.success, true);
    });

    it("validates repo.status action", () => {
      const result = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "repo.status",
      });
      assert.strictEqual(result.success, true);
    });

    it("validates policy.set action", () => {
      const result = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "policy.set",
        policyPatch: { maxWindowLines: 200 },
      });
      assert.strictEqual(result.success, true);
    });

    it("rejects partial policy.set budgetCaps patches", () => {
      const result = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "policy.set",
        policyPatch: {
          budgetCaps: {
            maxCards: 10,
          },
        },
      });
      assert.strictEqual(result.success, false);
    });
  });

  describe("AgentGatewaySchema", () => {
    it("validates agent.orchestrate action", () => {
      const result = AgentGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "agent.orchestrate",
        taskType: "debug",
        taskText: "Fix login bug",
      });
      assert.strictEqual(result.success, true);
    });

    it("validates buffer.push action", () => {
      const result = AgentGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "buffer.push",
        eventType: "change",
        filePath: "src/index.ts",
        content: "const x = 1;",
        version: 1,
        dirty: true,
        timestamp: new Date().toISOString(),
      });
      assert.strictEqual(result.success, true);
    });

    it("validates agent.feedback action", () => {
      const result = AgentGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "agent.feedback",
        versionId: "v1",
        sliceHandle: "slice-1",
        usefulSymbols: ["sym1"],
      });
      assert.strictEqual(result.success, true);
    });
  });

  describe("action constants", () => {
    it("QUERY_ACTIONS has 9 actions", () => {
      assert.strictEqual(QUERY_ACTIONS.length, 9);
    });

    it("CODE_ACTIONS has 3 actions", () => {
      assert.strictEqual(CODE_ACTIONS.length, 3);
    });

    it("REPO_ACTIONS has 8 actions", () => {
      assert.strictEqual(REPO_ACTIONS.length, 8);
    });

    it("AGENT_ACTIONS has 12 actions", () => {
      assert.strictEqual(AGENT_ACTIONS.length, 12);
    });

    it("ALL_ACTIONS has 32 total actions", () => {
      assert.strictEqual(ALL_ACTIONS.length, 32);
    });
  });
});
