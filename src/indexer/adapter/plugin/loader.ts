import path from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type {
  AdapterPlugin,
  PluginAdapter,
  PluginLoadError,
  PluginLoadResult,
} from "./types.js";
import { validateManifest, PLUGIN_API_VERSION } from "./types.js";
import { logger } from "../../../util/logger.js";

const loadedPlugins = new Map<string, AdapterPlugin>();

export async function loadPlugin(
  pluginPath: string,
): Promise<PluginLoadResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const absolutePath = path.resolve(pluginPath);

  try {
    if (!existsSync(absolutePath)) {
      return {
        plugin: null as never,
        loaded: false,
        errors: [`Plugin file not found: ${absolutePath}`],
      };
    }

    const importUrl = pathToFileURL(absolutePath).href;
    const module = await import(importUrl);
    const pluginModule: AdapterPlugin = module.default ?? module;

    if (!pluginModule) {
      return {
        plugin: null as never,
        loaded: false,
        errors: [`Plugin module must export a default or named export`],
      };
    }

    if (!pluginModule.manifest) {
      errors.push("Plugin missing required 'manifest' property");
    }

    if (typeof pluginModule.createAdapters !== "function") {
      errors.push("Plugin missing required 'createAdapters' function");
    }

    if (errors.length > 0) {
      return {
        plugin: null as never,
        loaded: false,
        errors,
      };
    }

    const validation = validateManifest(pluginModule.manifest);

    if (!validation.valid) {
      errors.push(...validation.errors);
    }

    if (validation.warnings.length > 0) {
      warnings.push(...validation.warnings);
    }

    if (!validation.valid) {
      return {
        plugin: pluginModule,
        loaded: false,
        errors,
      };
    }

    loadedPlugins.set(absolutePath, pluginModule);

    logger.info("Plugin loaded successfully", {
      name: pluginModule.manifest.name,
      version: pluginModule.manifest.version,
      path: absolutePath,
    });

    if (warnings.length > 0) {
      logger.warn("Plugin loaded with warnings", {
        name: pluginModule.manifest.name,
        warnings,
      });
    }

    return {
      plugin: pluginModule,
      loaded: true,
      errors: warnings,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load plugin", {
      path: absolutePath,
      error: errorMessage,
    });

    return {
      plugin: null as never,
      loaded: false,
      errors: [`Failed to load plugin: ${errorMessage}`],
    };
  }
}

export async function loadPluginsFromConfig(
  pluginPaths: string[] | undefined,
): Promise<{
  successful: AdapterPlugin[];
  failed: PluginLoadError[];
}> {
  const successful: AdapterPlugin[] = [];
  const failed: PluginLoadError[] = [];

  if (!pluginPaths || pluginPaths.length === 0) {
    return { successful, failed };
  }

  for (const pluginPath of pluginPaths) {
    const result = await loadPlugin(pluginPath);

    if (result.loaded) {
      successful.push(result.plugin);
    } else {
      failed.push({
        pluginPath,
        error: result.errors.join("; "),
      });
    }
  }

  return { successful, failed };
}

export async function getPluginAdapters(
  plugin: AdapterPlugin,
): Promise<PluginAdapter[]> {
  try {
    const adapters = await plugin.createAdapters();

    if (!Array.isArray(adapters)) {
      throw new Error("createAdapters must return an array of adapters");
    }

    for (const adapter of adapters) {
      if (
        !adapter.extension ||
        !adapter.languageId ||
        typeof adapter.factory !== "function"
      ) {
        throw new Error(
          `Invalid adapter: must have extension, languageId, and factory function`,
        );
      }
    }

    return adapters;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to create adapters from plugin", {
      plugin: plugin.manifest.name,
      error: errorMessage,
    });
    throw new Error(`Failed to create adapters: ${errorMessage}`);
  }
}

export function getLoadedPlugins(): AdapterPlugin[] {
  return Array.from(loadedPlugins.values());
}

export function isPluginLoaded(pluginPath: string): boolean {
  const absolutePath = path.resolve(pluginPath);
  return loadedPlugins.has(absolutePath);
}

export function unloadPlugin(pluginPath: string): boolean {
  const absolutePath = path.resolve(pluginPath);
  const removed = loadedPlugins.delete(absolutePath);

  if (removed) {
    logger.info("Plugin unloaded", { path: absolutePath });
  }

  return removed;
}

export function clearLoadedPlugins(): void {
  const count = loadedPlugins.size;
  loadedPlugins.clear();
  logger.info("All plugins unloaded", { count });
}

export function getHostApiVersion(): string {
  return PLUGIN_API_VERSION;
}
