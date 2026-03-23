import { describe, it } from "node:test";
import assert from "node:assert";
import {
  logToolCall,
  logCodeWindowDecision,
  logIndexEvent,
  logPolicyDecision,
  logSetupPipelineEvent,
  logSummaryGenerationEvent,
  logWatcherHealthTelemetry,
  logEdgeResolutionTelemetry,
  logSemanticSearchTelemetry,
  logSummaryQualityTelemetry,
  logPrefetchTelemetry,
  logRuntimeExecution,
  type ToolCallEvent,
  type CodeWindowDecisionEvent,
  type IndexEvent,
  type PolicyDecisionEvent,
  type SetupPipelineEvent,
  type SummaryGenerationEvent,
  type WatcherHealthTelemetryEvent,
  type EdgeResolutionTelemetryEvent,
  type SemanticSearchTelemetryEvent,
  type SummaryQualityTelemetryEvent,
  type PrefetchTelemetryEvent,
  type RuntimeExecutionEvent,
} from "../../dist/mcp/telemetry.js";

/**
 * Tests for src/mcp/telemetry.ts.
 * The functions fire-and-forget audit DB writes (which may fail in test
 * env without a running DB), so we verify they don't throw synchronously
 * and that the exported types/functions exist.
 */

describe("MCP telemetry", () => {
  describe("logToolCall", () => {
    it("does not throw for success event", () => {
      const event: ToolCallEvent = {
        tool: "sdl.symbol.search",
        request: { query: "foo" },
        response: { symbols: [] },
        durationMs: 42,
        repoId: "test-repo",
      };

      assert.doesNotThrow(() => logToolCall(event));
    });

    it("does not throw for error event", () => {
      const event: ToolCallEvent = {
        tool: "sdl.symbol.search",
        request: { query: "foo" },
        response: { error: { message: "not found" } },
        durationMs: 10,
        repoId: "test-repo",
      };

      assert.doesNotThrow(() => logToolCall(event));
    });

    it("handles missing optional fields", () => {
      const event: ToolCallEvent = {
        tool: "sdl.repo.status",
        request: {},
        response: { status: "ok" },
        durationMs: 5,
      };

      assert.doesNotThrow(() => logToolCall(event));
    });
  });

  describe("logCodeWindowDecision", () => {
    it("does not throw for approved decision", () => {
      const event: CodeWindowDecisionEvent = {
        symbolId: "sym-123",
        approved: true,
        reason: ["identifiers found"],
      };

      assert.doesNotThrow(() => logCodeWindowDecision(event));
    });

    it("does not throw for denied decision", () => {
      const event: CodeWindowDecisionEvent = {
        symbolId: "sym-456",
        approved: false,
        reason: ["out of scope", "no identifiers"],
      };

      assert.doesNotThrow(() => logCodeWindowDecision(event));
    });
  });

  describe("logIndexEvent", () => {
    it("does not throw for valid index event", () => {
      const event: IndexEvent = {
        repoId: "test-repo",
        versionId: "v-001",
        stats: {
          filesScanned: 100,
          symbolsExtracted: 500,
          edgesExtracted: 200,
          durationMs: 3000,
          errors: 0,
        },
      };

      assert.doesNotThrow(() => logIndexEvent(event));
    });
  });

  describe("logPolicyDecision", () => {
    it("does not throw for valid policy decision", () => {
      const event: PolicyDecisionEvent = {
        requestType: "code.needWindow",
        repoId: "test-repo",
        symbolId: "sym-789",
        decision: "approved",
        auditHash: "abc123",
        evidenceUsed: [],
      };

      assert.doesNotThrow(() => logPolicyDecision(event));
    });

    it("does not throw with denial reasons and next best action", () => {
      const event: PolicyDecisionEvent = {
        requestType: "code.needWindow",
        repoId: "test-repo",
        decision: "denied",
        auditHash: "def456",
        evidenceUsed: [],
        deniedReasons: ["policy violation"],
        nextBestAction: {
          tool: "sdl.code.getSkeleton",
          reason: "Try skeleton first",
        } as any,
      };

      assert.doesNotThrow(() => logPolicyDecision(event));
    });
  });

  describe("logSetupPipelineEvent", () => {
    it("does not throw for valid setup event", () => {
      const event: SetupPipelineEvent = {
        repoId: "test-repo",
        nonInteractive: true,
        autoIndex: false,
        dryRun: false,
        durationMs: 1500,
        languages: ["typescript"],
        configPath: "/tmp/config.json",
      };

      assert.doesNotThrow(() => logSetupPipelineEvent(event));
    });
  });

  describe("logSummaryGenerationEvent", () => {
    it("does not throw for valid summary event", () => {
      const event: SummaryGenerationEvent = {
        repoId: "test-repo",
        query: "how does auth work",
        scope: "repo",
        format: "markdown",
        budget: 4000,
        summaryTokens: 2000,
        truncated: false,
        durationMs: 500,
      };

      assert.doesNotThrow(() => logSummaryGenerationEvent(event));
    });
  });

  describe("logWatcherHealthTelemetry", () => {
    it("does not throw for healthy watcher", () => {
      const event: WatcherHealthTelemetryEvent = {
        repoId: "test-repo",
        enabled: true,
        running: true,
        stale: false,
        errors: 0,
        queueDepth: 0,
        eventsReceived: 100,
        eventsProcessed: 100,
      };

      assert.doesNotThrow(() => logWatcherHealthTelemetry(event));
    });

    it("does not throw for unhealthy watcher", () => {
      const event: WatcherHealthTelemetryEvent = {
        repoId: "test-repo",
        enabled: true,
        running: false,
        stale: true,
        errors: 5,
        queueDepth: 10,
        eventsReceived: 50,
        eventsProcessed: 40,
      };

      assert.doesNotThrow(() => logWatcherHealthTelemetry(event));
    });
  });

  describe("logEdgeResolutionTelemetry", () => {
    it("does not throw for valid event", () => {
      const event: EdgeResolutionTelemetryEvent = {
        repoId: "test-repo",
        language: "typescript",
        precision: 0.95,
        recall: 0.9,
        f1: 0.92,
        strategyAccuracy: 0.88,
      };

      assert.doesNotThrow(() => logEdgeResolutionTelemetry(event));
    });
  });

  describe("logSemanticSearchTelemetry", () => {
    it("does not throw for valid event", () => {
      const event: SemanticSearchTelemetryEvent = {
        repoId: "test-repo",
        semanticEnabled: true,
        latencyMs: 200,
        candidateCount: 50,
        alpha: 0.7,
      };

      assert.doesNotThrow(() => logSemanticSearchTelemetry(event));
    });
  });

  describe("logSummaryQualityTelemetry", () => {
    it("does not throw for valid event", () => {
      const event: SummaryQualityTelemetryEvent = {
        repoId: "test-repo",
        provider: "anthropic",
        divergenceScore: 0.05,
        costUsd: 0.003,
      };

      assert.doesNotThrow(() => logSummaryQualityTelemetry(event));
    });
  });

  describe("logPrefetchTelemetry", () => {
    it("does not throw for valid event", () => {
      const event: PrefetchTelemetryEvent = {
        repoId: "test-repo",
        hitRate: 0.8,
        wasteRate: 0.1,
        avgLatencyReductionMs: 50,
        queueDepth: 3,
      };

      assert.doesNotThrow(() => logPrefetchTelemetry(event));
    });
  });

  describe("logRuntimeExecution", () => {
    it("does not throw for successful execution", () => {
      const event: RuntimeExecutionEvent = {
        repoId: "test-repo",
        runtime: "node",
        executable: "node",
        exitCode: 0,
        durationMs: 500,
        stdoutBytes: 1024,
        stderrBytes: 0,
        timedOut: false,
        policyDecision: "approved",
        auditHash: "hash123",
        artifactHandle: "artifact-1",
      };

      assert.doesNotThrow(() => logRuntimeExecution(event));
    });

    it("does not throw for timed-out execution", () => {
      const event: RuntimeExecutionEvent = {
        repoId: "test-repo",
        runtime: "node",
        executable: "node",
        exitCode: null,
        durationMs: 30000,
        stdoutBytes: 0,
        stderrBytes: 256,
        timedOut: true,
        policyDecision: "approved",
        auditHash: "hash456",
        artifactHandle: null,
      };

      assert.doesNotThrow(() => logRuntimeExecution(event));
    });
  });

  describe("type exports", () => {
    it("ToolCallEvent is constructible", () => {
      const event: ToolCallEvent = {
        tool: "test",
        request: {},
        response: {},
        durationMs: 0,
      };
      assert.strictEqual(event.tool, "test");
    });

    it("CodeWindowDecisionEvent is constructible", () => {
      const event: CodeWindowDecisionEvent = {
        symbolId: "s",
        approved: true,
        reason: [],
      };
      assert.strictEqual(event.symbolId, "s");
    });
  });
});
