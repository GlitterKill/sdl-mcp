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
import { homedir } from "node:os";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import {
  WATCHER_DEFAULT_MAX_WATCHED_FILES,
  DEFAULT_PASS2_CONCURRENCY,
} from "../../config/constants.js";
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
  RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACTS_PER_REPO,
  RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACT_BYTES_PER_REPO,
  RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACT_BYTES_TOTAL,
  RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACTS_TOTAL,
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
  // Version control
  "**/.git/**",

  // Build output (universal)
  "**/dist/**",
  "**/dist-*/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.min.css",

  // Package managers / dependencies
  "**/node_modules/**",
  "**/vendor/**",
  "**/.pnp.*",
  "**/.yarn/**",

  // Framework-specific output
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/.output/**",

  // Language-specific intermediates
  "**/__pycache__/**",
  "**/.pytest_cache/**",
  "**/*.pyc",
  "**/.venv/**",
  "**/venv/**",
  "**/.tox/**",
  "**/.mypy_cache/**",

  // Temp / scratch
  "**/.tmp/**",
  "**/tmp/**",

  // AI agent folders
  "**/.claude/**",
  "**/.codex/**",
  "**/.cursor/**",
  "**/.aider*/**",
  "**/.windsurf/**",
  "**/.continue/**",

  // SDL-MCP internal
  "**/.sdl-memory/**",
  "**/.sisyphus/**",
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

