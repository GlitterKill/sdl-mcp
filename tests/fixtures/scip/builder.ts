/**
 * Programmatic SCIP protobuf fixture builder.
 *
 * Builds valid SCIP Index protobuf binary data from simplified test inputs,
 * avoiding the need for real SCIP emitters during testing.
 *
 * The protobuf encoding here mirrors the wire format that
 * `decodeScipIndex()` in `src/scip/proto/scip_pb.ts` expects.
 */

import { writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Simplified input types for test fixture construction
// ---------------------------------------------------------------------------

export interface TestScipMetadata {
  version?: number;
  toolName?: string;
  toolVersion?: string;
  toolArgs?: string[];
  projectRoot?: string;
  textDocumentEncoding?: number;
}

export interface TestScipOccurrence {
  /** 3-element [startLine, startCol, endCol] or 4-element [startLine, startCol, endLine, endCol] */
  range: [number, number, number] | [number, number, number, number];
  symbol: string;
  symbolRoles?: number;
  syntaxKind?: number;
}

export interface TestScipRelationship {
  symbol: string;
  isReference?: boolean;
  isImplementation?: boolean;
  isTypeDefinition?: boolean;
  isDefinition?: boolean;
}

export interface TestScipSymbolInfo {
  symbol: string;
  documentation?: string[];
  kind?: number;
  displayName?: string;
  enclosingSymbol?: string;
  relationships?: TestScipRelationship[];
}

export interface TestScipDocument {
  language?: string;
  relativePath: string;
  occurrences?: TestScipOccurrence[];
  symbols?: TestScipSymbolInfo[];
}

export interface TestScipExternalSymbol {
  symbol: string;
  documentation?: string[];
  kind?: number;
  displayName?: string;
  enclosingSymbol?: string;
  relationships?: TestScipRelationship[];
}

export interface TestScipIndex {
  metadata?: TestScipMetadata;
  documents?: TestScipDocument[];
  externalSymbols?: TestScipExternalSymbol[];
}

// ---------------------------------------------------------------------------
// Low-level protobuf encoding primitives
// ---------------------------------------------------------------------------

/**
 * Encode an unsigned 32-bit integer as a protobuf varint.
 */
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

/**
 * Encode a protobuf field tag (field_number << 3 | wire_type).
 */
function encodeTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
}

/**
 * Encode a varint field (wire type 0).
 */
function encodeVarintField(fieldNumber: number, value: number): Uint8Array {
  const tag = encodeTag(fieldNumber, 0);
  const val = encodeVarint(value);
  const result = new Uint8Array(tag.length + val.length);
  result.set(tag, 0);
  result.set(val, tag.length);
  return result;
}

/**
 * Encode a length-delimited field (wire type 2).
 */
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

/**
 * Encode a string field (length-delimited UTF-8).
 */
function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  const strBytes = new TextEncoder().encode(value);
  return encodeLengthDelimited(fieldNumber, strBytes);
}

/**
 * Concatenate multiple Uint8Arrays into one.
 */
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
// Message-level encoders (matching SCIP proto field numbers)
// ---------------------------------------------------------------------------

/**
 * Encode a ToolInfo message.
 * Proto fields: name(1 string), version(2 string), arguments(3 repeated string)
 */
