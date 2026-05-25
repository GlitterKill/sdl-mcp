import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  IndexingConfigSchema,
  ScipConfigSchema,
  SemanticEnrichmentConfigSchema,
} from "../../dist/config/types.js";
import { createProviderSymbolId } from "../../dist/indexer/provider-first/ids.js";
import { createLspProviderCacheKey } from "../../dist/indexer/provider-first/lsp-cache.js";
import { resolveProviderFirstPipeline } from "../../dist/indexer/provider-first/planner.js";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";

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
    assert.equal(facts.symbols[0]?.range?.startLine, 4);
    assert.equal(facts.occurrences.length, 1);
    assert.equal(facts.coverage[0]?.symbolCoverage, "full");
  });
});
