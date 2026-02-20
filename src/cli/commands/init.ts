import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, resolve } from "path";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { getDb } from "../../db/db.js";
import { createRepo, getRepo } from "../../db/queries.js";
import { runMigrations } from "../../db/migrations.js";
import { WATCHER_DEFAULT_MAX_WATCHED_FILES } from "../../config/constants.js";
import {
  DEFAULT_INDEXING_CONCURRENCY,
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
  DEFAULT_MAX_WINDOW_LINES,
  DEFAULT_MAX_WINDOW_TOKENS,
  MAX_FILE_BYTES,
} from "../../config/constants.js";
import { resolveCliConfigPath } from "../../config/configPath.js";
import { indexRepo } from "../../indexer/indexer.js";
import { logSetupPipelineEvent } from "../../mcp/telemetry.js";
import { normalizePath } from "../../util/paths.js";
import { InitOptions } from "../types.js";
import { doctorCommand } from "./doctor.js";

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

const DEFAULT_IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/build/**",
  "**/.git/**",
  "**/coverage/**",
];

const LANGUAGE_BY_EXTENSION: Record<string, LanguageType> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  py: "py",
  go: "go",
  java: "java",
  cs: "cs",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  php: "php",
  rs: "rs",
  kt: "kt",
  kts: "kt",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
};

const SKIP_SCAN_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
]);

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
    console.error(`Invalid languages: ${invalidLanguages.join(", ")}`);
    console.error(`Valid options: ${VALID_LANGUAGES.join(", ")}`);
    process.exit(1);
  }

  return validLanguages;
}

export function detectLanguagesFromRepo(repoRoot: string): LanguageType[] {
  const found = new Set<LanguageType>();

  const walk = (current: string): void => {
    if (found.size === VALID_LANGUAGES.length) {
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (SKIP_SCAN_DIRS.has(entry)) {
          continue;
        }
        walk(fullPath);
        continue;
      }

      const dot = entry.lastIndexOf(".");
      if (dot < 0 || dot === entry.length - 1) {
        continue;
      }
      const ext = entry.slice(dot + 1).toLowerCase();
      const mapped = LANGUAGE_BY_EXTENSION[ext];
      if (mapped) {
        found.add(mapped);
      }
    }
  };

  walk(repoRoot);
  if (found.size === 0) {
    return [...VALID_LANGUAGES];
  }
  return [...found].sort();
}

function sanitizeRepoId(raw: string): string {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return value || "my-repo";
}

export function detectRepoId(repoRoot: string): string {
  const packageJsonPath = join(repoRoot, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
        return sanitizeRepoId(parsed.name);
      }
    } catch {
      // Ignore malformed package.json and fall back to directory name.
    }
  }

  return sanitizeRepoId(basename(repoRoot));
}

function promptForLanguages(): Promise<LanguageType[]> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolveQuestion) => rl.question(prompt, resolveQuestion));

  return (async () => {
    console.log("\nAvailable languages:");
    VALID_LANGUAGES.forEach((lang, idx) => {
      console.log(`  ${idx + 1}. ${lang}`);
    });
    console.log("  0. All (default)");
    console.log("");

    const answer = await question(
      "Select languages (comma-separated numbers or 0 for all): ",
    );
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
  })().finally(() => {
    rl.close();
  });
}

function parseGitignorePatterns(repoRoot: string): string[] {
  const gitignorePath = join(repoRoot, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return [];
  }

  const lines = readFileSync(gitignorePath, "utf-8")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));

  const patterns: string[] = [];
  for (const line of lines) {
    const normalized = normalizePath(line).replace(/^\.\//, "").replace(/^\/+/, "");
    if (!normalized) {
      continue;
    }
    if (normalized.endsWith("/")) {
      const bare = normalized.slice(0, -1);
      if (bare) {
        patterns.push(`**/${bare}/**`);
      }
      continue;
    }

    if (normalized.includes("*") || normalized.includes("?") || normalized.includes("[")) {
      patterns.push(normalized.startsWith("**/") ? normalized : `**/${normalized}`);
      continue;
    }

    patterns.push(`**/${normalized}`);
    patterns.push(`**/${normalized}/**`);
  }

  return patterns;
}

