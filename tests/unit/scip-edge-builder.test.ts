import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildEdgesFromOccurrences,
  buildContainingSymbolMap,
  classifyEdgeAction,
  findContainingSymbol,
  getImplementationSymbols,
} from "../../dist/scip/edge-builder.js";
import type {
  ScipEdgeDescriptor,
  ExistingEdge,
} from "../../dist/scip/edge-builder.js";
import type {
  ScipDocument,
  ScipOccurrence,
  ScipRange,
  ScipSymbolMatch,
  ScipSymbolInfo,
} from "../../dist/scip/types.js";
import {
  SCIP_ROLE_DEFINITION,
  SCIP_ROLE_IMPORT,
} from "../../dist/scip/symbol-matcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRange(
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): ScipRange {
  return { startLine, startCol, endLine, endCol };
}

function makeOccurrence(
  symbol: string,
  startLine: number,
  symbolRoles = 0,
): ScipOccurrence {
  return {
    range: makeRange(startLine, 0, startLine, 10),
    symbol,
    symbolRoles,
    overrideDocumentation: [],
    syntaxKind: 0,
    diagnostics: [],
  };
}

function makeDocument(
  occurrences: ScipOccurrence[],
  symbols: ScipSymbolInfo[] = [],
): ScipDocument {
  return {
    language: "typescript",
    relativePath: "src/foo.ts",
    occurrences,
    symbols,
  };
}

function makeSdlSymbol(
  symbolId: string,
  rangeStartLine: number,
  rangeEndLine: number,
) {
  return { symbolId, rangeStartLine, rangeEndLine };
}

function makeSymbolMatch(
  scipSymbol: string,
  sdlSymbolId: string,
): ScipSymbolMatch {
  return {
    scipSymbol,
    sdlSymbolId,
    matchType: "exact",
    kindMismatch: false,
  };
}

// ---------------------------------------------------------------------------
// getImplementationSymbols
// ---------------------------------------------------------------------------

describe("getImplementationSymbols", () => {
  it("returns empty set when document has no symbols", () => {
    const doc = makeDocument([]);
    const result = getImplementationSymbols(doc);
    assert.equal(result.size, 0);
  });

  it("collects symbols with isImplementation relationship", () => {
    const doc = makeDocument(
      [],
      [
        {
          symbol: "scip-ts npm pkg 1.0.0 src/`IFoo`#",
          documentation: [],
          relationships: [
            {
              symbol: "scip-ts npm pkg 1.0.0 src/`IBar`#",
              isReference: false,
              isImplementation: true,
              isTypeDefinition: false,
              isDefinition: false,
            },
          ],
          kind: 0,
          displayName: "IFoo",
        },
        {
          symbol: "scip-ts npm pkg 1.0.0 src/`Baz`#",
          documentation: [],
          relationships: [
            {
              symbol: "scip-ts npm pkg 1.0.0 src/`Other`#",
              isReference: true,
              isImplementation: false,
              isTypeDefinition: false,
              isDefinition: false,
            },
          ],
          kind: 0,
          displayName: "Baz",
        },
      ],
    );

    const result = getImplementationSymbols(doc);
    assert.equal(result.size, 1);
    assert.ok(result.has("scip-ts npm pkg 1.0.0 src/`IFoo`#"));
    assert.ok(!result.has("scip-ts npm pkg 1.0.0 src/`Baz`#"));
  });

  it("ignores symbols with no relationships", () => {
    const doc = makeDocument(
      [],
      [
        {
          symbol: "scip-ts npm pkg 1.0.0 src/`NoRels`#",
          documentation: [],
          relationships: [],
          kind: 0,
          displayName: "NoRels",
        },
      ],
    );

    const result = getImplementationSymbols(doc);
    assert.equal(result.size, 0);
  });
});

// ---------------------------------------------------------------------------
// findContainingSymbol
// ---------------------------------------------------------------------------

