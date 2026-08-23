import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  isPublicIndexRefresh,
  isMetadataOnlyTool,
  MCPServer,
  shouldBypassToolDispatch,
  isReadOnlyWhenDegraded,
} from "../../dist/server.js";
import { SDL_MCP_SERVER_INSTRUCTIONS } from "../../dist/mcp/server-instructions.js";
import { getPackageVersion } from "../../dist/util/package-info.js";

const SYNTHETIC_PROJECTION_PROFILE = Object.freeze({
  projector: "generic",
  observabilityProfile: "standard",
  defaultDetail: "compact",
  budgetClass: "compact",
  largeResponseStrategy: "truncate",
  recoveryPolicy: "none",
} as const);

// Synthetic tools exercise server mechanics without widening the production registry.
const resolveSyntheticProjectionProfile = () => SYNTHETIC_PROJECTION_PROFILE;

/**
 * Tests for src/server.ts — MCPServer class.
 * Verifies tool registration, gatewayMode property, clearTools, and
 * post-dispatch hook registration. Covers in-memory protocol connectivity,
 * but not external stdio or HTTP integration.
 */

describe("MCPServer", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer({
      resolveProjectionProfile: resolveSyntheticProjectionProfile,
    });
  });

  describe("metadata-only dispatch bypass", () => {
    it("identifies catalog/manual tools as metadata-only", () => {
      assert.strictEqual(isMetadataOnlyTool("sdl.action.search"), true);
      assert.strictEqual(isMetadataOnlyTool("sdl.manual"), true);
      assert.strictEqual(isMetadataOnlyTool("sdl.context"), false);
      assert.strictEqual(isMetadataOnlyTool("sdl.file"), false);
    });

    it("bypasses dispatch for direct status tools", () => {
      assert.strictEqual(
        shouldBypassToolDispatch("sdl.repo.status", { repoId: "sdl-mcp" }),
        true,
      );
      assert.strictEqual(
        shouldBypassToolDispatch("sdl.repo", {
          repoId: "sdl-mcp",
          action: "repo.status",
        }),
        true,
      );
      assert.strictEqual(
        shouldBypassToolDispatch("sdl.index.refresh", {
          repoId: "sdl-mcp",
          mode: "incremental",
        }),
        false,
      );
      assert.strictEqual(
        shouldBypassToolDispatch("sdl.repo", {
          repoId: "sdl-mcp",
          action: "index.refresh",
        }),
        false,
      );
    });

    it("bypasses dispatch for read-only status workflows", () => {
      assert.strictEqual(
        shouldBypassToolDispatch("sdl.workflow", {
          repoId: "sdl-mcp",
          steps: [{ fn: "repo.status", args: { detail: "minimal" } }],
        }),
        true,
      );
      assert.strictEqual(
        shouldBypassToolDispatch("sdl.workflow", {
          repoId: "sdl-mcp",
          steps: [
            { fn: "repo.status", args: {} },
            {
              fn: "dataPick",
              args: { input: "$0", fields: { repoId: "repoId" } },
            },
          ],
        }),
        true,
      );
    });

    it("keeps mutating or runtime workflows behind dispatch", () => {
      assert.strictEqual(
        shouldBypassToolDispatch("sdl.workflow", {
          repoId: "sdl-mcp",
          steps: [{ fn: "index.refresh", args: { mode: "incremental" } }],
        }),
        false,
      );
      assert.strictEqual(
        shouldBypassToolDispatch("sdl.workflow", {
          repoId: "sdl-mcp",
          steps: [{ fn: "runtime.execute", args: { runtime: "node" } }],
        }),
        false,
      );
    });
  });

  describe("public index refresh admission classification", () => {
    it("matches the exact flat, gateway, and workflow refresh surfaces", () => {
      assert.strictEqual(
        isPublicIndexRefresh("sdl.index.refresh", {
          repoId: "sdl-mcp",
          mode: "full",
        }),
        true,
      );
      assert.strictEqual(
        isPublicIndexRefresh("sdl.repo", {
          repoId: "sdl-mcp",
          action: "index.refresh",
        }),
        true,
      );
      assert.strictEqual(
        isPublicIndexRefresh("sdl.workflow", {
          repoId: "sdl-mcp",
          steps: [{ fn: "indexRefresh", args: { mode: "full" } }],
        }),
        true,
      );
      assert.strictEqual(
        isPublicIndexRefresh("sdl.workflow", {
          repoId: "sdl-mcp",
          steps: [{ fn: "index.refresh", args: { mode: "full" } }],
        }),
        true,
      );
    });

    it("does not admit lookalike actions or workflow dry runs", () => {
      assert.strictEqual(
        isPublicIndexRefresh("sdl.repo", {
          repoId: "sdl-mcp",
          action: "repo.status",
        }),
        false,
      );
      assert.strictEqual(
        isPublicIndexRefresh("sdl.workflow", {
          repoId: "sdl-mcp",
          steps: [{ fn: "index.refresh.extra", args: { mode: "full" } }],
        }),
        false,
      );
      assert.strictEqual(
        isPublicIndexRefresh("sdl.workflow", {
          repoId: "sdl-mcp",
          dryRun: true,
          steps: [{ fn: "indexRefresh", args: { mode: "full" } }],
        }),
        false,
      );
      assert.strictEqual(
        isPublicIndexRefresh("sdl.workflow", {
          repoId: "sdl-mcp",
          dryRun: true,
          steps: [{ fn: "index.refresh", args: { mode: "full" } }],
        }),
        false,
      );
    });
  });

  describe("constructor", () => {
    it("advertises workflow instructions once in the deterministic tool catalog", async () => {
      const schema = z.object({});
      const handler = async () => ({});
      server.registerTool("tool-a", "desc-a", schema, handler);
      server.registerTool("tool-b", "desc-b", schema, handler);

      const client = new Client({ name: "test-client", version: "1.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        client.connect(clientTransport),
        server.getServer().connect(serverTransport),
      ]);

      const rawToolResults: unknown[] = [];
      const handleClientMessage = clientTransport.onmessage;
      clientTransport.onmessage = (message, extra) => {
        if (
          "result" in message &&
          message.result !== null &&
          typeof message.result === "object" &&
          "tools" in message.result
        ) {
          rawToolResults.push(message.result);
        }
        handleClientMessage?.(message, extra);
      };

      try {
        assert.strictEqual(client.getInstructions(), undefined);

        const first = await client.listTools();
        const second = await client.listTools();
        const descriptions = first.tools.map((tool) => tool.description);

        assert.strictEqual(rawToolResults.length, 2);
        assert.strictEqual(
          JSON.stringify(rawToolResults[1]),
          JSON.stringify(rawToolResults[0]),
        );
        const rawFirst = rawToolResults[0] as {
          tools: Array<Record<string, unknown>>;
        };
        assert.deepStrictEqual(Object.keys(rawFirst), ["tools"]);
        for (const tool of rawFirst.tools) {
          assert.deepStrictEqual(Object.keys(tool), [
            "name",
            "title",
            "description",
            "annotations",
            "inputSchema",
          ]);
        }

        assert.strictEqual(JSON.stringify(second), JSON.stringify(first));
        assert.deepStrictEqual(Object.keys(first), ["tools"]);
        for (const tool of first.tools) {
          assert.deepStrictEqual(Object.keys(tool), [
            "name",
            "title",
            "description",
            "inputSchema",
            "annotations",
          ]);
        }
        assert.deepStrictEqual(
          first.tools.map((tool) => tool.name),
          ["tool-a", "tool-b"],
        );
        assert.strictEqual(
          descriptions[0],
          `${SDL_MCP_SERVER_INSTRUCTIONS}\n\ndesc-a [SDL-MCP v${getPackageVersion()}]`,
        );
        assert.strictEqual(
          descriptions[1],
          `desc-b [SDL-MCP v${getPackageVersion()}]`,
        );
        assert.strictEqual(
          descriptions.filter(
            (description) =>
              description?.includes(SDL_MCP_SERVER_INSTRUCTIONS) === true,
          ).length,
          1,
        );
      } finally {
        await client.close();
      }
    });

    it("creates an MCPServer instance", () => {
      assert.ok(server);
      assert.ok(server instanceof MCPServer);
    });

    it("publishes SDL-MCP Agent Workflow instructions for session start", () => {
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /sdl-mcp-agent-workflow/);
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /repo\.status/);
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /sdl\.workflow[^\n]*repoStatus/);
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /sdl\.action\.search/);
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /sdl\.context/);
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /usageStats/);
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /outputMode: \"digest\"/);
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /outputMode: \"minimal\"/);
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /refsMode: \"off\"/);
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /short ids/);
      assert.match(
        SDL_MCP_SERVER_INSTRUCTIONS,
        /runtimeExecute executes repository tooling/i,
      );
      assert.match(
        SDL_MCP_SERVER_INSTRUCTIONS,
        /Do not use it to inspect, search, or print repository files/i,
      );
      assert.match(
        SDL_MCP_SERVER_INSTRUCTIONS,
        /sdl\.context[^\n]*sdl\.retrieve[^\n]*indexed source/i,
      );
      assert.match(
        SDL_MCP_SERVER_INSTRUCTIONS,
        /sdl\.file[^\n]*op[^\n]*read[^\n]*other files/i,
      );
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /sdl\.workflow[^\n]*responseGet/);
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /sdl\.file[^\n]*op[^\n]*write/);
      assert.match(
        SDL_MCP_SERVER_INSTRUCTIONS,
        /build[^\n]*test[^\n]*lint[^\n]*compiler/i,
      );
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /targeted edit scripts/i);
      assert.doesNotMatch(
        SDL_MCP_SERVER_INSTRUCTIONS,
        /runtimeExecute[^\n.]*(?:inspect|search|print|read)[^\n.]*(?:fallback|last resort)/i,
      );
      assert.match(
        SDL_MCP_SERVER_INSTRUCTIONS,
        /Never (?:call|run) `index\.refresh`[^\n]*explicit user approval in the current turn/,
      );
      assert.match(
        SDL_MCP_SERVER_INSTRUCTIONS,
        /directly[^\n]*`sdl\.workflow`[^\n]*`sdl-mcp index`/,
      );
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /`embeddingsDirty`/);
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /`summariesDirty`/);
      assert.match(SDL_MCP_SERVER_INSTRUCTIONS, /`PARSER_FILE_STATE_MISSING`/);
      assert.match(
        SDL_MCP_SERVER_INSTRUCTIONS,
        /Do not wait for semantic freshness or graph verification/,
      );
      assert.match(
        SDL_MCP_SERVER_INSTRUCTIONS,
        /`file\.write`[^\n]*indexed/,
      );
      assert.doesNotMatch(
        SDL_MCP_SERVER_INSTRUCTIONS,
        /do not refresh the index by habit/i,
      );
    });

    it("has gatewayMode defaulting to false", () => {
      assert.strictEqual(server.gatewayMode, false);
    });
  });

  describe("gatewayMode", () => {
    it("can be set to true", () => {
      server.gatewayMode = true;
      assert.strictEqual(server.gatewayMode, true);
    });

    it("can be toggled back to false", () => {
      server.gatewayMode = true;
      server.gatewayMode = false;
      assert.strictEqual(server.gatewayMode, false);
    });
  });

  describe("registerTool", () => {
    it("registers a tool without throwing", () => {
      const schema = z.object({ repoId: z.string() });
      const handler = async () => ({ ok: true });

      assert.doesNotThrow(() => {
        server.registerTool("sdl.test.tool", "A test tool", schema, handler);
      });
    });

    it("can register multiple tools", () => {
      const schema = z.object({});
      const handler = async () => ({});

      server.registerTool("tool-a", "desc-a", schema, handler);
      server.registerTool("tool-b", "desc-b", schema, handler);

      // No assertion beyond not throwing — internal tools Map is private
      assert.ok(true);
    });

    it("accepts optional wireSchema", () => {
      const schema = z.object({});
      const handler = async () => ({});
      const wireSchema = {
        type: "object",
        properties: { action: { type: "string" } },
      };

      assert.doesNotThrow(() => {
        server.registerTool(
          "sdl.test.wire",
          "desc",
          schema,
          handler,
          wireSchema,
        );
      });
    });
  });

  describe("clearTools", () => {
    it("does not throw when called on empty tool set", () => {
      assert.doesNotThrow(() => server.clearTools());
    });

    it("does not throw after registering tools", () => {
      server.registerTool("tool-x", "desc", z.object({}), async () => ({}));
      assert.doesNotThrow(() => server.clearTools());
    });
  });

  describe("registerPostDispatchHook", () => {
    it("accepts a hook function", () => {
      const hook = async () => {};
      assert.doesNotThrow(() => server.registerPostDispatchHook(hook));
    });

    it("accepts multiple hooks", () => {
      const hook1 = async () => {};
      const hook2 = async () => {};
      server.registerPostDispatchHook(hook1);
      server.registerPostDispatchHook(hook2);
      assert.ok(true);
    });
  });

  describe("getServer", () => {
    it("returns the underlying MCP Server instance", () => {
      const inner = server.getServer();
      assert.ok(inner, "should return a Server instance");
    });
  });

  describe("notifyToolListChanged", () => {
    it("does not throw when no client is connected", async () => {
      // With no transport connected, notification should be swallowed
      await assert.doesNotReject(server.notifyToolListChanged());
    });
  });

  describe("broad context compaction", () => {
    it("does not affect non-context tool registration", () => {
      const schema = z.object({ repoId: z.string() });
      const handler = async () => ({ results: [1, 2, 3] });

      server.registerTool("sdl.symbol.search", "Search", schema, handler);
      // Just verify registration works — the actual compaction is tested
      // in context-response-projection.test.ts
      assert.ok(server);
    });
  });
});

