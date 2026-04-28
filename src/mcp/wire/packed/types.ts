/**
 * Packed wire format type definitions.
 * See devdocs/plans/packed-wireformat-plan.md.
 */

export type EncoderId = "sl1" | "ss1" | "ctx1" | "gen1";

export interface PackedPayload {
  text: string;
  encoderId: string;
  jsonBytes: number;
  packedBytes: number;
}

export interface WireFormatStandardResult {
  format: "standard" | "readable" | "compact" | "agent";
  payload: object;
}

export interface WireFormatPackedResult {
  format: "packed";
  payload: string;
  encoderId: string;
  jsonBytes: number;
  packedBytes: number;
  jsonTokens?: number;
  packedTokens?: number;
  axisHit?: "bytes" | "tokens";
}

export type WireFormatResult =
  | WireFormatStandardResult
  | WireFormatPackedResult;

export interface PackedStats {
  encoderId: string;
  jsonBytes: number;
  packedBytes: number;
  savedRatio: number;
  gateDecision: "packed" | "fallback";
}

export interface ColumnSpec {
  name: string;
  type: "str" | "int" | "float" | "bool";
  intern?: boolean;
}

export interface TableSpec {
  tag: string;
  key: string;
  columns: ColumnSpec[];
}

export interface ScalarTypeMap {
  [key: string]: "str" | "int" | "float" | "bool" | "json";
}

export class PackedDecodeError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    super(`packed decode error at line ${line}, col ${column}: ${message}`);
    this.name = "PackedDecodeError";
    this.line = line;
    this.column = column;
  }
}
