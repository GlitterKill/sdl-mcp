import {
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  rmSync,
} from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { InitOptions } from "../types.js";
import { normalizePath } from "../../util/paths.js";
import { resolveCliConfigPath } from "../../config/configPath.js";
import {
  MAX_FILE_BYTES,
  DEFAULT_MAX_WINDOW_LINES,
  DEFAULT_MAX_WINDOW_TOKENS,
  DEFAULT_INDEXING_CONCURRENCY,
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
} from "../../config/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VALID_CLIENTS = ["claude-code", "codex", "gemini", "opencode"] as const;
type ClientType = (typeof VALID_CLIENTS)[number];

const VALID_LANGUAGES = [
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
  "php",
  "rs",
  "kt",
  "sh",
] as const;
type LanguageType = (typeof VALID_LANGUAGES)[number];

function validateLanguages(languages: string[]): LanguageType[] {
  const validLanguages: LanguageType[] = [];
  const invalidLanguages: string[] = [];

  for (const lang of languages) {
    if (VALID_LANGUAGES.includes(lang as LanguageType)) {
      validLanguages.push(lang as LanguageType);
    } else {
      invalidLanguages.push(lang);
    }
  }

  if (invalidLanguages.length > 0) {
    console.error(`\n✗ Invalid languages: ${invalidLanguages.join(", ")}`);
    console.error(`  Valid options: ${VALID_LANGUAGES.join(", ")}`);
    process.exit(1);
  }

  return validLanguages;
}

async function promptForLanguages(): Promise<LanguageType[]> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  console.log("\nAvailable languages:");
  VALID_LANGUAGES.forEach((lang, idx) => {
    console.log(`  ${idx + 1}. ${lang}`);
  });
  console.log(`  0. All (default)`);
  console.log("");

  const answer = await question(
    "Select languages (comma-separated numbers or 0 for all): ",
  );
  rl.close();

  if (answer.trim() === "" || answer.trim() === "0") {
    return [...VALID_LANGUAGES];
  }

  const selectedIndices = answer
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0 && n <= VALID_LANGUAGES.length);

  if (selectedIndices.length === 0) {
    console.log("No languages selected, defaulting to all languages");
    return [...VALID_LANGUAGES];
  }

  return selectedIndices.map((idx) => VALID_LANGUAGES[idx - 1]);
}

async function loadClientTemplate(client: ClientType): Promise<any> {
  const templatePath = resolve(
    __dirname,
    "../../../templates",
    `${client}.json`,
  );
  const content = readFileSync(templatePath, "utf-8");
  return JSON.parse(content);
}

function generateClientConfig(template: any, configPath: string): string {
  const mcpServers = template.mcpServers;
  const config = {
    mcpServers: {
      "sdl-mcp": {
        ...mcpServers["sdl-mcp"],
        env: {
          ...mcpServers["sdl-mcp"].env,
          SDL_CONFIG: normalizePath(configPath),
        },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

export async function initCommand(options: InitOptions): Promise<void> {
  const configPath = resolveCliConfigPath(options.config, "write");
  const repoPath = options.repoPath ?? process.cwd();

  if (existsSync(configPath) && !options.force) {
    console.error(`Configuration file already exists: ${configPath}`);
    console.error(
      "To reinitialize, remove the existing file first or use --force.",
    );
    process.exit(1);
  }

  const dbPath = resolve(dirname(configPath), "sdlmcp.sqlite");
  const configDir = dirname(configPath);
  const dbDir = dirname(dbPath);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const repoId = "my-repo";
  const normalizedRepoPath = normalizePath(repoPath);

  let languages: LanguageType[];
  if (options.languages && options.languages.length > 0) {
    languages = validateLanguages(options.languages);
  } else {
    languages = await promptForLanguages();
  }

  const config = {
    repos: [
      {
        repoId,
        rootPath: normalizedRepoPath,
        ignore: [
          "**/node_modules/**",
          "**/dist/**",
          "**/.next/**",
          "**/build/**",
          "**/.git/**",
          "**/coverage/**",
        ],
        languages,
        maxFileBytes: MAX_FILE_BYTES,
      },
    ],
    dbPath,
    policy: {
      maxWindowLines: DEFAULT_MAX_WINDOW_LINES,
      maxWindowTokens: DEFAULT_MAX_WINDOW_TOKENS,
      requireIdentifiers: true,
      allowBreakGlass: true,
    },
    redaction: {
      enabled: true,
      includeDefaults: true,
      patterns: [],
    },
    indexing: {
      concurrency: DEFAULT_INDEXING_CONCURRENCY,
      enableFileWatching: false,
    },
    slice: {
      defaultMaxCards: DEFAULT_MAX_CARDS,
      defaultMaxTokens: DEFAULT_MAX_TOKENS_SLICE,
      edgeWeights: {
        call: 1.0,
        import: 0.6,
        config: 0.8,
      },
    },
  };

  const createdPaths: string[] = [];
  const createdDirs: string[] = [];

  function rollback(): void {
    for (const path of createdPaths) {
      try {
        if (existsSync(path)) {
          unlinkSync(path);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
    for (const dir of createdDirs) {
      try {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    createdPaths.push(configPath);

    console.log(`✓ Configuration created: ${configPath}`);
    console.log(`✓ Database path: ${dbPath}`);
    console.log(`✓ Repository: ${normalizedRepoPath} (id: ${repoId})`);
    console.log(`✓ Languages: ${languages.join(", ")}`);

    if (options.client) {
      if (!VALID_CLIENTS.includes(options.client as ClientType)) {
        console.error(`\n✗ Invalid client: ${options.client}`);
        console.error(`  Valid options: ${VALID_CLIENTS.join(", ")}`);
        rollback();
        process.exit(1);
      }

      const template = await loadClientTemplate(options.client as ClientType);
      const clientConfig = generateClientConfig(template, configPath);

      const clientConfigPath = resolve(`${options.client}-mcp-config.json`);
      writeFileSync(clientConfigPath, clientConfig);
      createdPaths.push(clientConfigPath);

      console.log(`✓ ${options.client} config created: ${clientConfigPath}`);
      console.log("");
      console.log(`${options.client.toUpperCase()} SETUP INSTRUCTIONS:`);
      console.log(
        `  1. Copy ${options.client}-mcp-config.json to your ${options.client} configuration location`,
      );
      console.log(`  2. Review and adjust configuration as needed`);
    }

    console.log("");
    console.log("Next steps:");
    console.log("  1. Review and adjust configuration as needed");
    console.log("  2. Run: sdl-mcp doctor");
    console.log("  3. Run: sdl-mcp index");
    console.log("  4. Run: sdl-mcp serve");
  } catch (error) {
    console.error(`\n✗ Init failed: ${error}`);
    rollback();
    process.exit(1);
  }
}
