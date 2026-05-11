import { adapters } from "../indexer/adapter/adapters.js";
import type { SemanticEnrichmentConfig } from "../config/types.js";

export interface SemanticLanguagePack {
  languageId: string;
  extensions: string[];
  treeSitter: boolean;
}

interface AdapterLike {
  languageId: string;
  extension: string;
}

/**
 * Build semantic language support from the parser adapter registry so the
 * enrichment bridge cannot drift away from the base tree-sitter indexer.
 */
export function deriveSemanticLanguagePacks(
  adapterEntries: readonly AdapterLike[] = adapters,
): SemanticLanguagePack[] {
  const byLanguage = new Map<string, Set<string>>();
  for (const entry of adapterEntries) {
    const extensions = byLanguage.get(entry.languageId) ?? new Set<string>();
    extensions.add(entry.extension);
    byLanguage.set(entry.languageId, extensions);
  }

  return [...byLanguage.entries()]
    .map(([languageId, extensions]) => ({
      languageId,
      extensions: [...extensions].sort(),
      treeSitter: true,
    }))
    .sort((a, b) => a.languageId.localeCompare(b.languageId));
}

export function extendLanguagePacksForLsp(
  packs: readonly SemanticLanguagePack[],
  config: SemanticEnrichmentConfig,
): SemanticLanguagePack[] {
  const byLanguage = new Map(
    packs.map((pack) => [
      pack.languageId,
      {
        languageId: pack.languageId,
        extensions: new Set(pack.extensions),
        treeSitter: pack.treeSitter,
      },
    ]),
  );

  for (const server of Object.values(config.providers.lsp?.servers ?? {})) {
    if (server.enabled === false) continue;
    const extensions = extensionsFromFilePatterns(server.filePatterns);
    for (const languageId of server.languages) {
      const existing = byLanguage.get(languageId) ?? {
        languageId,
        extensions: new Set<string>(),
        treeSitter: false,
      };
      for (const extension of extensions) existing.extensions.add(extension);
      byLanguage.set(languageId, existing);
    }
  }

  return [...byLanguage.values()]
    .map((pack) => ({
      languageId: pack.languageId,
      extensions: [...pack.extensions].sort(),
      treeSitter: pack.treeSitter,
    }))
    .sort((a, b) => a.languageId.localeCompare(b.languageId));
}

function extensionsFromFilePatterns(patterns: readonly string[]): string[] {
  const extensions = new Set<string>();
  for (const pattern of patterns) {
    const match = /\*\.([A-Za-z0-9_-]+)$/.exec(pattern);
    if (match?.[1]) extensions.add(`.${match[1]}`);
  }
  return [...extensions];
}

export function getSemanticLanguagePack(
  languageId: string,
  packs: readonly SemanticLanguagePack[] = deriveSemanticLanguagePacks(),
): SemanticLanguagePack | null {
  return packs.find((pack) => pack.languageId === languageId) ?? null;
}
