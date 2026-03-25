import {
  chmodSync,
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
import { WATCHER_DEFAULT_MAX_WATCHED_FILES } from "../../config/constants.js";
import {
  DEFAULT_INDEXING_CONCURRENCY,
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
  DEFAULT_MAX_WINDOW_LINES,
  DEFAULT_MAX_WINDOW_TOKENS,
  MAX_FILE_BYTES,
  RUNTIME_DEFAULT_ARTIFACT_TTL_HOURS,
  RUNTIME_DEFAULT_MAX_ARTIFACT_BYTES,
  RUNTIME_DEFAULT_MAX_CONCURRENT_JOBS,
  RUNTIME_DEFAULT_MAX_STDERR_BYTES,
  RUNTIME_DEFAULT_MAX_STDOUT_BYTES,
  RUNTIME_DEFAULT_TIMEOUT_MS,
} from "../../config/constants.js";
import { resolveCliConfigPath } from "../../config/configPath.js";
import { defaultGraphDbPath } from "../../db/graph-db-path.js";
import { resolvePidfilePath } from "../../util/pidfile.js";
import { initGraphDb } from "../../db/initGraphDb.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
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
  "**/target/**",
  "**/vendor/**",
  "**/*.min.js",
  "**/*.min.css",
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

const ENFORCED_ALLOWED_RUNTIMES = [
  "node",
  "typescript",
  "python",
  "ruby",
  "php",
  "shell",
] as const;

const ENFORCED_CODE_MODE_CONFIG = {
  enabled: true,
  exclusive: true,
  maxChainSteps: 20,
  maxChainTokens: 50_000,
  maxChainDurationMs: 60_000,
  ladderValidation: "warn" as const,
  etagCaching: true,
};

const ENFORCED_RUNTIME_CONFIG = {
  enabled: true,
  allowedRuntimes: [...ENFORCED_ALLOWED_RUNTIMES],
  allowedExecutables: [],
  maxDurationMs: RUNTIME_DEFAULT_TIMEOUT_MS,
  maxStdoutBytes: RUNTIME_DEFAULT_MAX_STDOUT_BYTES,
  maxStderrBytes: RUNTIME_DEFAULT_MAX_STDERR_BYTES,
  maxArtifactBytes: RUNTIME_DEFAULT_MAX_ARTIFACT_BYTES,
  artifactTtlHours: RUNTIME_DEFAULT_ARTIFACT_TTL_HOURS,
  maxConcurrentJobs: RUNTIME_DEFAULT_MAX_CONCURRENT_JOBS,
  envAllowlist: [],
  artifactBaseDir: undefined,
};

const SDL_SOURCE_EXTENSIONS_BY_LANGUAGE: Array<{
  language: string;
  extensions: string[];
}> = [
  {
    language: "TypeScript/JavaScript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  { language: "Python", extensions: [".py", ".pyw"] },
  { language: "Go", extensions: [".go"] },
  { language: "Java", extensions: [".java"] },
  { language: "C#", extensions: [".cs"] },
  { language: "C/C++", extensions: [".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx"] },
  { language: "PHP", extensions: [".php", ".phtml"] },
  { language: "Rust", extensions: [".rs"] },
  { language: "Kotlin", extensions: [".kt", ".kts"] },
  { language: "Shell", extensions: [".sh", ".bash", ".zsh"] },
];

const SDL_SOURCE_EXTENSIONS = SDL_SOURCE_EXTENSIONS_BY_LANGUAGE.flatMap(
  ({ extensions }) => extensions,
);

const SDL_RUNTIME_REDIRECT_PREFIXES = [
  "npm test",
  "npm run test",
  "npm run lint",
  "npm run build",
  "pnpm test",
  "pnpm lint",
  "pnpm build",
  "yarn test",
  "yarn lint",
  "yarn build",
  "bun test",
  "bun run test",
  "bun run lint",
  "bun run build",
  "pytest",
  "python -m pytest",
  "python -m unittest",
  "bundle exec rspec",
  "bundle exec rake",
  "rake test",
  "phpunit",
  "vendor/bin/phpunit",
  "composer test",
  "go test",
  "cargo test",
];

type GeneratedAsset = {
  path: string;
  content: string;
  executable?: boolean;
};

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
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith("#") && !line.startsWith("!"),
    );

  const patterns: string[] = [];
  for (const line of lines) {
    const normalized = normalizePath(line)
      .replace(/^\.\//, "")
      .replace(/^\/+/, "");
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

    if (
      normalized.includes("*") ||
      normalized.includes("?") ||
      normalized.includes("[")
    ) {
      patterns.push(
        normalized.startsWith("**/") ? normalized : `**/${normalized}`,
      );
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
  const templatesDir = resolve(__dirname, "../../../templates");
  const templatePath = resolve(templatesDir, `${client}.json`);
  if (!templatePath.startsWith(templatesDir)) {
    throw new Error("Template path traversal detected");
  }
  try {
    const content = readFileSync(templatePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to load client template '${client}' from ${templatePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function loadTextTemplate(templateName: string): string {
  const templatesDir = resolve(__dirname, "../../../templates");
  const templatePath = resolve(templatesDir, templateName);
  if (!templatePath.startsWith(templatesDir)) {
    throw new Error("Template path traversal detected");
  }
  return readFileSync(templatePath, "utf-8");
}

function renderTextTemplate(templateName: string, values: Record<string, string>): string {
  let rendered = loadTextTemplate(templateName);
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}

function formatExtensionArrayLiteral(): string {
  return SDL_SOURCE_EXTENSIONS.map((ext) => `"${ext}"`).join(", ");
}

function ensureDirectory(path: string, createdDirs: string[]): void {
  if (existsSync(path)) {
    return;
  }
  mkdirSync(path, { recursive: true });
  createdDirs.push(path);
}

function writeGeneratedAsset(
  asset: GeneratedAsset,
  createdPaths: string[],
  createdDirs: string[],
  force = false,
): void {
  const targetDir = dirname(asset.path);
  ensureDirectory(targetDir, createdDirs);

  const existed = existsSync(asset.path);
  if (existed && !force) {
    return;
  }

  writeFileSync(
    asset.path,
    asset.content.endsWith("\n") ? asset.content : `${asset.content}\n`,
    "utf-8",
  );
  if (!existed) {
    createdPaths.push(asset.path);
  }
  if (asset.executable) {
    try {
      chmodSync(asset.path, 0o755);
    } catch {
      // Best-effort on platforms that ignore executable bits.
    }
  }
}

function shellEscape(s: string): string {
  return s.replaceAll("'", "'\\''");
}

function buildClaudeReadHook(pidfilePath: string): string {
  const safePath = shellEscape(pidfilePath);
  const blocked = SDL_SOURCE_EXTENSIONS.map((ext) => `'${ext}'`).join(" ");
  return `#!/bin/sh
set -eu

# Only enforce when SDL-MCP server is running (PID file exists)
if [ ! -f '${safePath}' ]; then
  exit 0
fi

payload="$(cat)"
tool_name="$(printf '%s' "$payload" | python -c "import json,sys; data=json.load(sys.stdin); print(data.get('tool_name',''))")"
file_path="$(printf '%s' "$payload" | python -c "import json,sys; data=json.load(sys.stdin); tool_input=data.get('tool_input') or {}; print(tool_input.get('file_path') or tool_input.get('path') or '')")"

if [ "$tool_name" != "Read" ]; then
  exit 0
fi

if [ -z "$file_path" ]; then
  exit 0
fi

ext="$(printf '%s' "$file_path" | tr '[:upper:]' '[:lower:]')"
ext=".\${ext##*.}"

for blocked_ext in ${blocked}; do
  if [ "$ext" = "$blocked_ext" ]; then
    python -c "import json; print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': 'Use SDL-MCP tools instead of native Read for indexed source code. Start with sdl.repo.status, then use sdl.action.search, focused sdl.manual, and sdl.chain. Use symbolRef when the symbol name is known but the ID is not, and follow SDL fallback guidance when present. Read is only allowed for non-indexed file types.'}}))"
    exit 0
  fi
done
`;
}

function buildClaudeRuntimeHook(pidfilePath: string): string {
  const safePath = shellEscape(pidfilePath);
  const prefixes = SDL_RUNTIME_REDIRECT_PREFIXES.map((prefix) => `'${prefix}'`).join(" ");
  return `#!/bin/sh
set -eu

# Only enforce when SDL-MCP server is running (PID file exists)
if [ ! -f '${safePath}' ]; then
  exit 0
fi

payload="$(cat)"
tool_name="$(printf '%s' "$payload" | python -c "import json,sys; data=json.load(sys.stdin); print(data.get('tool_name',''))")"
command="$(printf '%s' "$payload" | python -c "import json,sys; data=json.load(sys.stdin); tool_input=data.get('tool_input') or {}; print(tool_input.get('command') or tool_input.get('cmd') or '')")"

if [ "$tool_name" != "Bash" ]; then
  exit 0
fi

trimmed="$(printf '%s' "$command" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//')"

for prefix in ${prefixes}; do
  case "$trimmed" in
    "$prefix"|"$prefix "*) 
      python -c "import json; print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': 'Run repo-local test/build/lint commands through SDL runtime instead of native Bash. Use sdl.chain with runtimeExecute so command execution stays in SDL-MCP and avoids redundant token spend.'}}))"
      exit 0
      ;;
  esac
done
`;
}

function buildClaudeSettings(): string {
  const settings = {
    permissions: {
      deny: ["Task(Explore)"],
      allow: ["Read(**.md)", "Read(**.json)", "mcp__sdl-mcp__*"],
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "Read",
          hooks: [
            {
              type: "command",
              command: ".claude/hooks/force-sdl-mcp.sh",
            },
          ],
        },
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: ".claude/hooks/force-sdl-runtime.sh",
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(settings, null, 2);
}

function buildClaudeExploreAgent(repoId: string): string {
  return `---
name: explore-sdl
description: Explore indexed source code in ${repoId} with SDL-MCP instead of native Read.
tools: Grep, Glob, mcp__sdl-mcp__*
disallowedTools: Read
model: inherit
---

Use SDL-MCP for source code understanding in this repository.

- Start with \`mcp__sdl-mcp__sdl.repo.status\`.
- Use \`mcp__sdl-mcp__sdl.action.search\` when the right action is unclear.
- Use \`mcp__sdl-mcp__sdl.manual\` with focused \`query\` or \`actions\`.
- Prefer \`mcp__sdl-mcp__sdl.chain\` for multi-step workflows.
- Use \`mcp__sdl-mcp__sdl.symbol.getCard\` or \`mcp__sdl-mcp__sdl.symbol.getCards\` with \`symbolRef\` / \`symbolRefs\` when the exact \`symbolId\` is unknown.
- Use SDL runtime via \`runtimeExecute\` in \`sdl.chain\` for repo-local commands.
- Follow \`nextBestAction\`, \`fallbackTools\`, \`fallbackRationale\`, and candidate guidance from SDL responses instead of retrying native tools.
- Do not use native \`Read\` for indexed source files.
- If you need a non-code file, ask the parent session to read it directly.
`;
}

function buildClaudePrompt(repoId: string): string {
  return `Use SDL-MCP as the default path for repository ${repoId}.

- Never use native Read for indexed source-code extensions: ${SDL_SOURCE_EXTENSIONS.join(", ")}.
- Start with sdl.repo.status, then use sdl.action.search, focused sdl.manual, and sdl.chain.
- Use symbolRef / symbolRefs when you know a symbol name but not the canonical symbolId.
- Use runtimeExecute inside sdl.chain for repo-local test, build, lint, and diagnostic commands.
- Follow nextBestAction, fallbackTools, fallbackRationale, and candidate guidance from SDL responses instead of retrying blocked native tools.
- If native Read or Bash is denied by a hook, switch to SDL-MCP immediately and do not retry the denied tool.
`;
}

function buildOpenCodeProjectConfig(configPath: string): string {
  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      "sdl-mcp": {
        type: "local",
        enabled: true,
        command: ["npx", "--yes", "sdl-mcp@latest", "serve", "--stdio"],
        env: {
          SDL_CONFIG: normalizePath(configPath),
        },
      },
    },
    permission: {
      read: Object.fromEntries([
        ["*", "allow"],
        ...SDL_SOURCE_EXTENSIONS.map((ext) => [`*${ext}`, "deny"]),
      ]),
      bash: Object.fromEntries([
        ["*", "ask"],
        ...SDL_RUNTIME_REDIRECT_PREFIXES.map((prefix) => [`${prefix}*`, "deny"]),
      ]),
    },
  };
  return JSON.stringify(config, null, 2);
}

function buildOpenCodePlugin(): string {
  return `import type { Plugin } from "@opencode-ai/plugin";

const BLOCKED_EXTENSIONS = [${formatExtensionArrayLiteral()}];
const REDIRECT_PREFIXES = ${JSON.stringify(SDL_RUNTIME_REDIRECT_PREFIXES, null, 2)};

export const EnforceSDL: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "read") {
        const rawPath =
          (output.args.filePath as string | undefined) ??
          (output.args.path as string | undefined) ??
          "";
        const loweredPath = rawPath.toLowerCase();
        if (BLOCKED_EXTENSIONS.some((ext) => loweredPath.endsWith(ext))) {
          throw new Error(
            "Use SDL-MCP tools for indexed source code. Start with sdl.repo.status, then use sdl.action.search, focused sdl.manual, and sdl.chain. Use symbolRef when the symbol name is known but the ID is not."
          );
        }
      }

      if (input.tool === "bash") {
        const command = String(output.args.command ?? "").trim().toLowerCase();
        if (REDIRECT_PREFIXES.some((prefix) => command === prefix || command.startsWith(\`\${prefix} \`))) {
          throw new Error(
            "Run repo-local build, test, lint, and diagnostic commands through SDL runtime using sdl.chain + runtimeExecute instead of native bash."
          );
        }
      }
    },
  };
};
`;
}

function buildEnforcementAssets(
  repoRoot: string,
  repoId: string,
  configPath: string,
  client?: ClientType,
): GeneratedAsset[] {
  const assets: GeneratedAsset[] = [
    {
      path: join(repoRoot, "AGENTS.md"),
      content: renderTextTemplate("AGENTS.md.template", { REPO_ID: repoId }),
    },
  ];

  if (!client) {
    return assets;
  }

  const markdownTemplateByClient: Record<ClientType, string> = {
    "claude-code": "CLAUDE.md.template",
    codex: "CODEX.md.template",
    gemini: "GEMINI.md.template",
    opencode: "OPENCODE.md.template",
  };

  const markdownNameByClient: Record<ClientType, string> = {
    "claude-code": "CLAUDE.md",
    codex: "CODEX.md",
    gemini: "GEMINI.md",
    opencode: "OPENCODE.md",
  };

  assets.push({
    path: join(repoRoot, markdownNameByClient[client]),
    content: renderTextTemplate(markdownTemplateByClient[client], {
      REPO_ID: repoId,
    }),
  });

  if (client === "claude-code") {
    const graphDbPath = defaultGraphDbPath(configPath);
    const pidfilePath = resolvePidfilePath(graphDbPath).replace(/\\/g, "/").replace(/'/g, "'\\''");
    assets.push(
      {
        path: join(repoRoot, ".claude", "settings.json"),
        content: buildClaudeSettings(),
      },
      {
        path: join(repoRoot, ".claude", "hooks", "force-sdl-mcp.sh"),
        content: buildClaudeReadHook(pidfilePath),
        executable: true,
      },
      {
        path: join(repoRoot, ".claude", "hooks", "force-sdl-runtime.sh"),
        content: buildClaudeRuntimeHook(pidfilePath),
        executable: true,
      },
      {
        path: join(repoRoot, ".claude", "agents", "explore-sdl.md"),
        content: buildClaudeExploreAgent(repoId),
      },
      {
        path: join(repoRoot, ".claude", "sdl-prompt.md"),
        content: buildClaudePrompt(repoId),
      },
    );
  }

  if (client === "opencode") {
    assets.push(
      {
        path: join(repoRoot, "opencode.json"),
        content: buildOpenCodeProjectConfig(configPath),
      },
      {
        path: join(repoRoot, ".opencode", "plugins", "enforce-sdl.ts"),
        content: buildOpenCodePlugin(),
      },
    );
  }

  return assets;
}

function generateClientConfig(template: unknown, configPath: string): string {
  // Template is JSON-parsed client config with mcpServers shape
  const tpl = template as {
    mcpServers: Record<string, { env?: Record<string, string>; [k: string]: unknown }>;
  };
  const mcpServers = tpl.mcpServers;
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

function printDryRunPreview(
  configPath: string,
  config: unknown,
  generatedAssets: GeneratedAsset[],
): void {
  console.log("Dry run: no files written.");
  console.log(`Target config path: ${normalizePath(configPath)}`);
  console.log("");
  console.log(JSON.stringify(config, null, 2));
  if (generatedAssets.length > 0) {
    console.log("");
    console.log("Generated repo-local assets:");
    for (const asset of generatedAssets) {
      console.log(`- ${normalizePath(asset.path)}`);
    }
  }
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
    console.error(
      "To reinitialize, remove the existing file first or use --force.",
    );
    process.exit(1);
  }

  const dbPath = resolve(dirname(configPath), "sdlmcp.sqlite");
  const ladybugDbPath = defaultGraphDbPath(configPath);
  const configDir = dirname(configPath);
  const dbDir = dirname(dbPath);
  const ladybugDbDir = dirname(ladybugDbPath);

  if (options.client && !VALID_CLIENTS.includes(options.client as ClientType)) {
    console.error(`Invalid client: ${options.client}`);
    console.error(`Valid options: ${VALID_CLIENTS.join(", ")}`);
    process.exit(1);
  }

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
        includeNodeModulesTypes: true,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      },
    ],
    dbPath,
    graphDatabase: {
      path: ladybugDbPath,
    },
    policy: {
      maxWindowLines: DEFAULT_MAX_WINDOW_LINES,
      maxWindowTokens: DEFAULT_MAX_WINDOW_TOKENS,
      requireIdentifiers: true,
      allowBreakGlass: true,
      defaultDenyRaw: true,
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
      engine: "rust" as const,
      watchDebounceMs: 300,
    },
    liveIndex: {
      enabled: true,
      debounceMs: 75,
      idleCheckpointMs: 15_000,
      maxDraftFiles: 200,
      reconcileConcurrency: 1,
      clusterRefreshThreshold: 25,
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
    ...(options.enforceAgentTools
      ? {
          runtime: ENFORCED_RUNTIME_CONFIG,
          codeMode: ENFORCED_CODE_MODE_CONFIG,
        }
      : {}),
  };

  const generatedAssets = options.enforceAgentTools
    ? buildEnforcementAssets(
        repoRoot,
        repoId,
        configPath,
        options.client as ClientType | undefined,
      )
    : [];

  if (options.dryRun) {
    printDryRunPreview(configPath, config, generatedAssets);
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
    if (!existsSync(ladybugDbDir)) {
      mkdirSync(ladybugDbDir, { recursive: true });
      createdDirs.push(ladybugDbDir);
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    createdPaths.push(configPath);

    for (const asset of generatedAssets) {
      writeGeneratedAsset(asset, createdPaths, createdDirs, false);
    }

    console.log(`Configuration created: ${normalizePath(configPath)}`);
    console.log(`Database path: ${normalizePath(dbPath)}`);
    console.log(`Graph database path: ${normalizePath(ladybugDbPath)}`);
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
      console.log(
        `${options.client} config created: ${normalizePath(clientConfigPath)}`,
      );
    }

    if (generatedAssets.length > 0) {
      console.log("Generated agent enforcement assets:");
      for (const asset of generatedAssets) {
        console.log(`  - ${normalizePath(asset.path)}`);
      }
    }

    await emitClientConfigBlocks(configPath);

    if (autoIndex) {
      const setupStartedAt = Date.now();
      await initGraphDb(config, configPath);
      const conn = await getLadybugConn();

      const existingRepo = await ladybugDb.getRepo(conn, repoId);
      if (!existingRepo) {
        await withWriteConn(async (wConn) => {
          await ladybugDb.upsertRepo(wConn, {
            repoId,
            rootPath: normalizedRepoPath,
            configJson: JSON.stringify(config.repos[0]),
            createdAt: new Date().toISOString(),
          });
        });
      }

      console.log("Running inline index (incremental)...");
      const indexResult = await indexRepo(repoId, "incremental", (progress) => {
        if (progress.stage !== "pass1" && progress.stage !== "pass2") {
          return;
        }
        const fileLabel = progress.currentFile
          ? ` ${progress.currentFile}`
          : "";
        console.log(
          `  ${progress.stage}: ${progress.current}/${progress.total}${fileLabel}`,
        );
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
    console.error(
      `Init failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    rollback();
    process.exit(1);
  }
}
