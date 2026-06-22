#!/usr/bin/env node
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
    home
      ? join(home, ".codex", "skills", "sdl-mcp-agent-workflow", "SKILL.md")
      : undefined,
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
    "Load and follow the `sdl-mcp-agent-workflow` skill when available. Fallback rules:",
    "1. Start every repository task with `repo.status`, then choose `sdl.context`, `symbolSearch`/`symbolGetCard`, or `slice.build` based on the task.",
    '2. Use `contextMode: "precise"` for named symbols, exact paths, narrow bugs, focused reviews, and implementation follow-up.',
    '3. Use `contextMode: "broad"` for subsystem mapping, behavior tracing, unfamiliar code, or broad investigations.',
    "4. Batch follow-up retrieval through `sdl.workflow`: `symbolSearch`, `symbolGetCard`, `sliceBuild` for graph/file frontiers, `codeSkeleton`, `codeHotPath`, then `codeNeedWindow` as a last resort.",
    '5. Use `symbol.edit` for one-symbol indexed edits; use `searchEditPreview` with `targeting:"identifier"`, `targeting:"structural"`, or `operations[]` for safer cross-file edits.',
    "6. Use `runtimeExecute` with `stdin` for repo-local commands and multiline scripts/input; for indexed-source edits, use runtime only when SDL edit tools cannot express the change.",
    "7. Use memory tools only when `memory.enabled: true`; avoid habitual `index.refresh`.",
    "8. Finish with `usageStats` and pass through the full session token meter, including per-tool savings; do not replace it with a one-line summary.",
  ].join("\n");
}

const input = readHookInput();
if (input.hook_event_name && input.hook_event_name !== "SessionStart") {
  process.exit(0);
}

const skill = loadSkill();
const sourceLine = skill
  ? `Skill source: ${skill.path}`
  : "Skill source: fallback summary; install the user-global sdl-mcp-agent-workflow skill for the full version.";
const body = skill?.body ?? fallbackSkillBody();

process.stdout.write(
  JSON.stringify({
    systemMessage: [
      "SDL-MCP Agent Workflow skill auto-loaded for this session.",
      sourceLine,
      "",
      body,
      "",
      "For detailed recipes, load references/tool-recipes.md from the same skill directory when needed.",
    ].join("\n"),
  }),
);
