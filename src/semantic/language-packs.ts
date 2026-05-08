import { adapters } from "../indexer/adapter/adapters.js";

export interface SemanticLanguagePack {
  languageId: string;
  extensions: string[];
  treeSitter: true;
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
      treeSitter: true as const,
    }))
    .sort((a, b) => a.languageId.localeCompare(b.languageId));
}

export function getSemanticLanguagePack(
  languageId: string,
  packs: readonly SemanticLanguagePack[] = deriveSemanticLanguagePacks(),
): SemanticLanguagePack | null {
  return packs.find((pack) => pack.languageId === languageId) ?? null;
}
