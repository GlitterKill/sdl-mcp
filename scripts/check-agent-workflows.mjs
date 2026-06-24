#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = new Set(process.argv.slice(2));
const writeMode = args.has("--write");
const checkMode = args.has("--check") || !writeMode;

const canonicalPath = "templates/SDL.md";
const exactCopies = ["SDL.md", "tests/stress/fixtures/SDL.md"];

const syncSurfaces = [
  {
    path: "templates/SDL.md",
    required: ["slice.build", "file.read` for indexed source", "symbol.edit", "symbolEditPreview", "search.edit", "previewWindow"],
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
    required: ["sdl.context", "sdl.workflow", "responseMode", "runtimeExecute", "usageStats"],
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
    required: ["sdl-mcp-agent-workflow", "repo.status", "sdl.context", "slice.build", "file.read` for indexed source", "symbol.edit", "response.get", "usageStats"],
  },
  {
    path: "src/cli/commands/init.ts",
    required: ["buildClaudeExploreAgent", "buildCodexSessionStartHook", "sdl-mcp-agent-workflow", "sdl.context", "slice.build", "Never use \\`file.read\\` for indexed source", "symbol.edit", "runtimeExecute", "usageStats"],
  },
  {
    path: ".codex/hooks/load-sdl-skill.mjs",
    required: ["sdl-mcp-agent-workflow", "choose `sdl.context`, `symbolSearch`/`symbolGetCard`, or `slice.build`", "sliceBuild", "symbol.edit", "usageStats"],
  },
  {
    path: ".codex/agents/explore-sdl.toml",
    required: ["Choose the cheapest SDL discovery surface", "symbolSearch", "sliceBuild", "Never use native `Read`", "file.read` or `sdl.file` `op: \"read\"", "usageStats"],
  },
  {
    path: ".claude/agents/explore-sdl.md",
    required: ["Choose the cheapest SDL discovery surface", "symbolSearch", "sliceBuild", "NEVER use the native `Read`", "For non-indexed files", "usageStats"],
  },
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
const canonical = read(canonicalPath);
const normalizedCanonical = normalizeEol(canonical);

for (const path of exactCopies) {
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

for (const surface of syncSurfaces) {
  const text = read(surface.path);
  for (const required of surface.required) {
    if (!text.includes(required)) {
      failures.push(`${surface.path} is missing workflow anchor: ${required}`);
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