const ENFORCED_RUNTIME_CONFIG = {
  enabled: true,
  allowedRuntimes: [...ENFORCED_ALLOWED_RUNTIMES],
  allowedExecutables: [],
  maxDurationMs: RUNTIME_DEFAULT_TIMEOUT_MS,
  maxStdoutBytes: RUNTIME_DEFAULT_MAX_STDOUT_BYTES,
  maxStderrBytes: RUNTIME_DEFAULT_MAX_STDERR_BYTES,
  maxArtifactBytes: RUNTIME_DEFAULT_MAX_ARTIFACT_BYTES,
  maxResponseArtifactsPerRepo: RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACTS_PER_REPO,
  maxResponseArtifactBytesPerRepo:
    RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACT_BYTES_PER_REPO,
  maxResponseArtifactBytesTotal:
    RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACT_BYTES_TOTAL,
  maxResponseArtifactsTotal: RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACTS_TOTAL,
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
  {
    language: "C/C++",
    extensions: [".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx"],
  },
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
      .filter((n) => !Number.isNaN(n) && n > 0 && n <= VALID_LANGUAGES.length);

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
      `Failed to load client template '${client}' from ${templatePath}: ${error instanceof Error ? error.message : String(error)}`,
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

function renderTextTemplate(
  templateName: string,
  values: Record<string, string>,
): string {
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
  const indexedExtensions = shellEscape(JSON.stringify(SDL_SOURCE_EXTENSIONS));
  return `#!/bin/sh
set -eu

# Only enforce when SDL-MCP server is running (PID file exists)
if [ ! -f '${safePath}' ]; then
  exit 0
fi

payload="$(cat)"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
repo_root="$(CDPATH= cd -- "$script_dir/../.." && pwd -P)"

PAYLOAD="$payload" REPO_ROOT="$repo_root" INDEXED_EXTENSIONS='${indexedExtensions}' python - <<'PY'
import json
import os
import re
import sys

INDEXED_READ_REASON = "Use the SDL-MCP Iris retrieval ladder for indexed source reads. Start with sdl.context, then batch follow-ups through sdl.workflow using symbolSearch, symbolGetCard, codeSkeleton, codeHotPath, and codeNeedWindow only as a last resort with identifiersToFind and expectedLines."
INDEXED_WRITE_REASON = "Use SDL-MCP indexed-source edit tools instead of native writes. Prefer symbol.edit for one-symbol edits; use searchEditPreview with targeting:\\"identifier\\" for exact AST identifier replacements in supported structural languages, targeting:\\"structural\\" for tree-sitter capture edits, or operations[] for heterogeneous batches. Review astMatches/snippets, then apply the plan handle. If SDL edit tools cannot express the change, run a targeted script through sdl.workflow runtimeExecute with stdin."
NON_INDEXED_READ_REASON = "Use SDL-MCP file.read for non-indexed repository reads. Prefer sdl.file { op: \\"read\\" } or file.read with search, jsonPath, or bounded offset/limit instead of native file reads."
NON_INDEXED_WRITE_REASON = "Use SDL-MCP file.write for non-indexed repository writes. Prefer sdl.file { op: \\"write\\" } or file.write with one targeted write mode instead of native Write/Edit/apply_patch."

def norm(value):
    return str(value or "").replace("\\\\", "/").lower()

def resolve_path(path):
    raw = str(path or "").strip()
    if not raw:
        return ""
    if re.match(r"^[A-Za-z]:[\\\\/]", raw) or raw.startswith("/") or raw.startswith("\\\\"):
        return norm(os.path.abspath(raw))
    return norm(os.path.abspath(os.path.join(repo_root, raw)))

def within(path, root):
    p = resolve_path(path)
    r = resolve_path(root)
    return p == r or p.startswith(r + "/")

def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}))

def collect_paths(value):
    paths = []
    if isinstance(value, dict):
        for key, entry in value.items():
            if re.match(r"^(file_path|filePath|path|filename|target_file|targetFile|old_path|oldPath|new_path|newPath)$", key) and isinstance(entry, str):
                paths.append(entry)
            else:
                paths.extend(collect_paths(entry))
    elif isinstance(value, list):
        for entry in value:
            paths.extend(collect_paths(entry))
    return paths

def collect_patch_paths(tool_input):
    patch = str(tool_input.get("patch") or tool_input.get("diff") or "")
    return [m.group(1).strip() for m in re.finditer(r"^\\*\\*\\* (?:Add|Update|Delete) File: (.+)$", patch, re.M | re.I)]

def is_repo_path(path):
    return within(path, repo_root)

def is_repo_internal_path(path):
    return within(path, os.path.join(repo_root, ".codex")) or within(path, os.path.join(repo_root, ".claude"))

def is_indexed(value):
    text = norm(value)
    return "/src/" in text or "src/" in text or any(ext in text for ext in indexed_extensions)

try:
    data = json.loads(os.environ.get("PAYLOAD", "") or "{}")
except Exception:
    sys.exit(0)

repo_root = os.environ.get("REPO_ROOT", "")
indexed_extensions = set(json.loads(os.environ.get("INDEXED_EXTENSIONS", "[]")))
tool_name = str(data.get("tool_name") or "")
tool_input = data.get("tool_input") or {}
if tool_name not in {"Read", "Write", "Edit", "MultiEdit", "NotebookEdit"}:
    sys.exit(0)

paths = collect_paths(tool_input) + collect_patch_paths(tool_input)
if paths and all(is_repo_internal_path(path) for path in paths):
    sys.exit(0)

cwd = data.get("cwd") or tool_input.get("cwd") or tool_input.get("workdir") or tool_input.get("working_directory") or ""
serialized = json.dumps(tool_input)
targets_repo = within(cwd, repo_root) or norm(repo_root) in norm(serialized) or any(is_repo_path(path) for path in paths)
if not targets_repo:
    sys.exit(0)

indexed = any(is_indexed(path) for path in paths) or is_indexed(serialized)
if tool_name == "Read":
    deny(INDEXED_READ_REASON if indexed else NON_INDEXED_READ_REASON)
else:
    deny(INDEXED_WRITE_REASON if indexed else NON_INDEXED_WRITE_REASON)
PY
`;
}

function buildClaudeRuntimeHook(pidfilePath: string): string {
  const safePath = shellEscape(pidfilePath);
  return `#!/bin/sh
set -eu

# Only enforce when SDL-MCP server is running (PID file exists)
if [ ! -f '${safePath}' ]; then
  exit 0
fi

payload="$(cat)"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
repo_root="$(CDPATH= cd -- "$script_dir/../.." && pwd -P)"

PAYLOAD="$payload" REPO_ROOT="$repo_root" python - <<'PY'
import json
import os
import re
import sys

RUNTIME_REASON = "Run repo-local shell actions through SDL-MCP instead of native Bash. Use sdl.workflow with runtimeExecute, default outputMode: \\"minimal\\", persistOutput: true, an explicit timeoutMs, stdin for multiline input, and runtimeQueryOutput only for focused follow-up output."

def norm(value):
    return str(value or "").replace("\\\\", "/").lower()

def resolve_path(path):
    raw = str(path or "").strip()
    if not raw:
        return ""
    if re.match(r"^[A-Za-z]:[\\\\/]", raw) or raw.startswith("/") or raw.startswith("\\\\"):
        return norm(os.path.abspath(raw))
    return norm(os.path.abspath(os.path.join(repo_root, raw)))

def within(path, root):
    p = resolve_path(path)
    r = resolve_path(root)
    return p == r or p.startswith(r + "/")

def internal_command_allowed(command):
    normalized = norm(command)
    mentions_internal = (
        re.search(r"(?:^|[\\s\\\"'\\x60])\\.(?:codex|claude)(?:[\\\\/\\\"'\\x60\\s]|$)", command) is not None
        or "/.codex/" in normalized
        or "/.claude/" in normalized
        or "/.agents/skills/" in normalized
    )
    if not mentions_internal:
        return False
    blocked = r"(?:^|[\\s\\\"'\\x60])(?:src|tests|docs|templates|native|scripts|config|packages|grammar-wrappers|README\\.md|SDL\\.md|AGENTS\\.md|CODEX\\.md|CLAUDE\\.md|package(?:-lock)?\\.json|tsconfig\\.json|eslint\\.config\\.mjs)(?:[\\\\/\\\"'\\x60\\s]|$)"
    return re.search(blocked, command, re.I) is None

def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}))

try:
    data = json.loads(os.environ.get("PAYLOAD", "") or "{}")
except Exception:
    sys.exit(0)

repo_root = os.environ.get("REPO_ROOT", "")
tool_name = str(data.get("tool_name") or "")
tool_input = data.get("tool_input") or {}
if tool_name != "Bash":
    sys.exit(0)

command = str(tool_input.get("command") or tool_input.get("cmd") or "")
if internal_command_allowed(command):
    sys.exit(0)

cwd = data.get("cwd") or tool_input.get("cwd") or tool_input.get("workdir") or tool_input.get("working_directory") or ""
serialized = json.dumps(tool_input)
if within(cwd, repo_root) or norm(repo_root) in norm(serialized):
    deny(RUNTIME_REASON)
PY
`;
}

function buildClaudeExploreHook(pidfilePath: string): string {
  const safePath = shellEscape(pidfilePath);
  return `#!/bin/sh
set -eu

# Only enforce when SDL-MCP server is running (PID file exists)
if [ ! -f '${safePath}' ]; then
  exit 0
fi

payload="$(cat)"
tool_name="$(printf '%s' "$payload" | python -c "import json,sys; data=json.load(sys.stdin); print(data.get('tool_name',''))")"

if [ "$tool_name" != "Task" ]; then
  exit 0
fi

task_type="$(printf '%s' "$payload" | python -c "import json,sys; data=json.load(sys.stdin); tool_input=data.get('tool_input') or {}; print(tool_input.get('subagent_type') or tool_input.get('description') or '')")"

case "$task_type" in
  *[Ee]xplore*)
    python -c "import json; print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': 'Use the explore-sdl subagent instead of the built-in Explore agent when SDL-MCP is active. The explore-sdl agent uses SDL-MCP tools for efficient source code understanding.'}}))"
    exit 0
    ;;
esac
`;
}

function buildClaudeSettings(): string {
  // Permissions are broad — hooks handle conditional enforcement when SDL-MCP is active.
  // When SDL-MCP is not running (no PID file), all native tools work normally.
  const settings = {
    permissions: {
      allow: [
        "Read",
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "Bash",
        "Task",
        "mcp__sdl-mcp__*",
      ],
    },
    hooks: {
      PreToolUse: [
        ...["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].map(
          (matcher) => ({
            matcher,
            hooks: [
              {
                type: "command",
                command: ".claude/hooks/force-sdl-mcp.sh",
              },
            ],
          }),
        ),
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: ".claude/hooks/force-sdl-runtime.sh",
            },
          ],
        },
        {
          matcher: "Task",
          hooks: [
            {
              type: "command",
              command: ".claude/hooks/force-sdl-explore.sh",
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(settings, null, 2);
}

function buildClaudeExploreAgent(_repoId: string): string {
  const exts = SDL_SOURCE_EXTENSIONS.map((e) => `\`${e}\``).join(", ");
  return `---
name: explore-sdl
description: Codebase exploration agent that follows the SDL-MCP Agent Workflow skill: use SDL-MCP tools for repository context, indexed source understanding, runtime execution, and token-efficient exploration instead of native source reads. Use this instead of the built-in Explore agent.
tools:
  - Grep
  - Glob
  - Bash
  - mcp__sdl-mcp__*
disallowedTools:
  - Read
model: inherit
---

# Explore SDL — Codebase Exploration via SDL-MCP

You are a codebase exploration agent. Your job is to answer questions about the codebase using SDL-MCP tools for repository context, indexed source understanding, runtime execution, and token-efficient exploration.

Follow the same workflow as the SDL-MCP Agent Workflow skill when that skill is available. These instructions inline the critical rules so exploration remains SDL-first even when a client cannot load that skill directly.

## Rules

1. **NEVER use the native \`Read\` tool for source code files.** Source code extensions include: ${exts}.

2. **Start with \`sdl.repo.status\`** to understand the repository state.

3. **Use \`sdl.action.search\`** when you are not sure which SDL action to use for a task.

4. **Use \`sdl.manual\`** with \`query\` or \`actions\` to load a focused reference for specific tools.

5. **Start real context gathering with \`sdl.context\`**:
   - \`contextMode: "precise"\` — targeted symbol/file lookups.
   - \`contextMode: "broad"\` — exploratory codebase understanding.
   - Provide \`focusSymbols\` and/or \`focusPaths\` to scope the retrieval.
   - Set \`responseMode: "auto"\` for potentially large responses and use \`response.get\` only for needed excerpts.
   - Always set a tight budget (\`maxTokens\`; use slice tools, not \`sdl.context\`, when card-count budgets are required).

6. **Use \`sdl.workflow\`** for multi-step follow-ups, runtime execution, data transforms, and batch operations. Start retrieval with \`sdl.context\`; use workflow for batched escalation or procedural work.

7. **Use \`symbolRef\` or \`symbolRefs\`** when you know a symbol name but not the canonical \`symbolId\`. SDL-MCP will resolve the best match.

8. **Follow the Context Ladder** — escalate only when needed:
   - \`sdl.symbol.search\` — Find symbols by name/pattern. Add \`semantic: true\` for conceptual queries.
   - \`sdl.symbol.getCard\` — Get symbol metadata, signature, dependencies.
   - \`sdl.slice.build\` — Get related symbols for a task. Use \`taskText\` for auto-discovery.
   - \`sdl.code.getSkeleton\` — See control flow structure (signatures + elided bodies).
   - \`sdl.code.getHotPath\` — Find specific identifiers in code.
   - \`sdl.code.needWindow\` — Full code (last resort, requires justification and \`identifiersToFind\`).

9. **Use SDL runtime for repo-local commands** via \`runtimeExecute\` in \`sdl.workflow\`:
    - Default to \`outputMode: "minimal"\`, \`persistOutput: true\`, and an explicit \`timeoutMs\`.
    - Use \`stdin\` for multiline scripts/input instead of PowerShell here-strings, quote-heavy \`node -e\`, or base64 decode/eval workarounds.
    - If output details are needed, call \`runtimeQueryOutput\` with the \`artifactHandle\` and targeted \`queryTerms\`.
   - Use \`outputMode: "intent"\` when the command is already tied to known terms such as \`FAIL\`, \`Error\`, or a test name.
   - Always set \`timeoutMs\` to prevent hangs.
   - Never use runtime execution to print indexed source.

10. **Follow SDL fallback guidance** — when a request is denied or ambiguous, use the \`nextBestAction\`, \`fallbackTools\`, \`fallbackRationale\`, and ranked candidates from the response instead of retrying native tools.

11. **Use native tools only as fallback or for non-repository internal data.** Avoid native \`Grep\`/\`Glob\` for repo-local source discovery when SDL-MCP can answer with \`sdl.context\`, \`symbolSearch\`, \`file.read\`, or \`sdl.action.search\`.

12. **For non-code files** (\`.md\`, \`.json\`, \`.yaml\`, \`.toml\`, \`.xml\`, \`.sql\`, \`.css\`, \`.html\`, \`.txt\`, config files, lock files), use \`file.read\` inside \`sdl.workflow\`. Prefer targeted modes over full reads:
   - **Line range**: \`{ "fn": "file.read", "args": { "filePath": "docs/guide.md", "offset": 10, "limit": 20 } }\`
   - **Search**: \`{ "fn": "file.read", "args": { "filePath": "docs/guide.md", "search": "authentication", "searchContext": 3 } }\`
   - **JSON path**: \`{ "fn": "file.read", "args": { "filePath": "package.json", "jsonPath": "dependencies" } }\`

13. **Do not refresh the index by habit.** Run \`index.refresh\` only when \`repo.status\` shows stale or missing indexed state and current code is required. Prefer incremental refresh; if it runs asynchronously, poll \`repo.status\` and wait for completion before continuing graph-backed exploration.

14. **Use SDL memory only when enabled.** If \`repo.status\`, config, or tool discovery does not show \`memory.enabled: true\`, do not repeatedly call memory tools. When enabled, use \`memory.query\` for task-text lookup and \`memory.surface\` after relevant symbol IDs are known.

15. **Finish with usage stats when SDL-MCP was used.** Call \`usageStats\` with \`scope: "session"\` and \`persist: true\`; report token savings in the final exploration answer.

## Workflow

1. Use \`sdl.repo.status\` to check repo state and health
2. Use \`sdl.context\` with the appropriate \`contextMode\` for the exploration question
3. Use \`sdl.action.search\` or focused \`sdl.manual\` if the next SDL tool is unclear
4. Use \`sdl.workflow\` to batch \`symbolSearch\`, \`symbolGetCard\`, \`codeSkeleton\`, and \`codeHotPath\` when context needs follow-up
5. Use \`codeNeedWindow\` only as a last resort with clear justification
6. Use \`fileRead\` for non-indexed files with \`search\`, \`jsonPath\`, or bounded ranges
7. Use \`runtimeExecute\` plus \`runtimeQueryOutput\` for repo-local commands and targeted output retrieval
8. Use \`symbol.edit\` for one-symbol edits, \`searchEditPreview\` with \`targeting:"identifier"\`, \`targeting:"structural"\`, or \`operations[]\` for safer cross-file edits, and Node scripts only as a last resort
9. Use \`usageStats\` before the final answer and report token savings
`;
}

function buildClaudePrompt(repoId: string): string {
  return `Use SDL-MCP as the default path for repository ${repoId}.

## SDL-MCP Skill Bootstrap

At the start of every new session in this repository, load and follow the \`sdl-mcp-agent-workflow\` skill before repository exploration, command execution, or edits. If the client cannot load skills, use SDL.md and this prompt as the fallback workflow.

## Required Workflow

1. Start with sdl.repo.status.
2. Use sdl.action.search when the correct SDL action is unclear.
3. Use sdl.manual(query|actions|format) for focused reference instead of loading the full manual.
4. Use sdl.context for context retrieval (contextMode: "precise" for targeted lookups, "broad" for exploration).
5. Use sdl.workflow for multi-step follow-ups, runtime execution, data transforms, and batch operations. Start retrieval with sdl.context; use workflow for batched escalation or procedural work.
6. Use symbolRef / symbolRefs when you know a symbol name but not the canonical symbolId.
7. Follow nextBestAction, fallbackTools, fallbackRationale, and candidate guidance from SDL responses instead of retrying blocked native tools.

## Native Tool Restrictions

- Never use native repo-local Read, Write, Edit, patch, or Bash while the SDL-MCP PID file is present.
- Use the Iris ladder for indexed source reads: sdl.context, then symbolSearch, symbolGetCard, codeSkeleton, codeHotPath, and codeNeedWindow only as a last resort.
- Use symbol.edit for one-symbol indexed writes and searchEditPreview with targeting:"identifier", targeting:"structural", or operations[] for cross-file indexed edits. Use targeted scripts through sdl.workflow runtimeExecute with stdin only when SDL edit tools cannot express the change.
- Use file.read / file.write for non-indexed repository files.
- Use runtimeExecute inside sdl.workflow for repo-local shell actions; pass multiline scripts/input through stdin.
- If a native file or Bash call is denied by a hook, switch to SDL-MCP immediately and do not retry the denied tool.
- Use the explore-sdl subagent for codebase exploration instead of the built-in Explore agent.
- Native access remains allowed for .codex/**, .claude/**, and non-repo agent skills, memories, and session internals.

## Conditional Enforcement

All SDL-MCP enforcement is conditional on the server being active (PID file exists). When SDL-MCP is not running, all native tools work normally with no restrictions.

## Context Retrieval

Start understanding tasks with sdl.context, then use sdl.workflow for batched follow-up steps when cards, skeletons, hot paths, or bounded windows are needed:
- contextMode: "precise" — targeted symbol/file lookups
- contextMode: "broad" — exploratory codebase understanding
Provide focusSymbols and/or focusPaths to scope the retrieval. Always set a budget (maxTokens, maxActions).

## Runtime Execution

- Use runtimeExecute inside sdl.workflow with outputMode: "minimal" (default) for ~50-token responses.
- Parameters: use args (string array), code (inline string), and stdin for multiline input. command is an executable alias; executable wins if both are present.
- Use runtimeQueryOutput with artifactHandle and queryTerms to retrieve output details after minimal-mode execution.
- Set timeoutMs on all runtime executions to prevent hangs.

## Non-Indexed File Access

- Use file.read inside sdl.workflow for reading non-indexed files with targeted modes (search, jsonPath, offset/limit).
- Use file.write or sdl.file op:"write" for non-indexed writes with one targeted mode.
- Prefer search or jsonPath over full reads.
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
        ...SDL_RUNTIME_REDIRECT_PREFIXES.map((prefix) => [
          `${prefix}*`,
          "deny",
        ]),
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
            "Use SDL-MCP tools for indexed source code. Start with sdl.repo.status, then use sdl.context for context retrieval, or sdl.action.search to find the right tool. Use symbolRef when the symbol name is known but the ID is not."
          );
        }
      }

      if (input.tool === "bash") {
        const command = String(output.args.command ?? "").trim().toLowerCase();
        if (REDIRECT_PREFIXES.some((prefix) => command === prefix || command.startsWith(\`\${prefix} \`))) {
          throw new Error(
            "Run repo-local build, test, lint, and diagnostic commands through SDL runtime. Use runtimeExecute inside sdl.workflow with outputMode: 'minimal' and stdin for multiline input instead of native bash."
          );
        }
      }
    },
  };
};
`;
}

function buildCodexProjectConfig(): string {
  return `[features]
codex_hooks = true
`;
}

function buildCodexHooksJson(repoRoot: string): string {
  const sessionHookPath = normalizePath(
    join(repoRoot, ".codex", "hooks", "load-sdl-skill.mjs"),
  );
  const hookPath = normalizePath(
    join(repoRoot, ".codex", "hooks", "force-sdl-mcp.mjs"),
  );
  const config = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `node "${sessionHookPath.replace(/"/g, '\\"')}"`,
              timeout: 5,
              statusMessage: "Loading SDL-MCP workflow skill",
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: ".*",
          hooks: [
            {
              type: "command",
              command: `node "${hookPath.replace(/"/g, '\\"')}"`,
              timeout: 10,
              statusMessage: "Checking SDL-MCP tool policy",
            },
          ],
        },
      ],
    },
  };

  return `${JSON.stringify(config, null, 2)}\n`;
}

