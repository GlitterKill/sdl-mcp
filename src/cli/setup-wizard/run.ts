import type { InitOptions } from "../types.js";
import type {
  RepoSizeProfile,
  SemanticTier,
  SetupWizardInput,
  SetupWizardResult,
} from "./types.js";
import { SETUP_WIZARD_AGENT_CHOICES } from "./types.js";

export const SETUP_WIZARD_EMBEDDING_CHOICES = [
  {
    value: "code",
    label: "Code (Jina symbol embeddings, no file summaries)",
  },
  {
    value: "enhanced",
    label: "Enhanced (Jina symbol embeddings and Nomic file summaries)",
  },
  { value: "off", label: "Off (Disable semantic embeddings)" },
] satisfies readonly { value: SemanticTier; label: string; hint?: string }[];

const REPO_SIZE_CHOICES = [
  { value: "small", label: "Small", hint: "Under 2k source files" },
  { value: "medium", label: "Medium", hint: "2k-20k source files" },
  { value: "large", label: "Large", hint: "20k-100k source files" },
  { value: "huge", label: "Huge", hint: "Over 100k; disables file watching" },
] satisfies readonly { value: RepoSizeProfile; label: string; hint: string }[];

export const SETUP_WIZARD_LANGUAGE_LABELS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TSX (.tsx)",
  js: "JavaScript",
  jsx: "JSX (.jsx)",
  py: "Python",
  go: "Go",
  java: "Java",
  cs: "C#",
  c: "C",
  cpp: "C++",
  php: "PHP",
  rs: "Rust",
  kt: "Kotlin",
  sh: "Shell / Bash",
  powershell: "PowerShell",
  ruby: "Ruby",
  lua: "Lua",
  dart: "Dart",
  swift: "Swift",
  groovy: "Groovy",
  perl: "Perl",
  r: "R",
  elixir: "Elixir",
  fsharp: "F#",
  fortran: "Fortran",
  haskell: "Haskell",
};

export function shouldRunSetupWizard(
  options: Pick<InitOptions, "yes" | "dryRun" | "fromPostinstall">,
  isTTY: boolean,
): boolean {
  return isTTY && options.yes !== true;
}

export async function runSetupWizard(
  input: SetupWizardInput,
): Promise<SetupWizardResult> {
  const [{ missingLspManualCommands }, { detectRepoSizeProfile }, terminal] =
    await Promise.all([
      import("./lsp.js"),
      import("./recommendations.js"),
      import("./terminal.js"),
    ]);

  terminal.renderBanner();

  const repoPath = input.defaultRepoPath
    ? await terminal.inputText("Repository path", input.defaultRepoPath)
    : await terminal.inputOptionalText(
        "Repository path (leave blank for global install)",
        "No repo path",
      );
  const globalInstall = !repoPath;
  if (globalInstall) {
    console.log("Global install selected. No repository config will be written.");
  }
  const detectedAgents = new Set(input.detectedAgents);
  const agentDefaults = SETUP_WIZARD_AGENT_CHOICES.map((choice) => choice.value).filter(
    (agent) => detectedAgents.has(agent),
  );
  const undetectedAgentHint = globalInstall
    ? "not detected; selected configs are saved to ~/.sdl-mcp/resources/configs"
    : "not detected; selected configs are saved to ~/.sdl-mcp/configs";
  const agentChoices = SETUP_WIZARD_AGENT_CHOICES.map((choice) => ({
    ...choice,
    hint: detectedAgents.has(choice.value) ? "detected" : undetectedAgentHint,
  }));
  const agents = await terminal.multiSelect(
    "Agents",
    agentChoices,
    agentDefaults,
  );
  const languageProviders = await terminal.confirm(
    "Use Language Providers for faster, more accurate indexing when trusted provider facts are available?",
    true,
  );
  const repoScan = repoPath
    ? input.scanRepo?.(repoPath) ?? {
        detectedLanguages: input.detectedLanguages,
        sourceFileCount: input.sourceFileCount,
      }
    : { detectedLanguages: input.defaultLanguages, sourceFileCount: 0 };
  const languageDefaults = repoScan.detectedLanguages.length > 0
    ? repoScan.detectedLanguages
    : input.defaultLanguages;
  const coreLanguages = new Set(input.defaultLanguages);
  const languageChoices = input.supportedLanguages.map((language) => ({
    value: language,
    label: SETUP_WIZARD_LANGUAGE_LABELS[language] ?? language,
    hint: coreLanguages.has(language)
      ? "core built-in"
      : "provider-supported; installed on demand",
  }));
  const languages = await terminal.multiSelect(
    "Supported languages",
    languageChoices,
    languageDefaults,
  );
  const semanticTier = await terminal.selectOne(
    "Embeddings",
    SETUP_WIZARD_EMBEDDING_CHOICES,
    "code",
  );

  if (globalInstall) {
    const writeConfig = await terminal.confirm("Write global resources now?", true);
    return {
      repoPath: "",
      globalInstall: true,
      languages,
      agents,
      languageProviders,
      semanticTier,
      repoSizeProfile: "small",
      paths: {},
      lspManualCommands: [],
      writeConfig,
      firstIndex: false,
    };
  }

  const detectedProfile = detectRepoSizeProfile(repoScan.sourceFileCount);
  const repoSizeProfile = await terminal.selectOne(
    "Repo size profile",
    REPO_SIZE_CHOICES,
    detectedProfile,
  );

  const useDefaultLocations = await terminal.confirm(
    "Use default locations?",
    true,
  );
  const paths = useDefaultLocations
    ? {}
    : {
        configPath: await terminal.inputText(
          "Config path",
          "sdlmcp.config.json",
        ),
        graphDbPath: await terminal.inputText(
          "Graph DB path",
          "sdl-mcp-graph.lbug",
        ),
        modelCachePath: await terminal.inputText(
          "Model cache path",
          ".sdl-models",
        ),
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
