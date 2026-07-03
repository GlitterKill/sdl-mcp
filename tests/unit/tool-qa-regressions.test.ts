import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  compactSemanticEnrichmentStatusForAgent,
} from "../../dist/mcp/tools/semantic-enrichment.js";
import { buildIdentifierMissWarning } from "../../dist/mcp/tools/code.js";
import {
  buildPRRiskPreflightResponse,
} from "../../dist/mcp/tools/prRisk.js";
import { detectRuntimeHints } from "../../dist/mcp/tools/runtime.js";

describe("SDL tool QA regressions", () => {
  it("summarizes semantic provider selections in compact status output", () => {
    const compact = compactSemanticEnrichmentStatusForAgent(
      {
        ok: true,
        repoId: "repo",
        enabled: true,
        autoRunOnIndexRefresh: true,
        installPolicy: "never",
        selections: [
          {
            languageId: "typescript",
            selected: {
              providerType: "scip",
              providerId: "scip",
              canAffectPass2: true,
            },
            skipped: [],
          },
          {
            languageId: "python",
            skipped: [{ providerType: "lsp", reason: "provider not available" }],
          },
        ],
        lastRuns: [
          {
            runId: "run-1",
            repoId: "repo",
            providerType: "scip",
            providerId: "scip",
            languages: ["typescript"],
            sourceIndexPath: "index.scip",
            status: "completed",
            startedAt: "2026-07-03T00:00:00.000Z",
            finishedAt: "2026-07-03T00:00:01.000Z",
            documentsProcessed: 1,
            symbolsMatched: 1,
            edgesCreated: 1,
            edgesUpgraded: 0,
            edgesReplaced: 0,
            edgesSkipped: 0,
            diagnosticsCount: 0,
            precisionScore: 1,
            selected: true,
            metadataJson: "{\"verbose\":true}",
          },
        ],
      } as any,
      1,
    ) as any;

    assert.deepEqual(compact.selections, {
      totalLanguages: 2,
      selectedLanguages: 1,
      skippedProviders: 1,
      languagesWithSelection: ["typescript"],
    });
    assert.equal(compact.lastRuns.length, 1);
    assert.equal("metadataJson" in compact.lastRuns[0], false);
  });

  it("distinguishes whole-symbol identifier misses from truncation", () => {
    const warning = buildIdentifierMissWarning(["apply", "planHandle"], {
      maxLines: 80,
      windowTruncated: false,
      rangeNarrowed: false,
    });

    assert.match(warning, /outside the selected symbol|not found in selected symbol/i);
    assert.doesNotMatch(warning, /truncated to 80 lines/i);
    assert.match(warning, /symbol\.search/i);
  });

  it("hints npm.cmd when PowerShell npm.ps1 shims fail noisily", () => {
    const hints = detectRuntimeHints(
      {
        repoId: "repo",
        runtime: "powershell",
        executable: "npm",
        args: ["run", "docs:tools:check"],
        relativeCwd: ".",
        maxResponseLines: 100,
        persistOutput: true,
        outputMode: "summary",
      } as any,
      "The variable '$LASTEXITCODE' cannot be retrieved because it has not been set.\nC:\\nvm4w\\nodejs\\npm.ps1",
    );

    assert.ok(hints?.some((hint) => /npm\.cmd/.test(hint)));
  });

  it("builds a cheap pr.risk preflight response without blast-radius data", () => {
    const response = buildPRRiskPreflightResponse(
      {
        repoId: "repo",
        fromVersion: "v1",
        toVersion: "v2",
        changedSymbols: [
          {
            symbolId: "src/a.ts::a",
            changeType: "modified",
            tiers: { riskScore: 80, interfaceStable: false },
          },
          {
            symbolId: "src/b.ts::b",
            changeType: "added",
            tiers: { riskScore: 20 },
          },
        ],
      } as any,
      {
        riskThreshold: undefined,
        maxChangedSymbols: 1,
        maxFindings: 2,
        maxNestedSymbols: 5,
      },
    ) as any;

    assert.equal(response.summary.changedCount, 2);
    assert.equal(response.analysis.blastRadius.totalCount, 0);
    assert.equal(response.analysis.changedSymbols.items.length, 1);
    assert.equal(response.analysis.preflight.skipped.includes("blastRadius"), true);
  });
});
