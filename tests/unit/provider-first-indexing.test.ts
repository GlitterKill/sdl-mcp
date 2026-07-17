import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rename as fsRename } from "node:fs/promises";

import {
  type AppConfig,
  IndexingConfigSchema,
  ScipConfigSchema,
  SemanticEnrichmentConfigSchema,
} from "../../dist/config/types.js";
import {
  clearProviderFactPayloadsForCoverageAnalysis,
  clearProviderFactPayloadsForGc,
  clearProviderGraphRowsForGc,
  collectCallProofMismatchSamples,
  countExistingProviderPrimaryFiles,
  filterProviderFirstDataToScannedScope,
  isProviderFirstLegacyFallbackPlanComplete,
  providerFirstFatalFailureReasons,
  analyzeProviderFirstCoverage,
  resolveProviderFirstSemanticEligiblePaths,
  resolveProviderFirstReadinessGates,
  resolveProviderFirstActiveMaterializationPlan,
  resolveProviderFirstLegacyFallbackPlan,
  resolveProviderFirstShadowRepoScopeSkipReason,
  resolveProviderFirstPass1Concurrency,
  resolvePass1BatchSymbolWriteMode,
  selectProviderFirstLegacyFallbackPaths,
  shouldCreateParserWorkerPool,
  shouldDeleteExistingFilesBeforeFullPass1,
  shouldStabilizePass1BatchPersist,
  shouldUseBatchPersistAccumulator,
  shouldUseRustPass1Engine,
} from "../../dist/indexer/indexer.js";
import { shouldReuseProviderFirstFullGraph } from "../../dist/indexer/indexer-pass1-policy.js";
import { createProviderSymbolId } from "../../dist/indexer/provider-first/ids.js";
import {
  executeProviderFirstScipIncremental,
  executeProviderFirstScipFull,
  resolveProviderFirstExecutionPlan,
} from "../../dist/indexer/provider-first/executor.js";
import { createLspProviderCacheKey } from "../../dist/indexer/provider-first/lsp-cache.js";
import {
  materializeProviderFacts,
  providerFactsToGraphRows,
} from "../../dist/indexer/provider-first/materializer.js";
import { providerFactsToSemanticProvenanceRecords } from "../../dist/indexer/provider-first/provenance.js";
import { validateProviderFirstGraphRows } from "../../dist/indexer/provider-first/graph-validation.js";
import { resolveProviderFirstPipeline } from "../../dist/indexer/provider-first/planner.js";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import { BatchPersistAccumulator } from "../../dist/indexer/parser/batch-persist.js";
import { stageProviderFirstShadowBuild } from "../../dist/indexer/provider-first/shadow-build.js";
import { finalizeProviderFirstShadowDb } from "../../dist/indexer/provider-first/shadow-finalization.js";
import {
  activateProviderFirstShadowDb,
  activateProviderFirstShadowDbWithHandoff,
  summarizeProviderFirstShadowActivationReadiness,
} from "../../dist/indexer/provider-first/shadow-activation.js";
import {
  collectLegacyFallbackShadowRows,
  mergeProviderFirstGraphRows,
} from "../../dist/indexer/provider-first/legacy-shadow-rows.js";
import {
  resolveProviderFirstSemanticReadinessDeferral,
  runProviderFirstSemanticReadinessRefresh,
} from "../../dist/indexer/provider-first/semantic-readiness.js";
import {
  exec as dbExec,
  execDdl as dbExecDdl,
  queryAll,
  toNumber,
} from "../../dist/db/ladybug-core.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  createBaseSchema,
  createSecondaryIndexes,
} from "../../dist/db/ladybug-schema.js";
import { setSymbolEmbeddingBatchOnNode } from "../../dist/db/ladybug-symbol-embeddings.js";
import { unresolvedCallSymbolId } from "../../dist/db/symbol-placeholders.js";
import { ensureFtsIndexForNonEmptyTable } from "../../dist/retrieval/index-lifecycle.js";
import { normalizePath } from "../../dist/util/paths.js";
import type { SymbolRow } from "../../dist/db/ladybug-queries.js";
import type { ProviderFirstGraphRows } from "../../dist/indexer/provider-first/materializer.js";
import type { ProviderFactSet } from "../../dist/indexer/provider-first/types.js";
import { writeTestScipIndex } from "../fixtures/scip/builder.ts";

