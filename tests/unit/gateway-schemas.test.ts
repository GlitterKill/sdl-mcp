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

    it("rejects symbol.edit because sdl.query is read-only", () => {
      const result = QueryGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "symbol.edit",
        mode: "preview",
        symbolId: "src/server.ts::handleRequest",
        operation: { kind: "replaceBody", content: "return true;\n" },
      });
      assert.strictEqual(result.success, false);
    });

    it("rejects symbol.getCard action with batch symbolIds (not supported)", () => {
      const result = QueryGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "symbol.getCard",
        symbolIds: ["sym1", "sym2"],
      });
      assert.strictEqual(result.success, false);
    });

    it("rejects symbol.getCard action with batch symbolRefs (not supported)", () => {
      const result = QueryGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "symbol.getCard",
        symbolRefs: [{ name: "handleRequest" }],
      });
      assert.strictEqual(result.success, false);
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

    it("keeps empty policy.set patches empty", () => {
      const result = RepoGatewaySchema.parse({
        repoId: "test-repo",
        action: "policy.set",
        policyPatch: {},
      });

      assert.deepStrictEqual(result.policyPatch, {});
    });

    it("rejects direct SCIP ingest because provider inputs are provider-first only", () => {
      const result = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "scip.ingest",
        indexPath: "index.scip",
      });
      assert.strictEqual(result.success, false);
    });

    it("accepts partial policy.set budgetCaps patches", () => {
      const result = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "policy.set",
        policyPatch: {
          budgetCaps: {
            maxCards: 10,
          },
        },
      });
      assert.strictEqual(result.success, true);

      assert.deepStrictEqual(result.data.policyPatch.budgetCaps, {
        maxCards: 10,
      });
    });

    it("validates search.edit preview with responseMode", () => {
      const result = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "search.edit",
        mode: "preview",
        targeting: "text",
        query: {
          literal: "oldName",
          replacement: "newName",
        },
        editMode: "replacePattern",
        responseMode: "handle",
      });
      assert.strictEqual(result.success, true);
    });

    it("mirrors the direct search.edit maxFiles cap", () => {
      const result = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "search.edit",
        mode: "preview",
        targeting: "text",
        query: {
          literal: "oldName",
          replacement: "newName",
        },
        editMode: "replacePattern",
        maxFiles: 501,
      });
      assert.strictEqual(result.success, false);
    });

    it("validates structural search.edit payloads with the strict MCP query contract", () => {
      const valid = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "search.edit",
        mode: "preview",
        targeting: "structural",
        query: {
          structural: {
            language: "python",
            treeSitterQuery: "(identifier) @target",
            capture: "target",
            requiredCaptures: { target: "old_name" },
          },
          replacement: "new_name",
        },
        editMode: "replacePattern",
      });
      assert.strictEqual(valid.success, true);

      const longQuery = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "search.edit",
        mode: "preview",
        targeting: "structural",
        query: {
          structural: {
            treeSitterQuery: "x".repeat(5001),
          },
        },
        editMode: "replacePattern",
      });
      assert.strictEqual(longQuery.success, false);

      const invalidCapture = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "search.edit",
        mode: "preview",
        targeting: "structural",
        query: {
          structural: {
            treeSitterQuery: "(identifier) @target",
            capture: "target name",
          },
        },
        editMode: "replacePattern",
      });
      assert.strictEqual(invalidCapture.success, false);

      const invalidRequiredCapture = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "search.edit",
        mode: "preview",
        targeting: "structural",
        query: {
          structural: {
            treeSitterQuery: "(identifier) @target",
            requiredCaptures: { "target name": "old_name" },
          },
        },
        editMode: "replacePattern",
      });
      assert.strictEqual(invalidRequiredCapture.success, false);

      const oversizedRequiredValue = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "search.edit",
        mode: "preview",
        targeting: "structural",
        query: {
          structural: {
            treeSitterQuery: "(identifier) @target",
            requiredCaptures: { target: "x".repeat(501) },
          },
        },
        editMode: "replacePattern",
      });
      assert.strictEqual(oversizedRequiredValue.success, false);

      const tooManyRequiredCaptures = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "search.edit",
        mode: "preview",
        targeting: "structural",
        query: {
          structural: {
            treeSitterQuery: "(identifier) @target",
            requiredCaptures: Object.fromEntries(
              Array.from({ length: 33 }, (_, index) => [
                `capture_${index}`,
                "old_name",
              ]),
            ),
          },
        },
        editMode: "replacePattern",
      });
      assert.strictEqual(tooManyRequiredCaptures.success, false);

      const blockedRequiredCapture = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "search.edit",
        mode: "preview",
        targeting: "structural",
        query: {
          structural: {
            treeSitterQuery: "(identifier) @target",
            requiredCaptures: JSON.parse('{"__proto__":"old_name"}'),
          },
        },
        editMode: "replacePattern",
      });
      assert.strictEqual(blockedRequiredCapture.success, false);

      const oversizedFilters = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "search.edit",
        mode: "preview",
        targeting: "text",
        query: { literal: "oldName", replacement: "newName" },
        filters: {
          include: Array.from({ length: 51 }, (_, index) => `src/${index}.ts`),
        },
        editMode: "replacePattern",
      });
      assert.strictEqual(oversizedFilters.success, false);

      const oversizedContent = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "search.edit",
        mode: "preview",
        targeting: "text",
        query: {
          content: "x".repeat(512 * 1024 + 1),
        },
        editMode: "overwrite",
      });
      assert.strictEqual(oversizedContent.success, false);
    });

    it("rejects search.edit preview operations with duplicate ids", () => {
      const result = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "search.edit",
        mode: "preview",
        operations: [
          {
            id: "rename",
            targeting: "text",
            query: { literal: "oldName", replacement: "newName" },
            editMode: "replacePattern",
          },
          {
            id: "rename",
            targeting: "text",
            query: { literal: "otherName", replacement: "newName" },
            editMode: "replacePattern",
          },
        ],
      });
      assert.strictEqual(result.success, false);
    });

    it("validates symbol.edit preview action", () => {
      const result = RepoGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "symbol.edit",
        mode: "preview",
        symbolId: "src/server.ts::handleRequest",
        operation: { kind: "replaceBody", content: "return true;\n" },
      });
      assert.strictEqual(result.success, true);
    });
  });

  describe("AgentGatewaySchema", () => {
    it("rejects non-existent agent.context action", () => {
      const result = AgentGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "agent.context",
        taskType: "debug",
        taskText: "Fix login bug",
      });
      assert.strictEqual(result.success, false);
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

    it("rejects runtime.execute stdin above the 512 KiB UTF-8 byte limit", () => {
      const result = AgentGatewaySchema.safeParse({
        repoId: "test-repo",
        action: "runtime.execute",
        runtime: "node",
        args: ["-e", "process.stdin.resume()"],
        stdin: "\u00e9".repeat(256 * 1024 + 1),
      });
      assert.strictEqual(result.success, false);
    });
  });

  describe("action constants", () => {
    it("QUERY_ACTIONS has 8 actions", () => {
      assert.strictEqual(QUERY_ACTIONS.length, 8);
    });

    it("CODE_ACTIONS has 3 actions", () => {
      assert.strictEqual(CODE_ACTIONS.length, 3);
    });

    it("REPO_ACTIONS has 13 actions", () => {
      assert.strictEqual(REPO_ACTIONS.length, 13);
    });

    it("AGENT_ACTIONS has 11 actions", () => {
      assert.strictEqual(AGENT_ACTIONS.length, 11);
    });

    it("ALL_ACTIONS has 35 total actions", () => {
      assert.strictEqual(ALL_ACTIONS.length, 35);
    });
  });
});
