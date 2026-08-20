import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import { MCPServer } from "../../../dist/server.js";
import {
  installObservabilityTap,
  resetObservabilityTap,
  type ObservabilityTap,
} from "../../../dist/observability/event-tap.js";
import type { ToolCallEvent } from "../../../dist/mcp/telemetry.js";
import {
  measureProjectionPair,
  measureProjectionValue,
} from "../../../dist/mcp/response-projection/measure.js";

type CallToolHandler = (
  request: {
    method: "tools/call";
    params: { name: string; arguments?: Record<string, unknown> };
  },
  extra: {
    _meta: Record<string, unknown>;
    sendNotification: () => Promise<void>;
    signal: AbortSignal;
  },
) => Promise<Record<string, unknown>>;

const CANONICAL_RESULT = Object.freeze({
  status: "complete",
  taskType: "debug",
  exitCode: 0,
  durationMs: 41,
  evidence: [{
    symbolId: "symbol:metrics",
    rung: "hotPath",
    path: "src/example.ts",
    content: { code: "function example() {}" },
  }],
  source: "canonical-source",
});

function getCallToolHandler(server: MCPServer): CallToolHandler {
  const sdkServer = server.getServer() as unknown as {
    _requestHandlers: Map<string, CallToolHandler>;
  };
  const handler = sdkServer._requestHandlers.get("tools/call");
  assert.ok(handler);
  return handler;
}

function installToolCallTap(
  callback: (event: ToolCallEvent) => void | Promise<void>,
): void {
  const tap = new Proxy({} as ObservabilityTap, {
    get: (_target, property) =>
      property === "toolCall" ? callback : () => {},
  });
  installObservabilityTap(tap);
}

async function callRuntime(
  server: MCPServer,
  detail: "compact" | "full",
  responseMode?: "inline" | "auto" | "handle",
  repoId: string | null = "test-repo",
): Promise<Record<string, unknown>> {
  return getCallToolHandler(server)(
    {
      method: "tools/call",
      params: {
        name: "sdl.manual",
        arguments: {
          ...(repoId ? { repoId } : {}),
          detail,
          ...(responseMode ? { responseMode } : {}),
        },
      },
    },
    {
      _meta: {},
      sendNotification: async () => {},
      signal: new AbortController().signal,
    },
  );
}

function runtimeServer(
  result: Record<string, unknown> = CANONICAL_RESULT,
  options: ConstructorParameters<typeof MCPServer>[0] = {},
): MCPServer {
  const server = new MCPServer(options);
  server.registerTool(
    "sdl.manual",
    "Projection metrics test tool",
    z.object({
      repoId: z.string(),
      detail: z.enum(["compact", "full"]),
      responseMode: z.enum(["inline", "auto", "handle"]).optional(),
    }),
    async () => result,
  );
  return server;
}

afterEach(() => {
  resetObservabilityTap();
});

