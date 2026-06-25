import type { InitOptions } from "../types.js";
import type {
  RepoSizeProfile,
  SemanticTier,
  SetupWizardAgent,
  SetupWizardPaths,
} from "./types.js";
import { SETUP_WIZARD_AGENTS } from "./types.js";

export function detectRepoSizeProfile(sourceFileCount: number): RepoSizeProfile {
  if (sourceFileCount < 2_000) {
    return "small";
  }
  if (sourceFileCount < 20_000) {
    return "medium";
  }
  if (sourceFileCount <= 100_000) {
    return "large";
  }
  return "huge";
}

export function semanticConfigForTier(tier: SemanticTier): Record<string, unknown> {
  if (tier === "off") {
    return { enabled: false };
  }
  if (tier === "enhanced") {
    return {
      enabled: true,
      provider: "local",
      embeddingProfile: "specialized",
      generateSummaries: false,
    };
  }
  return {
    enabled: true,
    provider: "local",
    symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
    fileSummaryEmbeddingModels: ["nomic-embed-text-v1.5"],
    generateSummaries: false,
  };
}

export interface WizardConfigPatch {
  languageProviders?: boolean;
  semanticTier?: SemanticTier;
  repoSizeProfile?: RepoSizeProfile;
  paths?: SetupWizardPaths;
}

export function applySetupWizardConfig(
  config: {
    indexing?: { pipeline?: string; enableFileWatching?: boolean };
    semantic?: Record<string, unknown>;
    graphDatabase?: { path?: string };
  },
  result: WizardConfigPatch,
): void {
  if (result.languageProviders !== undefined) {
    config.indexing ??= {};
    config.indexing.pipeline = result.languageProviders ? "auto" : "legacy";
  }
  if (result.semanticTier) {
    config.semantic = semanticConfigForTier(result.semanticTier);
  }
  if (result.repoSizeProfile === "huge") {
    config.indexing ??= {};
    config.indexing.enableFileWatching = false;
  }
  if (result.paths?.graphDbPath) {
    config.graphDatabase ??= {};
    config.graphDatabase.path = result.paths.graphDbPath;
  }
  if (result.paths?.modelCachePath) {
    config.semantic ??= {};
    config.semantic.modelCachePath = result.paths.modelCachePath;
  }
}

export function resolveSelectedAgents(
  options: Pick<InitOptions, "agents" | "client">,
  detectedAgents: readonly string[],
): SetupWizardAgent[] {
  const raw = options.agents?.length
    ? options.agents
    : options.client
      ? [options.client]
      : detectedAgents;
  const selected = raw.filter((agent): agent is SetupWizardAgent =>
    SETUP_WIZARD_AGENTS.includes(agent),
  );
  return [...new Set(selected)];
}
