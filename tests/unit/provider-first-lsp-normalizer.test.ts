import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeProviderFirstLspFull } from "../../dist/indexer/provider-first/executor.js";
import { normalizeLspProviderFacts } from "../../dist/indexer/provider-first/lsp-normalizer.js";
import { validateProviderFirstGraphRows } from "../../dist/indexer/provider-first/graph-validation.js";
import { providerFactsToGraphRows } from "../../dist/indexer/provider-first/materializer.js";

describe("provider-first LSP normalization", () => {
  it("normalizes LSP document symbols, diagnostics, coverage, and provider run facts", () => {
    const emittedAt = "2026-06-16T12:00:00.000Z";
    const facts = normalizeLspProviderFacts({
      repoId: "repo",
      generationId: "gen-lsp",
      providerId: "phpactor",
      providerVersion: "1.2.3",
      emittedAt,
      documents: [
        {
          relPath: "src/Tool.php",
          languageId: "php",
          contentHash: "a".repeat(64),
          byteSize: 128,
          symbols: [
            {
              name: "Tool",
              kind: 5,
              range: {
                start: { line: 2, character: 0 },
                end: { line: 8, character: 1 },
              },
              selectionRange: {
                start: { line: 2, character: 6 },
                end: { line: 2, character: 10 },
              },
              children: [
                {
                  name: "run",
                  kind: 6,
                  range: {
                    start: { line: 4, character: 2 },
                    end: { line: 7, character: 3 },
                  },
                  selectionRange: {
                    start: { line: 4, character: 11 },
                    end: { line: 4, character: 14 },
                  },
                },
              ],
            },
          ],
          diagnostics: [
            {
              message: "Unused import",
              severity: 2,
              code: "W001",
              range: {
                start: { line: 1, character: 0 },
                end: { line: 1, character: 10 },
              },
            },
          ],
        },
      ],
      run: {
        runId: "run-lsp",
        status: "succeeded",
        startedAt: emittedAt,
        finishedAt: emittedAt,
      },
    });

    assert.equal(facts.files.length, 1);
    assert.equal(facts.files[0]?.providerType, "lsp");
    assert.equal(facts.files[0]?.relPath, "src/Tool.php");
    assert.equal(facts.symbols.length, 2);
    assert.deepEqual(
      facts.symbols.map((symbol) => [symbol.name, symbol.symbolKind]),
      [
        ["Tool", "class"],
        ["run", "method"],
      ],
    );
    assert.equal(facts.symbols[0]?.providerType, "lsp");
    assert.equal(facts.diagnostics.length, 1);
    assert.equal(facts.diagnostics[0]?.severity, "warning");
    assert.equal(facts.coverage[0]?.symbolCoverage, "full");
    assert.equal(facts.coverage[0]?.diagnosticCoverage, "full");
    assert.equal(facts.coverage[0]?.legacyFallback, "targeted");
    assert.equal(facts.providerRuns[0]?.symbolCount, 2);
    assert.equal(facts.providerRuns[0]?.diagnosticCount, 1);

    validateProviderFirstGraphRows(providerFactsToGraphRows({ facts }), {
      repoId: "repo",
    });
  });

  it("executes a bounded LSP provider-first run through a client factory", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-lsp-provider-"));
    try {
      mkdirSync(join(repoRoot, "src"));
      writeFileSync(
        join(repoRoot, "src", "Tool.php"),
        "<?php\nclass Tool { function run() {} }\n",
      );

      const result = await executeProviderFirstLspFull({
        repoId: "repo",
        repoRoot,
        config: {
          indexing: {
            providerFirst: {
              lsp: {
                documentSymbolFileLimit: 10,
                diagnosticsLimit: 10,
              },
            },
          },
          semanticEnrichment: {
            enabled: true,
            providers: {
              lsp: {
                enabled: true,
                servers: {
                  phpactor: {
                    enabled: true,
                    serverId: "phpactor",
                    command: "phpactor",
                    args: [],
                    languages: ["php"],
                    documentLanguageIds: ["php"],
                    filePatterns: ["**/*.php"],
                    capabilities: ["documentSymbol", "diagnostic"],
                  },
                },
              },
            },
          },
        },
        clientFactory: () => ({
          async start() {
            return {
              capabilities: {
                documentSymbolProvider: true,
                diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
              },
            };
          },
          async openDocument() {},
          async documentSymbol() {
            return [
              {
                name: "Tool",
                kind: 5,
                range: {
                  start: { line: 1, character: 0 },
                  end: { line: 1, character: 37 },
                },
                selectionRange: {
                  start: { line: 1, character: 6 },
                  end: { line: 1, character: 10 },
                },
              },
            ];
          },
          diagnostics() {
            return [];
          },
          async pullDiagnostics() {
            return [];
          },
          async dispose() {},
        }),
      });

      assert.equal(result.summary.status, "executed");
      assert.equal(result.summary.executor, "lspFull");
      assert.equal(result.facts.files.length, 1);
      assert.equal(result.facts.symbols[0]?.providerType, "lsp");
      assert.equal(result.rows.symbols[0]?.source, "lsp");
      validateProviderFirstGraphRows(result.rows, { repoId: "repo" });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps LSP document symbols when pull diagnostics are unsupported", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-lsp-diagnostic-fallback-"));
    try {
      writeFileSync(
        join(repoRoot, "install.sh"),
        "BATS_ROOT=${0%/*}\nBATS_EXE_CONTENTS=1\n",
      );

      const result = await executeProviderFirstLspFull({
        repoId: "repo",
        repoRoot,
        config: {
          indexing: {
            providerFirst: {
              lsp: {
                documentSymbolFileLimit: 10,
                diagnosticsLimit: 10,
              },
            },
          },
          semanticEnrichment: {
            enabled: true,
            providers: {
              lsp: {
                enabled: true,
                servers: {
                  "bash-language-server": {
                    enabled: true,
                    serverId: "bash-language-server",
                    command: "bash-language-server",
                    args: ["start"],
                    languages: ["bash"],
                    documentLanguageIds: ["shellscript"],
                    filePatterns: ["**/*.sh"],
                    capabilities: ["documentSymbol", "diagnostics"],
                  },
                },
              },
            },
          },
        },
        clientFactory: () => ({
          async start() {
            return {
              capabilities: {
                documentSymbolProvider: true,
                diagnosticProvider: {
                  interFileDependencies: false,
                  workspaceDiagnostics: false,
                },
              },
            };
          },
          async openDocument() {},
          async documentSymbol() {
            return [
              {
                name: "BATS_EXE_CONTENTS",
                kind: 13,
                location: {
                  uri: "file:///install.sh",
                  range: {
                    start: { line: 1, character: 0 },
                    end: { line: 1, character: 19 },
                  },
                },
              },
            ];
          },
          diagnostics() {
            return [];
          },
          async pullDiagnostics() {
            throw new Error("Unhandled method textDocument/diagnostic");
          },
          async dispose() {},
        }),
      });

      assert.equal(result.facts.providerRuns[0]?.status, "succeeded");
      assert.equal(result.facts.files.length, 1);
      assert.equal(result.facts.symbols.length, 1);
      assert.equal(result.facts.symbols[0]?.name, "BATS_EXE_CONTENTS");
      assert.equal(result.rows.symbols[0]?.source, "lsp");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
