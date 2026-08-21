import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { projectToolResultForModelContent } from "../../dist/mcp/context-response-projection.js";

import {
  PolicySetRequestSchema,
  PRRiskAnalysisRequestSchema,
  RepoRegisterRequestSchema,
  SemanticEnrichmentStatusRequestSchema,
  type SearchEditPreviewResponse,
  type SearchEditApplyResponse,
  type SymbolEditPreviewResponse,
} from "../../dist/mcp/tools.js";
import { _runtimeToolTesting } from "../../dist/mcp/tools/runtime.js";
import { classifyRuntimeStatus } from "../../dist/runtime/executor.js";
import {
  compactSemanticEnrichmentStatusForAgent,
} from "../../dist/mcp/tools/semantic-enrichment.js";
import {
  _prRiskToolTesting,
  compactPRRiskResponse,
} from "../../dist/mcp/tools/prRisk.js";
import { compactBufferStatusForAgent } from "../../dist/mcp/tools/buffer.js";
import { _policyToolTesting } from "../../dist/mcp/tools/policy.js";
import {
  projectExclusiveCodeModeRecovery,
  withExclusiveCodeModeRecoveryProjection,
} from "../../dist/code-mode/action-reference-projection.js";
import { WorkflowOutputSchema } from "../../dist/code-mode/types.js";
import {
  createPolicyDenial,
  ValidationError,
  errorToMcpResponse,
} from "../../dist/mcp/errors.js";
import {
  buildHotPathPagingRecovery,
  buildValidatedRecoveryAction,
} from "../../dist/mcp/response-projection/recovery.js";
import {
  extractRuntimeObservability,
  projectRuntimeValue,
} from "../../dist/mcp/response-projection/projectors/runtime.js";

