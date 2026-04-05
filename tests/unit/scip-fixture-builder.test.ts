/**
 * Tests for the SCIP fixture builder.
 *
 * Verifies that buildTestScipIndex() produces valid protobuf bytes
 * that round-trip through decodeScipIndex().
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTestScipIndex } from "../fixtures/scip/builder.ts";
import { decodeScipIndex } from "../../dist/scip/proto/scip_pb.js";

describe("SCIP Fixture Builder", () => {
  it("should create a valid empty index", () => {
    const bytes = buildTestScipIndex({});
    const index = decodeScipIndex(bytes);
    assert.ok(index);
    assert.equal(index.documents.length, 0);
    assert.equal(index.externalSymbols.length, 0);
    assert.equal(index.metadata, undefined);
  });

  it("should create index with metadata", () => {
    const bytes = buildTestScipIndex({
      metadata: {
        version: 1,
        toolName: "scip-typescript",
        toolVersion: "0.3.0",
        projectRoot: "file:///test/project",
      },
    });
    const index = decodeScipIndex(bytes);
    assert.ok(index.metadata);
    assert.equal(index.metadata.version, 1);
    assert.ok(index.metadata.toolInfo);
    assert.equal(index.metadata.toolInfo.name, "scip-typescript");
    assert.equal(index.metadata.toolInfo.version, "0.3.0");
    assert.equal(index.metadata.projectRoot, "file:///test/project");
  });

  it("should create metadata with tool arguments", () => {
    const bytes = buildTestScipIndex({
      metadata: {
        toolName: "scip-typescript",
        toolVersion: "0.3.0",
        toolArgs: ["--output", "index.scip"],
      },
    });
    const index = decodeScipIndex(bytes);
    assert.ok(index.metadata?.toolInfo);
    assert.deepEqual(index.metadata.toolInfo.arguments, [
      "--output",
      "index.scip",
    ]);
  });

  it("should create metadata with text document encoding", () => {
    const bytes = buildTestScipIndex({
      metadata: {
        version: 1,
        textDocumentEncoding: 1, // UTF8
      },
    });
    const index = decodeScipIndex(bytes);
    assert.ok(index.metadata);
    assert.equal(index.metadata.textDocumentEncoding, 1);
  });

  it("should create index with a single document", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "src/main.ts",
          language: "TypeScript",
        },
      ],
    });
    const index = decodeScipIndex(bytes);
    assert.equal(index.documents.length, 1);
    assert.equal(index.documents[0].relativePath, "src/main.ts");
    assert.equal(index.documents[0].language, "TypeScript");
    assert.equal(index.documents[0].occurrences.length, 0);
    assert.equal(index.documents[0].symbols.length, 0);
  });

  it("should create index with documents and occurrences", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "src/main.ts",
          language: "TypeScript",
          occurrences: [
            {
              range: [0, 0, 10],
              symbol: "scip-typescript npm test 1.0.0 src/main.ts/main().",
              symbolRoles: 1, // Definition
            },
            {
              range: [5, 4, 20],
              symbol: "scip-typescript npm test 1.0.0 src/util.ts/helper().",
              symbolRoles: 8, // ReadAccess
            },
          ],
          symbols: [
            {
              symbol: "scip-typescript npm test 1.0.0 src/main.ts/main().",
              kind: 17, // Function
              displayName: "main",
            },
          ],
        },
      ],
    });
    const index = decodeScipIndex(bytes);
    assert.equal(index.documents.length, 1);
    assert.equal(index.documents[0].occurrences.length, 2);
    assert.equal(index.documents[0].symbols.length, 1);

    // Check first occurrence
    const occ0 = index.documents[0].occurrences[0];
    assert.deepEqual(occ0.range, [0, 0, 10]);
    assert.equal(
      occ0.symbol,
      "scip-typescript npm test 1.0.0 src/main.ts/main().",
    );
    assert.equal(occ0.symbolRoles, 1);

    // Check second occurrence
    const occ1 = index.documents[0].occurrences[1];
    assert.deepEqual(occ1.range, [5, 4, 20]);
    assert.equal(occ1.symbolRoles, 8);

    // Check symbol info
    const sym = index.documents[0].symbols[0];
    assert.equal(sym.kind, 17);
    assert.equal(sym.displayName, "main");
  });

  it("should create index with external symbols", () => {
    const bytes = buildTestScipIndex({
      externalSymbols: [
        {
          symbol: "scip-typescript npm express 4.18.0 Router#use().",
          kind: 26, // Method
          displayName: "use",
          documentation: ["Mounts middleware"],
        },
      ],
    });
    const index = decodeScipIndex(bytes);
    assert.equal(index.externalSymbols.length, 1);
    assert.equal(index.externalSymbols[0].displayName, "use");
    assert.equal(index.externalSymbols[0].kind, 26);
    assert.deepEqual(index.externalSymbols[0].documentation, [
      "Mounts middleware",
    ]);
  });

  it("should round-trip multi-line ranges (4-element)", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "src/test.ts",
          occurrences: [
            {
              range: [10, 0, 15, 5],
              symbol: "test#multiLine().",
              symbolRoles: 1,
            },
          ],
        },
      ],
    });
    const index = decodeScipIndex(bytes);
    const range = index.documents[0].occurrences[0].range;
    assert.deepEqual(range, [10, 0, 15, 5]);
  });

  it("should round-trip single-line ranges (3-element)", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "src/test.ts",
          occurrences: [
            {
              range: [7, 2, 12],
              symbol: "test#singleLine().",
              symbolRoles: 1,
            },
          ],
        },
      ],
    });
    const index = decodeScipIndex(bytes);
    const range = index.documents[0].occurrences[0].range;
    assert.deepEqual(range, [7, 2, 12]);
  });

  it("should handle symbol relationships", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "src/impl.ts",
          symbols: [
            {
              symbol: "test#MyClass#",
              kind: 7, // Class
              displayName: "MyClass",
              relationships: [
                {
                  symbol: "test#IMyInterface#",
                  isImplementation: true,
                },
                {
                  symbol: "test#BaseClass#",
                  isDefinition: true,
                },
              ],
            },
          ],
        },
      ],
    });
    const index = decodeScipIndex(bytes);
    const sym = index.documents[0].symbols[0];
    assert.equal(sym.relationships.length, 2);
    assert.equal(sym.relationships[0].symbol, "test#IMyInterface#");
    assert.equal(sym.relationships[0].isImplementation, true);
    assert.equal(sym.relationships[1].symbol, "test#BaseClass#");
    assert.equal(sym.relationships[1].isDefinition, true);
  });

  it("should handle enclosing symbol", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "src/cls.ts",
          symbols: [
            {
              symbol: "test#MyClass#method().",
              kind: 26, // Method
              displayName: "method",
              enclosingSymbol: "test#MyClass#",
            },
          ],
        },
      ],
    });
    const index = decodeScipIndex(bytes);
    const sym = index.documents[0].symbols[0];
    assert.equal(sym.enclosingSymbol, "test#MyClass#");
  });

  it("should handle multiple documents", () => {
    const bytes = buildTestScipIndex({
      documents: [
        { relativePath: "src/a.ts", language: "TypeScript" },
        { relativePath: "src/b.ts", language: "TypeScript" },
        { relativePath: "src/c.py", language: "Python" },
      ],
    });
    const index = decodeScipIndex(bytes);
    assert.equal(index.documents.length, 3);
    assert.equal(index.documents[0].relativePath, "src/a.ts");
    assert.equal(index.documents[1].relativePath, "src/b.ts");
    assert.equal(index.documents[2].relativePath, "src/c.py");
    assert.equal(index.documents[2].language, "Python");
  });

  it("should handle syntax kind on occurrences", () => {
    const bytes = buildTestScipIndex({
      documents: [
        {
          relativePath: "src/test.ts",
          occurrences: [
            {
              range: [0, 0, 5],
              symbol: "test#foo().",
              syntaxKind: 16, // IdentifierFunctionDefinition
            },
          ],
        },
      ],
    });
    const index = decodeScipIndex(bytes);
    assert.equal(index.documents[0].occurrences[0].syntaxKind, 16);
  });

  it("should handle multiple documentation strings", () => {
    const bytes = buildTestScipIndex({
      externalSymbols: [
        {
          symbol: "test#documented().",
          documentation: [
            "First line of docs",
            "Second line of docs",
            "```typescript\nexample()\n```",
          ],
        },
      ],
    });
    const index = decodeScipIndex(bytes);
    assert.equal(index.externalSymbols[0].documentation.length, 3);
    assert.equal(
      index.externalSymbols[0].documentation[0],
      "First line of docs",
    );
    assert.equal(
      index.externalSymbols[0].documentation[2],
      "```typescript\nexample()\n```",
    );
  });

  it("should create a complete realistic index", () => {
    const bytes = buildTestScipIndex({
      metadata: {
        version: 1,
        toolName: "scip-typescript",
        toolVersion: "0.3.11",
        projectRoot: "file:///home/user/project",
      },
      documents: [
        {
          relativePath: "src/index.ts",
          language: "TypeScript",
          occurrences: [
            {
              range: [0, 9, 15],
              symbol:
                "scip-typescript npm @types/node 18.0.0 fs/readFileSync().",
              symbolRoles: 2, // Import
            },
            {
              range: [2, 16, 20],
              symbol: "scip-typescript npm project 1.0.0 src/index.ts/main().",
              symbolRoles: 1, // Definition
            },
            {
              range: [3, 2, 14],
              symbol:
                "scip-typescript npm @types/node 18.0.0 fs/readFileSync().",
              symbolRoles: 8, // ReadAccess
            },
          ],
          symbols: [
            {
              symbol: "scip-typescript npm project 1.0.0 src/index.ts/main().",
              kind: 17,
              displayName: "main",
              documentation: ["Entry point function"],
            },
          ],
        },
      ],
      externalSymbols: [
        {
          symbol: "scip-typescript npm @types/node 18.0.0 fs/readFileSync().",
          kind: 17,
          displayName: "readFileSync",
          documentation: ["Synchronously reads the entire contents of a file"],
        },
      ],
    });
    const index = decodeScipIndex(bytes);

    // Metadata
    assert.ok(index.metadata);
    assert.equal(index.metadata.toolInfo?.name, "scip-typescript");

    // Documents
    assert.equal(index.documents.length, 1);
    assert.equal(index.documents[0].occurrences.length, 3);
    assert.equal(index.documents[0].symbols.length, 1);

    // External symbols
    assert.equal(index.externalSymbols.length, 1);
    assert.equal(index.externalSymbols[0].displayName, "readFileSync");
  });
});
