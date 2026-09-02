#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = new Set(process.argv.slice(2));
const writeMode = args.has("--write");
const checkMode = args.has("--check") || !writeMode;

const exactCopySets = [
  {
    canonicalPath: "templates/SDL.md",
    copies: ["SDL.md", "tests/stress/fixtures/SDL.md"],
  },
];

const runtimeInspectionAnchors = [
  "executes repository tooling",
  "inspect, search, or print repository files",
  "sdl.context",
  "sdl.retrieve",
  "sdl.file",
  "op=",
  "other files",
  "targeted edit scripts",
];

const initRuntimeGuidanceSections = [
  ["const RUNTIME_REPOSITORY_TOOLING_GUIDANCE", "const SDL_RUNTIME_REDIRECT_PREFIXES", runtimeInspectionAnchors],
  ["function buildClaudeRuntimeHook(", "function buildClaudeExploreHook(", ["RUNTIME_REPOSITORY_TOOLING_GUIDANCE"]],
  ["function buildClaudeExploreAgent(", "function buildClaudePrompt(", ["RUNTIME_REPOSITORY_TOOLING_GUIDANCE"]],
  ["function buildClaudePrompt(", "function buildOpenCodeProjectConfig(", ["RUNTIME_REPOSITORY_TOOLING_GUIDANCE"]],
  ["function buildOpenCodePlugin(", "function buildCodexProjectConfig(", ["RUNTIME_REPOSITORY_TOOLING_GUIDANCE"]],
  ["function buildCodexSessionStartHook(", "function buildCodexPreToolUseHook(", ["RUNTIME_REPOSITORY_TOOLING_GUIDANCE"]],
  ["function buildCodexPreToolUseHook(", "function buildAgentInstructionAssets(", ["RUNTIME_REPOSITORY_TOOLING_GUIDANCE"]],
].map(([sectionStart, sectionEnd, required]) => ({
  path: "src/cli/commands/init.ts",
  sectionStart,
  sectionEnd,
  required,
}));

const syncSurfaces = [
  {
    path: "templates/SDL.md",
    required: ["slice.build", "structured retrieval is unavailable", "symbol.edit", "symbolEditPreview", "search.edit", "previewWindow", "explicit user approval in the current turn"],
  },
  {
    path: "templates/sdl-mcp-agent-workflow/SKILL.md",
    required: ["budget.maxTokens", "sdl.context", "sdl.retrieve", "response.get", "explicit user approval in the current turn"],
  },
  {
    path: "templates/sdl-mcp-agent-workflow/references/tool-recipes.md",
    required: ["focusSymbols", "includeTests", "jsonPath", "evidence"],
  },
  {
    path: "templates/AGENTS.md.template",
    required: ["sdl-mcp-agent-workflow", "SDL.md", "SDL runtime", "searchEditPreview", "file.read", "file.write"],
  },
  {
    path: "templates/CLAUDE.md.template",
    required: ["sdl-mcp-agent-workflow", "SDL.md", "SDL runtime", "searchEditPreview", "file.read", "file.write"],
  },
  {
    path: "templates/CODEX.md.template",
    required: ["sdl-mcp-agent-workflow", "SessionStart", "SDL.md", "SDL runtime", "searchEditPreview", "file.read", "file.write"],
  },
  {
    path: "templates/GEMINI.md.template",
    required: ["sdl-mcp-agent-workflow", "SDL.md", "SDL runtime", "searchEditPreview", "file.read", "file.write"],
  },
  {
    path: "templates/OPENCODE.md.template",
    required: ["sdl-mcp-agent-workflow", "SDL.md", "SDL runtime", "searchEditPreview", "file.read", "file.write"],
  },
  {
    path: "docs/agent-workflows.md",
    required: ["sdl.context", "sdl.workflow", "responseMode", "runtimeExecute", "usageStats", "explicit user approval in the current turn"],
  },
  {
    path: "docs/tool-enforcement.md",
    required: ["sdl-mcp-agent-workflow", "explore-sdl", "sdl.context", "sdl.workflow", "runtimeExecute"],
  },
  {
    path: "docs/tool-enforcement-for-claude.md",
    required: ["sdl-mcp-agent-workflow", "explore-sdl", "sdl.context", "sdl.workflow", "runtimeExecute"],
  },
  {
    path: "src/mcp/server-instructions.ts",
    required: ["sdl-mcp-agent-workflow", "repo.status", "sdl.context", "sliceBuild", "structured retrieval is unavailable", "symbol.edit", "response.get", "usageStats", "explicit user approval in the current turn"],
  },
  {
    path: "src/cli/commands/init.ts",
    required: ["buildClaudeExploreAgent", "buildCodexSessionStartHook", "sdl-mcp-agent-workflow", "sdl.context", "slice.build", "structured retrieval is unavailable", "symbol.edit", "runtimeExecute", "usageStats", "explicit user approval in the current turn"],
  },
  {
    path: ".codex/agents/explore-sdl.toml",
    required: ["Choose the cheapest SDL discovery surface", "symbolSearch", "sliceBuild", "Never use native `Read`", "file.read` or `sdl.file` `op: \"read\"", "usageStats", "explicit user approval in the current turn"],
  },
  {
    path: ".claude/agents/explore-sdl.md",
    required: ["Choose the cheapest SDL discovery surface", "symbolSearch", "sliceBuild", "NEVER use the native `Read`", "For non-indexed files", "usageStats", "explicit user approval in the current turn"],
  },
  ...[
    "templates/SDL.md",
    "templates/sdl-mcp-agent-workflow/SKILL.md",
    "templates/AGENTS.md.template",
    "templates/CLAUDE.md.template",
    "templates/CODEX.md.template",
    "templates/GEMINI.md.template",
    "templates/OPENCODE.md.template",
    "src/code-mode/action-catalog.ts",
    "src/code-mode/descriptions.ts",
    "src/code-mode/manual-generator.ts",
    "src/mcp/tools/tool-descriptors.ts",
    "src/gateway/descriptions.ts",
    "src/mcp/server-instructions.ts",
    ".codex/agents/explore-sdl.toml",
    ".claude/agents/explore-sdl.md",
  ].map((path) => ({ path, required: runtimeInspectionAnchors })),
  ...initRuntimeGuidanceSections,
];

