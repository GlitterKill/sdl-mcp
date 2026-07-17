import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BROAD_VISIBLE_FIELDS,
  isBroadContextResult,
  projectBroadContextResult,
  projectCardForTask,
  projectSymbolCardEvidenceForTask,
  projectContextResultForUsageAccounting,
  projectToolResultForModelContent,
} from "../../dist/mcp/context-response-projection.js";

describe("context-response-projection", () => {
  const broadResult = {
    taskId: "task-123",
    taskType: "explain",
    actionsTaken: [{ id: "a-1", type: "getCard", status: "completed" }],
    path: { rungs: ["card"], estimatedTokens: 50 },
    finalEvidence: [
      { type: "symbolCard", reference: "sym:1", summary: "test" }],
    summary: "Task completed",
    success: true,
    metrics: { totalDurationMs: 10, totalTokens: 50 },
    answer: "# Explain Results\n\nFound 1 symbol(s).",
    nextBestAction: "none",
    retrievalEvidence: { symptomType: "taskText" },
    etag: "etag-123",
  };

  it("keeps structured metadata through broad pre-compaction", () => {
    assert.equal(BROAD_VISIBLE_FIELDS.has("etag"), true);
    assert.equal(BROAD_VISIBLE_FIELDS.has("diagnostics"), true);
    assert.equal(BROAD_VISIBLE_FIELDS.has("retrievalEvidence"), true);
  });

  describe("isBroadContextResult", () => {
    it("returns true for sdl.context broad result", () => {
      assert.equal(
        isBroadContextResult("sdl.context", broadResult),
        true,
      );
    });

    it("returns true for sdl.context broad result", () => {
      assert.equal(isBroadContextResult("sdl.context", broadResult), true);
    });

    it("returns false for non-context tools", () => {
      assert.equal(
        isBroadContextResult("sdl.symbol.search", broadResult),
        false,
      );
    });

    it("returns false for null/undefined/array", () => {
      assert.equal(isBroadContextResult("sdl.context", null), false);
      assert.equal(isBroadContextResult("sdl.context", undefined), false);
      assert.equal(isBroadContextResult("sdl.context", [1, 2]), false);
    });

    it("returns false when answer field is missing (precise mode)", () => {
      const precise = { taskId: "t-1", actionsTaken: [], success: true };
      assert.equal(isBroadContextResult("sdl.context", precise), false);
    });
  });

  describe("projectBroadContextResult", () => {
    it("keeps only visible fields for broad context", () => {
      const projected = projectBroadContextResult(
        "sdl.context",
        broadResult,
      ) as Record<string, unknown>;

      assert.equal(projected.taskId, undefined);
      assert.equal(projected.taskType, "explain");
      assert.equal(projected.success, true);
      assert.equal(projected.summary, "Task completed");
      assert.ok(projected.answer);
      assert.ok(projected.finalEvidence);
      assert.equal(projected.nextBestAction, "none");
      assert.equal(projected.etag, undefined);

      // Hidden fields
      assert.equal(projected.actionsTaken, undefined);
      assert.equal(projected.path, undefined);
      assert.equal(projected.metrics, undefined);
      assert.equal(projected.retrievalEvidence, undefined);
    });

    it("preserves error field when present", () => {
      const errorResult = { ...broadResult, error: "something broke" };
      const projected = projectBroadContextResult(
        "sdl.context",
        errorResult,
      ) as Record<string, unknown>;
      assert.equal(projected.error, "something broke");
    });

    it("preserves truncation field when present", () => {
      const truncated = {
        ...broadResult,
        truncation: {
          originalTokens: 100,
          truncatedTokens: 50,
          fieldsAffected: ["answer"],
        },
      };
      const projected = projectBroadContextResult(
        "sdl.context",
        truncated,
      ) as Record<string, unknown>;
      assert.deepEqual(projected.truncation, truncated.truncation);
    });

    it("hides _displayFooter token meter", () => {
      const withFooter = { ...broadResult, _displayFooter: "meter text" };
      const projected = projectBroadContextResult(
        "sdl.context",
        withFooter,
      ) as Record<string, unknown>;
      assert.equal(projected._displayFooter, undefined);
    });

    it("returns non-context tool results unchanged", () => {
      const result = { foo: "bar" };
      assert.strictEqual(
        projectBroadContextResult("sdl.symbol.search", result),
        result,
      );
    });

    it("returns precise-mode results unchanged", () => {
      const precise = { taskId: "t-1", actionsTaken: [], success: true };
      assert.strictEqual(
        projectBroadContextResult("sdl.context", precise),
        precise,
      );
    });

    it("is idempotent on already-compact broad payloads", () => {
      // Simulate what the context engine returns after compaction:
      // only BROAD_VISIBLE_FIELDS, no actionsTaken/path/metrics
      const compact = {
        taskId: "task-123",
        taskType: "explain",
        success: true,
        summary: "Task completed",
        answer: "# Results\n\nFound 1 symbol.",
        finalEvidence: [
          { type: "symbolCard", reference: "sym:1", summary: "test" }],
        nextBestAction: "none",
      };
      // First projection should detect it's not a broad result (no actionsTaken)
      // and return it unchanged
      const first = projectBroadContextResult("sdl.context", compact);
      assert.strictEqual(
        first,
        compact,
        "Already-compact broad payload should pass through unchanged",
      );
    });

    it("is idempotent when re-projecting a projected result", () => {
      // Project the full broad result once
      const projected = projectBroadContextResult(
        "sdl.context",
        broadResult,
      ) as Record<string, unknown>;
      // Project again — should pass through since actionsTaken was stripped
      const reprojected = projectBroadContextResult(
        "sdl.context",
        projected,
      );
      assert.strictEqual(
        reprojected,
        projected,
        "Re-projecting should return the same reference (no-op)",
      );
    });

    it("uses projected context payloads for usage accounting while preserving baseline hints", () => {
      const withRawContext = {
        ...broadResult,
        _rawContext: { rawTokens: 1000 },
      };
      const projected = projectContextResultForUsageAccounting(
        "sdl.context",
        withRawContext,
      );

      assert.notStrictEqual(projected, withRawContext);
      assert.equal(projected.actionsTaken, undefined);
      assert.equal(projected.path, undefined);
      assert.equal(projected.metrics, undefined);
      assert.equal(projected.taskId, undefined);
      assert.equal(projected.summary, undefined);
      assert.equal(projected.retrievalEvidence, undefined);
      assert.equal(projected.etag, undefined);
      assert.equal(projected.answer, broadResult.answer);
      assert.deepEqual(projected._rawContext, { rawTokens: 1000 });
    });
  });


  describe("projectCardForTask", () => {
    const fullCard = {
      symbolId: "sym-1",
      repoId: "repo-1",
      file: "src/example.ts",
      range: { startLine: 1, startCol: 0, endLine: 5, endCol: 1 },
      kind: "function",
      name: "example",
      exported: true,
      visibility: "public",
      signature: "function example(): void",
      summary: "Does example work.",
      summaryProvenance: "heuristic",
      invariants: ["input is normalized"],
      sideEffects: ["writes cache"],
      cluster: { clusterId: "c1", label: "context", memberCount: 2 },
      processes: [{ processId: "p1", label: "flow", role: "entry", depth: 0 }],
      callResolution: { calls: [] },
      deps: {
        imports: ["node:path"],
        calls: ["helper"],
        callsNote: "static calls only",
      },
      metrics: {
        fanIn: 3,
        fanOut: 2,
        churn30d: 1,
        canonicalTest: {
          file: "tests/example.test.ts",
          distance: 1,
          proximity: 1,
        },
      },
      canonicalTest: {
        file: "tests/example.test.ts",
        distance: 1,
        proximity: 1,
      },
      detailLevel: "full",
      etag: "etag-1",
      version: { ledgerVersion: "v1", astFingerprint: "fp" },
    };

    it("projects debug cards to call and runtime-relevant fields", () => {
      const projected = projectCardForTask(fullCard, "debug");

      assert.deepEqual(Object.keys(projected).sort(), [
        "canonicalTest",
        "deps",
        "file",
        "kind",
        "name",
        "range",
        "sideEffects",
        "signature",
        "summary",
        "symbolId",
      ]);
      assert.deepEqual(Object.keys(projected.deps as Record<string, unknown>), [
        "calls",
      ]);
    });

    it("projects implement cards to import and invariant fields", () => {
      const projected = projectCardForTask(fullCard, "implement");

      assert.deepEqual(Object.keys(projected).sort(), [
        "deps",
        "file",
        "invariants",
        "kind",
        "name",
        "range",
        "signature",
        "summary",
        "symbolId",
      ]);
      assert.deepEqual(Object.keys(projected.deps as Record<string, unknown>), [
        "imports",
      ]);
    });

    it("projects explain cards to summary and dependency fields", () => {
      const projected = projectCardForTask(fullCard, "explain");

      assert.deepEqual(Object.keys(projected).sort(), [
        "deps",
        "file",
        "kind",
        "name",
        "range",
        "signature",
        "summary",
        "summaryProvenance",
        "symbolId",
      ]);
      assert.deepEqual(Object.keys(projected.deps as Record<string, unknown>), [
        "imports",
        "calls",
      ]);
    });

    it("projects review cards to metric and side-effect fields", () => {
      const projected = projectCardForTask(fullCard, "review");

      assert.deepEqual(Object.keys(projected).sort(), [
        "file",
        "kind",
        "metrics",
        "name",
        "range",
        "sideEffects",
        "signature",
        "summary",
        "symbolId",
      ]);
      assert.equal("canonicalTest" in projected, false);
      assert.equal("invariants" in projected, false);
    });

    it("passes through ref, unchanged, and changedSincePrior fields", () => {
      const ref = { key: "card:r:s", etag: "e" };
      const projected = projectCardForTask(
        { ...fullCard, ref, unchanged: true, changedSincePrior: true },
        "debug",
      );

      assert.strictEqual(projected.ref, ref);
      assert.equal(projected.unchanged, true);
      assert.equal(projected.changedSincePrior, true);
    });

    it("projects symbolCard finalEvidence while preserving its envelope", () => {
      const projected = projectSymbolCardEvidenceForTask(
        {
          ...fullCard,
          type: "symbolCard",
          reference: "symbol:sym-1",
          timestamp: 123,
        },
        "implement",
      );

      assert.deepEqual(Object.keys(projected).sort(), [
        "deps",
        "file",
        "invariants",
        "kind",
        "name",
        "range",
        "reference",
        "signature",
        "summary",
        "symbolId",
        "type",
      ]);
      assert.equal(projected.type, "symbolCard");
      assert.equal(projected.reference, "symbol:sym-1");
      assert.equal("timestamp" in projected, false);
      assert.deepEqual(Object.keys(projected.deps as Record<string, unknown>), [
        "imports",
      ]);
    });
  });

  describe("projectToolResultForModelContent", () => {
    it("compacts successful workflow telemetry by default", () => {
      const projected = projectToolResultForModelContent(
        "sdl.workflow",
        {
          results: [
            {
              stepIndex: 0,
              fn: "repoStatus",
              result: {
                repoId: "sdl-mcp",
                truncated: false,
                warnings: [],
              },
              tokens: 100,
              durationMs: 12,
              status: "ok",
            },
          ],
          totalTokens: 100,
          durationMs: 12,
          etagCache: { "repo.status": "etag-1" },
          truncated: false,
        },
        {},
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        results: [
          {
            fn: "repoStatus",
            result: { repoId: "sdl-mcp" },
          },
        ],
      });
    });

    it("drops no-op runtime truncation objects in compact workflow output", () => {
      const projected = projectToolResultForModelContent(
        "sdl.workflow",
        {
          results: [
            {
              fn: "runtimeExecute",
              status: "ok",
              result: {
                status: "success",
                exitCode: 0,
                signal: null,
                artifactHandle: "runtime-1",
                truncation: {
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  totalStdoutBytes: 2,
                  totalStderrBytes: 0,
                },
              },
            },
          ],
        },
        {},
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        results: [
          {
            fn: "runtimeExecute",
            result: {
              status: "success",
              exitCode: 0,
              artifactHandle: "runtime-1",
            },
          },
        ],
      });
    });

    it("keeps actionable workflow failure context", () => {
      const projected = projectToolResultForModelContent(
        "sdl.workflow",
        {
          results: [
            {
              stepIndex: 0,
              fn: "repoStatus",
              result: null,
              tokens: 0,
              durationMs: 1,
              status: "error",
              error: "boom",
              fallbackTools: ["repo.overview"],
              failureTrace: {
                stepIndex: 0,
                fn: "repoStatus",
                status: "error",
                message: "boom",
                resolvedArgKeys: ["repoId"],
              },
            },
          ],
          durationMs: 1,
          truncated: false,
        },
        {},
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        results: [
          {
            fn: "repoStatus",
            status: "error",
            error: "boom",
            fallbackTools: ["repo.overview"],
            failureTrace: {
              stepIndex: 0,
              fn: "repoStatus",
              status: "error",
              message: "boom",
            },
          },
        ],
      });
    });

    it("keeps requested workflow trace data visible in MCP content", () => {
      const projected = projectToolResultForModelContent(
        "sdl.workflow",
        {
          results: [],
          trace: {
            steps: [{ stepIndex: 0, fn: "repoStatus" }],
            totals: { durationMs: 1, tokens: 2, stepsExecuted: 1 },
          },
        },
        { trace: { level: "verbose" } },
      ) as Record<string, unknown>;

      assert.ok(projected.trace);
    });

    it("restores workflow wrapper and child result telemetry at full detail", () => {
      const projected = projectToolResultForModelContent(
        "sdl.workflow",
        {
          results: [
            {
              stepIndex: 0,
              fn: "repoStatus",
              result: {
                repoId: "sdl-mcp",
                rootPath: ".",
                filesIndexed: 1,
                symbolsIndexed: 2,
                healthAvailable: true,
                healthComponents: { freshness: 1 },
                watcherHealth: {
                  enabled: true,
                  running: true,
                  filesWatched: 10,
                },
                serverInfo: { node: "v24.0.0" },
                derivedState: { stale: false, clustersDirty: false },
                diagnostics: { timings: { dbMs: 1 } },
                etag: "repo-etag",
                etagCache: { "repo.status": "etag-1" },
                sliceEtag: "slice-etag",
                nested: { etag: "nested-etag" },
                truncated: false,
                warnings: [],
              },
              tokens: 100,
              durationMs: 12,
              status: "ok",
            },
          ],
          totalTokens: 100,
          durationMs: 12,
          etagCache: { "repo.status": "etag-1" },
          truncated: false,
        },
        { detail: "full" },
      ) as Record<string, unknown>;

      const [step] = projected.results as Array<Record<string, unknown>>;
      assert.equal(step.stepIndex, 0);
      assert.equal(step.tokens, 100);
      assert.equal(step.durationMs, 12);
      assert.equal(step.status, "ok");
      assert.equal(projected.totalTokens, 100);
      assert.equal(projected.durationMs, 12);
      assert.equal(projected.etagCache, undefined);
      assert.equal(projected.truncated, undefined);
      assert.deepEqual(step.result, {
        repoId: "sdl-mcp",
        rootPath: ".",
        filesIndexed: 1,
        symbolsIndexed: 2,
        healthAvailable: true,
        healthComponents: { freshness: 1 },
        watcherHealth: {
          enabled: true,
          running: true,
          filesWatched: 10,
        },
        serverInfo: { node: "v24.0.0" },
        derivedState: { stale: false, clustersDirty: false },
        diagnostics: { timings: { dbMs: 1 } },
        nested: {},
        truncated: false,
        warnings: [],
      });
    });

    it("honors child workflow detail and telemetry args", () => {
      const projected = projectToolResultForModelContent(
        "sdl.workflow",
        {
          results: [
            {
              fn: "repoStatus",
              status: "ok",
              result: {
                repoId: "sdl-mcp",
                rootPath: ".",
                filesIndexed: 1,
                symbolsIndexed: 2,
                healthAvailable: true,
                healthComponents: { freshness: 1 },
                watcherHealth: { enabled: true, running: true },
                prefetchStats: { hitRate: 0.75 },
                serverInfo: { node: "v24.0.0" },
                derivedState: { stale: false, clustersDirty: false },
              },
            },
          ],
        },
        {
          steps: [
            {
              fn: "repoStatus",
              args: { detail: "standard", includeTelemetry: true },
            },
          ],
        },
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        results: [
          {
            fn: "repoStatus",
            result: {
              repoId: "sdl-mcp",
              rootPath: ".",
              filesIndexed: 1,
              symbolsIndexed: 2,
              healthAvailable: true,
              healthComponents: { freshness: 1 },
              watcherHealth: { enabled: true, running: true },
              prefetchStats: { hitRate: 0.75 },
              serverInfo: { node: "v24.0.0" },
              derivedState: { stale: false, clustersDirty: false },
            },
          },
        ],
      });
    });

    it("preserves the compact usage summary without mutating the raw result", () => {
      const raw = {
        formattedSummary: "summary",
        session: { callCount: 1 },
        history: { snapshots: [], aggregate: {} },
        wire: { packed: { encodings: 1 } },
      };

      const projected = projectToolResultForModelContent("usage.stats", raw, {});

      assert.deepEqual(projected, { formattedSummary: "summary" });
      assert.equal(raw.formattedSummary, "summary");
      assert.deepEqual(raw.session, { callCount: 1 });
    });

    it("omits only formattedSummary from full-detail usage model content", () => {
      const raw = {
        formattedSummary: "summary",
        session: { callCount: 1 },
        history: { snapshots: [], aggregate: {} },
        wire: { packed: { encodings: 1 } },
      };

      const projected = projectToolResultForModelContent(
        "sdl.usage.stats",
        raw,
        { detail: "full" },
      );

      assert.deepEqual(projected, {
        session: { callCount: 1 },
        history: { snapshots: [], aggregate: {} },
        wire: { packed: { encodings: 1 } },
      });
      assert.equal(raw.formattedSummary, "summary");
      assert.deepEqual(
        Object.keys(projected as Record<string, unknown>),
        ["session", "history", "wire"],
      );
    });

    it("omits only redundant approval fields from compact code.needWindow model content", () => {
      const raw = {
        approved: true,
        status: "approved",
        whyApproved: ["matched requested identifier"],
        estimatedTokens: 240,
        matchedIdentifiers: ["resolveTarget"],
        matchedLineNumbers: [120],
        range: { startLine: 116, startCol: 0, endLine: 124, endCol: 1 },
        continuation: { cursor: 1 },
        diagnostic: {
          whyApproved: "nested evidence",
          matchedLineNumbers: [999],
        },
      };

      const projected = projectToolResultForModelContent("code.needWindow", raw, {});

      assert.deepEqual(projected, {
        approved: true,
        status: "approved",
        matchedIdentifiers: ["resolveTarget"],
        matchedLineNumbers: [120],
        range: { startLine: 116, startCol: 0, endLine: 124, endCol: 1 },
        continuation: { cursor: 1 },
        diagnostic: {
          whyApproved: "nested evidence",
        },
      });
      assert.deepEqual(raw.whyApproved, ["matched requested identifier"]);
      assert.equal(raw.estimatedTokens, 240);
      assert.deepEqual(
        Object.keys(projected as Record<string, unknown>),
        [
          "approved",
          "status",
          "matchedIdentifiers",
          "matchedLineNumbers",
          "range",
          "continuation",
          "diagnostic",
        ],
      );
    });

    it("preserves downgraded guidance while omitting redundant fields", () => {
      const downgraded = {
        approved: false,
        status: "downgraded",
        whyApproved: [],
        estimatedTokens: 400,
        downgradedTo: "skeleton",
        reason: "raw window not required",
        nextBestAction: "Use codeSkeleton",
        matchedIdentifiers: ["resolveTarget"],
        matchedLineNumbers: [120],
        sessionRef: "s4",
        contentRef: "response-1",
      };

      const projected = projectToolResultForModelContent(
        "sdl.code.needWindow",
        downgraded,
        {},
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        approved: false,
        status: "downgraded",
        downgradedTo: "skeleton",
        reason: "raw window not required",
        nextBestAction: "Use codeSkeleton",
        matchedIdentifiers: ["resolveTarget"],
        matchedLineNumbers: [120],
        sessionRef: "s4",
        contentRef: "response-1",
      });
      assert.deepEqual(Object.keys(projected), [
        "approved",
        "status",
        "downgradedTo",
        "reason",
        "nextBestAction",
        "matchedIdentifiers",
        "matchedLineNumbers",
        "sessionRef",
        "contentRef",
      ]);
    });

    it("applies full-detail omissions only at the direct tool-result root", () => {
      const raw = {
        approved: true,
        status: "approved",
        whyApproved: ["top-level duplicate"],
        estimatedTokens: 240,
        matchedIdentifiers: ["resolveTarget"],
        matchedLineNumbers: [120],
        range: { startLine: 116, startCol: 0, endLine: 124, endCol: 1 },
        diagnostic: { whyApproved: "nested evidence" },
      };

      const projected = projectToolResultForModelContent(
        "code.needWindow",
        raw,
        { detail: "full" },
      ) as Record<string, unknown>;

      assert.deepEqual(Object.keys(projected), [
        "approved",
        "status",
        "matchedIdentifiers",
        "matchedLineNumbers",
        "range",
        "diagnostic",
      ]);
      assert.deepEqual(projected.diagnostic, {
        whyApproved: "nested evidence",
      });
      assert.equal("whyApproved" in projected, false);
      assert.equal("estimatedTokens" in projected, false);
    });

    it("keeps action search summary-only payloads in compact mode", () => {
      const projected = projectToolResultForModelContent(
        "action.search",
        {
          summary: {
            total: 2,
            byKind: { gateway: 2 },
            byNamespace: { repo: 1, symbol: 1 },
            matchedActions: ["repo.status", "symbol.search"],
          },
          tokenEstimate: 123,
        },
        { summaryOnly: true },
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        summary: {
          total: 2,
          byKind: { gateway: 2 },
          byNamespace: { repo: 1, symbol: 1 },
          matchedActions: ["repo.status", "symbol.search"],
        },
      });
    });

    it("keeps actionable schema enum values in compact action search", () => {
      const projected = projectToolResultForModelContent(
        "action.search",
        {
          actions: [
            {
              action: "runtime.execute",
              fn: "runtimeExecute",
              schemaSummary: {
                fields: [
                  {
                    name: "runtime",
                    type: "enum",
                    required: true,
                    description: "Runtime to execute",
                    default: "shell",
                    enumValues: ["shell", "node"],
                  },
                ],
              },
            },
          ],
        },
        { includeSchemas: true },
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        actions: [
          {
            action: "runtime.execute",
            fn: "runtimeExecute",
            schemaSummary: {
              fields: [
                {
                  name: "runtime",
                  type: "enum",
                  required: true,
                  default: "shell",
                  enumValues: ["shell", "node"],
                },
              ],
            },
          },
        ],
      });
    });

    it("keeps compact action schemas shallow with a stable full-schema handoff", () => {
      const raw = {
        actions: [
          {
            action: "context",
            fn: "context",
            schemaSummary: {
              fields: [
                {
                  name: "options",
                  type: "object",
                  required: false,
                  description: "Task-specific options",
                  subFields: [
                    {
                      name: "contextMode",
                      type: "enum(precise|broad)",
                      required: false,
                      enumValues: ["precise", "broad"],
                    },
                    {
                      name: "nested",
                      type: "object",
                      required: false,
                      subFields: [
                        { name: "value", type: "string", required: true },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
        nextAction: {
          action: "sdl.manual",
          args: {
            actions: ["context"],
            includeSchemas: true,
            detail: "full",
            format: "json",
          },
        },
      };

      const first = projectToolResultForModelContent(
        "sdl.action.search",
        raw,
        { detail: "compact" },
      ) as Record<string, unknown>;
      const second = projectToolResultForModelContent(
        "sdl.action.search",
        raw,
        { detail: "compact" },
      ) as Record<string, unknown>;
      const full = projectToolResultForModelContent(
        "sdl.action.search",
        raw,
        { detail: "full" },
      ) as {
        actions: Array<{
          schemaSummary: { fields: Array<Record<string, unknown>> };
        }>;
      };

      assert.deepEqual(first, {
        actions: [
          {
            action: "context",
            fn: "context",
            schemaSummary: {
              fields: [
                {
                  name: "options",
                  type: "object",
                  required: false,
                  nestedFieldCount: 2,
                },
              ],
            },
          },
        ],
        nextAction: raw.nextAction,
      });
      assert.equal(JSON.stringify(first), JSON.stringify(second));
      const fullOptions = full.actions[0]?.schemaSummary.fields.find(
        (field) => field.name === "options",
      );
      assert.ok(fullOptions);
      assert.ok(Array.isArray(fullOptions.subFields));
      assert.equal(fullOptions.subFields.length, 2);
    });

    it("keeps compact action search guidance for disabled actions", () => {
      const projected = projectToolResultForModelContent(
        "action.search",
        {
          actions: [
            {
              action: "repo.status",
              fn: "repoStatus",
              requiredParams: ["repoId"],
              disabled: true,
              disabledReason: "Disabled in config",
              tags: ["repo"],
              kind: "gateway",
              schemaSummary: {
                fields: [
                  {
                    name: "detail",
                    type: "enum",
                    required: false,
                    description: "verbosity",
                    default: "minimal",
                    enumValues: ["minimal", "standard", "full"],
                  },
                ],
              },
            },
          ],
          disabledHint: {
            count: 1,
            message: "1 action(s) are disabled.",
            actions: [{ action: "repo.status", reason: "Disabled in config" }],
          },
          schemaHint: "Tip: Add includeSchemas: true.",
          tokenEstimate: 123,
        },
        {},
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        actions: [
          {
            action: "repo.status",
            fn: "repoStatus",
            requiredParams: ["repoId"],
            disabled: true,
            disabledReason: "Disabled in config",
            schemaSummary: {
              fields: [
                {
                  default: "minimal",
                  enumValues: ["minimal", "standard", "full"],
                  name: "detail",
                  type: "enum",
                  required: false,
                },
              ],
            },
          },
        ],
        disabledHint: {
          count: 1,
          message: "1 action(s) are disabled.",
          actions: [{ action: "repo.status", reason: "Disabled in config" }],
        },
        schemaHint: "Tip: Add includeSchemas: true.",
      });
    });

    it("restores workflow telemetry when trace or diagnostics are requested", () => {
      const raw = {
        results: [
          {
            stepIndex: 0,
            fn: "repoStatus",
            result: {
              repoId: "sdl-mcp",
              rootPath: ".",
              filesIndexed: 1,
              symbolsIndexed: 2,
              watcherHealth: {
                enabled: true,
                running: true,
                filesWatched: 10,
              },
              serverInfo: { node: "v24.0.0" },
              derivedState: { stale: false, clustersDirty: false },
            },
            tokens: 100,
            durationMs: 12,
            status: "ok",
          },
        ],
        totalTokens: 100,
        durationMs: 12,
        etagCache: { "repo.status": "etag-1" },
        truncated: false,
      };

      for (const args of [
        { trace: { level: "summary" } },
        { includeDiagnostics: true },
        { includeTelemetry: true },
      ]) {
        const projected = projectToolResultForModelContent(
          "sdl.workflow",
          raw,
          args,
        ) as Record<string, unknown>;
        const [step] = projected.results as Array<Record<string, unknown>>;

        assert.equal(step.stepIndex, 0);
        assert.equal(step.tokens, 100);
        assert.equal(step.durationMs, 12);
        assert.equal(step.status, "ok");
        assert.equal(projected.totalTokens, 100);
        assert.equal(projected.durationMs, 12);
        assert.equal(projected.etagCache, undefined);
        assert.deepEqual(step.result, {
          repoId: "sdl-mcp",
          filesIndexed: 1,
          symbolsIndexed: 2,
          derivedState: { stale: false },
        });
      }
    });

    it("removes requested symbol and slice debug fields in compact mode", () => {
      const symbolSearch = projectToolResultForModelContent(
        "symbol.search",
        {
          results: [
            {
              symbolId: "sym-1",
              name: "target",
              repoId: "sdl-mcp",
              shortId: "abc123",
              relevance: 0.987654,
              retrievalEvidence: [{ reason: "debug" }],
              pprBoosts: { inbound: 1 },
            },
          ],
          truncation: false,
          _packedStats: { tokens: 10 },
        },
        {},
      ) as Record<string, unknown>;

      assert.deepEqual(symbolSearch, {
        results: [{ symbolId: "sym-1", name: "target" }],
      });

      const slice = projectToolResultForModelContent(
        "slice.build",
        {
          slice: {
            symbols: ["sym-1"],
            budget: { maxCards: 12 },
          },
          lease: "lease-1",
          sliceEtag: "etag-1",
          retrievalEvidence: [{ reason: "debug" }],
          symptomType: "debug",
          _packedStats: { tokens: 10 },
          symbolIndex: { "sym-1": 0 },
          confidenceDistribution: { high: 1 },
          detailLevelMetadata: { level: "debug" },
          staleSymbols: [],
        },
        {},
      ) as Record<string, unknown>;

      assert.deepEqual(slice, {
        slice: { symbols: ["sym-1"] },
      });
    });

    it("projects noisy workflow repoStatus child results with repo status rules", () => {
      const rawRepoStatus = {
        repoId: "sdl-mcp",
        rootPath: ".",
        filesIndexed: 1,
        symbolsIndexed: 2,
        etag: "repo-etag",
        healthAvailable: true,
        healthComponents: { freshness: 1 },
        watcherHealth: {
          enabled: true,
          running: true,
          filesWatched: 10,
          eventsReceived: 20,
          watchmanVersion: "2026.1",
        },
        prefetchStats: { hitRate: 1 },
        serverInfo: { node: "v24.0.0" },
        derivedState: {
          stale: false,
          clustersDirty: false,
        },
      };
      const projected = projectToolResultForModelContent(
        "sdl.workflow",
        {
          results: [
            {
              fn: "repoStatus",
              status: "ok",
              result: rawRepoStatus,
            },
          ],
        },
        {},
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        results: [
          {
            fn: "repoStatus",
            result: {
              repoId: "sdl-mcp",
              filesIndexed: 1,
              symbolsIndexed: 2,
              healthAvailable: true,
              derivedState: { stale: false },
            },
          },
        ],
      });
      assert.deepEqual(rawRepoStatus.watcherHealth, {
        enabled: true,
        running: true,
        filesWatched: 10,
        eventsReceived: 20,
        watchmanVersion: "2026.1",
      });
      assert.deepEqual(rawRepoStatus.prefetchStats, { hitRate: 1 });
      assert.deepEqual(rawRepoStatus.serverInfo, { node: "v24.0.0" });
    });

    it("keeps repo status telemetry at standard detail", () => {
      const projected = projectToolResultForModelContent(
        "repo.status",
        {
          repoId: "sdl-mcp",
          healthAvailable: true,
          healthComponents: { freshness: 1 },
          prefetchStats: { wasteRate: 0 },
        },
        { detail: "standard" },
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        repoId: "sdl-mcp",
        healthAvailable: true,
        healthComponents: { freshness: 1 },
        prefetchStats: { wasteRate: 0 },
      });
    });

    it("keeps delta.get delta payload while hiding amplifiers by default", () => {
      const projected = projectToolResultForModelContent(
        "delta.get",
        {
          delta: {
            repoId: "sdl-mcp",
            fromVersion: "v1",
            toVersion: "v2",
            changedSymbols: [{ symbolId: "sym-1" }],
            blastRadius: [],
          },
          amplifiers: [{ symbolId: "sym-2" }],
          blastRadiusTruncated: false,
        },
        {},
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        delta: {
          repoId: "sdl-mcp",
          fromVersion: "v1",
          toVersion: "v2",
          changedSymbols: [{ symbolId: "sym-1" }],
          blastRadius: [],
        },
      });
    });

    it("hides edit precondition fields for edit tools", () => {
      const projected = projectToolResultForModelContent(
        "search.edit",
        {
          planHandle: "plan-1",
          preconditionSnapshot: {
            sha256: "abc",
            mtimeMs: 123,
            astFingerprint: "ast-1",
          },
          expiresAt: "2026-01-01T00:00:00.000Z",
        },
        {},
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        planHandle: "plan-1",
      });
    });

    it("hides edit precondition fields even at full detail", () => {
      const projected = projectToolResultForModelContent(
        "search.edit",
        {
          mode: "preview",
          planHandle: "se-test",
          preconditionSnapshot: [{ file: "a.ts", sha256: "abc", mtimeMs: 1 }],
          fileEntries: [
            {
              file: "a.ts",
              astFingerprint: "fp",
              expectedRange: { startLine: 1, endLine: 2 },
            },
          ],
        },
        { detail: "full" },
      ) as Record<string, unknown>;

      assert.equal("preconditionSnapshot" in projected, false);
      const entry = (projected.fileEntries as Array<Record<string, unknown>>)[0];
      assert.equal("astFingerprint" in entry, false);
      assert.equal("expectedRange" in entry, false);
    });

    it("hides file edit preconditions in real workflow child results", () => {
      const projected = projectToolResultForModelContent(
        "sdl.workflow",
        {
          results: [
            {
              fn: "file",
              status: "ok",
              result: {
                planHandle: "plan-1",
                mode: "preview",
                sha256: "abc",
                mtimeMs: 123,
                astFingerprint: "ast-1",
                expiresAt: "2026-01-01T00:00:00.000Z",
                _packedStats: { tokens: 1 },
              },
            },
          ],
        },
        {
          steps: [
            {
              fn: "file",
              args: { op: "searchEditPreview" },
            },
          ],
        },
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        results: [
          {
            fn: "file",
            result: {
              planHandle: "plan-1",
              mode: "preview",
            },
          },
        ],
      });
    });

    it("hides file edit preconditions in full-detail workflow child results", () => {
      const projected = projectToolResultForModelContent(
        "sdl.workflow",
        {
          results: [
            {
              fn: "file",
              status: "ok",
              result: {
                planHandle: "plan-1",
                mode: "preview",
                preconditionSnapshot: [{ file: "a.ts", sha256: "abc", mtimeMs: 123 }],
                sha256: "abc",
                mtimeMs: 123,
                astFingerprint: "ast-1",
                expiresAt: "2026-01-01T00:00:00.000Z",
              },
            },
          ],
        },
        {
          detail: "full",
          steps: [
            {
              fn: "file",
              args: { op: "searchEditPreview" },
            },
          ],
        },
      ) as Record<string, unknown>;

      const child = (projected.results as Array<Record<string, unknown>>)[0]
        .result as Record<string, unknown>;
      assert.equal("preconditionSnapshot" in child, false);
      assert.equal("sha256" in child, false);
      assert.equal("mtimeMs" in child, false);
      assert.equal("astFingerprint" in child, false);
    });

    it("hides top-level symbol card fingerprint fields from model content", () => {
      const projected = projectToolResultForModelContent(
        "symbol.getCard",
        {
          symbolId: "sym-1",
          name: "target",
          etag: "etag-1",
          astFingerprint: "ast-1",
          sha256: "abc",
          mtimeMs: 123,
          detailLevel: "full",
        },
        {},
      ) as Record<string, unknown>;

      assert.deepEqual(projected, {
        symbolId: "sym-1",
        name: "target",
      });
    });

    it("keeps action search token estimates in compact model content", () => {
      const projected = projectToolResultForModelContent(
        "sdl.action.search",
        {
          actions: [
            {
              action: "symbol.search",
              fn: "symbolSearch",
              requiredParams: ["query"],
              estTokens: 150,
              schemaSummary: {
                fields: [{ path: "query", type: "string", required: true }],
              },
            },
          ],
        },
        { detail: "compact" },
      ) as { actions: Array<Record<string, unknown>> };

      assert.equal(projected.actions[0].estTokens, 150);
    });

    it("keeps answer-first fields in compact context model content", () => {
      const projected = projectToolResultForModelContent(
        "sdl.context",
        {
          answer: "composed answer",
          confidence: "medium",
          evidence: [
            {
              symbolId: "sym-1",
              name: "target",
              file: "src/a.ts",
              why: "entry symbol",
            },
          ],
          expand: {
            hint: "call sdl.context without answerFirst, or symbol.getCard on evidence ids",
          },
          etag: "etag-1",
        },
        {},
      ) as Record<string, unknown>;

      assert.equal(projected.answer, "composed answer");
      assert.equal(projected.confidence, "medium");
      assert.deepEqual(projected.evidence, [
        {
          symbolId: "sym-1",
          name: "target",
          file: "src/a.ts",
          why: "entry symbol",
        },
      ]);
      assert.deepEqual(projected.expand, {
        hint: "call sdl.context without answerFirst, or symbol.getCard on evidence ids",
      });
    });

    it("keeps the answer-first fallback marker in compact context model content", () => {
      const projected = projectToolResultForModelContent(
        "sdl.context",
        {
          taskType: "explain",
          success: true,
          finalEvidence: [],
          answerFirstFallback: "insufficient-summary-coverage",
        },
        {},
      ) as Record<string, unknown>;

      assert.equal(
        projected.answerFirstFallback,
        "insufficient-summary-coverage",
      );
    });

    it("does not run action-search validation errors through the success projector", () => {
      const errorResult = {
        error: {
          message: "Invalid tool arguments:\n  - limit: Too small",
          code: "VALIDATION_ERROR",
          details: [{ path: "limit", message: "Too small" }],
        },
      };

      assert.deepEqual(
        projectToolResultForModelContent(
          "sdl.action.search",
          errorResult,
          { detail: "compact" },
        ),
        errorResult,
      );
    });

    it("continues to hide trace-like internal fields from other tools", () => {
      const projected = projectToolResultForModelContent(
        "sdl.context",
        { success: true, trace: { internal: true } },
        {},
      ) as Record<string, unknown>;

      assert.equal(projected.trace, undefined);
    });
  });
});
