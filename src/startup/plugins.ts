import path from "node:path";

import type { AppConfig } from "../config/types.js";
import { ConfigError } from "../domain/errors.js";
import {
  loadBuiltInAdapters,
  loadPlugins,
} from "../indexer/adapter/registry.js";

function resolveConfigRelativePath(
  configDir: string,
  targetPath: string,
): string {
  return path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(configDir, targetPath);
}

export function resolveConfiguredPluginPaths(
  pluginPaths: readonly string[],
  configPath: string,
): string[] {
  const configDir = path.dirname(path.resolve(configPath));
  return pluginPaths.map((pluginPath) =>
    resolveConfigRelativePath(configDir, pluginPath),
  );
}

export function resolveConfiguredPluginTrustedRoots(
  pluginPaths: readonly string[],
  resolvedPluginPaths: readonly string[],
  trustedRoots: readonly string[],
  configPath: string,
): string[] {
  const configDir = path.dirname(path.resolve(configPath));
  const configuredRoots = trustedRoots.map((root) =>
    resolveConfigRelativePath(configDir, root),
  );
  if (configuredRoots.length > 0) {
    return Array.from(new Set(configuredRoots));
  }

  const inferredRoots = pluginPaths.map((pluginPath, index) =>
    path.isAbsolute(pluginPath)
      ? path.dirname(resolvedPluginPaths[index]!)
      : configDir,
  );
  return Array.from(new Set(inferredRoots));
}

/**
 * Load built-in adapters and any configured plugin adapters before indexing or
 * tool planning touches the adapter registry.
 */
export async function loadConfiguredAdapterPlugins(
  config: AppConfig,
  configPath: string,
  log?: (message: string) => void,
): Promise<void> {
  loadBuiltInAdapters();

  const pluginConfig = config.plugins;
  if (pluginConfig?.enabled === false) {
    log?.("[sdl-mcp] Plugin loading disabled by config.");
    return;
  }

  const pluginPaths = pluginConfig?.paths ?? [];
  if (pluginPaths.length === 0) {
    return;
  }
  if (!configPath) {
    throw new ConfigError(
      "Plugin loading requires the active config path so relative plugin paths resolve from the config directory.",
    );
  }

  const resolvedPluginPaths = resolveConfiguredPluginPaths(
    pluginPaths,
    configPath,
  );
  const trustedRoots = resolveConfiguredPluginTrustedRoots(
    pluginPaths,
    resolvedPluginPaths,
    pluginConfig?.trustedRoots ?? [],
    configPath,
  );

  await loadPlugins(resolvedPluginPaths, trustedRoots);
  log?.(`[sdl-mcp] Plugin adapter paths loaded: ${pluginPaths.length}`);
}
