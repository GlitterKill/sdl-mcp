export type {
  CoverageFact,
  DiagnosticFact,
  EdgeFact,
  ExternalSymbolFact,
  FileFact,
  OccurrenceFact,
  ProviderFactSet,
  ProviderFirstPipelineSelection,
  ProviderRunFact,
  ProviderSourcePlan,
  SymbolFact,
} from "./types.js";
export {
  createProviderEdgeDedupeKey,
  createProviderOccurrenceId,
  createProviderSymbolId,
} from "./ids.js";
export { createLspProviderCacheKey } from "./lsp-cache.js";
export { resolveProviderFirstPipeline } from "./planner.js";
export { normalizeScipProviderFacts } from "./scip-normalizer.js";
