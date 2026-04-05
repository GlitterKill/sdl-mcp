/**
 * Hand-written TypeScript protobuf decoder for the SCIP schema.
 *
 * This file mirrors the types in scip.proto and provides a manual wire-format
 * decoder so the TS build does not require protoc at runtime.  It is checked
 * in as a generated artifact — regenerate if scip.proto changes.
 *
 * Wire-format reference (proto3):
 *   varint        = wire type 0
 *   64-bit fixed  = wire type 1
 *   length-delim  = wire type 2
 *   32-bit fixed  = wire type 5
 *
 * @module scip_pb
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const enum ProtocolVersion {
  UnspecifiedProtocolVersion = 0,
}

export const enum TextEncoding {
  UnspecifiedTextEncoding = 0,
  UTF8 = 1,
  UTF16 = 2,
}

export const enum PositionEncoding {
  UnspecifiedPositionEncoding = 0,
  UTF8CodeUnitOffsetFromLineStart = 1,
  UTF16CodeUnitOffsetFromLineStart = 2,
  UTF32CodeUnitOffsetFromLineStart = 3,
}

export const enum SymbolRole {
  UnspecifiedSymbolRole = 0,
  Definition = 0x1,
  Import = 0x2,
  WriteAccess = 0x4,
  ReadAccess = 0x8,
  Generated = 0x10,
  Test = 0x20,
  ForwardDefinition = 0x40,
}

export const enum SyntaxKind {
  UnspecifiedSyntaxKind = 0,
  Comment = 1,
  PunctuationDelimiter = 2,
  PunctuationBracket = 3,
  Keyword = 4,
  IdentifierOperator = 5,
  Identifier = 6,
  IdentifierBuiltin = 7,
  IdentifierNull = 8,
  IdentifierConstant = 9,
  IdentifierMutableGlobal = 10,
  IdentifierParameter = 11,
  IdentifierLocal = 12,
  IdentifierShadowed = 13,
  IdentifierNamespace = 14,
  IdentifierFunction = 15,
  IdentifierFunctionDefinition = 16,
  IdentifierMacro = 17,
  IdentifierMacroDefinition = 18,
  IdentifierType = 19,
  IdentifierBuiltinType = 20,
  IdentifierAttribute = 21,
  RegexEscape = 22,
  RegexRepeated = 23,
  RegexWildcard = 24,
  RegexDelimiter = 25,
  RegexJoin = 26,
  StringLiteral = 27,
  StringLiteralEscape = 28,
  StringLiteralSpecial = 29,
  StringLiteralKey = 30,
  CharacterLiteral = 31,
  NumericLiteral = 32,
  BooleanLiteral = 33,
  Tag = 34,
  TagAttribute = 35,
  TagDelimiter = 36,
}

export const enum Severity {
  UnspecifiedSeverity = 0,
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export const enum DiagnosticTag {
  UnspecifiedDiagnosticTag = 0,
  Unnecessary = 1,
  Deprecated = 2,
}

/** SymbolInformation.Kind — fine-grained symbol kind. */
export const enum SymbolKind {
  UnspecifiedKind = 0,
  Array = 1,
  Assertion = 2,
  AssociatedType = 3,
  Attribute = 4,
  Axiom = 5,
  Boolean = 6,
  Class = 7,
  Constant = 8,
  Constructor = 9,
  DataFamily = 10,
  Enum = 11,
  EnumMember = 12,
  Event = 13,
  Fact = 14,
  Field = 15,
  File = 16,
  Function = 17,
  Getter = 18,
  Grammar = 19,
  Instance = 20,
  Interface = 21,
  Key = 22,
  Lang = 23,
  Lemma = 24,
  Macro = 25,
  Method = 26,
  MethodReceiver = 27,
  Message = 28,
  Module = 29,
  Namespace = 30,
  Null = 31,
  Number = 32,
  Object = 33,
  Operator = 34,
  Package = 35,
  PackageObject = 36,
  Parameter = 37,
  ParameterLabel = 38,
  Pattern = 39,
  Predicate = 40,
  Property = 41,
  Protocol = 42,
  Quasiquoter = 43,
  SelfParameter = 44,
  Setter = 45,
  Signature = 46,
  Subscript = 47,
  String = 48,
  Struct = 49,
  Tactic = 50,
  Theorem = 51,
  ThisParameter = 52,
  Trait = 53,
  Type = 54,
  TypeAlias = 55,
  TypeClass = 56,
  TypeFamily = 57,
  TypeParameter = 58,
  Union = 59,
  Value = 60,
  Variable = 61,
  Contract = 62,
  Error = 63,
  Library = 64,
  Modifier = 65,
  AbstractMethod = 66,
  MethodSpecification = 67,
  ProtocolMethod = 68,
  PureVirtualMethod = 69,
  TraitMethod = 70,
  TypeClassMethod = 71,
  Accessor = 72,
  Delegate = 73,
  MethodAlias = 74,
  SingletonClass = 75,
  SingletonMethod = 76,
  StaticDataMember = 77,
  StaticEvent = 78,
  StaticField = 79,
  StaticMethod = 80,
  StaticProperty = 81,
  StaticVariable = 82,
  Extension = 84,
  Mixin = 85,
  Concept = 86,
}

