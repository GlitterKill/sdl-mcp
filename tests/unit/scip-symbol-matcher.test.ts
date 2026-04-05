import { describe, it } from "node:test";
import assert from "node:assert";
import {
  matchScipToSdl,
  buildSymbolMatchMap,
  SCIP_ROLE_DEFINITION,
  SCIP_ROLE_READ_ACCESS,
} from "../../dist/scip/symbol-matcher.js";
import type { SdlSymbolForMatching } from "../../dist/scip/symbol-matcher.js";
import type { ScipDocument } from "../../dist/scip/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSdlSymbol(
  overrides: Partial<SdlSymbolForMatching> & { symbolId: string; name: string },
): SdlSymbolForMatching {
  return {
    kind: "function",
    rangeStartLine: 1,
    rangeEndLine: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// matchScipToSdl
// ---------------------------------------------------------------------------

describe("matchScipToSdl", () => {
  it("returns exact match when name and kind both match", () => {
    const sdlSymbols: SdlSymbolForMatching[] = [
      makeSdlSymbol({
        symbolId: "sym-1",
        name: "handleRequest",
        kind: "function",
        rangeStartLine: 10,
        rangeEndLine: 30,
      }),
    ];

    const result = matchScipToSdl(
      "scip-typescript npm pkg 1.0.0 src/server.ts/handleRequest().",
      {
        range: { startLine: 9, startCol: 0, endLine: 9, endCol: 13 },
        symbolRoles: SCIP_ROLE_DEFINITION,
      },
      sdlSymbols,
      "function",
    );

    assert.ok(result !== null);
    assert.strictEqual(result.sdlSymbolId, "sym-1");
    assert.strictEqual(result.matchType, "exact");
    assert.strictEqual(result.kindMismatch, false);
  });

  it("returns nameOnly match when name matches but kind differs", () => {
    const sdlSymbols: SdlSymbolForMatching[] = [
      makeSdlSymbol({
        symbolId: "sym-1",
        name: "handler",
        kind: "variable", // SDL thinks it's a variable
        rangeStartLine: 5,
        rangeEndLine: 15,
      }),
    ];

    const result = matchScipToSdl(
      "scip-typescript npm pkg 1.0.0 src/server.ts/handler().",
      {
        range: { startLine: 4, startCol: 0, endLine: 4, endCol: 7 },
        symbolRoles: SCIP_ROLE_DEFINITION,
      },
      sdlSymbols,
      "function", // SCIP says function
    );

    assert.ok(result !== null);
    assert.strictEqual(result.sdlSymbolId, "sym-1");
    assert.strictEqual(result.matchType, "nameOnly");
    assert.strictEqual(result.kindMismatch, true);
  });

  it("returns null when no name matches", () => {
    const sdlSymbols: SdlSymbolForMatching[] = [
      makeSdlSymbol({
        symbolId: "sym-1",
        name: "otherFunction",
        kind: "function",
      }),
    ];

    const result = matchScipToSdl(
      "scip-typescript npm pkg 1.0.0 src/server.ts/handleRequest().",
      {
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 13 },
        symbolRoles: SCIP_ROLE_DEFINITION,
      },
      sdlSymbols,
      "function",
    );

    assert.strictEqual(result, null);
  });

  it("prefers exact kind match over kind mismatch", () => {
    const sdlSymbols: SdlSymbolForMatching[] = [
      makeSdlSymbol({
        symbolId: "sym-var",
        name: "parse",
        kind: "variable",
        rangeStartLine: 5,
        rangeEndLine: 5,
      }),
      makeSdlSymbol({
        symbolId: "sym-fn",
        name: "parse",
        kind: "function",
        rangeStartLine: 10,
        rangeEndLine: 20,
      }),
    ];

    const result = matchScipToSdl(
      "scip-typescript npm pkg 1.0.0 src/utils.ts/parse().",
      {
        range: { startLine: 9, startCol: 0, endLine: 9, endCol: 5 },
        symbolRoles: SCIP_ROLE_DEFINITION,
      },
      sdlSymbols,
      "function",
    );

    assert.ok(result !== null);
    assert.strictEqual(result.sdlSymbolId, "sym-fn");
    assert.strictEqual(result.matchType, "exact");
    assert.strictEqual(result.kindMismatch, false);
  });

  it("uses range overlap to tiebreak among same-name same-kind symbols", () => {
    const sdlSymbols: SdlSymbolForMatching[] = [
      makeSdlSymbol({
        symbolId: "sym-overload-1",
        name: "process",
        kind: "function",
        rangeStartLine: 10,
        rangeEndLine: 20,
      }),
      makeSdlSymbol({
        symbolId: "sym-overload-2",
        name: "process",
        kind: "function",
        rangeStartLine: 50,
        rangeEndLine: 60,
      }),
    ];

    // SCIP occurrence is on line 49 (0-based) = line 50 (1-based)
    // This overlaps with sym-overload-2 (lines 50-60)
    const result = matchScipToSdl(
      "scip-typescript npm pkg 1.0.0 src/processor.ts/process().",
      {
        range: { startLine: 49, startCol: 0, endLine: 49, endCol: 7 },
        symbolRoles: SCIP_ROLE_DEFINITION,
      },
      sdlSymbols,
      "function",
    );

    assert.ok(result !== null);
    assert.strictEqual(result.sdlSymbolId, "sym-overload-2");
  });

  it("handles SCIP 0-based to SDL 1-based line conversion correctly", () => {
    const sdlSymbols: SdlSymbolForMatching[] = [
      makeSdlSymbol({
        symbolId: "sym-1",
        name: "init",
        kind: "function",
        rangeStartLine: 1, // SDL 1-based
        rangeEndLine: 5,
      }),
    ];

    // SCIP line 0 (0-based) = SDL line 1 (1-based) — should overlap
    const result = matchScipToSdl(
      "scip-typescript npm pkg 1.0.0 src/init().",
      {
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 4 },
        symbolRoles: SCIP_ROLE_DEFINITION,
      },
      sdlSymbols,
      "function",
    );

    assert.ok(result !== null);
    assert.strictEqual(result.sdlSymbolId, "sym-1");
    assert.strictEqual(result.matchType, "exact");
  });

  it("returns null for empty SDL symbols array", () => {
    const result = matchScipToSdl(
      "scip-typescript npm pkg 1.0.0 src/foo().",
      {
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 3 },
        symbolRoles: SCIP_ROLE_DEFINITION,
      },
      [],
      "function",
    );

    assert.strictEqual(result, null);
  });
});

