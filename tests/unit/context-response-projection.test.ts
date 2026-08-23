import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  projectCompatibilityValue,
  projectModelValue,
  projectResultForUsageAccounting,
  projectToolResultForModelContent,
  projectWorkflowChildResultForModel,
} from "../../dist/mcp/context-response-projection.js";

describe("context-response-projection", () => {
  it("projects canonical v2 context without retaining internal accounting fields", () => {
    const rawContext = { rawTokens: 512 };
    const result = {
      status: "complete",
      taskType: "explain",
      retrieval: {
        mode: "hybrid",
        lanesUsed: ["lexical", "graph"],
        coveragePermille: 1000,
        confidencePermille: 900,
      },
      evidence: [{
        symbolId: "sym:1",
        rung: "card",
        content: {
          symbolId: "sym:1",
          name: "example",
          file: "src/example.ts",
        },
      }],
      edges: [],
      omitted: {
        tier0: [],
        tier1Count: 0,
        optionalRungCount: 0,
      },
      nextActions: [],
      etag: "etag-1",
      _packedStats: { rawBytes: 100 },
      _rawContext: rawContext,
    };

    const projected = projectToolResultForModelContent(
      "sdl.context",
      result,
    ) as Record<string, unknown>;
    assert.deepEqual(projected, {
      status: "complete",
      taskType: "explain",
      evidence: result.evidence,
    });

    const accounting = projectResultForUsageAccounting(
      "sdl.context",
      result,
    );
    assert.deepEqual(accounting, { ...projected, _rawContext: rawContext });
  });

  it("projects continuation data through the generic workflow path", () => {
    const result = {
      data: {
        status: "complete",
        evidence: [{ symbolId: "sym:1", rung: "card" }],
        generatedAt: "2026-07-27T00:00:00.000Z",
        etag: "etag-1",
        _rawContext: { rawTokens: 128 },
      },
    };

    const projected = projectWorkflowChildResultForModel(
      "workflowContinuationGet",
      result,
      {},
      {},
    );
    assert.deepEqual(projected, {
      data: {
        status: "complete",
        evidence: [{ symbolId: "sym:1", rung: "card" }],
      },
    });
    assert.deepEqual(result.data.evidence, [{
      symbolId: "sym:1",
      rung: "card",
    }]);
  });

  it("compacts workflow telemetry unless explicitly requested", () => {
    const result = {
      results: [{
        stepIndex: 0,
        fn: "repoStatus",
        status: "ok",
        tokens: 40,
        durationMs: 5,
        result: {
          repoId: "repo-1",
          status: "ready",
          graphIntegrityState: "verified",
          lastIndexedAt: "2026-07-27T00:00:00.000Z",
        },
      }],
      totalTokens: 40,
      durationMs: 5,
    };

    assert.deepEqual(
      projectToolResultForModelContent("sdl.workflow", result),
      {
        results: [{
          fn: "repoStatus",
          result: {
            repoId: "repo-1",
          },
        }],
      },
    );

    const detailed = projectToolResultForModelContent(
      "sdl.workflow",
      result,
      { includeTelemetry: true },
    ) as Record<string, unknown>;
    assert.equal(detailed.totalTokens, 40);
    assert.equal(detailed.durationMs, 5);
  });

  it("preserves action-search paging metadata in stable key order", () => {
    const projected = projectToolResultForModelContent("sdl.action.search", {
      actions: [{ action: "repo.status" }],
      total: 46,
      hasMore: true,
      tokenEstimate: 100,
      offset: 0,
      limit: 50,
      nextOffset: 1,
    }) as Record<string, unknown>;

    assert.deepEqual(Object.keys(projected), [
      "actions",
      "total",
      "hasMore",
      "offset",
      "limit",
      "nextOffset",
      "nextAction",
    ]);
    assert.equal(projected.nextOffset, 1);
  });

  it("preserves focused-path recovery details for context errors", () => {
    const focusPath = "scripts/run-isolated-mutating-qa.mjs";
    const args = {
      repoId: "repo",
      taskType: "explain",
      taskText: "Explain parseArgs",
      budget: { maxTokens: 1_000 },
      focusPaths: [focusPath],
      focusSymbols: ["parseArgs"],
    };
    const completeError = {
      isError: true,
      error: {
        code: "CONTEXT_FOCUS_PATH_UNAVAILABLE",
        message: `Exact focus path is indexed but has no available symbols: ${focusPath}`,
        recovery: [
          { id: "index.refresh", args: { mode: "incremental" } },
          { id: "context", args },
        ],
      },
    };

    const projected = projectToolResultForModelContent(
      "sdl.context",
      completeError,
      args,
    ) as typeof completeError;

    assert.equal(projected.error.code, "CONTEXT_FOCUS_PATH_UNAVAILABLE");
    assert.match(projected.error.message, new RegExp(focusPath));
    assert.deepEqual(projected.error.recovery, [
      { id: "index.refresh", args: { mode: "incremental" } },
      {
        id: "context",
        args: {
          taskType: "explain",
          taskText: "Explain parseArgs",
          budget: { maxTokens: 1_000 },
          focusPaths: [focusPath],
          focusSymbols: ["parseArgs"],
        },
      },
    ]);
  });

  it("keeps the compatibility facade aligned with dispatcher-owned projection", () => {
    const canonical = {
      status: "complete",
      evidence: [{ symbolId: "sym:dispatcher", rung: "card" }],
      diagnostics: { timings: { totalMs: 12 } },
      etag: "hidden-etag",
    };
    const input = {
      canonicalResult: canonical,
      action: "sdl.context",
      profile: {
        projector: "generic",
        observabilityProfile: "standard",
        defaultDetail: "compact" as const,
        budgetClass: "compact" as const,
        largeResponseStrategy: "truncate" as const,
        recoveryPolicy: "none" as const,
      },
      options: { detail: "compact" as const, includeDiagnostics: false },
      context: { toolName: "sdl.context", requestArgs: {} },
    };

    assert.deepEqual(
      projectToolResultForModelContent("sdl.context", canonical),
      projectModelValue(input, projectCompatibilityValue),
    );
  });

  it("is idempotent and does not mutate canonical input", () => {
    const canonical = {
      status: "complete",
      taskType: "explain",
      evidence: [{ symbolId: "sym:1", rung: "card" }],
      diagnostics: { timings: { totalMs: 12 } },
      _rawContext: { rawTokens: 128 },
    };
    const original = structuredClone(canonical);
    const first = projectToolResultForModelContent("sdl.context", canonical);
    const second = projectToolResultForModelContent("sdl.context", first);

    assert.deepEqual(second, first);
    assert.deepEqual(canonical, original);
  });

  it("keeps validation errors out of success-only projectors", () => {
    const error = {
      error: {
        code: "INVALID_ARGS",
        message: "Unknown key: options",
      },
      diagnostics: { ignored: true },
    };

    assert.deepEqual(
      projectToolResultForModelContent("sdl.action.search", error),
      { error: error.error },
    );
  });
  it("keeps compact workflow failures single-sourced and ordered", () => {
    const projected = projectToolResultForModelContent("sdl.workflow", {
      results: [{
        stepIndex: 3,
        fn: "repoStatus",
        status: "error",
        result: { status: "failure", error: { message: "failed once" }, fallbackTools: ["sdl.repo.status"] },
        tokens: 0,
        durationMs: 9,
        error: "failed once",
        fallbackTools: ["sdl.repo.status"],
        failureTrace: { stepIndex: 3, fn: "repoStatus", status: "error", message: "failed once", fallbackTools: ["sdl.repo.status"] },
        nextAction: { action: "repo.status", args: { repoId: "repo" } },
      }],
    }, { repoId: "repo", detail: "compact" }) as { results: Array<Record<string, unknown>> };

    assert.deepEqual(Object.keys(projected.results[0]), ["stepIndex", "fn", "status", "error", "nextAction"]);
    assert.equal((JSON.stringify(projected.results[0]).match(/failed once/g) ?? []).length, 1);
  });
});