describe("findContainingSymbol", () => {
  const sdlSymbols = [
    makeSdlSymbol("sym-outer", 1, 50), // lines 1-50 (1-based)
    makeSdlSymbol("sym-inner", 10, 20), // lines 10-20 (1-based)
    makeSdlSymbol("sym-other", 60, 80), // lines 60-80 (1-based)
  ];

  it("returns the containing symbol for a basic match", () => {
    // SCIP line 65 (0-based) => 1-based line 66, inside sym-other [60, 80]
    const range = makeRange(65, 0, 65, 5);
    const result = findContainingSymbol(range, sdlSymbols);
    assert.equal(result, "sym-other");
  });

  it("prefers the narrowest range when multiple symbols contain the occurrence", () => {
    // SCIP line 14 (0-based) => 1-based line 15, inside both sym-outer [1, 50] and sym-inner [10, 20]
    const range = makeRange(14, 0, 14, 5);
    const result = findContainingSymbol(range, sdlSymbols);
    assert.equal(result, "sym-inner");
  });

  it("returns null when no symbol contains the occurrence", () => {
    // SCIP line 99 (0-based) => 1-based line 100, outside all ranges
    const range = makeRange(99, 0, 99, 5);
    const result = findContainingSymbol(range, sdlSymbols);
    assert.equal(result, null);
  });

  it("converts 0-based SCIP line to 1-based correctly", () => {
    // SCIP line 0 (0-based) => 1-based line 1, which is the start of sym-outer
    const range = makeRange(0, 0, 0, 5);
    const result = findContainingSymbol(range, sdlSymbols);
    assert.equal(result, "sym-outer");
  });

  it("handles boundary lines correctly", () => {
    // SCIP line 49 (0-based) => 1-based line 50, which is the end of sym-outer
    const range = makeRange(49, 0, 49, 5);
    const result = findContainingSymbol(range, sdlSymbols);
    assert.equal(result, "sym-outer");
  });
});

// ---------------------------------------------------------------------------
// buildContainingSymbolMap
// ---------------------------------------------------------------------------

describe("buildContainingSymbolMap", () => {
  it("maps occurrence indices to containing SDL symbols", () => {
    const sdlSymbols = [
      makeSdlSymbol("sym-a", 1, 20),
      makeSdlSymbol("sym-b", 30, 50),
    ];
    const occurrences = [
      makeOccurrence("ref1", 5), // 0-based line 5 => 1-based 6, inside sym-a
      makeOccurrence("ref2", 35), // 0-based line 35 => 1-based 36, inside sym-b
      makeOccurrence("ref3", 99), // 0-based line 99 => outside all
    ];

    const map = buildContainingSymbolMap(occurrences, sdlSymbols);
    assert.equal(map.size, 2);
    assert.equal(map.get(0), "sym-a");
    assert.equal(map.get(1), "sym-b");
    assert.equal(map.has(2), false);
  });
});

// ---------------------------------------------------------------------------
// buildEdgesFromOccurrences
// ---------------------------------------------------------------------------

