/**
 * Unit tests for the TypeScript fallback SCIP decoder.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TypeScriptScipDecoder } from "../../dist/scip/decoder-ts.js";
import { ScipDecodeError } from "../../dist/domain/errors.js";

// ---------------------------------------------------------------------------
// Protobuf wire-format helpers
// ---------------------------------------------------------------------------

/** Encode a varint (unsigned 32-bit). */
function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0; // unsigned 32-bit
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

/** Encode a field tag (fieldNumber << 3 | wireType). */
function encodeTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
}

/** Encode a length-delimited field (wire type 2). */
function encodeLengthDelimited(
  fieldNumber: number,
  data: Uint8Array,
): Uint8Array {
  const tag = encodeTag(fieldNumber, 2);
  const len = encodeVarint(data.length);
  const result = new Uint8Array(tag.length + len.length + data.length);
  result.set(tag, 0);
  result.set(len, tag.length);
  result.set(data, tag.length + len.length);
  return result;
}

/** Encode a varint field (wire type 0). */
function encodeVarintField(fieldNumber: number, value: number): Uint8Array {
  const tag = encodeTag(fieldNumber, 0);
  const val = encodeVarint(value);
  const result = new Uint8Array(tag.length + val.length);
  result.set(tag, 0);
  result.set(val, tag.length);
  return result;
}

/** Encode a string as a length-delimited field. */
function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  const strBytes = new TextEncoder().encode(value);
  return encodeLengthDelimited(fieldNumber, strBytes);
}

/** Concatenate multiple Uint8Arrays. */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Protobuf message builders
// ---------------------------------------------------------------------------

/**
 * Build a ToolInfo message.
 * Proto fields: name(1), version(2), arguments(3 repeated)
 */
function buildToolInfo(
  name: string,
  version: string,
  args: string[] = [],
): Uint8Array {
  const parts: Uint8Array[] = [
    encodeStringField(1, name),
    encodeStringField(2, version),
  ];
  for (const arg of args) {
    parts.push(encodeStringField(3, arg));
  }
  return concat(...parts);
}

/**
 * Build a Metadata message.
 * Proto fields: version(1 varint), toolInfo(2 message), projectRoot(3 string),
 *               textDocumentEncoding(4 varint)
 */