function buildCodexSessionStartHook(): string {
  return `#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function userHome() {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function candidateSkillPaths() {
  const home = userHome();
  return [
    process.env.SDL_MCP_AGENT_WORKFLOW_SKILL_PATH,
    join(repoRoot, ".codex", "skills", "sdl-mcp-agent-workflow", "SKILL.md"),
    home ? join(home, ".codex", "skills", "sdl-mcp-agent-workflow", "SKILL.md") : undefined,
  ].filter(Boolean);
}

function loadSkill() {
  for (const candidate of candidateSkillPaths()) {
    if (existsSync(candidate)) {
      return {
        path: candidate,
        body: readFileSync(candidate, "utf8").trim(),
      };
    }
  }
  return null;
}

function fallbackSkillBody() {
  return [
    "# SDL-MCP Agent Workflow",
    "",
    "Load and follow the \`sdl-mcp-agent-workflow\` skill when available. Fallback rules:",
    "1. Start every repository task with \`repo.status\`, then \`sdl.context\`.",
    "2. Use \`contextMode: \\"precise\\"\` for named symbols, exact paths, narrow bugs, focused reviews, and implementation follow-up.",
    "3. Use \`contextMode: \\"broad\\"\` for subsystem mapping, behavior tracing, unfamiliar code, or broad investigations.",
    "4. Batch follow-up retrieval through \`sdl.workflow\`: \`symbolSearch\`, \`symbolGetCard\`, \`codeSkeleton\`, \`codeHotPath\`, then \`codeNeedWindow\` as a last resort.",
    "5. Use \`symbol.edit\` for one-symbol indexed edits; use \`searchEditPreview\` with \`targeting:\\"identifier\\"\`, \`targeting:\\"structural\\"\`, or \`operations[]\` for safer cross-file edits.",
    "6. Use \`runtimeExecute\` with \`stdin\` for repo-local commands and multiline scripts/input; for indexed-source edits, use runtime only when SDL edit tools cannot express the change.",
    "7. Use memory tools only when \`memory.enabled: true\`; avoid habitual \`index.refresh\`.",
    "8. Finish with \`usageStats\` and report token savings.",
  ].join("\\n");
}

const input = readHookInput();
if (input.hook_event_name && input.hook_event_name !== "SessionStart") {
  process.exit(0);
}

const skill = loadSkill();
const sourceLine = skill
  ? \`Skill source: \${skill.path}\`
  : "Skill source: fallback summary; install the user-global sdl-mcp-agent-workflow skill for the full version.";
const body = skill?.body ?? fallbackSkillBody();

process.stdout.write(JSON.stringify({
  systemMessage: [
    "SDL-MCP Agent Workflow skill auto-loaded for this session.",
    sourceLine,
    "",
    body,
    "",
    "For detailed recipes, load references/tool-recipes.md from the same skill directory when needed."
  ].join("\\n")
}));
`;
}

