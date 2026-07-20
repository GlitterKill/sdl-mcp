import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SemanticEnrichmentConfigSchema } from "../../dist/config/types.js";
import {
  deriveSemanticLanguagePacks,
  extendLanguagePacksForLsp,
} from "../../dist/semantic/language-packs.js";
import { selectSemanticSources } from "../../dist/semantic/source-selection.js";
import { createSemanticCacheKey } from "../../dist/semantic/cache-key.js";
import { computeSemanticPrecisionScore } from "../../dist/semantic/precision.js";
import { classifySemanticEdgeAction } from "../../dist/semantic/writer.js";
import {
  refreshSemanticEnrichment,
  scipResultToProviderRun,
} from "../../dist/semantic/enrichment.js";
import type { SemanticEdge } from "../../dist/semantic/types.js";
import type { AppConfig } from "../../dist/config/types.js";
import * as semanticTools from "../../dist/mcp/tools/semantic-enrichment.js";

describe("semantic enrichment bridge core", () => {
  it("defaults to enabled enrichment separate from semantic retrieval", () => {
    const config = SemanticEnrichmentConfigSchema.parse({});

    assert.equal(config.enabled, true);
    assert.equal(config.autoRunOnIndexRefresh, false);
    assert.equal(config.installPolicy, "never");
    assert.equal(config.concurrency, 1);
    assert.deepEqual(config.languages, []);
  });

  it("does not refresh providers when semantic enrichment is disabled", async () => {
    const result = await refreshSemanticEnrichment(
      { repoId: "missing-repo" },
      {
        repos: [],
        policy: {},
        semanticEnrichment: { enabled: false },
      } as AppConfig,
    );

    assert.equal(result.enabled, false);
    assert.equal(result.runs.length, 0);
    assert.equal(result.skipped[0].reason, "semanticEnrichment.enabled is false");
  });

  it("derives language support from the tree-sitter adapter registry", () => {
    const packs = deriveSemanticLanguagePacks();
    const byLanguage = new Map(packs.map((pack) => [pack.languageId, pack]));

    assert.ok(byLanguage.get("typescript")?.extensions.includes(".tsx"));
    assert.ok(byLanguage.get("typescript")?.extensions.includes(".mjs"));
    assert.ok(byLanguage.get("python")?.extensions.includes(".pyw"));
    assert.ok(byLanguage.get("php")?.extensions.includes(".phtml"));
    assert.ok(byLanguage.get("shell")?.extensions.includes(".zsh"));
  });

  it("selects exactly one semantic source per language with SCIP priority", () => {
    const [selection] = selectSemanticSources(
      SemanticEnrichmentConfigSchema.parse({ languages: ["typescript"] }),
      [{ languageId: "typescript", extensions: [".ts"], treeSitter: true }],
      {
        scip: { typescript: { available: true, providerId: "scip" } },
        lsp: { typescript: { available: true, providerId: "tsserver" } },
      },
    );

    assert.equal(selection.selected?.providerType, "scip");
    assert.deepEqual(
      selection.skipped.map((skip) => skip.providerType).sort(),
      ["lsp"],
    );
  });

  it("selects configured LSP languages without a tree-sitter adapter", () => {
    const config = SemanticEnrichmentConfigSchema.parse({
      languages: ["elixir"],
      providers: {
        scip: { enabled: false, indexes: [] },
        lsif: { enabled: false, indexes: [] },
        lsp: {
          enabled: true,
          servers: {
            expert: {
              serverId: "expert",
              command: "expert",
              args: [],
              languages: ["elixir"],
              documentLanguageIds: ["elixir"],
              filePatterns: ["**/*.ex", "**/*.exs"],
            },
          },
        },
      },
    });
    const packs = extendLanguagePacksForLsp([], config);
    const [selection] = selectSemanticSources(config, packs, {
      lsp: { elixir: { available: true, providerId: "expert" } },
    });

    assert.equal(packs[0].treeSitter, false);
    assert.equal(selection.selected?.providerType, "lsp");
  });

  it("selects LSP when SCIP is unavailable", () => {
    const [selection] = selectSemanticSources(
      SemanticEnrichmentConfigSchema.parse({ languages: ["typescript"] }),
      [{ languageId: "typescript", extensions: [".ts"], treeSitter: true }],
      {
        lsp: {
          typescript: {
            available: true,
            providerId: "tsserver",
            canAffectPass2: false,
          },
        },
      },
    );

    assert.equal(selection.selected?.providerType, "lsp");
    assert.equal(selection.selected?.canAffectPass2, false);
  });

  it("ignores stale LSIF provider config during parsing", () => {
    const config = SemanticEnrichmentConfigSchema.parse({
      providers: {
        lsif: { enabled: true, indexes: [{ path: "stale.lsif" }] },
        lsp: { enabled: true, servers: {} },
      },
    });

    assert.equal(Object.hasOwn(config.providers, "lsif"), false);
    assert.equal(config.providers.lsp?.enabled, true);
  });

  it("keeps semantic cache keys stable across object key order", () => {
    const left = createSemanticCacheKey({
      repoId: "repo",
      languageId: "typescript",
      sourceHashes: { b: "2", a: "1" },
    });
    const right = createSemanticCacheKey({
      languageId: "typescript",
      repoId: "repo",
      sourceHashes: { a: "1", b: "2" },
    });

    assert.equal(left, right);
  });

  it("classifies generic semantic edge actions without lowering confidence", () => {
    const edge: SemanticEdge = {
      sourceSymbolId: "source",
      targetSymbolId: "target",
      edgeType: "call",
      confidence: 0.9,
      resolution: "exact",
      resolverId: "lsp:fixture",
      resolutionPhase: "semantic-enrichment:lsp",
      capability: "definition",
      provenance: {
        providerType: "lsp",
        providerId: "fixture",
        capability: "definition",
        confidence: 0.9,
        runId: "run",
        resolutionPhase: "semantic-enrichment:lsp",
      },
    };

    assert.equal(classifySemanticEdgeAction(null, edge), "create");
    assert.equal(
      classifySemanticEdgeAction(
        {
          sourceSymbolId: "source",
          targetSymbolId: "target",
          edgeType: "call",
          confidence: 0.5,
          resolution: "heuristic",
        },
        edge,
      ),
      "upgrade",
    );
    assert.equal(
      classifySemanticEdgeAction(
        {
          sourceSymbolId: "source",
          targetSymbolId: "old-target",
          edgeType: "call",
          confidence: 0.5,
          resolution: "unresolved",
        },
        edge,
      ),
      "replace",
    );
    assert.equal(
      classifySemanticEdgeAction(
        {
          sourceSymbolId: "source",
          targetSymbolId: "target",
          edgeType: "call",
          confidence: 0.95,
          resolution: "exact",
        },
        edge,
      ),
      "skip",
    );
  });

  it("scores SCIP higher than equally covered LSP enrichment", () => {
    const base = {
      filesCovered: 10,
      filesEligible: 10,
      symbolsMatched: 8,
      symbolsTotal: 10,
      resolvedEdges: 9,
      totalEdges: 10,
      diagnosticsAvailable: true,
      pass2SkippedFiles: 5,
      pass2EligibleFiles: 10,
    };

    assert.ok(
      computeSemanticPrecisionScore({ ...base, providerType: "scip" }) >
        computeSemanticPrecisionScore({ ...base, providerType: "lsp" }),
    );
  });

  it("records cached SCIP ingests as skipped cache-hit runs", () => {
    const run = scipResultToProviderRun({
      repoId: "repo",
      indexPath: "fixtures/index.scip",
      languages: ["typescript"],
      dryRun: false,
      result: {
        status: "alreadyIngested",
        decoderBackend: "typescript",
        documentsProcessed: 0,
        documentsSkipped: 0,
        symbolsMatched: 0,
        externalSymbolsCreated: 0,
        edgesCreated: 0,
        edgesUpgraded: 0,
        edgesReplaced: 0,
        unresolvedOccurrences: 0,
        skippedSymbols: 0,
        truncated: false,
        durationMs: 1,
        perFileCoverage: [],
      },
    });

    assert.equal(run.status, "skipped");
    assert.equal(run.cacheHit, true);
    assert.equal(run.canAffectPass2, true);
    assert.equal(run.selected, true);
    assert.equal("precisionScore" in run, false);
  });

  it("projects semantic score availability identically in compact and full modes", () => {
    const projectRun = Reflect.get(semanticTools, "projectSemanticEnrichmentRun");
    assert.equal(typeof projectRun, "function");
    if (typeof projectRun !== "function") return;

    const baseRun = {
      runId: "run-unavailable",
      repoId: "repo-1",
      providerType: "scip" as const,
      providerId: "scip-typescript",
      languages: ["typescript"],
      status: "completed" as const,
      startedAt: "2026-07-19T00:00:00.000Z",
      finishedAt: "2026-07-19T00:00:01.000Z",
      documentsProcessed: 1,
      symbolsMatched: 2,
      edgesCreated: 3,
      edgesUpgraded: 0,
      edgesReplaced: 0,
      edgesSkipped: 0,
      diagnosticsCount: 0,
      cacheHit: false,
      canAffectPass2: true,
      selected: true,
    };
    const runs = [
      baseRun,
      { ...baseRun, runId: "run-zero", precisionScore: 0 },
      { ...baseRun, runId: "run-positive", precisionScore: 0.75 },
    ];
    const fullRuns = runs.map((run) => projectRun(run) as Record<string, unknown>);
    const projectedStatus = {
      ok: true,
      repoId: "repo-1",
      enabled: true,
      autoRunOnIndexRefresh: false,
      installPolicy: "never" as const,
      selections: [],
      lastRuns: fullRuns,
    } as unknown as Parameters<typeof semanticTools.compactSemanticEnrichmentStatusForAgent>[0];
    const compact = semanticTools.compactSemanticEnrichmentStatusForAgent(
      projectedStatus,
      runs.length,
    ) as { lastRuns: Array<Record<string, unknown>> };

    assert.equal("precisionScore" in fullRuns[0], false);
    assert.equal("precisionBasis" in fullRuns[0], false);
    assert.equal(fullRuns[0].precisionMeasurement, "unavailable");
    assert.equal(compact.lastRuns[0].precisionMeasurement, "unavailable");
    assert.equal("precisionScore" in compact.lastRuns[0], false);
    assert.equal("precisionBasis" in compact.lastRuns[0], false);

    for (const index of [1, 2]) {
      assert.equal(fullRuns[index].precisionMeasurement, "measured");
      assert.equal(fullRuns[index].precisionBasis, "operational-composite");
      assert.equal(compact.lastRuns[index].precisionScore, fullRuns[index].precisionScore);
      assert.equal(compact.lastRuns[index].precisionMeasurement, fullRuns[index].precisionMeasurement);
      assert.equal(compact.lastRuns[index].precisionBasis, fullRuns[index].precisionBasis);
    }
    assert.equal(fullRuns[1].precisionScore, 0);
    assert.equal(fullRuns.some((run) => run.precisionScore === null), false);
    assert.equal(compact.lastRuns.some((run) => run.precisionScore === null), false);

    const measuredFullKeys = Object.keys(fullRuns[1]);
    assert.ok(measuredFullKeys.indexOf("precisionScore") < measuredFullKeys.indexOf("precisionMeasurement"));
    assert.ok(measuredFullKeys.indexOf("precisionMeasurement") < measuredFullKeys.indexOf("precisionBasis"));
    assert.ok(measuredFullKeys.indexOf("precisionBasis") < measuredFullKeys.indexOf("cacheHit"));
    const measuredCompactKeys = Object.keys(compact.lastRuns[1]);
    assert.equal(
      measuredCompactKeys.indexOf("precisionBasis"),
      measuredCompactKeys.indexOf("precisionMeasurement") + 1,
    );

    assert.equal(
      JSON.stringify(fullRuns),
      JSON.stringify(runs.map((run) => projectRun(run))),
    );
    assert.equal(
      JSON.stringify(compact),
      JSON.stringify(
        semanticTools.compactSemanticEnrichmentStatusForAgent(projectedStatus, runs.length),
      ),
    );
  });
});
