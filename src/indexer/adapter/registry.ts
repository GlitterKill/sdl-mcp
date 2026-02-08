import type { LanguageAdapter } from "./LanguageAdapter.js";
import { adapters as builtInAdapters } from "./adapters.js";

type AdapterFactory = () => LanguageAdapter;

interface AdapterEntry {
  languageId: string;
  factory: AdapterFactory;
  adapter: LanguageAdapter | null;
}

const ADAPTER_REGISTRY = new Map<string, AdapterEntry>();

let builtInAdaptersLoaded = false;

function loadBuiltInAdapters(): void {
  if (builtInAdaptersLoaded) {
    return;
  }

  for (const { extension, languageId, factory } of builtInAdapters) {
    ADAPTER_REGISTRY.set(extension.toLowerCase(), {
      languageId,
      factory,
      adapter: null,
    });
  }

  builtInAdaptersLoaded = true;
}

function registerAdapter(
  extension: string,
  languageId: string,
  factory: AdapterFactory,
): void {
  ADAPTER_REGISTRY.set(extension.toLowerCase(), {
    languageId,
    factory,
    adapter: null,
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
    entry.adapter = entry.factory();
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

export {
  registerAdapter,
  getAdapterForExtension,
  getSupportedExtensions,
  getLanguageIdForExtension,
  loadBuiltInAdapters,
};