describe("tool output projection metrics", () => {
  it("emits exact deterministic projection measurements after delivery is prepared", async () => {
    const events: ToolCallEvent[] = [];
    installToolCallTap((event) => {
      events.push(event);
    });

    const result = await callRuntime(runtimeServer(), "compact");
    const event = events[0];
    assert.ok(event?.projection);
    assert.equal(event.repoId, "test-repo");

    const raw = measureProjectionValue(CANONICAL_RESULT);
    const projected = measureProjectionValue(result.structuredContent);

    assert.equal(event.projection.rawBytes, raw.bytes);
    assert.equal(event.projection.rawTokens, raw.tokens);
    assert.equal(event.projection.projectedBytes, projected.bytes);
    assert.equal(event.projection.projectedTokens, projected.tokens);
    assert.equal(event.projection.effectiveDetail, "compact");
    assert.equal(event.projection.diagnosticsIncluded, false);
    assert.equal(event.projection.profile.observabilityProfile, "standard");
    assert.ok(event.projection.removedFieldCount > 0);
    assert.equal(event.projection.truncated, false);
    assert.equal(event.projection.responseHandled, false);
    assert.equal(event.projection.recoveryEmitted, false);
    assert.equal(event.projection.invalidRecoveryCount, 0);
  });

  it("keeps canonical operation measurements stable across compact and full projection", async () => {
    const events: ToolCallEvent[] = [];
    installToolCallTap((event) => {
      events.push(event);
    });
    const originalNow = Date.now;
    Date.now = () => 1_000;
    try {
      const server = runtimeServer();
      await callRuntime(server, "compact");
      await callRuntime(server, "full");
    } finally {
      Date.now = originalNow;
    }

    assert.equal(events.length, 2);
    assert.equal(events[0]?.durationMs, events[1]?.durationMs);
    assert.deepEqual(events[0]?.operationalStats, {
      status: "complete",
      exitCode: 0,
      durationMs: 41,
    });
    assert.deepEqual(events[1]?.operationalStats, events[0]?.operationalStats);
    assert.notEqual(
      events[0]?.projection?.projectedBytes,
      events[1]?.projection?.projectedBytes,
    );
  });

  it("does not count valid policy hints removed by compact projection as invalid", () => {
    const policyHints = [
      "requestSkeleton",
      "requestHotPath",
      "refreshSlice",
    ] as const;

    for (const nextBestAction of policyHints) {
      const canonical = { status: "complete", nextBestAction };
      const compact = measureProjectionPair(canonical, { status: "complete" });
      const full = measureProjectionPair(canonical, canonical);

      assert.equal(
        compact.invalidRecoveryCount,
        0,
        `compact policy hint ${nextBestAction}`,
      );
      assert.equal(
        full.invalidRecoveryCount,
        0,
        `full policy hint ${nextBestAction}`,
      );
    }
  });

  it("counts invalid recovery internally without exposing the invalid action", async () => {
    const events: ToolCallEvent[] = [];
    installToolCallTap((event) => {
      events.push(event);
    });
    const result = await callRuntime(
      runtimeServer(
        {
          ...CANONICAL_RESULT,
          truncated: true,
          nextAction: {
            action: "sdl.not-advertised",
            args: { source: "private-source" },
          },
        },
        {
          responseProjectionBoundaryOverrides: {
            projectValue: ({ canonicalResult }) => {
              const {
                nextAction: _invalidNextAction,
                ...projected
              } = canonicalResult as Record<string, unknown>;
              return projected;
            },
          },
        },
      ),
      "compact",
    );

    assert.equal(events[0]?.projection?.invalidRecoveryCount, 1);
    assert.doesNotMatch(JSON.stringify(result), /not-advertised|private-source/);
  });

  it("measures the final inline-too-large replacement envelope", async () => {
    const events: ToolCallEvent[] = [];
    installToolCallTap((event) => {
      events.push(event);
    });
    const oversizedResult = {
      ...CANONICAL_RESULT,
      payload: "x".repeat(100_000),
    };

    const result = await callRuntime(
      runtimeServer(oversizedResult),
      "full",
      "inline",
    );
    const event = events[0];
    assert.ok(event?.projection);
    const delivered = measureProjectionValue(result.structuredContent);
    assert.equal(event.projection.projectedBytes, delivered.bytes);
    assert.equal(event.projection.projectedTokens, delivered.tokens);
    assert.equal(event.projection.responseHandled, true);
    assert.equal(event.projection.recoveryEmitted, true);
  });

  it("measures the final response-handling failure replacement", async () => {
    const events: ToolCallEvent[] = [];
    installToolCallTap((event) => {
      events.push(event);
    });
    const server = new MCPServer();
    server.registerTool(
      "sdl.manual",
      "Response handling failure metrics test tool",
      z.object({
        detail: z.enum(["compact", "full"]),
        responseMode: z.enum(["handle"]),
      }),
      async () => CANONICAL_RESULT,
    );

    const result = await callRuntime(server, "full", "handle", null);
    const event = events[0];
    assert.ok(event?.projection);
    const delivered = measureProjectionValue(result.structuredContent);
    assert.equal(event.projection.projectedBytes, delivered.bytes);
    assert.equal(event.projection.projectedTokens, delivered.tokens);
    assert.equal(event.projection.responseHandled, true);
    assert.equal(event.projection.recoveryEmitted, false);
  });

  it("measures the final response artifact envelope returned for handle mode", async () => {
    const events: ToolCallEvent[] = [];
    installToolCallTap((event) => {
      events.push(event);
    });

    const result = await callRuntime(runtimeServer(), "full", "handle");
    const event = events[0];
    assert.ok(event?.projection);

    const delivered = measureProjectionValue(result.structuredContent);
    assert.equal(event.projection.projectedBytes, delivered.bytes);
    assert.equal(event.projection.projectedTokens, delivered.tokens);
    assert.equal(event.projection.responseHandled, true);
    assert.equal(event.projection.recoveryEmitted, true);
    const raw = measureProjectionValue(CANONICAL_RESULT);
    assert.equal(event.projection.rawBytes, raw.bytes);
    assert.equal(event.projection.rawTokens, raw.tokens);
    assert.equal(event.projection.effectiveDetail, "full");
    assert.equal(event.projection.diagnosticsIncluded, false);
    assert.equal(event.projection.profile.observabilityProfile, "standard");
  });

  it("emits exact final projection measurements for a throwing handler", async () => {
    const events: ToolCallEvent[] = [];
    installToolCallTap((event) => {
      events.push(event);
    });
    const server = new MCPServer();
    server.registerTool(
      "sdl.manual",
      "Throwing projection metrics test tool",
      z.object({
        repoId: z.string(),
        detail: z.enum(["compact", "full"]),
      }),
      async () => {
        throw new Error("handler exploded");
      },
    );

    const result = await callRuntime(server, "compact");
    const event = events[0];
    assert.equal(result.isError, true);
    assert.deepEqual(Object.keys(result), [
      "content",
      "structuredContent",
      "isError",
    ]);
    assert.ok(event?.projection);
    assert.equal(event.repoId, "test-repo");
    assert.ok(event.durationMs >= 0);
    assert.equal(event.diagnostics, undefined);
    assert.doesNotMatch(
      JSON.stringify(result),
      /nextAction|nextBestAction/,
    );
    const delivered = measureProjectionValue(result.structuredContent);
    assert.equal(event.projection.projectedBytes, delivered.bytes);
    assert.equal(event.projection.projectedTokens, delivered.tokens);
  });
});
