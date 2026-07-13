/**
 * Compatibility facade for provider-first callers. LadybugDB finalization,
 * including bulk COPY and fallback persistence, is owned by the db adapter.
 */
export { finalizeProviderFirstShadowDb } from "../../db/ladybug-shadow-finalization.js";
export type {
  FinalizeProviderFirstShadowDbParams,
  ProviderFirstShadowFinalizationBulkArtifact,
  ProviderFirstShadowFinalizationBulkLoadSummary,
  ProviderFirstShadowFinalizationCounts,
  ProviderFirstShadowFinalizationStatus,
  ProviderFirstShadowFinalizationSummary,
} from "../../db/ladybug-shadow-finalization.js";
