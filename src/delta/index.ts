/**
 * delta/ barrel — re-exports the public API of the Delta & Blast Radius layer.
 *
 * Consumers MAY import from individual files for narrower deps.
 */

export { computeDelta, computeDeltaWithTiers } from "./diff.js";

export {
  computeBlastRadius,
  runGovernorLoop,
  mergeBlastRadiusWithDiagnostics,
} from "./blastRadius.js";
export type {
  BlastRadiusOptions,
  GovernorLoopOptions,
  GovernorLoopResult,
} from "./blastRadius.js";

export {
  createVersion,
  computeVersionHash,
  finalizeVersionHash,
  getVersion,
  getLatestVersion,
  listVersions,
  snapshotSymbols,
} from "./versioning.js";