export const enum DescriptorSuffix {
  UnspecifiedSuffix = 0,
  Namespace = 1,
  Type = 2,
  Term = 3,
  Method = 4,
  TypeParameter = 5,
  Parameter = 6,
  Meta = 7,
  Local = 8,
  Macro = 9,
}

/**
 * SCIP Language enum — numeric IDs for common languages.
 * Only a subset is listed; the full list is in scip.proto.
 */
export const enum Language {
  UnspecifiedLanguage = 0,
  CSharp = 1,
  Swift = 2,
  Dart = 3,
  Kotlin = 4,
  Scala = 5,
  Java = 6,
  Groovy = 7,
  Clojure = 8,
  CommonLisp = 9,
  Scheme = 10,
  Racket = 11,
  Lua = 12,
  Perl = 13,
  Raku = 14,
  Python = 15,
  Ruby = 16,
  Elixir = 17,
  Erlang = 18,
  PHP = 19,
  Hack = 20,
  Coffeescript = 21,
  JavaScript = 22,
  TypeScript = 23,
  Flow = 24,
  Vue = 25,
  CSS = 26,
  Less = 27,
  Sass = 28,
  SCSS = 29,
  HTML = 30,
  XML = 31,
  XSL = 32,
  Go = 33,
  C = 34,
  CPP = 35,
  Objective_C = 36,
  Objective_CPP = 37,
  Zig = 38,
  Ada = 39,
  Rust = 40,
  OCaml = 41,
  FSharp = 42,
  SML = 43,
  Haskell = 44,
  Agda = 45,
  Idris = 46,
  Coq = 47,
  Lean = 48,
  APL = 49,
  Dyalog = 50,
  J = 51,
  Matlab = 52,
  Wolfram = 53,
  R = 54,
  Julia = 55,
  Fortran = 56,
  Delphi = 57,
  Assembly = 58,
  COBOL = 59,
  ABAP = 60,
  SAS = 61,
  Razor = 62,
  VisualBasic = 63,
  ShellScript = 64,
  Fish = 65,
  Awk = 66,
  PowerShell = 67,
  Bat = 68,
  SQL = 69,
  PLSQL = 70,
  Prolog = 71,
  Ini = 72,
  TOML = 73,
  YAML = 74,
  JSON = 75,
  Jsonnet = 76,
  Nix = 77,
  Skylark = 78,
  Makefile = 79,
  Dockerfile = 80,
  BibTeX = 81,
  TeX = 82,
  LaTeX = 83,
  Markdown = 84,
  ReST = 85,
  AsciiDoc = 86,
  Diff = 88,
  Git_Config = 89,
  Handlebars = 90,
  Git_Commit = 91,
  Git_Rebase = 92,
  JavaScriptReact = 93,
  TypeScriptReact = 94,
  Solidity = 95,
  Apex = 96,
  CUDA = 97,
  GraphQL = 98,
  Pascal = 99,
  Protobuf = 100,
  Tcl = 101,
  Repro = 102,
  Thrift = 103,
  Verilog = 104,
  VHDL = 105,
  Svelte = 106,
  Slang = 107,
  Luau = 108,
  Justfile = 109,
  Nickel = 110,
}