function encodeToolInfo(
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
 * Encode a Metadata message.
 * Proto fields: version(1 varint), toolInfo(2 message), projectRoot(3 string),
 *               textDocumentEncoding(4 varint)
 */
function encodeMetadata(opts: TestScipMetadata): Uint8Array {
  const parts: Uint8Array[] = [];
  if (opts.version !== undefined) {
    parts.push(encodeVarintField(1, opts.version));
  }
  if (opts.toolName || opts.toolVersion || opts.toolArgs) {
    const toolInfo = encodeToolInfo(
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
 * Encode a Relationship message.
 * Proto fields: symbol(1 string), isReference(2 bool), isImplementation(3 bool),
 *               isTypeDefinition(4 bool), isDefinition(5 bool)
 */
function encodeRelationship(opts: TestScipRelationship): Uint8Array {
  const parts: Uint8Array[] = [encodeStringField(1, opts.symbol)];
  if (opts.isReference) parts.push(encodeVarintField(2, 1));
  if (opts.isImplementation) parts.push(encodeVarintField(3, 1));
  if (opts.isTypeDefinition) parts.push(encodeVarintField(4, 1));
  if (opts.isDefinition) parts.push(encodeVarintField(5, 1));
  return concat(...parts);
}

/**
 * Encode an Occurrence message.
 * Proto fields: range(1 packed repeated int32), symbol(2 string),
 *               symbolRoles(3 varint), syntaxKind(5 varint),
 *               diagnostics(6 repeated message)
 */
function encodeOccurrence(opts: TestScipOccurrence): Uint8Array {
  const parts: Uint8Array[] = [];

  // Range is a packed repeated int32 (field 1, wire type 2)
  const rangeBytes = concat(...opts.range.map((v) => encodeVarint(v)));
  parts.push(encodeLengthDelimited(1, rangeBytes));

  if (opts.symbol) parts.push(encodeStringField(2, opts.symbol));
  if (opts.symbolRoles !== undefined) {
    parts.push(encodeVarintField(3, opts.symbolRoles));
  }
  if (opts.syntaxKind !== undefined) {
    parts.push(encodeVarintField(5, opts.syntaxKind));
  }
  return concat(...parts);
}

/**
 * Encode a SymbolInformation message.
 * Proto fields: symbol(1 string), documentation(3 repeated string),
 *               relationships(4 repeated message), kind(5 varint),
 *               displayName(6 string), enclosingSymbol(8 string)
 */
function encodeSymbolInformation(
  opts: TestScipSymbolInfo | TestScipExternalSymbol,
): Uint8Array {
  const parts: Uint8Array[] = [encodeStringField(1, opts.symbol)];
  if (opts.documentation) {
    for (const doc of opts.documentation) {
      parts.push(encodeStringField(3, doc));
    }
  }
  if (opts.relationships) {
    for (const rel of opts.relationships) {
      parts.push(encodeLengthDelimited(4, encodeRelationship(rel)));
    }
  }
  if (opts.kind !== undefined) parts.push(encodeVarintField(5, opts.kind));
  if (opts.displayName) parts.push(encodeStringField(6, opts.displayName));
  if (opts.enclosingSymbol) {
    parts.push(encodeStringField(8, opts.enclosingSymbol));
  }
  return concat(...parts);
}

/**
 * Encode a Document message.
 * Proto fields: relativePath(1 string), occurrences(2 repeated message),
 *               symbols(3 repeated message), language(4 string),
 *               text(5 string), positionEncoding(6 varint)
 */
function encodeDocument(opts: TestScipDocument): Uint8Array {
  const parts: Uint8Array[] = [encodeStringField(1, opts.relativePath)];
  if (opts.occurrences) {
    for (const occ of opts.occurrences) {
      parts.push(encodeLengthDelimited(2, encodeOccurrence(occ)));
    }
  }
  if (opts.symbols) {
    for (const sym of opts.symbols) {
      parts.push(encodeLengthDelimited(3, encodeSymbolInformation(sym)));
    }
  }
  if (opts.language) parts.push(encodeStringField(4, opts.language));
  return concat(...parts);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a SCIP index protobuf binary from simplified test data.
 *
 * The output is a valid protobuf message that `decodeScipIndex()` can decode.
 *
 * Proto fields for Index: metadata(1 message), documents(2 repeated message),
 *                         externalSymbols(3 repeated message)
 */
export function buildTestScipIndex(opts: TestScipIndex): Uint8Array {
  const parts: Uint8Array[] = [];
  if (opts.metadata) {
    parts.push(encodeLengthDelimited(1, encodeMetadata(opts.metadata)));
  }
  if (opts.documents) {
    for (const doc of opts.documents) {
      parts.push(encodeLengthDelimited(2, encodeDocument(doc)));
    }
  }
  if (opts.externalSymbols) {
    for (const sym of opts.externalSymbols) {
      parts.push(encodeLengthDelimited(3, encodeSymbolInformation(sym)));
    }
  }
  return concat(...parts);
}

/**
 * Write a test SCIP index to a file.
 */
export async function writeTestScipIndex(
  filePath: string,
  opts: TestScipIndex,
): Promise<void> {
  const bytes = buildTestScipIndex(opts);
  await writeFile(filePath, bytes);
}
