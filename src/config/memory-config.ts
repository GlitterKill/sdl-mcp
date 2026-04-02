import {
  MemoryConfigSchema,
  type MemoryConfig,
  type AppConfig,
} from "./types.js";
import { DEFAULT_MEMORY_SURFACE_LIMIT } from "./constants.js";

/** Built-in defaults: memory disabled, but sub-features on if ever enabled */
const BUILT_IN_DEFAULTS: MemoryConfig = {
  enabled: false,
  toolsEnabled: true,
  fileSyncEnabled: true,
  surfacingEnabled: true,
  hintsEnabled: true,
  defaultSurfaceLimit: DEFAULT_MEMORY_SURFACE_LIMIT,
};

/** Resolved capabilities with master-gate applied */
export interface MemoryCapabilities {
  enabled: boolean;
  toolsEnabled: boolean;
  fileSyncEnabled: boolean;
  surfacingEnabled: boolean;
  hintsEnabled: boolean;
  defaultSurfaceLimit: number;
}

/**
 * Resolve effective memory config for a repo.
 * Precedence: built-in defaults < app-level memory < repo-level memory
 */
export function resolveMemoryConfig(
  appConfig: AppConfig,
  repoId?: string,
): MemoryConfig {
  const appLevel = appConfig.memory
    ? MemoryConfigSchema.parse(appConfig.memory)
    : BUILT_IN_DEFAULTS;

  if (!repoId) return { ...BUILT_IN_DEFAULTS, ...appLevel };

  const repo = appConfig.repos.find((r) => r.repoId === repoId);
  const repoOverrides = repo?.memory;

  if (!repoOverrides) return { ...BUILT_IN_DEFAULTS, ...appLevel };

  // Repo-level uses MemoryConfigOverrideSchema (all optional, no defaults),
  // so only explicitly set keys are present — safe to spread directly.
  return { ...BUILT_IN_DEFAULTS, ...appLevel, ...repoOverrides };
}

/**
 * Get flattened capabilities with master gate applied.
 * When `enabled=false`, all sub-features resolve to false.
 */
export function getMemoryCapabilities(
  appConfig: AppConfig,
  repoId?: string,
): MemoryCapabilities {
  const config = resolveMemoryConfig(appConfig, repoId);
  if (!config.enabled) {
    return {
      enabled: false,
      toolsEnabled: false,
      fileSyncEnabled: false,
      surfacingEnabled: false,
      hintsEnabled: false,
      defaultSurfaceLimit: config.defaultSurfaceLimit,
    };
  }
  return {
    enabled: true,
    toolsEnabled: config.toolsEnabled,
    fileSyncEnabled: config.fileSyncEnabled,
    surfacingEnabled: config.surfacingEnabled,
    hintsEnabled: config.hintsEnabled,
    defaultSurfaceLimit: config.defaultSurfaceLimit,
  };
}

/**
 * Check if ANY configured repo has memory tools enabled.
 * Used to decide whether to expose memory tools in discovery surfaces.
 */
export function anyRepoHasMemoryTools(appConfig: AppConfig): boolean {
  // Check if global config enables memory
  if (appConfig.memory?.enabled) {
    const globalCaps = getMemoryCapabilities(appConfig);
    if (globalCaps.toolsEnabled) return true;
  }
  // Check per-repo overrides
  for (const repo of appConfig.repos) {
    const caps = getMemoryCapabilities(appConfig, repo.repoId);
    if (caps.toolsEnabled) return true;
  }
  return false;
}
