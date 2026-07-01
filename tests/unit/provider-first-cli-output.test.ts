import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatIndexWallTimeLine,
  formatSummaryStatsLine,
  formatProviderFirstExecutionSummaryLines,
  formatScipGeneratorCacheLine,
  formatSemanticReadinessLines,
} from "../../dist/cli/commands/index.js";

describe("provider-first CLI output", () => {
  it("prints summary cost only for API summary providers", () => {
    const apiLine = formatSummaryStatsLine({
      generated: 849,
      skipped: 24324,
      failed: 0,
      totalCostUsd: 0.0472,
      provider: "api",
    });
    const mockLine = formatSummaryStatsLine({
      generated: 849,
      skipped: 24324,
      failed: 0,
      totalCostUsd: 0.0472,
      provider: "mock",
    });
    const localLine = formatSummaryStatsLine({
      generated: 849,
      skipped: 24324,
      failed: 0,
      totalCostUsd: 0.0472,
      provider: "local",
    });

    assert.equal(
      apiLine,
      "  Summaries: 849 new ($0.0472), 24324 cached, 0 failed",
    );
    assert.equal(
      mockLine,
      "  Summaries: 849 new, 24324 cached, 0 failed",
    );
    assert.equal(
      localLine,
      "  Summaries: 849 new, 24324 cached, 0 failed",
    );
  });

  it("reports repo wall time separately from index duration", () => {
    assert.equal(
      formatIndexWallTimeLine(406_700, 69_775),
      "  Wall time: 406700ms (includes 336925ms outside indexed phases)",
    );
  });

  it("reports generator cache hits without printing cache misses", () => {
    assert.equal(
      formatScipGeneratorCacheLine({
        status: "hit",
        durationMs: 2_500,
        fileCount: 16_790,
      }),
      "  SCIP generator cache: hit (2500ms, 16790 input file(s))",
    );
    assert.equal(
      formatScipGeneratorCacheLine({
        status: "miss",
        durationMs: 1_000,
      }),
      undefined,
    );
  });

  it("breaks down generator cache store timing", () => {
    assert.equal(
      formatScipGeneratorCacheLine({
        status: "stored",
        durationMs: 360_764,
        generatorDurationMs: 358_200,
        prepareDurationMs: 2_000,
        saveDurationMs: 564,
        fileCount: 42_111,
      }),
      "  SCIP generator cache: stored (generator 358200ms, save 564ms, prepare 2000ms, 42111 input file(s))",
    );
  });

  it("explains provider coverage and legacy fallback scope for executed runs", () => {
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 0,
      symbolsIndexed: 0,
      edgesCreated: 0,
      externalSymbolsIndexed: 0,
      shadowBuild: {
        status: "staged",
        activation: "shadowDb",
        requestedFormat: "parquet",
        format: "csv",
        generationId: "provider-first:test",
        stagingDir: "F:/db/provider-first-shadow/repo/provider-first-test",
        manifestPath:
          "F:/db/provider-first-shadow/repo/provider-first-test/manifest.json",
        counts: {
          files: 521,
          symbols: 10_000,
          externalSymbols: 500,
          edges: 25_000,
        },
        shadowDb: {
          status: "loaded",
          path: "F:/db/provider-first-shadow/repo/provider-first-test/shadow.lbug",
          actualCounts: {
            repos: 1,
            files: 521,
            symbols: 10_500,
            fileInRepo: 521,
            symbolInFile: 10_000,
            symbolInRepo: 10_500,
            edges: 25_000,
          },
          expectedCounts: {
            repos: 1,
            files: 521,
            symbols: 10_500,
            fileInRepo: 521,
            symbolInFile: 10_000,
            symbolInRepo: 10_500,
            edges: 25_000,
          },
          secondaryIndexes: { attempted: 10, failures: [] },
          loadedAt: "2026-05-26T00:00:00.000Z",
          reasons: [],
        },
        reasons: ["Parquet staging is not available; wrote CSV fallback."],
      },
      coverage: {
        scannedFiles: 1213,
        providerFiles: 543,
        providerPrimaryFiles: 521,
        fullyCoveredFiles: 0,
        partialFiles: 521,
        providerUnusableReasons: [
          {
            code: "noUsableProviderSymbols",
            files: 20,
            samplePaths: ["tests/empty.ts", "scripts/no-symbols.ts"],
            skippedSymbolReasons: [
              {
                reason: "unknown descriptor suffix",
                symbols: 20,
                samplePaths: ["tests/empty.ts", "scripts/no-symbols.ts"],
              },
            ],
          },
          {
            code: "unknown",
            files: 2,
            samplePaths: ["src/unknown.ts"],
          },
        ],
        fullFallbackFiles: 22,
        uncoveredFiles: 670,
        ignoredProviderFiles: 12,
        ignoredProviderFileSamples: ["scripts/fix-agent-frontmatter.py"],
        fallbackFiles: 692,
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first shadow staging: csv files=521 symbols=10000 externals=500 edges=25000 (parquet requested)",
      "  Provider-first shadow DB loaded: files=521 symbols=10500 edges=25000",
      "  Provider-first coverage: 521/1213 files provider-primary (0 full, 521 partial); 22 provider unusable, 670 uncovered, 12 provider file(s) ignored outside scan scope; legacy fallback parsed 692 file(s)",
      "  Provider-first provider-unusable diagnostics:",
      "    no usable provider symbols: 20 file(s): tests/empty.ts, scripts/no-symbols.ts",
      "      skipped symbol reason: unknown descriptor suffix, 20 symbol(s): tests/empty.ts, scripts/no-symbols.ts",
      "    unknown: 2 file(s): src/unknown.ts",
    ]);
  });

  it("splits scan scope, semantic eligibility, and provider document counts", () => {
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 0,
      symbolsIndexed: 0,
      edgesCreated: 0,
      externalSymbolsIndexed: 0,
      coverage: {
        scannedFiles: 1213,
        semanticEligibleFiles: 543,
        providerFiles: 543,
        providerPrimaryFiles: 521,
        fullyCoveredFiles: 0,
        partialFiles: 521,
        fullFallbackFiles: 22,
        uncoveredFiles: 670,
        fallbackFiles: 692,
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first coverage: 521/543 semantic-eligible files provider-primary (scan scope 1213, provider docs 543; 0 full, 521 partial); 22 provider unusable, 670 outside semantic eligibility or uncovered; legacy fallback parsed 692 file(s)",
    ]);
  });

  it("prints semantic eligibility gap diagnostics for fallback-cap runs", () => {
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 0,
      symbolsIndexed: 0,
      edgesCreated: 0,
      externalSymbolsIndexed: 0,
      coverage: {
        scannedFiles: 70_952,
        semanticEligibleFiles: 7_459,
        providerFiles: 5_121,
        providerCoveredFiles: 5_121,
        providerPrimaryFiles: 5_120,
        fullyCoveredFiles: 161,
        partialFiles: 4_959,
        fullFallbackFiles: 1,
        uncoveredFiles: 65_831,
        legacyFallbackSkippedFiles: 63_493,
        legacyFallbackFileLimit: 5_000,
        semanticEligibleFallbackFiles: 2_339,
        semanticEligibleFallbackFileLimit: 5_000,
        fallbackFiles: 2_339,
        semanticEligibilityGap: {
          totalFiles: 2_339,
          uncoveredFiles: 2_338,
          providerUnusableFiles: 1,
          outsideSemanticEligibilityFiles: 63_493,
          semanticEligibleUncoveredSamples: [
            "llvm/include/llvm/ADT/Foo.h",
            "llvm/lib/Support/Bar.cpp",
          ],
          semanticEligibleProviderUnusableSamples: ["llvm/utils/lit/lit.py"],
          outsideSemanticEligibilitySamples: ["llvm/docs/CommandGuide/foo.rst"],
        },
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first coverage: 5120/7459 semantic-eligible files provider-primary (scan scope 70952, provider docs 5121; 161 full, 4959 partial); 1 provider unusable, 65831 outside semantic eligibility or uncovered; legacy fallback parsed 2339 file(s); legacy fallback skipped 63493 file(s) over cap 5000",
      "  Provider-first semantic eligibility diagnostics:",
      "    semantic-eligible uncovered: 2338 file(s): llvm/include/llvm/ADT/Foo.h, llvm/lib/Support/Bar.cpp",
      "    semantic-eligible provider-unusable: 1 file(s): llvm/utils/lit/lit.py",
      "    outside semantic eligibility: 63493 scanned file(s): llvm/docs/CommandGuide/foo.rst",
    ]);
  });

  it("reports provider-first legacy fallback skipped by the cap", () => {
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [
        "same-run legacy fallback skipped for 39052 file(s) because providerFirst.maxLegacyFallbackFiles=5000",
      ],
      filesProcessed: 2_257,
      symbolsIndexed: 169_411,
      edgesCreated: 41_000,
      externalSymbolsIndexed: 0,
      coverage: {
        scannedFiles: 41_309,
        providerFiles: 2_257,
        providerPrimaryFiles: 2_257,
        fullyCoveredFiles: 1_000,
        partialFiles: 1_257,
        fullFallbackFiles: 92,
        uncoveredFiles: 38_960,
        legacyFallbackSkippedFiles: 39_052,
        legacyFallbackFileLimit: 5_000,
        fallbackFiles: 0,
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first coverage: 2257/41309 files provider-primary (1000 full, 1257 partial); 92 provider unusable, 38960 uncovered; legacy fallback skipped 39052 file(s) over cap 5000",
    ]);
  });

  it("reports semantic-eligible fallback skipped by the semantic cap", () => {
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 5_120,
      symbolsIndexed: 199_278,
      edgesCreated: 57_401,
      externalSymbolsIndexed: 0,
      coverage: {
        scannedFiles: 70_952,
        semanticEligibleFiles: 7_459,
        providerFiles: 5_121,
        providerCoveredFiles: 5_121,
        providerPrimaryFiles: 5_120,
        fullyCoveredFiles: 161,
        partialFiles: 4_959,
        fullFallbackFiles: 1,
        uncoveredFiles: 65_831,
        legacyFallbackSkippedFiles: 65_832,
        legacyFallbackFileLimit: 5_000,
        semanticEligibleFallbackFiles: 2_339,
        semanticEligibleFallbackFileLimit: 0,
        fallbackFiles: 0,
        semanticEligibilityGap: {
          totalFiles: 2_339,
          uncoveredFiles: 2_338,
          providerUnusableFiles: 1,
          outsideSemanticEligibilityFiles: 63_493,
          semanticEligibleUncoveredSamples: [
            "llvm/benchmarks/DummyYAML.cpp",
          ],
          semanticEligibleProviderUnusableSamples: ["llvm/utils/lit/lit.py"],
          outsideSemanticEligibilitySamples: [".ci/cache_lit_timing_files.py"],
        },
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first coverage: 5120/7459 semantic-eligible files provider-primary (scan scope 70952, provider docs 5121; 161 full, 4959 partial); 1 provider unusable, 65831 outside semantic eligibility or uncovered; legacy fallback skipped 65832 file(s) over semantic cap 0 (semantic-eligible 2339, full cap 5000)",
      "  Provider-first semantic eligibility diagnostics:",
      "    semantic-eligible uncovered: 2338 file(s): llvm/benchmarks/DummyYAML.cpp",
      "    semantic-eligible provider-unusable: 1 file(s): llvm/utils/lit/lit.py",
      "    outside semantic eligibility: 63493 scanned file(s): .ci/cache_lit_timing_files.py",
    ]);
  });

  it("reports fallback-cap shadows as skipped before staging", () => {
    const fallbackCapReason =
      "same-run legacy fallback skipped for 39052 file(s) because providerFirst.maxLegacyFallbackFiles=5000";
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [fallbackCapReason],
      filesProcessed: 2_257,
      symbolsIndexed: 169_411,
      edgesCreated: 41_000,
      externalSymbolsIndexed: 0,
      shadowBuild: {
        status: "skipped",
        activation: "shadowDb",
        requestedFormat: "csv",
        generationId: "provider-first:test",
        counts: {
          files: 2_257,
          symbols: 169_411,
          externalSymbols: 0,
          edges: 41_000,
        },
        reasons: [fallbackCapReason],
      },
      coverage: {
        scannedFiles: 41_309,
        providerFiles: 2_257,
        providerPrimaryFiles: 2_257,
        fullyCoveredFiles: 1_000,
        partialFiles: 1_257,
        fullFallbackFiles: 92,
        uncoveredFiles: 38_960,
        legacyFallbackSkippedFiles: 39_052,
        legacyFallbackFileLimit: 5_000,
        fallbackFiles: 0,
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      `  Provider-first shadow staging skipped: ${fallbackCapReason}`,
      "  Provider-first coverage: 2257/41309 files provider-primary (1000 full, 1257 partial); 92 provider unusable, 38960 uncovered; legacy fallback skipped 39052 file(s) over cap 5000",
    ]);
  });

  it("surfaces shadow DB load warnings separately from loaded row counts", () => {
    const counts = {
      repos: 1,
      files: 1,
      symbols: 2,
      fileInRepo: 1,
      symbolInFile: 1,
      symbolInRepo: 2,
      edges: 3,
    };
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 0,
      symbolsIndexed: 0,
      edgesCreated: 0,
      externalSymbolsIndexed: 0,
      shadowBuild: {
        status: "staged",
        activation: "shadowDb",
        requestedFormat: "csv",
        format: "csv",
        generationId: "provider-first:test",
        counts: {
          files: 1,
          symbols: 2,
          externalSymbols: 0,
          edges: 3,
        },
        shadowDb: {
          status: "loaded",
          path: "F:/db/provider-first-shadow/repo/provider-first-test/shadow.lbug",
          actualCounts: counts,
          expectedCounts: counts,
          secondaryIndexes: {
            attempted: 10,
            failures: [
              {
                statement: "CREATE INDEX idx_symbol_name ON Symbol(name)",
                error: "index unavailable",
              },
            ],
          },
          loadedAt: "2026-05-26T00:00:00.000Z",
          reasons: ["1 secondary index build failed"],
        },
        reasons: [],
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first shadow staging: csv files=1 symbols=2 externals=0 edges=3",
      "  Provider-first shadow DB loaded: files=1 symbols=2 edges=3",
      "  Provider-first shadow DB warning: 1 secondary index build failed",
    ]);
  });

  it("surfaces unsupported shadow DB secondary indexes without broken plurals", () => {
    const counts = {
      repos: 1,
      files: 1,
      symbols: 2,
      fileInRepo: 1,
      symbolInFile: 1,
      symbolInRepo: 2,
      edges: 3,
    };
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 0,
      symbolsIndexed: 0,
      edgesCreated: 0,
      externalSymbolsIndexed: 0,
      shadowBuild: {
        status: "staged",
        activation: "shadowDb",
        requestedFormat: "csv",
        format: "csv",
        generationId: "provider-first:test",
        counts: {
          files: 1,
          symbols: 2,
          externalSymbols: 0,
          edges: 3,
        },
        shadowDb: {
          status: "loaded",
          path: "F:/db/provider-first-shadow/repo/provider-first-test/shadow.lbug",
          actualCounts: counts,
          expectedCounts: counts,
          secondaryIndexes: {
            attempted: 30,
            failures: [],
          },
          loadedAt: "2026-05-26T00:00:00.000Z",
          reasons: [
            "secondary indexes skipped: CREATE INDEX unsupported by LadybugDB runtime (30)",
          ],
        },
        reasons: [],
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first shadow staging: csv files=1 symbols=2 externals=0 edges=3",
      "  Provider-first shadow DB loaded: files=1 symbols=2 edges=3",
      "  Provider-first shadow DB warning: secondary indexes skipped: CREATE INDEX unsupported by LadybugDB runtime (30)",
    ]);
    assert.equal(
      lines.some((line) => line.includes("faileds")),
      false,
    );
  });

  it("surfaces skipped shadow activation separately from shadow load", () => {
    const counts = {
      repos: 1,
      files: 1,
      symbols: 2,
      fileInRepo: 1,
      symbolInFile: 1,
      symbolInRepo: 2,
      edges: 3,
    };
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 0,
      symbolsIndexed: 0,
      edgesCreated: 0,
      externalSymbolsIndexed: 0,
      shadowBuild: {
        status: "staged",
        activation: "shadowDb",
        requestedFormat: "csv",
        format: "csv",
        generationId: "provider-first:test",
        counts: {
          files: 1,
          symbols: 2,
          externalSymbols: 0,
          edges: 3,
        },
        shadowDb: {
          status: "loaded",
          path: "F:/db/provider-first-shadow/repo/provider-first-test/shadow.lbug",
          actualCounts: counts,
          expectedCounts: counts,
          secondaryIndexes: { attempted: 0, failures: [] },
          loadedAt: "2026-05-26T00:00:00.000Z",
          reasons: [],
        },
        activationResult: {
          status: "skipped",
          shadowDbPath:
            "F:/db/provider-first-shadow/repo/provider-first-test/shadow.lbug",
          rollback: "notNeeded",
          reasons: [
            "legacy fallback rows are not staged into the shadow DB yet",
          ],
        },
        reasons: [],
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first shadow staging: csv files=1 symbols=2 externals=0 edges=3",
      "  Provider-first shadow DB loaded: files=1 symbols=2 edges=3",
      "  Provider-first shadow DB activation skipped: legacy fallback rows are not staged into the shadow DB yet",
    ]);
  });

  it("surfaces shadow finalization before activation handoff status", () => {
    const loadedCounts = {
      repos: 1,
      files: 2,
      symbols: 4,
      fileInRepo: 2,
      symbolInFile: 4,
      symbolInRepo: 4,
      edges: 3,
    };
    const finalizedCounts = {
      files: 2,
      symbols: 4,
      auxiliarySymbols: 0,
      edges: 5,
      versions: 1,
      symbolVersions: 4,
      metrics: 4,
      fileSummaries: 2,
      clusters: 1,
      clusterMembers: 4,
      processes: 1,
      processSteps: 3,
      shadowClusters: 0,
      shadowClusterMembers: 0,
      derivedStates: 1,
    };
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 0,
      symbolsIndexed: 0,
      edgesCreated: 0,
      externalSymbolsIndexed: 0,
      shadowBuild: {
        status: "staged",
        activation: "shadowDb",
        requestedFormat: "csv",
        format: "csv",
        generationId: "provider-first:test",
        counts: {
          files: 2,
          symbols: 4,
          externalSymbols: 0,
          edges: 3,
        },
        shadowDb: {
          status: "loaded",
          path: "F:/db/provider-first-shadow/repo/provider-first-test/shadow.lbug",
          actualCounts: loadedCounts,
          expectedCounts: loadedCounts,
          secondaryIndexes: { attempted: 0, failures: [] },
          loadedAt: "2026-05-26T00:00:00.000Z",
          reasons: [],
        },
        finalization: {
          status: "finalized",
          shadowDbPath:
            "F:/db/provider-first-shadow/repo/provider-first-test/shadow.lbug",
          copyMode: "bulkCsv",
          bulkLoad: {
            status: "loaded",
            stagingDir:
              "F:/db/provider-first-shadow/repo/provider-first-test/finalization",
            manifestPath:
              "F:/db/provider-first-shadow/repo/provider-first-test/finalization/manifest.json",
            copiedAt: "2026-05-26T00:00:01.000Z",
            artifacts: [
              {
                path: "F:/db/provider-first-shadow/repo/provider-first-test/finalization/depends-on.csv",
                columns: ["from", "to"],
                rows: 3,
                targetTable: "DEPENDS_ON",
                kind: "relationship",
              },
            ],
          },
          expectedCounts: finalizedCounts,
          actualCounts: finalizedCounts,
          finalizedAt: "2026-05-26T00:00:01.000Z",
          reasons: [],
        },
        activationResult: {
          status: "skipped",
          shadowDbPath:
            "F:/db/provider-first-shadow/repo/provider-first-test/shadow.lbug",
          rollback: "notNeeded",
          reasons: ["shadow DB activation was not attempted for this run"],
        },
        reasons: [],
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first shadow staging: csv files=2 symbols=4 externals=0 edges=3",
      "  Provider-first shadow DB loaded: files=2 symbols=4 edges=3",
      "  Provider-first shadow DB finalized: files=2 symbols=4 edges=5 versions=1 metrics=4 fileSummaries=2 copy=bulkCsv artifacts=1",
      "  Provider-first shadow DB activation skipped: shadow DB activation was not attempted for this run",
    ]);
  });

  it("surfaces provider-first phase timings when available", () => {
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 0,
      symbolsIndexed: 0,
      edgesCreated: 0,
      externalSymbolsIndexed: 0,
      phaseTimings: {
        totalMs: 123_456,
        phases: {
          providerCollection: 1_000,
          "providerCollection.metadata": 10,
          "providerCollection.documents": 110,
          "providerCollection.externalSymbols": 20,
          "providerCollection.sourceLines": 120,
          "providerCollection.normalize": 130,
          "providerCollection.normalize.coalesce": 11,
          "providerCollection.normalize.symbolInfoRelPaths": 12,
          "providerCollection.normalize.symbolDefinitionRelPaths": 13,
          "providerCollection.normalize.symbols": 14,
          "providerCollection.normalize.externalSymbols": 15,
          "providerCollection.normalize.occurrenceFacts": 16,
          "providerCollection.normalize.diagnostics": 17,
          "providerCollection.normalize.coverage": 18,
          "providerCollection.normalize.relationshipEdges": 19,
          "providerCollection.normalize.occurrenceEdges": 20,
          "providerCollection.rows": 30,
          "providerCollection.validate": 5,
          coverageScan: 2_000,
          materialize: 3_000,
          "materialize.deleteFileSymbols": 100,
          "materialize.upsertFiles": 200,
          "materialize.upsertSymbols": 300,
          "materialize.upsertSymbols.nodeAndRelCreate": 301,
          "materialize.pruneExternalSymbols": 400,
          "materialize.mergeExternalSymbols": 500,
          "materialize.insertEdges": 600,
          legacyFallback: 4_000,
          shadowStageFinal: 5_000,
          shadowFinalize: 6_000,
          shadowActivate: 7_000,
        },
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first timings: total=123456ms; slowest=activate 7000ms",
      "    collect=1000ms, scan=2000ms, materialize=3000ms, legacy=4000ms, shadowStage=5000ms, shadowFinalize=6000ms, activate=7000ms",
      "    collect: metadata=10ms, documents=110ms, externalSymbols=20ms, sourceLines=120ms, normalize=130ms, rows=30ms, validate=5ms",
      "    collect.normalize: coalesce=11ms, symbolInfoRelPaths=12ms, symbolDefinitionRelPaths=13ms, symbols=14ms, externalSymbols=15ms, occurrenceFacts=16ms, diagnostics=17ms, coverage=18ms, relationshipEdges=19ms, occurrenceEdges=20ms",
      "    materialize: deleteFileSymbols=100ms, upsertFiles=200ms, upsertSymbols=300ms, pruneExternalSymbols=400ms, mergeExternalSymbols=500ms, insertEdges=600ms",
      "    materialize.upsertSymbols: nodeAndRelCreate=301ms",
    ]);
  });

  it("surfaces legacy fallback diagnostics when provider-first must parse uncovered files", () => {
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 0,
      symbolsIndexed: 0,
      edgesCreated: 0,
      externalSymbolsIndexed: 0,
      legacyFallbackDiagnostics: {
        files: 50,
        durationMs: 69_025,
        averageMsPerFile: 1_381,
        samplePaths: [
          "tests/stress/fixtures/src/rust/lib.rs",
          "tests/stress/fixtures/src/typescript/index.ts",
          "scripts/dev-only.ts",
        ],
        phases: {
          pass1: 12_000,
          pass1Drain: 2_500,
          "pass1Drain.write.deleteOldSymbols": 125,
          "pass1Drain.write.deleteIncomingSymbols": 175,
          "pass1Drain.write.upsertFiles": 225,
          "pass1Drain.write.insertSymbolReferences": 325,
          "pass1Drain.write.upsertSymbols": 425,
          "pass1Drain.write.insertEdges": 525,
          pass2: 4_250,
          "pass2.targetSelection": 100,
          "pass2.importCache": 900,
          "pass2.resolverDispatch": 3_000,
          "pass2.writeActive": 700,
          "pass2.writeQueue": 250,
          "pass2.write.copyEnsure": 101,
          "pass2.write.copyEnsure.symbolMetadata": 40,
          "pass2.write.copyEnsure.repoLink": 61,
          "pass2.write.copyInsert": 212,
          "pass2.write.copyInsert.txnBegin": 10,
          "pass2.write.copyInsert.txnBody": 180,
          "pass2.write.copyInsert.txnCommit": 12,
          "pass2.write.copyInsert.csvMaterialize": 55,
          "pass2.write.copyInsert.copyFrom": 147,
          "pass2.write.copyInsert.tempCleanup": 10,
          "pass2.dispatch.skippedNoExistingSymbols": 12,
          "pass2.write.repairInsert": 303,
          "pass2.write.repairInsert.prepareRows": 10,
          "pass2.write.repairInsert.sourceRepoLink.symbolMetadata": 0,
          "pass2.write.repairInsert.sourceRepoLink.repoLink": 0,
          "pass2.write.repairInsert.endpointMetadata": 80,
          "pass2.write.repairInsert.targetMetadata": 90,
          "pass2.write.repairInsert.targetRepoLink": 20,
          "pass2.write.repairInsert.relationshipCreate": 70,
          "pass2.write.repairInsert.relationshipUpdate": 0,
          initSharedState: 1_100,
          refreshSymbolIndex: 120,
          resolveUnresolvedImports: 10,
          finalizeEdges: 300,
          versionSnapshot: 700,
          "versionSnapshot.latestVersion": 25,
          "versionSnapshot.createVersion": 35,
          "versionSnapshot.snapshot": 640,
          "versionSnapshot.snapshot.readPages": 250,
          "versionSnapshot.snapshot.writePages": 350,
          finalizeIndexing: 49_000,
          "finalizeIndexing.symbolStatusNormalize": 9_000,
          "finalizeIndexing.metrics": 31_000,
          "finalizeIndexing.metrics.centralityFold": 2_100,
          "finalizeIndexing.metrics.metricsFingerprint": 150,
          "finalizeIndexing.metrics.writeMetrics": 20_000,
          "finalizeIndexing.metrics.writeWait": 500,
          "finalizeIndexing.metrics.writeRows": 19_500,
          "finalizeIndexing.metrics.writeRows.csvMaterialize": 300,
          "finalizeIndexing.metrics.writeRows.deleteExisting": 1_200,
          "finalizeIndexing.metrics.writeRows.copyFrom": 18_000,
          "finalizeIndexing.metrics.writeRows.prepareRows": 40,
          "finalizeIndexing.metrics.writeRows.probeExisting": 60,
          "finalizeIndexing.metrics.writeRows.copyMissing.csvMaterialize": 70,
          "finalizeIndexing.metrics.writeRows.copyMissing.copyFrom": 80,
          "finalizeIndexing.metrics.writeRows.createMissing": 90,
          "finalizeIndexing.metrics.writeRows.mergeExisting": 100,
          "finalizeIndexing.fileSummaries": 6_000,
          "finalizeIndexing.fileSummaries.loadFiles": 100,
          "finalizeIndexing.fileSummaries.loadExportedSymbols": 200,
          "finalizeIndexing.fileSummaries.loadSymbolFacts": 300,
          "finalizeIndexing.fileSummaries.loadExistingSummaries": 400,
          "finalizeIndexing.fileSummaries.buildPayloads": 500,
          "finalizeIndexing.fileSummaries.writeSummaries": 4_500,
          "finalizeIndexing.fileSummaries.writeWait": 2_000,
          "finalizeIndexing.fileSummaries.writeExistingSummaries": 3_900,
          "finalizeIndexing.fileSummaries.writeNewSummaries": 600,
          "finalizeIndexing.qualityAudit": 3_000,
          clustersAndProcesses: 55_000,
          "clustersAndProcesses.loadSymbols": 1_000,
          "clustersAndProcesses.loadEdges": 2_000,
          "clustersAndProcesses.clusterCompute": 3_000,
          "clustersAndProcesses.loadFiles": 4_000,
          "clustersAndProcesses.clusterWrite": 5_000,
          "clustersAndProcesses.clusterWrite.loadExisting": 1_100,
          "clustersAndProcesses.clusterWrite.writeRows": 3_800,
          "clustersAndProcesses.clusterWrite.deleteRows": 900,
          "clustersAndProcesses.clusterWrite.upsertClusters": 1_200,
          "clustersAndProcesses.clusterWrite.upsertMembers": 1_700,
          "clustersAndProcesses.processCompute": 40_000,
          "clustersAndProcesses.processWrite": 6_000,
          "clustersAndProcesses.processWrite.loadExisting": 1_300,
          "clustersAndProcesses.processWrite.writeRows": 4_500,
          "clustersAndProcesses.processWrite.deleteRows": 1_000,
          "clustersAndProcesses.processWrite.upsertProcesses": 1_500,
          "clustersAndProcesses.processWrite.upsertSteps": 2_000,
          "clustersAndProcesses.algorithmStage": 7_000,
          "clustersAndProcesses.algorithmStage.centralityWorker": 2_100,
          "clustersAndProcesses.algorithmStage.centralityPrepare": 300,
          "clustersAndProcesses.algorithmStage.centralityWrite": 4_400,
          "clustersAndProcesses.algorithmStage.centralityWrite.prepareRows": 100,
          "clustersAndProcesses.algorithmStage.centralityWrite.probeExisting": 200,
          "clustersAndProcesses.algorithmStage.centralityWrite.updateExisting": 4_000,
          "clustersAndProcesses.algorithmStage.centralityWrite.mergeMissing": 100,
          buildDeferredIndexes: 180,
          "buildDeferredIndexes.secondaryIndexes": 30,
          "buildDeferredIndexes.configLoad": 20,
          "buildDeferredIndexes.retrievalIndexes": 130,
          "buildDeferredIndexes.retrieval.symbolDiscovery": 11,
          "buildDeferredIndexes.retrieval.symbolFts": 22,
          "buildDeferredIndexes.retrieval.symbolVectors": 33,
          "buildDeferredIndexes.retrieval.entityDiscovery": 44,
          "buildDeferredIndexes.retrieval.entityFts": 55,
          "buildDeferredIndexes.retrieval.fileSummaryVectors": 66,
          "buildDeferredIndexes.retrieval.agentFeedbackVectors": 77,
          memorySync: 85,
        },
        resolverBreakdown: {
          "cpp-call-resolution": {
            targets: 42,
            filesProcessed: 39,
            edgesCreated: 120,
            elapsedMs: 2_700,
            resolvedByCompiler: 0,
            resolvedByImport: 80,
            resolvedByLexical: 20,
            resolvedByGlobal: 5,
            resolvedByHeuristic: 15,
            unresolved: 6,
            ambiguous: 2,
            brokenChain: 1,
            phases: {
              readFile: 100,
              parse: 200,
              extract: 300,
              includeIndex: 400,
              resolveCalls: 500,
            },
            metrics: {
              "readFile.bytes": 9_000,
              "includeIndex.bytesRead": 8_000,
              "includeIndex.filesParsed": 10,
            },
          },
          "ts-call-resolution": {
            targets: 8,
            filesProcessed: 8,
            edgesCreated: 12,
            elapsedMs: 300,
            resolvedByCompiler: 10,
            resolvedByImport: 0,
            resolvedByLexical: 1,
            resolvedByGlobal: 0,
            resolvedByHeuristic: 1,
            unresolved: 3,
            ambiguous: 0,
            brokenChain: 0,
            phases: {},
            metrics: {},
          },
        },
        pass2WriteStats: {
          flushes: 4,
          totalEdges: 1234,
          copyFlushes: 2,
          copyEdges: 1000,
          copyPlaceholderTargets: 12,
          copyPlaceholderRows: 5,
          copyEnsuredPlaceholderRows: 3,
          copySkippedPlaceholderRows: 2,
          copyUnresolvedPlaceholderRows: 4,
          copyExternalPlaceholderRows: 1,
          repairFlushes: 3,
          repairInsertEdges: 234,
          repairEdges: 150,
          repairUnresolvedSourceEdges: 10,
          repairUnsafeSourceEndpointEdges: 20,
          repairUnsafeTargetEndpointEdges: 30,
          repairUnsafeBothEndpointEdges: 40,
          repairOtherCauseEdges: 50,
          smallKnownEndpointFlushes: 1,
          smallKnownEndpointEdges: 42,
        },
      },
      coverage: {
        scannedFiles: 1221,
        providerFiles: 1171,
        providerPrimaryFiles: 1171,
        fullyCoveredFiles: 35,
        partialFiles: 1136,
        fullFallbackFiles: 0,
        uncoveredFiles: 50,
        fallbackFiles: 50,
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first legacy fallback diagnostics: files=50 total=69025ms avg=1381ms/file; slowest=clustersAndProcesses.processCompute 40000ms",
      "    pass1=12000ms, pass1Drain=2500ms, pass2=4250ms, finalize=49000ms",
      "    pass1Drain: deleteOldSymbols=125ms, deleteIncoming=175ms, upsertFiles=225ms, symbolRefs=325ms, upsertSymbols=425ms, insertEdges=525ms",
      "    pass2: targetSelection=100ms, importCache=900ms, resolverDispatch=3000ms, writeActive=700ms, writeQueue=250ms, copyEnsure=101ms, copyEnsure.symbols=40ms, copyEnsure.repoLinks=61ms, copyInsert=212ms, copyInsert.txnBegin=10ms, copyInsert.txnBody=180ms, copyInsert.txnCommit=12ms, copyInsert.csvMaterialize=55ms, copyInsert.copyFrom=147ms, copyInsert.tempCleanup=10ms, repairInsert=303ms, repairInsert.prepareRows=10ms, repairInsert.sourceRepoLink.symbolMetadata=0ms, repairInsert.sourceRepoLink.repoLink=0ms, repairInsert.endpointMetadata=80ms, repairInsert.targetMetadata=90ms, repairInsert.targetRepoLink=20ms, repairInsert.relationshipCreate=70ms, repairInsert.relationshipUpdate=0ms",
      "    pass2.dispatch: skippedNoExistingSymbols=12",
      "    pass2.write: flushes=4, edges=1234, copyFlushes=2, copyEdges=1000, copyPlaceholders=12, copyPlaceholderRows=5, copyEnsuredRows=3, copySkippedRows=2, copyUnresolvedRows=4, copyExternalRows=1, repairFlushes=3, repairEdges=234, repairPrimaryEdges=150, repairUnresolvedSource=10, repairUnsafeSource=20, repairUnsafeTarget=30, repairUnsafeBoth=40, repairOther=50, repairCauseSum=150, repairCauseDrift=0, effectiveRepairRows=192, smallCopyFlushes=1, smallCopyEdges=42",
      "    pass2.resolvers: cpp-call-resolution targets=42 files=39 edges=120 cumulative=2700ms unresolved=6 ambiguous=2 broken=1; ts-call-resolution targets=8 files=8 edges=12 cumulative=300ms unresolved=3 ambiguous=0 broken=0",
      "    pass2.resolverPhases: cpp-call-resolution resolveCalls=500ms,includeIndex=400ms,extract=300ms,parse=200ms,readFile=100ms",
      "    pass2.resolverMetrics: cpp-call-resolution readFile.bytes=9000,includeIndex.bytesRead=8000,includeIndex.filesParsed=10",
      "    finalize: symbolStatus=9000ms, metrics=31000ms, metrics.centralityFold=2100ms, metrics.fingerprint=150ms, metrics.writeMetrics=20000ms, metrics.writeWait=500ms, metrics.writeRows=19500ms, metrics.writeRows.csvMaterialize=300ms, metrics.writeRows.deleteExisting=1200ms, metrics.writeRows.copyFrom=18000ms, metrics.writeRows.prepare=40ms, metrics.writeRows.probe=60ms, metrics.writeRows.copyMissing.csv=70ms, metrics.writeRows.copyMissing.copy=80ms, metrics.writeRows.createMissing=90ms, metrics.writeRows.mergeExisting=100ms, fileSummaries=6000ms, fileSummaries.loadFiles=100ms, fileSummaries.exports=200ms, fileSummaries.symbolFacts=300ms, fileSummaries.existing=400ms, fileSummaries.build=500ms, fileSummaries.write=4500ms, fileSummaries.writeWait=2000ms, fileSummaries.writeExisting=3900ms, fileSummaries.writeNew=600ms, qualityAudit=3000ms",
      "    derived: loadSymbols=1000ms, loadEdges=2000ms, clusterCompute=3000ms, loadFiles=4000ms, clusterWrite=5000ms, processCompute=40000ms, processWrite=6000ms, algorithmStage=7000ms",
      "    derived.clusterWrite: loadExisting=1100ms, writeRows=3800ms, deleteRows=900ms, upsertClusters=1200ms, upsertMembers=1700ms",
      "    derived.processWrite: loadExisting=1300ms, writeRows=4500ms, deleteRows=1000ms, upsertProcesses=1500ms, upsertSteps=2000ms",
      "    derived.algorithm: centralityWorker=2100ms, centralityPrepare=300ms, centralityWrite=4400ms, centralityWrite.prepare=100ms, centralityWrite.probe=200ms, centralityWrite.updateExisting=4000ms, centralityWrite.mergeMissing=100ms",
      "    version: latest=25ms, create=35ms, snapshot=640ms, readPages=250ms, writePages=350ms",
      "    deferredIndexes: secondary=30ms, config=20ms, retrieval=130ms",
      "    deferredIndexes.retrieval: symbolDiscovery=11ms, symbolFts=22ms, symbolVectors=33ms, entityDiscovery=44ms, entityFts=55ms, fileSummaryVectors=66ms, agentFeedbackVectors=77ms",
      "    other: initSharedState=1100ms, refreshSymbolIndex=120ms, imports=10ms, finalizeEdges=300ms, version=700ms, deferredIndexes=180ms, memorySync=85ms, unaccounted=0ms",
      "    fallback files: tests/stress/fixtures/src/rust/lib.rs, tests/stress/fixtures/src/typescript/index.ts, scripts/dev-only.ts",
      "  Provider-first coverage: 1171/1221 files provider-primary (35 full, 1136 partial); 50 uncovered; legacy fallback parsed 50 file(s)",
    ]);
  });

  it("surfaces auxiliary symbols when shadow finalization copies dependency placeholders", () => {
    const loadedCounts = {
      repos: 1,
      files: 1,
      symbols: 1,
      fileInRepo: 1,
      symbolInFile: 1,
      symbolInRepo: 1,
      edges: 1,
    };
    const finalizedCounts = {
      files: 1,
      symbols: 1,
      auxiliarySymbols: 2,
      edges: 3,
      versions: 1,
      symbolVersions: 1,
      metrics: 1,
      fileSummaries: 1,
      clusters: 0,
      clusterMembers: 0,
      processes: 0,
      processSteps: 0,
      shadowClusters: 0,
      shadowClusterMembers: 0,
      derivedStates: 1,
    };
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 0,
      symbolsIndexed: 0,
      edgesCreated: 0,
      externalSymbolsIndexed: 0,
      shadowBuild: {
        status: "staged",
        activation: "shadowDb",
        requestedFormat: "csv",
        format: "csv",
        generationId: "provider-first:test",
        counts: {
          files: 1,
          symbols: 1,
          externalSymbols: 0,
          edges: 1,
        },
        shadowDb: {
          status: "loaded",
          path: "F:/db/provider-first-shadow/repo/provider-first-test/shadow.lbug",
          actualCounts: loadedCounts,
          expectedCounts: loadedCounts,
          secondaryIndexes: { attempted: 0, failures: [] },
          loadedAt: "2026-05-26T00:00:00.000Z",
          reasons: [],
        },
        finalization: {
          status: "finalized",
          shadowDbPath:
            "F:/db/provider-first-shadow/repo/provider-first-test/shadow.lbug",
          copyMode: "bulkCsv",
          bulkLoad: {
            status: "loaded",
            stagingDir:
              "F:/db/provider-first-shadow/repo/provider-first-test/finalization",
            manifestPath:
              "F:/db/provider-first-shadow/repo/provider-first-test/finalization/manifest.json",
            copiedAt: "2026-05-26T00:00:01.000Z",
            artifacts: [
              {
                path: "F:/db/provider-first-shadow/repo/provider-first-test/finalization/depends-on.csv",
                columns: ["from", "to"],
                rows: 3,
                targetTable: "DEPENDS_ON",
                kind: "relationship",
              },
            ],
          },
          expectedCounts: finalizedCounts,
          actualCounts: finalizedCounts,
          finalizedAt: "2026-05-26T00:00:01.000Z",
          reasons: [],
        },
        reasons: [],
      },
    });

    assert.ok(
      lines.includes(
        "  Provider-first shadow DB finalized: files=1 symbols=1 edges=3 versions=1 metrics=1 fileSummaries=1 auxiliarySymbols=2 copy=bulkCsv artifacts=1",
      ),
    );
  });

  it("surfaces deferred semantic readiness separately from index readiness", () => {
    assert.deepEqual(formatSemanticReadinessLines(true), [
      "  Semantic readiness: deferred",
    ]);
    assert.deepEqual(formatSemanticReadinessLines(false), []);
  });

  it("surfaces skipped shadow staging without hiding coverage output", () => {
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 0,
      symbolsIndexed: 0,
      edgesCreated: 0,
      externalSymbolsIndexed: 0,
      shadowBuild: {
        status: "skipped",
        activation: "shadowDb",
        requestedFormat: "csv",
        generationId: "provider-first:test",
        counts: {
          files: 1,
          symbols: 2,
          externalSymbols: 0,
          edges: 3,
        },
        reasons: ["shadow staging failed: ENOTDIR"],
      },
      coverage: {
        scannedFiles: 1,
        providerFiles: 1,
        providerPrimaryFiles: 1,
        fullyCoveredFiles: 1,
        partialFiles: 0,
        fullFallbackFiles: 0,
        uncoveredFiles: 0,
        fallbackFiles: 0,
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first shadow staging skipped: shadow staging failed: ENOTDIR",
      "  Provider-first coverage: 1/1 files provider-primary (1 full, 0 partial)",
    ]);
  });

  it("surfaces provider call-proof incompleteness in coverage output", () => {
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 0,
      symbolsIndexed: 0,
      edgesCreated: 0,
      externalSymbolsIndexed: 0,
      coverage: {
        scannedFiles: 2,
        providerFiles: 2,
        providerPrimaryFiles: 2,
        fullyCoveredFiles: 2,
        partialFiles: 0,
        callProofIncompleteFiles: 1,
        callProofIncompleteReasons: [
          {
            code: "symbolTextMismatch",
            references: 2,
            files: 1,
            samplePaths: ["src/index.ts"],
            samples: Array.from({ length: 5 }, (_, index) => ({
              relPath: `src/index-${index}.ts`,
              range: { startLine: 2, startCol: 9, endLine: 2, endCol: 15 },
              expectedText: "helper",
              actualText: `renamed${index}`,
            })),
          },
          {
            code: "sourceTooLarge",
            references: 1,
            files: 1,
            samplePaths: ["src/huge.ts"],
          },
          {
            code: "missingSourceLine",
            references: 1,
            files: 1,
            samplePaths: ["src/missing-line.ts"],
          },
          {
            code: "sourceReadFailed",
            references: 1,
            files: 1,
            samplePaths: ["src/unreadable.ts"],
          },
          {
            code: "sourcePathOutsideRoot",
            references: 1,
            files: 1,
            samplePaths: ["../outside.ts"],
          },
          {
            code: "multiLineRange",
            references: 1,
            files: 1,
            samplePaths: ["src/multiline.ts"],
          },
        ],
        fullFallbackFiles: 0,
        uncoveredFiles: 0,
        fallbackFiles: 0,
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first coverage: 2/2 files provider-primary (2 full, 0 partial); 1 call-proof incomplete",
      "  Provider-first call-proof diagnostics:",
      "    symbol text mismatch: 2 reference(s), 1 file(s): src/index.ts",
      '      sample: src/index-0.ts:2:9-2:15 expected "helper", actual "renamed0"',
      '      sample: src/index-1.ts:2:9-2:15 expected "helper", actual "renamed1"',
      '      sample: src/index-2.ts:2:9-2:15 expected "helper", actual "renamed2"',
      '      sample: src/index-3.ts:2:9-2:15 expected "helper", actual "renamed3"',
      '      sample: src/index-4.ts:2:9-2:15 expected "helper", actual "renamed4"',
      "    source file too large: 1 reference(s), 1 file(s): src/huge.ts",
      "    missing source line: 1 reference(s), 1 file(s): src/missing-line.ts",
      "    source read failed: 1 reference(s), 1 file(s): src/unreadable.ts",
      "    source path outside repo: 1 reference(s), 1 file(s): ../outside.ts",
      "    multi-line range: 1 reference(s), 1 file(s): src/multiline.ts",
    ]);
  });
});