describe("agent-facing SDL tool contracts", () => {
  it("policy.set patches preserve only user-supplied policy keys", () => {
    assert.deepEqual(
      PolicySetRequestSchema.parse({ repoId: "r", policyPatch: {} }).policyPatch,
      {},
    );
    assert.deepEqual(
      PolicySetRequestSchema.parse({
        repoId: "r",
        policyPatch: { defaultDenyRaw: false },
      }).policyPatch,
      { defaultDenyRaw: false },
    );
  });


  it("policy.set budgetCaps patches preserve unspecified nested caps", () => {
    const merged = _policyToolTesting.mergePolicyOverrides(
      {
        defaultDenyRaw: true,
        budgetCaps: { maxCards: 10, maxEstimatedTokens: 5000 },
      },
      { budgetCaps: { maxCards: 20 } },
    );

    assert.deepEqual(merged.budgetCaps, {
      maxCards: 20,
      maxEstimatedTokens: 5000,
    });
  });

  it("pr.risk.analyze accepts fractional thresholds documented as numbers", () => {
    const parsed = PRRiskAnalysisRequestSchema.parse({
      repoId: "r",
      fromVersion: "v1",
      toVersion: "v2",
      riskThreshold: 0.5,
    });

    assert.equal(parsed.riskThreshold, 0.5);
  });

  it("agent-noisy tools default to compact detail and bounded output", () => {
    assert.equal(
      PRRiskAnalysisRequestSchema.parse({
        repoId: "r",
        fromVersion: "v1",
        toVersion: "v2",
      }).detail,
      "compact",
    );
    assert.equal(
      PRRiskAnalysisRequestSchema.parse({
        repoId: "r",
        fromVersion: "v1",
        toVersion: "v2",
      }).limit,
      5,
    );

    const semanticStatus = SemanticEnrichmentStatusRequestSchema.parse({
      repoId: "r",
    });
    assert.equal(semanticStatus.detail, "compact");
    assert.equal(semanticStatus.limit, 5);

    const repoRegister = RepoRegisterRequestSchema.parse({
      repoId: "r",
      rootPath: ".",
      dryRun: true,
    });
    assert.equal(repoRegister.detail, "compact");
  });

  it("projects healthy, degraded, and blocked repository status fixtures", () => {
    const base = {
      repoId: "repo",
      rootAvailability: { status: "available" },
      latestVersionId: "v1",
      filesIndexed: 12,
      symbolsIndexed: 34,
    };
    const cases = [
      {
        label: "healthy graph with non-blocking semantic staleness",
        canonical: {
          ...base,
          rootPath: "C:\\private\\repo",
          countNotes: { filesIndexed: "files", symbolsIndexed: "symbols" },
          healthAvailable: true,
          watcherHealth: {
            enabled: true, running: true, provider: "watchman",
            configuredProvider: "auto", fallbackReason: null,
            errors: 0, queueDepth: 0, stale: false,
          },
          derivedState: {
            stale: true, structuralStale: false, semanticStale: true,
            clustersDirty: false, processesDirty: false,
            algorithmsDirty: false, summariesDirty: false, embeddingsDirty: true,
            targetVersionId: "v1", computedVersionId: "v1", lastError: null,
            graphIntegrityState: "verified", graphIntegrityVersionId: "v1",
            graphIntegrityRevision: 8, graphIntegrityVerifiedRevision: 8,
            graphIntegrityDigest: "a".repeat(64),
            nextBestAction:
              "Semantic derived state is not yet ready. Continue with available retrieval lanes; do not run incremental indexing solely for summariesDirty or embeddingsDirty.",
          },
        },
        expected: {
          ...base,
          derivedState: {
            semanticStale: true,
            embeddingsDirty: true,
            graphIntegrityState: "verified",
            nextBestAction:
              "Semantic derived state is not yet ready. Continue with available retrieval lanes; do not run incremental indexing solely for summariesDirty or embeddingsDirty.",
          },
        },
      },
      {
        label: "degraded graph reports background verification",
        canonical: {
          ...base,
          latestVersionId: "v2",
          watcherHealth: {
            enabled: true, running: false, provider: "watchman",
            configuredProvider: "auto", fallbackReason: "watchman unavailable",
            errors: 2, queueDepth: 0, stale: true,
          },
          derivedState: {
            stale: true, structuralStale: true, semanticStale: false,
            clustersDirty: false, processesDirty: false,
            algorithmsDirty: true, summariesDirty: false, embeddingsDirty: false,
            targetVersionId: "v2", computedVersionId: "v1",
            graphIntegrityState: "verifying", graphIntegrityVersionId: "v1",
            graphIntegrityRevision: 9, graphIntegrityVerifiedRevision: 8,
            graphIntegrityDigest: "b".repeat(64),
            nextBestAction:
              "Graph integrity verification is running in the background. Continue using graph reads and check sdl.repo.status later; do not start a refresh solely for this state.",
          },
        },
        expected: {
          ...base,
          latestVersionId: "v2",
          watcherHealth: {
            running: false, fallbackReason: "watchman unavailable",
            errors: 2, stale: true,
          },
          derivedState: {
            stale: true, structuralStale: true, algorithmsDirty: true,
            graphIntegrityState: "verifying",
            nextBestAction:
              "Graph integrity verification is running in the background. Continue using graph reads and check sdl.repo.status later; do not start a refresh solely for this state.",
          },
        },
      },
      {
        label: "blocked root",
        canonical: {
          ...base,
          rootAvailability: {
            status: "missing",
            nextBestAction: "Restore the repository root.",
          },
          latestVersionId: null, filesIndexed: 0, symbolsIndexed: 0,
          healthAvailable: false, watcherHealth: null, derivedState: null,
        },
        expected: {
          repoId: "repo",
          rootAvailability: {
            status: "missing",
            nextBestAction: "Restore the repository root.",
          },
          healthAvailable: false,
        },
      },
    ];
    for (const fixture of cases) {
      assert.deepEqual(
        projectToolResultForModelContent(
          "sdl.repo.status", fixture.canonical, { detail: "compact" },
        ),
        fixture.expected,
        fixture.label,
      );
    }
  });

  it("projects idle/nonempty buffers and no/some feedback without placeholders", () => {
    const cases = [
      {
        label: "idle buffer",
        action: "sdl.buffer.status",
        canonical: {
          repoId: "repo", enabled: true, pendingBuffers: 0, dirtyBuffers: 0,
          parseQueueDepth: 0, checkpointPending: false,
          lastBufferEventAt: null, lastCheckpointAt: null,
          reconcileQueueDepth: 0, reconcileInflight: false,
        },
        expected: { repoId: "repo", enabled: true, state: "idle" },
      },
      {
        label: "nonempty buffer",
        action: "sdl.buffer.status",
        canonical: {
          repoId: "repo", enabled: true, pendingBuffers: 2, dirtyBuffers: 1,
          parseQueueDepth: 0, checkpointPending: true,
          lastBufferEventAt: null, lastCheckpointAt: null,
          lastCheckpointError: "checkpoint failed",
          reconcileQueueDepth: 0, reconcileInflight: true,
        },
        expected: {
          repoId: "repo", enabled: true, state: "active",
          pendingBuffers: 2, dirtyBuffers: 1, checkpointPending: true,
          lastCheckpointError: "checkpoint failed", reconcileInflight: true,
        },
      },
      {
        label: "no feedback",
        action: "sdl.agent.feedback.query",
        canonical: {
          repoId: "repo", feedback: [],
          aggregatedStats: {
            totalFeedback: 0, topUsefulSymbols: [], topMissingSymbols: [],
          },
          hasMore: false,
        },
        expected: { repoId: "repo", state: "empty" },
      },
      {
        label: "some feedback",
        action: "sdl.agent.feedback.query",
        canonical: {
          repoId: "repo",
          feedback: [{
            feedbackId: "feedback-1", versionId: "v1", sliceHandle: "slice-1",
            usefulSymbols: ["sym-useful"], missingSymbols: [], taskTags: null,
            taskType: "review", taskText: null,
            createdAt: "2026-08-09T00:00:00.000Z",
          }],
          aggregatedStats: {
            totalFeedback: 2,
            topUsefulSymbols: [{ symbolId: "sym-useful", count: 2 }],
            topMissingSymbols: [],
          },
          hasMore: true,
        },
        expected: {
          repoId: "repo", state: "available",
          feedback: [{ usefulSymbols: ["sym-useful"], taskType: "review" }],
          aggregatedStats: {
            totalFeedback: 2,
            topUsefulSymbols: [{ symbolId: "sym-useful", count: 2 }],
          },
          hasMore: true,
        },
      },
    ];
    for (const fixture of cases) {
      assert.deepEqual(
        projectToolResultForModelContent(
          fixture.action, fixture.canonical, { detail: "compact" },
        ),
        fixture.expected,
        fixture.label,
      );
    }
  });

  it("projects unavailable/healthy semantic state and zero/nonzero usage", () => {
    const semanticRun = {
      runId: "semantic-run-1", repoId: "repo", providerType: "scip",
      providerId: "scip", languages: ["typescript"], status: "completed",
      startedAt: "2026-08-09T00:00:00.000Z",
      finishedAt: "2026-08-09T00:00:01.000Z",
      documentsProcessed: 4, symbolsMatched: 8, edgesCreated: 5,
      edgesUpgraded: 0, edgesReplaced: 0, edgesSkipped: 0,
      diagnosticsCount: 2, precisionScore: 0.9,
      precisionMeasurement: "measured", precisionBasis: "operational-composite",
      metadataJson:
        '{"diagnosticsBySeverity":{"error":0,"warning":2,"information":0,"hint":0}}',
    };
    const cases = [
      {
        label: "semantic unavailable",
        action: "sdl.semantic.enrichment.status",
        canonical: {
          ok: true, repoId: "repo", enabled: false,
          autoRunOnIndexRefresh: false, installPolicy: "never",
          selections: [], lastRuns: [],
        },
        expected: { ok: true, enabled: false, availability: "unavailable" },
      },
      {
        label: "semantic healthy",
        action: "sdl.semantic.enrichment.status",
        canonical: {
          ok: true, repoId: "repo", enabled: true,
          autoRunOnIndexRefresh: true, installPolicy: "never",
          selections: [{
            languageId: "typescript",
            selected: {
              providerType: "scip", providerId: "scip", canAffectPass2: true,
            },
            skipped: [{ providerType: "lsp", reason: "unavailable" }],
          }],
          lastRuns: [semanticRun],
        },
        expected: {
          ok: true, enabled: true, availability: "available",
          selections: [{
            languageId: "typescript", providerType: "scip", providerId: "scip",
          }],
          latestRun: {
            providerType: "scip", providerId: "scip",
            languages: ["typescript"], status: "completed",
            symbolsMatched: 8, edgesCreated: 5, diagnosticsCount: 2,
            precisionScore: 0.9,
          },
          warnings: { skippedProviders: 1, diagnostics: 2 },
        },
      },
      {
        label: "zero usage",
        action: "sdl.usage.stats",
        canonical: {
          session: {
            sessionId: "session-1", startedAt: "2026-08-09T00:00:00.000Z",
            totalSdlTokens: 0, totalRawEquivalent: 0, totalSavedTokens: 0,
            overallSavingsPercent: 0, toolBreakdown: [], callCount: 0,
          },
          formattedSummary: "+--------+\n| empty |\n+--------+",
        },
        expected: { status: "empty" },
      },
      {
        label: "nonzero usage",
        action: "sdl.usage.stats",
        canonical: {
          session: {
            sessionId: "session-1", startedAt: "2026-08-09T00:00:00.000Z",
            totalSdlTokens: 150, totalRawEquivalent: 600,
            totalSavedTokens: 450, overallSavingsPercent: 75, callCount: 2,
            toolBreakdown: [
              {
                tool: "sdl.symbol.search", sdlTokens: 50, rawEquivalent: 500,
                savedTokens: 450, callCount: 1,
              },
              {
                tool: "repoStatus", sdlTokens: 100, rawEquivalent: 100,
                savedTokens: 0, callCount: 1,
              },
            ],
          },
          formattedSummary: "+-------------------+--------+",
        },
        expected: {
          aggregate: {
            totalSdlTokens: 150, totalRawEquivalent: 600,
            totalSavedTokens: 450, savingsPercent: 75, callCount: 2,
          },
          topTools: [{
            tool: "sdl.symbol.search", savedTokens: 450,
            savingsPercent: 90, callCount: 1,
          }],
        },
      },
    ];
    for (const fixture of cases) {
      const projected = projectToolResultForModelContent(
        fixture.action, fixture.canonical, { detail: "compact" },
      );
      assert.deepEqual(projected, fixture.expected, fixture.label);
      assert.doesNotMatch(JSON.stringify(projected), /\+[-+]+\+/);
    }
  });

  it("projects semantic compact status idempotently without mutating canonical input", () => {
    const canonical = {
      ok: true,
      enabled: true,
      selections: [
        {
          languageId: "typescript",
          selected: {
            providerType: "scip",
            providerId: "scip",
            canAffectPass2: true,
          },
          skipped: [{ providerType: "lsp", reason: "provider unavailable" }],
        },
      ],
      lastRuns: [
        {
          providerType: "scip",
          providerId: "scip",
          languages: ["typescript"],
          status: "completed",
          symbolsMatched: 7,
          edgesCreated: 4,
          diagnosticsCount: 2,
        },
      ],
    };
    const original = structuredClone(canonical);
    const first = projectToolResultForModelContent(
      "sdl.semantic.enrichment.status",
      canonical,
      { detail: "compact" },
    );
    const second = projectToolResultForModelContent(
      "sdl.semantic.enrichment.status",
      first,
      { detail: "compact" },
    );

    assert.deepEqual(second, first);
    assert.deepEqual(canonical, original);
  });

  it("projects usage compact status idempotently without mutating canonical input", () => {
    const canonical = {
      session: {
        totalSdlTokens: 120,
        totalRawEquivalent: 500,
        totalSavedTokens: 380,
        overallSavingsPercent: 76,
        callCount: 2,
        toolBreakdown: [
          {
            tool: "sdl.symbol.search",
            sdlTokens: 120,
            rawEquivalent: 500,
            savedTokens: 380,
            callCount: 2,
          },
        ],
      },
    };
    const original = structuredClone(canonical);
    const first = projectToolResultForModelContent(
      "sdl.usage.stats",
      canonical,
      { detail: "compact" },
    );
    const second = projectToolResultForModelContent(
      "sdl.usage.stats",
      first,
      { detail: "compact" },
    );

    assert.deepEqual(second, first);
    assert.deepEqual(canonical, original);
  });

  it("redacts info paths in free-form text unless both disclosure gates are open", () => {
    const canonical = {
      version: "0.13.3",
      runtime: { node: "v24", platform: "win32", arch: "x64" },
      config: {
        path: "C:\\Server\\SDL\\sdl.config.json",
        exists: true,
        loaded: false,
      },
      logging: {
        path: "c:/server/sdl/logs/sdl.log",
        consoleMirroring: false,
        fallbackUsed: true,
      },
      ladybug: {
        available: false,
        activePath: "/var/lib/sdl/graph.lbug",
      },
      native: {
        available: false,
        sourcePath: "\\\\?\\C:\\Server\\SDL\\addon\\sdl.node",
        disabledByEnv: false,
        reason:
          "Native \\\\?\\c:/SERVER/SDL/addon/sdl.node failed; TypeScript fallback remains active.",
      },
      warnings: [
        "Config c:/SERVER/SDL/sdl.config.json could not load; retry after repair.",
        "Ladybug /var/lib/sdl/graph.lbug is unavailable; graph reads remain blocked.",
      ],
      misconfigurations: [
        "Logging C:\\SERVER\\SDL\\LOGS\\SDL.LOG is not writable; console fallback remains active.",
      ],
    };
    const cases = [
      { includeDiagnostics: false, redactPaths: false, disclose: false },
      { includeDiagnostics: false, redactPaths: true, disclose: false },
      { includeDiagnostics: true, redactPaths: true, disclose: false },
      { includeDiagnostics: true, redactPaths: false, disclose: true },
    ];

    for (const testCase of cases) {
      const projected = projectToolResultForModelContent("sdl.info", canonical, {
        detail: "full",
        includeDiagnostics: testCase.includeDiagnostics,
        redactPaths: testCase.redactPaths,
      }) as Record<string, unknown>;
      const serialized = JSON.stringify(projected);
      if (testCase.disclose) {
        assert.match(serialized, /sdl\.config\.json/);
        assert.match(serialized, /graph\.lbug/);
        assert.match(serialized, /sdl\.node/);
      } else {
        assert.doesNotMatch(
          serialized,
          /(?:[a-z]:[\\/]|\\\\\?\\[a-z]:[\\/]|\/var\/lib\/sdl)/i,
        );
        assert.match(serialized, /retry after repair/);
        assert.match(serialized, /graph reads remain blocked/);
        assert.match(serialized, /console fallback remains active/);
        assert.match(serialized, /TypeScript fallback remains active/);
      }
    }
  });

  it("redacts standard and extended UNC paths unless both disclosure gates are open", () => {
    const canonical = {
      version: "0.13.3",
      runtime: { node: "v24", platform: "win32", arch: "x64" },
      config: {
        path: "\\\\Server\\Share\\config\\sdl.config.json",
        exists: true,
        loaded: false,
      },
      logging: {
        path: "\\\\?\\UNC\\Server\\Share\\logs\\sdl.log",
        consoleMirroring: false,
        fallbackUsed: true,
      },
      ladybug: {
        available: false,
        activePath: "\\\\Server\\Share\\db\\graph.lbug",
      },
      native: {
        available: false,
        sourcePath: "\\\\?\\UNC\\Server\\Share\\native\\sdl.node",
        disabledByEnv: false,
        reason:
          "Native //?/unc/SERVER/share/native/sdl.node failed; \\\\server\\SHARE\\native\\sdl.node remains unavailable; TypeScript fallback remains active.",
      },
      warnings: [
        "Config //SERVER/share/config/sdl.config.json and \\\\?\\UNC\\server\\SHARE\\config\\sdl.config.json could not load; retry after repair; ordinary server share guidance remains visible.",
      ],
      misconfigurations: [
        "Logging \\\\SERVER\\share\\logs\\sdl.log and //?/UNC/server/SHARE/logs/sdl.log are not writable; console fallback remains active.",
      ],
    };
    const cases = [
      { includeDiagnostics: false, redactPaths: false, disclose: false },
      { includeDiagnostics: false, redactPaths: true, disclose: false },
      { includeDiagnostics: true, redactPaths: true, disclose: false },
      { includeDiagnostics: true, redactPaths: false, disclose: true },
    ];

    for (const testCase of cases) {
      const projected = projectToolResultForModelContent("sdl.info", canonical, {
        detail: "full",
        includeDiagnostics: testCase.includeDiagnostics,
        redactPaths: testCase.redactPaths,
      }) as Record<string, unknown>;
      const serialized = JSON.stringify(projected);
      if (testCase.disclose) {
        assert.match(serialized, /sdl\.config\.json/i);
        assert.match(serialized, /sdl\.log/i);
        assert.match(serialized, /graph\.lbug/i);
        assert.match(serialized, /sdl\.node/i);
      } else {
        assert.doesNotMatch(
          serialized,
          /sdl\.config\.json|sdl\.log|graph\.lbug|sdl\.node/i,
        );
        assert.match(serialized, /retry after repair/);
        assert.match(serialized, /ordinary server share guidance remains visible/);
        assert.match(serialized, /console fallback remains active/);
        assert.match(serialized, /TypeScript fallback remains active/);
      }
    }
  });

  it("redacts remaining extended Windows namespace paths without redacting namespace prose", () => {
    const canonical = {
      version: "0.13.3",
      runtime: { node: "v24", platform: "win32", arch: "x64" },
      config: {
        path: "\\\\?\\Volume{A1B2-C3D4}\\config\\sdl.config.json",
        exists: true,
        loaded: false,
      },
      logging: {
        path: "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy7\\logs\\sdl.log",
        consoleMirroring: false,
        fallbackUsed: true,
      },
      ladybug: {
        available: false,
        activePath: "\\\\?\\Volume{A1B2-C3D4}\\db\\graph.lbug",
      },
      native: {
        available: false,
        sourcePath:
          "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy7\\native\\sdl.node",
        disabledByEnv: false,
        reason:
          "Native //?/globalroot/device/HARDDISKVOLUMESHADOWCOPY7/native/sdl.node failed; \\\\?\\volume{a1b2-c3d4}/db\\graph.lbug is unavailable; namespace fallback remains active.",
      },
      warnings: [
        "Config //?/volume{a1b2-c3d4}/config/sdl.config.json and \\\\?\\gLoBaLrOoT/DEVICE\\HarddiskVolumeShadowCopy7\\logs/sdl.log are unavailable; retry after repair.",
        "Volume GUID and GLOBALROOT namespace guidance remains visible.",
      ],
      misconfigurations: [
        "Paths \\\\?\\VOLUME{a1b2-c3d4}\\db/graph.lbug and //?/GLOBALROOT/device/harddiskvolumeshadowcopy7/native/sdl.node are blocked; console fallback remains active.",
      ],
    };
    const cases = [
      { includeDiagnostics: false, redactPaths: false, disclose: false },
      { includeDiagnostics: false, redactPaths: true, disclose: false },
      { includeDiagnostics: true, redactPaths: true, disclose: false },
      { includeDiagnostics: true, redactPaths: false, disclose: true },
    ];

    for (const testCase of cases) {
      const projected = projectToolResultForModelContent("sdl.info", canonical, {
        detail: "full",
        includeDiagnostics: testCase.includeDiagnostics,
        redactPaths: testCase.redactPaths,
      }) as Record<string, unknown>;
      const serialized = JSON.stringify(projected);
      if (testCase.disclose) {
        assert.match(serialized, /sdl\.config\.json/i);
        assert.match(serialized, /sdl\.log/i);
        assert.match(serialized, /graph\.lbug/i);
        assert.match(serialized, /sdl\.node/i);
      } else {
        assert.doesNotMatch(
          serialized,
          /sdl\.config\.json|sdl\.log|graph\.lbug|sdl\.node/i,
        );
        assert.match(serialized, /retry after repair/);
        assert.match(
          serialized,
          /Volume GUID and GLOBALROOT namespace guidance remains visible/,
        );
        assert.match(serialized, /console fallback remains active/);
        assert.match(serialized, /namespace fallback remains active/);
      }
    }
  });

  it("projects info without machine paths unless diagnostics and disclosure allow them", () => {
    const healthy = {
      version: "0.13.3",
      runtime: { node: "v24.0.0", platform: "win32", arch: "x64" },
      config: {
        path: "C:\\private\\sdl.config.json", exists: true, loaded: true,
      },
      logging: {
        path: "C:\\private\\sdl.log",
        consoleMirroring: false, fallbackUsed: false,
      },
      ladybug: { available: true, activePath: "C:\\private\\graph.lbug" },
      native: {
        available: true, sourcePath: "C:\\private\\sdl.node",
        disabledByEnv: false, reason: "loaded",
      },
      warnings: [],
      misconfigurations: [],
      secret: "must not leak",
    };
    const degraded = {
      ...healthy,
      config: {
        path: "C:\\private\\missing.json", exists: false, loaded: false,
      },
      logging: { ...healthy.logging, fallbackUsed: true },
      ladybug: { available: false, activePath: null },
      native: {
        available: false, sourcePath: "C:\\private\\sdl.node",
        disabledByEnv: true, reason: "disabled by environment",
      },
      warnings: ["Native addon disabled at C:\\private\\sdl.node."],
      misconfigurations: ["Config file missing."],
    };

    assert.deepEqual(
      projectToolResultForModelContent("sdl.info", healthy, {
        detail: "compact",
      }),
      {
        version: "0.13.3",
        runtime: { node: "v24.0.0", platform: "win32", arch: "x64" },
        config: { exists: true, loaded: true },
        ladybug: { available: true },
        native: { available: true },
      },
    );
    assert.deepEqual(
      projectToolResultForModelContent("sdl.info", degraded, {
        detail: "compact",
      }),
      {
        version: "0.13.3",
        runtime: { node: "v24.0.0", platform: "win32", arch: "x64" },
        config: { exists: false, loaded: false },
        logging: { fallbackUsed: true },
        ladybug: { available: false },
        native: {
          available: false, disabledByEnv: true,
          reason: "disabled by environment",
        },
        warnings: ["Native addon disabled at <redacted>."],
        misconfigurations: ["Config file missing."],
      },
    );

    const defaultFull = projectToolResultForModelContent("sdl.info", healthy, {
      detail: "full",
    }) as Record<string, unknown>;
    assert.doesNotMatch(JSON.stringify(defaultFull), /C:\\\\private/);
    assert.equal("secret" in defaultFull, false);

    const diagnostic = projectToolResultForModelContent("sdl.info", healthy, {
      detail: "full", includeDiagnostics: true, redactPaths: false,
    }) as Record<string, unknown>;
    assert.equal(
      (diagnostic.config as Record<string, unknown>).path,
      "C:\\private\\sdl.config.json",
    );
    assert.equal("secret" in diagnostic, false);
  });

  it("full semantic projection restores all public canonical fields", () => {
    const semantic = {
      ok: true, repoId: "repo", enabled: true,
      autoRunOnIndexRefresh: true, installPolicy: "never",
      selections: [{
        languageId: "typescript",
        selected: {
          providerType: "scip", providerId: "scip", canAffectPass2: true,
        },
        skipped: [],
      }],
      lastRuns: [{
        runId: "semantic-run-1", repoId: "repo", providerType: "scip",
        providerId: "scip", languages: ["typescript"],
        sourceIndexPath: "index.scip", status: "completed",
        startedAt: "2026-08-09T00:00:00.000Z", documentsProcessed: 1,
        symbolsMatched: 2, edgesCreated: 3, edgesUpgraded: 0,
        edgesReplaced: 0, edgesSkipped: 0, diagnosticsCount: 0,
        precisionMeasurement: "unavailable", metadataJson: "{}",
      }],
    };
    assert.deepEqual(
      projectToolResultForModelContent(
        "sdl.semantic.enrichment.status", semantic, { detail: "full" },
      ),
      semantic,
    );
  });

  it("compact pr risk responses are actionable without duplicate scores or counts", () => {
    const empty = compactPRRiskResponse({
      summary: { riskScore: 0, riskLevel: "low", changedCount: 0 },
      analysis: {
        repoId: "r",
        fromVersion: "v1",
        toVersion: "v2",
        riskScore: 0,
        riskLevel: "low",
        changedSymbolsCount: 0,
        blastRadiusCount: 0,
        findings: { items: [], totalCount: 0 },
        recommendedTests: { items: [], totalCount: 0 },
      },
      escalationRequired: false,
    });
    assert.deepEqual(empty.analysis, {
      repoId: "r",
      fromVersion: "v1",
      toVersion: "v2",
    });
    const canonicalProjection = projectToolResultForModelContent(
      "pr.risk.analyze",
      {
        summary: empty.summary,
        analysis: {
          repoId: "r",
          fromVersion: "v1",
          toVersion: "v2",
          riskScore: 0,
          riskLevel: "low",
          changedSymbolsCount: 0,
          blastRadiusCount: 0,
        },
        escalationRequired: false,
      },
      { detail: "compact" },
    );
    const handlerCompactProjection = projectToolResultForModelContent(
      "pr.risk.analyze",
      empty,
      { detail: "compact" },
    );
    assert.deepEqual(canonicalProjection, handlerCompactProjection);

    const low = compactPRRiskResponse({
      summary: { riskScore: 31, riskLevel: "low", changedCount: 1 },
      analysis: {
        repoId: "r",
        fromVersion: "v1",
        toVersion: "v2",
        riskScore: 31,
        riskLevel: "low",
        changedSymbolsCount: 1,
        blastRadiusCount: 0,
        findings: {
          items: [{
            type: "localized-change",
            severity: "low",
            message: "One isolated symbol changed.",
            affectedSymbols: ["src/leaf.ts#leaf"],
          }],
          totalCount: 1,
        },
        recommendedTests: { items: [], totalCount: 0 },
      },
      escalationRequired: false,
    });
    assert.equal("riskScore" in low.analysis, false);
    assert.equal("changedSymbolsCount" in low.analysis, false);

    const highInput = {
      summary: {
        riskScore: 88,
        riskLevel: "high" as const,
        changedCount: 4,
        blastRadiusCount: 9,
        topRiskItem: "src/core.ts#dispatch",
      },
      analysis: {
        repoId: "r",
        fromVersion: "v1",
        toVersion: "v2",
        riskScore: 88,
        riskLevel: "high" as const,
        changedSymbolsCount: 4,
        blastRadiusCount: 9,
        changedSymbols: { items: [{ symbolId: "sym-a" }], totalCount: 4 },
        findings: {
          items: [{
            type: "wide-blast-radius",
            severity: "high" as const,
            message: "Dispatch changes affect authentication callers.",
            affectedSymbols: ["src/core.ts#dispatch", "src/auth.ts#login"],
          }],
          totalCount: 1,
        },
        recommendedTests: {
          items: [{
            type: "integration",
            description: "Run authentication integration tests.",
            targetSymbols: ["src/core.ts#dispatch"],
            priority: "high" as const,
          }],
          totalCount: 1,
        },
      },
      escalationRequired: true,
    };
    const high = compactPRRiskResponse(highInput);

    assert.deepEqual(high.analysis, {
      repoId: "r",
      fromVersion: "v1",
      toVersion: "v2",
      topRisk: {
        target: "src/core.ts#dispatch",
        reason: "Dispatch changes affect authentication callers.",
        recommendedVerification: "Run authentication integration tests.",
      },
    });
    assert.equal("riskScore" in high.analysis, false);
    assert.equal("blastRadiusCount" in high.analysis, false);
    assert.equal(high.summary.riskScore, 88);
    assert.equal(highInput.analysis.findings.items.length, 1);
    assert.equal(highInput.analysis.recommendedTests.items.length, 1);
  });

  it("preserves one coherent canonical top risk across zero presentation budgets", () => {
    const findings = [
      {
        message: "Core dispatch changes affect authentication callers.",
        affectedSymbols: ["src/core.ts#dispatch", "src/auth.ts#login"],
      },
      {
        message: "Unrelated worker change.",
        affectedSymbols: ["src/worker.ts#run"],
      },
    ];
    const recommendedTests = [
      {
        description: "Run worker unit tests.",
        targetSymbols: ["src/worker.ts#run"],
      },
      {
        description: "Run authentication integration tests.",
        targetSymbols: ["src/core.ts#dispatch"],
      },
    ];
    const topRisk = _prRiskToolTesting.selectCanonicalTopRisk(
      findings,
      recommendedTests,
    );
    assert.deepEqual(topRisk, {
      target: "src/core.ts#dispatch",
      reason: "Core dispatch changes affect authentication callers.",
      recommendedVerification: "Run authentication integration tests.",
    });

    for (const [label, visibleFindings, visibleTests] of [
      ["limit:0", [], []],
      ["budget.maxFindings:0", [], recommendedTests],
      ["budget.maxRecommendedTests:0", findings, []],
    ] as const) {
      const compact = compactPRRiskResponse(
        {
          summary: { riskScore: 91, riskLevel: "high", changedCount: 3 },
          analysis: {
            repoId: "r",
            fromVersion: "v1",
            toVersion: "v2",
            riskScore: 91,
            riskLevel: "high",
            changedSymbolsCount: 3,
            blastRadiusCount: 8,
            findings: { items: visibleFindings, totalCount: findings.length },
            recommendedTests: {
              items: visibleTests,
              totalCount: recommendedTests.length,
            },
          },
          escalationRequired: true,
        },
        topRisk,
      );
      assert.deepEqual(compact.analysis.topRisk, topRisk, label);
    }
  });

  it("omits compact top risk when canonical finding and verification targets differ", () => {
    const findings = [
      {
        message: "Core dispatch changes affect authentication callers.",
        affectedSymbols: ["src/core.ts#dispatch"],
      },
    ];
    const recommendedTests = [
      {
        description: "Run worker unit tests.",
        targetSymbols: ["src/worker.ts#run"],
      },
    ];

    assert.equal(
      _prRiskToolTesting.selectCanonicalTopRisk(findings, recommendedTests),
      undefined,
    );

    const compact = compactPRRiskResponse({
      summary: { riskScore: 91, riskLevel: "high", changedCount: 2 },
      analysis: {
        repoId: "r",
        fromVersion: "v1",
        toVersion: "v2",
        findings: { items: findings, totalCount: 1 },
        recommendedTests: { items: recommendedTests, totalCount: 1 },
      },
      escalationRequired: true,
    });
    assert.equal("topRisk" in compact.analysis, false);
  });

  it("runtime intent excerpts ignore Windows cmd echo lines", () => {
    const excerpts = _runtimeToolTesting.generateIntentExcerpts(
      "F:\\repo>if exist target echo echoed\nactual output\n",
      "",
      ["target"],
      0,
    );

    assert.deepEqual(excerpts, []);
  });

  it("runtime status treats clean close after timeout race as success", () => {
    assert.equal(
      classifyRuntimeStatus({ cancelled: false, timedOut: true, exitCode: 0, signal: null }),
      "success",
    );
    assert.equal(
      classifyRuntimeStatus({ cancelled: false, timedOut: true, exitCode: null, signal: "SIGTERM" }),
      "timeout",
    );
  });

  it("semantic enrichment status hides raw metadataJson, repeated skip details, and old runs", () => {
    const compact = compactSemanticEnrichmentStatusForAgent({
      ok: true,
      repoId: "r",
      enabled: true,
      autoRunOnIndexRefresh: true,
      installPolicy: "never",
      selections: [
        {
          languageId: "typescript",
          selected: { providerType: "scip", providerId: "scip", canAffectPass2: true },
          skipped: [{ providerType: "lsp", reason: "provider not available" }],
        },
      ],
      lastRuns: [
        {
          runId: "run-1",
          repoId: "r",
          providerType: "scip",
          providerId: "scip",
          languages: ["typescript"],
          status: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          documentsProcessed: 1,
          symbolsMatched: 1,
          edgesCreated: 1,
          edgesUpgraded: 0,
          edgesReplaced: 0,
          edgesSkipped: 0,
          diagnosticsCount: 3,
          metadataJson: "{\"diagnosticsBySeverity\":{\"error\":1,\"warning\":2}}",
        },
      ],
    }, 1);

    assert.deepEqual(compact.selections, [
      { languageId: "typescript", providerType: "scip", providerId: "scip" },
    ]);
    const latestRun = compact.latestRun as Record<string, unknown>;
    assert.equal("metadataJson" in latestRun, false);
    assert.equal("runId" in latestRun, false);
    assert.equal(latestRun.status, "completed");
    assert.equal(latestRun.symbolsMatched, 1);
    assert.equal(latestRun.edgesCreated, 1);
    assert.deepEqual(compact.warnings, {
      skippedProviders: 1,
      diagnostics: 3,
    });
  });

  it("buffer.status omits null diagnostic fields", () => {
    const compact = compactBufferStatusForAgent({
      repoId: "r",
      enabled: true,
      pendingBuffers: 0,
      dirtyBuffers: 0,
      parseQueueDepth: 0,
      checkpointPending: false,
      lastBufferEventAt: null,
      lastCheckpointAt: null,
      lastCheckpointAttemptAt: null,
      lastCheckpointResult: null,
      lastCheckpointError: null,
      lastCheckpointReason: null,
      reconcileQueueDepth: 0,
      oldestReconcileAt: null,
      lastReconciledAt: null,
      reconcileInflight: false,
      reconcileLastError: null,
    });

    assert.equal("lastCheckpointError" in compact, false);
    assert.equal("reconcileLastError" in compact, false);
  });

  it("edit preview/apply contracts do not expose preconditions or AST internals", () => {
    const searchPreview: SearchEditPreviewResponse = {
      mode: "preview",
      planHandle: "se-hidden",
      defaultCreateBackup: false,
      applyArgs: {
        mode: "apply",
        repoId: "r",
        planHandle: "se-hidden",
        createBackup: false,
      },
      filesMatched: 1,
      matchesFound: 1,
      filesEligible: 1,
      filesSkipped: [],
      fileEntries: [
        {
          file: "a.ts",
          matchCount: 1,
          editMode: "replacePattern",
          snippets: { before: "old", after: "new" },
          indexedSource: true,
          astMatches: [
            {
              target: { name: "target", nodeType: "identifier", text: "old" },
              captures: [{ name: "target", nodeType: "identifier", text: "old" }],
            },
          ],
        },
      ],
      requiresApply: true,
      expiresAt: "2026-01-01T00:00:00.000Z",
    };
    const searchApply: SearchEditApplyResponse = {
      mode: "apply",
      planHandle: "se-hidden",
      filesAttempted: 1,
      filesWritten: 1,
      filesSkipped: 0,
      filesFailed: 0,
      results: [{ file: "a.ts", status: "written" }],
      fileEntries: searchPreview.fileEntries,
      rollback: { triggered: false, restoredFiles: [] },
    };
    const symbolPreview: SymbolEditPreviewResponse = {
      mode: "preview",
      planHandle: "se-symbol",
      symbolId: "sym",
      symbolName: "target",
      operation: "replaceBody",
      file: "a.ts",
      writeTarget: "file",
      requiresApply: true,
      expiresAt: "2026-01-01T00:00:00.000Z",
      validation: { parseBefore: true, parseAfter: true, targetSymbolResolved: true },
      fileEntries: searchPreview.fileEntries,
    };

    assert.equal("preconditionSnapshot" in searchPreview, false);
    assert.equal(
      "startByte" in (searchApply.fileEntries![0].astMatches?.[0]?.target ?? {}),
      false,
    );
    assert.equal("preconditions" in symbolPreview, false);
  });

  it("does not warn for a disposable file write with a literal target", () => {
    const warnings = _runtimeToolTesting.detectQuotingWarnings({
      repoId: "r",
      runtime: "node",
      args: [],
      code: 'writeFileSync("fixture.ts", "export const value = 1;")',
    });

    assert.equal(
      (warnings ?? []).some((warning) =>
        warning.startsWith("Runtime write scripts"),
      ),
      false,
    );
  });

  it("omits incomplete runtime recovery without changing the safe result", () => {
    const projected = projectExclusiveCodeModeRecovery(
      {
        status: "failure",
        artifactHandle: "runtime-artifact",
        stderrSummary: "safe summary",
        nextAction: {
          kind: "queryOutput",
          action: "runtime.queryOutput",
          message: "Inspect persisted output.",
          queryTerms: ["error"],
        },
      },
      "repo-a",
    ) as Record<string, unknown>;

    assert.equal("nextAction" in projected, false);
    assert.equal(projected.artifactHandle, "runtime-artifact");
    assert.equal(projected.stderrSummary, "safe summary");
  });

  it("omits invalid next calls while preserving safe error diagnostics", () => {
    const error = Object.assign(new ValidationError("Safe validation failure."), {
      classification: "invalid_input",
      fallbackRationale: "Correct the request before retrying.",
      nextCalls: [
        {
          action: "unknown.action",
          args: { repoId: "repo-a" },
        },
      ],
    });

    const response = errorToMcpResponse(error);
    const detail = response.error as Record<string, unknown>;

    assert.equal(detail.message, "Safe validation failure.");
    assert.equal(detail.classification, "invalid_input");
    assert.equal(detail.fallbackRationale, "Correct the request before retrying.");
    assert.equal("nextCalls" in detail, false);
  });

  it("does not promote inherited recovery fields through exclusive error delivery", async () => {
    const error = new ValidationError("Safe validation failure.");
    const inheritedPrototype = Object.assign(
      Object.create(Object.getPrototypeOf(error)) as Record<string, unknown>,
      {
        fallbackTools: ["sdl.symbol.search"],
        nextCalls: [
          {
            action: "sdl.symbol.search",
            args: { repoId: "repo-a", query: "target" },
          },
        ],
        fallbackRationale: "Use sdl.symbol.search to retry.",
      },
    );
    Object.setPrototypeOf(error, inheritedPrototype);

    let thrown: unknown;
    try {
      await withExclusiveCodeModeRecoveryProjection(
        true,
        async () => {
          throw error;
        },
        { repoId: "repo-a" },
      );
    } catch (caught) {
      thrown = caught;
    }

    const detail = errorToMcpResponse(thrown).error as Record<string, unknown>;
    assert.equal(thrown, error);
    assert.deepEqual(
      {
        ownsFallbackTools: Object.hasOwn(error, "fallbackTools"),
        ownsNextCalls: Object.hasOwn(error, "nextCalls"),
        ownsFallbackRationale: Object.hasOwn(error, "fallbackRationale"),
        fallbackTools: detail.fallbackTools,
        nextCalls: detail.nextCalls,
        fallbackRationale: detail.fallbackRationale,
      },
      {
        ownsFallbackTools: false,
        ownsNextCalls: false,
        ownsFallbackRationale: false,
        fallbackTools: undefined,
        nextCalls: undefined,
        fallbackRationale: undefined,
      },
    );
  });

  it("preserves only valid typed policy guidance through exclusive error projection", async () => {
    const projectError = async (error: Error): Promise<Record<string, unknown>> => {
      let thrown: unknown;
      try {
        await withExclusiveCodeModeRecoveryProjection(
          true,
          async () => {
            throw error;
          },
          { repoId: "repo-a" },
        );
      } catch (caught) {
        thrown = caught;
      }
      return errorToMcpResponse(thrown).error as Record<string, unknown>;
    };

    const valid = await projectError(
      createPolicyDenial("Use a cheaper context rung.", "requestSkeleton", {
        requestSkeleton: { repoId: "repo-a", symbolId: "symbol-a" },
      }),
    );
    const invalid = await projectError(
      Object.assign(new ValidationError("Safe validation failure."), {
        nextBestAction: "not-a-policy-action",
      }),
    );

    assert.deepEqual(
      {
        validNextBestAction: valid.nextBestAction,
        validFallbackTools: valid.fallbackTools,
        validNextCalls: valid.nextCalls,
        validFallbackRationale: valid.fallbackRationale,
        invalidHasNextBestAction: Object.hasOwn(invalid, "nextBestAction"),
      },
      {
        validNextBestAction: "requestSkeleton",
        validFallbackTools: ["sdl.retrieve"],
        validNextCalls: [
          {
            action: "sdl.retrieve",
            args: {
              args: { symbolId: "symbol-a" },
              op: "codeSkeleton",
              repoId: "repo-a",
            },
          },
        ],
        validFallbackRationale:
          "Use a skeleton request first to stay on the context ladder.",
        invalidHasNextBestAction: false,
      },
    );
  });
  it("keeps successful workflow recovery actions strict and callable", () => {
    const recovery = {
      action: "sdl.workflow",
      args: {
        repoId: "repo",
        steps: [{
          fn: "workflowContinuationGet",
          args: { handle: "workflow-continuation" },
        }],
      },
    };
    const output = {
      results: [{
        fn: "dataMap",
        result: [{ id: 1 }],
        truncatedResponse: {
          originalTokens: 100,
          keptTokens: 50,
          continuationHandle: "workflow-continuation",
        },
        nextAction: recovery,
      }],
    };

    assert.equal(WorkflowOutputSchema.safeParse(output).success, true);
    assert.equal(
      WorkflowOutputSchema.safeParse({
        ...output,
        results: [{ ...output.results[0], nextAction: { ...recovery, id: "resume" } }],
      }).success,
      false,
    );
  });

  it("materializes one schema-valid workflow recovery action", () => {
    const context = {
      repoId: "repo",
      advertisedTools: ["sdl.workflow"],
      activeWorkflowFunctions: ["repoStatus"],
    };
    const valid = buildValidatedRecoveryAction(
      { action: "repo.status", args: { repoId: "repo" } },
      context,
    );
    const invalid = buildValidatedRecoveryAction(
      { action: "repo.status", args: { repoId: "repo" } },
      {
        ...context,
        failedCall: { action: "repo.status", args: { repoId: "repo" } },
      },
    );

    assert.deepEqual(valid.nextAction, {
      action: "sdl.workflow",
      args: {
        includeTelemetry: false,
        onError: "continue",
        repoId: "repo",
        steps: [{
          fn: "repoStatus",
          args: {
            detail: "compact",
            includeTelemetry: false,
            surfaceMemories: false,
          },
        }],
      },
    });
    assert.equal(invalid.nextAction, undefined);
    assert.equal(invalid.invalidRecoveryCount, 1);
  });

  it("accepts only version-bound schema-valid delta continuations", () => {
    const context = {
      repoId: "repo",
      advertisedTools: ["sdl.delta.get"],
    };
    const cursor = { fromVersion: "v1", toVersion: "v2", offset: 3 };
    const valid = buildValidatedRecoveryAction(
      {
        action: "delta.get",
        args: {
          repoId: "repo",
          fromVersion: "v1",
          toVersion: "v2",
          cursor,
          budget: { maxCards: 3 },
          skipBlastRadius: true,
        },
      },
      context,
    );
    const mismatch = buildValidatedRecoveryAction(
      {
        action: "delta.get",
        args: {
          repoId: "repo",
          fromVersion: "v1",
          toVersion: "v3",
          cursor,
        },
      },
      context,
    );

    assert.deepEqual(valid.nextAction, {
      action: "sdl.delta.get",
      args: {
        budget: { maxCards: 3 },
        cursor,
        fromVersion: "v1",
        repoId: "repo",
        skipBlastRadius: true,
        toVersion: "v2",
      },
    });
    assert.equal(mismatch.nextAction, undefined);
    assert.equal(mismatch.invalidRecoveryCount, 1);
  });

  it("builds only schema-shaped hot-path paging recovery", () => {
    assert.deepEqual(
      buildHotPathPagingRecovery(
        {
          repoId: "repo-a",
          symbolId: "symbol-a",
          identifiersToFind: ["alpha"],
          maxLines: 40,
        },
        { range: { startLine: 1, endLine: 40 }, truncated: true },
      ),
      {
        action: "sdl.retrieve",
        args: {
          repoId: "repo-a",
          op: "codeNeedWindow",
          args: {
            symbolId: "symbol-a",
            reason: "Continue the truncated hot-path result.",
            expectedLines: 40,
            identifiersToFind: ["alpha"],
            cursor: 41,
          },
        },
      },
    );
    assert.equal(
      buildHotPathPagingRecovery(
        { repoId: "repo-a", symbolId: "symbol-a", identifiersToFind: [] },
        { truncated: true },
      ),
      undefined,
    );
  });
});