describe("buildEdgesFromOccurrences", () => {
  const sdlSymbols = [makeSdlSymbol("src-sym", 1, 100)];

  it("creates a call edge from a basic occurrence", () => {
    const matchMap = new Map<string, ScipSymbolMatch>();
    matchMap.set(
      "scip-ts pkg target#",
      makeSymbolMatch("scip-ts pkg target#", "tgt-sym"),
    );

    const occurrences = [
      makeOccurrence("scip-ts pkg target#", 10, 0), // reference only, no flags
    ];
    const containingMap = buildContainingSymbolMap(occurrences, sdlSymbols);
    const doc = makeDocument(occurrences);

    const edges = buildEdgesFromOccurrences(doc, matchMap, containingMap, 0.95);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].sourceSymbolId, "src-sym");
    assert.equal(edges[0].targetSymbolId, "tgt-sym");
    assert.equal(edges[0].edgeType, "call");
    assert.equal(edges[0].confidence, 0.95);
    assert.equal(edges[0].resolution, "exact");
    assert.equal(edges[0].resolverId, "scip");
    assert.equal(edges[0].resolutionPhase, "scip");
  });

  it("creates an import edge when symbolRoles has IMPORT flag", () => {
    const matchMap = new Map<string, ScipSymbolMatch>();
    matchMap.set(
      "scip-ts pkg imported#",
      makeSymbolMatch("scip-ts pkg imported#", "imp-sym"),
    );

    const occurrences = [
      makeOccurrence("scip-ts pkg imported#", 2, SCIP_ROLE_IMPORT),
    ];
    const containingMap = buildContainingSymbolMap(occurrences, sdlSymbols);
    const doc = makeDocument(occurrences);

    const edges = buildEdgesFromOccurrences(doc, matchMap, containingMap, 0.9);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].edgeType, "import");
  });

  it("creates an implements edge when symbol has isImplementation relationship", () => {
    const scipSymbol = "scip-ts pkg impl#";
    const matchMap = new Map<string, ScipSymbolMatch>();
    matchMap.set(scipSymbol, makeSymbolMatch(scipSymbol, "impl-sym"));

    const occurrences = [makeOccurrence(scipSymbol, 15, 0)];
    const containingMap = buildContainingSymbolMap(occurrences, sdlSymbols);
    const doc = makeDocument(occurrences, [
      {
        symbol: scipSymbol,
        documentation: [],
        relationships: [
          {
            symbol: "scip-ts pkg iface#",
            isReference: false,
            isImplementation: true,
            isTypeDefinition: false,
            isDefinition: false,
          },
        ],
        kind: 0,
        displayName: "Impl",
      },
    ]);

    const edges = buildEdgesFromOccurrences(doc, matchMap, containingMap, 0.95);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].edgeType, "implements");
  });

  it("skips definitions (DEFINITION flag)", () => {
    const matchMap = new Map<string, ScipSymbolMatch>();
    matchMap.set(
      "scip-ts pkg def#",
      makeSymbolMatch("scip-ts pkg def#", "def-sym"),
    );

    const occurrences = [
      makeOccurrence("scip-ts pkg def#", 5, SCIP_ROLE_DEFINITION),
    ];
    const containingMap = buildContainingSymbolMap(occurrences, sdlSymbols);
    const doc = makeDocument(occurrences);

    const edges = buildEdgesFromOccurrences(doc, matchMap, containingMap, 0.95);
    assert.equal(edges.length, 0);
  });

  it("skips occurrences where target is not in match map", () => {
    const matchMap = new Map<string, ScipSymbolMatch>(); // empty map

    const occurrences = [makeOccurrence("scip-ts pkg unknown#", 10, 0)];
    const containingMap = buildContainingSymbolMap(occurrences, sdlSymbols);
    const doc = makeDocument(occurrences);

    const edges = buildEdgesFromOccurrences(doc, matchMap, containingMap, 0.95);
    assert.equal(edges.length, 0);
  });

  it("skips occurrences where containing symbol is not found", () => {
    const matchMap = new Map<string, ScipSymbolMatch>();
    matchMap.set(
      "scip-ts pkg target#",
      makeSymbolMatch("scip-ts pkg target#", "tgt-sym"),
    );

    const occurrences = [makeOccurrence("scip-ts pkg target#", 10, 0)];
    // Use an empty containing map (no symbols matched)
    const containingMap = new Map<number, string>();
    const doc = makeDocument(occurrences);

    const edges = buildEdgesFromOccurrences(doc, matchMap, containingMap, 0.95);
    assert.equal(edges.length, 0);
  });

  it("skips self-edges", () => {
    const matchMap = new Map<string, ScipSymbolMatch>();
    matchMap.set(
      "scip-ts pkg self#",
      makeSymbolMatch("scip-ts pkg self#", "src-sym"),
    );

    const occurrences = [makeOccurrence("scip-ts pkg self#", 10, 0)];
    const containingMap = buildContainingSymbolMap(occurrences, sdlSymbols);
    const doc = makeDocument(occurrences);

    const edges = buildEdgesFromOccurrences(doc, matchMap, containingMap, 0.95);
    assert.equal(edges.length, 0);
  });

  it("produces multiple edges from multiple occurrences", () => {
    const matchMap = new Map<string, ScipSymbolMatch>();
    matchMap.set("scip-ts pkg a#", makeSymbolMatch("scip-ts pkg a#", "sym-a"));
    matchMap.set("scip-ts pkg b#", makeSymbolMatch("scip-ts pkg b#", "sym-b"));

    const occurrences = [
      makeOccurrence("scip-ts pkg a#", 10, 0),
      makeOccurrence("scip-ts pkg b#", 20, SCIP_ROLE_IMPORT),
    ];
    const containingMap = buildContainingSymbolMap(occurrences, sdlSymbols);
    const doc = makeDocument(occurrences);

    const edges = buildEdgesFromOccurrences(doc, matchMap, containingMap, 0.9);
    assert.equal(edges.length, 2);
    assert.equal(edges[0].edgeType, "call");
    assert.equal(edges[0].targetSymbolId, "sym-a");
    assert.equal(edges[1].edgeType, "import");
    assert.equal(edges[1].targetSymbolId, "sym-b");
  });
});

