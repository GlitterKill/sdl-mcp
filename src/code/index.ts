/**
 * code/ barrel — re-exports the public API of the Code Access Layer.
 *
 * Consumers MAY import from individual files for narrower deps.
 */

export {
  extractSkeletonFromNode,
  trimSkeletonToBounds,
  parseFile,
  generateSymbolSkeleton,
  generateFileSkeleton,
  generateSkeletonIR,
} from "./skeleton.js";
export type {
  SkeletonResult,
  SkeletonIRResult,
  SkeletonOptions,
} from "./skeleton.js";

export { extractHotPath } from "./hotpath.js";
export type { HotPathOptions, HotPathResult } from "./hotpath.js";

export {
  extractCodeWindow,
  identifiersExistInWindow,
  extractWindow,
  applyBounds,
  centerOnSymbol,
  expandToBlock,
  estimateTokens,
} from "./windows.js";
export type { ExtractWindowResult } from "./windows.js";

export { enforceCodeWindow } from "./enforce.js";
export type { EnforceContext, IdentifierDenialGuidance } from "./enforce.js";

export { LadybugWindowLoader } from "./window-loader.js";
export type { WindowLoader } from "./window-loader.js";
