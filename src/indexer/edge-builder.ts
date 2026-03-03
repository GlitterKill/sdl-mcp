export {
  createCallResolutionTelemetry,
  isTsCallResolutionFile,
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
  cleanupUnresolvedEdges,
  findEnclosingSymbolByRange,
  isBuiltinCall,
  resolvePass2Targets,
  resolveTsCallEdgesPass2,
} from "./edge-builder/pass2.js";
export type {
  PendingCallEdge,
  SymbolIndex,
  TsCallResolver,
} from "./edge-builder/types.js";
