/**
 * Emitter-specific validation tests for the SCIP fixture builder.
 *
 * Each section mimics the output conventions of a real SCIP emitter
 * (scip-typescript, scip-go, rust-analyzer) and verifies:
 * 1. The fixture decodes correctly
 * 2. Kind mappings are correct for that emitter
 * 3. Emitter-specific patterns (relationships, schemes, etc.) work
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTestScipIndex } from "../fixtures/scip/builder.ts";
import { decodeScipIndex } from "../../dist/scip/proto/scip_pb.js";

// ---------------------------------------------------------------------------
// SCIP SymbolRole constants (from scip_pb.ts)
// ---------------------------------------------------------------------------
const SymbolRole = {
  Definition: 0x1,
  Import: 0x2,
  WriteAccess: 0x4,
  ReadAccess: 0x8,
  Generated: 0x10,
  Test: 0x20,
} as const;

// ---------------------------------------------------------------------------
// SCIP SymbolKind constants (subset used in tests)
// ---------------------------------------------------------------------------
const SK = {
  Class: 7,
  Constructor: 9,
  Enum: 11,
  EnumMember: 12,
  Field: 15,
  Function: 17,
  Interface: 21,
  Method: 26,
  Module: 29,
  Namespace: 30,
  Package: 35,
  Property: 41,
  Struct: 49,
  Trait: 53,
  Type: 54,
  TypeAlias: 55,
  Variable: 61,
} as const;

// ---------------------------------------------------------------------------
// scip-typescript patterns
// ---------------------------------------------------------------------------
describe("SCIP Emitter Patterns: scip-typescript", () => {
  it("should handle module-scoped function definitions", () => {
    const bytes = buildTestScipIndex({
      metadata: {
        version: 1,
        toolName: "scip-typescript",
        toolVersion: "0.3.11",
        projectRoot: "file:///home/user/my-project",
      },
      documents: [
        {
          relativePath: "src/utils.ts",
          language: "TypeScript",
          occurrences: [
            {
              range: [0, 16, 25],
              symbol:
                "scip-typescript npm my-project 1.0.0 src/utils.ts/parseLine().",
              symbolRoles: SymbolRole.Definition,
            },
            {
              range: [5, 16, 30],
              symbol:
                "scip-typescript npm my-project 1.0.0 src/utils.ts/formatOutput().",
              symbolRoles: SymbolRole.Definition,
            },
          ],
          symbols: [
            {
              symbol:
                "scip-typescript npm my-project 1.0.0 src/utils.ts/parseLine().",
              kind: SK.Function,
              displayName: "parseLine",
              documentation: ["Parse a single line of input"],
            },
            {
              symbol:
                "scip-typescript npm my-project 1.0.0 src/utils.ts/formatOutput().",
              kind: SK.Function,
              displayName: "formatOutput",
            },
          ],
        },
      ],
    });

    const index = decodeScipIndex(bytes);
    assert.equal(index.metadata?.toolInfo?.name, "scip-typescript");
    assert.equal(index.documents.length, 1);
    assert.equal(index.documents[0].language, "TypeScript");

    // Verify function kinds
    const symbols = index.documents[0].symbols;
    assert.equal(symbols.length, 2);
    assert.equal(symbols[0].kind, SK.Function);
    assert.equal(symbols[1].kind, SK.Function);
    assert.equal(symbols[0].displayName, "parseLine");
  });

  it("should handle classes with methods and properties", () => {
    const bytes = buildTestScipIndex({
      metadata: {
        version: 1,
        toolName: "scip-typescript",
        toolVersion: "0.3.11",
        projectRoot: "file:///home/user/my-project",
      },
      documents: [
        {
          relativePath: "src/server.ts",
          language: "TypeScript",
          occurrences: [
            {
              range: [2, 13, 19],
              symbol:
                "scip-typescript npm my-project 1.0.0 src/server.ts/Server#",
              symbolRoles: SymbolRole.Definition,
            },
            {
              range: [3, 10, 14],
              symbol:
                "scip-typescript npm my-project 1.0.0 src/server.ts/Server#port.",
              symbolRoles: SymbolRole.Definition,
            },
            {
              range: [5, 8, 13],
              symbol:
                "scip-typescript npm my-project 1.0.0 src/server.ts/Server#start().",
              symbolRoles: SymbolRole.Definition,
            },
          ],
          symbols: [
            {
              symbol:
                "scip-typescript npm my-project 1.0.0 src/server.ts/Server#",
              kind: SK.Class,
              displayName: "Server",
            },
            {
              symbol:
                "scip-typescript npm my-project 1.0.0 src/server.ts/Server#port.",
              kind: SK.Property,
              displayName: "port",
              enclosingSymbol:
                "scip-typescript npm my-project 1.0.0 src/server.ts/Server#",
            },
            {
              symbol:
                "scip-typescript npm my-project 1.0.0 src/server.ts/Server#start().",
              kind: SK.Method,
              displayName: "start",
              enclosingSymbol:
                "scip-typescript npm my-project 1.0.0 src/server.ts/Server#",
            },
          ],
        },
      ],
    });

    const index = decodeScipIndex(bytes);
    const symbols = index.documents[0].symbols;
    assert.equal(symbols.length, 3);

    // Class
    assert.equal(symbols[0].kind, SK.Class);
    assert.equal(symbols[0].displayName, "Server");

    // Property with enclosing symbol
    assert.equal(symbols[1].kind, SK.Property);
    assert.equal(symbols[1].enclosingSymbol, symbols[0].symbol);

    // Method with enclosing symbol
    assert.equal(symbols[2].kind, SK.Method);
    assert.equal(symbols[2].enclosingSymbol, symbols[0].symbol);
  });

  it("should handle import/export relationships", () => {
    const bytes = buildTestScipIndex({
      metadata: {
        version: 1,
        toolName: "scip-typescript",
        toolVersion: "0.3.11",
        projectRoot: "file:///home/user/my-project",
      },
      documents: [
        {
          relativePath: "src/main.ts",
          language: "TypeScript",
          occurrences: [
            {
              range: [0, 9, 18],
              symbol:
                "scip-typescript npm my-project 1.0.0 src/utils.ts/parseLine().",
              symbolRoles: SymbolRole.Import,
            },
            {
              range: [3, 2, 11],
              symbol:
                "scip-typescript npm my-project 1.0.0 src/utils.ts/parseLine().",
              symbolRoles: SymbolRole.ReadAccess,
            },
          ],
        },
      ],
      externalSymbols: [
        {
          symbol: "scip-typescript npm @types/node 18.0.0 fs/readFileSync().",
          kind: SK.Function,
          displayName: "readFileSync",
          documentation: ["Reads the contents of a file synchronously"],
        },
      ],
    });

    const index = decodeScipIndex(bytes);

    // Import occurrence
    assert.equal(
      index.documents[0].occurrences[0].symbolRoles,
      SymbolRole.Import,
    );

    // Read access occurrence
    assert.equal(
      index.documents[0].occurrences[1].symbolRoles,
      SymbolRole.ReadAccess,
    );

    // External symbol with npm scheme
    assert.equal(index.externalSymbols.length, 1);
    assert.ok(index.externalSymbols[0].symbol.includes("npm"));
    assert.equal(index.externalSymbols[0].kind, SK.Function);
  });

  it("should handle interface definitions", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "src/types.ts",
          language: "TypeScript",
          symbols: [
            {
              symbol:
                "scip-typescript npm my-project 1.0.0 src/types.ts/Config#",
              kind: SK.Interface,
              displayName: "Config",
              documentation: ["Application configuration interface"],
            },
            {
              symbol:
                "scip-typescript npm my-project 1.0.0 src/types.ts/Config#host.",
              kind: SK.Property,
              displayName: "host",
              enclosingSymbol:
                "scip-typescript npm my-project 1.0.0 src/types.ts/Config#",
            },
          ],
        },
      ],
    });

    const index = decodeScipIndex(bytes);
    assert.equal(index.documents[0].symbols[0].kind, SK.Interface);
    assert.equal(index.documents[0].symbols[1].kind, SK.Property);
    assert.equal(
      index.documents[0].symbols[1].enclosingSymbol,
      index.documents[0].symbols[0].symbol,
    );
  });
});

// ---------------------------------------------------------------------------
// scip-go patterns
// ---------------------------------------------------------------------------
describe("SCIP Emitter Patterns: scip-go", () => {
  it("should handle package-level functions", () => {
    const bytes = buildTestScipIndex({
      metadata: {
        version: 1,
        toolName: "scip-go",
        toolVersion: "0.4.0",
        projectRoot: "file:///home/user/go-project",
      },
      documents: [
        {
          relativePath: "pkg/handler/handler.go",
          language: "Go",
          occurrences: [
            {
              range: [5, 5, 16],
              symbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/handler/HandleRequest().",
              symbolRoles: SymbolRole.Definition,
            },
            {
              range: [15, 5, 21],
              symbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/handler/parseBody().",
              symbolRoles: SymbolRole.Definition,
            },
          ],
          symbols: [
            {
              symbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/handler/HandleRequest().",
              kind: SK.Function,
              displayName: "HandleRequest",
              documentation: ["HandleRequest processes incoming HTTP requests"],
            },
            {
              symbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/handler/parseBody().",
              kind: SK.Function,
              displayName: "parseBody",
            },
          ],
        },
      ],
    });

    const index = decodeScipIndex(bytes);
    assert.equal(index.metadata?.toolInfo?.name, "scip-go");
    assert.equal(index.documents[0].language, "Go");

    const symbols = index.documents[0].symbols;
    assert.equal(symbols.length, 2);
    assert.equal(symbols[0].kind, SK.Function);
    assert.equal(symbols[0].displayName, "HandleRequest");

    // Verify go scheme in symbol strings
    assert.ok(symbols[0].symbol.includes("gomod"));
    assert.ok(symbols[1].symbol.includes("gomod"));
  });

  it("should handle interface implementation via isImplementation", () => {
    const bytes = buildTestScipIndex({
      metadata: {
        version: 1,
        toolName: "scip-go",
        toolVersion: "0.4.0",
        projectRoot: "file:///home/user/go-project",
      },
      documents: [
        {
          relativePath: "pkg/store/store.go",
          language: "Go",
          symbols: [
            {
              symbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/store/Store#",
              kind: SK.Interface,
              displayName: "Store",
              documentation: ["Store defines the persistence interface"],
            },
            {
              symbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/store/Store#Get().",
              kind: SK.Method,
              displayName: "Get",
              enclosingSymbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/store/Store#",
            },
            {
              symbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/store/MemStore#",
              kind: SK.Struct,
              displayName: "MemStore",
              relationships: [
                {
                  symbol:
                    "scip-go gomod github.com/user/project v1.0.0 pkg/store/Store#",
                  isImplementation: true,
                },
              ],
            },
            {
              symbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/store/MemStore#Get().",
              kind: SK.Method,
              displayName: "Get",
              enclosingSymbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/store/MemStore#",
              relationships: [
                {
                  symbol:
                    "scip-go gomod github.com/user/project v1.0.0 pkg/store/Store#Get().",
                  isImplementation: true,
                },
              ],
            },
          ],
        },
      ],
    });

    const index = decodeScipIndex(bytes);
    const symbols = index.documents[0].symbols;

    // Interface
    assert.equal(symbols[0].kind, SK.Interface);

    // Struct implementing interface
    assert.equal(symbols[2].kind, SK.Struct);
    assert.equal(symbols[2].relationships.length, 1);
    assert.equal(symbols[2].relationships[0].isImplementation, true);
    assert.equal(symbols[2].relationships[0].symbol, symbols[0].symbol);

    // Method implementing interface method
    assert.equal(symbols[3].relationships.length, 1);
    assert.equal(symbols[3].relationships[0].isImplementation, true);
    assert.equal(symbols[3].relationships[0].symbol, symbols[1].symbol);
  });

  it("should handle struct fields", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "pkg/config/config.go",
          language: "Go",
          symbols: [
            {
              symbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/config/Config#",
              kind: SK.Struct,
              displayName: "Config",
            },
            {
              symbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/config/Config#Host.",
              kind: SK.Field,
              displayName: "Host",
              enclosingSymbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/config/Config#",
            },
            {
              symbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/config/Config#Port.",
              kind: SK.Field,
              displayName: "Port",
              enclosingSymbol:
                "scip-go gomod github.com/user/project v1.0.0 pkg/config/Config#",
            },
          ],
        },
      ],
    });

    const index = decodeScipIndex(bytes);
    const symbols = index.documents[0].symbols;
    assert.equal(symbols[0].kind, SK.Struct);
    assert.equal(symbols[1].kind, SK.Field);
    assert.equal(symbols[2].kind, SK.Field);
    assert.equal(symbols[1].enclosingSymbol, symbols[0].symbol);
    assert.equal(symbols[2].enclosingSymbol, symbols[0].symbol);
  });
});

// ---------------------------------------------------------------------------
// rust-analyzer patterns
// ---------------------------------------------------------------------------
describe("SCIP Emitter Patterns: rust-analyzer", () => {
  it("should handle trait definitions and implementations", () => {
    const bytes = buildTestScipIndex({
      metadata: {
        version: 1,
        toolName: "rust-analyzer",
        toolVersion: "0.3.0",
        projectRoot: "file:///home/user/rust-project",
      },
      documents: [
        {
          relativePath: "src/lib.rs",
          language: "Rust",
          occurrences: [
            {
              range: [2, 10, 17],
              symbol: "rust-analyzer cargo my-crate 0.1.0 src/lib.rs/Encoder#",
              symbolRoles: SymbolRole.Definition,
            },
            {
              range: [3, 7, 13],
              symbol:
                "rust-analyzer cargo my-crate 0.1.0 src/lib.rs/Encoder#encode().",
              symbolRoles: SymbolRole.Definition,
            },
            {
              range: [8, 5, 15],
              symbol:
                "rust-analyzer cargo my-crate 0.1.0 src/lib.rs/JsonEncoder#",
              symbolRoles: SymbolRole.Definition,
            },
          ],
          symbols: [
            {
              symbol: "rust-analyzer cargo my-crate 0.1.0 src/lib.rs/Encoder#",
              kind: SK.Trait,
              displayName: "Encoder",
              documentation: ["A trait for encoding values"],
            },
            {
              symbol:
                "rust-analyzer cargo my-crate 0.1.0 src/lib.rs/Encoder#encode().",
              kind: SK.Method,
              displayName: "encode",
              enclosingSymbol:
                "rust-analyzer cargo my-crate 0.1.0 src/lib.rs/Encoder#",
            },
            {
              symbol:
                "rust-analyzer cargo my-crate 0.1.0 src/lib.rs/JsonEncoder#",
              kind: SK.Struct,
              displayName: "JsonEncoder",
              relationships: [
                {
                  symbol:
                    "rust-analyzer cargo my-crate 0.1.0 src/lib.rs/Encoder#",
                  isImplementation: true,
                },
              ],
            },
          ],
        },
      ],
    });

    const index = decodeScipIndex(bytes);
    assert.equal(index.metadata?.toolInfo?.name, "rust-analyzer");
    assert.equal(index.documents[0].language, "Rust");

    const symbols = index.documents[0].symbols;

    // Trait
    assert.equal(symbols[0].kind, SK.Trait);
    assert.equal(symbols[0].displayName, "Encoder");

    // Trait method
    assert.equal(symbols[1].kind, SK.Method);
    assert.equal(symbols[1].enclosingSymbol, symbols[0].symbol);

    // Struct implementing trait
    assert.equal(symbols[2].kind, SK.Struct);
    assert.equal(symbols[2].relationships.length, 1);
    assert.equal(symbols[2].relationships[0].isImplementation, true);
    assert.equal(symbols[2].relationships[0].symbol, symbols[0].symbol);

    // Verify cargo scheme
    assert.ok(symbols[0].symbol.includes("cargo"));
  });

  it("should handle enum with variants", () => {
    const bytes = buildTestScipIndex({
      metadata: {
        version: 1,
        toolName: "rust-analyzer",
        toolVersion: "0.3.0",
        projectRoot: "file:///home/user/rust-project",
      },
      documents: [
        {
          relativePath: "src/error.rs",
          language: "Rust",
          symbols: [
            {
              symbol:
                "rust-analyzer cargo my-crate 0.1.0 src/error.rs/AppError#",
              kind: SK.Enum,
              displayName: "AppError",
            },
            {
              symbol:
                "rust-analyzer cargo my-crate 0.1.0 src/error.rs/AppError#NotFound.",
              kind: SK.EnumMember,
              displayName: "NotFound",
              enclosingSymbol:
                "rust-analyzer cargo my-crate 0.1.0 src/error.rs/AppError#",
            },
            {
              symbol:
                "rust-analyzer cargo my-crate 0.1.0 src/error.rs/AppError#InvalidInput.",
              kind: SK.EnumMember,
              displayName: "InvalidInput",
              enclosingSymbol:
                "rust-analyzer cargo my-crate 0.1.0 src/error.rs/AppError#",
            },
          ],
        },
      ],
    });

    const index = decodeScipIndex(bytes);
    const symbols = index.documents[0].symbols;
    assert.equal(symbols[0].kind, SK.Enum);
    assert.equal(symbols[1].kind, SK.EnumMember);
    assert.equal(symbols[2].kind, SK.EnumMember);
    assert.equal(symbols[1].enclosingSymbol, symbols[0].symbol);
  });

  it("should handle type aliases and module structure", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "src/types.rs",
          language: "Rust",
          symbols: [
            {
              symbol: "rust-analyzer cargo my-crate 0.1.0 src/types.rs/Result#",
              kind: SK.TypeAlias,
              displayName: "Result",
              documentation: ["Alias for std::result::Result with AppError"],
            },
          ],
        },
      ],
    });

    const index = decodeScipIndex(bytes);
    assert.equal(index.documents[0].symbols[0].kind, SK.TypeAlias);
    assert.equal(index.documents[0].symbols[0].displayName, "Result");
  });

  it("should handle external crate dependencies", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "src/main.rs",
          language: "Rust",
          occurrences: [
            {
              range: [0, 4, 9],
              symbol: "rust-analyzer cargo serde 1.0.0 serde/Serialize#",
              symbolRoles: SymbolRole.Import,
            },
          ],
        },
      ],
      externalSymbols: [
        {
          symbol: "rust-analyzer cargo serde 1.0.0 serde/Serialize#",
          kind: SK.Trait,
          displayName: "Serialize",
          documentation: ["A data structure that can be serialized"],
        },
        {
          symbol:
            "rust-analyzer cargo serde_json 1.0.0 serde_json/to_string().",
          kind: SK.Function,
          displayName: "to_string",
          documentation: ["Serialize the given data to a JSON string"],
        },
      ],
    });

    const index = decodeScipIndex(bytes);
    assert.equal(index.externalSymbols.length, 2);
    assert.equal(index.externalSymbols[0].kind, SK.Trait);
    assert.equal(index.externalSymbols[1].kind, SK.Function);
    assert.ok(index.externalSymbols[0].symbol.includes("cargo"));
    assert.ok(index.externalSymbols[1].symbol.includes("cargo"));
  });

  it("should handle impl blocks with trait methods", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "src/codec.rs",
          language: "Rust",
          symbols: [
            {
              symbol:
                "rust-analyzer cargo my-crate 0.1.0 src/codec.rs/JsonCodec#",
              kind: SK.Struct,
              displayName: "JsonCodec",
            },
            {
              symbol:
                "rust-analyzer cargo my-crate 0.1.0 src/codec.rs/JsonCodec#encode().",
              kind: SK.Method,
              displayName: "encode",
              enclosingSymbol:
                "rust-analyzer cargo my-crate 0.1.0 src/codec.rs/JsonCodec#",
              relationships: [
                {
                  symbol:
                    "rust-analyzer cargo my-crate 0.1.0 src/lib.rs/Encoder#encode().",
                  isImplementation: true,
                },
              ],
            },
            {
              symbol:
                "rust-analyzer cargo my-crate 0.1.0 src/codec.rs/JsonCodec#new().",
              kind: SK.Method,
              displayName: "new",
              enclosingSymbol:
                "rust-analyzer cargo my-crate 0.1.0 src/codec.rs/JsonCodec#",
            },
          ],
        },
      ],
    });

    const index = decodeScipIndex(bytes);
    const symbols = index.documents[0].symbols;

    // Struct
    assert.equal(symbols[0].kind, SK.Struct);

    // Method implementing trait method
    assert.equal(symbols[1].relationships.length, 1);
    assert.equal(symbols[1].relationships[0].isImplementation, true);

    // Regular impl method (no relationship)
    assert.equal(symbols[2].relationships.length, 0);
    assert.equal(symbols[2].displayName, "new");
  });
});

// ---------------------------------------------------------------------------
// Cross-emitter edge cases
// ---------------------------------------------------------------------------
describe("SCIP Emitter Patterns: cross-emitter edge cases", () => {
  it("should handle empty documents (no occurrences or symbols)", () => {
    const bytes = buildTestScipIndex({
      documents: [
        { relativePath: "empty.ts" },
        { relativePath: "also-empty.go" },
      ],
    });
    const index = decodeScipIndex(bytes);
    assert.equal(index.documents.length, 2);
    assert.equal(index.documents[0].occurrences.length, 0);
    assert.equal(index.documents[0].symbols.length, 0);
    assert.equal(index.documents[1].occurrences.length, 0);
  });

  it("should handle symbols with multiple relationships", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "src/multi.ts",
          symbols: [
            {
              symbol: "test#Multi#",
              kind: SK.Class,
              displayName: "Multi",
              relationships: [
                { symbol: "test#IFoo#", isImplementation: true },
                { symbol: "test#IBar#", isImplementation: true },
                { symbol: "test#Base#", isTypeDefinition: true },
                { symbol: "test#Mixin#", isReference: true },
              ],
            },
          ],
        },
      ],
    });
    const index = decodeScipIndex(bytes);
    const rels = index.documents[0].symbols[0].relationships;
    assert.equal(rels.length, 4);
    assert.equal(rels[0].isImplementation, true);
    assert.equal(rels[1].isImplementation, true);
    assert.equal(rels[2].isTypeDefinition, true);
    assert.equal(rels[3].isReference, true);
  });

  it("should handle large range values", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "large-file.ts",
          occurrences: [
            {
              range: [9999, 0, 10050, 80],
              symbol: "test#farAway().",
              symbolRoles: SymbolRole.Definition,
            },
          ],
        },
      ],
    });
    const index = decodeScipIndex(bytes);
    const range = index.documents[0].occurrences[0].range;
    assert.deepEqual(range, [9999, 0, 10050, 80]);
  });

  it("should handle mixed document languages in single index", () => {
    const bytes = buildTestScipIndex({
      metadata: {
        version: 1,
        toolName: "multi-emitter",
        toolVersion: "1.0.0",
        projectRoot: "file:///project",
      },
      documents: [
        {
          relativePath: "src/main.ts",
          language: "TypeScript",
          symbols: [
            {
              symbol: "ts#main().",
              kind: SK.Function,
              displayName: "main",
            },
          ],
        },
        {
          relativePath: "src/lib.rs",
          language: "Rust",
          symbols: [
            {
              symbol: "rs#process().",
              kind: SK.Function,
              displayName: "process",
            },
          ],
        },
        {
          relativePath: "pkg/handler.go",
          language: "Go",
          symbols: [
            {
              symbol: "go#Handle().",
              kind: SK.Function,
              displayName: "Handle",
            },
          ],
        },
      ],
    });

    const index = decodeScipIndex(bytes);
    assert.equal(index.documents.length, 3);
    assert.equal(index.documents[0].language, "TypeScript");
    assert.equal(index.documents[1].language, "Rust");
    assert.equal(index.documents[2].language, "Go");
  });

  it("should handle occurrences with zero symbolRoles", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "src/test.ts",
          occurrences: [
            {
              range: [0, 0, 5],
              symbol: "test#noRole().",
              // symbolRoles omitted (defaults to 0)
            },
          ],
        },
      ],
    });
    const index = decodeScipIndex(bytes);
    // symbolRoles defaults to 0 when not set
    assert.equal(index.documents[0].occurrences[0].symbolRoles, 0);
  });
});