describe("provider-first indexing foundation", () => {
  it("defaults indexing to automatic provider-first selection with shadow activation", () => {
    const config = IndexingConfigSchema.parse({});

    assert.equal(config.pipeline, "auto");
    assert.equal(config.providerFirst.activation, "shadowDb");
    assert.equal(config.providerFirst.readyState, "graphPlusAlgorithms");
    assert.equal(config.providerFirst.maxLegacyFallbackFiles, 1_000_000);
    assert.equal(config.providerFirst.maxSemanticEligibleFallbackFiles, 0);
    assert.equal(config.providerFirst.lsp.mode, "primaryWithCaps");
    assert.equal(config.algorithmRefresh.louvain.maxCallEdges, 10_000);
    assert.equal(config.watchProvider, "auto");
  });

  it("validates watcher provider configuration", () => {
    for (const watchProvider of ["auto", "watchman", "chokidar", "fsWatch"] as const) {
      assert.equal(IndexingConfigSchema.parse({ watchProvider }).watchProvider, watchProvider);
    }

    assert.throws(() => IndexingConfigSchema.parse({ watchProvider: "native" }));
  });

  it("skips provider-first shadow staging when the active DB has other repos", () => {
    assert.equal(
      resolveProviderFirstShadowRepoScopeSkipReason("repo", []),
      undefined,
    );
    assert.equal(
      resolveProviderFirstShadowRepoScopeSkipReason("repo", ["repo"]),
      undefined,
    );

    const reason = resolveProviderFirstShadowRepoScopeSkipReason("repo", [
      "other-repo",
      "repo",
    ]);

    assert.match(reason ?? "", /other-repo/);
    assert.match(reason ?? "", /single-repo scoped/);
  });

  it("keeps provider-first same-run legacy fallback complete by default", () => {
    assert.deepEqual(
      resolveProviderFirstLegacyFallbackPlan({
        fallbackFileCount: 57,
        maxLegacyFallbackFiles: 1_000_000,
      }),
      {
        runLegacyFallback: true,
        parsedFiles: 57,
        skippedFiles: 0,
        fileLimit: 1_000_000,
      },
    );

    const llvmDefaultPlan = resolveProviderFirstLegacyFallbackPlan({
      fallbackFileCount: 65_832,
      semanticEligibleFallbackFileCount: 2_339,
      maxLegacyFallbackFiles: 1_000_000,
    });
    assert.deepEqual(llvmDefaultPlan, {
      runLegacyFallback: true,
      parsedFiles: 65_832,
      skippedFiles: 0,
      fileLimit: 1_000_000,
      semanticEligibleFallbackFiles: 2_339,
      semanticEligibleFileLimit: 0,
    });
    assert.equal(
      isProviderFirstLegacyFallbackPlanComplete(llvmDefaultPlan),
      true,
    );
  });

  it("resolves provider-first semantic deferral flags from semantic config", () => {
    assert.deepEqual(
      resolveProviderFirstSemanticReadinessDeferral({
        semantic: {
          enabled: true,
          generateSummaries: false,
        },
      } as AppConfig),
      {
        semanticDeferred: true,
        summariesDirty: false,
        embeddingsDirty: true,
      },
    );

    assert.deepEqual(
      resolveProviderFirstSemanticReadinessDeferral({
        semantic: {
          enabled: true,
          generateSummaries: true,
        },
      } as AppConfig),
      {
        semanticDeferred: true,
        summariesDirty: true,
        embeddingsDirty: true,
      },
    );

    assert.deepEqual(
      resolveProviderFirstSemanticReadinessDeferral({
        semantic: {
          enabled: false,
          generateSummaries: true,
        },
      } as AppConfig),
      {
        semanticDeferred: false,
        summariesDirty: false,
        embeddingsDirty: false,
      },
    );
  });

  it("runs provider-first semantic readiness refresh with deferred indexes", async () => {
    const calls: string[] = [];
    const result = await runProviderFirstSemanticReadinessRefresh({
      repoId: "repo-semantic-refresh",
      versionId: "v-semantic-refresh",
      appConfig: {
        semantic: {
          enabled: true,
          provider: "mock",
          generateSummaries: true,
        },
      } as AppConfig,
      deps: {
        generateSummariesForRepo: async () => {
          calls.push("summaries");
          return {
            generated: 1,
            skipped: 2,
            failed: 0,
            totalCostUsd: 0,
          };
        },
        refreshFileSummaryEmbeddings: async (params) => {
          calls.push(`file:${params.model}`);
          return {
            embedded: 3,
            skipped: 4,
            missing: 0,
            degraded: false,
          };
        },
        refreshSymbolEmbeddings: async (params) => {
          calls.push(`symbol:${params.model}`);
          return { embedded: 5, skipped: 6 };
        },
        buildDeferredIndexes: async (params) => {
          calls.push(
            `indexes:${String(params.deferSemanticVectorIndexes)}:${String(params.deferSemanticTextIndexes)}`,
          );
        },
        markDerivedStateComputed: async (_repoId, _versionId, flags) => {
          calls.push(
            `computed:${String(flags?.summaries)}:${String(flags?.embeddings)}`,
          );
        },
        recordDerivedStateError: async () => {
          throw new Error("recordDerivedStateError should not run");
        },
      },
    });

    assert.equal(result.semanticDeferred, false);
    assert.deepEqual(calls, [
      "summaries",
      "file:nomic-embed-text-v1.5",
      "symbol:jina-embeddings-v2-base-code",
      "indexes:false:false",
      "computed:true:true",
    ]);
  });

  it("caps provider-first same-run legacy fallback only for extreme uncovered tails", () => {
    assert.deepEqual(
      resolveProviderFirstLegacyFallbackPlan({
        fallbackFileCount: 1_000_001,
        maxLegacyFallbackFiles: 1_000_000,
      }),
      {
        runLegacyFallback: false,
        parsedFiles: 0,
        skippedFiles: 1_000_001,
        fileLimit: 1_000_000,
      },
    );
  });

  it("can opt in to semantic-eligible fallback before skipping outside-semantic tails", () => {
    const semanticSubsetPlan = resolveProviderFirstLegacyFallbackPlan({
      fallbackFileCount: 65_832,
      semanticEligibleFallbackFileCount: 2_339,
      maxLegacyFallbackFiles: 5_000,
      maxSemanticEligibleFallbackFiles: 5_000,
    });
    assert.deepEqual(semanticSubsetPlan, {
      runLegacyFallback: true,
      parsedFiles: 2_339,
      skippedFiles: 63_493,
      fileLimit: 5_000,
      semanticEligibleFallbackFiles: 2_339,
      semanticEligibleFileLimit: 5_000,
    });
    assert.equal(
      isProviderFirstLegacyFallbackPlanComplete(semanticSubsetPlan),
      false,
    );

    assert.deepEqual(
      [
        ...selectProviderFirstLegacyFallbackPaths({
          fallbackPaths: new Set([
            "llvm/benchmarks/DummyYAML.cpp",
            "llvm/utils/lit/lit.py",
            ".ci/cache_lit_timing_files.py",
          ]),
          semanticEligiblePaths: new Set([
            "llvm/benchmarks/DummyYAML.cpp",
            "llvm/utils/lit/lit.py",
          ]),
          parsedFiles: 2,
        }),
      ],
      ["llvm/benchmarks/DummyYAML.cpp", "llvm/utils/lit/lit.py"],
    );
  });

  it("uses tuned legacy engines for complete provider-first fallback only", () => {
    assert.equal(
      shouldUseRustPass1Engine({
        configuredEngine: "rust",
        rustEngineAvailable: true,
        providerFirstLegacyFallbackActive: false,
        providerFirstLegacyFallbackComplete: false,
      }),
      true,
    );
    assert.equal(
      shouldUseRustPass1Engine({
        configuredEngine: "rust",
        rustEngineAvailable: true,
        providerFirstLegacyFallbackActive: true,
        providerFirstLegacyFallbackComplete: false,
      }),
      false,
    );
    assert.equal(
      shouldUseRustPass1Engine({
        configuredEngine: "rust",
        rustEngineAvailable: true,
        providerFirstLegacyFallbackActive: true,
        providerFirstLegacyFallbackComplete: true,
      }),
      true,
    );
    assert.equal(
      shouldCreateParserWorkerPool({
        useRustEngine: false,
        providerFirstLegacyFallbackActive: false,
        providerFirstLegacyFallbackComplete: false,
      }),
      true,
    );
    assert.equal(
      shouldCreateParserWorkerPool({
        useRustEngine: false,
        providerFirstLegacyFallbackActive: true,
        providerFirstLegacyFallbackComplete: false,
      }),
      false,
    );
    assert.equal(
      shouldCreateParserWorkerPool({
        useRustEngine: false,
        providerFirstLegacyFallbackActive: true,
        providerFirstLegacyFallbackComplete: true,
      }),
      true,
    );
    assert.equal(
      shouldUseBatchPersistAccumulator({
        providerFirstLegacyFallbackActive: false,
        providerFirstLegacyFallbackComplete: false,
      }),
      true,
    );
    assert.equal(
      shouldUseBatchPersistAccumulator({
        providerFirstLegacyFallbackActive: true,
        providerFirstLegacyFallbackComplete: false,
      }),
      false,
    );
    assert.equal(
      shouldUseBatchPersistAccumulator({
        providerFirstLegacyFallbackActive: true,
        providerFirstLegacyFallbackComplete: true,
      }),
      true,
    );
    assert.equal(
      shouldStabilizePass1BatchPersist({
        providerFirstLegacyFallbackActive: false,
        useBatchPersist: true,
        env: {},
        platform: "linux",
      }),
      false,
    );
    assert.equal(
      shouldStabilizePass1BatchPersist({
        providerFirstLegacyFallbackActive: false,
        useBatchPersist: true,
        env: {},
        platform: "win32",
      }),
      true,
    );
    assert.equal(
      shouldStabilizePass1BatchPersist({
        providerFirstLegacyFallbackActive: false,
        useBatchPersist: true,
        env: { SDL_MCP_PASS1_STABLE_DB_WRITES: "1" },
        platform: "linux",
      }),
      true,
    );
    assert.equal(
      shouldStabilizePass1BatchPersist({
        providerFirstLegacyFallbackActive: false,
        useBatchPersist: true,
        env: { SDL_MCP_PASS1_STABLE_DB_WRITES: "0" },
        platform: "win32",
      }),
      false,
    );
    const previousStableWritesEnv = process.env.SDL_MCP_PASS1_STABLE_DB_WRITES;
    try {
      process.env.SDL_MCP_PASS1_STABLE_DB_WRITES = "1";
      assert.equal(
        shouldStabilizePass1BatchPersist({
          providerFirstLegacyFallbackActive: false,
          useBatchPersist: true,
        }),
        true,
      );
    } finally {
      if (previousStableWritesEnv === undefined) {
        delete process.env.SDL_MCP_PASS1_STABLE_DB_WRITES;
      } else {
        process.env.SDL_MCP_PASS1_STABLE_DB_WRITES = previousStableWritesEnv;
      }
    }
    assert.equal(
      shouldStabilizePass1BatchPersist({
        providerFirstLegacyFallbackActive: true,
        useBatchPersist: true,
        env: {},
      }),
      true,
    );
    assert.equal(
      shouldStabilizePass1BatchPersist({
        providerFirstLegacyFallbackActive: true,
        useBatchPersist: false,
        env: { SDL_MCP_PASS1_STABLE_DB_WRITES: "1" },
      }),
      false,
    );
    assert.equal(
      resolvePass1BatchSymbolWriteMode({
        providerFirstLegacyFallbackActive: false,
      }),
      "merge",
    );
    assert.equal(
      resolvePass1BatchSymbolWriteMode({
        providerFirstLegacyFallbackActive: true,
      }),
      "fresh-copy",
    );
    assert.equal(
      resolveProviderFirstPass1Concurrency({
        configuredConcurrency: 8,
        fileCount: 2_339,
        providerFirstLegacyFallbackActive: true,
        providerFirstLegacyFallbackComplete: false,
      }),
      1,
    );
    assert.equal(
      resolveProviderFirstPass1Concurrency({
        configuredConcurrency: 8,
        fileCount: 2_339,
        providerFirstLegacyFallbackActive: false,
        providerFirstLegacyFallbackComplete: false,
      }),
      8,
    );
    assert.equal(
      resolveProviderFirstPass1Concurrency({
        configuredConcurrency: 8,
        fileCount: 2_339,
        providerFirstLegacyFallbackActive: true,
        providerFirstLegacyFallbackComplete: true,
      }),
      8,
    );
    assert.equal(
      shouldDeleteExistingFilesBeforeFullPass1({
        mode: "full",
        providerFirstLegacyFallbackActive: true,
        existingFileCount: 25,
      }),
      true,
    );
    assert.equal(
      shouldDeleteExistingFilesBeforeFullPass1({
        mode: "full",
        providerFirstLegacyFallbackActive: false,
        existingFileCount: 25,
      }),
      false,
    );
    assert.equal(
      shouldDeleteExistingFilesBeforeFullPass1({
        mode: "incremental",
        providerFirstLegacyFallbackActive: true,
        existingFileCount: 25,
      }),
      false,
    );
  });

  it("classifies semantic-eligible fallback gaps separately from outside-scope tails", () => {
    const report = analyzeProviderFirstCoverage({
      scannedPaths: [
        "src/provider.cpp",
        "src/missing.cpp",
        "llvm/utils/lit/lit.py",
        "docs/readme.md",
      ],
      semanticEligiblePaths: [
        "src/provider.cpp",
        "src/missing.cpp",
        "llvm/utils/lit/lit.py",
      ],
      providerPaths: ["src/provider.cpp", "llvm/utils/lit/lit.py"],
      coverage: [
        {
          relPath: "src/provider.cpp",
          legacyFallback: "skip",
          symbolCoverage: "full",
        },
        {
          relPath: "llvm/utils/lit/lit.py",
          legacyFallback: "full",
          symbolCoverage: "none",
          skippedSymbolReasons: [
            { reason: "ambiguous provider symbol", symbols: 1 },
          ],
        },
      ],
      symbols: [],
    });

    assert.deepEqual(report.summary.semanticEligibilityGap, {
      totalFiles: 2,
      uncoveredFiles: 1,
      providerUnusableFiles: 1,
      outsideSemanticEligibilityFiles: 1,
      semanticEligibleUncoveredSamples: ["src/missing.cpp"],
      semanticEligibleProviderUnusableSamples: ["llvm/utils/lit/lit.py"],
      outsideSemanticEligibilitySamples: ["docs/readme.md"],
    });
  });

  it("keeps targeted LSP coverage in the legacy fallback set", () => {
    const lspReport = analyzeProviderFirstCoverage({
      scannedPaths: ["src/caller.ts"],
      providerPaths: ["src/caller.ts"],
      coverage: [
        {
          relPath: "src/caller.ts",
          providerType: "lsp",
          legacyFallback: "targeted",
          symbolCoverage: "full",
        },
      ],
      symbols: [],
    });

    assert.deepEqual([...lspReport.fallbackPaths], ["src/caller.ts"]);
    assert.equal(lspReport.summary.partialFiles, 1);
    assert.equal(lspReport.summary.fallbackFiles, 1);
  });

  it("keeps targeted SCIP reference gaps out of the legacy fallback set", () => {
    const scipReport = analyzeProviderFirstCoverage({
      scannedPaths: ["src/index.ts"],
      providerPaths: ["src/index.ts"],
      coverage: [
        {
          relPath: "src/index.ts",
          providerType: "scip",
          legacyFallback: "targeted",
          symbolCoverage: "full",
          referenceCoverage: "partial",
        },
      ],
      symbols: [],
    });

    assert.deepEqual([...scipReport.fallbackPaths], []);
    assert.equal(scipReport.summary.partialFiles, 1);
    assert.equal(scipReport.summary.fallbackFiles, 0);
  });

  it("deduplicates call-proof samples collected from coverage and source analysis", () => {
    const report = analyzeProviderFirstCoverage({
      scannedPaths: ["src/index.ts"],
      providerPaths: ["src/index.ts"],
      coverage: [
        {
          relPath: "src/index.ts",
          legacyFallback: "skip",
          symbolCoverage: "full",
          totalResolvedReferences: 1,
          callProofUnavailableReferences: 1,
          callProofCoverage: "none",
          callProofUnavailableReasons: [
            { code: "symbolTextMismatch", references: 1 },
          ],
          callProofUnavailableSamples: [
            {
              code: "symbolTextMismatch",
              relPath: "src/index.ts",
              range: { startLine: 1, startCol: 9, endLine: 1, endCol: 15 },
              expectedText: "helper",
              actualText: "rename",
            },
          ],
        },
      ],
      symbols: [
        {
          relPath: "src/index.ts",
          providerId: "scip",
          providerSymbolId:
            "scip-typescript npm fixture 1.0.0 src/index.ts/helper().",
          name: "helper",
        },
      ],
      occurrences: [
        {
          relPath: "src/index.ts",
          role: "reference",
          providerSymbolId:
            "scip-typescript npm fixture 1.0.0 src/index.ts/helper().",
          range: { startLine: 1, startCol: 9, endLine: 1, endCol: 15 },
        },
      ],
      sourceLinesByPath: new Map([
        ["src/index.ts", new Map([[0, "  return renamed();"]])],
      ]),
    });

    const mismatchReason = report.summary.callProofIncompleteReasons?.find(
      (reason) => reason.code === "symbolTextMismatch",
    );
    assert.equal(mismatchReason?.samples?.length, 1);
  });

  it("skips shadow staging when only the legacy fallback cap defers readiness", () => {
    const gates = resolveProviderFirstReadinessGates({
      skippedLegacyFallbackReason:
        "same-run legacy fallback skipped for 39052 file(s) because providerFirst.maxLegacyFallbackFiles=5000",
    });

    assert.equal(
      gates.shadowStagingSkipReason,
      "same-run legacy fallback skipped for 39052 file(s) because providerFirst.maxLegacyFallbackFiles=5000",
    );
    assert.equal(
      gates.skipDerivedStateReason,
      "same-run legacy fallback skipped for 39052 file(s) because providerFirst.maxLegacyFallbackFiles=5000",
    );
  });

  it("keeps call-proof gaps as a shadow staging blocker", () => {
    const gates = resolveProviderFirstReadinessGates({
      callProofSkipReason:
        "provider-first SCIP call proof unavailable for 3 provider-primary file(s); derived graph algorithms remain dirty: a.cpp",
      skippedLegacyFallbackReason:
        "same-run legacy fallback skipped for 39052 file(s) because providerFirst.maxLegacyFallbackFiles=5000",
    });

    assert.equal(
      gates.shadowStagingSkipReason,
      "provider-first SCIP call proof unavailable for 3 provider-primary file(s); derived graph algorithms remain dirty: a.cpp",
    );
    assert.equal(
      gates.skipDerivedStateReason,
      "provider-first SCIP call proof unavailable for 3 provider-primary file(s); derived graph algorithms remain dirty: a.cpp; same-run legacy fallback skipped for 39052 file(s) because providerFirst.maxLegacyFallbackFiles=5000",
    );
  });

  it("keeps provider symbol ids stable across provider version drift", () => {
    const base = {
      repoId: "repo",
      providerType: "scip" as const,
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      providerSymbolId:
        "scip-typescript npm example 1.0.0 src/index.ts/buildGraph().",
      sourcePath: "src\\index.ts",
      range: { startLine: 4, startCol: 9, endLine: 8, endCol: 1 },
    };

    const first = createProviderSymbolId(base);
    const second = createProviderSymbolId({
      ...base,
      providerVersion: "2.0.0",
      sourcePath: "src/index.ts",
    });
    const differentSymbol = createProviderSymbolId({
      ...base,
      providerSymbolId:
        "scip-typescript npm example 1.0.0 src/index.ts/buildSlice().",
    });

    assert.equal(first, second);
    assert.notEqual(first, differentSymbol);
  });

  it("binds provider symbol ids to the provider id", () => {
    const sharedIdentity = {
      repoId: "repo",
      providerType: "scip" as const,
      providerSymbolId:
        "scip-typescript npm example 1.0.0 src/index.ts/buildGraph().",
      sourcePath: "src/index.ts",
    };

    const primaryProvider = createProviderSymbolId({
      ...sharedIdentity,
      providerId: "scip-typescript",
    });
    const alternateProvider = createProviderSymbolId({
      ...sharedIdentity,
      providerId: "semantic-scip",
    });

    assert.notEqual(primaryProvider, alternateProvider);
  });

  it("keeps provider symbol ids stable when definition ranges move", () => {
    const base = {
      repoId: "repo",
      providerType: "scip" as const,
      providerId: "scip-typescript",
      providerSymbolId:
        "scip-typescript npm example 1.0.0 src/index.ts/buildGraph().",
      sourcePath: "src/index.ts",
      range: { startLine: 4, startCol: 9, endLine: 8, endCol: 1 },
    };

    const first = createProviderSymbolId(base);
    const shifted = createProviderSymbolId({
      ...base,
      range: { startLine: 104, startCol: 9, endLine: 108, endCol: 1 },
    });

    assert.equal(first, shifted);
  });

  it("builds durable LSP cache keys from server, workspace, config, content, and capabilities", () => {
    const first = createLspProviderCacheKey({
      serverId: "typescript-language-server",
      serverVersion: "4.0.0",
      workspaceRoot: "F:\\repo",
      configHash: "cfg",
      fileContentHash: "file",
      capabilitySet: ["textDocument/definition", "workspace/symbol"],
    });

    const second = createLspProviderCacheKey({
      capabilitySet: ["workspace/symbol", "textDocument/definition"],
      fileContentHash: "file",
      configHash: "cfg",
      workspaceRoot: "F:/repo",
      serverVersion: "4.0.0",
      serverId: "typescript-language-server",
    });

    assert.equal(first, second);
    assert.match(first, /^lsp-cache:typescript-language-server:/);
  });

  it("selects provider-first in auto mode only when SCIP or LSP coverage is configured", () => {
    const legacy = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({}),
    });
    assert.equal(legacy.selectedPipeline, "legacy");
    assert.deepEqual(
      legacy.sources.map((source) => source.type),
      ["legacy"],
    );

    const scip = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({}),
      scip: ScipConfigSchema.parse({
        enabled: true,
        indexes: [{ path: "index.scip" }],
      }),
    });
    assert.equal(scip.selectedPipeline, "providerFirst");
    assert.deepEqual(
      scip.sources.map((source) => source.type),
      ["scip", "legacy"],
    );

    const lsp = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({}),
      semanticEnrichment: SemanticEnrichmentConfigSchema.parse({
        enabled: true,
        providers: {
          lsp: {
            enabled: true,
            servers: {
              tsserver: {
                serverId: "tsserver",
                command: "typescript-language-server",
                languages: ["typescript"],
              },
            },
          },
        },
      }),
    });
    assert.equal(lsp.selectedPipeline, "providerFirst");
    assert.deepEqual(
      lsp.sources.map((source) => source.type),
      ["lsp", "legacy"],
    );
  });

  it("forces provider-first when explicit legacy mode has SCIP provider inputs", () => {
    const selection = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({ pipeline: "legacy" }),
      scip: ScipConfigSchema.parse({
        enabled: true,
        indexes: [{ path: "index.scip" }],
      }),
    });

    assert.equal(selection.requestedMode, "legacy");
    assert.equal(selection.selectedPipeline, "providerFirst");
    assert.deepEqual(
      selection.sources.map((source) => source.type),
      ["scip", "legacy"],
    );
    assert.match(selection.warnings.join(" "), /provider-first/i);
  });

  it("forces provider-first when explicit legacy mode has SCIP enabled without indexes yet", () => {
    const selection = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({ pipeline: "legacy" }),
      scip: ScipConfigSchema.parse({ enabled: true }),
    });

    assert.equal(selection.requestedMode, "legacy");
    assert.equal(selection.selectedPipeline, "providerFirst");
    assert.deepEqual(
      selection.sources.map((source) => source.type),
      ["scip", "legacy"],
    );
    assert.match(selection.warnings.join(" "), /provider-first/i);
  });

  it("keeps explicit legacy mode when provider inputs are disabled", () => {
    const selection = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({ pipeline: "legacy" }),
      scip: ScipConfigSchema.parse({ enabled: false }),
    });

    assert.equal(selection.selectedPipeline, "legacy");
    assert.deepEqual(
      selection.sources.map((source) => source.type),
      ["legacy"],
    );
    assert.deepEqual(selection.warnings, []);
  });

  it("forces provider-first when explicit legacy mode has LSP provider inputs", () => {
    const selection = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({ pipeline: "legacy" }),
      semanticEnrichment: SemanticEnrichmentConfigSchema.parse({
        enabled: true,
        providers: {
          lsp: {
            enabled: true,
            servers: {
              tsserver: {
                serverId: "tsserver",
                command: "typescript-language-server",
                languages: ["typescript"],
              },
            },
          },
        },
      }),
    });

    assert.equal(selection.requestedMode, "legacy");
    assert.equal(selection.selectedPipeline, "providerFirst");
    assert.deepEqual(
      selection.sources.map((source) => source.type),
      ["lsp", "legacy"],
    );
    assert.match(selection.warnings.join(" "), /provider-first/i);
  });

  it("normalizes SCIP documents into provider-neutral facts", () => {
    const symbol =
      "scip-typescript npm example 1.0.0 src/index.ts/buildGraph().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [
        {
          language: "typescript",
          relativePath: "src\\index.ts",
          occurrences: [
            {
              range: { startLine: 4, startCol: 16, endLine: 4, endCol: 26 },
              symbol,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol,
              documentation: ["Builds the graph."],
              relationships: [],
              kind: 12,
              displayName: "buildGraph",
              signatureDocumentation: "function buildGraph(): Graph",
            },
          ],
        },
      ],
    });

    assert.equal(facts.files.length, 1);
    assert.equal(facts.files[0]?.relPath, "src/index.ts");
    assert.equal(facts.symbols.length, 1);
    assert.equal(facts.symbols[0]?.name, "buildGraph");
    assert.equal(facts.symbols[0]?.symbolKind, "function");
    assert.equal(facts.symbols[0]?.providerSymbolId, symbol);
    assert.equal(facts.symbols[0]?.range?.startLine, 5);
    assert.equal(facts.occurrences.length, 1);
    assert.equal(facts.coverage[0]?.symbolCoverage, "full");
  });

  it("falls back from invalid SCIP enclosing ranges before graph row shaping", () => {
    const symbol =
      "scip-java maven cf 1.0.0 src/main/java/example/Fleet.java/Fleet#run().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-io",
      providerVersion: "0.1.9",
      documents: [
        {
          language: "java",
          relativePath: "src/main/java/example/Fleet.java",
          occurrences: [
            {
              range: { startLine: 41, startCol: 8, endLine: 41, endCol: 11 },
              enclosingRange: {
                startLine: 41,
                startCol: 8,
                endLine: 41,
                endCol: -2,
              },
              symbol,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol,
              documentation: [],
              relationships: [],
              kind: 6,
              displayName: "run",
              signatureDocumentation: "void run()",
            },
          ],
        },
      ],
    });

    assert.deepEqual(facts.symbols[0]?.range, {
      startLine: 42,
      startCol: 8,
      endLine: 42,
      endCol: 11,
    });

    facts.files[0]!.contentHash = "1".repeat(64);
    facts.files[0]!.byteSize = 42;
    const rows = providerFactsToGraphRows({ facts });
    assert.equal(rows.symbols[0]?.rangeEndCol, 11);
    validateProviderFirstGraphRows(rows, { repoId: "repo" });
  });

  it("normalizes scip-python module initializer symbols as provider-usable modules", () => {
    const symbol =
      "scip-python python sentry 0.0.0 `fixtures.page_objects`/__init__:";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-python",
      providerVersion: "1.0.0",
      documents: [
        {
          language: "python",
          relativePath: "fixtures/page_objects/__init__.py",
          occurrences: [
            {
              range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
              symbol,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol,
              documentation: ["(module) fixtures.page_objects"],
              relationships: [],
              kind: 0,
              displayName: "",
            },
          ],
        },
      ],
    });

    assert.equal(facts.symbols.length, 1);
    assert.equal(facts.symbols[0]?.name, "fixtures.page_objects");
    assert.equal(facts.symbols[0]?.symbolKind, "module");
    assert.equal(facts.occurrences[0]?.symbolId, facts.symbols[0]?.symbolId);
    assert.equal(facts.coverage[0]?.symbolCoverage, "full");
    assert.equal(facts.coverage[0]?.referenceCoverage, "full");
    assert.equal(facts.coverage[0]?.legacyFallback, "skip");
  });

  it("coalesces duplicate SCIP documents for the same normalized file path", () => {
    const symbol =
      "scip-typescript npm example 1.0.0 src/index.ts/buildGraph().";
    const document = {
      language: "typescript",
      relativePath: "src\\index.ts",
      occurrences: [
        {
          range: { startLine: 4, startCol: 16, endLine: 4, endCol: 26 },
          symbol,
          symbolRoles: 1,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
        },
      ],
      symbols: [
        {
          symbol,
          documentation: ["Builds the graph."],
          relationships: [],
          kind: 12,
          displayName: "buildGraph",
          signatureDocumentation: "function buildGraph(): Graph",
        },
      ],
    };

    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [document, document],
    });

    assert.equal(facts.files.length, 1);
    assert.equal(facts.symbols.length, 1);
    assert.equal(facts.occurrences.length, 1);
    assert.equal(facts.coverage.length, 1);
    assert.equal(facts.providerRuns[0]?.fileCount, 1);
    validateProviderFirstGraphRows(
      providerFactsToGraphRows({ facts: withProviderFileMetadata(facts) }),
      {
        repoId: "repo",
      },
    );
  });

  it("coalesces duplicate SCIP symbols and occurrences within one document", () => {
    const symbol =
      "scip-typescript npm example 1.0.0 src/index.ts/buildGraph().";
    const occurrence = {
      range: { startLine: 4, startCol: 16, endLine: 4, endCol: 26 },
      symbol,
      symbolRoles: 1,
      overrideDocumentation: [],
      syntaxKind: 0,
      diagnostics: [],
    };
    const symbolInfo = {
      symbol,
      documentation: ["Builds the graph."],
      relationships: [],
      kind: 12,
      displayName: "buildGraph",
      signatureDocumentation: "function buildGraph(): Graph",
    };

    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [occurrence, occurrence],
          symbols: [symbolInfo, symbolInfo],
        },
      ],
    });

    assert.equal(facts.symbols.length, 1);
    assert.equal(facts.occurrences.length, 1);
    assert.equal(facts.coverage[0]?.totalSymbols, 1);
    assert.equal(facts.coverage[0]?.totalOccurrences, 1);
    validateProviderFirstGraphRows(
      providerFactsToGraphRows({ facts: withProviderFileMetadata(facts) }),
      {
        repoId: "repo",
      },
    );
  });

  it("does not emit duplicate symbols from referenced-only SCIP metadata", () => {
    const symbol =
      "scip-python python sentry 0.0.0 `fixtures.page_objects.base`/BasePage#browser.";
    const symbolInfo = {
      symbol,
      documentation: ["Browser fixture."],
      relationships: [],
      kind: 7,
      displayName: "browser",
      signatureDocumentation: "browser: Browser",
    };

    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-python",
      providerVersion: "1.0.0",
      documents: [
        {
          language: "python",
          relativePath: "fixtures/page_objects/base.py",
          occurrences: [
            {
              range: { startLine: 9, startCol: 13, endLine: 9, endCol: 20 },
              symbol,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [symbolInfo],
        },
        {
          language: "python",
          relativePath: "fixtures/page_objects/explore_logs.py",
          occurrences: [
            {
              range: { startLine: 12, startCol: 8, endLine: 12, endCol: 15 },
              symbol,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [symbolInfo],
        },
      ],
    });

    assert.equal(facts.symbols.length, 1);
    assert.equal(facts.symbols[0]?.relPath, "fixtures/page_objects/base.py");
    assert.deepEqual(
      facts.occurrences.map((occurrence) => occurrence.symbolId),
      [facts.symbols[0]?.symbolId, facts.symbols[0]?.symbolId],
    );
    assert.deepEqual(
      facts.coverage.map((coverage) => coverage.symbolCoverage),
      ["full", "full"],
    );
    validateProviderFirstGraphRows(
      providerFactsToGraphRows({ facts: withProviderFileMetadata(facts) }),
      {
        repoId: "repo",
      },
    );
  });

  it("keeps local SCIP metadata without a definition occurrence as a non-real endpoint", () => {
    const symbol =
      "scip-typescript npm example 1.0.0 src/index.ts/noDefinition().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [],
          symbols: [
            {
              symbol,
              documentation: ["Metadata only symbol."],
              relationships: [],
              kind: 12,
              displayName: "noDefinition",
              signatureDocumentation: "function noDefinition(): void",
            },
          ],
        },
      ],
    });

    assert.equal(facts.files.length, 1);
    assert.equal(facts.symbols.length, 1);
    assert.equal(facts.symbols[0]?.symbolStatus, "unresolved");
    assert.equal(facts.symbols[0]?.range, undefined);
    assert.equal(facts.coverage[0]?.symbolCoverage, "none");
    assert.equal(facts.coverage[0]?.legacyFallback, "full");
    assert.deepEqual(facts.coverage[0]?.skippedSymbolReasons, [
      { reason: "missing definition occurrence", symbols: 1 },
    ]);
    const rows = providerFactsToGraphRows({
      facts: withProviderFileMetadata(facts),
    });
    assert.equal(rows.symbols[0]?.symbolStatus, "unresolved");
    assert.equal(rows.symbols[0]?.rangeStartLine, 0);
    validateProviderFirstGraphRows(rows, { repoId: "repo" });
  });

  it("skips ambiguous C++ provider symbols with definitions in multiple files", () => {
    const symbol = "cxx . . $ OutputBuffer#";
    const symbolInfo = {
      symbol,
      documentation: ["Output buffer."],
      relationships: [],
      kind: 0,
      displayName: "OutputBuffer",
      signatureDocumentation: "class OutputBuffer",
    };

    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-clang",
      providerVersion: "0.3.2",
      documents: [
        {
          language: "Cpp",
          relativePath: "llvm/lib/Demangle/DLangDemangle.cpp",
          occurrences: [
            {
              range: { startLine: 25, startCol: 30, endLine: 25, endCol: 42 },
              symbol,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [symbolInfo],
        },
        {
          language: "Cpp",
          relativePath: "llvm/lib/Demangle/RustDemangle.cpp",
          occurrences: [
            {
              range: { startLine: 26, startCol: 30, endLine: 26, endCol: 42 },
              symbol,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [symbolInfo],
        },
      ],
    });

    assert.equal(facts.symbols.length, 0);
    assert.deepEqual(
      facts.occurrences.map((occurrence) => occurrence.symbolId),
      [undefined, undefined],
    );
    assert.deepEqual(
      facts.coverage.map((coverage) => coverage.skippedSymbolReasons),
      [
        [{ reason: "ambiguous provider symbol", symbols: 1 }],
        [{ reason: "ambiguous provider symbol", symbols: 1 }],
      ],
    );
    validateProviderFirstGraphRows(
      providerFactsToGraphRows({ facts: withProviderFileMetadata(facts) }),
      {
        repoId: "repo",
      },
    );
  });

  it("normalizes rust-analyzer module descriptors into usable module symbols", () => {
    const symbol = "rust-analyzer cargo sdl-mcp-native 0.1.0 cluster/";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "rust-analyzer",
      documents: [
        {
          language: "rust",
          relativePath: "native/src/cluster/mod.rs",
          occurrences: [
            {
              range: { startLine: 0, startCol: 0, endLine: 0, endCol: 7 },
              symbol,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol,
              documentation: [],
              relationships: [],
              kind: 2,
              displayName: "cluster",
              signatureDocumentation: "",
            },
          ],
        },
      ],
    });

    assert.equal(facts.symbols.length, 1);
    assert.equal(facts.symbols[0]?.name, "cluster");
    assert.equal(facts.symbols[0]?.symbolKind, "module");
    assert.equal(facts.coverage[0]?.symbolCoverage, "full");
    assert.equal(facts.coverage[0]?.legacyFallback, "skip");
    assert.equal(facts.coverage[0]?.skippedSymbolReasons, undefined);
  });

  it("coalesces repeated rust-analyzer crate namespace symbols", () => {
    const symbol = "rust-analyzer cargo sdl-mcp-native 0.1.0 crate/";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "rust-analyzer",
      documents: [
        {
          language: "rust",
          relativePath: "native/build.rs",
          occurrences: [
            {
              range: { startLine: 0, startCol: 0, endLine: 0, endCol: 5 },
              symbol,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol,
              documentation: [],
              relationships: [],
              kind: 29,
              displayName: "",
              signatureDocumentation: "",
            },
          ],
        },
        {
          language: "rust",
          relativePath: "native/src/lib.rs",
          occurrences: [
            {
              range: { startLine: 0, startCol: 0, endLine: 0, endCol: 5 },
              symbol,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol,
              documentation: [],
              relationships: [],
              kind: 29,
              displayName: "",
              signatureDocumentation: "",
            },
          ],
        },
      ],
    });

    assert.equal(facts.symbols.length, 1);
    assert.equal(facts.symbols[0]?.name, "crate");
    assert.equal(facts.symbols[0]?.symbolKind, "module");
    assert.deepEqual(
      facts.occurrences.map((occurrence) => occurrence.symbolId),
      [facts.symbols[0]?.symbolId, facts.symbols[0]?.symbolId],
    );
    assert.deepEqual(
      facts.coverage.map((coverage) => coverage.symbolCoverage),
      ["full", "full"],
    );
  });

  it("normalizes SCIP definition enclosing ranges and skips broad reference occurrences as calls", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const helper = "scip-typescript npm example 1.0.0 src/index.ts/helper().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 3,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 9, endLine: 1, endCol: 15 },
              symbol: helper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 5, startCol: 16, endLine: 5, endCol: 22 },
              enclosingRange: {
                startLine: 5,
                startCol: 0,
                endLine: 7,
                endCol: 1,
              },
              symbol: helper,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
            {
              symbol: helper,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "helper",
            },
          ],
        },
      ],
    });

    const mainFact = facts.symbols.find((symbol) => symbol.name === "main");
    const helperFact = facts.symbols.find((symbol) => symbol.name === "helper");
    assert.equal(mainFact?.range?.startLine, 1);
    assert.equal(mainFact?.range?.endLine, 4);
    assert.equal(helperFact?.range?.startLine, 6);

    assert.equal(facts.edges.length, 0);
  });

  it("promotes SCIP reference occurrences to exact calls when source text proves invocation syntax", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const helper = "scip-typescript npm example 1.0.0 src/index.ts/helper().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "export function main() {",
            "  return helper ();",
            "}",
            "",
            "export function helper() {",
            "  return 1;",
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 2,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 9, endLine: 1, endCol: 15 },
              symbol: helper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 4, startCol: 16, endLine: 4, endCol: 22 },
              enclosingRange: {
                startLine: 4,
                startCol: 0,
                endLine: 6,
                endCol: 1,
              },
              symbol: helper,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
            {
              symbol: helper,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "helper",
            },
          ],
        },
      ],
    });

    const callEdges = facts.edges.filter((edge) => edge.edgeType === "call");
    assert.equal(callEdges.length, 1);
    assert.equal(callEdges[0]?.resolution, "exact");
    assert.equal(callEdges[0]?.confidence, 0.95);
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
  });

  it("uses the smallest containing provider symbol for reference edges", () => {
    const outer = "scip-typescript npm example 1.0.0 src/index.ts/outer().";
    const inner = "scip-typescript npm example 1.0.0 src/index.ts/inner().";
    const helper = "scip-typescript npm example 1.0.0 src/index.ts/helper().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "export function outer() {",
            "  function inner() {",
            "    return helper();",
            "  }",
            "  return inner();",
            "}",
            "export function helper() { return 1; }",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 21 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 5,
                endCol: 1,
              },
              symbol: outer,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 11, endLine: 1, endCol: 16 },
              enclosingRange: {
                startLine: 1,
                startCol: 2,
                endLine: 3,
                endCol: 3,
              },
              symbol: inner,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 2, startCol: 11, endLine: 2, endCol: 17 },
              symbol: helper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 6, startCol: 16, endLine: 6, endCol: 22 },
              enclosingRange: {
                startLine: 6,
                startCol: 0,
                endLine: 6,
                endCol: 45,
              },
              symbol: helper,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: outer,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "outer",
            },
            {
              symbol: inner,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "inner",
            },
            {
              symbol: helper,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "helper",
            },
          ],
        },
      ],
    });

    const innerFact = facts.symbols.find((symbol) => symbol.name === "inner");
    const helperFact = facts.symbols.find((symbol) => symbol.name === "helper");
    const helperCall = facts.edges.find(
      (edge) =>
        edge.edgeType === "call" &&
        edge.targetSymbolId === helperFact?.symbolId,
    );

    assert.equal(helperCall?.sourceSymbolId, innerFact?.symbolId);
  });

  it("can skip retained occurrence facts while preserving coverage and edges", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const helper = "scip-typescript npm example 1.0.0 src/index.ts/helper().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      retainOccurrenceFacts: false,
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "export function main() {",
            "  return helper();",
            "}",
            "export function helper() { return 1; }",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 2,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 9, endLine: 1, endCol: 15 },
              symbol: helper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 3, startCol: 16, endLine: 3, endCol: 22 },
              enclosingRange: {
                startLine: 3,
                startCol: 0,
                endLine: 3,
                endCol: 45,
              },
              symbol: helper,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
            {
              symbol: helper,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "helper",
            },
          ],
        },
      ],
    });

    assert.equal(facts.occurrences.length, 0);
    assert.equal(facts.coverage[0]?.totalOccurrences, 3);
    assert.equal(facts.coverage[0]?.referenceCoverage, "full");
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(
      facts.edges.filter((edge) => edge.edgeType === "call").length,
      1,
    );
  });

  it("promotes Python nested descriptor references when source text names the terminal callable", () => {
    const main = "scip-python python sentry 0.0.0 `pkg.module`/main().";
    const wrapper =
      "scip-python python sentry 0.0.0 `pkg.module`/eventclass().wrapper.";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-python",
      sourceTextByPath: new Map([
        [
          "pkg/module.py",
          [
            "def main():",
            "  return wrapper()",
            "",
            "def wrapper():",
            "  return 1",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "python",
          relativePath: "pkg/module.py",
          occurrences: [
            {
              range: { startLine: 0, startCol: 4, endLine: 0, endCol: 8 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 1,
                endCol: 18,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 9, endLine: 1, endCol: 16 },
              symbol: wrapper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 3, startCol: 4, endLine: 3, endCol: 11 },
              enclosingRange: {
                startLine: 3,
                startCol: 0,
                endLine: 4,
                endCol: 10,
              },
              symbol: wrapper,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
            {
              symbol: wrapper,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "eventclass().wrapper",
            },
          ],
        },
      ],
    });

    const callEdges = facts.edges.filter((edge) => edge.edgeType === "call");
    assert.equal(callEdges.length, 1);
    assert.equal(callEdges[0]?.resolution, "exact");
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
  });

  it("proves JVM constructor references whose provider display name is <init>", () => {
    const main =
      "semanticdb maven maven/com.example/app 1.0.0 example/CardAdapter#fromJson().";
    const cardConstructor =
      "semanticdb maven maven/com.example/app 1.0.0 example/Card#`<init>`(+1).";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-java",
      sourceTextByPath: new Map([
        [
          "example/CardAdapter.java",
          [
            "class CardAdapter {",
            "  Card fromJson(char rank) {",
            "    return new Card(rank);",
            "  }",
            "}",
          ].join("\n"),
        ],
      ]),
      externalSymbols: [
        {
          symbol: cardConstructor,
          documentation: [],
          relationships: [],
          kind: 9,
          displayName: "<init>",
        },
      ],
      documents: [
        {
          language: "java",
          relativePath: "example/CardAdapter.java",
          occurrences: [
            {
              range: { startLine: 1, startCol: 7, endLine: 1, endCol: 15 },
              enclosingRange: {
                startLine: 1,
                startCol: 2,
                endLine: 3,
                endCol: 3,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 2, startCol: 15, endLine: 2, endCol: 19 },
              symbol: cardConstructor,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 6,
              displayName: "fromJson",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      true,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
  });

  it("proves qualified JVM/Kotlin constructor references by terminal name", () => {
    const main =
      "semanticdb maven maven/com.example/app 1.0.0 example/BridgeKt#bridge().";
    const dispatcherConstructor =
      "semanticdb maven maven/com.example/app 1.0.0 mockwebserver3/Dispatcher#`<init>`().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-java",
      sourceTextByPath: new Map([
        [
          "example/Bridge.kt",
          [
            "fun bridge() {",
            "  object : mockwebserver3.Dispatcher() {}",
            "}",
          ].join("\n"),
        ],
      ]),
      externalSymbols: [
        {
          symbol: dispatcherConstructor,
          documentation: [],
          relationships: [],
          kind: 9,
          displayName: "<init>",
        },
      ],
      documents: [
        {
          language: "kotlin",
          relativePath: "example/Bridge.kt",
          occurrences: [
            {
              range: { startLine: 0, startCol: 4, endLine: 0, endCol: 10 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 2,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 11, endLine: 1, endCol: 36 },
              symbol: dispatcherConstructor,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "bridge",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      true,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
  });

  it("proves qualified JVM/Kotlin type references with invocation syntax", () => {
    const main =
      "semanticdb maven maven/com.example/app 1.0.0 example/BridgeKt#bridge().";
    const dispatcherType =
      "semanticdb maven maven/com.example/app 1.0.0 mockwebserver3/Dispatcher#";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-java",
      sourceTextByPath: new Map([
        [
          "example/Bridge.kt",
          [
            "fun bridge() {",
            "  object : mockwebserver3.Dispatcher() {}",
            "}",
          ].join("\n"),
        ],
      ]),
      externalSymbols: [
        {
          symbol: dispatcherType,
          documentation: [],
          relationships: [],
          kind: 5,
          displayName: "Dispatcher",
        },
      ],
      documents: [
        {
          language: "kotlin",
          relativePath: "example/Bridge.kt",
          occurrences: [
            {
              range: { startLine: 0, startCol: 4, endLine: 0, endCol: 10 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 2,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 11, endLine: 1, endCol: 36 },
              symbol: dispatcherType,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "bridge",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      true,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
  });

  it("proves JVM this and super constructor delegation calls through type symbols", () => {
    const delegatedConstructor =
      "semanticdb maven maven/com.example/app 1.0.0 example/JsonValueSource#`<init>`().";
    const delegatedType =
      "semanticdb maven maven/com.example/app 1.0.0 example/JsonValueSource#";
    const superType =
      "semanticdb maven maven/com.example/app 1.0.0 example/JsonReader#";
    const sourceText = [
      "class JsonValueSource extends JsonReader {",
      "  JsonValueSource() {",
      "    this(null);",
      "  }",
      "  JsonValueSource(Object value) {",
      "    super(value);",
      "  }",
      "}",
    ].join("\n");
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-java",
      sourceTextByPath: new Map([["example/JsonValueSource.java", sourceText]]),
      externalSymbols: [
        {
          symbol: delegatedType,
          documentation: [],
          relationships: [],
          kind: 5,
          displayName: "JsonValueSource",
        },
        {
          symbol: superType,
          documentation: [],
          relationships: [],
          kind: 5,
          displayName: "JsonReader",
        },
      ],
      documents: [
        {
          language: "java",
          relativePath: "example/JsonValueSource.java",
          occurrences: [
            {
              range: { startLine: 1, startCol: 2, endLine: 1, endCol: 17 },
              enclosingRange: {
                startLine: 1,
                startCol: 2,
                endLine: 6,
                endCol: 3,
              },
              symbol: delegatedConstructor,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 2, startCol: 4, endLine: 2, endCol: 8 },
              symbol: delegatedType,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 5, startCol: 4, endLine: 5, endCol: 9 },
              symbol: superType,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: delegatedConstructor,
              documentation: [],
              relationships: [],
              kind: 9,
              displayName: "<init>",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.filter((edge) => edge.edgeType === "call").length,
      2,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
  });

  it("keeps broad JVM delegated property spans neutral when ranges exceed source lines", () => {
    const owner =
      "semanticdb maven maven/com.example/app 1.0.0 example/Main#";
    const property =
      "semanticdb maven maven/com.example/app 1.0.0 example/Main#userAgent.";
    const getter =
      "semanticdb maven maven/com.example/app 1.0.0 example/Main#getUserAgent().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-java",
      sourceTextByPath: new Map([
        [
          "example/Main.kt",
          [
            "class Main {",
            "  val userAgent: String by option(",
            "    \"--user-agent\",",
            "  )",
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "kotlin",
          relativePath: "example/Main.kt",
          occurrences: [
            {
              range: { startLine: 0, startCol: 6, endLine: 0, endCol: 10 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 4,
                endCol: 1,
              },
              symbol: owner,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 6, endLine: 1, endCol: 15 },
              enclosingRange: {
                startLine: 1,
                startCol: 2,
                endLine: 3,
                endCol: 3,
              },
              symbol: property,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 27, endLine: 1, endCol: 152 },
              symbol: property,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 27, endLine: 1, endCol: 152 },
              symbol: getter,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: owner,
              documentation: [],
              relationships: [],
              kind: 5,
              displayName: "Main",
            },
            {
              symbol: property,
              documentation: [],
              relationships: [],
              kind: 7,
              displayName: "userAgent",
            },
            {
              symbol: getter,
              documentation: [],
              relationships: [],
              kind: 6,
              displayName: "getUserAgent",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.filter((edge) => edge.edgeType === "call").length,
      0,
    );
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
  });

  it("keeps broad JVM type spans neutral when ranges exceed source lines", () => {
    const protocol =
      "semanticdb maven maven/com.example/app 1.0.0 example/Protocol#";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-java",
      sourceTextByPath: new Map([
        [
          "example/Protocol.kt",
          [
            "/** Protocol docs. */",
            "enum class Protocol {",
            "  HTTP_1_1,",
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "kotlin",
          relativePath: "example/Protocol.kt",
          occurrences: [
            {
              range: { startLine: 1, startCol: 11, endLine: 1, endCol: 19 },
              enclosingRange: {
                startLine: 1,
                startCol: 0,
                endLine: 3,
                endCol: 1,
              },
              symbol: protocol,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 0, startCol: 0, endLine: 0, endCol: 3901 },
              symbol: protocol,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: protocol,
              documentation: [],
              relationships: [],
              kind: 10,
              displayName: "Protocol",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.filter((edge) => edge.edgeType === "call").length,
      0,
    );
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
  });

  it("keeps Python module qualifier ranges neutral when source invokes a member", () => {
    const main = "scip-python python example 0.0.0 `pkg.script`/main().";
    const module = "scip-python python example 0.0.0 `lit.util`/__init__:";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-python",
      sourceTextByPath: new Map([
        [
          "pkg/script.py",
          ["def main():", '    lit.util.warning("escape")'].join("\n"),
        ],
        ["lit/util/__init__.py", ""],
      ]),
      documents: [
        {
          language: "python",
          relativePath: "lit/util/__init__.py",
          occurrences: [
            {
              range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
              symbol: module,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: module,
              documentation: ["(module) lit.util"],
              relationships: [],
              kind: 0,
              displayName: "",
            },
          ],
        },
        {
          language: "python",
          relativePath: "pkg/script.py",
          occurrences: [
            {
              range: { startLine: 0, startCol: 4, endLine: 0, endCol: 8 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 1,
                endCol: 30,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 4, endLine: 1, endCol: 20 },
              symbol: module,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      false,
    );
    assert.equal(facts.coverage[1]?.callProofCoverage, "full");
    assert.equal(facts.coverage[1]?.totalResolvedReferences, 0);
    assert.equal(facts.coverage[1]?.callProofUnavailableReferences, 0);
    assert.deepEqual(facts.coverage[1]?.callProofUnavailableReasons, []);
  });

  it("promotes Python import aliases when SCIP marks the imported alias clause", () => {
    const main =
      "scip-python python example 0.0.0 `mlir.python.mlir.dialects.affine`/main().";
    const helper =
      "scip-python python example 0.0.0 `mlir.python.mlir.dialects._ods_common`/get_op_result_or_value().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-python",
      sourceTextByPath: new Map([
        [
          "mlir/python/mlir/dialects/affine.py",
          [
            "from ._ods_common import (",
            "    get_op_result_or_value as _get_op_result_or_value,",
            ")",
            "def main(value):",
            "    return _get_op_result_or_value(value)",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "python",
          relativePath: "mlir/python/mlir/dialects/affine.py",
          occurrences: [
            {
              range: { startLine: 1, startCol: 4, endLine: 1, endCol: 53 },
              symbol: helper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 3, startCol: 4, endLine: 3, endCol: 8 },
              enclosingRange: {
                startLine: 3,
                startCol: 0,
                endLine: 4,
                endCol: 41,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 4, startCol: 11, endLine: 4, endCol: 34 },
              symbol: helper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
          ],
        },
      ],
      externalSymbols: [
        {
          symbol: helper,
          documentation: [],
          relationships: [],
          kind: 12,
          displayName: "get_op_result_or_value",
        },
      ],
    });

    const callEdges = facts.edges.filter((edge) => edge.edgeType === "call");
    assert.equal(callEdges.length, 1);
    assert.equal(callEdges[0]?.resolution, "exact");
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.totalResolvedReferences, 1);
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
    assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
  });

  it("promotes constructor references when source text names the owning class", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const constructor =
      "scip-typescript npm example 1.0.0 src/index.ts/Executor#`<constructor>`().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "export function main() {",
            "  return new Executor();",
            "}",
            "",
            "export class Executor {",
            "  constructor() {}",
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 2,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 13, endLine: 1, endCol: 21 },
              symbol: constructor,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 5, startCol: 2, endLine: 5, endCol: 13 },
              enclosingRange: {
                startLine: 5,
                startCol: 2,
                endLine: 5,
                endCol: 19,
              },
              symbol: constructor,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
            {
              symbol: constructor,
              documentation: [],
              relationships: [],
              kind: 9,
              displayName: "`<constructor>`",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      true,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.totalResolvedReferences, 1);
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
    assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
  });

  it("promotes type-literal member references when source text names the member", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const cleanupSession =
      "scip-typescript npm example 1.0.0 src/index.ts/createHandlers().typeLiteral753:cleanupSession().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "export function main() {",
            "  return cleanupSession();",
            "}",
            "",
            "const handlers = {",
            "  cleanupSession() {",
            "    return 1;",
            "  },",
            "};",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 2,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 9, endLine: 1, endCol: 23 },
              symbol: cleanupSession,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 5, startCol: 2, endLine: 5, endCol: 16 },
              enclosingRange: {
                startLine: 5,
                startCol: 2,
                endLine: 7,
                endCol: 3,
              },
              symbol: cleanupSession,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
            {
              symbol: cleanupSession,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "typeLiteral753:cleanupSession",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      true,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.totalResolvedReferences, 1);
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
    assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
  });

  it("promotes aliased import references when source text names the local alias", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const estimateTokens =
      "scip-typescript npm example 1.0.0 src/util/tokenize.ts/estimateTokens().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            'import { estimateTokens as estimateTokenCount } from "../util/tokenize.js";',
            "export function main() {",
            '  return estimateTokenCount("x");',
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 9, endLine: 0, endCol: 23 },
              symbol: estimateTokens,
              symbolRoles: 0,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 0, startCol: 27, endLine: 0, endCol: 45 },
              symbol: estimateTokens,
              symbolRoles: 0,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 16, endLine: 1, endCol: 20 },
              enclosingRange: {
                startLine: 1,
                startCol: 0,
                endLine: 3,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 2, startCol: 9, endLine: 2, endCol: 27 },
              symbol: estimateTokens,
              symbolRoles: 0,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
          ],
        },
      ],
      externalSymbols: [
        {
          symbol: estimateTokens,
          documentation: [],
          relationships: [],
          kind: 12,
          displayName: "estimateTokens",
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      true,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.totalResolvedReferences, 1);
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
    assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
  });

  it("promotes import aliases when SCIP only marks the imported name", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const clearCache =
      "scip-typescript npm example 1.0.0 src/grammarLoader.ts/clearCache().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            'import { clearCache as clearGrammarCache } from "../treesitter/grammarLoader.js";',
            "export function main() {",
            '  clearGrammarCache("c");',
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 9, endLine: 0, endCol: 19 },
              symbol: clearCache,
              symbolRoles: 0,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 16, endLine: 1, endCol: 20 },
              enclosingRange: {
                startLine: 1,
                startCol: 0,
                endLine: 3,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 2, startCol: 2, endLine: 2, endCol: 19 },
              symbol: clearCache,
              symbolRoles: 0,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
          ],
        },
      ],
      externalSymbols: [
        {
          symbol: clearCache,
          documentation: [],
          relationships: [],
          kind: 12,
          displayName: "clearCache",
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      true,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.totalResolvedReferences, 1);
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
    assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
  });

  it("promotes multi-line import aliases when SCIP only marks the imported name", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const clearCache =
      "scip-typescript npm example 1.0.0 src/grammarLoader.ts/clearCache().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "import {",
            "  clearCache as clearGrammarCache,",
            '} from "../treesitter/grammarLoader.js";',
            "export function main() {",
            '  clearGrammarCache("c");',
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 1, startCol: 2, endLine: 1, endCol: 12 },
              symbol: clearCache,
              symbolRoles: 0,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 3, startCol: 16, endLine: 3, endCol: 20 },
              enclosingRange: {
                startLine: 3,
                startCol: 0,
                endLine: 5,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 4, startCol: 2, endLine: 4, endCol: 19 },
              symbol: clearCache,
              symbolRoles: 0,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
          ],
        },
      ],
      externalSymbols: [
        {
          symbol: clearCache,
          documentation: [],
          relationships: [],
          kind: 12,
          displayName: "clearCache",
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      true,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.totalResolvedReferences, 1);
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
    assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
  });

  it("does not treat non-import TypeScript as-expressions as import aliases", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const estimateTokens =
      "scip-typescript npm example 1.0.0 src/util/tokenize.ts/estimateTokens().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "export function main() {",
            "  const estimateTokenCount = estimateTokens as unknown;",
            "  return estimateTokenCount();",
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 3,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 8, endLine: 1, endCol: 26 },
              symbol: estimateTokens,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 2, startCol: 9, endLine: 2, endCol: 27 },
              symbol: estimateTokens,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
          ],
        },
      ],
      externalSymbols: [
        {
          symbol: estimateTokens,
          documentation: [],
          relationships: [],
          kind: 12,
          displayName: "estimateTokens",
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      false,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "none");
    assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, [
      { code: "symbolTextMismatch", references: 1 },
    ]);
  });

  it("does not promote SCIP reference occurrences when source text shows a value read", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const helper = "scip-typescript npm example 1.0.0 src/index.ts/helper().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "export function main() {",
            "  return helper;",
            "}",
            "",
            "export function helper() {",
            "  return 1;",
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 2,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 9, endLine: 1, endCol: 15 },
              symbol: helper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 4, startCol: 16, endLine: 4, endCol: 22 },
              enclosingRange: {
                startLine: 4,
                startCol: 0,
                endLine: 6,
                endCol: 1,
              },
              symbol: helper,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
            {
              symbol: helper,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "helper",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      false,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
  });

  it("excludes readable non-call symbol-text mismatches from call-proof readiness", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const helper = "scip-typescript npm example 1.0.0 src/index.ts/helper().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "export function main() {",
            '  return { "helper": 1 };',
            "}",
            "",
            "export function helper() {",
            "  return 1;",
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 2,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 11, endLine: 1, endCol: 19 },
              symbol: helper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 4, startCol: 16, endLine: 4, endCol: 22 },
              enclosingRange: {
                startLine: 4,
                startCol: 0,
                endLine: 6,
                endCol: 1,
              },
              symbol: helper,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
            {
              symbol: helper,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "helper",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      false,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.totalResolvedReferences, 0);
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
    assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
  });

  it("canonicalizes scip-dotnet overload arity for call proof and symbol identity", () => {
    const main = "scip-dotnet nuget . . CharacteristicObject#Main().";
    const getValue = "scip-dotnet nuget . . CharacteristicObject#GetValue().";
    const getValueArity =
      "scip-dotnet nuget . . CharacteristicObject#GetValue(+1).";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-dotnet",
      sourceTextByPath: new Map([
        [
          "CharacteristicObject.cs",
          [
            "class CharacteristicObject {",
            "  void Main() {",
            "    GetValue(1);",
            "  }",
            "  int GetValue(int value) { return value; }",
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "csharp",
          relativePath: "CharacteristicObject.cs",
          occurrences: [
            {
              range: { startLine: 1, startCol: 7, endLine: 1, endCol: 11 },
              enclosingRange: {
                startLine: 1,
                startCol: 2,
                endLine: 3,
                endCol: 3,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 2, startCol: 4, endLine: 2, endCol: 12 },
              symbol: getValueArity,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 4, startCol: 6, endLine: 4, endCol: 14 },
              enclosingRange: {
                startLine: 4,
                startCol: 2,
                endLine: 4,
                endCol: 47,
              },
              symbol: getValue,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 6,
              displayName: "",
            },
            {
              symbol: getValue,
              documentation: [],
              relationships: [],
              kind: 6,
              displayName: "",
            },
          ],
        },
      ],
    });

    const callEdges = facts.edges.filter((edge) => edge.edgeType === "call");
    assert.equal(callEdges.length, 1);
    assert.equal(callEdges[0]?.resolution, "exact");
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
    assert.equal(
      facts.symbols.some((symbol) => symbol.providerSymbolId === getValueArity),
      false,
    );
    assert.ok(
      facts.symbols.some(
        (symbol) =>
          symbol.providerSymbolId === getValue && symbol.name === "GetValue",
      ),
    );
  });

  it("keeps invocation-shaped symbol-text mismatches as call-proof incomplete", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const helper = "scip-typescript npm example 1.0.0 src/index.ts/helper().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "export function main() {",
            "  return this.helper();",
            "}",
            "",
            "export function helper() {",
            "  return 1;",
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 2,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 9, endLine: 1, endCol: 20 },
              symbol: helper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 4, startCol: 16, endLine: 4, endCol: 22 },
              enclosingRange: {
                startLine: 4,
                startCol: 0,
                endLine: 6,
                endCol: 1,
              },
              symbol: helper,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
            {
              symbol: helper,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "helper",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      false,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "none");
    assert.equal(facts.coverage[0]?.totalResolvedReferences, 1);
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 1);
    assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, [
      { code: "symbolTextMismatch", references: 1 },
    ]);
  });

  it("keeps stale prefix matches inside invocation identifiers incomplete", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const helper = "scip-typescript npm example 1.0.0 src/index.ts/helper().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "export function main() {",
            "  return helperRenamed();",
            "}",
            "",
            "export function helper() {",
            "  return 1;",
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 2,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 9, endLine: 1, endCol: 15 },
              symbol: helper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 4, startCol: 16, endLine: 4, endCol: 22 },
              enclosingRange: {
                startLine: 4,
                startCol: 0,
                endLine: 6,
                endCol: 1,
              },
              symbol: helper,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
            {
              symbol: helper,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "helper",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      false,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "none");
    assert.equal(facts.coverage[0]?.totalResolvedReferences, 1);
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 1);
    assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, [
      { code: "symbolTextMismatch", references: 1 },
    ]);
  });

  it("collects bounded samples for multi-line call-proof ranges", () => {
    const samples = collectCallProofMismatchSamples({
      symbols: [
        {
          providerSymbolId: "cxx . . $ llvm/cast().",
          name: "cast",
        },
      ],
      occurrences: [
        {
          relPath: "src/main.cpp",
          role: "reference",
          symbolId: "provider:cast",
          providerSymbolId: "cxx . . $ llvm/cast().",
          range: { startLine: 2, startCol: 2, endLine: 3, endCol: 13 },
        },
      ],
      sourceLinesByPath: new Map([
        [
          "src/main.cpp",
          new Map([
            [1, "  llvm::cast<"],
            [2, "    NumberExprAST>("],
          ]),
        ],
      ]),
    });

    assert.deepEqual(samples.get("multiLineRange"), [
      {
        relPath: "src/main.cpp",
        range: { startLine: 2, startCol: 2, endLine: 3, endCol: 13 },
        expectedText: "cast",
        actualText: "llvm::cast<\\n    NumberExp",
      },
    ]);
  });

  it("keeps multi-line call-proof samples when occurrence facts are not retained", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const helper = "scip-typescript npm example 1.0.0 src/index.ts/helper().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      retainOccurrenceFacts: false,
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "export function main() {",
            "  return (",
            "    helper",
            "  );",
            "}",
            "export function helper() {",
            "  return 1;",
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 4,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 9, endLine: 2, endCol: 10 },
              symbol: helper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 5, startCol: 16, endLine: 5, endCol: 22 },
              enclosingRange: {
                startLine: 5,
                startCol: 0,
                endLine: 7,
                endCol: 1,
              },
              symbol: helper,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
            {
              symbol: helper,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "helper",
            },
          ],
        },
      ],
    });

    assert.equal(facts.occurrences.length, 0);
    assert.deepEqual(facts.coverage[0]?.callProofUnavailableSamples, [
      {
        code: "multiLineRange",
        relPath: "src/index.ts",
        range: { startLine: 2, startCol: 9, endLine: 3, endCol: 10 },
        expectedText: "helper",
        actualText: "(\\n    helper",
      },
    ]);
  });

  it("promotes C++ location-only macro references when source text proves invocation syntax", () => {
    const main = "cxx . . $ src/main.cpp/main().";
    const assertMacro = "cxx . . $ `/usr/include/assert.h:77:11`!";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-clang",
      sourceTextByPath: new Map([
        ["src/main.cpp", ["void main() {", "  assert(value);", "}"].join("\n")],
      ]),
      externalSymbols: [
        {
          symbol: assertMacro,
          documentation: [],
          relationships: [],
          kind: 0,
          displayName: "",
        },
      ],
      documents: [
        {
          language: "Cpp",
          relativePath: "src/main.cpp",
          occurrences: [
            {
              range: { startLine: 0, startCol: 5, endLine: 0, endCol: 9 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 2,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 2, endLine: 1, endCol: 8 },
              symbol: assertMacro,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
          ],
        },
      ],
    });

    const callEdges = facts.edges.filter((edge) => edge.edgeType === "call");
    assert.equal(callEdges.length, 1);
    assert.equal(callEdges[0]?.resolution, "exact");
    assert.equal(facts.coverage[0]?.callProofCoverage, "full");
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
  });

  describe("provider-first C++ call proof", () => {
    function normalizeCppCallProofCase(options: {
      sourceLines: readonly string[];
      targetSymbol: string;
      targetDisplayName: string;
      referenceRange: {
        startLine: number;
        startCol: number;
        endLine: number;
        endCol: number;
      };
    }): ProviderFactSet {
      const main = "cxx . . $ src/main.cpp/main().";
      return normalizeScipProviderFacts({
        repoId: "repo",
        generationId: "gen-1",
        providerId: "scip-clang",
        sourceTextByPath: new Map([
          ["src/main.cpp", options.sourceLines.join("\n")],
        ]),
        externalSymbols: [
          {
            symbol: options.targetSymbol,
            documentation: [],
            relationships: [],
            kind: 12,
            displayName: options.targetDisplayName,
          },
        ],
        documents: [
          {
            language: "Cpp",
            relativePath: "src/main.cpp",
            occurrences: [
              {
                range: { startLine: 0, startCol: 5, endLine: 0, endCol: 9 },
                enclosingRange: {
                  startLine: 0,
                  startCol: 0,
                  endLine: options.sourceLines.length - 1,
                  endCol: options.sourceLines.at(-1)?.length ?? 0,
                },
                symbol: main,
                symbolRoles: 1,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: options.referenceRange,
                symbol: options.targetSymbol,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
            ],
            symbols: [
              {
                symbol: main,
                documentation: [],
                relationships: [],
                kind: 12,
                displayName: "main",
              },
            ],
          },
        ],
      });
    }

    function assertCppCallProven(facts: ProviderFactSet): void {
      assert.equal(
        facts.edges.some((edge) => edge.edgeType === "call"),
        true,
      );
      assert.equal(facts.coverage[0]?.callProofCoverage, "full");
      assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
    }

    function assertCppReferenceNeutral(facts: ProviderFactSet): void {
      assert.equal(
        facts.edges.some((edge) => edge.edgeType === "call"),
        false,
      );
      assert.equal(facts.coverage[0]?.callProofCoverage, "full");
      assert.equal(facts.coverage[0]?.totalResolvedReferences, 0);
      assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
    }

    it("proves a cxx qualified free function call when the range covers the bare name", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  llvm::cast(value);", "}"],
        targetSymbol: "cxx . . $ llvm/cast().",
        targetDisplayName: "cast",
        referenceRange: { startLine: 1, startCol: 8, endLine: 1, endCol: 12 },
      });

      assertCppCallProven(facts);
    });

    it("proves a cxx namespace-qualified call when the range starts at the qualifier", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  llvm::cast(value);", "}"],
        targetSymbol: "cxx . . $ llvm/cast().",
        targetDisplayName: "cast",
        referenceRange: { startLine: 1, startCol: 2, endLine: 1, endCol: 12 },
      });

      assertCppCallProven(facts);
    });

    it("proves a cxx member call through dot and arrow access", () => {
      const dotFacts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  object.method();", "}"],
        targetSymbol: "cxx . . $ Type#method().",
        targetDisplayName: "method",
        referenceRange: { startLine: 1, startCol: 9, endLine: 1, endCol: 15 },
      });
      const arrowFacts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  ptr->method();", "}"],
        targetSymbol: "cxx . . $ Type#method().",
        targetDisplayName: "method",
        referenceRange: { startLine: 1, startCol: 7, endLine: 1, endCol: 13 },
      });

      assertCppCallProven(dotFacts);
      assertCppCallProven(arrowFacts);
    });

    it("proves a cxx template function call with explicit template arguments", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  llvm::cast<Foo>(value);", "}"],
        targetSymbol: "cxx . . $ llvm/cast().",
        targetDisplayName: "cast",
        referenceRange: { startLine: 1, startCol: 8, endLine: 1, endCol: 12 },
      });

      assertCppCallProven(facts);
    });

    it("proves a cxx template function call when the range covers template arguments", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  llvm::cast<Foo>(value);", "}"],
        targetSymbol: "cxx . . $ llvm/cast().",
        targetDisplayName: "cast",
        referenceRange: { startLine: 1, startCol: 13, endLine: 1, endCol: 16 },
      });

      assertCppCallProven(facts);
    });

    it("proves cxx constructor, destructor, and operator calls", () => {
      const constructorFacts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  Foo(value);", "}"],
        targetSymbol: "cxx . . $ Foo#Foo().",
        targetDisplayName: "Foo",
        referenceRange: { startLine: 1, startCol: 2, endLine: 1, endCol: 5 },
      });
      const destructorFacts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  value.~Foo();", "}"],
        targetSymbol: "cxx . . $ Foo#~Foo().",
        targetDisplayName: "~Foo",
        referenceRange: { startLine: 1, startCol: 8, endLine: 1, endCol: 12 },
      });
      const operatorFacts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  value.operator bool();", "}"],
        targetSymbol: "cxx . . $ Optional#operator bool().",
        targetDisplayName: "operator bool",
        referenceRange: { startLine: 1, startCol: 8, endLine: 1, endCol: 21 },
      });

      assertCppCallProven(constructorFacts);
      assertCppCallProven(destructorFacts);
      assertCppCallProven(operatorFacts);
    });

    it("proves cxx destructor declarations when the range covers only the tilde token", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: ["struct V8 {", "  ~V8() override;", "};"],
        targetSymbol: "cxx . . $ V8#`~V8`(ced63f7c635d850d).",
        targetDisplayName: "",
        referenceRange: { startLine: 1, startCol: 2, endLine: 1, endCol: 3 },
      });

      assertCppCallProven(facts);
    });

    it("proves cxx calls when template or member invocation syntax spans retained lines", () => {
      const templateFacts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          "  llvm::cast<",
          "    Foo",
          "  >(value);",
          "}",
        ],
        targetSymbol: "cxx . . $ llvm/cast().",
        targetDisplayName: "cast",
        referenceRange: { startLine: 1, startCol: 8, endLine: 1, endCol: 12 },
      });
      const memberFacts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  object", "    .method();", "}"],
        targetSymbol: "cxx . . $ Type#method().",
        targetDisplayName: "method",
        referenceRange: { startLine: 2, startCol: 5, endLine: 2, endCol: 11 },
      });

      assertCppCallProven(templateFacts);
      assertCppCallProven(memberFacts);
    });

    it("proves cxx calls when the provider range itself spans multiple lines", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          "  llvm::cast<",
          "    NumberExprAST",
          "  >(value);",
          "}",
        ],
        targetSymbol: "cxx . . $ llvm/cast().",
        targetDisplayName: "cast",
        referenceRange: { startLine: 1, startCol: 2, endLine: 2, endCol: 17 },
      });

      assertCppCallProven(facts);
    });

    it("keeps broad cxx multi-line non-call ranges neutral", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          "  if (condition &&",
          "      other) {",
          "    value;",
          "  }",
          "}",
        ],
        targetSymbol: "cxx . . $ Type#method().",
        targetDisplayName: "method",
        referenceRange: { startLine: 1, startCol: 2, endLine: 3, endCol: 10 },
      });

      assertCppReferenceNeutral(facts);
    });

    it("keeps cxx raw string literal constructor spans neutral", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          '  auto text = R"(',
          "    define i32 @f() {",
          "      ret i32 0",
          "    }",
          '  )";',
          "}",
        ],
        targetSymbol: "cxx . . $ llvm/StringRef#StringRef(85c52e162fed56f9).",
        targetDisplayName: "StringRef",
        referenceRange: { startLine: 1, startCol: 14, endLine: 5, endCol: 4 },
      });

      assertCppReferenceNeutral(facts);
    });

    it("keeps cxx ordinary string literal constructor spans neutral", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          '  auto text = "',
          "\\n        define i1 @recursive() {",
          "\\n            ret i1 true",
          '\\n        }";',
          "}",
        ],
        targetSymbol: "cxx . . $ llvm/StringRef#StringRef(85c52e162fed56f9).",
        targetDisplayName: "StringRef",
        referenceRange: { startLine: 1, startCol: 14, endLine: 4, endCol: 10 },
      });

      assertCppReferenceNeutral(facts);
    });

    it("keeps cxx UTF-8 byte-column string literal constructor ranges neutral", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          '  TestEscaped("/*параметр*/", "\\"/*параметр*/\\"");',
          "}",
        ],
        targetSymbol: "cxx . . $ llvm/StringRef#StringRef(85c52e162fed56f9).",
        targetDisplayName: "StringRef",
        referenceRange: { startLine: 1, startCol: 38, endLine: 1, endCol: 64 },
      });

      assertCppReferenceNeutral(facts);
    });

    it("does not stitch sparse retained C++ source windows into a fake call", () => {
      const main = "cxx . . $ src/main.cpp/main().";
      const method = "cxx . . $ Type#method().";
      const facts = normalizeScipProviderFacts({
        repoId: "repo",
        generationId: "gen-1",
        providerId: "scip-clang",
        sourceLinesByPath: new Map([
          [
            "src/main.cpp",
            new Map([
              [0, "void main() { object"],
              [10, "    .method();"],
            ]),
          ],
        ]),
        externalSymbols: [
          {
            symbol: method,
            documentation: [],
            relationships: [],
            kind: 12,
            displayName: "method",
          },
        ],
        documents: [
          {
            language: "Cpp",
            relativePath: "src/main.cpp",
            occurrences: [
              {
                range: { startLine: 0, startCol: 5, endLine: 0, endCol: 9 },
                enclosingRange: {
                  startLine: 0,
                  startCol: 0,
                  endLine: 10,
                  endCol: 15,
                },
                symbol: main,
                symbolRoles: 1,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 0, startCol: 14, endLine: 0, endCol: 20 },
                symbol: method,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
            ],
            symbols: [
              {
                symbol: main,
                documentation: [],
                relationships: [],
                kind: 12,
                displayName: "main",
              },
            ],
          },
        ],
      });

      assert.equal(
        facts.edges.some((edge) => edge.edgeType === "call"),
        false,
      );
      assert.equal(facts.coverage[0]?.callProofCoverage, "full");
      assert.equal(facts.coverage[0]?.totalResolvedReferences, 0);
      assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
    });

    it("does not scan beyond the bounded local C++ proof window", () => {
      const main = "cxx . . $ src/main.cpp/main().";
      const method = "cxx . . $ Type#method().";
      const retainedLines = new Map<number, string>();
      retainedLines.set(0, "void main() { object");
      retainedLines.set(1, "");
      retainedLines.set(2, "");
      retainedLines.set(3, "");
      retainedLines.set(4, "");
      retainedLines.set(5, "    .method();");
      const facts = normalizeScipProviderFacts({
        repoId: "repo",
        generationId: "gen-1",
        providerId: "scip-clang",
        sourceLinesByPath: new Map([["src/main.cpp", retainedLines]]),
        externalSymbols: [
          {
            symbol: method,
            documentation: [],
            relationships: [],
            kind: 12,
            displayName: "method",
          },
        ],
        documents: [
          {
            language: "Cpp",
            relativePath: "src/main.cpp",
            occurrences: [
              {
                range: { startLine: 0, startCol: 5, endLine: 0, endCol: 9 },
                enclosingRange: {
                  startLine: 0,
                  startCol: 0,
                  endLine: 5,
                  endCol: 15,
                },
                symbol: main,
                symbolRoles: 1,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 0, startCol: 14, endLine: 0, endCol: 20 },
                symbol: method,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
            ],
            symbols: [
              {
                symbol: main,
                documentation: [],
                relationships: [],
                kind: 12,
                displayName: "main",
              },
            ],
          },
        ],
      });

      assert.equal(
        facts.edges.some((edge) => edge.edgeType === "call"),
        false,
      );
      assert.equal(facts.coverage[0]?.callProofCoverage, "full");
      assert.equal(facts.coverage[0]?.totalResolvedReferences, 0);
      assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
    });

    it("keeps cxx namespace and class qualifier references neutral in qualified calls", () => {
      const namespaceFacts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  std::move(value);", "}"],
        targetSymbol: "cxx . . $ std/",
        targetDisplayName: "std",
        referenceRange: { startLine: 1, startCol: 2, endLine: 1, endCol: 5 },
      });
      const classFacts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  PreservedAnalyses::all();", "}"],
        targetSymbol: "cxx . . $ llvm/PreservedAnalyses#",
        targetDisplayName: "PreservedAnalyses",
        referenceRange: { startLine: 1, startCol: 2, endLine: 1, endCol: 19 },
      });

      assertCppReferenceNeutral(namespaceFacts);
      assertCppReferenceNeutral(classFacts);
    });

    it("keeps cxx template argument references neutral in factory calls", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          "  std::make_unique<NumberExprAST>(value);",
          "}",
        ],
        targetSymbol: "cxx . . $ NumberExprAST#",
        targetDisplayName: "NumberExprAST",
        referenceRange: { startLine: 1, startCol: 20, endLine: 1, endCol: 33 },
      });

      assertCppReferenceNeutral(facts);
    });

    it("ignores invocation-like text inside C++ string literals", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          '  cl::desc("say last words (suppress codegen)");',
          "}",
        ],
        targetSymbol: "cxx . . $ llvm/StringRef#StringRef(85c52e162fed56f9).",
        targetDisplayName: "StringRef",
        referenceRange: { startLine: 1, startCol: 11, endLine: 1, endCol: 46 },
      });

      assertCppReferenceNeutral(facts);
    });

    it("proves cxx constructor declarations when the range covers the declarator name", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  APInt TmpOffset(BitWidth, 0);", "}"],
        targetSymbol: "cxx . . $ llvm/APInt#APInt(66723ae35f7e8db6).",
        targetDisplayName: "APInt",
        referenceRange: { startLine: 1, startCol: 8, endLine: 1, endCol: 17 },
      });

      assertCppCallProven(facts);
    });

    it("proves cxx constructor declarations across multiple declarators", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          "  APFloat MA(Sem), SC(Sem), TC(Sem);",
          "}",
        ],
        targetSymbol: "cxx . . $ llvm/APFloat#APFloat(85c52e162fed56f9).",
        targetDisplayName: "APFloat",
        referenceRange: { startLine: 1, startCol: 19, endLine: 1, endCol: 21 },
      });

      assertCppCallProven(facts);
    });

    it("proves cxx constructors for trailing local-class declarators", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          "  struct RestorePath {",
          "    SmallString path;",
          "    RestorePath(const SmallString &path) : path(path) {}",
          "    ~RestorePath() { restore(path); }",
          "  } restore_path(path);",
          "}",
        ],
        targetSymbol:
          "cxx . . $ FileSystemTest#TestBody().RestorePath#RestorePath(48a128579325926a).",
        targetDisplayName: "RestorePath",
        referenceRange: { startLine: 5, startCol: 4, endLine: 5, endCol: 16 },
      });

      assertCppCallProven(facts);
    });

    it("proves cxx typedef-alias constructor declarations when SCIP exposes the alias type", () => {
      const main = "cxx . . $ src/main.cpp/main().";
      const mutexLockType = "cxx . . $ testing/internal/MutexLock#";
      const constructor =
        "cxx . . $ testing/internal/GTestMutexLock#GTestMutexLock(6c1d8b8db3bd6f5).";
      const facts = normalizeScipProviderFacts({
        repoId: "repo",
        generationId: "gen-1",
        providerId: "scip-clang",
        sourceTextByPath: new Map([
          [
            "src/main.cpp",
            ["void main() {", "  internal::MutexLock lock(&mutex);", "}"].join(
              "\n",
            ),
          ],
        ]),
        externalSymbols: [
          {
            symbol: constructor,
            documentation: [],
            relationships: [],
            kind: 9,
            displayName: "GTestMutexLock",
          },
        ],
        documents: [
          {
            language: "Cpp",
            relativePath: "src/main.cpp",
            occurrences: [
              {
                range: { startLine: 0, startCol: 5, endLine: 0, endCol: 9 },
                enclosingRange: {
                  startLine: 0,
                  startCol: 0,
                  endLine: 2,
                  endCol: 1,
                },
                symbol: main,
                symbolRoles: 1,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 1, startCol: 12, endLine: 1, endCol: 21 },
                symbol: mutexLockType,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 1, startCol: 22, endLine: 1, endCol: 26 },
                symbol: constructor,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
            ],
            symbols: [
              {
                symbol: main,
                documentation: [],
                relationships: [],
                kind: 12,
                displayName: "main",
              },
            ],
          },
        ],
      });

      assertCppCallProven(facts);
    });

    it("keeps cxx typedef-like constructor mismatches incomplete without a scoped alias occurrence", () => {
      const noAliasFacts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  MutexLock lock(&mutex);", "}"],
        targetSymbol:
          "cxx . . $ testing/internal/GTestMutexLock#GTestMutexLock(6c1d8b8db3bd6f5).",
        targetDisplayName: "GTestMutexLock",
        referenceRange: { startLine: 1, startCol: 12, endLine: 1, endCol: 16 },
      });

      assert.equal(
        noAliasFacts.edges.some((edge) => edge.edgeType === "call"),
        false,
      );
      assert.equal(noAliasFacts.coverage[0]?.callProofCoverage, "none");

      const main = "cxx . . $ src/main.cpp/main().";
      const otherMutexLockType = "cxx . . $ other/MutexLock#";
      const constructor =
        "cxx . . $ testing/internal/GTestMutexLock#GTestMutexLock(6c1d8b8db3bd6f5).";
      const wrongScopeFacts = normalizeScipProviderFacts({
        repoId: "repo",
        generationId: "gen-1",
        providerId: "scip-clang",
        sourceTextByPath: new Map([
          [
            "src/main.cpp",
            ["void main() {", "  other::MutexLock lock(&mutex);", "}"].join(
              "\n",
            ),
          ],
        ]),
        externalSymbols: [
          {
            symbol: constructor,
            documentation: [],
            relationships: [],
            kind: 9,
            displayName: "GTestMutexLock",
          },
        ],
        documents: [
          {
            language: "Cpp",
            relativePath: "src/main.cpp",
            occurrences: [
              {
                range: { startLine: 0, startCol: 5, endLine: 0, endCol: 9 },
                enclosingRange: {
                  startLine: 0,
                  startCol: 0,
                  endLine: 2,
                  endCol: 1,
                },
                symbol: main,
                symbolRoles: 1,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 1, startCol: 9, endLine: 1, endCol: 18 },
                symbol: otherMutexLockType,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 1, startCol: 19, endLine: 1, endCol: 23 },
                symbol: constructor,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
            ],
            symbols: [
              {
                symbol: main,
                documentation: [],
                relationships: [],
                kind: 12,
                displayName: "main",
              },
            ],
          },
        ],
      });

      assert.equal(
        wrongScopeFacts.edges.some((edge) => edge.edgeType === "call"),
        false,
      );
      assert.equal(wrongScopeFacts.coverage[0]?.callProofCoverage, "none");
    });

    it("keeps cxx implicit return-conversion overlaps neutral when the real call is proven", () => {
      const main = "cxx . . $ src/main.cpp/main().";
      const matchResult =
        "cxx . . $ llvm/Pattern#MatchResult#MatchResult(40dc7895f36e6b79).";
      const makeError = "cxx . . $ llvm/make_error(6654aae05a339a4b).";
      const facts = normalizeScipProviderFacts({
        repoId: "repo",
        generationId: "gen-1",
        providerId: "scip-clang",
        sourceTextByPath: new Map([
          [
            "src/main.cpp",
            [
              "void main() {",
              "  return make_error<NotFoundError>();",
              "}",
            ].join("\n"),
          ],
        ]),
        externalSymbols: [
          {
            symbol: makeError,
            documentation: [],
            relationships: [],
            kind: 12,
            displayName: "make_error",
          },
        ],
        documents: [
          {
            language: "Cpp",
            relativePath: "src/main.cpp",
            occurrences: [
              {
                range: { startLine: 0, startCol: 5, endLine: 0, endCol: 9 },
                enclosingRange: {
                  startLine: 0,
                  startCol: 0,
                  endLine: 2,
                  endCol: 1,
                },
                symbol: main,
                symbolRoles: 1,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 1, startCol: 9, endLine: 1, endCol: 19 },
                symbol: matchResult,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 1, startCol: 9, endLine: 1, endCol: 19 },
                symbol: makeError,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
            ],
            symbols: [
              {
                symbol: main,
                documentation: [],
                relationships: [],
                kind: 12,
                displayName: "main",
              },
              {
                symbol: matchResult,
                documentation: [],
                relationships: [],
                kind: 5,
                displayName: "MatchResult",
              },
            ],
          },
        ],
      });

      assert.equal(
        facts.edges.some(
          (edge) =>
            edge.edgeType === "call" &&
            edge.targetSymbolId ===
              facts.externalSymbols.find(
                (symbol) => symbol.providerSymbolId === makeError,
              )?.symbolId,
        ),
        true,
      );
      assert.equal(facts.coverage[0]?.callProofCoverage, "full");
      assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
      assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
    });

    it("proves cxx local type constructor calls from qualified descriptor suffixes", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          "  using TestCase = PPCDoubleDoubleRoundToIntegralTestCase;",
          "  TestCase({{0.0, 0.0}});",
          "}",
        ],
        targetSymbol:
          "cxx . . $ `$anonymous_namespace_llvm/unittests/ADT/APFloatTest.cpp`/ppcDoubleDoubleRoundToIntegralTests(d59a2aa1b4df04b2).TestCase#",
        targetDisplayName:
          "ppcDoubleDoubleRoundToIntegralTests(d59a2aa1b4df04b2).TestCase",
        referenceRange: { startLine: 2, startCol: 2, endLine: 2, endCol: 10 },
      });

      assertCppCallProven(facts);
    });

    it("proves cxx unary operator references when the range covers the operator token", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          '  APInt NegR = ~getRValue("1", RawData);',
          "}",
        ],
        targetSymbol: "cxx . . $ llvm/`operator~`(a58d06f4158ae7a9).",
        targetDisplayName: "`operator~`",
        referenceRange: { startLine: 1, startCol: 15, endLine: 1, endCol: 16 },
      });

      assertCppCallProven(facts);
    });

    it("keeps cxx symbolic operator friend declarations neutral when the range omits punctuation", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "class Align {",
          "  friend bool operator<(Align Lhs, Align Rhs);",
          "};",
        ],
        targetSymbol: "cxx . . $ llvm/Align#operator<().",
        targetDisplayName: "operator<",
        referenceRange: { startLine: 1, startCol: 14, endLine: 1, endCol: 22 },
      });

      assertCppReferenceNeutral(facts);
    });

    it("keeps cxx symbolic operator declarations neutral with nearby overload declarations", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "class Align {",
          "  friend bool operator==(Align Lhs, Align Rhs);",
          "  friend bool operator!=(Align Lhs, Align Rhs);",
          "  friend bool operator<=(Align Lhs, Align Rhs);",
          "  friend bool operator>=(Align Lhs, Align Rhs);",
          "  friend bool operator<(Align Lhs, Align Rhs);",
          "  friend bool operator>(Align Lhs, Align Rhs);",
          "};",
        ],
        targetSymbol: "cxx . . $ llvm/`operator<`(9bc2821aa7bbb0eb).",
        targetDisplayName: "",
        referenceRange: { startLine: 5, startCol: 14, endLine: 5, endCol: 22 },
      });

      assertCppReferenceNeutral(facts);
    });

    it("proves cxx calls when a unary operator wraps the callable token range", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "template <typename T> constexpr T maskLeadingOnes(unsigned N) {",
          "  return ~maskTrailingOnes<T>(CHAR_BIT * sizeof(T) - N);",
          "}",
        ],
        targetSymbol: "cxx . . $ llvm/maskTrailingOnes().",
        targetDisplayName: "maskTrailingOnes",
        referenceRange: { startLine: 1, startCol: 9, endLine: 1, endCol: 26 },
      });

      assertCppCallProven(facts);
    });

    it("keeps same-range offsetof macro expansion symbols neutral", () => {
      const main = "cxx . . $ src/main.cpp/main().";
      const offsetofMacro =
        "cxx . . $ `/usr/lib/llvm-21/lib/clang/21/include/__stddef_offsetof.h:16:9`!";
      const headerType = "cxx . . $ llvm/gsym/Header#";
      const facts = normalizeScipProviderFacts({
        repoId: "repo",
        generationId: "gen-1",
        providerId: "scip-clang",
        sourceTextByPath: new Map([
          [
            "src/main.cpp",
            [
              "void main() {",
              "  auto Offset = offsetof(Header, Magic);",
              "}",
            ].join("\n"),
          ],
        ]),
        externalSymbols: [
          {
            symbol: headerType,
            documentation: [],
            relationships: [],
            kind: 5,
            displayName: "Header",
          },
        ],
        documents: [
          {
            language: "Cpp",
            relativePath: "src/main.cpp",
            occurrences: [
              {
                range: { startLine: 0, startCol: 5, endLine: 0, endCol: 9 },
                enclosingRange: {
                  startLine: 0,
                  startCol: 0,
                  endLine: 2,
                  endCol: 1,
                },
                symbol: main,
                symbolRoles: 1,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 1, startCol: 16, endLine: 1, endCol: 24 },
                symbol: offsetofMacro,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 1, startCol: 16, endLine: 1, endCol: 24 },
                symbol: headerType,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
            ],
            symbols: [
              {
                symbol: main,
                documentation: [],
                relationships: [],
                kind: 12,
                displayName: "main",
              },
            ],
          },
        ],
      });

      const headerSymbolId = facts.externalSymbols.find(
        (symbol) => symbol.providerSymbolId === headerType,
      )?.symbolId;
      assert.equal(
        facts.edges.some(
          (edge) =>
            edge.edgeType === "call" && edge.targetSymbolId === headerSymbolId,
        ),
        false,
      );
      assert.equal(facts.coverage[0]?.callProofCoverage, "full");
      assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
      assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
    });

    it("keeps cxx callable-object result conversions neutral when operator call proof is separate", () => {
      const main = "cxx . . $ src/main.cpp/main().";
      const errorCtor = "cxx . . $ llvm/Error#Error(5dde26cae95b3419).";
      const callOperator =
        "cxx . . $ llvm/orc/EPCCaller#`operator()`(2553d6074f8eeb77).";
      const facts = normalizeScipProviderFacts({
        repoId: "repo",
        generationId: "gen-1",
        providerId: "scip-clang",
        sourceTextByPath: new Map([
          [
            "src/main.cpp",
            [
              "void main() {",
              "  Error Err =",
              "      C(std::promise<MSVCPError>());",
              "}",
            ].join("\n"),
          ],
        ]),
        externalSymbols: [
          {
            symbol: errorCtor,
            documentation: [],
            relationships: [],
            kind: 12,
            displayName: "Error",
          },
          {
            symbol: callOperator,
            documentation: [],
            relationships: [],
            kind: 12,
            displayName: "`operator()`",
          },
        ],
        documents: [
          {
            language: "Cpp",
            relativePath: "src/main.cpp",
            occurrences: [
              {
                range: { startLine: 0, startCol: 5, endLine: 0, endCol: 9 },
                enclosingRange: {
                  startLine: 0,
                  startCol: 0,
                  endLine: 3,
                  endCol: 1,
                },
                symbol: main,
                symbolRoles: 1,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 2, startCol: 6, endLine: 2, endCol: 7 },
                symbol: errorCtor,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 2, startCol: 7, endLine: 2, endCol: 8 },
                symbol: callOperator,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
            ],
            symbols: [
              {
                symbol: main,
                documentation: [],
                relationships: [],
                kind: 12,
                displayName: "main",
              },
            ],
          },
        ],
      });

      const errorSymbolId = facts.externalSymbols.find(
        (symbol) => symbol.providerSymbolId === errorCtor,
      )?.symbolId;
      assert.equal(
        facts.edges.some(
          (edge) =>
            edge.edgeType === "call" && edge.targetSymbolId === errorSymbolId,
        ),
        false,
      );
      assert.equal(facts.coverage[0]?.callProofCoverage, "full");
      assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 0);
      assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
    });

    it("keeps cxx named-cast result conversions neutral", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          "  Value Alias = static_cast<const char *>(X);",
          "}",
        ],
        targetSymbol: "cxx . . $ llvm/json/Value#Value(5dde26cae95b3419).",
        targetDisplayName: "Value",
        referenceRange: { startLine: 1, startCol: 16, endLine: 1, endCol: 27 },
      });

      assertCppReferenceNeutral(facts);
    });

    it("proves cxx template constructor declarations when the source omits template args", () => {
      const constructorFacts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          "  scc_member_iterator(const NodesType &InputNodes);",
          "}",
        ],
        targetSymbol:
          "cxx . . $ llvm/`scc_member_iterator<GraphT, GT>`#`scc_member_iterator<GraphT, GT>`(6f559d22b039ccdb).",
        targetDisplayName: "scc_member_iterator<GraphT, GT>",
        referenceRange: { startLine: 1, startCol: 2, endLine: 1, endCol: 21 },
      });
      const destructorFacts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  ~ScopedHashTableScope();", "}"],
        targetSymbol:
          "cxx . . $ llvm/`ScopedHashTableScope<K, V, KInfo, AllocatorTy>`#`~ScopedHashTableScope<K, V, KInfo, AllocatorTy>`(6f559d22b039ccdb).",
        targetDisplayName: "~ScopedHashTableScope<K, V, KInfo, AllocatorTy>",
        referenceRange: { startLine: 1, startCol: 2, endLine: 1, endCol: 23 },
      });

      assertCppCallProven(constructorFacts);
      assertCppCallProven(destructorFacts);
    });

    it("keeps cxx implicit constructor conversions over another call neutral", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          "  return buildExtractVectorElement(Res, Val, buildConstant(IdxTy, Idx));",
          "}",
        ],
        targetSymbol:
          "cxx . . $ llvm/MachineIRBuilder#SrcOp#SrcOp(6f559d22b039ccdb).",
        targetDisplayName: "SrcOp",
        referenceRange: { startLine: 1, startCol: 45, endLine: 1, endCol: 58 },
      });

      assertCppReferenceNeutral(facts);
    });

    it("keeps cxx conversion operator declaration ranges neutral", () => {
      const conversionFacts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          "  operator StringMapIterBase<ValueTy, ToConst>() const {",
          "}",
        ],
        targetSymbol: "cxx . . $ llvm/StringMapIterBase#",
        targetDisplayName: "StringMapIterBase",
        referenceRange: { startLine: 1, startCol: 11, endLine: 1, endCol: 28 },
      });
      const callOperatorFacts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          "  void operator()(MDNode *Node) const;",
          "}",
        ],
        targetSymbol:
          "cxx . . $ TempMDNodeDeleter#`operator()`(6f559d22b039ccdb).",
        targetDisplayName: "operator()",
        referenceRange: { startLine: 1, startCol: 7, endLine: 1, endCol: 15 },
      });

      assertCppReferenceNeutral(conversionFacts);
      assertCppReferenceNeutral(callOperatorFacts);
    });

    it("keeps C macro wrapper ranges neutral when the expected symbol is inside the macro expansion", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "void main() {",
          "  LLVM_ATTRIBUTE_C_DEPRECATED(LLVMTypeRef LLVMFloatType(void),",
          '                              "Use LLVMFloatTypeInContext instead");',
          "}",
        ],
        targetSymbol: "cxx . . $ LLVMTypeRef#",
        targetDisplayName: "LLVMTypeRef",
        referenceRange: { startLine: 1, startCol: 2, endLine: 1, endCol: 29 },
      });

      assertCppReferenceNeutral(facts);
    });

    it("keeps cxx camel-case macro expansion overlap ranges neutral", () => {
      const main = "cxx . . $ src/main.cpp/main().";
      const clNamespace = "cxx . . $ llvm/cl/";
      const optionValue = "cxx . . $ llvm/cl/OptionEnumValue#";
      const enumValue = "cxx . . $ V1.";
      const facts = normalizeScipProviderFacts({
        repoId: "repo",
        generationId: "gen-1",
        providerId: "scip-clang",
        sourceTextByPath: new Map([
          [
            "src/main.cpp",
            [
              "void main() {",
              '  cl::values(clEnumValN(V1, "v1", "version 1"));',
              "}",
            ].join("\n"),
          ],
        ]),
        externalSymbols: [
          {
            symbol: clNamespace,
            documentation: [],
            relationships: [],
            kind: 0,
            displayName: "cl",
          },
          {
            symbol: optionValue,
            documentation: [],
            relationships: [],
            kind: 4,
            displayName: "OptionEnumValue",
          },
          {
            symbol: enumValue,
            documentation: [],
            relationships: [],
            kind: 22,
            displayName: "V1",
          },
        ],
        documents: [
          {
            language: "Cpp",
            relativePath: "src/main.cpp",
            occurrences: [
              {
                range: { startLine: 0, startCol: 5, endLine: 0, endCol: 9 },
                enclosingRange: {
                  startLine: 0,
                  startCol: 0,
                  endLine: 2,
                  endCol: 1,
                },
                symbol: main,
                symbolRoles: 1,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 1, startCol: 13, endLine: 1, endCol: 23 },
                symbol: clNamespace,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 1, startCol: 13, endLine: 1, endCol: 23 },
                symbol: optionValue,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
              {
                range: { startLine: 1, startCol: 13, endLine: 1, endCol: 23 },
                symbol: enumValue,
                symbolRoles: 8,
                overrideDocumentation: [],
                syntaxKind: 0,
                diagnostics: [],
              },
            ],
            symbols: [
              {
                symbol: main,
                documentation: [],
                relationships: [],
                kind: 12,
                displayName: "main",
              },
            ],
          },
        ],
      });

      assertCppReferenceNeutral(facts);
    });

    it("proves cxx member-initializer constructors from nearby declarations", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "class CallExprAST {",
          "  std::vector<int> Args;",
          "public:",
          "  CallExprAST(std::vector<int> Args) : Args(std::move(Args)) {}",
          "};",
        ],
        targetSymbol: "cxx . . $ std/vector#vector(6f559d22b039ccdb).",
        targetDisplayName: "vector",
        referenceRange: { startLine: 3, startCol: 39, endLine: 3, endCol: 43 },
      });

      assertCppCallProven(facts);
    });

    it("does not confuse namespace qualifiers with member-initializer colons", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "class CallExprAST {",
          "  std::vector<int> Args;",
          "  void parse() { ns::Args(); }",
          "};",
        ],
        targetSymbol: "cxx . . $ std/vector#vector(6f559d22b039ccdb).",
        targetDisplayName: "vector",
        referenceRange: { startLine: 2, startCol: 21, endLine: 2, endCol: 25 },
      });

      assert.equal(
        facts.edges.some((edge) => edge.edgeType === "call"),
        false,
      );
      assert.equal(facts.coverage[0]?.callProofCoverage, "none");
    });

    it("does not confuse statement labels with member-initializer colons", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: [
          "class CallExprAST {",
          "  std::vector<int> Args;",
          "  void parse() { label: Args(); }",
          "};",
        ],
        targetSymbol: "cxx . . $ std/vector#vector(6f559d22b039ccdb).",
        targetDisplayName: "vector",
        referenceRange: { startLine: 2, startCol: 24, endLine: 2, endCol: 28 },
      });

      assert.equal(
        facts.edges.some((edge) => edge.edgeType === "call"),
        false,
      );
      assert.equal(facts.coverage[0]?.callProofCoverage, "none");
    });

    it("keeps a cxx readable non-call mismatch neutral", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  object.method;", "}"],
        targetSymbol: "cxx . . $ Type#method().",
        targetDisplayName: "method",
        referenceRange: { startLine: 1, startCol: 9, endLine: 1, endCol: 15 },
      });

      assert.equal(
        facts.edges.some((edge) => edge.edgeType === "call"),
        false,
      );
      assert.equal(facts.coverage[0]?.callProofCoverage, "full");
      assert.equal(facts.coverage[0]?.totalResolvedReferences, 0);
      assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, []);
    });

    it("keeps a cxx invocation-shaped mismatch incomplete when the callable token differs", () => {
      const facts = normalizeCppCallProofCase({
        sourceLines: ["void main() {", "  llvm::dyn_cast(value);", "}"],
        targetSymbol: "cxx . . $ llvm/cast().",
        targetDisplayName: "cast",
        referenceRange: { startLine: 1, startCol: 8, endLine: 1, endCol: 16 },
      });

      assert.equal(
        facts.edges.some((edge) => edge.edgeType === "call"),
        false,
      );
      assert.equal(facts.coverage[0]?.callProofCoverage, "none");
      assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, [
        { code: "symbolTextMismatch", references: 1 },
      ]);
    });
  });

  it("does not promote stale SCIP ranges when source text no longer matches the symbol", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const helper = "scip-typescript npm example 1.0.0 src/index.ts/helper().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      sourceTextByPath: new Map([
        [
          "src/index.ts",
          [
            "export function main() {",
            "  return renamed();",
            "}",
            "",
            "export function helper() {",
            "  return 1;",
            "}",
          ].join("\n"),
        ],
      ]),
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 2,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 9, endLine: 1, endCol: 15 },
              symbol: helper,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 4, startCol: 16, endLine: 4, endCol: 22 },
              enclosingRange: {
                startLine: 4,
                startCol: 0,
                endLine: 6,
                endCol: 1,
              },
              symbol: helper,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
            {
              symbol: helper,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "helper",
            },
          ],
        },
      ],
    });

    assert.equal(
      facts.edges.some((edge) => edge.edgeType === "call"),
      false,
    );
    assert.equal(facts.coverage[0]?.callProofCoverage, "none");
    assert.equal(facts.coverage[0]?.totalResolvedReferences, 1);
    assert.equal(facts.coverage[0]?.callProofUnavailableReferences, 1);
    assert.deepEqual(facts.coverage[0]?.callProofUnavailableReasons, [
      { code: "symbolTextMismatch", references: 1 },
    ]);
  });

  it("normalizes SCIP import and implementation occurrences into conservative edges", () => {
    const main = "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const imported =
      "scip-typescript npm example 1.0.0 src/imported.ts/imported().";
    const implemented = "scip-typescript npm example 1.0.0 src/index.ts/Impl#";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 20 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 3,
                endCol: 1,
              },
              symbol: main,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 1, startCol: 9, endLine: 1, endCol: 17 },
              symbol: imported,
              symbolRoles: 2,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 2, startCol: 9, endLine: 2, endCol: 13 },
              symbol: implemented,
              symbolRoles: 8,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: main,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "main",
            },
            {
              symbol: imported,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "imported",
            },
            {
              symbol: implemented,
              documentation: [],
              relationships: [{ symbol: main, isImplementation: true }],
              kind: 4,
              displayName: "Impl",
            },
          ],
        },
      ],
    });

    const edgeTypes = facts.edges.map((edge) => edge.edgeType);
    assert.ok(edgeTypes.includes("implements"));
    assert.ok(edgeTypes.includes("import"));
    assert.equal(edgeTypes.includes("call"), false);
  });

  it("skips SCIP reference relationships instead of staging exact call edges", () => {
    const source = "scip-typescript npm example 1.0.0 src/index.ts/source().";
    const target = "scip-typescript npm example 1.0.0 src/index.ts/target().";
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-1",
      providerId: "scip-typescript",
      documents: [
        {
          language: "typescript",
          relativePath: "src/index.ts",
          occurrences: [
            {
              range: { startLine: 0, startCol: 16, endLine: 0, endCol: 22 },
              enclosingRange: {
                startLine: 0,
                startCol: 0,
                endLine: 3,
                endCol: 1,
              },
              symbol: source,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
            {
              range: { startLine: 5, startCol: 16, endLine: 5, endCol: 22 },
              enclosingRange: {
                startLine: 5,
                startCol: 0,
                endLine: 7,
                endCol: 1,
              },
              symbol: target,
              symbolRoles: 1,
              overrideDocumentation: [],
              syntaxKind: 0,
              diagnostics: [],
            },
          ],
          symbols: [
            {
              symbol: source,
              documentation: [],
              relationships: [{ symbol: target, isReference: true }],
              kind: 12,
              displayName: "source",
            },
            {
              symbol: target,
              documentation: [],
              relationships: [],
              kind: 12,
              displayName: "target",
            },
          ],
        },
      ],
    });

    assert.deepEqual(facts.edges, []);
  });

  it("plans full SCIP provider-first execution when SCIP is configured", () => {
    const selection = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({ pipeline: "providerFirst" }),
      scip: ScipConfigSchema.parse({
        enabled: true,
        indexes: [{ path: "index.scip" }],
      }),
    });

    const plan = resolveProviderFirstExecutionPlan({
      selection,
      mode: "full",
      scip: ScipConfigSchema.parse({
        enabled: true,
        indexes: [{ path: "index.scip" }],
      }),
    });

    assert.equal(plan.canExecute, true);
    assert.equal(plan.executor, "scipFull");
    assert.equal(plan.shouldFallbackToLegacy, false);
    assert.deepEqual(plan.reasons, []);
  });

  it("plans full LSP provider-first execution when only LSP is configured", () => {
    const selection = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({ pipeline: "providerFirst" }),
      semanticEnrichment: SemanticEnrichmentConfigSchema.parse({
        enabled: true,
        providers: {
          lsp: {
            enabled: true,
            servers: {
              tsserver: {
                serverId: "tsserver",
                command: "typescript-language-server",
                languages: ["typescript"],
              },
            },
          },
        },
      }),
    });

    const plan = resolveProviderFirstExecutionPlan({
      selection,
      mode: "full",
      scip: ScipConfigSchema.parse({ enabled: false }),
    });

    assert.equal(plan.canExecute, true);
    assert.equal(plan.executor, "lspFull");
    assert.equal(plan.shouldFallbackToLegacy, false);
    assert.deepEqual(plan.reasons, []);
  });

  it("plans auto mode SCIP incremental execution when SCIP is configured", () => {
    const selection = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({ pipeline: "auto" }),
      scip: ScipConfigSchema.parse({
        enabled: true,
        generator: { enabled: true },
      }),
    });

    const plan = resolveProviderFirstExecutionPlan({
      selection,
      mode: "incremental",
      scip: ScipConfigSchema.parse({
        enabled: true,
        generator: { enabled: true },
      }),
    });

    assert.equal(plan.canExecute, true);
    assert.equal(plan.executor, "scipIncremental");
    assert.equal(plan.shouldFallbackToLegacy, false);
    assert.deepEqual(plan.reasons, []);
  });

  it("plans explicit providerFirst SCIP incremental execution when SCIP is configured", () => {
    const selection = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({ pipeline: "providerFirst" }),
      scip: ScipConfigSchema.parse({
        enabled: true,
        generator: { enabled: true },
      }),
    });

    const plan = resolveProviderFirstExecutionPlan({
      selection,
      mode: "incremental",
      scip: ScipConfigSchema.parse({
        enabled: true,
        generator: { enabled: true },
      }),
    });

    assert.equal(plan.canExecute, true);
    assert.equal(plan.executor, "scipIncremental");
    assert.equal(plan.shouldFallbackToLegacy, false);
    assert.deepEqual(plan.reasons, []);
  });

  it("plans LSP incremental execution when LSP is configured without SCIP", () => {
    const selection = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({ pipeline: "providerFirst" }),
      semanticEnrichment: SemanticEnrichmentConfigSchema.parse({
        enabled: true,
        providers: {
          lsp: {
            enabled: true,
            servers: {
              tsserver: {
                serverId: "tsserver",
                command: "typescript-language-server",
                languages: ["typescript"],
              },
            },
          },
        },
      }),
    });

    const plan = resolveProviderFirstExecutionPlan({
      selection,
      mode: "incremental",
      scip: ScipConfigSchema.parse({ enabled: false }),
    });

    assert.equal(plan.canExecute, true);
    assert.equal(plan.executor, "lspIncremental");
    assert.equal(plan.shouldFallbackToLegacy, false);
    assert.deepEqual(plan.reasons, []);
  });

  it("plans auto mode SCIP execution when a full SCIP source is configured", () => {
    const selection = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({ pipeline: "auto" }),
      scip: ScipConfigSchema.parse({
        enabled: true,
        indexes: [{ path: "index.scip" }],
      }),
    });

    const plan = resolveProviderFirstExecutionPlan({
      selection,
      mode: "full",
      scip: ScipConfigSchema.parse({
        enabled: true,
        indexes: [{ path: "index.scip" }],
      }),
    });

    assert.equal(plan.canExecute, true);
    assert.equal(plan.executor, "scipFull");
    assert.equal(plan.shouldFallbackToLegacy, false);
    assert.deepEqual(plan.reasons, []);
  });

  it("keeps generated SCIP warnings non-fatal after provider facts decode", () => {
    const fatalReasons = providerFirstFatalFailureReasons({
      providerRowsAvailable: true,
      failures: [
        {
          stage: "generator-run",
          message: "5 of 8 indexer(s) failed",
        },
        {
          stage: "generator-select",
          message: "optional split index skipped",
          path: "java.scip",
        },
      ],
    });

    assert.deepEqual(fatalReasons, []);
  });

  it("keeps missing configured SCIP indexes fatal after provider facts decode", () => {
    const fatalReasons = providerFirstFatalFailureReasons({
      providerRowsAvailable: true,
      failures: [
        {
          stage: "ingest",
          message: "SCIP index file not found",
          path: "missing.scip",
        },
      ],
    });

    assert.deepEqual(fatalReasons, [
      "SCIP index file not found (missing.scip)",
    ]);
  });

  it("drops repo-relative provider files outside the configured scan scope", () => {
    const emittedAt = "2026-05-29T00:00:00.000Z";
    const base = {
      repoId: "repo",
      generationId: "provider-first:test",
      providerType: "scip" as const,
      providerId: "scip-io",
      providerVersion: "1.0.0",
      emittedAt,
    };
    const facts: ProviderFactSet = {
      files: [
        {
          ...base,
          kind: "file",
          fileId: "file-src",
          relPath: "src/index.ts",
          languageId: "typescript",
        },
        {
          ...base,
          kind: "file",
          fileId: "file-py",
          relPath: "scripts/fix-agent-frontmatter.py",
          languageId: "python",
        },
      ],
      symbols: [
        {
          ...base,
          kind: "symbol",
          symbolId: "symbol-src",
          providerSymbolId:
            "scip-typescript npm repo 1.0.0 src/index.ts/main().",
          name: "main",
          symbolKind: "function",
          relPath: "src/index.ts",
          documentation: [],
          external: false,
        },
        {
          ...base,
          kind: "symbol",
          symbolId: "symbol-py",
          providerSymbolId:
            "scip-python pip repo 1.0.0 scripts/fix-agent-frontmatter.py/fix().",
          name: "fix",
          symbolKind: "function",
          relPath: "scripts/fix-agent-frontmatter.py",
          documentation: [],
          external: false,
        },
      ],
      occurrences: [
        {
          ...base,
          kind: "occurrence",
          occurrenceId: "occ-src",
          providerSymbolId:
            "scip-typescript npm repo 1.0.0 src/index.ts/main().",
          symbolId: "symbol-src",
          relPath: "src/index.ts",
          range: { startLine: 0, startCol: 0, endLine: 0, endCol: 4 },
          role: "definition",
        },
        {
          ...base,
          kind: "occurrence",
          occurrenceId: "occ-py",
          providerSymbolId:
            "scip-python pip repo 1.0.0 scripts/fix-agent-frontmatter.py/fix().",
          symbolId: "symbol-py",
          relPath: "scripts/fix-agent-frontmatter.py",
          range: { startLine: 0, startCol: 0, endLine: 0, endCol: 3 },
          role: "definition",
        },
      ],
      edges: [
        {
          ...base,
          kind: "edge",
          sourceSymbolId: "symbol-src",
          targetSymbolId: "symbol-py",
          edgeType: "call",
          resolution: "exact",
          confidence: 0.95,
          dedupeKey: "src-to-py",
        },
      ],
      externalSymbols: [],
      diagnostics: [
        {
          ...base,
          kind: "diagnostic",
          diagnosticId: "diag-py",
          relPath: "scripts/fix-agent-frontmatter.py",
          message: "ignored",
          severity: "information",
        },
      ],
      coverage: [
        {
          ...base,
          kind: "coverage",
          relPath: "src/index.ts",
          symbolCoverage: "full",
          referenceCoverage: "full",
          callProofCoverage: "full",
          diagnosticCoverage: "full",
          totalSymbols: 1,
          emittedSymbols: 1,
          totalOccurrences: 1,
          unresolvedOccurrences: 0,
          totalResolvedReferences: 0,
          callProofUnavailableReferences: 0,
          legacyFallback: "skip",
        },
        {
          ...base,
          kind: "coverage",
          relPath: "scripts/fix-agent-frontmatter.py",
          symbolCoverage: "full",
          referenceCoverage: "full",
          callProofCoverage: "full",
          diagnosticCoverage: "full",
          totalSymbols: 1,
          emittedSymbols: 1,
          totalOccurrences: 1,
          unresolvedOccurrences: 0,
          totalResolvedReferences: 0,
          callProofUnavailableReferences: 0,
          legacyFallback: "skip",
        },
      ],
      providerRuns: [
        {
          ...base,
          kind: "providerRun",
          runId: "run",
          status: "succeeded",
          startedAt: emittedAt,
          finishedAt: emittedAt,
          fileCount: 2,
          symbolCount: 2,
          edgeCount: 1,
          diagnosticCount: 1,
        },
      ],
      sourceLinesByPath: new Map([
        ["src/index.ts", new Map([[0, "function main() {}"]])],
        ["scripts/fix-agent-frontmatter.py", new Map([[0, "def fix(): pass"]])],
      ]),
    };

    const filtered = filterProviderFirstDataToScannedScope({
      rows: providerFactsToGraphRows({ facts, indexedAt: emittedAt }),
      facts,
      scannedPaths: ["src/index.ts"],
    });

    assert.deepEqual(filtered.ignoredProviderPaths, [
      "scripts/fix-agent-frontmatter.py",
    ]);
    assert.deepEqual(
      filtered.rows.files.map((file) => file.relPath),
      ["src/index.ts"],
    );
    assert.deepEqual(
      filtered.rows.symbols.map((symbol) => symbol.symbolId),
      ["symbol-src"],
    );
    assert.deepEqual(filtered.rows.edges, []);
    assert.deepEqual(
      filtered.facts.coverage.map((coverage) => coverage.relPath),
      ["src/index.ts"],
    );
    assert.equal(
      filtered.facts.sourceLinesByPath?.has("scripts/fix-agent-frontmatter.py"),
      false,
    );
  });

  it("derives semantic eligibility from compile commands plus provider-emitted headers in scan scope", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "sdl-semantic-eligible-"));
    try {
      mkdirSync(join(tempRoot, "src"), { recursive: true });
      mkdirSync(join(tempRoot, "build-scip-io-llvm-all-targets"), {
        recursive: true,
      });
      writeFileSync(join(tempRoot, "src", "main.cpp"), "", "utf-8");
      writeFileSync(join(tempRoot, "src", "main.h"), "", "utf-8");
      writeFileSync(
        join(
          tempRoot,
          "build-scip-io-llvm-all-targets",
          "compile_commands.json",
        ),
        JSON.stringify([
          {
            directory: join(tempRoot, "build-scip-io-llvm-all-targets"),
            file: "../src/main.cpp",
            command: "clang++ -c ../src/main.cpp",
          },
          {
            directory: join(tempRoot, "build-scip-io-llvm-all-targets"),
            file: "../generated/outside.cpp",
            command: "clang++ -c ../generated/outside.cpp",
          },
        ]),
        "utf-8",
      );

      const eligible = await resolveProviderFirstSemanticEligiblePaths({
        repoRoot: tempRoot,
        scannedPaths: ["src/main.cpp", "src/main.h", "src/other.h"],
        providerPaths: ["src/main.h"],
      });

      assert.deepEqual([...eligible].sort(), ["src/main.cpp", "src/main.h"]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("drops occurrence and source-line payloads before provider coverage analysis", () => {
    const emittedAt = "2026-05-29T00:00:00.000Z";
    const base = {
      repoId: "repo",
      generationId: "provider-first:release",
      providerType: "scip" as const,
      providerId: "scip-io",
      providerVersion: "1.0.0",
      emittedAt,
    };
    const facts: ProviderFactSet = {
      files: [
        {
          ...base,
          kind: "file",
          fileId: "file-1",
          relPath: "src/one.ts",
        },
      ],
      symbols: [
        {
          ...base,
          kind: "symbol",
          symbolId: "sym-1",
          providerSymbolId: "provider:sym-1",
          name: "one",
          symbolKind: "function",
          relPath: "src/one.ts",
          documentation: [],
          external: false,
        },
      ],
      occurrences: [
        {
          ...base,
          kind: "occurrence",
          occurrenceId: "occ-1",
          providerSymbolId: "provider:sym-1",
          symbolId: "sym-1",
          relPath: "src/one.ts",
          range: { startLine: 1, startCol: 0, endLine: 1, endCol: 3 },
          role: "definition",
        },
      ],
      edges: [
        {
          ...base,
          kind: "edge",
          sourceSymbolId: "sym-1",
          targetSymbolId: "sym-2",
          edgeType: "call",
          resolution: "exact",
          confidence: 0.95,
          dedupeKey: "edge-1",
        },
      ],
      externalSymbols: [],
      diagnostics: [],
      coverage: [
        {
          ...base,
          kind: "coverage",
          relPath: "src/one.ts",
          symbolCoverage: "full",
          referenceCoverage: "full",
          callProofCoverage: "full",
          diagnosticCoverage: "none",
          totalSymbols: 1,
          emittedSymbols: 1,
          totalOccurrences: 1,
          unresolvedOccurrences: 0,
          totalResolvedReferences: 0,
          callProofUnavailableReferences: 0,
          legacyFallback: "skip",
        },
      ],
      providerRuns: [],
      sourceLinesByPath: new Map([["src/one.ts", new Map([[0, "one()"]])]]),
    };

    clearProviderFactPayloadsForCoverageAnalysis(facts);

    assert.equal(facts.symbols.length, 1);
    assert.equal(facts.coverage.length, 1);
    assert.deepEqual(
      [
        facts.files.length,
        facts.occurrences.length,
        facts.edges.length,
        facts.externalSymbols.length,
        facts.diagnostics.length,
        facts.providerRuns.length,
        facts.sourceLinesByPath,
      ],
      [0, 0, 0, 0, 0, 0, undefined],
    );
  });

  it("clears provider-first payload arrays once coverage decisions are complete", () => {
    const emittedAt = "2026-05-29T00:00:00.000Z";
    const base = {
      repoId: "repo",
      generationId: "provider-first:release",
      providerType: "scip" as const,
      providerId: "scip-io",
      providerVersion: "1.0.0",
      emittedAt,
    };
    const facts: ProviderFactSet = {
      files: [
        {
          ...base,
          kind: "file",
          fileId: "file-1",
          relPath: "src/one.ts",
        },
      ],
      symbols: [
        {
          ...base,
          kind: "symbol",
          symbolId: "sym-1",
          providerSymbolId: "provider:sym-1",
          name: "one",
          symbolKind: "function",
          relPath: "src/one.ts",
          documentation: [],
          external: false,
        },
      ],
      occurrences: [
        {
          ...base,
          kind: "occurrence",
          occurrenceId: "occ-1",
          providerSymbolId: "provider:sym-1",
          symbolId: "sym-1",
          relPath: "src/one.ts",
          range: { startLine: 1, startCol: 0, endLine: 1, endCol: 3 },
          role: "definition",
        },
      ],
      edges: [],
      externalSymbols: [],
      diagnostics: [],
      coverage: [],
      providerRuns: [],
      sourceLinesByPath: new Map([["src/one.ts", new Map([[0, "one()"]])]]),
    };
    const rows = providerFactsToGraphRows({ facts, indexedAt: emittedAt });

    clearProviderFactPayloadsForGc(facts);
    clearProviderGraphRowsForGc(rows);

    assert.deepEqual(
      [
        facts.files.length,
        facts.symbols.length,
        facts.occurrences.length,
        facts.edges.length,
        facts.externalSymbols.length,
        facts.diagnostics.length,
        facts.coverage.length,
        facts.providerRuns.length,
        facts.sourceLinesByPath,
      ],
      [0, 0, 0, 0, 0, 0, 0, 0, undefined],
    );
    assert.deepEqual(
      [
        rows.files.length,
        rows.symbols.length,
        rows.externalSymbols.length,
        rows.edges.length,
        rows.changedFileIds.size,
      ],
      [0, 0, 0, 0, 0],
    );
  });

  it("keeps provider containment lookup bounded when exact line buckets exceed the cap", () => {
    const rootSymbol =
      "scip-typescript npm fixture 1.0.0 src/generated.ts/root().";
    const targetSymbol =
      "scip-typescript npm fixture 1.0.0 src/generated.ts/imported().";
    const helperSymbolCount = 20_000;
    const importReferenceCount = 5_000;
    const occurrences = [
      {
        range: { startLine: 0, startCol: 0, endLine: 500_000, endCol: 1 },
        symbol: rootSymbol,
        symbolRoles: 1,
        overrideDocumentation: [],
        syntaxKind: 0,
        diagnostics: [],
      },
      {
        range: { startLine: 1, startCol: 0, endLine: 1, endCol: 8 },
        symbol: targetSymbol,
        symbolRoles: 1,
        overrideDocumentation: [],
        syntaxKind: 0,
        diagnostics: [],
      },
    ];
    const symbols = [
      {
        symbol: rootSymbol,
        documentation: [],
        relationships: [],
        kind: 12,
        displayName: "root",
      },
      {
        symbol: targetSymbol,
        documentation: [],
        relationships: [],
        kind: 12,
        displayName: "imported",
      },
    ];

    for (let index = 0; index < helperSymbolCount; index += 1) {
      const startLine = 10 + index * 6;
      const helperSymbol = `scip-typescript npm fixture 1.0.0 src/generated.ts/helper${index}().`;
      occurrences.push({
        range: {
          startLine,
          startCol: 0,
          endLine: startLine + 5,
          endCol: 1,
        },
        symbol: helperSymbol,
        symbolRoles: 1,
        overrideDocumentation: [],
        syntaxKind: 0,
        diagnostics: [],
      });
      symbols.push({
        symbol: helperSymbol,
        documentation: [],
        relationships: [],
        kind: 12,
        displayName: `helper${index}`,
      });
    }

    for (let index = 0; index < importReferenceCount; index += 1) {
      const startLine = 300_000 + index;
      occurrences.push({
        range: { startLine, startCol: 2, endLine: startLine, endCol: 10 },
        symbol: targetSymbol,
        symbolRoles: 2,
        overrideDocumentation: [],
        syntaxKind: 0,
        diagnostics: [],
      });
    }

    const startedAt = Date.now();
    const facts = normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen-large-containment",
      providerId: "scip-typescript",
      providerVersion: "1.0.0",
      documents: [
        {
          language: "typescript",
          relativePath: "src/generated.ts",
          occurrences,
          symbols,
        },
      ],
    });
    const elapsedMs = Date.now() - startedAt;

    assert.ok(
      elapsedMs < 2_000,
      `normalization should keep cap-exceeded containment local; took ${elapsedMs}ms`,
    );
    assert.equal(facts.edges.length, 1);
    assert.equal(facts.edges[0]?.edgeType, "import");
  });

  it("collects large SCIP fact batches without overflowing the call stack", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-provider-first-scip-"));
    try {
      await writeTestScipIndex(join(repoRoot, "index.scip"), {
        metadata: {
          toolName: "scip-fixture",
          toolVersion: "1.0.0",
        },
        documents: Array.from({ length: 600 }, (_, documentIndex) => {
          const symbol = `scip-typescript npm fixture 1.0.0 src/file${documentIndex}.ts/main().`;
          return {
            language: "typescript",
            relativePath: `src/file${documentIndex}.ts`,
            occurrences: [
              {
                range: [0, 16, 20],
                enclosingRange: [0, 0, 2, 1],
                symbol,
                symbolRoles: 1,
              },
              ...Array.from({ length: 250 }, (_, occurrenceIndex) => ({
                range: [occurrenceIndex + 1, 2, 6] as [number, number, number],
                symbol,
                symbolRoles: 8,
              })),
            ],
            symbols: [
              {
                symbol,
                kind: 12,
                displayName: "main",
              },
            ],
          };
        }),
      });

      const progressEvents: Array<{
        stage: string;
        substage?: string;
        stageCurrent?: number;
        stageTotal?: number;
        message?: string;
      }> = [];
      const result = await executeProviderFirstScipFull({
        repoId: "repo",
        repoRoot,
        scannedFiles: Array.from({ length: 600 }, (_, documentIndex) => ({
          path: `src/file${documentIndex}.ts`,
          size: 1,
          contentHash: "0".repeat(64),
        })),
        config: {
          scip: ScipConfigSchema.parse({
            enabled: true,
            indexes: [{ path: "index.scip" }],
            externalSymbols: { enabled: true, maxPerIndex: 10000 },
          }),
          indexing: IndexingConfigSchema.parse({ pipeline: "providerFirst" }),
          repos: [],
        } as AppConfig,
        onProgress: (progress) => {
          progressEvents.push(progress);
        },
      });

      assert.equal(result.summary.filesProcessed, 600);
      assert.equal(result.facts.occurrences.length, 0);
      assert.equal(
        result.facts.coverage.reduce(
          (total, coverage) => total + coverage.totalOccurrences,
          0,
        ),
        600 * 251,
      );
      assert.ok(
        progressEvents.some(
          (event) =>
            event.stage === "providerFirst" &&
            event.substage === "providerCollection.documents" &&
            event.message?.endsWith("documents=600"),
        ),
        "provider-first document decode should emit live document heartbeats",
      );
      assert.ok(
        progressEvents.some(
          (event) =>
            event.stage === "providerFirst" &&
            event.substage === "providerCollection.rows",
        ),
        "provider-first row shaping should emit its own substage",
      );
      const rowProgressTotal =
        result.rows.files.length +
        result.rows.symbols.length +
        result.rows.externalSymbols.length +
        result.rows.edges.length;
      const rowEvents = progressEvents.filter(
        (event) =>
          event.stage === "providerFirst" &&
          event.substage === "providerCollection.rows" &&
          event.stageTotal !== undefined,
      );
      assert.ok(rowEvents.length > 0, "row progress should expose a total");
      assert.ok(
        rowEvents.every((event) => event.stageTotal === rowProgressTotal),
        "row progress should keep a stable graph-row denominator",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("scopes provider collection to scanned paths for subset benchmarks", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-provider-first-subset-"));
    try {
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      writeFileSync(
        join(repoRoot, "src", "keep.ts"),
        ["export function keep() {", "  return 1;", "}"].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(repoRoot, "src", "skip.ts"),
        ["export function skip() {", "  return 2;", "}"].join("\n"),
        "utf8",
      );
      const keepSymbol =
        "scip-typescript npm fixture 1.0.0 src/keep.ts/keep().";
      const skipSymbol =
        "scip-typescript npm fixture 1.0.0 src/skip.ts/skip().";
      await writeTestScipIndex(join(repoRoot, "index.scip"), {
        metadata: {
          toolName: "scip-fixture",
          toolVersion: "1.0.0",
        },
        documents: [
          {
            language: "typescript",
            relativePath: "src/keep.ts",
            occurrences: [
              {
                range: [0, 16, 20],
                enclosingRange: [0, 0, 2, 1],
                symbol: keepSymbol,
                symbolRoles: 1,
              },
            ],
            symbols: [{ symbol: keepSymbol, kind: 12, displayName: "keep" }],
          },
          {
            language: "typescript",
            relativePath: "src/skip.ts",
            occurrences: [
              {
                range: [0, 16, 20],
                enclosingRange: [0, 0, 2, 1],
                symbol: skipSymbol,
                symbolRoles: 1,
              },
            ],
            symbols: [{ symbol: skipSymbol, kind: 12, displayName: "skip" }],
          },
        ],
      });

      const result = await executeProviderFirstScipFull({
        repoId: "repo",
        repoRoot,
        scannedPaths: ["src/keep.ts"],
        config: {
          scip: ScipConfigSchema.parse({
            enabled: true,
            indexes: [{ path: "index.scip" }],
          }),
          indexing: IndexingConfigSchema.parse({ pipeline: "providerFirst" }),
          repos: [],
        } as AppConfig,
      });

      assert.deepEqual(
        result.facts.files.map((file) => file.relPath),
        ["src/keep.ts"],
      );
      assert.equal(result.summary.filesProcessed, 1);
      assert.equal(result.rows.files.length, 1);
      assert.equal(result.rows.symbols.length, 1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("uses only scoped generated SCIP indexes for incremental provider collection", async () => {
    const repoRoot = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-incremental-scope-"),
    );
    try {
      const scopedDir = join(repoRoot, ".sdl-mcp", "provider-first-incremental");
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      mkdirSync(scopedDir, { recursive: true });
      writeFileSync(
        join(repoRoot, "src", "keep.ts"),
        ["export function fresh() {", "  return 1;", "}"].join("\n"),
        "utf8",
      );

      const staleSymbol =
        "scip-typescript npm fixture 1.0.0 src/keep.ts/stale().";
      const freshSymbol =
        "scip-typescript npm fixture 1.0.0 src/keep.ts/fresh().";
      await writeTestScipIndex(join(repoRoot, "index.scip"), {
        metadata: {
          toolName: "scip-fixture",
          toolVersion: "1.0.0",
        },
        documents: [
          {
            language: "typescript",
            relativePath: "src/keep.ts",
            occurrences: [
              {
                range: [0, 16, 21],
                enclosingRange: [0, 0, 2, 1],
                symbol: staleSymbol,
                symbolRoles: 1,
              },
            ],
            symbols: [{ symbol: staleSymbol, kind: 12, displayName: "stale" }],
          },
        ],
      });
      const scopedRelPath = ".sdl-mcp/provider-first-incremental/run.scip";
      const scopedPath = join(scopedDir, "run.scip");
      await writeTestScipIndex(scopedPath, {
        metadata: {
          toolName: "scip-fixture",
          toolVersion: "1.0.0",
        },
        documents: [
          {
            language: "typescript",
            relativePath: "src/keep.ts",
            occurrences: [
              {
                range: [0, 16, 21],
                enclosingRange: [0, 0, 2, 1],
                symbol: freshSymbol,
                symbolRoles: 1,
              },
            ],
            symbols: [{ symbol: freshSymbol, kind: 12, displayName: "fresh" }],
          },
        ],
      });

      const result = await executeProviderFirstScipIncremental({
        repoId: "repo",
        repoRoot,
        scannedPaths: ["src/keep.ts"],
        generatedIndexes: [
          {
            path: scopedRelPath,
            label: "scoped-scip",
            sizeBytes: readFileSync(scopedPath).byteLength,
            mode: "merged",
          },
        ],
        config: {
          scip: ScipConfigSchema.parse({
            enabled: true,
            generator: { enabled: true },
            indexes: [{ path: "index.scip", label: "scip-io" }],
          }),
          indexing: IndexingConfigSchema.parse({ pipeline: "providerFirst" }),
          repos: [],
        } as AppConfig,
      });

      assert.deepEqual(
        result.facts.symbols.map((symbol) => symbol.name),
        ["fresh"],
      );
      assert.deepEqual(
        result.rows.symbols.map((symbol) => symbol.name),
        ["fresh"],
      );
      assert.equal(result.summary.filesProcessed, 1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not use configured SCIP indexes when incremental generation has no accepted output", async () => {
    const repoRoot = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-incremental-empty-"),
    );
    try {
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      writeFileSync(
        join(repoRoot, "src", "keep.ts"),
        ["export function stale() {", "  return 1;", "}"].join("\n"),
        "utf8",
      );

      const staleSymbol =
        "scip-typescript npm fixture 1.0.0 src/keep.ts/stale().";
      await writeTestScipIndex(join(repoRoot, "index.scip"), {
        metadata: {
          toolName: "scip-fixture",
          toolVersion: "1.0.0",
        },
        documents: [
          {
            language: "typescript",
            relativePath: "src/keep.ts",
            occurrences: [
              {
                range: [0, 16, 21],
                enclosingRange: [0, 0, 2, 1],
                symbol: staleSymbol,
                symbolRoles: 1,
              },
            ],
            symbols: [{ symbol: staleSymbol, kind: 12, displayName: "stale" }],
          },
        ],
      });

      await assert.rejects(
        () =>
          executeProviderFirstScipIncremental({
            repoId: "repo",
            repoRoot,
            scannedPaths: ["src/keep.ts"],
            generatedIndexes: [],
            config: {
              scip: ScipConfigSchema.parse({
                enabled: true,
                generator: { enabled: true },
                indexes: [{ path: "index.scip", label: "scip-io" }],
              }),
              indexing: IndexingConfigSchema.parse({
                pipeline: "providerFirst",
              }),
              repos: [],
            } as AppConfig,
          }),
        /Provider-first SCIP execution produced no file facts/,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("records source loader reasons in call-proof diagnostics", async () => {
    const realRepoRoot = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-source-real-"),
    );
    const linkedRepoParent = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-source-link-"),
    );
    const linkedRepoRoot = join(linkedRepoParent, "repo");
    let repoRoot = realRepoRoot;
    const main = "scip-typescript npm fixture 1.0.0 src/index.ts/main().";
    const helper = "scip-typescript npm fixture 1.0.0 src/index.ts/helper().";
    try {
      try {
        symlinkSync(realRepoRoot, linkedRepoRoot, "junction");
        repoRoot = linkedRepoRoot;
      } catch {
        repoRoot = realRepoRoot;
      }

      mkdirSync(join(realRepoRoot, "src"), { recursive: true });
      writeFileSync(
        join(realRepoRoot, "src", "index.ts"),
        [
          "export function main() {",
          "  return helper();",
          "}",
          "",
          "export function helper() {",
          "  return 1;",
          "}",
        ].join("\n"),
      );
      await writeTestScipIndex(join(realRepoRoot, "index.scip"), {
        metadata: {
          toolName: "scip-fixture",
          toolVersion: "1.0.0",
        },
        documents: [
          {
            language: "typescript",
            relativePath: "src/index.ts",
            occurrences: [
              {
                range: [0, 16, 20],
                enclosingRange: [0, 0, 2, 1],
                symbol: main,
                symbolRoles: 1,
              },
              {
                range: [1, 9, 15],
                symbol: helper,
                symbolRoles: 8,
              },
              {
                range: [4, 16, 22],
                enclosingRange: [4, 0, 6, 1],
                symbol: helper,
                symbolRoles: 1,
              },
            ],
            symbols: [
              {
                symbol: main,
                kind: 12,
                displayName: "main",
              },
              {
                symbol: helper,
                kind: 12,
                displayName: "helper",
              },
            ],
          },
        ],
      });

      const result = await executeProviderFirstScipFull({
        repoId: "repo",
        repoRoot,
        config: {
          scip: ScipConfigSchema.parse({
            enabled: true,
            indexes: [{ path: "index.scip" }],
            externalSymbols: { enabled: false, maxPerIndex: 100 },
          }),
          indexing: IndexingConfigSchema.parse({ pipeline: "providerFirst" }),
          repos: [{ repoId: "repo", rootPath: repoRoot, maxFileBytes: 1 }],
        } as AppConfig,
      });

      assert.equal(result.facts.coverage[0]?.callProofCoverage, "none");
      assert.deepEqual(result.facts.coverage[0]?.callProofUnavailableReasons, [
        { code: "sourceTooLarge", references: 1 },
      ]);
    } finally {
      rmSync(linkedRepoParent, { recursive: true, force: true });
      rmSync(realRepoRoot, { recursive: true, force: true });
    }
  });

  it("includes missing SCIP path diagnostics when provider execution has no facts", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-provider-first-missing-"));
    try {
      await assert.rejects(
        () =>
          executeProviderFirstScipFull({
            repoId: "repo",
            repoRoot,
            config: {
              scip: ScipConfigSchema.parse({
                enabled: true,
                indexes: [{ path: "index.scip" }],
              }),
              indexing: IndexingConfigSchema.parse({
                pipeline: "providerFirst",
              }),
              repos: [],
            } as AppConfig,
          }),
        /ingest index\.scip: SCIP index file not found/,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("records multi-line SCIP ranges before generic missing-source diagnostics", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-provider-first-range-"));
    const main = "scip-typescript npm fixture 1.0.0 src/index.ts/main().";
    const helper = "scip-typescript npm fixture 1.0.0 src/index.ts/helper().";
    try {
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      writeFileSync(
        join(repoRoot, "src", "index.ts"),
        [
          "export function main() {",
          "  return helper",
          "    ();",
          "}",
          "",
          "export function helper() {",
          "  return 1;",
          "}",
        ].join("\n"),
      );
      await writeTestScipIndex(join(repoRoot, "index.scip"), {
        metadata: {
          toolName: "scip-fixture",
          toolVersion: "1.0.0",
        },
        documents: [
          {
            language: "typescript",
            relativePath: "src/index.ts",
            occurrences: [
              {
                range: [0, 16, 20],
                enclosingRange: [0, 0, 3, 1],
                symbol: main,
                symbolRoles: 1,
              },
              {
                range: [1, 9, 2, 6],
                symbol: helper,
                symbolRoles: 8,
              },
              {
                range: [5, 16, 22],
                enclosingRange: [5, 0, 7, 1],
                symbol: helper,
                symbolRoles: 1,
              },
            ],
            symbols: [
              {
                symbol: main,
                kind: 12,
                displayName: "main",
              },
              {
                symbol: helper,
                kind: 12,
                displayName: "helper",
              },
            ],
          },
        ],
      });

      const result = await executeProviderFirstScipFull({
        repoId: "repo",
        repoRoot,
        config: {
          scip: ScipConfigSchema.parse({
            enabled: true,
            indexes: [{ path: "index.scip" }],
            externalSymbols: { enabled: false, maxPerIndex: 100 },
          }),
          indexing: IndexingConfigSchema.parse({ pipeline: "providerFirst" }),
          repos: [{ repoId: "repo", rootPath: repoRoot }],
        } as AppConfig,
      });

      assert.equal(result.facts.coverage[0]?.callProofCoverage, "none");
      assert.deepEqual(result.facts.coverage[0]?.callProofUnavailableReasons, [
        { code: "multiLineRange", references: 1 },
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("coalesces overlapping configured SCIP indexes before graph validation", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-provider-first-overlap-"));
    const symbol = "scip-typescript npm fixture 1.0.0 src/index.ts/main().";
    try {
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      writeFileSync(
        join(repoRoot, "src", "index.ts"),
        ["export function main() {", "  return 1;", "}"].join("\n"),
        "utf8",
      );
      const sharedDocument = {
        language: "typescript",
        relativePath: "src/index.ts",
        occurrences: [
          {
            range: [0, 16, 20] as [number, number, number],
            enclosingRange: [0, 0, 1, 1] as [number, number, number, number],
            symbol,
            symbolRoles: 1,
          },
        ],
        symbols: [
          {
            symbol,
            kind: 12,
            displayName: "main",
          },
        ],
      };
      for (const indexName of ["index-a.scip", "index-b.scip"]) {
        await writeTestScipIndex(join(repoRoot, indexName), {
          metadata: {
            toolName: "scip-fixture",
            toolVersion: "1.0.0",
          },
          documents: [sharedDocument],
        });
      }

      const result = await executeProviderFirstScipFull({
        repoId: "repo",
        repoRoot,
        config: {
          scip: ScipConfigSchema.parse({
            enabled: true,
            indexes: [{ path: "index-a.scip" }, { path: "index-b.scip" }],
            externalSymbols: { enabled: false, maxPerIndex: 100 },
          }),
          indexing: IndexingConfigSchema.parse({ pipeline: "providerFirst" }),
          repos: [{ repoId: "repo", rootPath: repoRoot }],
        } as AppConfig,
      });

      assert.equal(result.facts.files.length, 1);
      assert.equal(result.facts.symbols.length, 1);
      assert.equal(result.rows.files.length, 1);
      assert.equal(result.rows.symbols.length, 1);
      assert.equal(result.facts.providerRuns.length, 2);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("materializes provider facts into LadybugDB graph rows", () => {
    const emittedAt = "2026-05-25T12:00:00.000Z";
    const facts: ProviderFactSet = {
      files: [
        {
          kind: "file",
          repoId: "repo",
          generationId: "gen-1",
          providerType: "scip",
          providerId: "scip",
          emittedAt,
          fileId: "file-1",
          relPath: "src/index.ts",
          languageId: "typescript",
          contentHash: "0".repeat(64),
          byteSize: 42,
        },
      ],
      symbols: [
        {
          kind: "symbol",
          repoId: "repo",
          generationId: "gen-1",
          providerType: "scip",
          providerId: "scip",
          emittedAt,
          symbolId: "symbol-1",
          providerSymbolId: "scip npm pkg 1.0.0 src/index.ts/buildGraph().",
          name: "buildGraph",
          symbolKind: "function",
          relPath: "src/index.ts",
          range: { startLine: 1, startCol: 0, endLine: 3, endCol: 1 },
          signature: "function buildGraph(): Graph",
          documentation: ["Builds graph facts."],
          external: false,
        },
      ],
      occurrences: [],
      edges: [
        {
          kind: "edge",
          repoId: "repo",
          generationId: "gen-1",
          providerType: "scip",
          providerId: "scip",
          emittedAt,
          sourceSymbolId: "symbol-1",
          targetSymbolId: "symbol-2",
          edgeType: "call",
          resolution: "exact",
          confidence: 0.95,
          dedupeKey: "edge",
        },
      ],
      externalSymbols: [
        {
          kind: "externalSymbol",
          repoId: "repo",
          generationId: "gen-1",
          providerType: "scip",
          providerId: "scip",
          emittedAt,
          symbolId: "symbol-2",
          providerSymbolId: "scip npm dep 1.0.0 dep/index.ts/api().",
          name: "api",
          symbolKind: "function",
          packageName: "dep",
          packageVersion: "1.0.0",
          documentation: [],
        },
      ],
      diagnostics: [],
      coverage: [],
      providerRuns: [],
    };

    const rows = providerFactsToGraphRows({ facts, indexedAt: emittedAt });

    assert.equal(rows.files.length, 1);
    assert.equal(rows.files[0]?.language, "typescript");
    assert.equal(rows.symbols.length, 1);
    assert.equal(rows.symbols[0]?.summarySource, "provider:scip");
    assert.equal(
      rows.symbols[0]?.scipSymbol,
      facts.symbols[0]?.providerSymbolId,
    );
    assert.deepEqual(JSON.parse(rows.symbols[0]?.signatureJson ?? "{}"), {
      text: "function buildGraph(): Graph",
    });
    assert.equal(rows.externalSymbols.length, 1);
    assert.equal(rows.externalSymbols[0]?.external, true);
    assert.equal(rows.edges.length, 1);
    assert.equal(rows.edges[0]?.resolverId, "provider-first:scip");
    assert.equal(rows.edges[0]?.resolutionPhase, "provider-first");
  });

  it("preserves LSP provenance when shaping provider graph rows", () => {
    const emittedAt = "2026-06-16T12:00:00.000Z";
    const rows = providerFactsToGraphRows({
      indexedAt: emittedAt,
      facts: providerFactSet({
        externalSymbols: [
          {
            kind: "externalSymbol",
            repoId: "repo",
            generationId: "gen-lsp",
            providerType: "lsp",
            providerId: "phpactor",
            emittedAt,
            symbolId: "external:lsp:phpactor:vendor/autoload.php:Acme\\\\Tool",
            providerSymbolId: "phpactor:Acme\\\\Tool",
            name: "Tool",
            symbolKind: "class",
            packageName: "acme/tool",
            documentation: [],
          },
        ],
      }),
    });

    assert.equal(rows.externalSymbols.length, 1);
    assert.equal(rows.externalSymbols[0]?.source, "lsp");
    assert.equal(rows.externalSymbols[0]?.scipSymbol, "phpactor:Acme\\\\Tool");
  });

  it("carries raw file SHA-256 and byte size from provider file facts", () => {
    const rows = providerFactsToGraphRows({
      indexedAt: "2026-05-25T12:00:00.000Z",
      facts: providerFactSet({
        files: [
          {
            kind: "file",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt: "2026-05-25T12:00:00.000Z",
            fileId: "file-raw",
            relPath: "src/raw.ts",
            languageId: "typescript",
            contentHash: "2".repeat(64),
            byteSize: 123,
          },
        ],
      }),
    });

    assert.equal(rows.files[0]?.contentHash, "2".repeat(64));
    assert.equal(rows.files[0]?.byteSize, 123);
  });

  it("rejects provider graph rows with missing raw file hashes and bad endpoints", () => {
    const rows = providerFactsToGraphRows({
      indexedAt: "2026-05-25T12:00:00.000Z",
      facts: providerFactSet({
        files: [
          {
            kind: "file",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt: "2026-05-25T12:00:00.000Z",
            fileId: "file-invalid",
            relPath: "src/index.ts",
            languageId: "typescript",
          },
        ],
        edges: [
          {
            kind: "edge",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt: "2026-05-25T12:00:00.000Z",
            sourceSymbolId: "symbol-1",
            targetSymbolId: "symbol-missing",
            edgeType: "call",
            resolution: "exact",
            confidence: 0.95,
            dedupeKey: "symbol-1:symbol-missing:call:scip",
          },
        ],
      }),
    });

    assert.throws(
      () => validateProviderFirstGraphRows(rows, { repoId: "repo" }),
      /invalid raw SHA-256 contentHash/i,
    );

    rows.files[0]!.contentHash = "3".repeat(64);
    rows.files[0]!.byteSize = 10;
    assert.throws(
      () => validateProviderFirstGraphRows(rows, { repoId: "repo" }),
      /missing endpoint/i,
    );
  });

  it("maps provider runs, diagnostics, and coverage summaries to semantic provenance records", () => {
    const facts = providerFactSet({
      providerRuns: [
        {
          kind: "providerRun",
          repoId: "repo",
          generationId: "gen-1",
          providerType: "scip",
          providerId: "scip",
          emittedAt: "2026-05-25T12:00:00.000Z",
          runId: "gen-1:scip",
          status: "succeeded",
          startedAt: "2026-05-25T12:00:00.000Z",
          finishedAt: "2026-05-25T12:00:00.000Z",
          sourceIndexPath: "index.scip",
          fileCount: 1,
          symbolCount: 1,
          edgeCount: 0,
          diagnosticCount: 0,
        },
      ],
      diagnostics: [
        {
          kind: "diagnostic",
          repoId: "repo",
          generationId: "gen-1",
          providerType: "scip",
          providerId: "scip",
          emittedAt: "2026-05-25T12:00:00.000Z",
          diagnosticId: "diag-1",
          relPath: "src/index.ts",
          severity: "warning",
          message: "provider warning",
        },
      ],
      coverage: [
        {
          kind: "coverage",
          repoId: "repo",
          generationId: "gen-1",
          providerType: "scip",
          providerId: "scip",
          emittedAt: "2026-05-25T12:00:00.000Z",
          relPath: "src/index.ts",
          symbolCoverage: "full",
          referenceCoverage: "full",
          callProofCoverage: "partial",
          diagnosticCoverage: "full",
          totalSymbols: 1,
          emittedSymbols: 1,
          totalOccurrences: 3,
          unresolvedOccurrences: 0,
          totalResolvedReferences: 2,
          callProofUnavailableReferences: 1,
          callProofUnavailableReasons: [
            { code: "symbolTextMismatch", references: 1 },
          ],
          legacyFallback: "skip",
        },
      ],
    });

    const records = providerFactsToSemanticProvenanceRecords(facts);
    assert.equal(records.providerRuns.length, 1);
    assert.equal(records.providerRuns[0]?.status, "completed");
    assert.equal(records.providerRuns[0]?.diagnosticsCount, 3);
    assert.match(
      records.providerRuns[0]?.metadataJson ?? "",
      /callProofUnavailableReferences/,
    );
    assert.equal(records.diagnostics.length, 3);
    assert.deepEqual(
      records.diagnostics.map((diagnostic) => diagnostic.code).sort(),
      [
        "providerFirst.callProof.symbolTextMismatch",
        "providerFirst.coverage.callProof",
        undefined,
      ].sort(),
    );
  });

  it("records provider edge provenance with source path and SCIP index context", () => {
    const emittedAt = "2026-05-25T12:00:00.000Z";
    const rows = providerFactsToGraphRows({
      indexedAt: emittedAt,
      facts: providerFactSet({
        edges: [
          {
            kind: "edge",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "llvm-cpp",
            providerVersion: "1.0.0",
            emittedAt,
            sourceSymbolId: "symbol-1",
            targetSymbolId: "symbol-2",
            edgeType: "call",
            resolution: "exact",
            confidence: 0.95,
            dedupeKey: "symbol-1|symbol-2|call|llvm-cpp",
            relPath: "lib/IR/User.cpp",
            sourceIndexPath: "build/llvm.scip",
          },
        ],
      }),
    });

    assert.deepEqual(JSON.parse(rows.edges[0]?.provenance ?? "{}"), {
      providerId: "llvm-cpp",
      providerType: "scip",
      providerVersion: "1.0.0",
      sourceIndexPath: "build/llvm.scip",
      relPath: "lib/IR/User.cpp",
      dedupeKey: "symbol-1|symbol-2|call|llvm-cpp",
    });
  });

  it("scores provider summaries by documentation depth", () => {
    const emittedAt = "2026-05-25T12:00:00.000Z";
    const rows = providerFactsToGraphRows({
      indexedAt: emittedAt,
      facts: providerFactSet({
        symbols: [
          {
            kind: "symbol",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt,
            symbolId: "symbol-minimal",
            providerSymbolId: "scip npm pkg 1.0.0 src/index.ts/minimal().",
            name: "minimal",
            symbolKind: "function",
            relPath: "src/index.ts",
            range: { startLine: 1, startCol: 0, endLine: 1, endCol: 10 },
            signature: "function minimal(): void",
            documentation: ["Runs."],
            external: false,
          },
          {
            kind: "symbol",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt,
            symbolId: "symbol-rich",
            providerSymbolId: "scip npm pkg 1.0.0 src/index.ts/rich().",
            name: "rich",
            symbolKind: "function",
            relPath: "src/index.ts",
            range: { startLine: 3, startCol: 0, endLine: 3, endCol: 10 },
            signature: "function rich(): void",
            documentation: [
              [
                "Builds a stable provider-first graph from compiler facts.",
                "Preserves exact call edges, import relationships, and documentation for semantic retrieval.",
                "Used by large generated indexes where provider documentation should not be treated as a weak heuristic.",
              ].join("\n"),
            ],
            external: false,
          },
        ],
      }),
    });

    const minimal = rows.symbols.find((symbol) => symbol.name === "minimal");
    const rich = rows.symbols.find((symbol) => symbol.name === "rich");

    assert.equal(minimal?.summaryQuality, 0.4);
    assert.equal(rich?.summaryQuality, 0.8);
  });

  it("merges provider and legacy fallback rows for shadow staging", () => {
    const providerRows = providerFactsToGraphRows({
      facts: providerFactSet(),
      indexedAt: "2026-05-25T12:00:00.000Z",
    });
    const fallbackEdge = {
      repoId: "repo",
      fromSymbolId: "symbol-legacy",
      toSymbolId: "symbol-1",
      edgeType: "call",
      weight: 1,
      confidence: 0.8,
      resolution: "heuristic",
      resolverId: "pass2-typescript",
      resolutionPhase: "pass2",
      provenance: "legacy-edge",
      createdAt: "2026-05-25T12:00:00.000Z",
    };
    const fallbackRows = {
      files: [
        {
          fileId: "file-legacy",
          repoId: "repo",
          relPath: "src/extra.ts",
          contentHash: "1".repeat(64),
          language: "typescript",
          byteSize: 42,
          lastIndexedAt: "2026-05-25T12:00:00.000Z",
        },
      ],
      symbols: [
        {
          symbolId: "symbol-legacy",
          repoId: "repo",
          fileId: "file-legacy",
          kind: "function",
          name: "extra",
          exported: true,
          visibility: "public",
          language: "typescript",
          rangeStartLine: 1,
          rangeStartCol: 0,
          rangeEndLine: 3,
          rangeEndCol: 1,
          astFingerprint: "legacy",
          signatureJson: "{}",
          summary: null,
          invariantsJson: null,
          sideEffectsJson: null,
          updatedAt: "2026-05-25T12:00:00.000Z",
        },
      ],
      externalSymbols: [],
      edges: [fallbackEdge, fallbackEdge],
      changedFileIds: new Set(["file-legacy"]),
    };

    const merged = mergeProviderFirstGraphRows(providerRows, fallbackRows);

    assert.equal(merged.files.length, 2);
    assert.equal(merged.symbols.length, 2);
    assert.equal(merged.edges.length, 1);
    assert.deepEqual([...merged.changedFileIds].sort(), [
      "file-1",
      "file-legacy",
    ]);
    validateProviderFirstGraphRows(merged, { repoId: "repo" });
  });

  it("canonicalizes legacy fallback shadow row languages", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-fallback-language-"),
    );
    const dbPath = join(root, "active.lbug");
    const kuzu = await import("kuzu");
    const db = new kuzu.Database(dbPath);
      const conn = new kuzu.Connection(db);
      try {
        await createBaseSchema(conn);
        await dbExec(
          conn,
          `MERGE (r:Repo {repoId: $repoId})
           SET r.rootPath = $rootPath,
               r.configJson = '{}',
               r.createdAt = $indexedAt`,
        {
          repoId: "repo",
          rootPath: root,
          indexedAt: "2026-05-25T12:00:00.000Z",
        },
      );
      for (const row of [
        {
          fileId: "file-ts",
          relPath: "src/fallback.ts",
          contentHash: "1".repeat(64),
          fileLanguage: "ts",
          symbolId: "symbol-ts",
          symbolLanguage: "typescript",
          name: "runTs",
          byteSize: 128,
        },
        {
          fileId: "file-rs",
          relPath: "native/fallback.rs",
          contentHash: "2".repeat(64),
          fileLanguage: "rs",
          symbolId: "symbol-rs",
          symbolLanguage: "rust",
          name: "runRs",
          byteSize: 96,
        },
      ]) {
        await dbExec(
          conn,
          `MATCH (r:Repo {repoId: $repoId})
           MERGE (f:File {fileId: $fileId})
           SET f.relPath = $relPath,
               f.contentHash = $contentHash,
               f.language = $fileLanguage,
               f.byteSize = $byteSize,
               f.lastIndexedAt = $indexedAt
           MERGE (f)-[:FILE_IN_REPO]->(r)
           MERGE (s:Symbol {symbolId: $symbolId})
           SET s.repoId = $repoId,
               s.kind = 'function',
               s.name = $name,
               s.exported = true,
               s.visibility = 'public',
               s.language = $symbolLanguage,
               s.rangeStartLine = 1,
               s.rangeStartCol = 0,
               s.rangeEndLine = 3,
               s.rangeEndCol = 1,
               s.astFingerprint = $symbolId,
               s.signatureJson = '{}',
               s.summaryQuality = 0.5,
               s.summarySource = 'test',
               s.roleTagsJson = '[]',
               s.searchText = $name,
               s.external = false,
               s.source = 'treesitter',
               s.symbolStatus = 'real',
               s.updatedAt = $indexedAt
           MERGE (s)-[:SYMBOL_IN_FILE]->(f)
           MERGE (s)-[:SYMBOL_IN_REPO]->(r)`,
          {
            repoId: "repo",
            indexedAt: "2026-05-25T12:00:00.000Z",
            ...row,
          },
        );
      }

      const rows = await collectLegacyFallbackShadowRows({
        conn,
        repoId: "repo",
        relPaths: ["src/fallback.ts", "native/fallback.rs"],
        providerRows: {
          files: [],
          symbols: [],
          externalSymbols: [],
          edges: [],
          changedFileIds: new Set(),
        },
      });

      const fileLanguageByPath = new Map(
        rows.files.map((row) => [row.relPath, row.language]),
      );
      assert.equal(fileLanguageByPath.get("src/fallback.ts"), "typescript");
      assert.equal(fileLanguageByPath.get("native/fallback.rs"), "rust");

      const symbolLanguageById = new Map(
        rows.symbols.map((row) => [row.symbolId, row.language]),
      );
      assert.equal(symbolLanguageById.get("symbol-ts"), "typescript");
      assert.equal(symbolLanguageById.get("symbol-rs"), "rust");
    } finally {
      conn.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes active fallback batch file languages", () => {
    const accumulator = new BatchPersistAccumulator(10_000, {
      autoDrain: false,
    });
    accumulator.addFile(
      {
        fileId: "file-ts",
        repoId: "repo",
        relPath: "src/fallback.ts",
        contentHash: "1".repeat(64),
        language: "ts",
        byteSize: 128,
        lastIndexedAt: "2026-05-25T12:00:00.000Z",
      },
      null,
    );
    accumulator.addFile(
      {
        fileId: "file-rs",
        repoId: "repo",
        relPath: "native/fallback.rs",
        contentHash: "2".repeat(64),
        language: "rs",
        byteSize: 96,
        lastIndexedAt: "2026-05-25T12:00:00.000Z",
      },
      null,
    );

    const queuedFiles = (
      accumulator as unknown as {
        files: Array<{ file: { fileId: string; language: string } }>;
      }
    ).files;

    assert.deepEqual(
      queuedFiles.map((entry) => [entry.file.fileId, entry.file.language]),
      [
        ["file-ts", "typescript"],
        ["file-rs", "rust"],
      ],
    );
  });

  it("wraps provider materialization helper in a single transaction", async () => {
    const statements: string[] = [];
    const rows = providerFactsToGraphRows({
      indexedAt: "2026-05-25T12:00:00.000Z",
      facts: providerFactSet({
        externalSymbols: [
          {
            kind: "externalSymbol",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt: "2026-05-25T12:00:00.000Z",
            symbolId: "symbol-2",
            providerSymbolId: "scip npm dep 1.0.0 dep/index.ts/api().",
            name: "api",
            symbolKind: "function",
            packageName: "dep",
            packageVersion: "1.0.0",
            documentation: [],
          },
        ],
      }),
    });

    await materializeProviderFacts(createFakeConnection(statements), rows);

    assert.equal(countStatements(statements, "BEGIN TRANSACTION"), 1);
    assert.equal(countStatements(statements, "COMMIT"), 1);
  });

  it("uses full-replacement edge options when replacing provider file symbols", async () => {
    const statements: string[] = [];
    const rows = providerFactsToGraphRows({
      indexedAt: "2026-05-25T12:00:00.000Z",
      facts: providerFactSet({
        edges: [
          {
            kind: "edge",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt: "2026-05-25T12:00:00.000Z",
            sourceSymbolId: "symbol-1",
            targetSymbolId: "symbol-1",
            edgeType: "import",
            resolution: "exact",
            confidence: 0.95,
            dedupeKey: "symbol-1:symbol-1:import:scip",
          },
        ],
      }),
    });

    await materializeProviderFacts(createFakeConnection(statements), rows, {
      replaceFileSymbols: true,
    });

    assert.equal(
      countStatements(statements, "SET s.repoId = $repoId"),
      0,
      "source SYMBOL_IN_REPO rel refresh should be skipped after symbol replacement",
    );
    assert.equal(
      countStatements(statements, "WHERE d.confidence < row.confidence"),
      0,
      "existing relationship update should be skipped after symbol replacement",
    );
  });

  it("retires provider file symbols through FILE_IN_REPO ownership", async () => {
    const statements: string[] = [];
    const rows = providerFactsToGraphRows({
      indexedAt: "2026-05-25T12:00:00.000Z",
      facts: providerFactSet(),
    });

    await materializeProviderFacts(
      createFakeConnection(statements, (statement) =>
        statement.includes("RETURN s.symbolId AS symbolId")
          ? [{ symbolId: "stale-symbol" }]
          : [],
      ),
      rows,
      { replaceFileSymbols: true },
    );

    assert.equal(
      countStatements(statements, "RETURN DISTINCT f.repoId AS repoId"),
      0,
      "File nodes do not store repoId; ownership must be resolved through FILE_IN_REPO",
    );
    assert.equal(
      statements.some(
        (statement) =>
          statement.includes("FILE_IN_REPO") &&
          statement.includes("RETURN s.symbolId AS symbolId"),
      ),
      true,
    );
  });

  it("drops and rebuilds Symbol FTS around provider replacement materialization", async () => {
    const statements: string[] = [];
    const rows = providerFactsToGraphRows({
      indexedAt: "2026-05-25T12:00:00.000Z",
      facts: providerFactSet(),
    });

    await materializeProviderFacts(
      createFakeConnection(statements, (statement) => {
        if (statement.includes("RETURN s.symbolId AS symbolId")) {
          return [{ symbolId: "stale-symbol" }];
        }
        if (statement.includes("COUNT(n) AS rowCount")) {
          return [{ rowCount: 1 }];
        }
        return [];
      }),
      rows,
      { replaceFileSymbols: true },
    );

    const dropIndex = statements.findIndex((statement) =>
      statement.includes("CALL DROP_FTS_INDEX('Symbol', 'symbol_search_text_v1')"),
    );
    const staleLookupIndex = statements.findIndex((statement) =>
      statement.includes("RETURN s.symbolId AS symbolId"),
    );
    const createIndex = statements.findIndex((statement) =>
      statement.includes("CALL CREATE_FTS_INDEX('Symbol', 'symbol_search_text_v1'"),
    );

    assert.ok(dropIndex >= 0, "provider replacement must drop Symbol FTS first");
    assert.ok(
      staleLookupIndex > dropIndex,
      "stale symbol cleanup must run after Symbol FTS is dropped",
    );
    assert.ok(
      createIndex > staleLookupIndex,
      "Symbol FTS must be rebuilt after replacement materialization",
    );
  });

  it("records provider materialization subphase timings in write order", async () => {
    const statements: string[] = [];
    const phases: string[] = [];
    const rows = providerFactsToGraphRows({
      indexedAt: "2026-05-25T12:00:00.000Z",
      facts: providerFactSet({
        externalSymbols: [
          {
            kind: "externalSymbol",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt: "2026-05-25T12:00:00.000Z",
            symbolId: "symbol-2",
            providerSymbolId: "scip npm dep 1.0.0 dep/index.ts/api().",
            name: "api",
            symbolKind: "function",
            packageName: "dep",
            packageVersion: "1.0.0",
            documentation: [],
          },
        ],
        edges: [
          {
            kind: "edge",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt: "2026-05-25T12:00:00.000Z",
            sourceSymbolId: "symbol-1",
            targetSymbolId: "symbol-2",
            edgeType: "call",
            resolution: "exact",
            confidence: 0.95,
            dedupeKey: "symbol-1:symbol-2:call:scip",
          },
        ],
      }),
    });

    await materializeProviderFacts(createFakeConnection(statements), rows, {
      replaceFileSymbols: true,
      measurePhase: async (phaseName, fn) => {
        phases.push(phaseName);
        return await fn();
      },
    });

    assert.deepEqual(phases, [
      "deleteFileSymbols",
      "upsertFiles",
      "upsertSymbols",
      "upsertSymbols.nodeAndRelCreate",
      "pruneExternalSymbols",
      "mergeExternalSymbols",
      "insertEdges",
      "insertEdges.dedupe",
      "insertEdges.groupByRepo",
      "insertEdges.prepareRows",
      "insertEdges.relationshipCreate",
    ]);
  });

  it("skips repo-wide external pruning for scoped provider materialization", async () => {
    const statements: string[] = [];
    const phases: string[] = [];
    const rows = providerFactsToGraphRows({
      indexedAt: "2026-05-25T12:00:00.000Z",
      facts: providerFactSet({
        externalSymbols: [
          {
            kind: "externalSymbol",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt: "2026-05-25T12:00:00.000Z",
            symbolId: "symbol-2",
            providerSymbolId: "scip npm dep 1.0.0 dep/index.ts/api().",
            name: "api",
            symbolKind: "function",
            packageName: "dep",
            packageVersion: "1.0.0",
            documentation: [],
          },
        ],
      }),
    });

    await materializeProviderFacts(createFakeConnection(statements), rows, {
      pruneExternalSymbols: false,
      measurePhase: async (phaseName, fn) => {
        phases.push(phaseName);
        return await fn();
      },
    });

    assert.equal(phases.includes("pruneExternalSymbols"), false);
    assert.equal(
      statements.some(
        (statement) =>
          statement.includes("coalesce(s.external, false) = true") &&
          statement.includes("coalesce(s.source, '') = 'scip'"),
      ),
      false,
    );
  });

  it("uses provider-first active materialization batch shapes", async () => {
    const statements: string[] = [];
    const emittedAt = "2026-05-25T12:00:00.000Z";
    const symbols = Array.from({ length: 300 }, (_, index) => ({
      kind: "symbol" as const,
      repoId: "repo",
      generationId: "gen-1",
      providerType: "scip" as const,
      providerId: "scip",
      emittedAt,
      symbolId: `symbol-${index}`,
      providerSymbolId: `scip npm pkg 1.0.0 src/index.ts/symbol${index}().`,
      name: `symbol${index}`,
      symbolKind: "function" as const,
      relPath: "src/index.ts",
      range: {
        startLine: index + 1,
        startCol: 0,
        endLine: index + 1,
        endCol: 10,
      },
      documentation: [],
      external: false,
    }));
    const rows = providerFactsToGraphRows({
      indexedAt: emittedAt,
      facts: providerFactSet({
        symbols,
        edges: [
          {
            kind: "edge",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt,
            sourceSymbolId: "symbol-0",
            targetSymbolId: "symbol-1",
            edgeType: "call",
            resolution: "exact",
            confidence: 0.95,
            dedupeKey: "symbol-0:symbol-1:call:scip",
          },
        ],
      }),
    });

    await materializeProviderFacts(createFakeConnection(statements), rows, {
      replaceFileSymbols: true,
    });

    assert.equal(
      countStatements(statements, "MERGE (s:Symbol {symbolId: row.symbolId})"),
      0,
      "provider-first replacement materialization should not merge known-fresh symbol nodes",
    );
    assert.equal(
      countStatements(statements, "CREATE (s:Symbol {symbolId: row.symbolId})"),
      0,
      "provider-first materialization should not use per-row known-fresh symbol creation",
    );
    assert.equal(
      countStatements(statements, "COPY Symbol FROM"),
      1,
      "provider-first materialization should bulk-load known-fresh symbol nodes",
    );
    assert.equal(
      countStatements(statements, "COPY SYMBOL_IN_FILE FROM"),
      1,
      "provider-first materialization should bulk-load known-fresh symbol-file relationships",
    );
    assert.equal(
      countStatements(statements, "COPY SYMBOL_IN_REPO FROM"),
      1,
      "provider-first materialization should bulk-load known-fresh symbol-repo relationships",
    );
    assert.equal(
      countStatements(
        statements,
        "OPTIONAL MATCH (s)-[existing:SYMBOL_IN_FILE]",
      ),
      0,
      "provider-first materialization should not probe known fresh symbol-file relationships",
    );
    assert.equal(
      countStatements(statements, "row.targetStatus"),
      0,
      "provider-first materialization should not repair known-fresh edge endpoint metadata",
    );
    assert.equal(
      countStatements(
        statements,
        "OPTIONAL MATCH (s)-[existing:SYMBOL_IN_FILE]",
      ),
      0,
      "provider-first replacement materialization should not probe known-fresh symbol-file relationships",
    );
    assert.equal(
      countStatements(statements, "OPTIONAL MATCH (a)-[existing:DEPENDS_ON"),
      0,
      "provider-first replacement materialization should not probe known-fresh edge relationships",
    );
    assert.equal(
      countStatements(statements, "COPY DEPENDS_ON FROM"),
      0,
      "provider-first replacement materialization should avoid relationship COPY for provenance-sensitive edges",
    );
    assert.equal(
      countStatements(statements, "CREATE (a)-[:DEPENDS_ON"),
      1,
      "provider-first replacement materialization should use parameterized relationship creation",
    );
  });

  it("deletes existing provider symbol nodes by incoming ids before known-fresh copy", async () => {
    const statements: string[] = [];
    const emittedAt = "2026-05-25T12:00:00.000Z";
    const rows = providerFactsToGraphRows({
      indexedAt: emittedAt,
      facts: providerFactSet({
        symbols: [
          {
            kind: "symbol",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt,
            symbolId: "symbol-orphan",
            providerSymbolId: "scip npm pkg 1.0.0 src/index.ts/orphan().",
            name: "orphan",
            symbolKind: "function",
            relPath: "src/index.ts",
            range: { startLine: 1, startCol: 0, endLine: 1, endCol: 10 },
            documentation: [],
            external: false,
          },
        ],
      }),
    });

    await materializeProviderFacts(
      createFakeConnection(statements, (statement) =>
        statement.includes("s.symbolId IN $symbolIds") &&
        statement.includes("RETURN s.symbolId AS symbolId")
          ? [{ symbolId: "symbol-orphan" }]
          : [],
      ),
      rows,
      {
        replaceFileSymbols: true,
      },
    );

    const symbolDeleteIndex = statements.findIndex(
      (statement) =>
        statement.includes("MATCH (s:Symbol {repoId: $repoId})") &&
        statement.includes("DELETE s"),
    );
    const symbolCopyIndex = statements.findIndex((statement) =>
      statement.includes("COPY Symbol FROM"),
    );

    assert.ok(
      symbolDeleteIndex >= 0,
      "provider replacement should delete stale/orphan symbol nodes by incoming ids",
    );
    assert.ok(
      symbolDeleteIndex < symbolCopyIndex,
      "stale/orphan symbol nodes must be deleted before COPY inserts primary keys",
    );
  });

  it("uses merge-safe symbols and skips edge copy when provider rows are not known fresh", async () => {
    const statements: string[] = [];
    const emittedAt = "2026-05-25T12:00:00.000Z";
    const rows = providerFactsToGraphRows({
      indexedAt: emittedAt,
      facts: providerFactSet({
        symbols: [
          {
            kind: "symbol",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt,
            symbolId: "symbol-1",
            providerSymbolId: "scip npm pkg 1.0.0 src/index.ts/api().",
            name: "api",
            symbolKind: "function",
            relPath: "src/index.ts",
            range: { startLine: 1, startCol: 0, endLine: 1, endCol: 10 },
            documentation: [],
            external: false,
          },
        ],
        edges: [
          {
            kind: "edge",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt,
            sourceSymbolId: "symbol-1",
            targetSymbolId: "symbol-1",
            edgeType: "call",
            resolution: "exact",
            confidence: 0.95,
            dedupeKey: "symbol-1:symbol-1:call:scip",
          },
        ],
      }),
    });

    await materializeProviderFacts(createFakeConnection(statements), rows, {
      replaceFileSymbols: true,
      deleteExistingFileSymbols: false,
      useKnownFreshWriters: false,
      writeEdges: false,
    });

    assert.equal(
      countStatements(statements, "COPY Symbol FROM"),
      0,
      "existing active symbols should not be copied again when stale cleanup is skipped",
    );
    assert.equal(
      countStatements(statements, "MERGE (s:Symbol {symbolId: row.symbolId})"),
      1,
      "existing active symbols should be updated through the merge-safe writer",
    );
    assert.equal(
      countStatements(statements, "COPY DEPENDS_ON FROM"),
      0,
      "existing active edges should not be copied again when stale cleanup is skipped",
    );
    assert.equal(
      countStatements(statements, "CREATE (a)-[:DEPENDS_ON"),
      0,
      "large repeat materialization should not use the slow generic edge writer",
    );
  });

  it("reuses active provider rows when large repeat runs cannot safely retire stale symbols", () => {
    assert.deepEqual(
      resolveProviderFirstActiveMaterializationPlan({
        existingProviderFileCount: 0,
        providerSymbolCount: 200_000,
      }),
      {
        deleteExistingFileSymbols: false,
        useKnownFreshWriters: true,
        writeEdges: true,
        reuseExistingProviderRows: false,
      },
      "fresh large provider loads can use COPY because no active rows exist yet",
    );

    assert.deepEqual(
      resolveProviderFirstActiveMaterializationPlan({
        existingProviderFileCount: 1_000,
        providerSymbolCount: 2_000,
      }),
      {
        deleteExistingFileSymbols: true,
        useKnownFreshWriters: true,
        writeEdges: true,
        reuseExistingProviderRows: false,
      },
      "small repeat runs below LadybugDB's safe delete ceiling use fast replacement writers",
    );

    assert.deepEqual(
      resolveProviderFirstActiveMaterializationPlan({
        existingProviderFileCount: 1_000,
        providerSymbolCount: 4_414,
      }),
      {
        deleteExistingFileSymbols: false,
        useKnownFreshWriters: false,
        writeEdges: false,
        reuseExistingProviderRows: true,
      },
      "Zod-scale repeat runs avoid unsafe active rewrites and reuse existing provider rows",
    );

    assert.deepEqual(
      resolveProviderFirstActiveMaterializationPlan({
        existingProviderFileCount: 16_000,
        providerSymbolCount: 200_000,
      }),
      {
        deleteExistingFileSymbols: false,
        useKnownFreshWriters: false,
        writeEdges: false,
        reuseExistingProviderRows: true,
      },
      "large repeat runs reuse existing active provider rows instead of crashing native deletes or duplicate COPYs",
    );

    assert.deepEqual(
      resolveProviderFirstActiveMaterializationPlan({
        existingProviderFileCount: 16_000,
        providerSymbolCount: 200_000,
        activeProviderInputMatches: false,
        existingProviderSymbolCount: 12_000,
      }),
      {
        deleteExistingFileSymbols: false,
        useKnownFreshWriters: false,
        writeEdges: false,
        reuseExistingProviderRows: false,
      },
      "large changed provider inputs skip direct active rewrites and require clean rebuild or shadow activation for physical replacement",
    );

    assert.deepEqual(
      resolveProviderFirstActiveMaterializationPlan({
        existingProviderFileCount: 5_120,
        providerSymbolCount: 199_003,
        activeProviderInputMatches: false,
        existingProviderSymbolCount: 199_003,
      }),
      {
        deleteExistingFileSymbols: false,
        useKnownFreshWriters: false,
        writeEdges: false,
        reuseExistingProviderRows: true,
      },
      "versionless recovery can reuse active provider symbols when the current provider shape is already present",
    );
  });

  it("counts only provider-primary existing files for active materialization reuse", () => {
    assert.equal(
      countExistingProviderPrimaryFiles({
        providerFiles: [
          { relPath: "src/provider.cpp" },
          { relPath: "include/provider.h" },
        ],
        existingByPath: new Map([
          ["src/provider.cpp", { fileId: "provider-file" }],
          ["docs/readme.md", { fileId: "outside-provider" }],
          ["legacy/fallback.cpp", { fileId: "fallback-file" }],
        ]),
      }),
      1,
    );
  });

  it("reuses the full graph only for a verified unchanged provider repeat", () => {
    assert.equal(
      shouldReuseProviderFirstFullGraph({
        reuseExistingProviderRows: true,
        activeProviderInputMatches: true,
        allFilesUnchanged: true,
      }),
      true,
    );
    for (const changedInput of [
      {
        reuseExistingProviderRows: false,
        activeProviderInputMatches: true,
        allFilesUnchanged: true,
      },
      {
        reuseExistingProviderRows: true,
        activeProviderInputMatches: false,
        allFilesUnchanged: true,
      },
      {
        reuseExistingProviderRows: true,
        activeProviderInputMatches: true,
        allFilesUnchanged: false,
      },
    ]) {
      assert.equal(shouldReuseProviderFirstFullGraph(changedInput), false);
    }
  });

  it("preserves release-scale symbol identities across provider-first checkpoints", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-release-scale-integrity-"),
    );
    const activeDbPath = join(root, "active.lbug");
    const repoId = "release-scale-integrity-repo";
    const now = "2026-07-16T00:00:00.000Z";
    const fixture = releaseScaleProviderFirstRows(repoId, now);
    const { rows } = fixture;
    const expectedSymbols = canonicalProjectionForRows(rows);
    const expectedRelationships = canonicalRelationshipProjectionForRows(rows);
    const unresolvedTargets = Array.from({ length: 8 }, (_, index) =>
      unresolvedCallSymbolId(`release-scale-unused-${index}`),
    );
    const expectedPlaceholders = canonicalIsolatedPlaceholderProjection(
      repoId,
      unresolvedTargets,
    );
    const mutatedPlaceholders = expectedPlaceholders.map((row) => {
      const embeddingIndex = unresolvedTargets.indexOf(row.symbolId);
      return row.symbolId === unresolvedTargets.at(-1)
        ? {
            ...row,
            summary: "release-scale mutated placeholder summary",
            summaryQuality: 0.9,
            summarySource: "qa:release-scale",
            embeddingJinaCode: `embedding-${embeddingIndex}`,
            embeddingJinaCodeCardHash: `card-${embeddingIndex}`,
          }
        : {
            ...row,
            embeddingJinaCode: `embedding-${embeddingIndex}`,
            embeddingJinaCodeCardHash: `card-${embeddingIndex}`,
          };
    });
    let activeConn: import("kuzu").Connection | undefined;

    assertProviderIdentityBindings(fixture);
    validateProviderFirstGraphRows(rows, {
      repoId,
      context: "Release-scale provider-first integrity fixture",
    });

    try {
      await closeLadybugDb();
      await initLadybugDb(activeDbPath);
      await withWriteConn(async (writeConn) => {
        await ladybugDb.upsertRepo(writeConn, {
          repoId,
          rootPath: root,
          configJson: "{}",
          createdAt: now,
        });
        await ladybugDb.upsertFileBatch(writeConn, rows.files);

        await ladybugDb.upsertKnownFileSymbols(writeConn, rows.symbols);
        await assertReleaseScaleState(
          writeConn,
          "initial Symbol persistence",
          repoId,
          expectedSymbols,
          [],
          [],
        );

        await ladybugDb.ensureDependencyTargetsForKnownSourceEdges(
          writeConn,
          unresolvedTargets.map((toSymbolId, index) => ({
            repoId,
            fromSymbolId: rows.symbols[index]!.symbolId,
            toSymbolId,
            edgeType: "call",
            weight: 1,
            confidence: 0.5,
            resolution: "unresolved",
            resolverId: `provider-first:placeholder-${index}`,
            resolutionPhase: "provider-first",
            provenance: JSON.stringify({
              dedupeKey: `placeholder-${index}`,
              providerId: `placeholder-${index}`,
            }),
            createdAt: now,
            targetMeta: {
              symbolStatus: "unresolved" as const,
              placeholderKind: "call",
              placeholderTarget: `release-scale-unused-${index}`,
            },
          })),
          { measurePhase: async (_phaseName, fn) => await fn() },
        );
        await assertReleaseScaleState(
          writeConn,
          "placeholder preparation",
          repoId,
          expectedSymbols,
          expectedPlaceholders,
          [],
        );

        assert.equal(
          await ladybugDb.pruneIsolatedPlaceholderSymbols(writeConn, repoId),
          0,
          "large COPY-backed Symbol tables retain isolated placeholders before an unsafe delete",
        );
        await assertReleaseScaleState(
          writeConn,
          "placeholder pruning",
          repoId,
          expectedSymbols,
          expectedPlaceholders,
          [],
        );

        await ladybugDb.insertKnownSymbolEdges(writeConn, rows.edges);
        await assertReleaseScaleState(
          writeConn,
          "relationship materialization",
          repoId,
          expectedSymbols,
          expectedPlaceholders,
          expectedRelationships,
        );

        await ladybugDb.updateSymbolSummary(
          writeConn,
          unresolvedTargets.at(-1)!,
          "release-scale mutated placeholder summary",
          0.9,
          "qa:release-scale",
          now,
        );
        await setSymbolEmbeddingBatchOnNode(
          writeConn,
          "jina-embeddings-v2-base-code",
          unresolvedTargets.map((symbolId, index) => ({
            symbolId,
            vector: `embedding-${index}`,
            cardHash: `card-${index}`,
          })),
        );
        await assertReleaseScaleState(
          writeConn,
          "summary and embedding mutations",
          repoId,
          expectedSymbols,
          mutatedPlaceholders,
          expectedRelationships,
        );

        const fts = await ensureFtsIndexForNonEmptyTable(
          writeConn,
          "Symbol",
          "symbol_search_text_v1",
        );
        assert.ok(
          fts.status === "created" ||
            fts.status === "exists" ||
            (fts.status === "failed" &&
              fts.error === "CREATE_FTS_INDEX returned false"),
          `unexpected Symbol FTS ensure result: ${JSON.stringify(fts)}`,
        );
        await assertReleaseScaleState(
          writeConn,
          `FTS ensure ${fts.status}`,
          repoId,
          expectedSymbols,
          mutatedPlaceholders,
          expectedRelationships,
        );

        const secondaryIndexes = await createSecondaryIndexes(writeConn);
        assertSecondaryIndexBuildReported(secondaryIndexes);
        await assertReleaseScaleState(
          writeConn,
          "secondary index build attempt",
          repoId,
          expectedSymbols,
          mutatedPlaceholders,
          expectedRelationships,
        );
      });
      activeConn = await getLadybugConn();

      const shadowBuild = await stageProviderFirstShadowBuild({
        repoId,
        generationId: "release-scale-integrity",
        activation: "shadowDb",
        requestedFormat: "csv",
        activeDbPath,
        repoRoot: root,
        repoConfigJson: "{}",
        rows,
      });
      assert.equal(shadowBuild.status, "staged");
      assert.equal(shadowBuild.shadowDb?.status, "loaded");
      assert.ok(shadowBuild.shadowDb?.secondaryIndexes);
      assertSecondaryIndexBuildReported(
        shadowBuild.shadowDb.secondaryIndexes,
      );
      const shadowDbPath = shadowBuild.shadowDb?.path ?? "";
      await assertReleaseScaleState(
        activeConn,
        "shadow persistence active DB",
        repoId,
        expectedSymbols,
        mutatedPlaceholders,
        expectedRelationships,
      );
      await assertReleaseScaleStateAtPath(
        shadowDbPath,
        "shadow persistence and secondary indexes",
        repoId,
        expectedSymbols,
        [],
        expectedRelationships,
      );

      const finalization = await finalizeProviderFirstShadowDb({
        activeConn,
        repoId,
        versionId: "release-scale-version",
        shadowDbPath,
      });
      assert.equal(finalization.status, "skipped");
      assert.match(finalization.reasons.join(" "), /above 2048/);
      await assertReleaseScaleStateAtPath(
        shadowDbPath,
        "shadow reset and finalization guard",
        repoId,
        expectedSymbols,
        [],
        expectedRelationships,
      );

      const activation = summarizeProviderFirstShadowActivationReadiness({
        shadowBuild: { ...shadowBuild, finalization },
        fallbackFiles: 0,
        graphDerivedStateReady: true,
        shadowContainsFinalizedGraph: false,
        finalizedGraphReasons: finalization.reasons,
      });
      assert.equal(activation.status, "skipped");
      await assertReleaseScaleState(
        activeConn,
        "shadow activation guard",
        repoId,
        expectedSymbols,
        mutatedPlaceholders,
        expectedRelationships,
      );

      await withWriteConn(async (writeConn) => {
        await dbExecDdl(writeConn, "CHECKPOINT");
      });
      await closeLadybugDb();
      activeConn = undefined;
      await initLadybugDb(activeDbPath);
      activeConn = await getLadybugConn();
      await assertReleaseScaleState(
        activeConn,
        "final index completion",
        repoId,
        expectedSymbols,
        mutatedPlaceholders,
        expectedRelationships,
      );
    } finally {
      await closeLadybugDb().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages provider rows as CSV artifacts for shadow bulk loading", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdl-provider-first-shadow-"));
    try {
      const emittedAt = "2026-05-25T12:00:00.000Z";
      const rows = providerFactsToGraphRows({
        indexedAt: emittedAt,
        facts: providerFactSet({
          externalSymbols: [
            {
              kind: "externalSymbol",
              repoId: "repo",
              generationId: "gen-1",
              providerType: "scip",
              providerId: "scip",
              emittedAt,
              symbolId: "symbol-2",
              providerSymbolId: "scip npm dep 1.0.0 dep/index.ts/api().",
              name: "api",
              symbolKind: "function",
              packageName: "dep",
              packageVersion: "1.0.0",
              documentation: [],
            },
          ],
          edges: [
            {
              kind: "edge",
              repoId: "repo",
              generationId: "gen-1",
              providerType: "scip",
              providerId: "scip",
              emittedAt,
              sourceSymbolId: "symbol-1",
              targetSymbolId: "symbol-2",
              edgeType: "call",
              resolution: "exact",
              confidence: 0.95,
              dedupeKey: "symbol-1:symbol-2:call:scip",
            },
          ],
        }),
      });
      rows.files[0]!.byteSize = 123;
      rows.symbols[0]!.visibility = "";
      rows.symbols[0]!.packageName = "";
      rows.symbols[0]!.placeholderKind = "";
      rows.symbols[0]!.placeholderTarget = "";

      const summary = await stageProviderFirstShadowBuild({
        repoId: "repo",
        generationId: "provider-first:test",
        activation: "shadowDb",
        requestedFormat: "parquet",
        activeDbPath: join(root, "active.lbug"),
        rows,
      });

      assert.equal(summary.status, "staged");
      assert.equal(summary.format, "csv");
      assert.equal(summary.requestedFormat, "parquet");
      assert.equal(summary.counts.files, 1);
      assert.equal(summary.counts.symbols, 1);
      assert.equal(summary.counts.externalSymbols, 1);
      assert.equal(summary.counts.edges, 1);
      assert.equal(summary.shadowDb?.status, "loaded");
      assert.equal(summary.shadowDb?.actualCounts?.repos, 1);
      assert.equal(summary.shadowDb?.actualCounts?.files, 1);
      assert.equal(summary.shadowDb?.actualCounts?.symbols, 2);
      assert.equal(summary.shadowDb?.actualCounts?.fileInRepo, 1);
      assert.equal(summary.shadowDb?.actualCounts?.symbolInFile, 1);
      assert.equal(summary.shadowDb?.actualCounts?.symbolInRepo, 2);
      assert.equal(summary.shadowDb?.actualCounts?.edges, 1);
      assert.deepEqual(
        summary.shadowDb?.expectedCounts,
        summary.shadowDb?.actualCounts,
      );
      assert.ok((summary.shadowDb?.secondaryIndexes.attempted ?? 0) > 0);
      if ((summary.shadowDb?.secondaryIndexes.failures.length ?? 0) > 0) {
        assert.match(
          summary.shadowDb?.reasons.join(" ") ?? "",
          /secondary index/i,
        );
        assert.doesNotMatch(
          summary.shadowDb?.reasons.join(" ") ?? "",
          /faileds/,
        );
      }
      assert.ok(existsSync(summary.shadowDb?.path ?? ""));
      assert.match(
        summary.stagingDir ?? "",
        /provider-first-test-[a-f0-9]{8}$/,
      );
      assert.match(summary.reasons.join(" "), /Parquet/i);

      const manifest = JSON.parse(
        readFileSync(summary.manifestPath ?? "", "utf8"),
      ) as {
        copyOrder: string[];
        counts: {
          files: number;
          symbols: number;
          externalSymbols: number;
          edges: number;
        };
        artifacts: Record<
          string,
          { columns: string[]; rows: number; targetTable: string }
        >;
      };
      assert.deepEqual(manifest.copyOrder, [
        "repos",
        "files",
        "symbols",
        "externalSymbols",
        "fileInRepo",
        "symbolInFile",
        "symbolInRepo",
        "edges",
      ]);
      assert.deepEqual(manifest.counts, summary.counts);
      assert.equal(manifest.artifacts.repos.rows, 1);
      assert.equal(manifest.artifacts.files.rows, 1);
      assert.equal(manifest.artifacts.edges.rows, 1);
      assert.equal(manifest.artifacts.edges.targetTable, "DEPENDS_ON");
      assert.deepEqual(manifest.artifacts.files.columns.slice(0, 4), [
        "fileId",
        "relPath",
        "contentHash",
        "language",
      ]);

      const filesCsv = readFileSync(
        join(summary.stagingDir ?? "", "files.csv"),
        "utf8",
      );
      assert.match(filesCsv, /^fileId,relPath,contentHash,language/m);
      assert.match(filesCsv, /src\/index\.ts/);
      assert.doesNotMatch(filesCsv.split("\n")[0] ?? "", /repoId/);
      assert.match(filesCsv, /,123,/);

      const symbolsCsv = readFileSync(
        join(summary.stagingDir ?? "", "symbols.csv"),
        "utf8",
      );
      assert.match(
        symbolsCsv,
        /""/,
        "explicit empty strings must be quoted instead of emitted as empty CSV fields",
      );
      assert.match(
        symbolsCsv,
        /\\N/,
        "nulls must use the configured COPY null sentinel",
      );

      const edgesCsv = readFileSync(
        join(summary.stagingDir ?? "", "depends-on.csv"),
        "utf8",
      );
      assert.match(edgesCsv, /^from,to,edgeType/m);
      assert.match(edgesCsv, /symbol-1,symbol-2,call/);

      const symbolInRepoCsv = readFileSync(
        join(summary.stagingDir ?? "", "symbol-in-repo.csv"),
        "utf8",
      );
      assert.match(symbolInRepoCsv, /^from,to/m);
      assert.match(symbolInRepoCsv, /symbol-1,repo/);
      assert.match(symbolInRepoCsv, /symbol-2,repo/);

      const shadowSymbols = await readShadowSymbolRows(
        summary.shadowDb?.path ?? "",
      );
      const sourceSymbol = shadowSymbols.find(
        (symbol) => symbol.symbolId === "symbol-1",
      );
      const externalSymbol = shadowSymbols.find(
        (symbol) => symbol.symbolId === "symbol-2",
      );
      assert.equal(sourceSymbol?.visibility, "");
      assert.equal(sourceSymbol?.packageName, "");
      assert.equal(sourceSymbol?.placeholderKind, "");
      assert.equal(sourceSymbol?.placeholderTarget, "");
      assert.equal(externalSymbol?.astFingerprint, "symbol-2");
      assert.equal(externalSymbol?.signatureJson, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips only shadow DB loading when bulk load fails after artifacts are written", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-shadow-load-fail-"),
    );
    try {
      const rows = providerFactsToGraphRows({
        indexedAt: "2026-05-25T12:00:00.000Z",
        facts: providerFactSet(),
      });
      (rows.symbols[0] as { summaryQuality: unknown }).summaryQuality =
        "not-a-number";

      const summary = await stageProviderFirstShadowBuild({
        repoId: "repo",
        generationId: "provider-first:test",
        activation: "shadowDb",
        requestedFormat: "csv",
        activeDbPath: join(root, "active.lbug"),
        rows,
      });

      assert.equal(summary.status, "staged");
      assert.ok(existsSync(summary.manifestPath ?? ""));
      assert.ok(existsSync(join(summary.stagingDir ?? "", "files.csv")));
      assert.equal(summary.shadowDb?.status, "skipped");
      assert.equal(summary.shadowDb?.actualCounts, undefined);
      assert.equal(summary.shadowDb?.expectedCounts.files, 1);
      assert.match(
        summary.shadowDb?.reasons.join(" ") ?? "",
        /bulk load failed/i,
      );
      assert.equal(existsSync(summary.shadowDb?.path ?? ""), false);

      const manifest = JSON.parse(
        readFileSync(summary.manifestPath ?? "", "utf8"),
      ) as {
        shadowDb: {
          status: string;
          actualCounts?: unknown;
          expectedCounts: { files: number };
        };
      };
      assert.equal(manifest.shadowDb.status, "skipped");
      assert.equal(manifest.shadowDb.actualCounts, undefined);
      assert.equal(manifest.shadowDb.expectedCounts.files, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads shadow CSV rows with quoted newlines", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-shadow-newline-"),
    );
    try {
      const rows = providerFactsToGraphRows({
        indexedAt: "2026-05-25T12:00:00.000Z",
        facts: providerFactSet(),
      });
      rows.symbols[0]!.name = "replayEventsAfter().(`{\n  event: string\n}`)";

      const summary = await stageProviderFirstShadowBuild({
        repoId: "repo",
        generationId: "provider-first:test",
        activation: "shadowDb",
        requestedFormat: "csv",
        activeDbPath: join(root, "active.lbug"),
        rows,
      });

      assert.equal(summary.status, "staged");
      assert.equal(summary.shadowDb?.status, "loaded");
      assert.equal(summary.shadowDb?.actualCounts.symbols, 1);

      const shadowSymbols = await readShadowSymbolRows(
        summary.shadowDb?.path ?? "",
      );
      assert.equal(shadowSymbols[0]?.name, rows.symbols[0]?.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads shadow CSV file paths with late quoted commas", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-shadow-comma-"),
    );
    try {
      const rows = providerFactsToGraphRows({
        indexedAt: "2026-05-25T12:00:00.000Z",
        facts: providerFactSet(),
      });
      const baseFile = rows.files[0]!;
      const extraFiles = Array.from({ length: 650 }, (_, index) => ({
        ...baseFile,
        fileId: `file-extra-${index}`,
        relPath:
          index === 624
            ? "obj/Debug/netstandard2.0/.NETStandard,Version=v2.0.AssemblyAttributes.cs"
            : `src/generated/file-${index}.cs`,
        contentHash: (index % 16).toString(16).repeat(64),
        byteSize: 100 + index,
      }));
      rows.files = [baseFile, ...extraFiles];

      const summary = await stageProviderFirstShadowBuild({
        repoId: "repo",
        generationId: "provider-first:test",
        activation: "shadowDb",
        requestedFormat: "csv",
        activeDbPath: join(root, "active.lbug"),
        rows,
      });

      assert.equal(summary.status, "staged");
      assert.equal(summary.shadowDb?.status, "loaded");
      assert.equal(summary.shadowDb?.actualCounts.files, rows.files.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips unsafe large shadow finalization before mutating Symbol rows", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-finalize-large-guard-"),
    );
    const activeDbPath = join(root, "active.lbug");
    const shadowDbPath = join(root, "shadow.lbug");
    const kuzu = await import("kuzu");
    const activeDb = new kuzu.Database(activeDbPath);
    const activeConn = new kuzu.Connection(activeDb);
    const shadowDb = new kuzu.Database(shadowDbPath);
    const shadowConn = new kuzu.Connection(shadowDb);
    let verifyDb: import("kuzu").Database | undefined;
    let verifyConn: import("kuzu").Connection | undefined;

    try {
      await createBaseSchema(activeConn);
      await createBaseSchema(shadowConn);
      await dbExec(
        shadowConn,
        `UNWIND $symbolIds AS symbolId
         CREATE (:Symbol {symbolId: symbolId})`,
        {
          symbolIds: Array.from(
            { length: 2_049 },
            (_, index) => `shadow-symbol-${index}`,
          ),
        },
      );
      await shadowConn.close();
      await shadowDb.close();

      const summary = await finalizeProviderFirstShadowDb({
        activeConn,
        repoId: "repo",
        versionId: "version-1",
        shadowDbPath,
      });

      assert.equal(summary.status, "skipped");
      assert.match(
        summary.reasons.join("\n"),
        /cannot safely reset 2049 COPY-loaded Symbol rows/,
      );

      verifyDb = new kuzu.Database(shadowDbPath);
      verifyConn = new kuzu.Connection(verifyDb);
      const counts = await queryAll<{
        physicalTotal: unknown;
        distinctTotal: unknown;
      }>(
        verifyConn,
        `MATCH (s:Symbol)
         RETURN count(s) AS physicalTotal,
                count(DISTINCT s.symbolId) AS distinctTotal`,
      );
      assert.equal(toNumber(counts[0]?.physicalTotal), 2_049);
      assert.equal(toNumber(counts[0]?.distinctTotal), 2_049);
    } finally {
      await activeConn.close().catch(() => {});
      await activeDb.close().catch(() => {});
      await shadowConn.close().catch(() => {});
      await shadowDb.close().catch(() => {});
      await verifyConn?.close().catch(() => {});
      await verifyDb?.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes shadow DBs when unresolved relationship endpoints contain newlines", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-finalize-newline-"),
    );
    const activeDbPath = join(root, "active.lbug");
    const shadowDbPath = join(root, "shadow.lbug");
    const kuzu = await import("kuzu");
    const activeDb = new kuzu.Database(activeDbPath);
    const activeConn = new kuzu.Connection(activeDb);
    const shadowDb = new kuzu.Database(shadowDbPath);
    const shadowConn = new kuzu.Connection(shadowDb);
    const repoId = "repo";
    const fileId = "file-1";
    const sourceSymbolId = "source-symbol";
    const unresolvedSymbolId =
      "unresolved:call:store.find_by_status(&Status::Active)\r\n.unwrap()";
    const versionId = "version-1";
    const now = "2026-05-26T00:00:00.000Z";

    try {
      await createBaseSchema(activeConn);
      await createBaseSchema(shadowConn);
      await seedRepoFileAndSourceSymbol(activeConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await seedRepoFileAndSourceSymbol(shadowConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await dbExec(
        activeConn,
        `MATCH (r:Repo {repoId: $repoId})
         MATCH (source:Symbol {symbolId: $sourceSymbolId})
         MERGE (target:Symbol {symbolId: $unresolvedSymbolId})
         SET target.repoId = $repoId,
             target.kind = 'unknown',
             target.name = $unresolvedSymbolId,
             target.exported = false,
             target.visibility = '',
             target.language = 'unknown',
             target.rangeStartLine = 0,
             target.rangeStartCol = 0,
             target.rangeEndLine = 0,
             target.rangeEndCol = 0,
             target.astFingerprint = $unresolvedSymbolId,
             target.signatureJson = '',
             target.summary = '',
             target.summaryQuality = 0.0,
             target.summarySource = 'unknown',
             target.invariantsJson = '',
             target.sideEffectsJson = '',
             target.roleTagsJson = '',
             target.searchText = $unresolvedSymbolId,
             target.updatedAt = $now,
             target.external = false,
             target.source = 'treesitter',
             target.packageName = '',
             target.packageVersion = '',
             target.scipSymbol = '',
             target.symbolStatus = 'unresolved',
             target.placeholderKind = 'call',
             target.placeholderTarget = $unresolvedSymbolId
         MERGE (target)-[:SYMBOL_IN_REPO]->(r)
         MERGE (source)-[d:DEPENDS_ON {edgeType: 'call'}]->(target)
         SET d.weight = 1.0,
             d.confidence = 0.7,
             d.resolution = 'heuristic',
             d.resolverId = 'test',
             d.resolutionPhase = 'pass2',
             d.provenance = 'unit-test',
             d.createdAt = $now
         MERGE (v:Version {versionId: $versionId})
         SET v.createdAt = $now,
             v.reason = 'test',
             v.prevVersionHash = null,
             v.versionHash = 'hash'
         MERGE (v)-[:VERSION_OF_REPO]->(r)`,
        {
          repoId,
          sourceSymbolId,
          unresolvedSymbolId,
          versionId,
          now,
        },
      );
      await shadowConn.close();
      await shadowDb.close();

      const summary = await finalizeProviderFirstShadowDb({
        activeConn,
        repoId,
        versionId,
        shadowDbPath,
      });

      assert.equal(summary.status, "finalized", summary.reasons.join("\n"));
      assert.equal(summary.copyMode, "bulkCsv");
      assert.equal(summary.actualCounts?.edges, 1);
      assert.equal(summary.actualCounts?.auxiliarySymbols, 1);
      assert.ok(
        summary.bulkLoad?.artifacts.some(
          (artifact) =>
            artifact.targetTable === "DEPENDS_ON" && artifact.rows === 0,
        ),
        "newline-bearing edge endpoints should be excluded from relationship COPY",
      );
    } finally {
      await activeConn.close().catch(() => {});
      await activeDb.close().catch(() => {});
      await shadowConn.close().catch(() => {});
      await shadowDb.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes shadow DBs when auxiliary provider metadata endpoints are file-backed", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-finalize-file-backed-aux-"),
    );
    const activeDbPath = join(root, "active.lbug");
    const shadowDbPath = join(root, "shadow.lbug");
    const kuzu = await import("kuzu");
    const activeDb = new kuzu.Database(activeDbPath);
    const activeConn = new kuzu.Connection(activeDb);
    const shadowDb = new kuzu.Database(shadowDbPath);
    const shadowConn = new kuzu.Connection(shadowDb);
    const repoId = "repo";
    const fileId = "file-1";
    const sourceSymbolId = "source-symbol";
    const metadataSymbolId = "provider-metadata-symbol";
    const versionId = "version-1";
    const now = "2026-05-26T00:00:00.000Z";

    try {
      await createBaseSchema(activeConn);
      await createBaseSchema(shadowConn);
      await seedRepoFileAndSourceSymbol(activeConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await seedRepoFileAndSourceSymbol(shadowConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      const seedMetadataEndpoint = `
        MATCH (r:Repo {repoId: $repoId})
        MATCH (f:File {fileId: $fileId})
        MERGE (target:Symbol {symbolId: $metadataSymbolId})
        SET target.repoId = $repoId,
            target.kind = 'method',
            target.name = 'default',
            target.exported = true,
            target.visibility = '',
            target.language = 'rust',
            target.rangeStartLine = 0,
            target.rangeStartCol = 0,
            target.rangeEndLine = 0,
            target.rangeEndCol = 0,
            target.astFingerprint = $metadataSymbolId,
            target.signatureJson = '',
            target.summary = '',
            target.summaryQuality = 0.0,
            target.summarySource = 'provider:scip',
            target.invariantsJson = '',
            target.sideEffectsJson = '',
            target.roleTagsJson = '',
            target.searchText = 'default',
            target.updatedAt = $now,
            target.external = false,
            target.source = 'scip',
            target.packageName = '',
            target.packageVersion = '',
            target.scipSymbol = 'rust-analyzer cargo pkg 1.0.0 src/lib/Foo#default().',
            target.symbolStatus = 'unresolved',
            target.placeholderKind = 'provider-metadata',
            target.placeholderTarget = 'rust-analyzer cargo pkg 1.0.0 src/lib/Foo#default().'
        MERGE (target)-[:SYMBOL_IN_REPO]->(r)
        MERGE (target)-[:SYMBOL_IN_FILE]->(f)`;
      await dbExec(activeConn, seedMetadataEndpoint, {
        repoId,
        fileId,
        metadataSymbolId,
        now,
      });
      await dbExec(shadowConn, seedMetadataEndpoint, {
        repoId,
        fileId,
        metadataSymbolId,
        now,
      });
      await dbExec(
        activeConn,
        `MATCH (r:Repo {repoId: $repoId})
         MERGE (v:Version {versionId: $versionId})
         SET v.createdAt = $now,
             v.reason = 'test',
             v.prevVersionHash = null,
             v.versionHash = 'hash'
         MERGE (v)-[:VERSION_OF_REPO]->(r)`,
        { repoId, versionId, now },
      );
      await shadowConn.close();
      await shadowDb.close();

      const summary = await finalizeProviderFirstShadowDb({
        activeConn,
        repoId,
        versionId,
        shadowDbPath,
      });

      assert.equal(summary.status, "finalized", summary.reasons.join("\n"));
      assert.equal(summary.actualCounts?.auxiliarySymbols, 1);
    } finally {
      await activeConn.close().catch(() => {});
      await activeDb.close().catch(() => {});
      await shadowConn.close().catch(() => {});
      await shadowDb.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes shadow DBs when staged provider metadata supersedes stale active real rows", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-finalize-stale-real-metadata-"),
    );
    const activeDbPath = join(root, "active.lbug");
    const shadowDbPath = join(root, "shadow.lbug");
    const kuzu = await import("kuzu");
    const activeDb = new kuzu.Database(activeDbPath);
    const activeConn = new kuzu.Connection(activeDb);
    const shadowDb = new kuzu.Database(shadowDbPath);
    const shadowConn = new kuzu.Connection(shadowDb);
    const repoId = "repo";
    const fileId = "file-1";
    const sourceSymbolId = "source-symbol";
    const metadataSymbolId = "provider-metadata-symbol";
    const metadataScipSymbol =
      "scip-go gomod pkg 1.0.0 `example.com/repo/pkg`/Type#default().";
    const versionId = "version-1";
    const now = "2026-05-26T00:00:00.000Z";

    try {
      await createBaseSchema(activeConn);
      await createBaseSchema(shadowConn);
      await seedRepoFileAndSourceSymbol(activeConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await seedRepoFileAndSourceSymbol(shadowConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await dbExec(
        activeConn,
        `MATCH (r:Repo {repoId: $repoId})
         MATCH (f:File {fileId: $fileId})
         MERGE (target:Symbol {symbolId: $metadataSymbolId})
         SET target.repoId = $repoId,
             target.kind = 'method',
             target.name = 'default',
             target.exported = true,
             target.visibility = '',
             target.language = 'go',
             target.rangeStartLine = 0,
             target.rangeStartCol = 0,
             target.rangeEndLine = 0,
             target.rangeEndCol = 0,
             target.astFingerprint = $metadataSymbolId,
             target.signatureJson = '',
             target.summary = '',
             target.summaryQuality = 0.0,
             target.summarySource = 'provider:scip',
             target.invariantsJson = '',
             target.sideEffectsJson = '',
             target.roleTagsJson = '',
             target.searchText = 'default',
             target.updatedAt = $now,
             target.external = false,
             target.source = 'scip',
             target.packageName = '',
             target.packageVersion = '',
             target.scipSymbol = $metadataScipSymbol,
             target.symbolStatus = 'real',
             target.placeholderKind = '',
             target.placeholderTarget = ''
         MERGE (target)-[:SYMBOL_IN_REPO]->(r)
         MERGE (target)-[:SYMBOL_IN_FILE]->(f)
         MERGE (v:Version {versionId: $versionId})
         SET v.createdAt = $now,
             v.reason = 'test',
             v.prevVersionHash = null,
             v.versionHash = 'hash'
         MERGE (v)-[:VERSION_OF_REPO]->(r)
         MERGE (sv:SymbolVersion {id: $metadataSymbolId + ':' + $versionId})
         SET sv.versionId = $versionId,
             sv.symbolId = $metadataSymbolId,
             sv.astFingerprint = $metadataSymbolId,
             sv.signatureJson = '',
             sv.summary = '',
             sv.invariantsJson = '',
             sv.sideEffectsJson = ''
         MERGE (m:Metrics {symbolId: $metadataSymbolId})
         SET m.fanIn = 0,
             m.fanOut = 0,
             m.churn30d = 0,
             m.testRefsJson = '[]',
             m.canonicalTestJson = '[]',
             m.pageRank = 0.0,
             m.kCore = 0,
             m.updatedAt = $now`,
        {
          repoId,
          fileId,
          metadataSymbolId,
          metadataScipSymbol,
          versionId,
          now,
        },
      );
      await dbExec(
        shadowConn,
        `MATCH (r:Repo {repoId: $repoId})
         MATCH (f:File {fileId: $fileId})
         MERGE (target:Symbol {symbolId: $metadataSymbolId})
         SET target.repoId = $repoId,
             target.kind = 'method',
             target.name = 'default',
             target.exported = true,
             target.visibility = '',
             target.language = 'go',
             target.rangeStartLine = 0,
             target.rangeStartCol = 0,
             target.rangeEndLine = 0,
             target.rangeEndCol = 0,
             target.astFingerprint = $metadataSymbolId,
             target.signatureJson = '',
             target.summary = '',
             target.summaryQuality = 0.0,
             target.summarySource = 'provider:scip',
             target.invariantsJson = '',
             target.sideEffectsJson = '',
             target.roleTagsJson = '',
             target.searchText = 'default',
             target.updatedAt = $now,
             target.external = false,
             target.source = 'scip',
             target.packageName = '',
             target.packageVersion = '',
             target.scipSymbol = $metadataScipSymbol,
             target.symbolStatus = 'unresolved',
             target.placeholderKind = 'provider-metadata',
             target.placeholderTarget = $metadataScipSymbol
         MERGE (target)-[:SYMBOL_IN_REPO]->(r)
         MERGE (target)-[:SYMBOL_IN_FILE]->(f)`,
        {
          repoId,
          fileId,
          metadataSymbolId,
          metadataScipSymbol,
          now,
        },
      );
      await shadowConn.close();
      await shadowDb.close();

      const summary = await finalizeProviderFirstShadowDb({
        activeConn,
        repoId,
        versionId,
        shadowDbPath,
      });

      assert.equal(summary.status, "finalized", summary.reasons.join("\n"));
      assert.equal(summary.expectedCounts?.symbols, 1);
      assert.equal(summary.expectedCounts?.symbolVersions, 0);
      assert.equal(summary.expectedCounts?.metrics, 0);

      const finalizedDb = new kuzu.Database(shadowDbPath);
      const finalizedConn = new kuzu.Connection(finalizedDb);
      try {
        const staleRows = await queryAll<{ count: unknown }>(
          finalizedConn,
          `MATCH (sv:SymbolVersion {symbolId: $metadataSymbolId})
           RETURN count(sv) AS count`,
          { metadataSymbolId },
        );
        assert.equal(Number(staleRows[0]?.count ?? 0), 0);
      } finally {
        await finalizedConn.close().catch(() => {});
        await finalizedDb.close().catch(() => {});
      }
    } finally {
      await activeConn.close().catch(() => {});
      await activeDb.close().catch(() => {});
      await shadowConn.close().catch(() => {});
      await shadowDb.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes shadow DBs with semantic provenance and normalized provider call provenance", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-finalize-provenance-"),
    );
    const activeDbPath = join(root, "active.lbug");
    const shadowDbPath = join(root, "shadow.lbug");
    const kuzu = await import("kuzu");
    const activeDb = new kuzu.Database(activeDbPath);
    const activeConn = new kuzu.Connection(activeDb);
    const shadowDb = new kuzu.Database(shadowDbPath);
    const shadowConn = new kuzu.Connection(shadowDb);
    const repoId = "repo";
    const fileId = "file-1";
    const sourceSymbolId = "source-symbol";
    const targetSymbolId = "target-symbol";
    const versionId = "version-1";
    const runId = "provider-first-run-1";
    const diagnosticId = "provider-first-diag-1";
    const now = "2026-05-26T00:00:00.000Z";

    try {
      await createBaseSchema(activeConn);
      await createBaseSchema(shadowConn);
      await seedRepoFileAndSourceSymbol(activeConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await seedRepoFileAndSourceSymbol(shadowConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await dbExec(
        activeConn,
        `MATCH (r:Repo {repoId: $repoId})
         MATCH (f:File {fileId: $fileId})
         MATCH (source:Symbol {symbolId: $sourceSymbolId})
         MERGE (target:Symbol {symbolId: $targetSymbolId})
         SET target.repoId = $repoId,
             target.kind = 'function',
             target.name = 'target',
             target.exported = true,
             target.visibility = '',
             target.language = 'typescript',
             target.rangeStartLine = 1,
             target.rangeStartCol = 0,
             target.rangeEndLine = 1,
             target.rangeEndCol = 6,
             target.astFingerprint = $targetSymbolId,
             target.signatureJson = '',
             target.summary = '',
             target.summaryQuality = 0.0,
             target.summarySource = 'provider:scip',
             target.invariantsJson = '',
             target.sideEffectsJson = '',
             target.roleTagsJson = '',
             target.searchText = 'target',
             target.updatedAt = $now,
             target.external = false,
             target.source = 'scip',
             target.packageName = '',
             target.packageVersion = '',
             target.scipSymbol = 'scip local target().',
             target.symbolStatus = 'real',
             target.placeholderKind = '',
             target.placeholderTarget = ''
         MERGE (target)-[:SYMBOL_IN_REPO]->(r)
         MERGE (target)-[:SYMBOL_IN_FILE]->(f)
         MERGE (source)-[d:DEPENDS_ON {edgeType: 'call'}]->(target)
         SET d.weight = 1.0,
             d.confidence = 0.95,
             d.resolution = 'exact',
             d.resolverId = 'provider-first:scip-io',
             d.resolutionPhase = 'provider-first',
             d.provenance = 'legacy-provider-call',
             d.createdAt = $now
         MERGE (v:Version {versionId: $versionId})
         SET v.createdAt = $now,
             v.reason = 'test',
             v.prevVersionHash = null,
             v.versionHash = 'hash'
         MERGE (v)-[:VERSION_OF_REPO]->(r)
         MERGE (run:SemanticProviderRun {runId: $runId})
         SET run.repoId = $repoId,
             run.providerType = 'scip',
             run.providerId = 'scip-io',
             run.providerVersion = '0.1.8',
             run.languagesJson = '["typescript"]',
             run.sourceIndexPath = 'index.scip',
             run.sourceHash = 'source-hash',
             run.cacheKey = 'cache-key',
             run.configHash = 'config-hash',
             run.ledgerVersion = $versionId,
             run.status = 'completed',
             run.startedAt = $now,
             run.finishedAt = $now,
             run.documentsProcessed = 1,
             run.symbolsMatched = 2,
             run.edgesCreated = 1,
             run.edgesUpgraded = 0,
             run.edgesReplaced = 0,
             run.edgesSkipped = 1,
             run.diagnosticsCount = 1,
             run.precisionScore = 0.95,
             run.cacheHit = false,
             run.canAffectPass2 = true,
             run.selected = true,
             run.metadataJson = '{"coverage":{"files":1}}',
             run.error = null
         MERGE (diag:SemanticDiagnostic {id: $diagnosticId})
         SET diag.repoId = $repoId,
             diag.runId = $runId,
             diag.providerType = 'scip',
             diag.providerId = 'scip-io',
             diag.languageId = 'typescript',
             diag.sourcePath = 'src/example.ts',
             diag.severity = 'warning',
             diag.message = 'call proof skipped',
             diag.code = 'CALL_PROOF',
             diag.rangeJson = '{"startLine":1}',
             diag.createdAt = $now`,
        {
          repoId,
          fileId,
          sourceSymbolId,
          targetSymbolId,
          versionId,
          runId,
          diagnosticId,
          now,
        },
      );
      await dbExec(
        shadowConn,
        `MATCH (r:Repo {repoId: $repoId})
         MATCH (f:File {fileId: $fileId})
         MERGE (target:Symbol {symbolId: $targetSymbolId})
         SET target.repoId = $repoId,
             target.kind = 'function',
             target.name = 'target',
             target.exported = true,
             target.visibility = '',
             target.language = 'typescript',
             target.rangeStartLine = 1,
             target.rangeStartCol = 0,
             target.rangeEndLine = 1,
             target.rangeEndCol = 6,
             target.astFingerprint = $targetSymbolId,
             target.signatureJson = '',
             target.summary = '',
             target.summaryQuality = 0.0,
             target.summarySource = 'provider:scip',
             target.invariantsJson = '',
             target.sideEffectsJson = '',
             target.roleTagsJson = '',
             target.searchText = 'target',
             target.updatedAt = $now,
             target.external = false,
             target.source = 'scip',
             target.packageName = '',
             target.packageVersion = '',
             target.scipSymbol = 'scip local target().',
             target.symbolStatus = 'real',
             target.placeholderKind = '',
             target.placeholderTarget = ''
         MERGE (target)-[:SYMBOL_IN_REPO]->(r)
         MERGE (target)-[:SYMBOL_IN_FILE]->(f)`,
        {
          repoId,
          fileId,
          targetSymbolId,
          now,
        },
      );
      await shadowConn.close();
      await shadowDb.close();

      const summary = await finalizeProviderFirstShadowDb({
        activeConn,
        repoId,
        versionId,
        shadowDbPath,
      });

      assert.equal(summary.status, "finalized", summary.reasons.join("\n"));

      const finalizedDb = new kuzu.Database(shadowDbPath);
      const finalizedConn = new kuzu.Connection(finalizedDb);
      try {
        const edgeRows = await queryAll<{ provenance: string | null }>(
          finalizedConn,
          `MATCH (:Symbol {symbolId: $sourceSymbolId})-[d:DEPENDS_ON {edgeType: 'call'}]->(:Symbol {symbolId: $targetSymbolId})
           RETURN d.provenance AS provenance`,
          { sourceSymbolId, targetSymbolId },
        );
        assert.equal(edgeRows.length, 1);
        const provenance = JSON.parse(edgeRows[0]?.provenance ?? "{}") as {
          dedupeKey?: unknown;
          repaired?: unknown;
          previousProvenance?: unknown;
        };
        assert.equal(typeof provenance.dedupeKey, "string");
        assert.equal(provenance.repaired, true);
        assert.equal(provenance.previousProvenance, "legacy-provider-call");

        const runRows = await queryAll<{
          metadataJson: string | null;
          diagnosticsCount: unknown;
        }>(
          finalizedConn,
          `MATCH (run:SemanticProviderRun {runId: $runId})
           RETURN run.metadataJson AS metadataJson,
                  run.diagnosticsCount AS diagnosticsCount`,
          { runId },
        );
        assert.equal(runRows.length, 1);
        assert.equal(runRows[0]?.metadataJson, '{"coverage":{"files":1}}');

        const diagnosticRows = await queryAll<{ message: string | null }>(
          finalizedConn,
          `MATCH (diag:SemanticDiagnostic {id: $diagnosticId})
           RETURN diag.message AS message`,
          { diagnosticId },
        );
        assert.deepEqual(
          diagnosticRows.map((row) => row.message),
          ["call proof skipped"],
        );
      } finally {
        await finalizedConn.close().catch(() => {});
        await finalizedDb.close().catch(() => {});
      }
    } finally {
      await activeConn.close().catch(() => {});
      await activeDb.close().catch(() => {});
      await shadowConn.close().catch(() => {});
      await shadowDb.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes shadow DBs when relationship properties require CSV quoting", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-finalize-edge-property-"),
    );
    const activeDbPath = join(root, "active.lbug");
    const shadowDbPath = join(root, "shadow.lbug");
    const kuzu = await import("kuzu");
    const activeDb = new kuzu.Database(activeDbPath);
    const activeConn = new kuzu.Connection(activeDb);
    const shadowDb = new kuzu.Database(shadowDbPath);
    const shadowConn = new kuzu.Connection(shadowDb);
    const repoId = "repo";
    const fileId = "file-1";
    const sourceSymbolId = "source-symbol";
    const targetSymbolId = "target-symbol";
    const versionId = "version-1";
    const now = "2026-05-26T00:00:00.000Z";

    try {
      await createBaseSchema(activeConn);
      await createBaseSchema(shadowConn);
      await seedRepoFileAndSourceSymbol(activeConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await seedRepoFileAndSourceSymbol(shadowConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await dbExec(
        activeConn,
        `MATCH (r:Repo {repoId: $repoId})
         MATCH (source:Symbol {symbolId: $sourceSymbolId})
         MERGE (target:Symbol {symbolId: $targetSymbolId})
         SET target.repoId = $repoId,
             target.kind = 'function',
             target.name = 'target',
             target.exported = true,
             target.visibility = '',
             target.language = 'cpp',
             target.rangeStartLine = 1,
             target.rangeStartCol = 0,
             target.rangeEndLine = 1,
             target.rangeEndCol = 1,
             target.astFingerprint = $targetSymbolId,
             target.signatureJson = '',
             target.summary = '',
             target.summaryQuality = 0.0,
             target.summarySource = 'unknown',
             target.invariantsJson = '',
             target.sideEffectsJson = '',
             target.roleTagsJson = '',
             target.searchText = 'target',
             target.updatedAt = $now,
             target.external = false,
             target.source = 'treesitter',
             target.packageName = '',
             target.packageVersion = '',
             target.scipSymbol = '',
             target.symbolStatus = 'real',
             target.placeholderKind = null,
             target.placeholderTarget = null
         MERGE (target)-[:SYMBOL_IN_REPO]->(r)
         MERGE (source)-[d:DEPENDS_ON {edgeType: 'call'}]->(target)
         SET d.weight = 1.0,
             d.confidence = 0.78,
             d.resolution = 'same-directory',
             d.resolverId = 'pass2-cpp',
             d.resolutionPhase = 'pass2',
             d.provenance = 'cpp-call:Accesses[MemAccessInfo(Ptr, false)].insert',
             d.createdAt = $now
         MERGE (v:Version {versionId: $versionId})
         SET v.createdAt = $now,
             v.reason = 'test',
             v.prevVersionHash = null,
             v.versionHash = 'hash'
         MERGE (v)-[:VERSION_OF_REPO]->(r)`,
        {
          repoId,
          sourceSymbolId,
          targetSymbolId,
          versionId,
          now,
        },
      );
      await dbExec(
        shadowConn,
        `MATCH (r:Repo {repoId: $repoId})
         MERGE (target:Symbol {symbolId: $targetSymbolId})
         SET target.repoId = $repoId,
             target.kind = 'function',
             target.name = 'target',
             target.exported = true,
             target.visibility = '',
             target.language = 'cpp',
             target.rangeStartLine = 1,
             target.rangeStartCol = 0,
             target.rangeEndLine = 1,
             target.rangeEndCol = 1,
             target.astFingerprint = $targetSymbolId,
             target.signatureJson = '',
             target.summary = '',
             target.summaryQuality = 0.0,
             target.summarySource = 'unknown',
             target.invariantsJson = '',
             target.sideEffectsJson = '',
             target.roleTagsJson = '',
             target.searchText = 'target',
             target.updatedAt = $now,
             target.external = false,
             target.source = 'treesitter',
             target.packageName = '',
             target.packageVersion = '',
             target.scipSymbol = '',
             target.symbolStatus = 'real',
             target.placeholderKind = null,
             target.placeholderTarget = null
         MERGE (target)-[:SYMBOL_IN_REPO]->(r)`,
        {
          repoId,
          targetSymbolId,
          now,
        },
      );
      await shadowConn.close();
      await shadowDb.close();

      const summary = await finalizeProviderFirstShadowDb({
        activeConn,
        repoId,
        versionId,
        shadowDbPath,
      });

      assert.equal(summary.status, "finalized", summary.reasons.join("\n"));
      assert.equal(summary.copyMode, "bulkCsv");
      assert.equal(summary.actualCounts?.edges, 1);
      assert.ok(
        summary.bulkLoad?.artifacts.some(
          (artifact) =>
            artifact.targetTable === "DEPENDS_ON" && artifact.rows === 0,
        ),
        "comma-bearing edge properties should be excluded from relationship COPY",
      );
    } finally {
      await activeConn.close().catch(() => {});
      await activeDb.close().catch(() => {});
      await shadowConn.close().catch(() => {});
      await shadowDb.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes shadow DBs when unresolved relationship endpoints contain quotes", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-finalize-quoted-endpoint-"),
    );
    const activeDbPath = join(root, "active.lbug");
    const shadowDbPath = join(root, "shadow.lbug");
    const kuzu = await import("kuzu");
    const activeDb = new kuzu.Database(activeDbPath);
    const activeConn = new kuzu.Connection(activeDb);
    const shadowDb = new kuzu.Database(shadowDbPath);
    const shadowConn = new kuzu.Connection(shadowDb);
    const repoId = "repo";
    const fileId = "file-1";
    const sourceSymbolId = "source-symbol";
    const unresolvedSymbolId = 'unresolved:call:"Division by zero".into';
    const versionId = "version-1";
    const now = "2026-05-26T00:00:00.000Z";

    try {
      await createBaseSchema(activeConn);
      await createBaseSchema(shadowConn);
      await seedRepoFileAndSourceSymbol(activeConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await seedRepoFileAndSourceSymbol(shadowConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await dbExec(
        activeConn,
        `MATCH (r:Repo {repoId: $repoId})
         MATCH (source:Symbol {symbolId: $sourceSymbolId})
         MERGE (target:Symbol {symbolId: $unresolvedSymbolId})
         SET target.repoId = $repoId,
             target.kind = 'unknown',
             target.name = $unresolvedSymbolId,
             target.exported = false,
             target.visibility = '',
             target.language = 'unknown',
             target.rangeStartLine = 0,
             target.rangeStartCol = 0,
             target.rangeEndLine = 0,
             target.rangeEndCol = 0,
             target.astFingerprint = $unresolvedSymbolId,
             target.signatureJson = '',
             target.summary = '',
             target.summaryQuality = 0.0,
             target.summarySource = 'unknown',
             target.invariantsJson = '',
             target.sideEffectsJson = '',
             target.roleTagsJson = '',
             target.searchText = $unresolvedSymbolId,
             target.updatedAt = $now,
             target.external = false,
             target.source = 'treesitter',
             target.packageName = '',
             target.packageVersion = '',
             target.scipSymbol = '',
             target.symbolStatus = 'unresolved',
             target.placeholderKind = 'call',
             target.placeholderTarget = $unresolvedSymbolId
         MERGE (target)-[:SYMBOL_IN_REPO]->(r)
         MERGE (source)-[d:DEPENDS_ON {edgeType: 'call'}]->(target)
         SET d.weight = 1.0,
             d.confidence = 0.7,
             d.resolution = 'heuristic',
             d.resolverId = 'test',
             d.resolutionPhase = 'pass2',
             d.provenance = 'unit-test',
             d.createdAt = $now
         MERGE (v:Version {versionId: $versionId})
         SET v.createdAt = $now,
             v.reason = 'test',
             v.prevVersionHash = null,
             v.versionHash = 'hash'
         MERGE (v)-[:VERSION_OF_REPO]->(r)`,
        {
          repoId,
          sourceSymbolId,
          unresolvedSymbolId,
          versionId,
          now,
        },
      );
      await shadowConn.close();
      await shadowDb.close();

      const summary = await finalizeProviderFirstShadowDb({
        activeConn,
        repoId,
        versionId,
        shadowDbPath,
      });

      assert.equal(summary.status, "finalized", summary.reasons.join("\n"));
      assert.equal(summary.actualCounts?.edges, 1);
      assert.equal(summary.actualCounts?.auxiliarySymbols, 1);
      assert.ok(
        summary.bulkLoad?.artifacts.some(
          (artifact) =>
            artifact.targetTable === "DEPENDS_ON" && artifact.rows === 0,
        ),
        "quoted edge endpoints should be excluded from relationship COPY",
      );
    } finally {
      await activeConn.close().catch(() => {});
      await activeDb.close().catch(() => {});
      await shadowConn.close().catch(() => {});
      await shadowDb.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes shadow DBs when shadow-cluster members contain unsafe endpoints", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-finalize-shadow-cluster-"),
    );
    const activeDbPath = join(root, "active.lbug");
    const shadowDbPath = join(root, "shadow.lbug");
    const kuzu = await import("kuzu");
    const activeDb = new kuzu.Database(activeDbPath);
    const activeConn = new kuzu.Connection(activeDb);
    const shadowDb = new kuzu.Database(shadowDbPath);
    const shadowConn = new kuzu.Connection(shadowDb);
    const repoId = "repo";
    const fileId = "file-1";
    const sourceSymbolId = "source-symbol";
    const unresolvedSymbolId =
      "unresolved:call:store.find_by_status(&Status::Active)\r\n.unwrap()";
    const clusterId = "repo:cluster:1";
    const processId = "repo:process:1";
    const shadowClusterId = "repo:louvain:1";
    const versionId = "version-1";
    const now = "2026-05-26T00:00:00.000Z";

    try {
      await createBaseSchema(activeConn);
      await createBaseSchema(shadowConn);
      await seedRepoFileAndSourceSymbol(activeConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await seedRepoFileAndSourceSymbol(shadowConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await dbExec(
        activeConn,
        `MATCH (r:Repo {repoId: $repoId})
         MERGE (target:Symbol {symbolId: $unresolvedSymbolId})
         SET target.repoId = $repoId,
             target.kind = 'unknown',
             target.name = $unresolvedSymbolId,
             target.exported = false,
             target.visibility = '',
             target.language = 'unknown',
             target.rangeStartLine = 0,
             target.rangeStartCol = 0,
             target.rangeEndLine = 0,
             target.rangeEndCol = 0,
             target.astFingerprint = $unresolvedSymbolId,
             target.signatureJson = '',
             target.summary = '',
             target.summaryQuality = 0.0,
             target.summarySource = 'unknown',
             target.invariantsJson = '',
             target.sideEffectsJson = '',
             target.roleTagsJson = '',
             target.searchText = $unresolvedSymbolId,
             target.updatedAt = $now,
             target.external = false,
             target.source = 'treesitter',
             target.packageName = '',
             target.packageVersion = '',
             target.scipSymbol = '',
             target.symbolStatus = 'unresolved',
             target.placeholderKind = 'call',
             target.placeholderTarget = $unresolvedSymbolId
         MERGE (target)-[:SYMBOL_IN_REPO]->(r)
         MERGE (cluster:Cluster {clusterId: $clusterId})
         SET cluster.repoId = $repoId,
             cluster.label = 'fallback placeholders',
             cluster.symbolCount = 1,
             cluster.cohesionScore = 0.7,
             cluster.versionId = $versionId,
             cluster.createdAt = $now,
             cluster.searchText = 'fallback placeholders'
         MERGE (cluster)-[:CLUSTER_IN_REPO]->(r)
         MERGE (target)-[clusterMember:BELONGS_TO_CLUSTER]->(cluster)
         SET clusterMember.membershipScore = 0.9
         MERGE (process:Process {processId: $processId})
         SET process.repoId = $repoId,
             process.entrySymbolId = $unresolvedSymbolId,
             process.label = 'fallback process',
             process.depth = 1,
             process.versionId = $versionId,
             process.createdAt = $now,
             process.searchText = 'fallback process'
         MERGE (process)-[:PROCESS_IN_REPO]->(r)
         MERGE (target)-[step:PARTICIPATES_IN]->(process)
         SET step.stepOrder = 1,
             step.role = 'caller'
         MERGE (shadowCluster:ShadowCluster {shadowClusterId: $shadowClusterId})
         SET shadowCluster.repoId = $repoId,
             shadowCluster.algorithm = 'louvain',
             shadowCluster.label = 'fallback placeholders',
             shadowCluster.symbolCount = 1,
             shadowCluster.modularity = 0.42,
             shadowCluster.versionId = $versionId,
             shadowCluster.createdAt = $now
         MERGE (shadowCluster)-[:SHADOW_CLUSTER_IN_REPO]->(r)
         MERGE (target)-[member:BELONGS_TO_SHADOW_CLUSTER]->(shadowCluster)
         SET member.membershipScore = 1.0
         MERGE (v:Version {versionId: $versionId})
         SET v.createdAt = $now,
             v.reason = 'test',
             v.prevVersionHash = null,
             v.versionHash = 'hash'
         MERGE (v)-[:VERSION_OF_REPO]->(r)`,
        {
          repoId,
          unresolvedSymbolId,
          clusterId,
          processId,
          shadowClusterId,
          versionId,
          now,
        },
      );
      await shadowConn.close();
      await shadowDb.close();

      const summary = await finalizeProviderFirstShadowDb({
        activeConn,
        repoId,
        versionId,
        shadowDbPath,
      });

      assert.equal(summary.status, "finalized", summary.reasons.join("\n"));
      assert.equal(summary.actualCounts?.clusters, 1);
      assert.equal(summary.actualCounts?.clusterMembers, 1);
      assert.equal(summary.actualCounts?.processes, 1);
      assert.equal(summary.actualCounts?.processSteps, 1);
      assert.equal(summary.actualCounts?.shadowClusters, 1);
      assert.equal(summary.actualCounts?.shadowClusterMembers, 1);
      assert.equal(summary.actualCounts?.auxiliarySymbols, 1);
      assert.ok(
        summary.bulkLoad?.artifacts.some(
          (artifact) =>
            artifact.targetTable === "BELONGS_TO_CLUSTER" &&
            artifact.rows === 0,
        ),
        "unsafe cluster member endpoints should be excluded from relationship COPY",
      );
      assert.ok(
        summary.bulkLoad?.artifacts.some(
          (artifact) =>
            artifact.targetTable === "PARTICIPATES_IN" && artifact.rows === 0,
        ),
        "unsafe process step endpoints should be excluded from relationship COPY",
      );
      assert.ok(
        summary.bulkLoad?.artifacts.some(
          (artifact) =>
            artifact.targetTable === "BELONGS_TO_SHADOW_CLUSTER" &&
            artifact.rows === 0,
        ),
        "unsafe shadow-cluster member endpoints should be excluded from relationship COPY",
      );
    } finally {
      await activeConn.close().catch(() => {});
      await activeDb.close().catch(() => {});
      await shadowConn.close().catch(() => {});
      await shadowDb.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes shadow DBs when edge target placeholders are not repo-linked", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-finalize-missing-target-"),
    );
    const activeDbPath = join(root, "active.lbug");
    const shadowDbPath = join(root, "shadow.lbug");
    const kuzu = await import("kuzu");
    const activeDb = new kuzu.Database(activeDbPath);
    const activeConn = new kuzu.Connection(activeDb);
    const shadowDb = new kuzu.Database(shadowDbPath);
    const shadowConn = new kuzu.Connection(shadowDb);
    const repoId = "repo";
    const fileId = "file-1";
    const sourceSymbolId = "source-symbol";
    const unresolvedSymbolId = 'unresolved:call:"Division by zero".into';
    const versionId = "version-1";
    const now = "2026-05-26T00:00:00.000Z";

    try {
      await createBaseSchema(activeConn);
      await createBaseSchema(shadowConn);
      await seedRepoFileAndSourceSymbol(activeConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await seedRepoFileAndSourceSymbol(shadowConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await dbExec(
        activeConn,
        `MATCH (r:Repo {repoId: $repoId})
         MATCH (source:Symbol {symbolId: $sourceSymbolId})
         MERGE (target:Symbol {symbolId: $unresolvedSymbolId})
         SET target.repoId = $repoId,
             target.kind = 'unknown',
             target.name = $unresolvedSymbolId,
             target.exported = false,
             target.visibility = '',
             target.language = 'unknown',
             target.rangeStartLine = 0,
             target.rangeStartCol = 0,
             target.rangeEndLine = 0,
             target.rangeEndCol = 0,
             target.astFingerprint = $unresolvedSymbolId,
             target.signatureJson = '',
             target.summary = '',
             target.summaryQuality = 0.0,
             target.summarySource = 'unknown',
             target.invariantsJson = '',
             target.sideEffectsJson = '',
             target.roleTagsJson = '',
             target.searchText = $unresolvedSymbolId,
             target.updatedAt = $now,
             target.external = false,
             target.source = 'treesitter',
             target.packageName = '',
             target.packageVersion = '',
             target.scipSymbol = '',
             target.symbolStatus = 'unresolved',
             target.placeholderKind = 'call',
             target.placeholderTarget = $unresolvedSymbolId
         MERGE (source)-[d:DEPENDS_ON {edgeType: 'call'}]->(target)
         SET d.weight = 1.0,
             d.confidence = 0.7,
             d.resolution = 'heuristic',
             d.resolverId = 'test',
             d.resolutionPhase = 'pass2',
             d.provenance = 'unit-test',
             d.createdAt = $now
         MERGE (v:Version {versionId: $versionId})
         SET v.createdAt = $now,
             v.reason = 'test',
             v.prevVersionHash = null,
             v.versionHash = 'hash'
         MERGE (v)-[:VERSION_OF_REPO]->(r)`,
        {
          repoId,
          sourceSymbolId,
          unresolvedSymbolId,
          versionId,
          now,
        },
      );
      await shadowConn.close();
      await shadowDb.close();

      const summary = await finalizeProviderFirstShadowDb({
        activeConn,
        repoId,
        versionId,
        shadowDbPath,
      });

      assert.equal(summary.status, "finalized", summary.reasons.join("\n"));
      assert.equal(summary.actualCounts?.edges, 1);
      assert.equal(
        summary.actualCounts?.auxiliarySymbols,
        0,
        "shadow parity should not add repo links missing from the active graph",
      );
    } finally {
      await activeConn.close().catch(() => {});
      await activeDb.close().catch(() => {});
      await shadowConn.close().catch(() => {});
      await shadowDb.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes shadow DBs when active edge sources are absent from shadow", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-finalize-missing-source-"),
    );
    const activeDbPath = join(root, "active.lbug");
    const shadowDbPath = join(root, "shadow.lbug");
    const kuzu = await import("kuzu");
    const activeDb = new kuzu.Database(activeDbPath);
    const activeConn = new kuzu.Connection(activeDb);
    const shadowDb = new kuzu.Database(shadowDbPath);
    const shadowConn = new kuzu.Connection(shadowDb);
    const repoId = "repo";
    const fileId = "file-1";
    const sourceSymbolId = "fallback-source";
    const targetSymbolId = "unlinked-target";
    const versionId = "version-1";
    const now = "2026-05-26T00:00:00.000Z";

    try {
      await createBaseSchema(activeConn);
      await createBaseSchema(shadowConn);
      await seedRepoFileAndSourceSymbol(activeConn, {
        repoId,
        fileId,
        sourceSymbolId,
        now,
      });
      await dbExec(
        shadowConn,
        `MERGE (r:Repo {repoId: $repoId})
         SET r.rootPath = "",
             r.configJson = "{}",
             r.createdAt = $now
         MERGE (f:File {fileId: $fileId})
         SET f.relPath = "src/index.ts",
             f.contentHash = "hash",
             f.language = "typescript",
             f.byteSize = 10,
             f.lastIndexedAt = $now,
             f.directory = "src"
         MERGE (f)-[:FILE_IN_REPO]->(r)`,
        { repoId, fileId, now },
      );
      await dbExec(
        activeConn,
        `MATCH (r:Repo {repoId: $repoId})
         MATCH (source:Symbol {symbolId: $sourceSymbolId})
         MERGE (target:Symbol {symbolId: $targetSymbolId})
         SET target.repoId = $repoId,
             target.kind = "function",
             target.name = "target",
             target.exported = false,
             target.visibility = "",
             target.language = "typescript",
             target.rangeStartLine = 5,
             target.rangeStartCol = 0,
             target.rangeEndLine = 6,
             target.rangeEndCol = 1,
             target.astFingerprint = $targetSymbolId,
             target.signatureJson = "",
             target.summary = "",
             target.summaryQuality = 0.0,
             target.summarySource = "unknown",
             target.invariantsJson = "",
             target.sideEffectsJson = "",
             target.roleTagsJson = "",
             target.searchText = "target",
             target.updatedAt = $now,
             target.external = false,
             target.source = "treesitter",
             target.packageName = "",
             target.packageVersion = "",
             target.scipSymbol = "",
             target.symbolStatus = "real",
             target.placeholderKind = "",
             target.placeholderTarget = ""
         MERGE (source)-[d:DEPENDS_ON {edgeType: "call"}]->(target)
         SET d.weight = 1.0,
             d.confidence = 0.9,
             d.resolution = "provider-first-partial",
             d.resolverId = "test",
             d.resolutionPhase = "pass2",
             d.provenance = "unit-test",
             d.createdAt = $now
         MERGE (v:Version {versionId: $versionId})
         SET v.createdAt = $now,
             v.reason = "test",
             v.prevVersionHash = null,
             v.versionHash = "hash"
         MERGE (v)-[:VERSION_OF_REPO]->(r)`,
        {
          repoId,
          sourceSymbolId,
          targetSymbolId,
          versionId,
          now,
        },
      );
      await shadowConn.close();
      await shadowDb.close();

      const summary = await finalizeProviderFirstShadowDb({
        activeConn,
        repoId,
        versionId,
        shadowDbPath,
      });

      assert.equal(summary.status, "finalized", summary.reasons.join("\n"));
      assert.equal(summary.actualCounts?.symbols, 1);
      assert.equal(summary.actualCounts?.edges, 1);

      const finalizedDb = new kuzu.Database(shadowDbPath);
      const finalizedConn = new kuzu.Connection(finalizedDb);
      try {
        const edgeRows = await queryAll<{ count: unknown }>(
          finalizedConn,
          `MATCH (:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(source:Symbol {symbolId: $sourceSymbolId})-[d:DEPENDS_ON]->(:Symbol {symbolId: $targetSymbolId})
           RETURN count(d) AS count`,
          { repoId, sourceSymbolId, targetSymbolId },
        );
        assert.equal(Number(edgeRows[0]?.count ?? 0), 1);
      } finally {
        await finalizedConn.close().catch(() => {});
        await finalizedDb.close().catch(() => {});
      }
    } finally {
      await activeConn.close().catch(() => {});
      await activeDb.close().catch(() => {});
      await shadowConn.close().catch(() => {});
      await shadowDb.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes shadow DBs when copied derived relationships point at fallback-only real symbols", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-finalize-derived-symbol-"),
    );
    const activeDbPath = join(root, "active.lbug");
    const shadowDbPath = join(root, "shadow.lbug");
    const kuzu = await import("kuzu");
    const activeDb = new kuzu.Database(activeDbPath);
    const activeConn = new kuzu.Connection(activeDb);
    const shadowDb = new kuzu.Database(shadowDbPath);
    const shadowConn = new kuzu.Connection(shadowDb);
    const repoId = "repo";
    const fileId = "file-1";
    const fallbackSymbolId =
      "404b9898636576d8e639533e7f94be05bc6fa669326d537ddc4c6fea65637ec5";
    const clusterId = "repo:cluster:1";
    const processId = "repo:process:1";
    const shadowClusterId = "repo:louvain:1";
    const versionId = "version-1";
    const now = "2026-05-26T00:00:00.000Z";

    try {
      await createBaseSchema(activeConn);
      await createBaseSchema(shadowConn);
      await seedRepoFileAndSourceSymbol(activeConn, {
        repoId,
        fileId,
        sourceSymbolId: fallbackSymbolId,
        now,
      });
      await dbExec(
        shadowConn,
        `MERGE (r:Repo {repoId: $repoId})
         SET r.rootPath = "",
             r.configJson = "{}",
             r.createdAt = $now
         MERGE (f:File {fileId: $fileId})
         SET f.relPath = "src/index.ts",
             f.contentHash = "hash",
             f.language = "typescript",
             f.byteSize = 10,
             f.lastIndexedAt = $now,
             f.directory = "src"
         MERGE (f)-[:FILE_IN_REPO]->(r)`,
        { repoId, fileId, now },
      );
      await dbExec(
        activeConn,
        `MATCH (r:Repo {repoId: $repoId})
         MATCH (symbol:Symbol {symbolId: $fallbackSymbolId})
         MERGE (cluster:Cluster {clusterId: $clusterId})
         SET cluster.repoId = $repoId,
             cluster.label = "fallback real symbols",
             cluster.symbolCount = 1,
             cluster.cohesionScore = 0.7,
             cluster.versionId = $versionId,
             cluster.createdAt = $now,
             cluster.searchText = "fallback real symbols"
         MERGE (cluster)-[:CLUSTER_IN_REPO]->(r)
         MERGE (symbol)-[clusterMember:BELONGS_TO_CLUSTER]->(cluster)
         SET clusterMember.membershipScore = 0.9
         MERGE (process:Process {processId: $processId})
         SET process.repoId = $repoId,
             process.entrySymbolId = $fallbackSymbolId,
             process.label = "fallback process",
             process.depth = 1,
             process.versionId = $versionId,
             process.createdAt = $now,
             process.searchText = "fallback process"
         MERGE (process)-[:PROCESS_IN_REPO]->(r)
         MERGE (symbol)-[step:PARTICIPATES_IN]->(process)
         SET step.stepOrder = 1,
             step.role = "caller"
         MERGE (shadowCluster:ShadowCluster {shadowClusterId: $shadowClusterId})
         SET shadowCluster.repoId = $repoId,
             shadowCluster.algorithm = "louvain",
             shadowCluster.label = "fallback real symbols",
             shadowCluster.symbolCount = 1,
             shadowCluster.modularity = 0.42,
             shadowCluster.versionId = $versionId,
             shadowCluster.createdAt = $now
         MERGE (shadowCluster)-[:SHADOW_CLUSTER_IN_REPO]->(r)
         MERGE (symbol)-[member:BELONGS_TO_SHADOW_CLUSTER]->(shadowCluster)
         SET member.membershipScore = 1.0
         MERGE (v:Version {versionId: $versionId})
         SET v.createdAt = $now,
             v.reason = "test",
             v.prevVersionHash = null,
             v.versionHash = "hash"
         MERGE (v)-[:VERSION_OF_REPO]->(r)`,
        {
          repoId,
          fallbackSymbolId,
          clusterId,
          processId,
          shadowClusterId,
          versionId,
          now,
        },
      );
      await shadowConn.close();
      await shadowDb.close();

      const summary = await finalizeProviderFirstShadowDb({
        activeConn,
        repoId,
        versionId,
        shadowDbPath,
      });

      assert.equal(summary.status, "finalized", summary.reasons.join("\n"));
      assert.equal(summary.actualCounts?.symbols, 1);
      assert.equal(summary.actualCounts?.clusterMembers, 1);
      assert.equal(summary.actualCounts?.processSteps, 1);
      assert.equal(summary.actualCounts?.shadowClusterMembers, 1);
    } finally {
      await activeConn.close().catch(() => {});
      await activeDb.close().catch(() => {});
      await shadowConn.close().catch(() => {});
      await shadowDb.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes shadow DBs when copied derived relationships point at active real symbols that shadow staged as auxiliary", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-finalize-derived-staged-aux-"),
    );
    const activeDbPath = join(root, "active.lbug");
    const shadowDbPath = join(root, "shadow.lbug");
    const kuzu = await import("kuzu");
    const activeDb = new kuzu.Database(activeDbPath);
    const activeConn = new kuzu.Connection(activeDb);
    const shadowDb = new kuzu.Database(shadowDbPath);
    const shadowConn = new kuzu.Connection(shadowDb);
    const repoId = "repo";
    const fileId = "file-1";
    const fallbackSymbolId =
      "404b9898636576d8e639533e7f94be05bc6fa669326d537ddc4c6fea65637ec5";
    const clusterId = "repo:cluster:staged-aux";
    const processId = "repo:process:staged-aux";
    const shadowClusterId = "repo:louvain:staged-aux";
    const versionId = "version-1";
    const now = "2026-05-26T00:00:00.000Z";

    try {
      await createBaseSchema(activeConn);
      await createBaseSchema(shadowConn);
      await seedRepoFileAndSourceSymbol(activeConn, {
        repoId,
        fileId,
        sourceSymbolId: fallbackSymbolId,
        now,
      });
      await dbExec(
        shadowConn,
        `MERGE (r:Repo {repoId: $repoId})
         SET r.rootPath = "",
             r.configJson = "{}",
             r.createdAt = $now
         MERGE (f:File {fileId: $fileId})
         SET f.relPath = "src/index.ts",
             f.contentHash = "hash",
             f.language = "typescript",
             f.byteSize = 10,
             f.lastIndexedAt = $now,
             f.directory = "src"
         MERGE (f)-[:FILE_IN_REPO]->(r)
         MERGE (symbol:Symbol {symbolId: $fallbackSymbolId})
         SET symbol.repoId = $repoId,
             symbol.kind = "unknown",
             symbol.name = $fallbackSymbolId,
             symbol.exported = false,
             symbol.visibility = "",
             symbol.language = "unknown",
             symbol.rangeStartLine = 0,
             symbol.rangeStartCol = 0,
             symbol.rangeEndLine = 0,
             symbol.rangeEndCol = 0,
             symbol.astFingerprint = $fallbackSymbolId,
             symbol.signatureJson = "",
             symbol.summary = "",
             symbol.summaryQuality = 0.0,
             symbol.summarySource = "provider:scip",
             symbol.invariantsJson = "",
             symbol.sideEffectsJson = "",
             symbol.roleTagsJson = "",
             symbol.searchText = $fallbackSymbolId,
             symbol.updatedAt = $now,
             symbol.external = true,
             symbol.source = "scip",
             symbol.packageName = "",
             symbol.packageVersion = "",
             symbol.scipSymbol = $fallbackSymbolId,
             symbol.symbolStatus = "external",
             symbol.placeholderKind = "scip",
             symbol.placeholderTarget = $fallbackSymbolId
         MERGE (symbol)-[:SYMBOL_IN_REPO]->(r)
         MERGE (symbol)-[:SYMBOL_IN_FILE]->(f)`,
        { repoId, fileId, fallbackSymbolId, now },
      );
      await dbExec(
        activeConn,
        `MATCH (r:Repo {repoId: $repoId})
         MATCH (symbol:Symbol {symbolId: $fallbackSymbolId})
         MERGE (cluster:Cluster {clusterId: $clusterId})
         SET cluster.repoId = $repoId,
             cluster.label = "staged auxiliary collision",
             cluster.symbolCount = 1,
             cluster.cohesionScore = 0.7,
             cluster.versionId = $versionId,
             cluster.createdAt = $now,
             cluster.searchText = "staged auxiliary collision"
         MERGE (cluster)-[:CLUSTER_IN_REPO]->(r)
         MERGE (symbol)-[clusterMember:BELONGS_TO_CLUSTER]->(cluster)
         SET clusterMember.membershipScore = 0.9
         MERGE (process:Process {processId: $processId})
         SET process.repoId = $repoId,
             process.entrySymbolId = $fallbackSymbolId,
             process.label = "staged auxiliary process",
             process.depth = 1,
             process.versionId = $versionId,
             process.createdAt = $now,
             process.searchText = "staged auxiliary process"
         MERGE (process)-[:PROCESS_IN_REPO]->(r)
         MERGE (symbol)-[step:PARTICIPATES_IN]->(process)
         SET step.stepOrder = 1,
             step.role = "caller"
         MERGE (shadowCluster:ShadowCluster {shadowClusterId: $shadowClusterId})
         SET shadowCluster.repoId = $repoId,
             shadowCluster.algorithm = "louvain",
             shadowCluster.label = "staged auxiliary collision",
             shadowCluster.symbolCount = 1,
             shadowCluster.modularity = 0.42,
             shadowCluster.versionId = $versionId,
             shadowCluster.createdAt = $now
         MERGE (shadowCluster)-[:SHADOW_CLUSTER_IN_REPO]->(r)
         MERGE (symbol)-[member:BELONGS_TO_SHADOW_CLUSTER]->(shadowCluster)
         SET member.membershipScore = 1.0
         MERGE (v:Version {versionId: $versionId})
         SET v.createdAt = $now,
             v.reason = "test",
             v.prevVersionHash = null,
             v.versionHash = "hash"
         MERGE (v)-[:VERSION_OF_REPO]->(r)`,
        {
          repoId,
          fallbackSymbolId,
          clusterId,
          processId,
          shadowClusterId,
          versionId,
          now,
        },
      );
      await shadowConn.close();
      await shadowDb.close();

      const summary = await finalizeProviderFirstShadowDb({
        activeConn,
        repoId,
        versionId,
        shadowDbPath,
      });

      assert.equal(summary.status, "finalized", summary.reasons.join("\n"));
      assert.equal(summary.actualCounts?.clusterMembers, 1);
      assert.equal(summary.actualCounts?.processSteps, 1);
      assert.equal(summary.actualCounts?.shadowClusterMembers, 1);
    } finally {
      await activeConn.close().catch(() => {});
      await activeDb.close().catch(() => {});
      await shadowConn.close().catch(() => {});
      await shadowDb.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports shadow activation as ineligible until shadow contains the final graph", () => {
    const activation = summarizeProviderFirstShadowActivationReadiness({
      shadowBuild: {
        status: "staged",
        activation: "shadowDb",
        requestedFormat: "csv",
        format: "csv",
        generationId: "provider-first:test",
        stagingDir: "provider-first-shadow/repo/gen",
        manifestPath: "provider-first-shadow/repo/gen/manifest.json",
        counts: {
          files: 10,
          symbols: 20,
          externalSymbols: 0,
          edges: 30,
        },
        shadowDb: {
          status: "loaded",
          path: "provider-first-shadow/repo/gen/shadow.lbug",
          expectedCounts: {
            repos: 1,
            files: 10,
            symbols: 20,
            fileInRepo: 10,
            symbolInFile: 20,
            symbolInRepo: 20,
            edges: 30,
          },
          actualCounts: {
            repos: 1,
            files: 10,
            symbols: 20,
            fileInRepo: 10,
            symbolInFile: 20,
            symbolInRepo: 20,
            edges: 30,
          },
          secondaryIndexes: { attempted: 0, failures: [] },
          loadedAt: "2026-05-25T12:00:00.000Z",
          reasons: [],
        },
        reasons: [],
      },
      fallbackFiles: 2,
      graphDerivedStateReady: false,
      shadowContainsFinalizedGraph: false,
    });

    assert.equal(activation.status, "skipped");
    assert.deepEqual(activation.reasons, [
      "legacy fallback rows are not staged into the shadow DB yet",
      "graph-derived state is not ready in the shadow DB yet",
      "shadow DB does not contain version, metrics, summaries, and derived-state rows yet",
    ]);
  });

  it("activates shadow DB by swapping paths and keeping a previous DB backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdl-provider-first-activate-"));
    try {
      const activePath = join(root, "active.lbug");
      const shadowPath = join(root, "shadow.lbug");
      mkdirSync(activePath);
      mkdirSync(shadowPath);
      writeFileSync(join(activePath, "marker.txt"), "active", "utf8");
      writeFileSync(join(shadowPath, "marker.txt"), "shadow", "utf8");

      const activation = await activateProviderFirstShadowDb({
        activeDbPath: activePath,
        shadowDbPath: shadowPath,
        generationId: "provider-first:test",
      });

      assert.equal(activation.status, "activated");
      assert.equal(
        readFileSync(join(activePath, "marker.txt"), "utf8"),
        "shadow",
      );
      assert.ok(activation.previousDbPath);
      assert.equal(
        readFileSync(
          join(activation.previousDbPath ?? "", "marker.txt"),
          "utf8",
        ),
        "active",
      );
      assert.equal(existsSync(shadowPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes and reopens the active DB around live shadow activation", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdl-provider-first-handoff-"));
    try {
      const activePath = join(root, "active.lbug");
      const shadowPath = join(root, "shadow.lbug");
      mkdirSync(activePath);
      mkdirSync(shadowPath);
      writeFileSync(join(activePath, "marker.txt"), "active", "utf8");
      writeFileSync(join(shadowPath, "marker.txt"), "shadow", "utf8");
      const calls: string[] = [];

      const activation = await activateProviderFirstShadowDbWithHandoff({
        activeDbPath: activePath,
        shadowDbPath: shadowPath,
        generationId: "provider-first:test",
        closeActiveDb: async () => {
          calls.push("close");
        },
        reopenActiveDb: async (path) => {
          calls.push(`reopen:${path}`);
          assert.equal(
            readFileSync(join(path, "marker.txt"), "utf8"),
            "shadow",
          );
        },
        validateActivatedDb: async (path) => {
          calls.push(`validate:${path}`);
          assert.equal(
            readFileSync(join(path, "marker.txt"), "utf8"),
            "shadow",
          );
        },
      });

      assert.equal(activation.status, "activated");
      assert.deepEqual(calls, [
        "close",
        `reopen:${normalizePath(activePath)}`,
        `validate:${normalizePath(activePath)}`,
      ]);
      assert.equal(
        readFileSync(join(activePath, "marker.txt"), "utf8"),
        "shadow",
      );
      assert.ok(activation.previousDbPath);
      assert.equal(
        readFileSync(
          join(activation.previousDbPath ?? "", "marker.txt"),
          "utf8",
        ),
        "active",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the active DB when post-handoff validation fails", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-handoff-validation-"),
    );
    try {
      const activePath = join(root, "active.lbug");
      const shadowPath = join(root, "shadow.lbug");
      mkdirSync(activePath);
      mkdirSync(shadowPath);
      writeFileSync(join(activePath, "marker.txt"), "active", "utf8");
      writeFileSync(join(shadowPath, "marker.txt"), "shadow", "utf8");
      let reopenCalls = 0;

      const activation = await activateProviderFirstShadowDbWithHandoff({
        activeDbPath: activePath,
        shadowDbPath: shadowPath,
        generationId: "provider-first:fts-validation",
        closeActiveDb: async () => {},
        reopenActiveDb: async (path) => {
          reopenCalls++;
          assert.equal(
            readFileSync(join(path, "marker.txt"), "utf8"),
            reopenCalls === 1 ? "shadow" : "active",
          );
        },
        validateActivatedDb: async (path) => {
          assert.equal(
            readFileSync(join(path, "marker.txt"), "utf8"),
            "shadow",
          );
          throw new Error("critical Symbol FTS validation failed");
        },
      });

      assert.equal(activation.status, "failed");
      assert.equal(activation.rollback, "restored");
      assert.match(
        activation.reasons.join(" "),
        /critical Symbol FTS validation failed.*previous active DB was restored/,
      );
      assert.equal(reopenCalls, 2);
      assert.equal(
        readFileSync(join(activePath, "marker.txt"), "utf8"),
        "active",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports rollback failure when the previous active DB cannot be restored", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "sdl-provider-first-handoff-rollback-failure-"),
    );
    try {
      const activePath = join(root, "active.lbug");
      const shadowPath = join(root, "shadow.lbug");
      const previousPath = join(
        root,
        "active.lbug.provider-first-backup-provider-first-fts-validation",
      );
      mkdirSync(activePath);
      mkdirSync(shadowPath);
      writeFileSync(join(activePath, "marker.txt"), "active", "utf8");
      writeFileSync(join(shadowPath, "marker.txt"), "shadow", "utf8");

      const activation = await activateProviderFirstShadowDbWithHandoff({
        activeDbPath: activePath,
        shadowDbPath: shadowPath,
        generationId: "provider-first:fts-validation",
        closeActiveDb: async () => {},
        reopenActiveDb: async () => {},
        validateActivatedDb: async () => {
          throw new Error("critical Symbol FTS validation failed");
        },
        fs: {
          rename: async (from, to) => {
            if (
              normalizePath(String(from)) === normalizePath(previousPath) &&
              normalizePath(String(to)) === normalizePath(activePath)
            ) {
              throw new Error("simulated previous backup restore failure");
            }
            await fsRename(from, to);
          },
        },
      });

      assert.equal(activation.status, "failed");
      assert.equal(activation.rollback, "failed");
      assert.match(
        activation.reasons.join(" "),
        /previous active DB could not be restored.*simulated previous backup restore failure/,
      );
      assert.doesNotMatch(
        activation.reasons.join(" "),
        /previous active DB was restored/,
      );
      assert.equal(
        readFileSync(join(activePath, "marker.txt"), "utf8"),
        "shadow",
      );
      assert.equal(
        readFileSync(join(previousPath, "marker.txt"), "utf8"),
        "active",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back the active DB when shadow activation fails after backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdl-provider-first-rollback-"));
    try {
      const activePath = join(root, "active.lbug");
      const shadowPath = join(root, "shadow.lbug");
      mkdirSync(activePath);
      mkdirSync(shadowPath);
      writeFileSync(join(activePath, "marker.txt"), "active", "utf8");
      writeFileSync(join(shadowPath, "marker.txt"), "shadow", "utf8");
      let renameCalls = 0;

      const activation = await activateProviderFirstShadowDb({
        activeDbPath: activePath,
        shadowDbPath: shadowPath,
        generationId: "provider-first:test",
        fs: {
          rename: async (from, to) => {
            renameCalls++;
            if (renameCalls === 2) {
              throw new Error("simulated shadow rename failure");
            }
            await fsRename(from, to);
          },
        },
      });

      assert.equal(activation.status, "failed");
      assert.equal(activation.rollback, "restored");
      assert.match(
        activation.reasons.join(" "),
        /simulated shadow rename failure/,
      );
      assert.equal(
        readFileSync(join(activePath, "marker.txt"), "utf8"),
        "active",
      );
      assert.equal(
        readFileSync(join(shadowPath, "marker.txt"), "utf8"),
        "shadow",
      );
      assert.deepEqual(readdirSync(root).sort(), [
        "active.lbug",
        "shadow.lbug",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate and cross-repo provider graph rows before staging", async () => {
    const rows = providerFactsToGraphRows({
      indexedAt: "2026-05-25T12:00:00.000Z",
      facts: providerFactSet({
        edges: [
          {
            kind: "edge",
            repoId: "repo",
            generationId: "gen-1",
            providerType: "scip",
            providerId: "scip",
            emittedAt: "2026-05-25T12:00:00.000Z",
            sourceSymbolId: "symbol-1",
            targetSymbolId: "symbol-1",
            edgeType: "call",
            resolution: "exact",
            confidence: 0.95,
            dedupeKey: "symbol-1:symbol-1:call:scip",
          },
        ],
      }),
    });

    assert.throws(
      () =>
        validateProviderFirstGraphRows(
          {
            ...rows,
            files: [
              ...rows.files,
              { ...rows.files[0]!, relPath: "src/duplicate.ts" },
            ],
          },
          { repoId: "repo", context: "test" },
        ),
      /duplicate File primary key file-1/i,
    );
    assert.throws(
      () =>
        validateProviderFirstGraphRows(
          {
            ...rows,
            symbols: [{ ...rows.symbols[0]!, repoId: "other" }],
          },
          { repoId: "repo", context: "test" },
        ),
      /cross-repo Symbol row/i,
    );
    assert.throws(
      () =>
        validateProviderFirstGraphRows(
          {
            ...rows,
            edges: [...rows.edges, { ...rows.edges[0]! }],
          },
          { repoId: "repo", context: "test" },
        ),
      /duplicate DEPENDS_ON relationship/i,
    );
  });

  it("skips shadow staging when artifact writes fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdl-provider-first-shadow-fail-"));
    try {
      const blockingFile = join(root, "not-a-directory");
      writeFileSync(blockingFile, "blocks staging directory creation");
      const rows = providerFactsToGraphRows({
        indexedAt: "2026-05-25T12:00:00.000Z",
        facts: providerFactSet(),
      });

      const summary = await stageProviderFirstShadowBuild({
        repoId: "repo",
        generationId: "provider-first:test",
        activation: "shadowDb",
        requestedFormat: "csv",
        activeDbPath: join(blockingFile, "active.lbug"),
        rows,
      });

      assert.equal(summary.status, "skipped");
      assert.equal(summary.counts.files, 1);
      assert.equal(summary.counts.symbols, 1);
      assert.match(summary.reasons.join(" "), /failed/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

interface CanonicalProviderSymbolProjection {
  symbolId: string;
  fileId: string;
  relPath: string;
  name: string;
  signatureJson: string;
  kind: string;
  language: string;
  rangeStartLine: number;
  rangeStartCol: number;
  rangeEndLine: number;
  rangeEndCol: number;
  summarySource: string;
  source: string;
  scipSymbol: string;
  astFingerprint: string;
  symbolStatus: string;
  external: boolean;
  placeholderKind: string;
  placeholderTarget: string;
}

interface ProviderIdentityBinding {
  symbolId: string;
  repoId: string;
  providerId: string;
  providerType: "scip";
  providerSymbolId: string;
  sourcePath: string;
}

interface ReleaseScaleProviderFirstFixture {
  rows: ProviderFirstGraphRows;
  providerIdentities: ProviderIdentityBinding[];
}

interface CanonicalIsolatedPlaceholderProjection {
  symbolId: string;
  repoId: string;
  kind: string;
  name: string;
  exported: boolean;
  visibility: string;
  language: string;
  rangeStartLine: number;
  rangeStartCol: number;
  rangeEndLine: number;
  rangeEndCol: number;
  astFingerprint: string;
  signatureJson: string;
  summary: string;
  summaryQuality: number;
  summarySource: string;
  external: boolean;
  source: string;
  scipSymbol: string;
  symbolStatus: string;
  placeholderKind: string;
  placeholderTarget: string;
  embeddingJinaCode: string;
  embeddingJinaCodeCardHash: string;
}

interface CanonicalRelationshipProjection {
  fromSymbolId: string;
  toSymbolId: string;
  providerId: string;
  provenance: string;
}

function releaseScaleProviderFirstRows(
  repoId: string,
  updatedAt: string,
): ReleaseScaleProviderFirstFixture {
  const symbolCount = 2_112;
  const fallbackStart = 1_408;
  const placeholderStart = symbolCount - 16;
  const id = (index: number): string => String(index).padStart(5, "0");
  const files = Array.from({ length: symbolCount }, (_, index) => {
    const suffix = id(index);
    const language = index % 2 === 0 ? "typescript" : "rust";
    const extension = language === "typescript" ? "ts" : "rs";
    const relPath = `src/${language}/release-scale-${suffix}.${extension}`;
    return {
      fileId: `release-scale-file-${suffix}`,
      repoId,
      relPath,
      contentHash: createHash("sha256").update(relPath).digest("hex"),
      language,
      byteSize: 100 + index,
      lastIndexedAt: updatedAt,
    };
  });
  const kinds = ["function", "class", "method", "constant"] as const;
  const providerIdentities: ProviderIdentityBinding[] = [];
  const symbols: SymbolRow[] = files.map((file, index) => {
    const suffix = id(index);
    const placeholder = index >= placeholderStart;
    const fallbackOnly = index >= fallbackStart && !placeholder;
    const providerId = `release-scale-provider-${suffix}`;
    const providerSymbolId = `scip qa fixture ${suffix} releaseScaleName${suffix}().`;
    const symbolId = fallbackOnly
      ? `release-scale-fallback-symbol-${suffix}`
      : createProviderSymbolId({
          repoId,
          providerType: "scip",
          providerId,
          providerSymbolId,
          sourcePath: file.relPath,
        });
    if (!fallbackOnly) {
      providerIdentities.push({
        symbolId,
        repoId,
        providerId,
        providerType: "scip",
        providerSymbolId,
        sourcePath: file.relPath,
      });
    }
    return {
      symbolId,
      repoId,
      fileId: file.fileId,
      kind: kinds[index % kinds.length]!,
      name: `releaseScaleName${suffix}`,
      exported: index % 3 !== 0,
      visibility: index % 5 === 0 ? "private" : "public",
      language: file.language,
      rangeStartLine: index + 1,
      rangeStartCol: index % 17,
      rangeEndLine: index + 1,
      rangeEndCol: (index % 17) + 3,
      astFingerprint: `release-scale-fingerprint-${suffix}`,
      signatureJson: JSON.stringify({
        text: `signature releaseScaleName${suffix}(arg${suffix}): Result${suffix}`,
      }),
      summary: `release-scale summary ${suffix}`,
      invariantsJson: JSON.stringify([`invariant-${suffix}`]),
      sideEffectsJson: JSON.stringify([`effect-${suffix}`]),
      summaryQuality: 0.5 + (index % 4) / 10,
      summarySource: fallbackOnly ? "unknown" : "provider:scip",
      roleTagsJson: JSON.stringify([`role-${suffix}`]),
      searchText: `releaseScaleName${suffix} signature-${suffix}`,
      external: false,
      source: fallbackOnly ? "treesitter" : "scip",
      packageName: `package-${suffix}`,
      packageVersion: `1.0.${index}`,
      scipSymbol: fallbackOnly ? null : providerSymbolId,
      symbolStatus: placeholder ? "unresolved" : "real",
      placeholderKind: placeholder ? "provider-metadata" : "",
      placeholderTarget: placeholder ? `placeholder-${suffix}` : "",
      updatedAt,
    };
  });
  const edges = Array.from({ length: placeholderStart - 1 }, (_, index) => {
    const suffix = id(index);
    const fromSymbolId = symbols[index]!.symbolId;
    const toSymbolId = symbols[index + 1]!.symbolId;
    return {
      repoId,
      fromSymbolId,
      toSymbolId,
      edgeType: "call" as const,
      weight: 1,
      confidence: 0.99,
      resolution: "exact" as const,
      resolverId: `provider-first:release-scale-${suffix}`,
      resolutionPhase: "provider-first",
      provenance: JSON.stringify({
        dedupeKey: `${fromSymbolId}:${toSymbolId}:call`,
        providerId: `release-scale-${suffix}`,
      }),
      createdAt: updatedAt,
    };
  });
  return {
    rows: {
      files,
      symbols,
      externalSymbols: [],
      edges,
      changedFileIds: new Set(files.map((file) => file.fileId)),
    },
    providerIdentities,
  };
}

function assertProviderIdentityBindings(
  fixture: ReleaseScaleProviderFirstFixture,
): void {
  const symbolById = new Map(
    fixture.rows.symbols.map((symbol) => [symbol.symbolId, symbol]),
  );
  for (const identity of fixture.providerIdentities) {
    const symbol = symbolById.get(identity.symbolId);
    assert.ok(symbol);
    // Raw providerId is intentionally not a Symbol property. The v2 identity
    // contract commits it into symbolId, while provider type and native SCIP
    // identity remain directly queryable as source and scipSymbol.
    assert.equal(identity.symbolId, createProviderSymbolId(identity));
    assert.equal(symbol.source, identity.providerType);
    assert.equal(symbol.scipSymbol, identity.providerSymbolId);
    assert.equal(symbol.summarySource, `provider:${identity.providerType}`);
    assert.notEqual(symbol.summarySource, identity.providerId);
  }
}

function canonicalProjectionForRows(
  rows: ProviderFirstGraphRows,
): CanonicalProviderSymbolProjection[] {
  const fileById = new Map(rows.files.map((file) => [file.fileId, file]));
  return rows.symbols
    .map((symbol) => ({
      symbolId: symbol.symbolId,
      fileId: symbol.fileId,
      relPath: fileById.get(symbol.fileId)?.relPath ?? "",
      name: symbol.name,
      signatureJson: symbol.signatureJson ?? "",
      kind: symbol.kind,
      language: symbol.language,
      rangeStartLine: symbol.rangeStartLine,
      rangeStartCol: symbol.rangeStartCol,
      rangeEndLine: symbol.rangeEndLine,
      rangeEndCol: symbol.rangeEndCol,
      summarySource: symbol.summarySource ?? "unknown",
      source: symbol.source ?? "",
      scipSymbol: symbol.scipSymbol ?? "",
      astFingerprint: symbol.astFingerprint,
      symbolStatus: symbol.symbolStatus ?? "real",
      external: symbol.external ?? false,
      placeholderKind: symbol.placeholderKind ?? "",
      placeholderTarget: symbol.placeholderTarget ?? "",
    }))
    .sort((left, right) => left.symbolId.localeCompare(right.symbolId));
}

async function assertCanonicalProjection(
  conn: import("kuzu").Connection,
  checkpoint: string,
  repoId: string,
  expected: CanonicalProviderSymbolProjection[],
): Promise<void> {
  const rows = await queryAll<{
    symbolId: string;
    fileId: string;
    relPath: string;
    name: string;
    signatureJson: string | null;
    kind: string;
    language: string;
    rangeStartLine: unknown;
    rangeStartCol: unknown;
    rangeEndLine: unknown;
    rangeEndCol: unknown;
    summarySource: string | null;
    source: string | null;
    scipSymbol: string | null;
    astFingerprint: string;
    symbolStatus: string | null;
    external: unknown;
    placeholderKind: string | null;
    placeholderTarget: string | null;
  }>(
    conn,
    `MATCH (s:Symbol {repoId: $repoId})-[:SYMBOL_IN_FILE]->(f:File)
     RETURN s.symbolId AS symbolId,
            f.fileId AS fileId,
            f.relPath AS relPath,
            s.name AS name,
            s.signatureJson AS signatureJson,
            s.kind AS kind,
            s.language AS language,
            s.rangeStartLine AS rangeStartLine,
            s.rangeStartCol AS rangeStartCol,
            s.rangeEndLine AS rangeEndLine,
            s.rangeEndCol AS rangeEndCol,
            s.summarySource AS summarySource,
            s.source AS source,
            s.scipSymbol AS scipSymbol,
            s.astFingerprint AS astFingerprint,
            s.symbolStatus AS symbolStatus,
            s.external AS external,
            s.placeholderKind AS placeholderKind,
            s.placeholderTarget AS placeholderTarget
     ORDER BY s.symbolId`,
    { repoId },
  );
  const actual = rows
    .map((row) => ({
      symbolId: row.symbolId,
      fileId: row.fileId,
      relPath: row.relPath,
      name: row.name,
      signatureJson: row.signatureJson ?? "",
      kind: row.kind,
      language: row.language,
      rangeStartLine: toNumber(row.rangeStartLine),
      rangeStartCol: toNumber(row.rangeStartCol),
      rangeEndLine: toNumber(row.rangeEndLine),
      rangeEndCol: toNumber(row.rangeEndCol),
      summarySource: row.summarySource ?? "unknown",
      source: row.source ?? "",
      scipSymbol: row.scipSymbol ?? "",
      astFingerprint: row.astFingerprint,
      symbolStatus: row.symbolStatus ?? "real",
      external: Boolean(row.external),
      placeholderKind: row.placeholderKind ?? "",
      placeholderTarget: row.placeholderTarget ?? "",
    }))
    .sort((left, right) => left.symbolId.localeCompare(right.symbolId));
  assertProjection(checkpoint, expected, actual);
}

function canonicalIsolatedPlaceholderProjection(
  repoId: string,
  symbolIds: readonly string[],
): CanonicalIsolatedPlaceholderProjection[] {
  return symbolIds
    .map((symbolId, index) => ({
      symbolId,
      repoId,
      kind: "placeholder",
      name: `release-scale-unused-${index}`,
      exported: false,
      visibility: "",
      language: "",
      rangeStartLine: 0,
      rangeStartCol: 0,
      rangeEndLine: 0,
      rangeEndCol: 0,
      astFingerprint: "",
      signatureJson: "",
      summary: "",
      summaryQuality: 0,
      summarySource: "unknown",
      external: false,
      source: "treesitter",
      scipSymbol: "",
      symbolStatus: "unresolved",
      placeholderKind: "call",
      placeholderTarget: `release-scale-unused-${index}`,
      embeddingJinaCode: "",
      embeddingJinaCodeCardHash: "",
    }))
    .sort((left, right) => left.symbolId.localeCompare(right.symbolId));
}

async function assertIsolatedPlaceholderProjection(
  conn: import("kuzu").Connection,
  checkpoint: string,
  repoId: string,
  expected: CanonicalIsolatedPlaceholderProjection[],
): Promise<void> {
  const rows = await queryAll<{
    symbolId: string;
    repoId: string;
    kind: string | null;
    name: string | null;
    exported: unknown;
    visibility: string | null;
    language: string | null;
    rangeStartLine: unknown;
    rangeStartCol: unknown;
    rangeEndLine: unknown;
    rangeEndCol: unknown;
    astFingerprint: string | null;
    signatureJson: string | null;
    summary: string | null;
    summaryQuality: unknown;
    summarySource: string | null;
    external: unknown;
    source: string | null;
    scipSymbol: string | null;
    symbolStatus: string | null;
    placeholderKind: string | null;
    placeholderTarget: string | null;
    embeddingJinaCode: string | null;
    embeddingJinaCodeCardHash: string | null;
  }>(
    conn,
    `MATCH (s:Symbol {repoId: $repoId})
     WHERE NOT (s)-[:SYMBOL_IN_FILE]->(:File)
     RETURN s.symbolId AS symbolId,
            s.repoId AS repoId,
            s.kind AS kind,
            s.name AS name,
            s.exported AS exported,
            s.visibility AS visibility,
            s.language AS language,
            s.rangeStartLine AS rangeStartLine,
            s.rangeStartCol AS rangeStartCol,
            s.rangeEndLine AS rangeEndLine,
            s.rangeEndCol AS rangeEndCol,
            s.astFingerprint AS astFingerprint,
            s.signatureJson AS signatureJson,
            s.summary AS summary,
            s.summaryQuality AS summaryQuality,
            s.summarySource AS summarySource,
            s.external AS external,
            s.source AS source,
            s.scipSymbol AS scipSymbol,
            s.symbolStatus AS symbolStatus,
            s.placeholderKind AS placeholderKind,
            s.placeholderTarget AS placeholderTarget,
            s.embeddingJinaCode AS embeddingJinaCode,
            s.embeddingJinaCodeCardHash AS embeddingJinaCodeCardHash
     ORDER BY s.symbolId`,
    { repoId },
  );
  const actual = rows
    .map((row) => ({
      symbolId: row.symbolId,
      repoId: row.repoId,
      kind: row.kind ?? "",
      name: row.name ?? "",
      exported: Boolean(row.exported),
      visibility: row.visibility ?? "",
      language: row.language ?? "",
      rangeStartLine: toNumber(row.rangeStartLine),
      rangeStartCol: toNumber(row.rangeStartCol),
      rangeEndLine: toNumber(row.rangeEndLine),
      rangeEndCol: toNumber(row.rangeEndCol),
      astFingerprint: row.astFingerprint ?? "",
      signatureJson: row.signatureJson ?? "",
      summary: row.summary ?? "",
      summaryQuality: Number(row.summaryQuality ?? 0),
      summarySource: row.summarySource ?? "unknown",
      external: Boolean(row.external),
      source: row.source ?? "",
      scipSymbol: row.scipSymbol ?? "",
      symbolStatus: row.symbolStatus ?? "real",
      placeholderKind: row.placeholderKind ?? "",
      placeholderTarget: row.placeholderTarget ?? "",
      embeddingJinaCode: row.embeddingJinaCode ?? "",
      embeddingJinaCodeCardHash: row.embeddingJinaCodeCardHash ?? "",
    }))
    .sort((left, right) => left.symbolId.localeCompare(right.symbolId));
  assertProjection(`${checkpoint} isolated placeholders`, expected, actual);
}

function canonicalRelationshipProjectionForRows(
  rows: ProviderFirstGraphRows,
): CanonicalRelationshipProjection[] {
  return rows.edges
    .map((edge) => ({
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      providerId: edge.resolverId ?? "",
      provenance: edge.provenance ?? "",
    }))
    .sort((left, right) =>
      `${left.fromSymbolId}\0${left.toSymbolId}`.localeCompare(
        `${right.fromSymbolId}\0${right.toSymbolId}`,
      ),
    );
}

async function assertProviderRelationshipProjection(
  conn: import("kuzu").Connection,
  checkpoint: string,
  repoId: string,
  expected: CanonicalRelationshipProjection[],
): Promise<void> {
  const actual = (
    await queryAll<CanonicalRelationshipProjection>(
      conn,
      `MATCH (from:Symbol)-[edge:DEPENDS_ON]->(to:Symbol)
       WHERE from.repoId = $repoId
       RETURN from.symbolId AS fromSymbolId,
              to.symbolId AS toSymbolId,
              edge.resolverId AS providerId,
              edge.provenance AS provenance
       ORDER BY fromSymbolId, toSymbolId`,
      { repoId },
    )
  ).sort((left, right) =>
    `${left.fromSymbolId}\0${left.toSymbolId}`.localeCompare(
      `${right.fromSymbolId}\0${right.toSymbolId}`,
    ),
  );
  assertProjection(`${checkpoint} provider relationships`, expected, actual);
}

async function assertReleaseScaleState(
  conn: import("kuzu").Connection,
  checkpoint: string,
  repoId: string,
  expectedSymbols: CanonicalProviderSymbolProjection[],
  expectedPlaceholders: CanonicalIsolatedPlaceholderProjection[],
  expectedRelationships: CanonicalRelationshipProjection[],
): Promise<void> {
  await assertCanonicalProjection(
    conn,
    `${checkpoint} file-backed symbols`,
    repoId,
    expectedSymbols,
  );
  await assertIsolatedPlaceholderProjection(
    conn,
    checkpoint,
    repoId,
    expectedPlaceholders,
  );
  await assertProviderRelationshipProjection(
    conn,
    checkpoint,
    repoId,
    expectedRelationships,
  );
}

async function assertReleaseScaleStateAtPath(
  dbPath: string,
  checkpoint: string,
  repoId: string,
  expectedSymbols: CanonicalProviderSymbolProjection[],
  expectedPlaceholders: CanonicalIsolatedPlaceholderProjection[],
  expectedRelationships: CanonicalRelationshipProjection[],
): Promise<void> {
  const kuzu = await import("kuzu");
  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);
  try {
    await assertReleaseScaleState(
      conn,
      checkpoint,
      repoId,
      expectedSymbols,
      expectedPlaceholders,
      expectedRelationships,
    );
  } finally {
    await conn.close().catch(() => {});
    await db.close().catch(() => {});
  }
}

function assertProjection<T>(
  checkpoint: string,
  expected: readonly T[],
  actual: readonly T[],
): void {
  const digest = (rows: readonly T[]): string =>
    createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  const expectedDigest = digest(expected);
  const actualDigest = digest(actual);
  if (expected.length === actual.length && expectedDigest === actualDigest) {
    return;
  }

  const mismatchIndex = Array.from(
    { length: Math.max(expected.length, actual.length) },
    (_, index) => index,
  ).find(
    (index) =>
      JSON.stringify(expected[index]) !== JSON.stringify(actual[index]),
  );
  assert.fail(
    `Provider-first canonical projection mismatch: ${JSON.stringify({
      checkpoint,
      expectedCount: expected.length,
      actualCount: actual.length,
      expectedDigest,
      actualDigest,
      mismatchIndex,
      expected:
        mismatchIndex === undefined ? undefined : expected[mismatchIndex],
      actual: mismatchIndex === undefined ? undefined : actual[mismatchIndex],
    })}`,
  );
}

function assertSecondaryIndexBuildReported(summary: {
  attempted: number;
  failures: readonly { statement: string; error: string }[];
}): void {
  assert.ok(Number.isSafeInteger(summary.attempted));
  assert.ok(summary.attempted >= summary.failures.length);
  assert.ok(
    summary.failures.every(
      (failure) => failure.statement.length > 0 && failure.error.length > 0,
    ),
  );
}

async function readShadowSymbolRows(shadowDbPath: string): Promise<
  Array<{
    symbolId: string;
    name: string;
    visibility: string | null;
    packageName: string | null;
    astFingerprint: string | null;
    signatureJson: string | null;
    placeholderKind: string | null;
    placeholderTarget: string | null;
  }>
> {
  const kuzu = await import("kuzu");
  const db = new kuzu.Database(shadowDbPath);
  const conn = new kuzu.Connection(db);
  try {
    return await queryAll(
      conn,
      `MATCH (s:Symbol)
       RETURN s.symbolId AS symbolId,
              s.name AS name,
              s.visibility AS visibility,
              s.packageName AS packageName,
              s.astFingerprint AS astFingerprint,
              s.signatureJson AS signatureJson,
              s.placeholderKind AS placeholderKind,
              s.placeholderTarget AS placeholderTarget
       ORDER BY s.symbolId`,
      {},
    );
  } finally {
    await conn.close().catch(() => {});
    await db.close().catch(() => {});
  }
}

async function seedRepoFileAndSourceSymbol(
  conn: import("kuzu").Connection,
  params: {
    repoId: string;
    fileId: string;
    sourceSymbolId: string;
    now: string;
  },
): Promise<void> {
  await dbExec(
    conn,
    `MERGE (r:Repo {repoId: $repoId})
     SET r.rootPath = '',
         r.configJson = '{}',
         r.createdAt = $now
     MERGE (f:File {fileId: $fileId})
     SET f.relPath = 'src/index.ts',
         f.contentHash = 'hash',
         f.language = 'typescript',
         f.byteSize = 10,
         f.lastIndexedAt = $now,
         f.directory = 'src'
     MERGE (f)-[:FILE_IN_REPO]->(r)
     MERGE (s:Symbol {symbolId: $sourceSymbolId})
     SET s.repoId = $repoId,
         s.kind = 'function',
         s.name = 'main',
         s.exported = true,
         s.visibility = '',
         s.language = 'typescript',
         s.rangeStartLine = 1,
         s.rangeStartCol = 0,
         s.rangeEndLine = 3,
         s.rangeEndCol = 1,
         s.astFingerprint = 'fingerprint',
         s.signatureJson = '',
         s.summary = '',
         s.summaryQuality = 0.0,
         s.summarySource = 'unknown',
         s.invariantsJson = '',
         s.sideEffectsJson = '',
         s.roleTagsJson = '',
         s.searchText = 'main',
         s.updatedAt = $now,
         s.external = false,
         s.source = 'treesitter',
         s.packageName = '',
         s.packageVersion = '',
         s.scipSymbol = '',
         s.symbolStatus = 'real',
         s.placeholderKind = '',
         s.placeholderTarget = ''
     MERGE (s)-[:SYMBOL_IN_FILE]->(f)
     MERGE (s)-[:SYMBOL_IN_REPO]->(r)`,
    params,
  );
}

function providerFactSet(
  overrides: Partial<ProviderFactSet> = {},
): ProviderFactSet {
  const emittedAt = "2026-05-25T12:00:00.000Z";
  return {
    files: [
      {
        kind: "file",
        repoId: "repo",
        generationId: "gen-1",
        providerType: "scip",
        providerId: "scip",
        emittedAt,
        fileId: "file-1",
        relPath: "src/index.ts",
        languageId: "typescript",
        contentHash: "0".repeat(64),
        byteSize: 42,
      },
    ],
    symbols: [
      {
        kind: "symbol",
        repoId: "repo",
        generationId: "gen-1",
        providerType: "scip",
        providerId: "scip",
        emittedAt,
        symbolId: "symbol-1",
        providerSymbolId: "scip npm pkg 1.0.0 src/index.ts/buildGraph().",
        name: "buildGraph",
        symbolKind: "function",
        relPath: "src/index.ts",
        range: { startLine: 1, startCol: 0, endLine: 3, endCol: 1 },
        signature: "function buildGraph(): Graph",
        documentation: [],
        external: false,
      },
    ],
    occurrences: [],
    edges: [],
    externalSymbols: [],
    diagnostics: [],
    coverage: [],
    providerRuns: [],
    ...overrides,
  };
}

function withProviderFileMetadata(facts: ProviderFactSet): ProviderFactSet {
  for (const file of facts.files) {
    file.contentHash ??= "0".repeat(64);
    file.byteSize ??= 0;
  }
  return facts;
}

class FakeQueryResult {
  private readonly rows: unknown[];

  constructor(rows: unknown[] = []) {
    this.rows = rows;
  }

  close(): void {}
  async getAll(): Promise<unknown[]> {
    return this.rows;
  }
}

function createFakeConnection(
  statements: string[],
  resultRowsForStatement: (statement: string) => unknown[] = () => [],
): import("kuzu").Connection {
  return {
    async prepare(statement: string) {
      return {
        statement,
        isSuccess() {
          return true;
        },
        getErrorMessage() {
          return "";
        },
      };
    },
    async execute(preparedStatement: { statement: string }) {
      statements.push(preparedStatement.statement);
      return new FakeQueryResult(
        resultRowsForStatement(preparedStatement.statement),
      );
    },
    async query(statement: string) {
      statements.push(statement);
      return new FakeQueryResult(resultRowsForStatement(statement));
    },
  } as unknown as import("kuzu").Connection;
}

function countStatements(statements: string[], fragment: string): number {
  return statements.filter((statement) => statement.includes(fragment)).length;
}
