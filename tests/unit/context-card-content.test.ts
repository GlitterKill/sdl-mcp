import assert from "node:assert/strict";
import { it } from "node:test";
import type { Connection } from "kuzu";
import type { SymbolRow } from "../../dist/db/ladybug-symbols.js";
import { estimateSymbolCardContentTokens, projectCardContent } from "../../dist/context/card-content.js";
import { estimateTokens } from "../../dist/util/tokenize.js";

it("prices metadata exactly like signature-detail card hydration", async (t) => {
  const queries = await import("../../dist/db/ladybug-queries.js");
  const config = await import("../../dist/config/loadConfig.js");
  const base: SymbolRow = {
    symbolId: "small", repoId: "repo", fileId: "file", kind: "function", name: "Small",
    exported: true, visibility: null, language: "typescript",
    rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 2, rangeEndCol: 1,
    astFingerprint: "fingerprint", signatureJson: null, summary: null,
    invariantsJson: null, sideEffectsJson: null, updatedAt: "stable",
  };
  const symbols = [
    base,
    { ...base, symbolId: "valid", signatureJson: '{"name":"Small","parameters":[]}', summary: "Useful summary" },
    { ...base, symbolId: "invalid", signatureJson: "not JSON", testCaseJson: "not JSON" },
    { ...base, symbolId: "blank", signatureJson: "[]", summary: "  \n " },
    { ...base, symbolId: "name-only", summary: "Small" },
    { ...base, symbolId: "long", summary: "Useful information. ".repeat(80),
      testCaseJson: JSON.stringify({ framework: " NODE:TEST ", title: " validates   a small card ", modifiers: ["only", "skip"] }) },
  ];
  t.mock.module("../../dist/config/loadConfig.js", {
    namedExports: { ...config, loadConfig: () => ({ cache: { enabled: false } }) },
  });
  t.mock.module("../../dist/db/ladybug-queries.js", {
    namedExports: { ...queries,
      getSymbolsByIds: async () => new Map(symbols.map((symbol) => [symbol.symbolId, symbol])),
      getFilesByIds: async () => new Map(),
      getMetricsBySymbolIds: async () => new Map(),
      getEdgesFromSymbolsForSlice: async () => new Map(),
      getClustersForSymbols: async () => new Map(),
    },
  });
  const { loadSymbolCards } = await import("../../dist/graph/slice/card-hydrator.js");
  const snapshot = {
    repoId: "repo", touchedFileIds: new Set<string>(), symbolsById: new Map(),
    filesById: new Map(), outgoingEdgesBySymbolId: new Map(), contentByFileId: new Map(),
  };
  const { cards } = await loadSymbolCards({} as Connection, symbols.map((symbol) => symbol.symbolId),
    "version", "repo", "signature", undefined, false, snapshot);
  assert.equal(cards.length, symbols.length);
  for (const symbol of symbols) {
    const card = cards.find((item) => item.symbolId === symbol.symbolId)!;
    assert.equal(estimateSymbolCardContentTokens(symbol),
      estimateTokens(JSON.stringify(projectCardContent(card))), symbol.symbolId);
  }
  assert.ok(estimateSymbolCardContentTokens(base) < 160);
});
