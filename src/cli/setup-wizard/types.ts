export const SETUP_WIZARD_AGENTS = [
  "claude-code",
  "codex",
  "gemini",
  "opencode",
] as const;

export type SetupWizardAgent = (typeof SETUP_WIZARD_AGENTS)[number];
export type SemanticTier = "code" | "enhanced" | "off";
export type RepoSizeProfile = "small" | "medium" | "large" | "huge";

export interface SetupWizardPaths {
  configPath?: string;
  graphDbPath?: string;
  modelCachePath?: string;
}

export interface SetupWizardResult {
  repoPath: string;
  languages: string[];
  agents: SetupWizardAgent[];
  languageProviders: boolean;
  semanticTier: SemanticTier;
  repoSizeProfile: RepoSizeProfile;
  paths: SetupWizardPaths;
  lspManualCommands: string[];
  writeConfig: boolean;
  firstIndex: boolean;
}

export interface SetupWizardInput {
  defaultRepoPath: string;
  detectedAgents: string[];
  detectedLanguages: string[];
  sourceFileCount: number;
  fromPostinstall?: boolean;
}
