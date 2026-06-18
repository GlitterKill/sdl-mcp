import type {
  IndexingConfig,
  ScipConfig,
  SemanticEnrichmentConfig,
} from "../../config/types.js";
import type {
  ProviderFirstPipelineSelection,
  ProviderSourcePlan,
} from "./types.js";

export interface ResolveProviderFirstPipelineInput {
  indexing?: IndexingConfig;
  scip?: ScipConfig;
  semanticEnrichment?: SemanticEnrichmentConfig;
}

export function resolveProviderFirstPipeline(
  input: ResolveProviderFirstPipelineInput,
): ProviderFirstPipelineSelection {
  const requestedMode = input.indexing?.pipeline ?? "auto";
  const providerSources = [
    ...scipSources(input.scip, input.semanticEnrichment),
    ...lspSources(input.semanticEnrichment),
  ];

  if (requestedMode === "legacy" && providerSources.length === 0) {
    return {
      requestedMode,
      selectedPipeline: "legacy",
      sources: [legacySource(0, "indexing.pipeline is legacy")],
      warnings: [],
    };
  }

  if (providerSources.length === 0 && requestedMode === "auto") {
    return {
      requestedMode,
      selectedPipeline: "legacy",
      sources: [legacySource(0, "no SCIP or LSP provider coverage configured")],
      warnings: [],
    };
  }

  const warnings =
    requestedMode === "legacy"
      ? [
          "indexing.pipeline is legacy but SCIP or LSP provider inputs are enabled; provider-first is required for provider-owned facts",
        ]
      : providerSources.length === 0
      ? ["indexing.pipeline is providerFirst but no SCIP or LSP providers are configured"]
      : [];

  return {
    requestedMode,
    selectedPipeline: "providerFirst",
    sources: [
      ...providerSources,
      legacySource(
        providerSources.length + 1,
        "fallback for unsupported languages and partial provider coverage",
      ),
    ],
    warnings,
  };
}

function scipSources(
  scip: ScipConfig | undefined,
  semanticEnrichment: SemanticEnrichmentConfig | undefined,
): ProviderSourcePlan[] {
  const sources: ProviderSourcePlan[] = [];
  if (scip?.enabled === true) {
    sources.push({
      type: "scip",
      providerId: "scip",
      priority: 0,
      reason:
        scip.indexes.length > 0 || scip.generator.enabled === true
          ? "top-level SCIP indexes or generator configured"
          : "top-level SCIP provider enabled",
    });
  }

  const semanticScip = semanticEnrichment?.providers.scip;
  const semanticScipConfigured =
    semanticScip?.enabled !== false && (semanticScip?.indexes.length ?? 0) > 0;
  if (semanticScipConfigured) {
    sources.push({
      type: "scip",
      providerId: semanticScip?.providerId ?? "semantic-scip",
      priority: sources.length,
      reason: "semantic enrichment SCIP indexes configured",
    });
  }

  return dedupeProviderSources(sources);
}

function lspSources(
  semanticEnrichment: SemanticEnrichmentConfig | undefined,
): ProviderSourcePlan[] {
  const lsp = semanticEnrichment?.providers.lsp;
  if (!lsp || lsp.enabled === false) return [];

  return Object.entries(lsp.servers)
    .filter(([, server]) => server.enabled !== false)
    .map(([serverKey, server], index) => ({
      type: "lsp" as const,
      providerId: server.serverId || serverKey,
      priority: index + 10,
      reason: "configured LSP server",
    }));
}

function legacySource(priority: number, reason: string): ProviderSourcePlan {
  return {
    type: "legacy",
    providerId: "legacy",
    priority,
    reason,
  };
}

function dedupeProviderSources(
  sources: ProviderSourcePlan[],
): ProviderSourcePlan[] {
  const seen = new Set<string>();
  const deduped: ProviderSourcePlan[] = [];
  for (const source of sources) {
    const key = `${source.type}:${source.providerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...source, priority: deduped.length });
  }
  return deduped;
}
