import { dirname, resolve } from "node:path";

import { ViewerConfigSchema, type ViewerConfig } from "../config/types.js";

let runtimeViewerConfig: ViewerConfig | null = null;
let runtimeConfigDir: string | null = null;

/**
 * Wire the loaded `viewer.*` config block (and the config file location, for
 * configDir-relative defaults) into the viewer runtime. Called once at server
 * startup; before that, all getters fall back to schema defaults.
 */
export function setViewerRuntimeConfig(viewer: unknown, configPath?: string | null): void {
  runtimeViewerConfig = ViewerConfigSchema.parse(viewer ?? {});
  runtimeConfigDir = configPath ? dirname(resolve(configPath)) : null;
}

export function getViewerRuntimeConfig(): ViewerConfig {
  return runtimeViewerConfig ?? ViewerConfigSchema.parse({});
}

function configScopedDir(subdir: string): string {
  return runtimeConfigDir
    ? resolve(runtimeConfigDir, subdir)
    : resolve(process.cwd(), subdir);
}

export function resolveSkinsDir(): string {
  const config = getViewerRuntimeConfig();
  return config.skinsDir ? resolve(config.skinsDir) : configScopedDir("skins");
}

export function resolveLayoutCacheDir(): string {
  const config = getViewerRuntimeConfig();
  return config.layout.cacheDir
    ? resolve(config.layout.cacheDir)
    : configScopedDir("viewer-layout-cache");
}

export function _resetViewerRuntimeConfigForTesting(): void {
  runtimeViewerConfig = null;
  runtimeConfigDir = null;
}
