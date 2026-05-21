import { EMBEDDING_MODELS } from "../retrieval/model-mapping.js";
import type { SemanticConfig } from "./types.js";

export const SPECIALIZED_SYMBOL_EMBEDDING_MODELS = [
  "jina-embeddings-v2-base-code",
] as const;
export const SPECIALIZED_FILE_SUMMARY_EMBEDDING_MODELS = [
  "nomic-embed-text-v1.5",
] as const;
export const MAX_RECALL_EMBEDDING_MODELS = [
  "jina-embeddings-v2-base-code",
  "nomic-embed-text-v1.5",
] as const;

export type SemanticEmbeddingProfile = "specialized" | "max-recall";

export interface SemanticEmbeddingModelPlan {
  profile: SemanticEmbeddingProfile;
  symbolEmbeddingModels: string[];
  fileSummaryEmbeddingModels: string[];
  unsupportedModels: string[];
}

function dedupePreservingOrder(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const model of models) {
    if (seen.has(model)) {
      continue;
    }
    seen.add(model);
    deduped.push(model);
  }
  return deduped;
}

function filterSupportedModels(models: readonly string[]): {
  supported: string[];
  unsupported: string[];
} {
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const model of dedupePreservingOrder(models)) {
    if (EMBEDDING_MODELS[model]) {
      supported.push(model);
    } else {
      unsupported.push(model);
    }
  }
  return { supported, unsupported };
}

function profileDefaults(profile: SemanticEmbeddingProfile): {
  symbolEmbeddingModels: readonly string[];
  fileSummaryEmbeddingModels: readonly string[];
} {
  if (profile === "max-recall") {
    return {
      symbolEmbeddingModels: MAX_RECALL_EMBEDDING_MODELS,
      fileSummaryEmbeddingModels: MAX_RECALL_EMBEDDING_MODELS,
    };
  }
  return {
    symbolEmbeddingModels: SPECIALIZED_SYMBOL_EMBEDDING_MODELS,
    fileSummaryEmbeddingModels: SPECIALIZED_FILE_SUMMARY_EMBEDDING_MODELS,
  };
}

export function resolveSemanticEmbeddingModelPlan(
  semanticConfig: SemanticConfig | undefined,
): SemanticEmbeddingModelPlan {
  const profile = semanticConfig?.embeddingProfile ?? "specialized";
  const hasProfileOrLaneConfig =
    semanticConfig?.embeddingProfile !== undefined ||
    semanticConfig?.symbolEmbeddingModels !== undefined ||
    semanticConfig?.fileSummaryEmbeddingModels !== undefined;

  const defaults = profileDefaults(profile);
  const legacySharedModels =
    !hasProfileOrLaneConfig &&
    (semanticConfig?.model !== undefined ||
      semanticConfig?.additionalModels !== undefined)
      ? [
          semanticConfig.model ?? "jina-embeddings-v2-base-code",
          ...(semanticConfig.additionalModels ?? []),
        ]
      : null;

  const symbolCandidates =
    semanticConfig?.symbolEmbeddingModels ??
    legacySharedModels ??
    defaults.symbolEmbeddingModels;
  const fileSummaryCandidates =
    semanticConfig?.fileSummaryEmbeddingModels ??
    legacySharedModels ??
    defaults.fileSummaryEmbeddingModels;

  const symbol = filterSupportedModels(symbolCandidates);
  const fileSummary = filterSupportedModels(fileSummaryCandidates);
  const unsupportedModels = dedupePreservingOrder([
    ...symbol.unsupported,
    ...fileSummary.unsupported,
  ]);

  return {
    profile,
    symbolEmbeddingModels: symbol.supported,
    fileSummaryEmbeddingModels: fileSummary.supported,
    unsupportedModels,
  };
}