const narrativeDocs = [
  "docs/agent-workflows.md",
  "docs/tool-enforcement.md",
  "docs/tool-enforcement-for-claude.md",
  "docs/architecture.md",
  "docs/README.md",
  "docs/feature-deep-dives/tool-gateway.md",
];
const forbiddenNarrativePatterns = [
  {
    pattern: /SDL-MCP Token-Efficient Protocol \(v\d+(?:\.\d+)*\)/g,
    message: "omit versioned workflow labels; the canonical SDL.md owns freshness",
  },
  {
    pattern: /\b\d+\s+(?:flat\s+|namespace\s+|meta\s+)?tools\b/gi,
    message: "omit exact tool counts in narrative docs; generated tool inventory owns counts",
  },
  {
    pattern: /\b\d+\s+MCP tool actions\b/gi,
    message: "omit exact MCP tool action counts in narrative docs; generated tool inventory owns counts",
  },
  {
    pattern: /\b\d+\s+internal workflow transforms\b/gi,
    message: "omit exact internal workflow transform counts in narrative docs",
  },
  {
    pattern: /\b\d+\s+opt-in memory actions\b/gi,
    message: "omit exact memory action counts in narrative docs",
  },
  {
    pattern: /per\s+v\d+(?:\.\d+)*/gi,
    message: "omit stale version labels in narrative workflow docs",
  },
  {
    pattern: /replaces\s+\d+\s+of those flat actions/gi,
    message: "omit exact replaced-action counts in narrative docs",
  },
  {
    pattern: /only those \d+ tools/gi,
    message: "omit exact Code Mode tool counts in narrative docs",
  },
];

function read(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing expected workflow surface: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function normalizeEol(text) {
  return text.replace(/\r\n/g, "\n");
}

function preserveEol(source, target) {
  const targetEol = target.includes("\r\n") ? "\r\n" : "\n";
  return normalizeEol(source).replace(/\n/g, targetEol);
}

function shortHash(text) {
  return createHash("sha256").update(normalizeEol(text)).digest("hex").slice(0, 12);
}

function lineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

const failures = [];
for (const { canonicalPath, copies } of exactCopySets) {
  const canonical = read(canonicalPath);
  const normalizedCanonical = normalizeEol(canonical);

  for (const path of copies) {
    const current = read(path);
    if (normalizeEol(current) === normalizedCanonical) continue;

    if (writeMode) {
      writeFileSync(path, preserveEol(canonical, current));
      console.log(`synced ${path} from ${canonicalPath}`);
    } else {
      failures.push(
        `${path} differs from ${canonicalPath} (${shortHash(current)} != ${shortHash(canonical)})`,
      );
    }
  }
}

for (const surface of syncSurfaces) {
  const source = read(surface.path);
  let text = source;
  let surfaceLabel = surface.path;
  if (surface.sectionStart && surface.sectionEnd) {
    const start = source.indexOf(surface.sectionStart);
    const end = source.indexOf(surface.sectionEnd, start + 1);
    surfaceLabel = `${surface.path}#${surface.sectionStart}`;
    if (start === -1 || end === -1) {
      failures.push(`${surfaceLabel} has missing section boundary`);
      continue;
    }
    text = source.slice(start, end);
  }
  for (const required of surface.required) {
    if (!text.includes(required)) {
      failures.push(`${surfaceLabel} is missing workflow anchor: ${required}`);
    }
  }
}

for (const path of narrativeDocs) {
  const text = read(path);
  for (const { pattern, message } of forbiddenNarrativePatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      failures.push(`${path}:${lineNumber(text, match.index ?? 0)} uses "${match[0]}"; ${message}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Agent workflow sync check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  if (checkMode) console.error("Run npm run docs:workflows:write for exact-copy drift, then fix flagged prose.");
  process.exit(1);
}

console.log("Agent workflow surfaces are in sync.");
