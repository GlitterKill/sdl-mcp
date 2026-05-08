import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SemanticEnrichmentConfigSchema } from "../../dist/config/types.js";
import { deriveSemanticLanguagePacks } from "../../dist/semantic/language-packs.js";
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

describe("semantic enrichment bridge core", () => {
  it("defaults to explicit-only enrichment separate from semantic retrieval", () => {
    const config = SemanticEnrichmentConfigSchema.parse({});

    assert.equal(config.enabled, false);
    assert.equal(config.autoRunOnIndexRefresh, false);
    assert.equal(config.installPolicy, "never");
    assert.equal(config.concurrency, 1);
    assert.deepEqual(config.languages, []);
  });

  it("does not refresh providers when semantic enrichment is disabled", async () => {
    const result = await refreshSemanticEnrichment(
      { repoId: "missing-repo" },
      { repos: [], policy: {} } as AppConfig,
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
        lsif: { typescript: { available: true, providerId: "lsif" } },
        lsp: { typescript: { available: true, providerId: "tsserver" } },
      },
    );

    assert.equal(selection.selected?.providerType, "scip");
    assert.deepEqual(
      selection.skipped.map((skip) => skip.providerType).sort(),
      ["lsif", "lsp"],
    );
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
      resolverId: "lsif:fixture",
      resolutionPhase: "lsif",
      capability: "definition",
      provenance: {
        providerType: "lsif",
        providerId: "fixture",
        capability: "definition",
        confidence: 0.9,
        runId: "run",
        resolutionPhase: "lsif",
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
    assert.equal(run.precisionScore, 0);
  });
