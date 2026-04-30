/**
 * Packed wire format barrel — re-exports the public surface used by
 * dispatchers, decoders, telemetry, and tests.
 */

export {
  Legends,
  PACKED_HEADER_PREFIX,
  PACKED_HEADER_VERSION,
  assemble,
  parseHeader,
  parseScalars,
  quoteIfNeeded,
  splitCsvRow,
  splitSections,
  unquote,
  writeHeader,
  writeScalars,
  writeTableRows,
} from "./format.js";

export {
  decideFormat,
  decideFormatDetailed,
  defaultFormat,
  isPackedEnabled,
  PACKED_DEFAULT_THRESHOLD,
  PACKED_DEFAULT_TOKEN_THRESHOLD,
  resolveThreshold,
  resolveTokenThreshold,
  savedRatio,
  shouldEmitPacked,
} from "./gate.js";
export type { DecideMetrics, DecideResult, GateContext } from "./gate.js";

export {
  decodeSchemaDriven,
  encodeSchemaDriven,
  parseStypesScalar,
  parseTablesScalar,
} from "./schema.js";

export { decodePacked, tryDecodePacked } from "./decoder.js";

export { encodePackedSlice, SLICE_ENCODER_ID } from "./encoders/slice.js";
export {
  encodePackedSymbolSearch,
  SYMBOL_SEARCH_ENCODER_ID,
} from "./encoders/symbol-search.js";
export { encodePackedContext, CONTEXT_ENCODER_ID } from "./encoders/context.js";
export { getEncoder, listEncoders } from "./encoders/registry.js";

export type {
  ColumnSpec,
  EncoderId,
  PackedPayload,
  PackedStats,
  ScalarTypeMap,
  TableSpec,
  WireFormatPackedResult,
  WireFormatResult,
  WireFormatStandardResult,
} from "./types.js";

export { PackedDecodeError } from "./types.js";
