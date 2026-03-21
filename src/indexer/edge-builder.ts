export {
  createCallResolutionTelemetry,
  isTsCallResolutionFile,
  recordPass2ResolverResult,
  recordPass2ResolverTarget,
  type CallResolutionTelemetry,
} from "./edge-builder/telemetry.js";
export { resolveImportTargets } from "./edge-builder/import-resolution.js";
export { resolveCallTarget } from "./edge-builder/call-resolution.js";
export {
  addToSymbolIndex,
  resolveSymbolIdFromIndex,
} from "./edge-builder/symbol-index.js";
export { resolvePendingCallEdges } from "./edge-builder/pending.js";
export {
  BUILTIN_CONSTRUCTORS,
  BUILTIN_IDENTIFIERS,
  isBuiltinCall,
} from "./edge-builder/builtins.js";
export { cleanupUnresolvedEdges } from "./edge-builder/cleanup.js";
export { findEnclosingSymbolByRange } from "./edge-builder/enclosing-symbol.js";
export {
  buildSymbolKeyMaps,
  mapExtractedSymbolId,
  toFullKey,
  toStartKey,
  toStartLineKey,
  toNameKindKey,
  type MappedSymbolResult,
  type SymbolKeyMaps,
} from "./edge-builder/symbol-mapping.js";
export { resolvePass2Targets } from "./edge-builder/target-selection.js";
export { resolveUnresolvedImportEdges } from "./edge-builder/unresolved-imports.js";
export { resolveTsCallEdgesPass2 } from "./edge-builder/pass2.js";
export type {
  PendingCallEdge,
  SymbolIndex,
  TsCallResolver,
} from "./edge-builder/types.js";
