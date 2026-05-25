import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AppConfig,
  IndexingConfigSchema,
  ScipConfigSchema,
  SemanticEnrichmentConfigSchema,
} from "../../dist/config/types.js";
import { createProviderSymbolId } from "../../dist/indexer/provider-first/ids.js";
import {
  executeProviderFirstScipFull,
  resolveProviderFirstExecutionPlan,
} from "../../dist/indexer/provider-first/executor.js";
import { createLspProviderCacheKey } from "../../dist/indexer/provider-first/lsp-cache.js";
import {
  materializeProviderFacts,
  providerFactsToGraphRows,
} from "../../dist/indexer/provider-first/materializer.js";
import { resolveProviderFirstPipeline } from "../../dist/indexer/provider-first/planner.js";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import type { ProviderFactSet } from "../../dist/indexer/provider-first/types.js";
import { writeTestScipIndex } from "../fixtures/scip/builder.ts";

describe("provider-first indexing foundation", () => {
  it("defaults indexing to automatic provider-first selection with shadow activation", () => {
    const config = IndexingConfigSchema.parse({});

    assert.equal(config.pipeline, "auto");
    assert.equal(config.providerFirst.activation, "shadowDb");
    assert.equal(config.providerFirst.readyState, "graphPlusAlgorithms");
    assert.equal(config.providerFirst.lsp.mode, "primaryWithCaps");
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

  it("normalizes SCIP definition enclosing ranges and skips broad reference occurrences as calls", () => {
    const main =
      "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const helper =
      "scip-typescript npm example 1.0.0 src/index.ts/helper().";
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

  it("normalizes SCIP import and implementation occurrences into conservative edges", () => {
    const main =
      "scip-typescript npm example 1.0.0 src/index.ts/main().";
    const imported =
      "scip-typescript npm example 1.0.0 src/imported.ts/imported().";
    const implemented =
      "scip-typescript npm example 1.0.0 src/index.ts/Impl#";
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
    const source =
      "scip-typescript npm example 1.0.0 src/index.ts/source().";
    const target =
      "scip-typescript npm example 1.0.0 src/index.ts/target().";
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

  it("does not silently fall back for explicit providerFirst when execution is unsupported", () => {
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

    assert.equal(plan.canExecute, false);
    assert.equal(plan.shouldFallbackToLegacy, false);
    assert.match(plan.reasons.join(" "), /LSP provider-first execution/i);
  });

  it("allows auto mode to fall back when the next provider-first phase cannot execute", () => {
    const selection = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({ pipeline: "auto" }),
      scip: ScipConfigSchema.parse({
        enabled: true,
        indexes: [{ path: "index.scip" }],
      }),
    });

    const plan = resolveProviderFirstExecutionPlan({
      selection,
      mode: "incremental",
      scip: ScipConfigSchema.parse({
        enabled: true,
        indexes: [{ path: "index.scip" }],
      }),
    });

    assert.equal(plan.canExecute, false);
    assert.equal(plan.shouldFallbackToLegacy, true);
    assert.match(plan.reasons.join(" "), /full refreshes/i);
  });

  it("allows explicit providerFirst incremental refreshes to use legacy until provider incrementals exist", () => {
    const selection = resolveProviderFirstPipeline({
      indexing: IndexingConfigSchema.parse({ pipeline: "providerFirst" }),
      scip: ScipConfigSchema.parse({
        enabled: true,
        indexes: [{ path: "index.scip" }],
      }),
    });

    const plan = resolveProviderFirstExecutionPlan({
      selection,
      mode: "incremental",
      scip: ScipConfigSchema.parse({
        enabled: true,
        indexes: [{ path: "index.scip" }],
      }),
    });

    assert.equal(plan.canExecute, false);
    assert.equal(plan.shouldFallbackToLegacy, true);
    assert.equal(plan.fallbackReasonCode, "incrementalUnsupported");
    assert.match(plan.reasons.join(" "), /full refreshes/i);
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

      const progressMessages: string[] = [];
      const result = await executeProviderFirstScipFull({
        repoId: "repo",
        repoRoot,
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
          if (progress.stage === "scipIngest" && progress.message) {
            progressMessages.push(progress.message);
          }
        },
      });

      assert.equal(result.summary.filesProcessed, 600);
      assert.equal(result.facts.occurrences.length, 600 * 251);
      assert.ok(
        progressMessages.some((message) => message.endsWith("documents=600")),
      );
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
          contentHash: "content",
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
    assert.equal(rows.symbols[0]?.scipSymbol, facts.symbols[0]?.providerSymbolId);
    assert.deepEqual(JSON.parse(rows.symbols[0]?.signatureJson ?? "{}"), {
      text: "function buildGraph(): Graph",
    });
    assert.equal(rows.externalSymbols.length, 1);
    assert.equal(rows.externalSymbols[0]?.external, true);
    assert.equal(rows.edges.length, 1);
    assert.equal(rows.edges[0]?.resolverId, "provider-first:scip");
    assert.equal(rows.edges[0]?.resolutionPhase, "provider-first");
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
        symbols: [],
        externalSymbols: [],
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
            edgeType: "import",
            resolution: "exact",
            confidence: 0.95,
            dedupeKey: "symbol-1:symbol-2:import:scip",
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
});

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

class FakeQueryResult {
  close(): void {}
  async getAll(): Promise<unknown[]> {
    return [];
  }
}

function createFakeConnection(statements: string[]): import("kuzu").Connection {
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
      return new FakeQueryResult();
    },
  } as unknown as import("kuzu").Connection;
}

function countStatements(statements: string[], fragment: string): number {
  return statements.filter((statement) => statement.includes(fragment)).length;
}
