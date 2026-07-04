import { describe, it } from "node:test";
import assert from "node:assert/strict";

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
import { compactPRRiskResponse } from "../../dist/mcp/tools/prRisk.js";
import { compactBufferStatusForAgent } from "../../dist/mcp/tools/buffer.js";
import { _policyToolTesting } from "../../dist/mcp/tools/policy.js";

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

  it("compact pr risk responses omit verbose analysis arrays", () => {
    const compact = compactPRRiskResponse({
      summary: { riskScore: 31, riskLevel: "low" },
      analysis: {
        fromVersion: "v1",
        toVersion: "v2",
        changedSymbols: { items: [{ symbolId: "sym-a" }], totalCount: 1 },
        findings: { items: [{ affectedSymbols: ["sym-a"] }], totalCount: 1 },
        recommendedTests: { items: [{ targetSymbols: ["sym-a"] }], totalCount: 1 },
      },
      escalationRequired: false,
    });

    assert.equal("changedSymbols" in compact.analysis, false);
    assert.equal("findings" in compact.analysis, false);
    assert.equal("recommendedTests" in compact.analysis, false);
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
          diagnosticsCount: 0,
          metadataJson: "{\"internal\":true}",
        },
        {
          runId: "run-2",
          repoId: "r",
          providerType: "scip",
          providerId: "scip",
          languages: ["typescript"],
          status: "completed",
          startedAt: "2026-01-02T00:00:00.000Z",
          documentsProcessed: 1,
          symbolsMatched: 1,
          edgesCreated: 1,
          edgesUpgraded: 0,
          edgesReplaced: 0,
          edgesSkipped: 0,
          diagnosticsCount: 0,
          metadataJson: "{\"internal\":true}",
        },
      ],
    }, 1);

    assert.equal("selected" in compact.selections, false);
    assert.equal(compact.selections.selectedLanguages, 1);
    assert.deepEqual(compact.selections.languagesWithSelection, ["typescript"]);
    assert.equal("metadataJson" in compact.lastRuns[0], false);
    assert.equal("documentsProcessed" in compact.lastRuns[0], false);
    assert.equal(compact.lastRuns.length, 1);
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
});