// ---------------------------------------------------------------------------
// Message interfaces
// ---------------------------------------------------------------------------

export interface ScipIndex {
  metadata: ScipMetadata | undefined;
  documents: ScipDocument[];
  externalSymbols: ScipSymbolInformation[];
}

export interface ScipMetadata {
  version: ProtocolVersion;
  toolInfo: ScipToolInfo | undefined;
  projectRoot: string;
  textDocumentEncoding: TextEncoding;
}

export interface ScipToolInfo {
  name: string;
  version: string;
  arguments: string[];
}

export interface ScipDocument {
  language: string;
  relativePath: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
  text: string;
  positionEncoding: PositionEncoding;
}

export interface ScipOccurrence {
  range: number[];
  symbol: string;
  symbolRoles: number;
  overrideDocumentation: string[];
  syntaxKind: SyntaxKind;
  diagnostics: ScipDiagnostic[];
  enclosingRange: number[];
}

export interface ScipSymbolInformation {
  symbol: string;
  documentation: string[];
  relationships: ScipRelationship[];
  kind: SymbolKind;
  displayName: string;
  signatureDocumentation: ScipDocument | undefined;
  enclosingSymbol: string;
}

export interface ScipRelationship {
  symbol: string;
  isReference: boolean;
  isImplementation: boolean;
  isTypeDefinition: boolean;
  isDefinition: boolean;
}

export interface ScipDiagnostic {
  severity: Severity;
  code: string;
  message: string;
  source: string;
  tags: DiagnosticTag[];
}

export interface ScipSymbol {
  scheme: string;
  package: ScipPackage | undefined;
  descriptors: ScipDescriptor[];
}

export interface ScipPackage {
  manager: string;
  name: string;
  version: string;
}

export interface ScipDescriptor {
  name: string;
  disambiguator: string;
  suffix: DescriptorSuffix;
}

// ---------------------------------------------------------------------------
// Wire-format helpers
// ---------------------------------------------------------------------------

/** Internal reader state for decoding protobuf wire format. */
class ProtoReader {
  private readonly bytes: Uint8Array;
  pos: number;
  readonly end: number;

  constructor(buf: Uint8Array, offset = 0, length?: number) {
    this.bytes = buf;
    this.pos = offset;
    this.end = length !== undefined ? offset + length : buf.length;
  }

  /** Read a base-128 varint (up to 64-bit, returned as number — safe for values < 2^53). */
  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.end) {
      const b = this.bytes[this.pos++]!;
      result |= (b & 0x7f) * 2 ** shift; // use multiply to avoid int32 overflow with bitwise
      shift += 7;
      if ((b & 0x80) === 0) return result;
    }
    throw new Error("ProtoReader: truncated varint");
  }

  /** Read a signed varint (zigzag-decoded sint32/sint64). */
  readSignedVarint(): number {
    const n = this.readVarint();
    return (n >>> 1) ^ -(n & 1);
  }

  /** Read field tag and return { fieldNumber, wireType }. */
  readTag(): { fieldNumber: number; wireType: number } {
    const tag = this.readVarint();
    return { fieldNumber: tag >>> 3, wireType: tag & 0x7 };
  }

  /** Read a length-delimited field and return a sub-reader. */
  readLengthDelimited(): ProtoReader {
    const len = this.readVarint();
    if (this.pos + len > this.end) {
      throw new Error(
        `ProtoReader: length-delimited field extends past end (need ${len}, have ${this.end - this.pos})`,
      );
    }
    const sub = new ProtoReader(this.bytes, this.pos, len);
    this.pos += len;
    return sub;
  }

  /** Read a length-delimited field as a UTF-8 string. */
  readString(): string {
    const sub = this.readLengthDelimited();
    return textDecoder.decode(sub.bytes.subarray(sub.pos, sub.end));
  }

  /** Read a length-delimited field as raw bytes. */
  readBytes(): Uint8Array {
    const sub = this.readLengthDelimited();
    return sub.bytes.slice(sub.pos, sub.end);
  }

  /** Read packed repeated int32 values. */
  readPackedInt32(out: number[]): void {
    const sub = this.readLengthDelimited();
    while (sub.pos < sub.end) {
      out.push(sub.readVarint());
    }
  }

  /** Skip a field based on wire type. */
  skip(wireType: number): void {
    switch (wireType) {
      case 0: // varint
        this.readVarint();
        break;
      case 1: // 64-bit
        this.pos += 8;
        break;
      case 2: // length-delimited
        {
          const len = this.readVarint();
          this.pos += len;
        }
        break;
      case 5: // 32-bit
        this.pos += 4;
        break;
      default:
        throw new Error(`ProtoReader: unknown wire type ${wireType}`);
    }
  }

  hasMore(): boolean {
    return this.pos < this.end;
  }
}