export function mergeIgnorePatterns(repoRoot: string): string[] {
  const merged = [...DEFAULT_IGNORE_PATTERNS];
  for (const pattern of parseGitignorePatterns(repoRoot)) {
    if (!merged.includes(pattern)) {
      merged.push(pattern);
    }
  }
  return merged;
}

async function loadClientTemplate(client: ClientType): Promise<unknown> {
  const templatePath = resolve(__dirname, "../../../templates", `${client}.json`);
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

function buildGenericClientConfig(configPath: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "sdl-mcp": {
          command: "npx",
          args: ["--yes", "sdl-mcp@latest", "serve", "--stdio"],
          env: {
            SDL_CONFIG: normalizePath(configPath),
          },
        },
      },
    },
    null,
    2,
  );
}

type ClientDetection = {
  name: string;
  configPath: string;
  templateClient?: ClientType;
};

function detectInstalledClients(): ClientDetection[] {
  const userProfile = process.env.USERPROFILE ?? "";
  const appData = process.env.APPDATA ?? "";
  const detections: Array<{
    name: string;
    templateClient?: ClientType;
    candidates: string[];
  }> = [
    {
      name: "claude-code",
      templateClient: "claude-code",
      candidates: [
        join(userProfile, ".claude.json"),
        join(userProfile, ".claude", "settings.json"),
        join(appData, "Claude", "claude_desktop_config.json"),
      ],
    },
    {
      name: "cursor",
      candidates: [
        join(userProfile, ".cursor", "mcp.json"),
        join(appData, "Cursor", "User", "settings.json"),
      ],
    },
    {
      name: "codex",
      templateClient: "codex",
      candidates: [join(userProfile, ".codex", "config.json")],
    },
    {
      name: "gemini",
      templateClient: "gemini",
      candidates: [join(userProfile, ".gemini", "settings.json")],
    },
    {
      name: "opencode",
      templateClient: "opencode",
      candidates: [
        join(userProfile, ".opencode", "config.json"),
        join(appData, "opencode", "config.json"),
      ],
    },
  ];

  const installed: ClientDetection[] = [];
  for (const client of detections) {
    const hit = client.candidates.find((path) => path && existsSync(path));
    if (hit) {
      installed.push({
        name: client.name,
        templateClient: client.templateClient,
        configPath: normalizePath(hit),
      });
    }
  }
  if (installed.length === 0) {
    installed.push({
      name: "generic-mcp-client",
      configPath: "manual-config",
    });
  }
  return installed;
}

async function emitClientConfigBlocks(configPath: string): Promise<void> {
  const detections = detectInstalledClients();
  console.log("");
  console.log("Detected MCP clients and config blocks:");
  for (const detection of detections) {
    let block: string;
    if (detection.templateClient) {
      const template = await loadClientTemplate(detection.templateClient);
      block = generateClientConfig(template, configPath);
    } else {
      block = buildGenericClientConfig(configPath);
    }

    console.log(`- ${detection.name}: ${detection.configPath}`);
    console.log(block);
    console.log("");
  }
}

function printDryRunPreview(configPath: string, config: unknown): void {
  console.log("Dry run: no files written.");
  console.log(`Target config path: ${normalizePath(configPath)}`);
  console.log("");
  console.log(JSON.stringify(config, null, 2));
}