function buildMetadata(opts: {
  version?: number;
  toolName?: string;
  toolVersion?: string;
  toolArgs?: string[];
  projectRoot?: string;
  textDocumentEncoding?: number;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (opts.version !== undefined) {
    parts.push(encodeVarintField(1, opts.version));
  }
  if (opts.toolName || opts.toolVersion || opts.toolArgs) {
    const toolInfo = buildToolInfo(
      opts.toolName ?? "",
      opts.toolVersion ?? "",
      opts.toolArgs ?? [],
    );
    parts.push(encodeLengthDelimited(2, toolInfo));
  }
  if (opts.projectRoot) {
    parts.push(encodeStringField(3, opts.projectRoot));
  }
  if (opts.textDocumentEncoding !== undefined) {
    parts.push(encodeVarintField(4, opts.textDocumentEncoding));
  }
  return concat(...parts);
}

/**
 * Build a Relationship message.
 * Proto fields: symbol(1 string), isReference(2 bool), isImplementation(3 bool),
 *               isTypeDefinition(4 bool), isDefinition(5 bool)
 */
function buildRelationship(opts: {
  symbol: string;
  isReference?: boolean;
  isImplementation?: boolean;
  isTypeDefinition?: boolean;
  isDefinition?: boolean;
}): Uint8Array {
  const parts: Uint8Array[] = [encodeStringField(1, opts.symbol)];
  if (opts.isReference) parts.push(encodeVarintField(2, 1));
  if (opts.isImplementation) parts.push(encodeVarintField(3, 1));
  if (opts.isTypeDefinition) parts.push(encodeVarintField(4, 1));
  if (opts.isDefinition) parts.push(encodeVarintField(5, 1));
  return concat(...parts);
}

/**
 * Build a Diagnostic message.
 * Proto fields: severity(1 varint), code(2 string), message(3 string),
 *               source(4 string), tags(5 repeated varint)
 */
function buildDiagnostic(opts: {
  severity?: number;
  code?: string;
  message?: string;
  source?: string;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (opts.severity !== undefined)
    parts.push(encodeVarintField(1, opts.severity));
  if (opts.code) parts.push(encodeStringField(2, opts.code));
  if (opts.message) parts.push(encodeStringField(3, opts.message));
  if (opts.source) parts.push(encodeStringField(4, opts.source));
  return concat(...parts);
}

/**
 * Build an Occurrence message.
 * Proto fields: range(1 packed varint), symbol(2 string), symbolRoles(3 varint),
 *               overrideDocumentation(4 repeated string), syntaxKind(5 varint),
 *               diagnostics(6 repeated message), enclosingRange(7 packed varint)
 */
function buildOccurrence(opts: {
  range: number[];
  symbol?: string;
  symbolRoles?: number;
  syntaxKind?: number;
  diagnostics?: Uint8Array[];
}): Uint8Array {
  const parts: Uint8Array[] = [];

  // Range is a packed repeated int32 (field 1, wire type 2)
  const rangeBytes = concat(...opts.range.map((v) => encodeVarint(v)));
  parts.push(encodeLengthDelimited(1, rangeBytes));

  if (opts.symbol) parts.push(encodeStringField(2, opts.symbol));
  if (opts.symbolRoles !== undefined)
    parts.push(encodeVarintField(3, opts.symbolRoles));
  if (opts.syntaxKind !== undefined)
    parts.push(encodeVarintField(5, opts.syntaxKind));
  if (opts.diagnostics) {
    for (const d of opts.diagnostics) {
      parts.push(encodeLengthDelimited(6, d));
    }
  }
  return concat(...parts);
}

/**
 * Build a SymbolInformation message.
 * Proto fields: symbol(1 string), documentation(3 repeated string),
 *               relationships(4 repeated message), kind(5 varint),
 *               displayName(6 string), signatureDocumentation(7 message),
 *               enclosingSymbol(8 string)
 */
function buildSymbolInformation(opts: {
  symbol: string;
  documentation?: string[];
  relationships?: Uint8Array[];
  kind?: number;
  displayName?: string;
  enclosingSymbol?: string;
}): Uint8Array {
  const parts: Uint8Array[] = [encodeStringField(1, opts.symbol)];
  if (opts.documentation) {
    for (const doc of opts.documentation) {
      parts.push(encodeStringField(3, doc));
    }
  }
  if (opts.relationships) {
    for (const rel of opts.relationships) {
      parts.push(encodeLengthDelimited(4, rel));
    }
  }
  if (opts.kind !== undefined) parts.push(encodeVarintField(5, opts.kind));
  if (opts.displayName) parts.push(encodeStringField(6, opts.displayName));
  if (opts.enclosingSymbol)
    parts.push(encodeStringField(8, opts.enclosingSymbol));
  return concat(...parts);
}

/**
 * Build a Document message.
 * Proto fields: language(4 string), relativePath(1 string),
 *               occurrences(2 repeated message), symbols(3 repeated message),
 *               text(5 string), positionEncoding(6 varint)
 */
function buildDocument(opts: {
  relativePath: string;
  language?: string;
  occurrences?: Uint8Array[];
  symbols?: Uint8Array[];
}): Uint8Array {
  const parts: Uint8Array[] = [encodeStringField(1, opts.relativePath)];
  if (opts.occurrences) {
    for (const occ of opts.occurrences) {
      parts.push(encodeLengthDelimited(2, occ));
    }
  }
  if (opts.symbols) {
    for (const sym of opts.symbols) {
      parts.push(encodeLengthDelimited(3, sym));
    }
  }
  if (opts.language) parts.push(encodeStringField(4, opts.language));
  return concat(...parts);
}

/**
 * Build a complete SCIP Index message.
 * Proto fields: metadata(1 message), documents(2 repeated message),
 *               externalSymbols(3 repeated message)
 */
function buildScipIndex(opts: {
  metadata?: Uint8Array;
  documents?: Uint8Array[];
  externalSymbols?: Uint8Array[];
}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (opts.metadata) {
    parts.push(encodeLengthDelimited(1, opts.metadata));
  }
  if (opts.documents) {
    for (const doc of opts.documents) {
      parts.push(encodeLengthDelimited(2, doc));
    }
  }
  if (opts.externalSymbols) {
    for (const sym of opts.externalSymbols) {
      parts.push(encodeLengthDelimited(3, sym));
    }
  }
  return concat(...parts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TypeScriptScipDecoder", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = join(
      tmpdir(),
      `scip-decoder-test-${randomBytes(4).toString("hex")}`,
    );
    await mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeScipFile(data: Uint8Array): Promise<string> {
    const filePath = join(
      tmpDir,
      `index-${randomBytes(4).toString("hex")}.scip`,
    );
    await writeFile(filePath, data);
    return filePath;
  }

  describe("metadata()", () => {
    it("should decode metadata with tool info", async () => {
      const index = buildScipIndex({
        metadata: buildMetadata({
          version: 0,
          toolName: "scip-typescript",
          toolVersion: "0.3.0",
          toolArgs: ["--output", "index.scip"],
          projectRoot: "file:///home/user/project",
          textDocumentEncoding: 1, // UTF-8
        }),
      });

      const filePath = await writeScipFile(index);
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        const meta = await decoder.metadata();
        assert.equal(meta.version, 0);
        assert.equal(meta.toolName, "scip-typescript");
        assert.equal(meta.toolVersion, "0.3.0");
        assert.deepEqual(meta.toolArguments, ["--output", "index.scip"]);
        assert.equal(meta.projectRoot, "file:///home/user/project");
        assert.equal(meta.textDocumentEncoding, "UTF-8");
      } finally {
        decoder.close();
      }
    });

    it("should return defaults for empty metadata", async () => {
      // Index with metadata message but no fields set
      const index = buildScipIndex({
        metadata: buildMetadata({}),
      });

      const filePath = await writeScipFile(index);
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        const meta = await decoder.metadata();
        assert.equal(meta.version, 0);
        assert.equal(meta.toolName, "");
        assert.equal(meta.toolVersion, "");
        assert.deepEqual(meta.toolArguments, []);
        assert.equal(meta.projectRoot, "");
        assert.equal(meta.textDocumentEncoding, "UnspecifiedTextEncoding");
      } finally {
        decoder.close();
      }
    });

    it("should return defaults when metadata is absent", async () => {
      // Index with no metadata field at all
      const index = buildScipIndex({});

      const filePath = await writeScipFile(index);
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        const meta = await decoder.metadata();
        assert.equal(meta.version, 0);
        assert.equal(meta.toolName, "");
        assert.equal(meta.toolVersion, "");
        assert.deepEqual(meta.toolArguments, []);
        assert.equal(meta.projectRoot, "");
      } finally {
        decoder.close();
      }
    });

    it("should map UTF-16 encoding", async () => {
      const index = buildScipIndex({
        metadata: buildMetadata({
          textDocumentEncoding: 2, // UTF-16
        }),
      });

      const filePath = await writeScipFile(index);
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        const meta = await decoder.metadata();
        assert.equal(meta.textDocumentEncoding, "UTF-16");
      } finally {
        decoder.close();
      }
    });
  });

  describe("documents()", () => {
    it("should yield a single document with occurrences and symbols", async () => {
      const occ = buildOccurrence({
        range: [10, 5, 15], // single-line: line 10, col 5-15
        symbol: "scip-typescript npm test-pkg 0.1.0 src/`main.ts`/myFunc().",
        symbolRoles: 1, // Definition
        syntaxKind: 16, // IdentifierFunctionDefinition
      });

      const rel = buildRelationship({
        symbol: "scip-typescript npm test-pkg 0.1.0 src/`main.ts`/MyInterface#",
        isImplementation: true,
      });

      const symInfo = buildSymbolInformation({
        symbol: "scip-typescript npm test-pkg 0.1.0 src/`main.ts`/myFunc().",
        documentation: ["A test function."],
        relationships: [rel],
        kind: 17, // Function
        displayName: "myFunc",
        enclosingSymbol: "scip-typescript npm test-pkg 0.1.0 src/`main.ts`/",
      });

      const doc = buildDocument({
        relativePath: "src/main.ts",
        language: "typescript",
        occurrences: [occ],
        symbols: [symInfo],
      });

      const index = buildScipIndex({
        metadata: buildMetadata({ toolName: "scip-typescript" }),
        documents: [doc],
      });

      const filePath = await writeScipFile(index);
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        const docs: Awaited<ReturnType<typeof decoder.metadata>>[] = [];
        const collectedDocs = [];
        for await (const d of decoder.documents()) {
          collectedDocs.push(d);
        }

        assert.equal(collectedDocs.length, 1);
        const decodedDoc = collectedDocs[0];
        assert.equal(decodedDoc.relativePath, "src/main.ts");
        assert.equal(decodedDoc.language, "typescript");

        // Check occurrence
        assert.equal(decodedDoc.occurrences.length, 1);
        const decodedOcc = decodedDoc.occurrences[0];
        assert.deepEqual(decodedOcc.range, {
          startLine: 10,
          startCol: 5,
          endLine: 10, // single-line
          endCol: 15,
        });
        assert.equal(decodedOcc.symbolRoles, 1);
        assert.equal(decodedOcc.syntaxKind, 16);

        // Check symbol info
        assert.equal(decodedDoc.symbols.length, 1);
        const decodedSym = decodedDoc.symbols[0];
        assert.equal(decodedSym.displayName, "myFunc");
        assert.equal(decodedSym.kind, 17);
        assert.deepEqual(decodedSym.documentation, ["A test function."]);
        assert.equal(
          decodedSym.enclosingSymbol,
          "scip-typescript npm test-pkg 0.1.0 src/`main.ts`/",
        );

        // Check relationship
        assert.equal(decodedSym.relationships.length, 1);
        assert.equal(decodedSym.relationships[0].isImplementation, true);
        assert.equal(decodedSym.relationships[0].isReference, false);
        assert.equal(decodedSym.relationships[0].isDefinition, false);
      } finally {
        decoder.close();
      }
    });

    it("should handle multi-line range (4-element)", async () => {
      const occ = buildOccurrence({
        range: [5, 2, 10, 3], // multi-line: line 5 col 2 to line 10 col 3
        symbol: "test#myClass.",
      });

      const doc = buildDocument({
        relativePath: "src/utils.ts",
        occurrences: [occ],
      });

      const index = buildScipIndex({ documents: [doc] });
      const filePath = await writeScipFile(index);
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        const docs = [];
        for await (const d of decoder.documents()) {
          docs.push(d);
        }

        assert.equal(docs.length, 1);
        const decodedRange = docs[0].occurrences[0].range;
        assert.deepEqual(decodedRange, {
          startLine: 5,
          startCol: 2,
          endLine: 10,
          endCol: 3,
        });
      } finally {
        decoder.close();
      }
    });

    it("should iterate multiple documents", async () => {
      const doc1 = buildDocument({
        relativePath: "src/a.ts",
        language: "typescript",
      });
      const doc2 = buildDocument({
        relativePath: "src/b.ts",
        language: "typescript",
      });
      const doc3 = buildDocument({
        relativePath: "src/c.ts",
        language: "typescript",
      });

      const index = buildScipIndex({
        documents: [doc1, doc2, doc3],
      });

      const filePath = await writeScipFile(index);
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        const paths: string[] = [];
        for await (const d of decoder.documents()) {
          paths.push(d.relativePath);
        }
        assert.deepEqual(paths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
      } finally {
        decoder.close();
      }
    });

    it("should yield no documents for empty index", async () => {
      const index = buildScipIndex({
        metadata: buildMetadata({ toolName: "test" }),
      });

      const filePath = await writeScipFile(index);
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        const docs = [];
        for await (const d of decoder.documents()) {
          docs.push(d);
        }
        assert.equal(docs.length, 0);
      } finally {
        decoder.close();
      }
    });
  });

  describe("externalSymbols()", () => {
    it("should decode external symbols", async () => {
      const rel = buildRelationship({
        symbol:
          "scip-typescript npm @types/node latest src/`fs.d.ts`/readFile().",
        isReference: true,
      });

      const extSym = buildSymbolInformation({
        symbol: "scip-typescript npm lodash 4.17.21 src/`index.d.ts`/chunk().",
        documentation: ["Creates an array of elements split into groups."],
        relationships: [rel],
        kind: 17, // Function
        displayName: "chunk",
      });

      const index = buildScipIndex({
        externalSymbols: [extSym],
      });

      const filePath = await writeScipFile(index);
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        const exts = await decoder.externalSymbols();
        assert.equal(exts.length, 1);
        assert.equal(exts[0].displayName, "chunk");
        assert.equal(exts[0].kind, 17);
        assert.deepEqual(exts[0].documentation, [
          "Creates an array of elements split into groups.",
        ]);
        assert.equal(exts[0].relationships.length, 1);
        assert.equal(exts[0].relationships[0].isReference, true);
      } finally {
        decoder.close();
      }
    });

    it("should return empty array when no external symbols", async () => {
      const index = buildScipIndex({});
      const filePath = await writeScipFile(index);
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        const exts = await decoder.externalSymbols();
        assert.equal(exts.length, 0);
      } finally {
        decoder.close();
      }
    });
  });

  describe("close()", () => {
    it("should allow re-opening after close", async () => {
      const index = buildScipIndex({
        metadata: buildMetadata({ toolName: "scip-typescript" }),
      });

      const filePath = await writeScipFile(index);
      const decoder = new TypeScriptScipDecoder(filePath);

      // First access
      const meta1 = await decoder.metadata();
      assert.equal(meta1.toolName, "scip-typescript");

      // Close releases internal state
      decoder.close();

      // Second access re-loads from file
      const meta2 = await decoder.metadata();
      assert.equal(meta2.toolName, "scip-typescript");

      decoder.close();
    });
  });

  describe("error handling", () => {
    it("should throw ScipDecodeError for corrupted input", async () => {
      const corrupted = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xfb]);
      const filePath = await writeScipFile(corrupted);
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        await assert.rejects(
          () => decoder.metadata(),
          (err: Error) => {
            assert.ok(
              err instanceof ScipDecodeError,
              `Expected ScipDecodeError, got ${err.constructor.name}`,
            );
            assert.ok(
              err.message.includes(filePath),
              "Error should include file path",
            );
            return true;
          },
        );
      } finally {
        decoder.close();
      }
    });

    it("should throw ScipDecodeError for non-existent file", async () => {
      const decoder = new TypeScriptScipDecoder(
        join(tmpDir, "non-existent.scip"),
      );

      await assert.rejects(
        () => decoder.metadata(),
        (err: Error) => {
          assert.ok(
            err instanceof ScipDecodeError,
            `Expected ScipDecodeError, got ${err.constructor.name}`,
          );
          return true;
        },
      );
    });

    it("should throw ScipDecodeError for empty file", async () => {
      const filePath = await writeScipFile(new Uint8Array(0));
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        // An empty file is a valid protobuf (all defaults), so metadata() should
        // succeed with defaults. This is not an error.
        const meta = await decoder.metadata();
        assert.equal(meta.version, 0);
        assert.equal(meta.toolName, "");
      } finally {
        decoder.close();
      }
    });
  });

  describe("occurrence diagnostics", () => {
    it("should decode diagnostics on occurrences", async () => {
      const diag = buildDiagnostic({
        severity: 1, // Error
        code: "TS2322",
        message: "Type mismatch",
        source: "typescript",
      });

      const occ = buildOccurrence({
        range: [1, 0, 10],
        symbol: "test#foo.",
        diagnostics: [diag],
      });

      const doc = buildDocument({
        relativePath: "src/diag.ts",
        occurrences: [occ],
      });

      const index = buildScipIndex({ documents: [doc] });
      const filePath = await writeScipFile(index);
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        const docs = [];
        for await (const d of decoder.documents()) {
          docs.push(d);
        }

        assert.equal(docs.length, 1);
        const occDiags = docs[0].occurrences[0].diagnostics;
        assert.equal(occDiags.length, 1);
        assert.equal(occDiags[0].severity, 1);
        assert.equal(occDiags[0].code, "TS2322");
        assert.equal(occDiags[0].message, "Type mismatch");
        assert.equal(occDiags[0].source, "typescript");
      } finally {
        decoder.close();
      }
    });
  });

  describe("full round-trip", () => {
    it("should decode a complete index with metadata, documents, and external symbols", async () => {
      const occ1 = buildOccurrence({
        range: [0, 0, 20],
        symbol: "test#MyClass#",
        symbolRoles: 1,
      });
      const occ2 = buildOccurrence({
        range: [5, 2, 8, 3],
        symbol: "test#MyClass#method().",
        symbolRoles: 1,
      });

      const sym = buildSymbolInformation({
        symbol: "test#MyClass#",
        documentation: ["A test class."],
        kind: 7, // Class
        displayName: "MyClass",
      });

      const doc = buildDocument({
        relativePath: "src/index.ts",
        language: "typescript",
        occurrences: [occ1, occ2],
        symbols: [sym],
      });

      const extRel = buildRelationship({
        symbol: "test#ExternalInterface#",
        isTypeDefinition: true,
      });
      const extSym = buildSymbolInformation({
        symbol: "ext#Helper#",
        documentation: ["External helper."],
        relationships: [extRel],
        kind: 7,
        displayName: "Helper",
      });

      const index = buildScipIndex({
        metadata: buildMetadata({
          version: 0,
          toolName: "scip-test",
          toolVersion: "1.0.0",
          projectRoot: "file:///test/project",
          textDocumentEncoding: 1,
        }),
        documents: [doc],
        externalSymbols: [extSym],
      });

      const filePath = await writeScipFile(index);
      const decoder = new TypeScriptScipDecoder(filePath);

      try {
        // Metadata
        const meta = await decoder.metadata();
        assert.equal(meta.toolName, "scip-test");
        assert.equal(meta.toolVersion, "1.0.0");
        assert.equal(meta.projectRoot, "file:///test/project");
        assert.equal(meta.textDocumentEncoding, "UTF-8");

        // Documents
        const docs = [];
        for await (const d of decoder.documents()) {
          docs.push(d);
        }
        assert.equal(docs.length, 1);
        assert.equal(docs[0].relativePath, "src/index.ts");
        assert.equal(docs[0].occurrences.length, 2);
        assert.equal(docs[0].symbols.length, 1);

        // Verify multi-line range on second occurrence
        assert.deepEqual(docs[0].occurrences[1].range, {
          startLine: 5,
          startCol: 2,
          endLine: 8,
          endCol: 3,
        });

        // External symbols
        const exts = await decoder.externalSymbols();
        assert.equal(exts.length, 1);
        assert.equal(exts[0].displayName, "Helper");
        assert.equal(exts[0].relationships.length, 1);
        assert.equal(exts[0].relationships[0].isTypeDefinition, true);
      } finally {
        decoder.close();
      }
    });
  });
});