const textDecoder = new TextDecoder("utf-8");

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

function decodeToolInfo(reader: ProtoReader): ScipToolInfo {
  const msg: ScipToolInfo = { name: "", version: "", arguments: [] };
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        msg.name = reader.readString();
        break;
      case 2:
        msg.version = reader.readString();
        break;
      case 3:
        msg.arguments.push(reader.readString());
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return msg;
}

function decodeMetadata(reader: ProtoReader): ScipMetadata {
  const msg: ScipMetadata = {
    version: ProtocolVersion.UnspecifiedProtocolVersion,
    toolInfo: undefined,
    projectRoot: "",
    textDocumentEncoding: TextEncoding.UnspecifiedTextEncoding,
  };
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        msg.version = reader.readVarint() as ProtocolVersion;
        break;
      case 2:
        msg.toolInfo = decodeToolInfo(reader.readLengthDelimited());
        break;
      case 3:
        msg.projectRoot = reader.readString();
        break;
      case 4:
        msg.textDocumentEncoding = reader.readVarint() as TextEncoding;
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return msg;
}

function decodeDiagnostic(reader: ProtoReader): ScipDiagnostic {
  const msg: ScipDiagnostic = {
    severity: Severity.UnspecifiedSeverity,
    code: "",
    message: "",
    source: "",
    tags: [],
  };
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        msg.severity = reader.readVarint() as Severity;
        break;
      case 2:
        msg.code = reader.readString();
        break;
      case 3:
        msg.message = reader.readString();
        break;
      case 4:
        msg.source = reader.readString();
        break;
      case 5:
        if (wireType === 2) {
          // packed
          const sub = reader.readLengthDelimited();
          while (sub.hasMore()) {
            msg.tags.push(sub.readVarint() as DiagnosticTag);
          }
        } else {
          msg.tags.push(reader.readVarint() as DiagnosticTag);
        }
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return msg;
}

function decodeOccurrence(reader: ProtoReader): ScipOccurrence {
  const msg: ScipOccurrence = {
    range: [],
    symbol: "",
    symbolRoles: 0,
    overrideDocumentation: [],
    syntaxKind: SyntaxKind.UnspecifiedSyntaxKind,
    diagnostics: [],
    enclosingRange: [],
  };
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        // range: repeated int32, typically packed
        if (wireType === 2) {
          reader.readPackedInt32(msg.range);
        } else {
          msg.range.push(reader.readVarint());
        }
        break;
      case 2:
        msg.symbol = reader.readString();
        break;
      case 3:
        msg.symbolRoles = reader.readVarint();
        break;
      case 4:
        msg.overrideDocumentation.push(reader.readString());
        break;
      case 5:
        msg.syntaxKind = reader.readVarint() as SyntaxKind;
        break;
      case 6:
        msg.diagnostics.push(decodeDiagnostic(reader.readLengthDelimited()));
        break;
      case 7:
        // enclosing_range: repeated int32, typically packed
        if (wireType === 2) {
          reader.readPackedInt32(msg.enclosingRange);
        } else {
          msg.enclosingRange.push(reader.readVarint());
        }
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return msg;
}

function decodeRelationship(reader: ProtoReader): ScipRelationship {
  const msg: ScipRelationship = {
    symbol: "",
    isReference: false,
    isImplementation: false,
    isTypeDefinition: false,
    isDefinition: false,
  };
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        msg.symbol = reader.readString();
        break;
      case 2:
        msg.isReference = reader.readVarint() !== 0;
        break;
      case 3:
        msg.isImplementation = reader.readVarint() !== 0;
        break;
      case 4:
        msg.isTypeDefinition = reader.readVarint() !== 0;
        break;
      case 5:
        msg.isDefinition = reader.readVarint() !== 0;
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return msg;
}

