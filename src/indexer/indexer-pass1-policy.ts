import { LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT } from "../db/ladybug-symbols.js";
import { IndexError } from "../domain/errors.js";

import { normalizePath } from "../util/paths.js";

export interface ProviderFirstActiveMaterializationPlan {
  deleteExistingFileSymbols: boolean;
  useKnownFreshWriters: boolean;
  useKnownFreshEdgeWriter: boolean;
  writeEdges: boolean;
  reuseExistingProviderRows: boolean;
}

/** Signals that incremental replacement must move to a fresh database. */
export class ProviderFirstIncrementalReplacementError extends IndexError {}

/** @internal exported for tests; do not import from product code. */
export function countExistingProviderPrimaryFiles(params: {
  providerFiles: readonly { relPath: string }[];
  existingByPath: ReadonlyMap<string, unknown>;
}): number {
  let count = 0;
  for (const file of params.providerFiles) {
    if (params.existingByPath.has(normalizePath(file.relPath))) {
      count += 1;
    }
  }
  return count;
}

export function resolveProviderFirstActiveMaterializationPlan(params: {
  existingProviderFileCount: number;
  providerSymbolCount: number;
  activeProviderInputMatches?: boolean;
  existingProviderSymbolCount?: number;
}): ProviderFirstActiveMaterializationPlan {
  const hasExistingProviderRows = params.existingProviderFileCount > 0;
  // Replacement safety covers both rows removed from the active graph and incoming rows.
  const existingProviderSymbolCount = hasExistingProviderRows
    ? (params.existingProviderSymbolCount ?? params.providerSymbolCount)
    : 0;
  const providerReplacementRowCount = Math.max(
    params.providerSymbolCount,
    existingProviderSymbolCount,
  );
  const useKnownFreshWriters =
    providerReplacementRowCount <= LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT;
  const deleteExistingFileSymbols =
    hasExistingProviderRows && useKnownFreshWriters;
  // A fresh large graph still needs fast edge writes even though Symbol rows use MERGE.
  const useKnownFreshEdgeWriter =
    !hasExistingProviderRows || deleteExistingFileSymbols;
  const writeEdges = useKnownFreshEdgeWriter;
  const existingProviderRowsMatchCurrentShape =
    hasExistingProviderRows &&
    params.existingProviderSymbolCount === params.providerSymbolCount;
  const canReuseExistingProviderRows =
    (params.activeProviderInputMatches ?? true) ||
    existingProviderRowsMatchCurrentShape;

  return {
    deleteExistingFileSymbols,
    useKnownFreshWriters,
    useKnownFreshEdgeWriter,
    writeEdges,
    reuseExistingProviderRows:
      hasExistingProviderRows &&
      !deleteExistingFileSymbols &&
      canReuseExistingProviderRows,
  };
}

export function resolveProviderFirstIncrementalMaterializationPlan(params: {
  existingProviderSymbolCount: number;
  providerSymbolCount: number;
}): ProviderFirstActiveMaterializationPlan {
  const hasExistingProviderRows = params.existingProviderSymbolCount > 0;
  const replacementRowCount = Math.max(
    params.existingProviderSymbolCount,
    params.providerSymbolCount,
  );

  if (
    hasExistingProviderRows &&
    replacementRowCount > LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT
  ) {
    throw new ProviderFirstIncrementalReplacementError(
      `Provider-first incremental replacement is unsafe: ${params.existingProviderSymbolCount} existing scoped Symbol rows and ${params.providerSymbolCount} incoming Symbol rows exceed the LadybugDB safety limit of ${LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT}. A fresh database rebuild is required.`,
    );
  }

  return resolveProviderFirstActiveMaterializationPlan({
    existingProviderFileCount: hasExistingProviderRows ? 1 : 0,
    existingProviderSymbolCount: params.existingProviderSymbolCount,
    providerSymbolCount: params.providerSymbolCount,
    activeProviderInputMatches: false,
  });
}

export function shouldReuseProviderFirstFullGraph(params: {
  reuseExistingProviderRows: boolean;
  activeProviderInputMatches: boolean;
  allFilesUnchanged: boolean;
}): boolean {
  // Large COPY-loaded Symbol tables cannot safely tolerate even fallback-only
  // mutations, so reuse the whole graph only when both inputs are proven stable.
  return (
    params.reuseExistingProviderRows &&
    params.activeProviderInputMatches &&
    params.allFilesUnchanged
  );
}

/** @internal exported for tests; do not import from product code. */
export function shouldUseRustPass1Engine(params: {
  configuredEngine: string | undefined;
  rustEngineAvailable: boolean;
  providerFirstLegacyFallbackActive: boolean;
  providerFirstLegacyFallbackComplete: boolean;
}): boolean {
  return (
    params.configuredEngine === "rust" &&
    params.rustEngineAvailable &&
    (!params.providerFirstLegacyFallbackActive ||
      params.providerFirstLegacyFallbackComplete)
  );
}

/** @internal exported for tests; do not import from product code. */
export function shouldCreateParserWorkerPool(params: {
  useRustEngine: boolean;
  providerFirstLegacyFallbackActive: boolean;
  providerFirstLegacyFallbackComplete: boolean;
}): boolean {
  return (
    !params.useRustEngine &&
    (!params.providerFirstLegacyFallbackActive ||
      params.providerFirstLegacyFallbackComplete)
  );
}

/** @internal exported for tests; do not import from product code. */
export function shouldDeleteExistingFilesBeforeFullPass1(params: {
  mode: "full" | "incremental";
  providerFirstLegacyFallbackActive: boolean;
  existingFileCount: number;
}): boolean {
  return (
    params.mode === "full" &&
    params.providerFirstLegacyFallbackActive &&
    params.existingFileCount > 0
  );
}

/** @internal exported for tests; do not import from product code. */
export function shouldUseBatchPersistAccumulator(params: {
  providerFirstLegacyFallbackActive: boolean;
  providerFirstLegacyFallbackComplete: boolean;
}): boolean {
  return (
    !params.providerFirstLegacyFallbackActive ||
    params.providerFirstLegacyFallbackComplete
  );
}

/** @internal exported for tests; do not import from product code. */
export function resolvePass1BatchSymbolWriteMode(params: {
  providerFirstLegacyFallbackActive: boolean;
}): "merge" | "fresh-replace" {
  return params.providerFirstLegacyFallbackActive ? "fresh-replace" : "merge";
}

/** @internal exported for tests; do not import from product code. */
export function shouldStabilizePass1BatchPersist(params: {
  providerFirstLegacyFallbackActive: boolean;
  useBatchPersist: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): boolean {
  if (!params.useBatchPersist) return false;
  if (params.providerFirstLegacyFallbackActive) return true;
  const raw = (
    (params.env ?? process.env).SDL_MCP_PASS1_STABLE_DB_WRITES ?? ""
  ).trim();
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;

  // LadybugDB 0.16.0 can access-violate on Windows when the legacy Pass 1
  // parser overlaps with background batch writes. Prefer stable writes for the
  // simple legacy setup; non-Windows keeps the faster overlapped default.
  return (params.platform ?? process.platform) === "win32";
}
