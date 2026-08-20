import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ContextEngineV2 } from "../../dist/context/engine.js";
import type {
  ContextEngineV2Result,
  ContextPayload,
  ContextV2Request,
} from "../../dist/context/types.js";
import { sessionContentLedger } from "../../dist/mcp/session-dedupe.js";
import { handleAgentContext } from "../../dist/mcp/tools/context.js";
import {
  installObservabilityTap,
  resetObservabilityTap,
  type ObservabilityTap,
  type PackedWireTapEvent,
} from "../../dist/observability/event-tap.js";
import type { ToolContext } from "../../dist/server.js";

const originalBuildContext = ContextEngineV2.prototype.buildContext;
const sessions = new Set<string>();

function contextPayload(): ContextPayload {
  return {
    status: "complete",
    taskType: "explain",
    retrieval: {
      level: "hybrid",
      lanes: [
        { id: "exactIdentifier", available: true },
        { id: "symbolFts", available: true },
      ],
    },
    evidence: [
      {
        rung: "card",
        symbolId: "symbol-a",
        path: "src/a.ts",
        rank: 1,
        tier: 0,
        lanes: ["exactIdentifier", "symbolFts"],
        content: { kind: "function", name: "symbolA" },
      },
      {
        rung: "skeleton",
        symbolId: "symbol-a",
        path: "src/a.ts",
        rank: 1,
        tier: 0,
        lanes: ["exactIdentifier", "symbolFts"],
        content: "function symbolA(): void",
      },
    ],
    edges: [],
    omitted: {
      total: 0,
      byReason: { budget: 0 },
      highestRanked: [],
    },
    nextActions: [],
  };
}

function stubEngine(
  result: ContextEngineV2Result,
  onRequest?: (request: ContextV2Request) => void,
): void {
  ContextEngineV2.prototype.buildContext = async function (
    request: ContextV2Request,
  ): Promise<ContextEngineV2Result> {
    onRequest?.(request);
    return structuredClone(result);
  };
}

function toolContext(sessionId: string): ToolContext {
  sessions.add(sessionId);
  return {
    sessionId,
    signal: new AbortController().signal,
    sendNotification: async () => undefined,
  };
}

afterEach(() => {
  ContextEngineV2.prototype.buildContext = originalBuildContext;
  for (const sessionId of sessions) {
    sessionContentLedger.clearSession(sessionId);
  }
  sessions.clear();
  resetObservabilityTap();
});

describe("sdl.context v2 handler", () => {
  it("attributes packed-wire telemetry to the validated repository", async () => {
    const events: PackedWireTapEvent[] = [];
    installObservabilityTap(new Proxy({} as ObservabilityTap, {
      get: (_target, property) => property === "packedWire"
        ? (event: PackedWireTapEvent) => events.push(event)
        : () => {},
    }));
    stubEngine(contextPayload());

    const response = await handleAgentContext({
      repoId: "repo-context",
      taskType: "explain",
      taskText: "Explain symbolA",
      budget: { maxTokens: 2048 },
      wireFormat: "packed",
    });

    assert.equal((response as Record<string, unknown>).status, "complete");
    assert.deepEqual(events.map(({ repoId }) => repoId), ["repo-context"]);
  });

  it("adapts the strict public request and returns only the canonical v2 payload", async () => {
    let captured: ContextV2Request | undefined;
    stubEngine(contextPayload(), (request) => {
      captured = request;
    });

    const response = (await handleAgentContext({
      repoId: "repo-a",
      taskType: "explain",
      taskText: "Explain symbolA",
      budget: { maxTokens: 2048 },
      focusPaths: ["src/a.ts"],
      focusSymbols: ["symbol-a"],
      chatMentions: ["symbolA"],
      includeTests: false,
      refsMode: "off",
      responseMode: "inline",
      wireFormat: "json",
    })) as Record<string, unknown>;

    assert.deepEqual(captured, {
      repoId: "repo-a",
      taskType: "explain",
      taskText: "Explain symbolA",
      budget: { maxTokens: 2048 },
      focusPaths: ["src/a.ts"],
      focusSymbols: ["symbol-a"],
      chatMentions: ["symbolA"],
      includeTests: false,
    });
    assert.equal(response.status, "complete");
    assert.equal(response.taskType, "explain");
    assert.equal(typeof response.etag, "string");
    assert.equal("taskId" in response, false);
    assert.equal("actionsTaken" in response, false);
    assert.equal("finalEvidence" in response, false);
    assert.equal("rawContext" in response, false);
    assert.equal("_rawContext" in response, false);
  });

  it("uses the canonical payload identity for conditional requests", async () => {
    stubEngine(contextPayload());
    const args = {
      repoId: "repo-a",
      taskType: "explain" as const,
      taskText: "Explain symbolA",
      budget: { maxTokens: 2048 },
      refsMode: "off" as const,
      responseMode: "inline" as const,
      wireFormat: "json" as const,
    };

    const first = (await handleAgentContext(args)) as Record<string, unknown>;
    const second = (await handleAgentContext({
      ...args,
      ifNoneMatch: first.etag,
    })) as Record<string, unknown>;

    assert.deepEqual(second, {
      notModified: true,
      etag: first.etag,
    });
  });

  it("returns deterministic structured retrieval errors without wrapping them", async () => {
    const error: ContextEngineV2Result = {
      isError: true,
      error: {
        code: "CONTEXT_RETRIEVAL_BACKEND_FAILED",
        message: "No retrieval lane completed successfully.",
        recovery: [
          {
            id: "context",
            args: {
              repoId: "repo-a",
              taskType: "explain",
              taskText: "Explain symbolA",
              budget: { maxTokens: 2048 },
            },
          },
        ],
      },
    };
    stubEngine(error);

    const response = await handleAgentContext({
      repoId: "repo-a",
      taskType: "explain",
      taskText: "Explain symbolA",
      budget: { maxTokens: 2048 },
    });

    assert.deepEqual(response, error);
  });

  it("computes the ETag before session refs and preserves evidence identity", async () => {
    stubEngine(contextPayload());
    const context = toolContext(`context-v2-refs-${process.pid}`);
    const args = {
      repoId: "repo-a",
      taskType: "explain" as const,
      taskText: "Explain symbolA",
      budget: { maxTokens: 2048 },
      refsMode: "auto" as const,
      responseMode: "inline" as const,
      wireFormat: "json" as const,
    };

    const first = (await handleAgentContext(args, context)) as Record<
      string,
      unknown
    >;
    const second = (await handleAgentContext(args, context)) as Record<
      string,
      unknown
    >;
    const secondEvidence = second.evidence as Array<Record<string, unknown>>;

    assert.equal(first.etag, second.etag);
    assert.equal(secondEvidence.length, 2);
    assert.deepEqual(secondEvidence[0], {
      rung: "card",
      symbolId: "symbol-a",
      path: "src/a.ts",
      rank: 1,
      tier: 0,
      lanes: ["exactIdentifier", "symbolFts"],
      ref: { key: "card:repo-a:symbol-a" },
      unchanged: true,
    });
    assert.equal(secondEvidence[1]?.rung, "skeleton");
    assert.deepEqual(second.sessionDelta, {
      newCards: 0,
      changedCards: 0,
      unchangedRefs: 1,
    });
  });
});