function decodeSymbolInformation(reader: ProtoReader): ScipSymbolInformation {
  const msg: ScipSymbolInformation = {
    symbol: "",
    documentation: [],
    relationships: [],
    kind: SymbolKind.UnspecifiedKind,
    displayName: "",
    signatureDocumentation: undefined,
    enclosingSymbol: "",
  };
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        msg.symbol = reader.readString();
        break;
      case 3:
        msg.documentation.push(reader.readString());
        break;
      case 4:
        msg.relationships.push(
          decodeRelationship(reader.readLengthDelimited()),
        );
        break;
      case 5:
        msg.kind = reader.readVarint() as SymbolKind;
        break;
      case 6:
        msg.displayName = reader.readString();
        break;
      case 7:
        msg.signatureDocumentation = decodeDocument(
          reader.readLengthDelimited(),
        );
        break;
      case 8:
        msg.enclosingSymbol = reader.readString();
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return msg;
}

function decodeDocument(reader: ProtoReader): ScipDocument {
  const msg: ScipDocument = {
    language: "",
    relativePath: "",
    occurrences: [],
    symbols: [],
    text: "",
    positionEncoding: PositionEncoding.UnspecifiedPositionEncoding,
  };
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 4:
        msg.language = reader.readString();
        break;
      case 1:
        msg.relativePath = reader.readString();
        break;
      case 2:
        msg.occurrences.push(decodeOccurrence(reader.readLengthDelimited()));
        break;
      case 3:
        msg.symbols.push(decodeSymbolInformation(reader.readLengthDelimited()));
        break;
      case 5:
        msg.text = reader.readString();
        break;
      case 6:
        msg.positionEncoding = reader.readVarint() as PositionEncoding;
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return msg;
}

function decodeDescriptor(reader: ProtoReader): ScipDescriptor {
  const msg: ScipDescriptor = {
    name: "",
    disambiguator: "",
    suffix: DescriptorSuffix.UnspecifiedSuffix,
  };
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        msg.name = reader.readString();
        break;
      case 2:
        msg.disambiguator = reader.readString();
        break;
      case 3:
        msg.suffix = reader.readVarint() as DescriptorSuffix;
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return msg;
}

function decodePackage(reader: ProtoReader): ScipPackage {
  const msg: ScipPackage = { manager: "", name: "", version: "" };
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        msg.manager = reader.readString();
        break;
      case 2:
        msg.name = reader.readString();
        break;
      case 3:
        msg.version = reader.readString();
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return msg;
}

// Exported but not used in the main decode path yet — available for
// consumers that parse SCIP symbol strings into structured form.
export function decodeSymbol(reader: ProtoReader): ScipSymbol {
  const msg: ScipSymbol = { scheme: "", package: undefined, descriptors: [] };
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        msg.scheme = reader.readString();
        break;
      case 2:
        msg.package = decodePackage(reader.readLengthDelimited());
        break;
      case 3:
        msg.descriptors.push(decodeDescriptor(reader.readLengthDelimited()));
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode a binary SCIP Index message from a Uint8Array.
 *
 * This is the primary entry point for consuming SCIP data in TypeScript.
 * The input should be the raw bytes of a serialised `scip.Index` protobuf
 * message (typically read from a `.scip` file).
 *
 * @param bytes - Raw protobuf bytes of a SCIP Index message.
 * @returns Decoded ScipIndex with metadata, documents and external symbols.
 * @throws If the byte stream is malformed or truncated.
 */
export function decodeScipIndex(bytes: Uint8Array): ScipIndex {
  const reader = new ProtoReader(bytes);
  const msg: ScipIndex = {
    metadata: undefined,
    documents: [],
    externalSymbols: [],
  };
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        msg.metadata = decodeMetadata(reader.readLengthDelimited());
        break;
      case 2:
        msg.documents.push(decodeDocument(reader.readLengthDelimited()));
        break;
      case 3:
        msg.externalSymbols.push(
          decodeSymbolInformation(reader.readLengthDelimited()),
        );
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return msg;
}
