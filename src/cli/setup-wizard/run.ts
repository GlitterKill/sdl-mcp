import type { InitOptions } from "../types.js";
import type { SemanticTier, SetupWizardAgent, SetupWizardInput, SetupWizardResult } from "./types.js";

const SETUP_WIZARD_AGENTS = ["claude-code", "codex", "gemini", "opencode"] as const;

export function shouldRunSetupWizard(
  options: Pick<InitOptions, "yes" | "dryRun" | "fromPostinstall">,
  isTTY: boolean,
): boolean {
  return isTTY && options.yes !== true && options.dryRun !== true;
}

function chooseTier(answer: string): SemanticTier {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "2" || normalized === "enhanced") {
    return "enhanced";
  }
  if (normalized === "3" || normalized === "off") {
    return "off";
  }
  return "code";
}

function chooseProfile(answer: string, fallback: "small" | "medium" | "large" | "huge") {
  const normalized = answer.trim().toLowerCase();
  return ["small", "medium", "large", "huge"].includes(normalized)
    ? (normalized as typeof fallback)
    : fallback;
}

export async function runSetupWizard(input: SetupWizardInput): Promise<SetupWizardResult> {
  const [{ missingLspManualCommands }, { detectRepoSizeProfile }, terminal] =
    await Promise.all([
      import("./lsp.js"),
      import("./recommendations.js"),
      import("./terminal.js"),
    ]);

  terminal.renderBanner();

  const repoPath = await terminal.inputText("Repository path", input.defaultRepoPath);
  const agentDefaults = input.detectedAgents.filter((agent): agent is SetupWizardAgent =>
    SETUP_WIZARD_AGENTS.includes(agent as SetupWizardAgent),
  );
  const agents = await terminal.multiSelect(
    "Agents",
    SETUP_WIZARD_AGENTS,
    agentDefaults.length > 0 ? agentDefaults : ["codex"],
  );
  const languageProviders = await terminal.confirm(
    "Use Language Providers for faster, more accurate indexing when trusted provider facts are available?",
    true,
  );
  const languages = await terminal.multiSelect(
    "Languages",
    input.detectedLanguages.length > 0 ? input.detectedLanguages : ["ts", "js"],
    input.detectedLanguages.length > 0 ? input.detectedLanguages : ["ts", "js"],
  );

  console.log("Semantic tier: 1. Code  2. Enhanced  3. Off");
  const semanticTier = chooseTier(await terminal.inputText("Semantic tier", "code"));
  const detectedProfile = detectRepoSizeProfile(input.sourceFileCount);
  const repoSizeProfile = chooseProfile(
    await terminal.inputText("Repo size profile", detectedProfile),
    detectedProfile,
  );

  const useDefaultLocations = await terminal.confirm("Use default locations?", true);
  const paths = useDefaultLocations
    ? {}
    : {
        configPath: await terminal.inputText("Config path", "sdlmcp.config.json"),
        graphDbPath: await terminal.inputText("Graph DB path", "sdl-mcp-graph.lbug"),
        modelCachePath: await terminal.inputText("Model cache path", ".sdl-models"),
      };
  const lspManualCommands = missingLspManualCommands(languages);
  const writeConfig = await terminal.confirm("Write configuration now?", true);
  const firstIndex = await terminal.confirm(
    "Run first index now?",
    !input.fromPostinstall && repoSizeProfile !== "huge",
  );

  return {
    repoPath,
    languages,
    agents,
    languageProviders,
    semanticTier,
    repoSizeProfile,
    paths,
    lspManualCommands,
    writeConfig,
    firstIndex,
  };
}
