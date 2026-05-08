import { createHash } from "node:crypto";

export interface SemanticCacheKeyParts {
  repoId: string;
  languageId: string;
  sourceHashes: Record<string, string>;
  providerVersion?: string;
  providerCommand?: string;
  providerBinaryPath?: string;
  treeSitterAdapterVersion?: string;
  configHash?: string;
  dependencyLockfileHash?: string;
  projectConfigHashes?: Record<string, string>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashSemanticCacheParts(parts: SemanticCacheKeyParts): string {
  return createHash("sha256").update(stableJson(parts)).digest("hex");
}

export function createSemanticCacheKey(parts: SemanticCacheKeyParts): string {
  return `semantic-enrichment:${parts.repoId}:${parts.languageId}:${hashSemanticCacheParts(parts)}`;
}