describe("readiness admission classification", () => {
  it("allows only the audited read-only flat and metadata tools", () => {
    const allowed = [
      "sdl.action.search",
      "sdl.manual",
      "sdl.info",
      "sdl.context",
      "sdl.symbol.search",
      "sdl.symbol.getCard",
      "sdl.slice.spillover.get",
      "sdl.pr.risk.analyze",
      "sdl.code.getSkeleton",
      "sdl.code.getHotPath",
      "sdl.repo.status",
      "sdl.repo.overview",
      "sdl.policy.get",
      "sdl.agent.feedback.query",
      "sdl.buffer.status",
      "sdl.runtime.queryOutput",
      "sdl.response.get",
      "sdl.memory.query",
      "sdl.memory.surface",
      "sdl.usage.stats",
      "sdl.file.read",
      "sdl.semantic.enrichment.status",
    ];

    for (const tool of allowed) {
      assert.equal(isReadOnlyWhenDegraded(tool, {}), true, tool);
    }
  });

  it("classifies gateway, retrieve, file, and workflow calls by action", () => {
    assert.equal(
      isReadOnlyWhenDegraded("sdl.query", { action: "symbol.search" }),
      true,
    );
    assert.equal(
      isReadOnlyWhenDegraded("sdl.code", { action: "code.getSkeleton" }),
      true,
    );
    assert.equal(
      isReadOnlyWhenDegraded("sdl.repo", { action: "repo.status" }),
      true,
    );
    assert.equal(
      isReadOnlyWhenDegraded("sdl.retrieve", { op: "symbolSearch" }),
      true,
    );
    assert.equal(
      isReadOnlyWhenDegraded("sdl.retrieve", { op: "codeHotPath" }),
      true,
    );
    assert.equal(isReadOnlyWhenDegraded("sdl.file", { op: "read" }), true);
    assert.equal(
      isReadOnlyWhenDegraded("sdl.workflow", {
        steps: [
          { fn: "symbolSearch", args: {} },
          { fn: "dataPick", args: {} },
          { fn: "responseGet", args: {} },
        ],
      }),
      true,
    );
  });

  it("fails closed for mutation, runtime, audit, malformed, and mixed calls", () => {
    const rejected: Array<[string, unknown]> = [
      ["sdl.unknown", { action: "symbol.search" }],
      ["sdl.slice.build", {}],
      ["sdl.slice.refresh", {}],
      ["sdl.delta.get", {}],
      ["sdl.query", { action: "slice.build" }],
      ["sdl.retrieve", { op: "sliceBuild" }],
      ["sdl.workflow", { steps: [{ fn: "sliceBuild", args: {} }] }],
      ["sdl.workflow", { steps: [{ fn: "deltaGet", args: {} }] }],
      ["sdl.query", {}],
      ["sdl.query", { action: "unknown.action" }],
      ["sdl.repo.register", {}],
      ["sdl.index.refresh", {}],
      ["sdl.policy.set", {}],
      ["sdl.agent.feedback", {}],
      ["sdl.buffer.push", {}],
      ["sdl.runtime.execute", {}],
      ["sdl.memory.store", {}],
      ["sdl.file.write", {}],
      ["sdl.code.needWindow", {}],
      ["sdl.retrieve", { op: "codeNeedWindow" }],
      ["sdl.file", { op: "previewWindow" }],
      ["sdl.file", { op: "searchEditPreview" }],
      ["sdl.workflow", { steps: [] }],
      ["sdl.workflow", { steps: [{ fn: "runtimeExecute", args: {} }] }],
      [
        "sdl.workflow",
        {
          steps: [
            { fn: "repoStatus", args: {} },
            { fn: "indexRefresh", args: {} },
          ],
        },
      ],
      ["sdl.workflow", { steps: [null] }],
    ];

    for (const [tool, args] of rejected) {
      assert.equal(isReadOnlyWhenDegraded(tool, args), false, tool);
    }
  });
});