// ---------------------------------------------------------------------------
// classifyEdgeAction
// ---------------------------------------------------------------------------

describe("classifyEdgeAction", () => {
  const newEdge: ScipEdgeDescriptor = {
    sourceSymbolId: "src",
    targetSymbolId: "tgt",
    edgeType: "call",
    confidence: 0.95,
    resolution: "exact",
    resolverId: "scip",
    resolutionPhase: "scip",
  };

  it("returns 'create' when there is no existing edge", () => {
    const action = classifyEdgeAction(null, newEdge);
    assert.equal(action, "create");
  });

  it("returns 'upgrade' when existing edge has same target but lower confidence", () => {
    const existing: ExistingEdge = {
      sourceSymbolId: "src",
      targetSymbolId: "tgt",
      edgeType: "call",
      confidence: 0.5,
      resolution: "heuristic",
    };
    const action = classifyEdgeAction(existing, newEdge);
    assert.equal(action, "upgrade");
  });

  it("returns 'replace' when existing edge has different target and heuristic resolution", () => {
    const existing: ExistingEdge = {
      sourceSymbolId: "src",
      targetSymbolId: "old-tgt",
      edgeType: "call",
      confidence: 0.8,
      resolution: "heuristic",
    };
    const action = classifyEdgeAction(existing, newEdge);
    assert.equal(action, "replace");
  });

  it("returns 'replace' when existing edge has different target and unresolved resolution", () => {
    const existing: ExistingEdge = {
      sourceSymbolId: "src",
      targetSymbolId: "old-tgt",
      edgeType: "call",
      confidence: 0.3,
      resolution: "unresolved",
    };
    const action = classifyEdgeAction(existing, newEdge);
    assert.equal(action, "replace");
  });

  it("returns 'skip' when existing edge has same target and same confidence", () => {
    const existing: ExistingEdge = {
      sourceSymbolId: "src",
      targetSymbolId: "tgt",
      edgeType: "call",
      confidence: 0.95,
      resolution: "exact",
    };
    const action = classifyEdgeAction(existing, newEdge);
    assert.equal(action, "skip");
  });

  it("returns 'skip' when existing edge has same target and higher confidence", () => {
    const existing: ExistingEdge = {
      sourceSymbolId: "src",
      targetSymbolId: "tgt",
      edgeType: "call",
      confidence: 1.0,
      resolution: "exact",
    };
    const action = classifyEdgeAction(existing, newEdge);
    assert.equal(action, "skip");
  });

  it("returns 'upgrade' when existing edge has same target and same confidence but heuristic resolution", () => {
    // Regression guard for the equal-confidence upgrade bug. When a prior run
    // already wrote a heuristic edge at SCIP's 0.95 confidence (e.g. because
    // a config entry was set to 0.95), re-ingesting the same edge from SCIP
    // must still upgrade the resolution metadata to "exact" so downstream
    // queries filtering on resolverId/resolution see it as compiler-grade.
    const existing: ExistingEdge = {
      sourceSymbolId: "src",
      targetSymbolId: "tgt",
      edgeType: "call",
      confidence: 0.95,
      resolution: "heuristic",
    };
    const action = classifyEdgeAction(existing, newEdge);
    assert.equal(action, "upgrade");
  });

  it("returns 'skip' when existing edge has different target but exact resolution", () => {
    const existing: ExistingEdge = {
      sourceSymbolId: "src",
      targetSymbolId: "other-tgt",
      edgeType: "call",
      confidence: 0.9,
      resolution: "exact",
    };
    const action = classifyEdgeAction(existing, newEdge);
    assert.equal(action, "skip");
  });
});