describe("runtime agent-facing projection", () => {
  it("keeps observability typed while emitting one actionable large-output recovery", () => {
    const canonical = {
      status: "failure",
      exitCode: 2,
      signal: "SIGTERM",
      durationMs: 44,
      stdoutSummary: "preview",
      stderrSummary: "",
      artifactHandle: "runtime-artifact",
      truncation: {
        stdoutTruncated: false,
        stderrTruncated: false,
        totalStdoutBytes: 9_000,
        totalStderrBytes: 0,
      },
    };
    const projected = projectRuntimeValue(
      {
        canonicalResult: canonical,
        action: "runtime.execute",
        profile: {
          projector: "generic",
          observabilityProfile: "standard",
          defaultDetail: "standard",
          budgetClass: "standard",
          largeResponseStrategy: "artifact",
          recoveryPolicy: "on-truncation",
        },
        options: { detail: "compact", includeDiagnostics: false },
        context: {
          toolName: "runtime.execute",
          requestArgs: { repoId: "repo-a", outputMode: "summary" },
        },
      },
      () => {
        throw new Error("runtime projector must own display selection");
      },
    ) as Record<string, unknown>;

    assert.deepEqual(extractRuntimeObservability(canonical), {
      exitCode: 2,
      signal: "SIGTERM",
      totalStdoutBytes: 9_000,
      totalStderrBytes: 0,
      durationMs: 44,
    });
    assert.deepEqual(Object.keys(projected), [
      "status",
      "preview",
      "artifactHandle",
      "nextAction",
    ]);
    assert.deepEqual(projected.nextAction, {
      action: "runtime.queryOutput",
      args: {
        repoId: "repo-a",
        artifactHandle: "runtime-artifact",
        view: "model",
        queryTerms: ["error", "failed", "exception"],
        stream: "stdout",
        maxExcerpts: 10,
        contextLines: 3,
      },
    });
  });
});
