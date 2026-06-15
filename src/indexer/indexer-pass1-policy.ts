import { normalizePath } from "../util/paths.js";

const PROVIDER_FIRST_ACTIVE_STALE_DELETE_SYMBOL_LIMIT = 50_000;

export interface ProviderFirstActiveMaterializationPlan {
  deleteExistingFileSymbols: boolean;
  useKnownFreshWriters: boolean;
  writeEdges: boolean;
  reuseExistingProviderRows: boolean;
}

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
  const deleteExistingFileSymbols =
    hasExistingProviderRows &&
    params.providerSymbolCount <=
      PROVIDER_FIRST_ACTIVE_STALE_DELETE_SYMBOL_LIMIT;
  const useKnownFreshWriters =
    !hasExistingProviderRows || deleteExistingFileSymbols;
  const existingProviderRowsMatchCurrentShape =
    hasExistingProviderRows &&
    params.existingProviderSymbolCount === params.providerSymbolCount;
  const canReuseExistingProviderRows =
    (params.activeProviderInputMatches ?? true) ||
    existingProviderRowsMatchCurrentShape;

  return {
    deleteExistingFileSymbols,
    useKnownFreshWriters,
    writeEdges: useKnownFreshWriters,
    reuseExistingProviderRows:
      hasExistingProviderRows &&
      !deleteExistingFileSymbols &&
      canReuseExistingProviderRows,
  };
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
}): "merge" | "fresh-copy" {
  return params.providerFirstLegacyFallbackActive ? "fresh-copy" : "merge";
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