export async function initCommand(options: InitOptions): Promise<void> {
  const startedAt = Date.now();
  const configPath = resolveCliConfigPath(options.config, "write");
  const repoRoot = resolve(options.repoPath ?? process.cwd());
  const normalizedRepoPath = normalizePath(repoRoot);
  const nonInteractive = options.yes === true;
  const autoIndex = options.autoIndex ?? nonInteractive;

  if (existsSync(configPath) && !options.force && !options.dryRun) {
    console.error(`Configuration file already exists: ${configPath}`);
    console.error("To reinitialize, remove the existing file first or use --force.");
    process.exit(1);
  }

  const dbPath = resolve(dirname(configPath), "sdlmcp.sqlite");
  const configDir = dirname(configPath);
  const dbDir = dirname(dbPath);

  const repoId = detectRepoId(repoRoot);
  const ignorePatterns = mergeIgnorePatterns(repoRoot);

  let languages: LanguageType[];
  if (options.languages && options.languages.length > 0) {
    languages = validateLanguages(options.languages);
  } else if (nonInteractive) {
    languages = detectLanguagesFromRepo(repoRoot);
    console.log(`Detected languages: ${languages.join(", ")}`);
  } else {
    languages = await promptForLanguages();
  }

  const config = {
    repos: [
      {
        repoId,
        rootPath: normalizedRepoPath,
        ignore: ignorePatterns,
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
      enableFileWatching: true,
      maxWatchedFiles: WATCHER_DEFAULT_MAX_WATCHED_FILES,
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

  if (options.dryRun) {
    printDryRunPreview(configPath, config);
    await emitClientConfigBlocks(configPath);
    return;
  }

  const createdPaths: string[] = [];
  const createdDirs: string[] = [];
  const rollback = (): void => {
    for (const path of createdPaths) {
      try {
        if (existsSync(path)) {
          unlinkSync(path);
        }
      } catch {
        // Ignore rollback errors.
      }
    }
    for (const dir of [...createdDirs].reverse()) {
      try {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // Ignore rollback errors.
      }
    }
  };

  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
      createdDirs.push(configDir);
    }
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
      createdDirs.push(dbDir);
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    createdPaths.push(configPath);

    console.log(`Configuration created: ${normalizePath(configPath)}`);
    console.log(`Database path: ${normalizePath(dbPath)}`);
    console.log(`Repository: ${normalizedRepoPath} (id: ${repoId})`);
    console.log(`Languages: ${languages.join(", ")}`);

    if (options.client) {
      if (!VALID_CLIENTS.includes(options.client as ClientType)) {
        console.error(`Invalid client: ${options.client}`);
        console.error(`Valid options: ${VALID_CLIENTS.join(", ")}`);
        rollback();
        process.exit(1);
      }

      const template = await loadClientTemplate(options.client as ClientType);
      const clientConfig = generateClientConfig(template, configPath);
      const clientConfigPath = resolve(`${options.client}-mcp-config.json`);
      writeFileSync(clientConfigPath, clientConfig);
      createdPaths.push(clientConfigPath);
      console.log(`${options.client} config created: ${normalizePath(clientConfigPath)}`);
    }

    await emitClientConfigBlocks(configPath);

    if (autoIndex) {
      const setupStartedAt = Date.now();
      const db = getDb(config.dbPath);
      runMigrations(db);

      if (!getRepo(repoId)) {
        createRepo({
          repo_id: repoId,
          root_path: normalizedRepoPath,
          config_json: JSON.stringify(config.repos[0]),
          created_at: new Date().toISOString(),
        });
      }

      console.log("Running inline index (incremental)...");
      const indexResult = await indexRepo(repoId, "incremental", (progress) => {
        if (progress.stage !== "pass1" && progress.stage !== "pass2") {
          return;
        }
        const fileLabel = progress.currentFile ? ` ${progress.currentFile}` : "";
        console.log(`  ${progress.stage}: ${progress.current}/${progress.total}${fileLabel}`);
      });

      console.log(`Indexed files: ${indexResult.filesProcessed}`);
      console.log(`Indexed symbols: ${indexResult.symbolsIndexed}`);
      console.log(`Created edges: ${indexResult.edgesCreated}`);
      console.log(`Index duration: ${indexResult.durationMs}ms`);
      console.log("Running doctor checks...");
      await doctorCommand({
        ...options,
        config: configPath,
      });

      console.log(`Setup pipeline duration: ${Date.now() - setupStartedAt}ms`);
    } else {
      console.log("");
      console.log("Next steps:");
      console.log("  1. Run: sdl-mcp doctor");
      console.log("  2. Run: sdl-mcp index");
      console.log("  3. Run: sdl-mcp serve");
    }

    logSetupPipelineEvent({
      repoId,
      nonInteractive,
      autoIndex,
      dryRun: false,
      durationMs: Date.now() - startedAt,
      languages,
      configPath: normalizePath(configPath),
    });
  } catch (error) {
    console.error(`Init failed: ${error instanceof Error ? error.message : String(error)}`);
    rollback();
    process.exit(1);
  }
}
