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
export {
  executeProviderFirstLspFull,
  executeProviderFirstScipFull,
  resolveProviderFirstExecutionPlan,
} from "./executor.js";
export {
  materializeProviderFacts,
  providerFactsToGraphRows,
} from "./materializer.js";
export {
  persistProviderFirstProvenance,
  providerFactsToSemanticProvenanceRecords,
} from "./provenance.js";
export type {
  ProviderFirstExecutionPlan,
  ProviderFirstExecutionSummary,
  ProviderFirstExecutorKind,
  ProviderFirstLspExecutionResult,
  ProviderFirstScipExecutionResult,
} from "./executor.js";
export type {
  ProviderFirstExternalSymbolRow,
  ProviderFirstGraphRows,
} from "./materializer.js";
export {
  activateProviderFirstShadowDb,
  activateProviderFirstShadowDbWithHandoff,
  summarizeProviderFirstShadowActivationReadiness,
} from "./shadow-activation.js";
export type {
  ActivateProviderFirstShadowDbWithHandoffParams,
  ProviderFirstShadowActivationSummary,
  ProviderFirstShadowActivationStatus,
} from "./shadow-activation.js";
export { finalizeProviderFirstShadowDb } from "./shadow-finalization.js";
export type {
  ProviderFirstShadowFinalizationCounts,
  ProviderFirstShadowFinalizationStatus,
  ProviderFirstShadowFinalizationSummary,
} from "./shadow-finalization.js";
