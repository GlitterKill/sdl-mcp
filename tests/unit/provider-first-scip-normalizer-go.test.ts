import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import type { ScipDocument } from "../../dist/scip/types.js";

const GO_PROVIDER_ID = "scip-go";
const GO_PROVIDER_VERSION = "0.1.26";
const REPO_ID = "provider-first-scip-go";
const EMITTED_AT = "2026-06-15T00:00:00.000Z";

describe("provider-first SCIP Go normalization", () => {
  it("skips scip-go synthetic package documents and strips backticked import-path module names", () => {
    const facts = normalizeScipProviderFacts({
      repoId: REPO_ID,
      generationId: "gen-go",
      providerId: GO_PROVIDER_ID,
      providerVersion: GO_PROVIDER_VERSION,
      emittedAt: EMITTED_AT,
      documents: [goSyntheticPackageDocument(), goSourceDocument()],
      sourceTextByPath: new Map([
        [
          "pkg/store/store.go",
          ["package store", "", "func NewStore() {}", ""].join("\n"),
        ],
      ]),
    });

    assert.equal(
      facts.files.some((file) => file.relPath === "."),
      false,
      "scip-go package-summary documents must not materialize as a fake repo-root file",
    );
    assert.equal(
      facts.symbols.some((symbol) => symbol.relPath === "."),
      false,
      "synthetic package-summary symbols are not source-backed SDL symbols",
    );
    assert.equal(
      facts.coverage.some((coverage) => coverage.relPath === "."),
      false,
      "synthetic package-summary documents should not drive fallback coverage",
    );

    const moduleSymbol = facts.symbols.find(
      (symbol) => symbol.symbolKind === "module",
    );
    assert.equal(moduleSymbol?.name, "store");
    assert.equal(moduleSymbol?.relPath, "pkg/store/store.go");

    const functionSymbol = facts.symbols.find(
      (symbol) => symbol.symbolKind === "function",
    );
    assert.equal(functionSymbol?.name, "NewStore");
    assert.equal(functionSymbol?.relPath, "pkg/store/store.go");
  });
});

function goSyntheticPackageDocument(): ScipDocument {
  const packageSymbol =
    "scip-go gomod example.com/project . `example.com/project/pkg/store.test`/";
  const testMainSymbol =
    "scip-go gomod example.com/project . `example.com/project/pkg/store.test`/main().";
  return {
    language: "go",
    relativePath: "",
    occurrences: [
      definition(packageSymbol, 3, 8, 12),
      definition(testMainSymbol, 96, 5, 9),
    ],
    symbols: [
      {
        symbol: packageSymbol,
        documentation: ["package main"],
        relationships: [],
        kind: 0,
        displayName: "",
      },
      {
        symbol: testMainSymbol,
        documentation: ["```go\nfunc main()\n```"],
        relationships: [],
        kind: 0,
        displayName: "",
      },
    ],
  };
}

function goSourceDocument(): ScipDocument {
  const packageSymbol =
    "scip-go gomod example.com/project . `example.com/project/pkg/store`/";
  const functionSymbol =
    "scip-go gomod example.com/project . `example.com/project/pkg/store`/NewStore().";
  return {
    language: "go",
    relativePath: "pkg/store/store.go",
    occurrences: [
      definition(packageSymbol, 0, 8, 13),
      {
        ...definition(functionSymbol, 2, 5, 13),
        enclosingRange: { startLine: 2, startCol: 0, endLine: 2, endCol: 18 },
      },
    ],
    symbols: [
      {
        symbol: packageSymbol,
        documentation: ["package store"],
        relationships: [],
        kind: 0,
        displayName: "",
      },
      {
        symbol: functionSymbol,
        documentation: ["```go\nfunc NewStore()\n```"],
        relationships: [],
        kind: 0,
        displayName: "",
      },
    ],
  };
}

function definition(
  symbol: string,
  line: number,
  startCol: number,
  endCol: number,
): ScipDocument["occurrences"][number] {
  return {
    range: { startLine: line, startCol, endLine: line, endCol },
    symbol,
    symbolRoles: 1,
    overrideDocumentation: [],
    syntaxKind: 0,
    diagnostics: [],
  };
}