// ---------------------------------------------------------------------------
// buildSymbolMatchMap
// ---------------------------------------------------------------------------

describe("buildSymbolMatchMap", () => {
  it("matches definition occurrences only", () => {
    const scipDocument: ScipDocument = {
      language: "typescript",
      relativePath: "src/server.ts",
      occurrences: [
        {
          range: { startLine: 5, startCol: 0, endLine: 5, endCol: 10 },
          symbol: "scip-typescript npm pkg 1.0.0 src/server.ts/handleReq().",
          symbolRoles: SCIP_ROLE_DEFINITION,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
        },
        {
          // Reference occurrence — should be skipped
          range: { startLine: 20, startCol: 2, endLine: 20, endCol: 12 },
          symbol: "scip-typescript npm pkg 1.0.0 src/server.ts/handleReq().",
          symbolRoles: SCIP_ROLE_READ_ACCESS,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
        },
      ],
      symbols: [
        {
          symbol: "scip-typescript npm pkg 1.0.0 src/server.ts/handleReq().",
          documentation: ["Handles requests"],
          relationships: [],
          kind: 12, // LSP Function
          displayName: "handleReq",
        },
      ],
    };

    const sdlSymbols: SdlSymbolForMatching[] = [
      makeSdlSymbol({
        symbolId: "sdl-1",
        name: "handleReq",
        kind: "function",
        rangeStartLine: 6,
        rangeEndLine: 15,
      }),
    ];

    const { matches: map } = buildSymbolMatchMap(scipDocument, sdlSymbols);

    assert.strictEqual(map.size, 1);
    const match = map.get(
      "scip-typescript npm pkg 1.0.0 src/server.ts/handleReq().",
    );
    assert.ok(match !== undefined);
    assert.strictEqual(match.sdlSymbolId, "sdl-1");
    assert.strictEqual(match.matchType, "exact");
  });

  it("skips local symbols", () => {
    const scipDocument: ScipDocument = {
      language: "typescript",
      relativePath: "src/foo.ts",
      occurrences: [
        {
          range: { startLine: 0, startCol: 0, endLine: 0, endCol: 5 },
          symbol: "local 42",
          symbolRoles: SCIP_ROLE_DEFINITION,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
        },
      ],
      symbols: [],
    };

    const { matches: map } = buildSymbolMatchMap(scipDocument, []);
    assert.strictEqual(map.size, 0);
  });

  it("skips empty symbol strings", () => {
    const scipDocument: ScipDocument = {
      language: "typescript",
      relativePath: "src/foo.ts",
      occurrences: [
        {
          range: { startLine: 0, startCol: 0, endLine: 0, endCol: 5 },
          symbol: "",
          symbolRoles: SCIP_ROLE_DEFINITION,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
        },
      ],
      symbols: [],
    };

    const { matches: map } = buildSymbolMatchMap(scipDocument, []);
    assert.strictEqual(map.size, 0);
  });

  it("skips symbols with unmappable kinds (e.g., type parameter)", () => {
    const scipDocument: ScipDocument = {
      language: "typescript",
      relativePath: "src/foo.ts",
      occurrences: [
        {
          range: { startLine: 0, startCol: 0, endLine: 0, endCol: 1 },
          symbol: "scip-typescript npm pkg 1.0.0 src/Foo#T[",
          symbolRoles: SCIP_ROLE_DEFINITION,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
        },
      ],
      symbols: [
        {
          symbol: "scip-typescript npm pkg 1.0.0 src/Foo#T[",
          documentation: [],
          relationships: [],
          kind: 26, // TypeParameter
          displayName: "T",
        },
      ],
    };

    const { matches: map } = buildSymbolMatchMap(scipDocument, []);
    assert.strictEqual(map.size, 0);
  });

  it("processes multiple definitions and returns first match per symbol", () => {
    const scipSymbol = "scip-typescript npm pkg 1.0.0 src/utils.ts/helper().";

    const scipDocument: ScipDocument = {
      language: "typescript",
      relativePath: "src/utils.ts",
      occurrences: [
        {
          range: { startLine: 5, startCol: 0, endLine: 5, endCol: 6 },
          symbol: scipSymbol,
          symbolRoles: SCIP_ROLE_DEFINITION,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
        },
        {
          // Second definition occurrence (e.g., overload) — should be skipped
          range: { startLine: 15, startCol: 0, endLine: 15, endCol: 6 },
          symbol: scipSymbol,
          symbolRoles: SCIP_ROLE_DEFINITION,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
        },
      ],
      symbols: [
        {
          symbol: scipSymbol,
          documentation: [],
          relationships: [],
          kind: 12, // Function
          displayName: "helper",
        },
      ],
    };

    const sdlSymbols: SdlSymbolForMatching[] = [
      makeSdlSymbol({
        symbolId: "sdl-helper",
        name: "helper",
        kind: "function",
        rangeStartLine: 6,
        rangeEndLine: 10,
      }),
    ];

    const { matches: map } = buildSymbolMatchMap(scipDocument, sdlSymbols);
    assert.strictEqual(map.size, 1);

    const match = map.get(scipSymbol);
    assert.ok(match !== undefined);
    assert.strictEqual(match.sdlSymbolId, "sdl-helper");
  });

  it("matches multiple different symbols in the same document", () => {
    const scipDocument: ScipDocument = {
      language: "typescript",
      relativePath: "src/app.ts",
      occurrences: [
        {
          range: { startLine: 0, startCol: 0, endLine: 0, endCol: 7 },
          symbol: "scip-typescript npm pkg 1.0.0 src/app.ts/AppClass#",
          symbolRoles: SCIP_ROLE_DEFINITION,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
        },
        {
          range: { startLine: 5, startCol: 2, endLine: 5, endCol: 7 },
          symbol: "scip-typescript npm pkg 1.0.0 src/app.ts/AppClass#start().",
          symbolRoles: SCIP_ROLE_DEFINITION,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
        },
      ],
      symbols: [
        {
          symbol: "scip-typescript npm pkg 1.0.0 src/app.ts/AppClass#",
          documentation: [],
          relationships: [],
          kind: 5, // Class
          displayName: "AppClass",
        },
        {
          symbol: "scip-typescript npm pkg 1.0.0 src/app.ts/AppClass#start().",
          documentation: [],
          relationships: [],
          kind: 6, // Method
          displayName: "start",
        },
      ],
    };

    const sdlSymbols: SdlSymbolForMatching[] = [
      makeSdlSymbol({
        symbolId: "sdl-class",
        name: "AppClass",
        kind: "class",
        rangeStartLine: 1,
        rangeEndLine: 20,
      }),
      makeSdlSymbol({
        symbolId: "sdl-method",
        name: "start",
        kind: "method",
        rangeStartLine: 6,
        rangeEndLine: 10,
      }),
    ];

    const { matches: map } = buildSymbolMatchMap(scipDocument, sdlSymbols);
    assert.strictEqual(map.size, 2);

    const classMatch = map.get(
      "scip-typescript npm pkg 1.0.0 src/app.ts/AppClass#",
    );
    assert.ok(classMatch !== undefined);
    assert.strictEqual(classMatch.sdlSymbolId, "sdl-class");
    assert.strictEqual(classMatch.matchType, "exact");

    const methodMatch = map.get(
      "scip-typescript npm pkg 1.0.0 src/app.ts/AppClass#start().",
    );
    assert.ok(methodMatch !== undefined);
    assert.strictEqual(methodMatch.sdlSymbolId, "sdl-method");
    assert.strictEqual(methodMatch.matchType, "exact");
  });
});
