import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
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

function normalizeAllowedRoots(
  allowedRoots?: string | readonly string[],
): string[] {
  if (!allowedRoots) return [];
  return typeof allowedRoots === "string" ? [allowedRoots] : [...allowedRoots];
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function validateStructuralMatcherShape(adapter: PluginAdapter): void {
  const matcher: unknown = adapter.structuralMatcher;
  if (matcher === undefined) return;
  if (typeof matcher !== "object" || matcher === null) {
    throw new Error(
      `Invalid adapter structuralMatcher for ${adapter.extension}: must be an object`,
    );
  }

  const descriptor = matcher as Record<string, unknown>;
  const identifierNodeTypes = descriptor.identifierNodeTypes;
  if (
    !Array.isArray(identifierNodeTypes) ||
    identifierNodeTypes.length === 0 ||
    !identifierNodeTypes.every(
      (nodeType) => typeof nodeType === "string" && nodeType.length > 0,
    )
  ) {
    throw new Error(
      `Invalid adapter structuralMatcher for ${adapter.extension}: identifierNodeTypes must be a non-empty string array`,
    );
  }

  if (typeof descriptor.createQuery !== "function") {
    throw new Error(
      `Invalid adapter structuralMatcher for ${adapter.extension}: createQuery must be a function`,
    );
  }
}

export async function loadPlugin(
  pluginPath: string,
  allowedRoots?: string | readonly string[],
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

    const realPluginPath = realpathSync(absolutePath);
    const resolvedRoots = normalizeAllowedRoots(allowedRoots);

    // Path containment: resolve symlinks before importing so a trusted path
    // cannot point at code outside the configured trust boundary.
    if (resolvedRoots.length > 0) {
      const realRoots = resolvedRoots.map((root) => {
        const absoluteRoot = path.resolve(root);
        if (!existsSync(absoluteRoot)) {
          throw new Error(`Trusted plugin root not found: ${absoluteRoot}`);
        }
        return realpathSync(absoluteRoot);
      });
      const isTrusted = realRoots.some((root) =>
        isPathWithinRoot(realPluginPath, root),
      );
      if (!isTrusted) {
        return {
          plugin: null as never,
          loaded: false,
          errors: [
            `Plugin path escapes trusted roots: ${realPluginPath} is not within ${realRoots.join(", ")}`,
          ],
        };
      }
    }

    const importUrl = pathToFileURL(realPluginPath).href;
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

    loadedPlugins.set(realPluginPath, pluginModule);

    logger.info("Plugin loaded successfully", {
      name: pluginModule.manifest.name,
      version: pluginModule.manifest.version,
      path: realPluginPath,
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
  allowedRoots?: string | readonly string[],
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
    const result = await loadPlugin(pluginPath, allowedRoots);

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
      validateStructuralMatcherShape(adapter);
    }

    return adapters;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to create adapters from plugin", {
      plugin: plugin.manifest.name,
      error: errorMessage,
    });
    throw new Error(`Failed to create adapters: ${errorMessage}`, {
      cause: error,
    });
  }
}

export function getLoadedPlugins(): AdapterPlugin[] {
  return Array.from(loadedPlugins.values());
}

export function isPluginLoaded(pluginPath: string): boolean {
  const absolutePath = path.resolve(pluginPath);
  const pluginKey = existsSync(absolutePath)
    ? realpathSync(absolutePath)
    : absolutePath;
  return loadedPlugins.has(pluginKey);
}

export function unloadPlugin(pluginPath: string): boolean {
  const absolutePath = path.resolve(pluginPath);
  const pluginKey = existsSync(absolutePath)
    ? realpathSync(absolutePath)
    : absolutePath;
  const removed = loadedPlugins.delete(pluginKey);

  if (removed) {
    logger.info("Plugin unloaded", { path: pluginKey });
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
