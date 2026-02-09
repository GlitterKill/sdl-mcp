import type { LanguageAdapter } from "./LanguageAdapter.js";
import { adapters as builtInAdapters } from "./adapters.js";
import { loadPluginsFromConfig, getPluginAdapters } from "./plugin/index.js";
import { logger } from "../../util/logger.js";

type AdapterFactory = () => LanguageAdapter;

interface AdapterEntry {
  languageId: string;
  factory: AdapterFactory;
  adapter: LanguageAdapter | null;
  source: "builtin" | "plugin";
  pluginName?: string;
}

const ADAPTER_REGISTRY = new Map<string, AdapterEntry>();

let builtInAdaptersLoaded = false;
let pluginsLoaded = false;

function loadBuiltInAdapters(): void {
  if (builtInAdaptersLoaded) {
    return;
  }

  for (const { extension, languageId, factory } of builtInAdapters) {
    ADAPTER_REGISTRY.set(extension.toLowerCase(), {
      languageId,
      factory,
      adapter: null,
      source: "builtin",
    });
  }

  builtInAdaptersLoaded = true;
}

async function loadPlugins(pluginPaths: string[] | undefined): Promise<void> {
  if (pluginsLoaded || !pluginPaths || pluginPaths.length === 0) {
    return;
  }

  const { successful, failed } = await loadPluginsFromConfig(pluginPaths);

  for (const plugin of successful) {
    try {
      const pluginAdapters = await getPluginAdapters(plugin);

      for (const adapter of pluginAdapters) {
        const extension = adapter.extension.toLowerCase();
        const existing = ADAPTER_REGISTRY.get(extension);

        if (existing && existing.source === "builtin") {
          logger.warn(
            `Plugin overriding built-in adapter for extension ${extension}`,
            {
              pluginName: plugin.manifest.name,
              extension,
            },
          );
        }

        ADAPTER_REGISTRY.set(extension, {
          languageId: adapter.languageId,
          factory: adapter.factory,
          adapter: null,
          source: "plugin",
          pluginName: plugin.manifest.name,
        });
      }

      logger.info(`Registered plugin ${plugin.manifest.name}`, {
        adapters: pluginAdapters.length,
        extensions: pluginAdapters.map((a) => a.extension),
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`Failed to register plugin ${plugin.manifest.name}`, {
        error: errorMessage,
      });
    }
  }

  if (failed.length > 0) {
    logger.warn(`${failed.length} plugin(s) failed to load`, {
      failedPlugins: failed.map((f) => ({
        path: f.pluginPath,
        error: f.error,
      })),
    });
  }

  pluginsLoaded = true;
}

async function loadPluginsSync(
  pluginPaths: string[] | undefined,
): Promise<void> {
  await loadPlugins(pluginPaths);
}

function registerAdapter(
  extension: string,
  languageId: string,
  factory: AdapterFactory,
  source: "builtin" | "plugin" = "builtin",
  pluginName?: string,
): void {
  ADAPTER_REGISTRY.set(extension.toLowerCase(), {
    languageId,
    factory,
    adapter: null,
    source,
    pluginName,
  });
}

function getAdapterForExtension(ext: string): LanguageAdapter | null {
  loadBuiltInAdapters();

  const normalizedExt = ext.toLowerCase();
  const entry = ADAPTER_REGISTRY.get(normalizedExt);

  if (!entry) {
    return null;
  }

  if (!entry.adapter) {
    try {
      entry.adapter = entry.factory();
    } catch (error) {
      logger.error(`Failed to create adapter for extension ${normalizedExt}`, {
        source: entry.source,
        pluginName: entry.pluginName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return entry.adapter;
}

function getSupportedExtensions(): string[] {
  loadBuiltInAdapters();
  return Array.from(ADAPTER_REGISTRY.keys());
}

function getLanguageIdForExtension(ext: string): string | null {
  loadBuiltInAdapters();
  const normalizedExt = ext.toLowerCase();
  const entry = ADAPTER_REGISTRY.get(normalizedExt);
  return entry ? entry.languageId : null;
}

function getAdapterInfo(ext: string): {
  languageId: string | null;
  source: "builtin" | "plugin" | null;
  pluginName: string | undefined;
} {
  loadBuiltInAdapters();
  const normalizedExt = ext.toLowerCase();
  const entry = ADAPTER_REGISTRY.get(normalizedExt);
  return entry
    ? {
        languageId: entry.languageId,
        source: entry.source,
        pluginName: entry.pluginName,
      }
    : {
        languageId: null,
        source: null,
        pluginName: undefined,
      };
}

function resetRegistry(): void {
  ADAPTER_REGISTRY.clear();
  builtInAdaptersLoaded = false;
  pluginsLoaded = false;
}

export {
  registerAdapter,
  getAdapterForExtension,
  getSupportedExtensions,
  getLanguageIdForExtension,
  loadBuiltInAdapters,
  loadPlugins,
  loadPluginsSync,
  getAdapterInfo,
  resetRegistry,
};
