/**
 * Memory configuration helpers.
 *
 * Provides convenience functions for resolving effective memory capabilities
 * and checking whether any configured repo has memory tools enabled.
 */

import type { AppConfig, MemoryConfig } from "./types.js";

/** Flattened, resolved memory capabilities with master gate applied. */
export interface MemoryCapabilities {
  enabled: boolean;
  toolsEnabled: boolean;
  fileSyncEnabled: boolean;
  autoSurfaceEnabled: boolean;
}

/** Built-in defaults matching MemoryConfigSchema defaults. */
const BUILT_IN_DEFAULTS: MemoryCapabilities = {
  enabled: false,
  toolsEnabled: true,
  fileSyncEnabled: true,
  autoSurfaceEnabled: true,
};

/**
 * Resolve effective memory config for a repo.
 * Precedence: built-in defaults < app-level memory < repo-level memory
 *
 * When `enabled=false`, all sub-features resolve to false regardless of
 * their individual settings.
 */
export function resolveMemoryConfig(appConfig: AppConfig, repoId?: string): MemoryCapabilities {
  const appLevel: Partial<MemoryConfig> = appConfig.memory ?? {};

  if (!repoId) {
    return applyMasterGate({ ...BUILT_IN_DEFAULTS, ...appLevel });
  }

  const repo = appConfig.repos.find((r) => r.repoId === repoId);
  const repoLevel: Partial<MemoryConfig> = repo?.memory ?? {};

  return applyMasterGate({ ...BUILT_IN_DEFAULTS, ...appLevel, ...repoLevel });
}

/**
 * Get flattened capabilities with master gate applied.
 * When `enabled=false`, all sub-features resolve to false.
 */
export function getMemoryCapabilities(appConfig: AppConfig, repoId?: string): MemoryCapabilities {
  return resolveMemoryConfig(appConfig, repoId);
}

/**
 * Check if ANY configured repo has memory tools enabled.
 * Used to decide whether to expose memory tools in discovery surfaces.
 */
export function anyRepoHasMemoryTools(appConfig: AppConfig): boolean {
  // Check app-level first (global enable)
  if (appConfig.memory?.enabled) {
    const globalCaps = getMemoryCapabilities(appConfig);
    if (globalCaps.toolsEnabled) return true;
  }

  // Check per-repo
  for (const repo of appConfig.repos) {
    const caps = getMemoryCapabilities(appConfig, repo.repoId);
    if (caps.toolsEnabled) return true;
  }

  return false;
}

/** Apply the master gate: when enabled=false, all sub-features are false. */
function applyMasterGate(caps: MemoryCapabilities): MemoryCapabilities {
  if (!caps.enabled) {
    return {
      enabled: false,
      toolsEnabled: false,
      fileSyncEnabled: false,
      autoSurfaceEnabled: false,
    };
  }
  return caps;
}
