export interface ConfigRecommendation {
  path: string;
  recommendedValue: unknown;
  reason: string;
}

function hasPath(value: unknown, path: readonly string[]): boolean {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || !(segment in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

export function summarizeMissingConfigKeys(rawConfig: unknown): ConfigRecommendation[] {
  const candidates: ConfigRecommendation[] = [
    {
      path: "semantic.embeddingProfile",
      recommendedValue: "specialized",
      reason: "Enhanced embeddings use the existing specialized local profile.",
    },
    {
      path: "semantic.symbolEmbeddingModels",
      recommendedValue: ["jina-embeddings-v2-base-code"],
      reason: "Code embeddings default to Jina for symbols.",
    },
    {
      path: "semantic.fileSummaryEmbeddingModels",
      recommendedValue: ["nomic-embed-text-v1.5"],
      reason: "File-summary embeddings default to Nomic.",
    },
    {
      path: "indexing.providerFirst.lsp",
      recommendedValue: { mode: "primaryWithCaps" },
      reason: "Provider-first indexing needs explicit LSP caps for safe defaults.",
    },
    {
      path: "observability.sampleIntervalMs",
      recommendedValue: 2000,
      reason: "Observability sampling defaults keep dashboard metrics current.",
    },
  ];

  return candidates.filter((item) => !hasPath(rawConfig, item.path.split(".")));
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

export function applyMissingConfigRecommendations(
  rawConfig: Record<string, unknown>,
  recommendations: readonly ConfigRecommendation[],
): void {
  for (const recommendation of recommendations) {
    const parts = recommendation.path.split(".");
    let current = rawConfig;
    for (const part of parts.slice(0, -1)) {
      current = ensureObject(current, part);
    }
    const leaf = parts[parts.length - 1];
    if (!(leaf in current)) {
      current[leaf] = recommendation.recommendedValue;
    }
  }
}
