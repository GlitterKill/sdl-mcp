import { it } from "node:test";
import assert from "node:assert/strict";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import type { ScipDocument } from "../../dist/scip/types.js";

import { analyzeProviderFirstCoverage } from "../../dist/indexer/indexer.js";

it("preserves source-backed variant definitions without resolving ambiguous external references", () => {
  const symbol = "semanticdb maven fixture 1 example/Record#";
  const range = { startLine: 0, startCol: 6, endLine: 0, endCol: 12 };
  const definition = (relativePath: string): ScipDocument => ({
    relativePath,
    language: "kotlin",
    symbols: [
      {
        symbol,
        documentation: [],
        relationships: [],
        kind: 0,
        displayName: "",
      },
    ],
    occurrences: [
      {
        symbol,
        range,
        symbolRoles: 1,
        diagnostics: [],
        overrideDocumentation: [],
        syntaxKind: 0,
      },
    ],
  });
  const documents: ScipDocument[] = [
    definition("src/main/java/Record.kt"),
    definition("src/main/java16/Record.kt"),
    {
      relativePath: "src/main/java/Use.kt",
      language: "kotlin",
      symbols: [],
      occurrences: [
        {
          symbol,
          range,
          symbolRoles: 0,
          diagnostics: [],
          overrideDocumentation: [],
          syntaxKind: 0,
        },
      ],
    },
  ];
  for (const ordered of [documents, [...documents].reverse()]) {
    const facts = normalizeScipProviderFacts({
      repoId: "variants",
      generationId: "test",
      providerId: "scip-java",
      documents: ordered,
      externalSymbols: [{ symbol, documentation: [], kind: 0, displayName: "Record" }],
      sourceTextByPath: new Map(
        documents.map((d) => [d.relativePath, "class Record"]),
      ),
    });
    assert.equal(facts.symbols.length, 2);
    assert.equal(new Set(facts.symbols.map((s) => s.symbolId)).size, 2);
    for (const fact of facts.symbols) {
      const occurrence = facts.occurrences.find(
        (o) => o.relPath === fact.relPath,
      );
      assert.equal(occurrence?.symbolId, fact.symbolId);
      assert.equal(
        facts.coverage.find((c) => c.relPath === fact.relPath)?.emittedSymbols,
        1,
      );
    }
    assert.equal(
      facts.occurrences.find((o) => o.relPath.endsWith("Use.kt"))?.symbolId,
      undefined,
    );
    assert.equal(facts.edges.length, 0);
    const coverage = {
      scannedPaths: documents.map(d => d.relativePath),
      providerPaths: documents.map(d => d.relativePath),
      coverage: facts.coverage,
      symbols: facts.symbols,
    };
    assert.deepEqual(analyzeProviderFirstCoverage(coverage).fatalReasons, []);
    assert.equal(analyzeProviderFirstCoverage({
      ...coverage, symbols: [...facts.symbols, facts.symbols[0]!],
    }).fatalReasons.length, 1, "duplicate source identity must still fail readiness");
  }
});
