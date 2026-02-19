/**
 * Slice Module Index
 *
 * Re-exports all slice-related functionality from focused sub-modules.
 *
 * @module graph/slice
 */

export {
  type StartNodeSource,
  type ResolvedStartNode,
  type StartNodeLimits,
  type SliceBuildRequestBase,
  START_NODE_SOURCE_PRIORITY,
  START_NODE_SOURCE_SCORE,
  TASK_TEXT_STOP_WORDS,
  resolveStartNodes,
  collectTaskTextSeedTokens,
  getTaskTextTokenRank,
  buildSymbolsByFile,
  collectEntryFirstHopSymbols,
  collectEntrySiblingSymbols,
  computeStartNodeLimits,
  commonPrefixLength,
  extractSymbolsFromStackTrace,
  getSymbolsByPath,
  getStartNodeWhy,
} from "./start-node-resolver.js";

export {
  type FrontierItem,
  type DynamicCapState,
  type BeamSearchResult,
  type BeamSearchRequest,
  type ParallelScorerConfig,
  type BeamSearchOptions,
  type ScorerMode,
  DYNAMIC_CAP_MIN_CARDS,
  DYNAMIC_CAP_HIGH_CONFIDENCE_MARGIN,
  DYNAMIC_CAP_RECENT_SCORE_WINDOW,
  DYNAMIC_CAP_MIN_ENTRY_COVERAGE,
  DYNAMIC_CAP_FRONTIER_SCORE_MARGIN,
  DYNAMIC_CAP_FRONTIER_DROP_FACTOR,
  DEFAULT_PARALLEL_SCORER_CONFIG,
  normalizeEdgeConfidence,
  applyEdgeConfidenceWeight,
  getAdaptiveMinConfidence,
  beamSearch,
  beamSearchAsync,
  computeMinCardsForDynamicCap,
  shouldTightenDynamicCardCap,
  compareFrontierItems,
  getEdgeWhy,
  estimateCardTokens,
  getScorerPool,
  resetScorerPool,
} from "./beam-search-engine.js";

export {
  uniqueLimit,
  uniqueDepRefs,
  toDefaultSliceDeps,
  resolveSliceDeps,
  filterDepsBySliceSymbolSet,
  toFullCard,
  toCompactCard,
  toSliceSymbolCard,
  buildPayloadCardsAndRefs,
  encodeEdgesWithSymbolIndex,
  estimateTokens,
  SYMBOL_CARD_MAX_DEPS_PER_KIND,
  SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
  SYMBOL_CARD_MAX_INVARIANTS,
  SYMBOL_CARD_MAX_INVARIANTS_LIGHT,
  SYMBOL_CARD_MAX_SIDE_EFFECTS,
  SYMBOL_CARD_MAX_SIDE_EFFECTS_LIGHT,
  SYMBOL_CARD_MAX_TEST_REFS,
  SYMBOL_CARD_SUMMARY_MAX_CHARS,
  SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT,
} from "./slice-serializer.js";

