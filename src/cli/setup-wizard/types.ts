export interface SetupWizardAgentChoice {
  value: string;
  label: string;
}

export const SETUP_WIZARD_AGENT_CHOICES = [
  { value: "adal", label: "AdaL" },
  { value: "aider-desk", label: "AiderDesk" },
  { value: "amp", label: "Amp" },
  { value: "antigravity", label: "Antigravity" },
  { value: "antigravity-cli", label: "Antigravity CLI" },
  { value: "astrbot", label: "AstrBot" },
  { value: "augment", label: "Augment" },
  { value: "autohand-code", label: "Autohand Code CLI" },
  { value: "claude-code", label: "Claude Code" },
  { value: "cline", label: "Cline" },
  { value: "codestudio", label: "Code Studio" },
  { value: "codearts-agent", label: "CodeArts Agent" },
  { value: "codebuddy", label: "CodeBuddy" },
  { value: "codemaker", label: "Codemaker" },
  { value: "codex", label: "Codex" },
  { value: "command-code", label: "Command Code" },
  { value: "continue", label: "Continue" },
  { value: "cortex", label: "Cortex Code" },
  { value: "crush", label: "Crush" },
  { value: "cursor", label: "Cursor" },
  { value: "deepagents", label: "Deep Agents" },
  { value: "devin", label: "Devin for Terminal" },
  { value: "dexto", label: "Dexto" },
  { value: "droid", label: "Droid" },
  { value: "eve", label: "Eve" },
  { value: "firebender", label: "Firebender" },
  { value: "forgecode", label: "ForgeCode" },
  { value: "gemini", label: "Gemini CLI" },
  { value: "github-copilot", label: "GitHub Copilot" },
  { value: "goose", label: "Goose" },
  { value: "hermes-agent", label: "Hermes Agent" },
  { value: "bob", label: "IBM Bob" },
  { value: "iflow-cli", label: "iFlow CLI" },
  { value: "inference-sh", label: "inference.sh" },
  { value: "jazz", label: "Jazz" },
  { value: "junie", label: "Junie" },
  { value: "kilo", label: "Kilo Code" },
  { value: "kimi-code-cli", label: "Kimi Code CLI" },
  { value: "kiro-cli", label: "Kiro CLI" },
  { value: "kode", label: "Kode" },
  { value: "lingma", label: "Lingma" },
  { value: "loaf", label: "Loaf" },
  { value: "mcpjam", label: "MCPJam" },
  { value: "mistral-vibe", label: "Mistral Vibe" },
  { value: "moxby", label: "Moxby" },
  { value: "mux", label: "Mux" },
  { value: "neovate", label: "Neovate" },
  { value: "ona", label: "Ona" },
  { value: "openclaw", label: "OpenClaw" },
  { value: "opencode", label: "OpenCode" },
  { value: "openhands", label: "OpenHands" },
  { value: "pi", label: "Pi" },
  { value: "pochi", label: "Pochi" },
  { value: "promptscript", label: "PromptScript" },
  { value: "qoder", label: "Qoder" },
  { value: "qoder-cn", label: "Qoder CN" },
  { value: "qwen-code", label: "Qwen Code" },
  { value: "reasonix", label: "Reasonix" },
  { value: "replit", label: "Replit" },
  { value: "roo", label: "Roo Code" },
  { value: "rovodev", label: "Rovo Dev" },
  { value: "tabnine-cli", label: "Tabnine CLI" },
  { value: "terramind", label: "Terramind" },
  { value: "tinycloud", label: "Tinycloud" },
  { value: "trae", label: "Trae" },
  { value: "trae-cn", label: "Trae CN" },
  { value: "universal", label: "Universal" },
  { value: "warp", label: "Warp" },
  { value: "windsurf", label: "Windsurf" },
  { value: "zed", label: "Zed" },
  { value: "zencoder", label: "Zencoder" },
  { value: "zenflow", label: "Zenflow" },
] as const satisfies readonly SetupWizardAgentChoice[];

export const SETUP_WIZARD_AGENTS: readonly string[] = SETUP_WIZARD_AGENT_CHOICES.map(
  (choice) => choice.value,
);

export const RICH_SETUP_WIZARD_AGENTS = [
  "claude-code",
  "codex",
  "gemini",
  "opencode",
] as const;

export const CORE_LANGUAGE_DEFAULTS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "go",
  "java",
  "cs",
  "c",
  "cpp",
  "rs",
  "kt",
] as const;

export type SetupWizardAgent =
  (typeof SETUP_WIZARD_AGENT_CHOICES)[number]["value"];
export type SemanticTier = "code" | "enhanced" | "off";
export type RepoSizeProfile = "small" | "medium" | "large" | "huge";

export interface SetupWizardPaths {
  configPath?: string;
  graphDbPath?: string;
  modelCachePath?: string;
}

export interface SetupWizardResult {
  repoPath: string;
  globalInstall?: boolean;
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
  defaultRepoPath?: string;
  detectedAgents: string[];
  detectedLanguages: string[];
  defaultLanguages: string[];
  supportedLanguages: string[];
  sourceFileCount: number;
  fromPostinstall?: boolean;
  scanRepo?: (repoPath: string) => {
    detectedLanguages: string[];
    sourceFileCount: number;
  };
}