function buildCodexPreToolUseHook(pidfilePath: string): string {
  const indexedExtensions = JSON.stringify(SDL_SOURCE_EXTENSIONS);
  return `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pidfilePath = ${JSON.stringify(pidfilePath)};
const indexedExtensions = new Set(${indexedExtensions});

const RUNTIME_REASON =
  "Run repo-local shell actions through SDL-MCP instead of native shell. Use sdl.workflow with runtimeExecute, default outputMode: \\"minimal\\", persistOutput: true, an explicit timeoutMs, stdin for multiline input, and runtimeQueryOutput only for focused follow-up output.";
const INDEXED_READ_REASON =
  "Use the SDL-MCP Iris retrieval ladder for indexed source reads. Start with sdl.context, then batch follow-ups through sdl.workflow using symbolSearch, symbolGetCard, codeSkeleton, codeHotPath, and codeNeedWindow only as a last resort with identifiersToFind and expectedLines.";
const INDEXED_WRITE_REASON =
  "Use SDL-MCP indexed-source edit tools instead of native writes. Prefer symbol.edit for one-symbol edits; use searchEditPreview with targeting:\\"identifier\\" for exact AST identifier replacements in supported structural languages, targeting:\\"structural\\" for tree-sitter capture edits, or operations[] for heterogeneous batches. Review astMatches/snippets, then apply the plan handle. If SDL edit tools cannot express the change, run a targeted script through sdl.workflow runtimeExecute with stdin.";
const NON_INDEXED_READ_REASON =
  "Use SDL-MCP file.read for non-indexed repository reads. Prefer sdl.file { op: \\"read\\" } or file.read with search, jsonPath, or bounded offset/limit instead of native file reads.";
const NON_INDEXED_WRITE_REASON =
  "Use SDL-MCP file.write for non-indexed repository writes. Prefer sdl.file { op: \\"write\\" } or file.write with one targeted write mode instead of native Write/Edit/apply_patch.";
const MCP_REASON =
  "Use SDL-MCP file/search/edit/runtime actions instead of non-SDL MCP file, search, write, or edit tools in this repository.";

if (!existsSync(pidfilePath)) {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

function normalize(value) {
  return String(value ?? "").replace(/\\\\/g, "/").toLowerCase();
}

function userHome() {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function normalizeResolvedPath(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  try {
    return normalize(isAbsolute(raw) ? resolve(raw) : resolve(repoRoot, raw));
  } catch {
    return normalize(raw);
  }
}

function pathIsWithin(path, parent) {
  const normalizedPath = normalizeResolvedPath(path);
  const normalizedParent = normalizeResolvedPath(parent);
  return (
    normalizedPath === normalizedParent ||
    normalizedPath.startsWith(normalizedParent + "/")
  );
}

function isRepoPath(path) {
  return pathIsWithin(path, repoRoot);
}

function isRepoInternalPath(path) {
  return (
    pathIsWithin(path, resolve(repoRoot, ".codex")) ||
    pathIsWithin(path, resolve(repoRoot, ".claude"))
  );
}

function isUserInternalPath(path) {
  const home = userHome();
  if (!home) {
    return false;
  }
  return [
    resolve(home, ".codex", "memories"),
    resolve(home, ".codex", "skills"),
    resolve(home, ".codex", "plugins"),
    resolve(home, ".codex", "sessions"),
    resolve(home, ".agents", "skills"),
    resolve(home, ".claude", "agents"),
    resolve(home, ".claude", "skills"),
  ].some((root) => pathIsWithin(path, root));
}

function isAllowedInternalPath(path) {
  return isRepoInternalPath(path) || (!isRepoPath(path) && isUserInternalPath(path));
}

function getToolInput(input) {
  return input.tool_input ?? input.toolInput ?? input.input ?? {};
}

function getToolName(input) {
  return String(input.tool_name ?? input.toolName ?? "");
}

function getHookEventName(input) {
  return String(input.hook_event_name ?? input.hookEventName ?? "");
}

function getCommand(toolInput) {
  return String(
    toolInput.command ??
      toolInput.cmd ??
      toolInput.script ??
      toolInput.args?.command ??
      "",
  );
}

function collectStringPaths(value, paths = []) {
  if (!value) {
    return paths;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringPaths(entry, paths);
    }
    return paths;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (
        /^(file_path|filePath|path|filename|target_file|targetFile|old_path|oldPath|new_path|newPath)$/i.test(
          key,
        ) &&
        typeof entry === "string"
      ) {
        paths.push(entry);
      } else {
        collectStringPaths(entry, paths);
      }
    }
    return paths;
  }
  return paths;
}

function collectPatchPaths(toolInput) {
  const patch = String(toolInput.patch ?? toolInput.diff ?? "");
  const paths = [];
  for (const match of patch.matchAll(/^\\*\\*\\* (?:Add|Update|Delete) File: (.+)$/gim)) {
    paths.push(match[1].trim());
  }
  return paths;
}

function getCandidatePaths(toolInput) {
  return [...collectStringPaths(toolInput), ...collectPatchPaths(toolInput)].filter(
    Boolean,
  );
}

function targetsRepo(input, serializedToolInput, toolInput, candidatePaths) {
  const normalizedRepoRoot = normalize(repoRoot);
  const cwd = input.cwd ?? toolInput.cwd ?? toolInput.workdir ?? toolInput.working_directory;
  return (
    normalize(cwd).startsWith(normalizedRepoRoot) ||
    normalize(serializedToolInput).includes(normalizedRepoRoot) ||
    candidatePaths.some((path) => isRepoPath(path))
  );
}

function containsIndexedSourcePath(value) {
  const normalized = normalize(value);
  if (normalized.includes("/src/") || normalized.includes("src/")) {
    return true;
  }
  for (const extension of indexedExtensions) {
    if (normalized.includes(extension)) {
      return true;
    }
  }
  return false;
}

function fileOperation(toolName) {
  const normalized = toolName.toLowerCase();
  if (normalized === "read" || normalized.endsWith(".read")) {
    return "read";
  }
  if (
    ["write", "edit", "multiedit", "notebookedit", "apply_patch"].some(
      (name) => normalized === name || normalized.endsWith("." + name),
    )
  ) {
    return "write";
  }
  return null;
}

function internalCommandLooksAllowed(command) {
  const normalized = normalize(command);
  const mentionsInternal =
    /(?:^|[\\s"'\\x60])\\.(?:codex|claude)(?:[\\/"'\\x60\\s]|$)/i.test(command) ||
    normalized.includes("/.codex/") ||
    normalized.includes("/.claude/") ||
    normalized.includes("/.agents/skills/");
  if (!mentionsInternal) {
    return false;
  }
  return !/(?:^|[\\s"'\\x60])(?:src|tests|docs|templates|native|scripts|config|packages|grammar-wrappers|README\\.md|SDL\\.md|AGENTS\\.md|CODEX\\.md|CLAUDE\\.md|package(?:-lock)?\\.json|tsconfig\\.json|eslint\\.config\\.mjs)(?:[\\/"'\\x60\\s]|$)/i.test(
    command,
  );
}

function nativeFileReason(toolName, toolInput, serializedToolInput, candidatePaths) {
  const operation = fileOperation(toolName);
  if (!operation) {
    return null;
  }
  const indexed =
    candidatePaths.some((path) => containsIndexedSourcePath(path)) ||
    containsIndexedSourcePath(serializedToolInput);
  if (operation === "read") {
    return indexed ? INDEXED_READ_REASON : NON_INDEXED_READ_REASON;
  }
  return indexed ? INDEXED_WRITE_REASON : NON_INDEXED_WRITE_REASON;
}

function isNativeFileTool(toolName) {
  return fileOperation(toolName) !== null;
}

function isShellTool(toolName) {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "bash" ||
    normalized === "shell" ||
    normalized === "shell_command" ||
    normalized.endsWith(".shell_command")
  );
}

function isSdlMcpTool(toolName) {
  return /^mcp__sdl[_-]mcp__/.test(toolName);
}

function isNonSdlMcpFileTool(toolName) {
  return (
    /^mcp__/.test(toolName) &&
    !isSdlMcpTool(toolName) &&
    /(file|filesystem|fs|read|write|edit|search|grep|ripgrep|glob)/i.test(toolName)
  );
}

const rawInput = await new Promise((resolveInput) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolveInput(data));
});

if (!rawInput.trim()) {
  process.exit(0);
}

let hookInput;
try {
  hookInput = JSON.parse(rawInput);
} catch {
  process.exit(0);
}

if (getHookEventName(hookInput) !== "PreToolUse") {
  process.exit(0);
}

const toolInput = getToolInput(hookInput);
const toolName = getToolName(hookInput);
const toolInputJson = JSON.stringify(toolInput);
const candidatePaths = getCandidatePaths(toolInput);

if (isSdlMcpTool(toolName)) {
  process.exit(0);
}

if (isShellTool(toolName)) {
  const command = getCommand(toolInput);
  if (internalCommandLooksAllowed(command)) {
    process.exit(0);
  }
  if (targetsRepo(hookInput, toolInputJson, toolInput, candidatePaths)) {
    deny(RUNTIME_REASON);
  }
  process.exit(0);
}

if (
  candidatePaths.length > 0 &&
  candidatePaths.every((path) => isAllowedInternalPath(path))
) {
  process.exit(0);
}

if (!targetsRepo(hookInput, toolInputJson, toolInput, candidatePaths)) {
  process.exit(0);
}

if (isNativeFileTool(toolName)) {
  deny(nativeFileReason(toolName, toolInput, toolInputJson, candidatePaths));
  process.exit(0);
}

if (isNonSdlMcpFileTool(toolName)) {
  deny(MCP_REASON);
}
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
      path: join(repoRoot, "SDL.md"),
      content: loadTextTemplate("SDL.md"),
    },
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
    const pidfilePath = resolvePidfilePath(graphDbPath)
      .replace(/\\/g, "/")
      .replace(/'/g, "'\\''");
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
        path: join(repoRoot, ".claude", "hooks", "force-sdl-explore.sh"),
        content: buildClaudeExploreHook(pidfilePath),
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

  if (client === "codex") {
    const graphDbPath = defaultGraphDbPath(configPath);
    const pidfilePath = resolvePidfilePath(graphDbPath).replace(/\\/g, "/");
    assets.push(
      {
        path: join(repoRoot, ".codex", "config.toml"),
        content: buildCodexProjectConfig(),
      },
      {
        path: join(repoRoot, ".codex", "hooks.json"),
        content: buildCodexHooksJson(repoRoot),
      },
      {
        path: join(repoRoot, ".codex", "hooks", "load-sdl-skill.mjs"),
        content: buildCodexSessionStartHook(),
        executable: true,
      },
      {
        path: join(repoRoot, ".codex", "hooks", "force-sdl-mcp.mjs"),
        content: buildCodexPreToolUseHook(pidfilePath),
        executable: true,
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
    mcpServers: Record<
      string,
      { env?: Record<string, string>; [k: string]: unknown }
    >;
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

export type ClientDetection = {
  name: string;
  configPath: string;
  templateClient?: ClientType;
};

export function detectInstalledClients(): ClientDetection[] {
  // USERPROFILE is Windows-only — fall back to homedir() so detection works on macOS/Linux.
  const userProfile = process.env.USERPROFILE ?? homedir();
  const appData = process.env.APPDATA ?? "";
  // CLAUDE_CONFIG_DIR overrides ~/.claude when set (issue #17). When set, it is
  // authoritative — we do NOT fall through to legacy paths, since users set this
  // env var precisely to redirect Claude Code config away from ~/.claude. The
  // value may be a comma-separated list per upstream Claude Code semantics.
  const claudeConfigDirs = (process.env.CLAUDE_CONFIG_DIR ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const claudeCandidates: string[] =
    claudeConfigDirs.length > 0
      ? claudeConfigDirs.flatMap((dir) => [
          join(dir, ".claude.json"),
          join(dir, "settings.json"),
        ])
      : [
          join(userProfile, ".claude.json"),
          join(userProfile, ".claude", "settings.json"),
          join(appData, "Claude", "claude_desktop_config.json"),
        ];
  const detections: Array<{
    name: string;
    templateClient?: ClientType;
    candidates: string[];
  }> = [
    {
      name: "claude-code",
      templateClient: "claude-code",
      candidates: claudeCandidates,
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
  // CLAUDE_CONFIG_DIR is set but no Claude Code config exists there yet — surface
  // the env-var location as the intended install target so instructions point at
  // the right place instead of falling back to manual-config (issue #17).
  if (
    claudeConfigDirs.length > 0 &&
    !installed.some((d) => d.name === "claude-code")
  ) {
    installed.push({
      name: "claude-code",
      templateClient: "claude-code",
      configPath: normalizePath(join(claudeConfigDirs[0], "settings.json")),
    });
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
    performanceTier: "auto" as const,
    dbPath,
    graphDatabase: {
      path: ladybugDbPath,
    },
    policy: {
      maxWindowLines: DEFAULT_MAX_WINDOW_LINES,
      maxWindowTokens: DEFAULT_MAX_WINDOW_TOKENS,
      requireIdentifiers: true,
      allowBreakGlass: false,
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
      pass2Concurrency: DEFAULT_PASS2_CONCURRENCY,
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
        implements: 0.9,
      },
    },
    prefetch: {
      enabled: true,
      maxBudgetPercent: 20,
      warmTopN: 0,
      policy: {
        enabled: true,
        mode: "safe" as const,
        minSamples: 20,
        suppressionWasteRate: 0.8,
        boostHitRate: 0.35,
        retentionDays: 14,
        maxPriorityBoost: 25,
        maxBudgetTrimPercent: 50,
      },
    },
    tracing: {
      enabled: true,
      serviceName: "sdl-mcp",
      exporterType: "console" as const,
      sampleRate: 1.0,
    },
    observability: {
      enabled: true,
      sampleIntervalMs: 2000,
      retentionShortMinutes: 15,
      retentionLongHours: 24,
      pprMetricsEnabled: true,
      packedStatsEnabled: true,
      scipIngestMetrics: true,
      beamExplainCapacity: 128,
      beamExplainEntriesPerSlice: 512,
      sseHeartbeatMs: 15_000,
      sseMaxStreamMs: 3_600_000,
    },
    parallelScorer: {
      enabled: true,
    },
    httpAuth: {
      enabled: false,
      token: null,
      rateLimit: {
        bucketSize: 30,
        refillPerSec: 0.5,
      },
    },
    http: {
      allowRemote: false,
    },
    codeMode: {
      enabled: true,
      exclusive: true,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50_000,
      maxWorkflowDurationMs: 60_000,
      ladderValidation: "warn" as const,
      etagCaching: true,
    },
    ...(options.enforceAgentTools
      ? {
          runtime: ENFORCED_RUNTIME_CONFIG,
        }
      : {}),
  };

  // SDL.md + baseline AGENTS.md are dropped regardless of enforcement so the
  // optimized-tool-use playbook is always present before any agent touches
  // the repo. Client-specific hooks/settings only ship when enforcement is on.
  const generatedAssets = buildEnforcementAssets(
    repoRoot,
    repoId,
    configPath,
    options.enforceAgentTools
      ? (options.client as ClientType | undefined)
      : undefined,
  );

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
      writeGeneratedAsset(asset, createdPaths, createdDirs, options.force);
    }

    console.log(`Configuration created: ${normalizePath(configPath)}`);
    console.log(`Database path: ${normalizePath(dbPath)}`);
    console.log(`Graph database path: ${normalizePath(ladybugDbPath)}`);
    console.log(`Repository: ${normalizedRepoPath} (id: ${repoId})`);
    console.log(`Languages: ${languages.join(", ")}`);

    if (options.client) {
      // Client validation already done at line ~1052; this is post-success client config generation
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
