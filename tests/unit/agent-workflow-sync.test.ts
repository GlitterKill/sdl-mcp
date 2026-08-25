import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function assertRuntimeInspectionGuidance(
  content: string,
  relativePath: string,
): void {
  assert.match(content, /runtime(?:Execute|\.execute| execution) executes repository tooling/i, relativePath);
  assert.match(
    content,
    /Do not use (?:it|runtime(?:Execute|\.execute| execution))\s+to inspect, search, or print repository files/i,
    relativePath,
  );
  assert.match(
    content,
    /sdl\.context[\s\S]*?sdl\.retrieve[\s\S]*?indexed source/i,
    relativePath,
  );
  assert.match(
    content,
    /sdl\.file[\s\S]*?op[\s\S]*?read[\s\S]*?other files/i,
    relativePath,
  );
  assert.doesNotMatch(
    content,
    /runtime(?:Execute|\.execute| execution)[^\n.]*(?:inspect|search|print|read)[^\n.]*(?:fallback|last resort)/i,
    relativePath,
  );
}

function functionSection(
  source: string,
  functionName: string,
  nextFunctionName: string,
): string {
  const start = source.indexOf(`function ${functionName}(`);
  const end = source.indexOf(`function ${nextFunctionName}(`, start + 1);
  assert.notEqual(start, -1, `missing ${functionName}`);
  assert.notEqual(end, -1, `missing ${nextFunctionName}`);
  return source.slice(start, end);
}

describe("agent workflow sync", () => {
  it("keeps generated agent workflow surfaces current", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/check-agent-workflows.mjs", "--check"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    assert.equal(result.status, 0, `${result.stdout}
${result.stderr}`);
  });

  it("requires current-turn approval across refresh guidance surfaces", () => {
    const workflowSurfaces = [
      "templates/SDL.md",
      "SDL.md",
      "tests/stress/fixtures/SDL.md",
      "templates/sdl-mcp-agent-workflow/SKILL.md",
      "docs/agent-workflows.md",
      "src/cli/commands/init.ts",
      ".codex/agents/explore-sdl.toml",
      ".claude/agents/explore-sdl.md",
    ];

    for (const relativePath of workflowSurfaces) {
      const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
      assert.match(
        content,
        /explicit user approval in the current turn/,
        relativePath,
      );
    }
  });

  it("documents direct stored-response continuation across generated workflow surfaces", () => {
    const workflowSurfaces = [
      "templates/SDL.md",
      "SDL.md",
      "tests/stress/fixtures/SDL.md",
      "templates/sdl-mcp-agent-workflow/SKILL.md",
      "templates/sdl-mcp-agent-workflow/references/tool-recipes.md",
    ];

    for (const relativePath of workflowSurfaces) {
      const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
      assert.match(
        content,
        /sdl\.retrieve[\s\S]{0,300}(?:op:?\s*["`]responseGet["`]|["']op["']\s*:\s*["']responseGet["'])/,
        relativePath,
      );
    }
  });

  it("keeps raw MCP result handling compact across agent workflow surfaces", () => {
    const workflowSurfaces = [
      "templates/SDL.md",
      "SDL.md",
      "tests/stress/fixtures/SDL.md",
      "templates/sdl-mcp-agent-workflow/SKILL.md",
      "src/mcp/server-instructions.ts",
    ];

    for (const relativePath of workflowSurfaces) {
      const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
      assert.match(
        content,
        /prefer `structuredContent`[\s\S]{0,220}fallback[\s\S]{0,120}older servers/i,
        relativePath,
      );
      assert.match(
        content,
        /do not emit both[\s\S]{0,120}whole MCP response envelope/i,
        relativePath,
      );
      assert.match(
        content,
        /Do not guess\s+`runtimeQueryOutput` arguments[\s\S]{0,180}sdl\.manual/i,
        relativePath,
      );
    }
  });

  it("keeps fallback workflow readiness and provenance guidance current", () => {
    const workflowSurfaces = [
      "templates/SDL.md",
      "SDL.md",
      "tests/stress/fixtures/SDL.md",
    ];

    for (const relativePath of workflowSurfaces) {
      const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
      assert.match(content, /derivedState\.structuralStale/, relativePath);
      assert.match(content, /derivedState\.semanticStale/, relativePath);
      assert.match(content, /continue with available retrieval lanes/i, relativePath);
      assert.match(
        content,
        /reindex only if AST\/provenance-dependent behavior is required; otherwise use an SDL file-based fallback/i,
        relativePath,
      );
    }
  });

  it("keeps runtime repository inspection guidance broad and actionable", () => {
    const workflowSurfaces = [
      "templates/SDL.md",
      "SDL.md",
      "tests/stress/fixtures/SDL.md",
      "templates/sdl-mcp-agent-workflow/SKILL.md",
      "templates/AGENTS.md.template",
      "templates/CLAUDE.md.template",
      "templates/CODEX.md.template",
      "templates/GEMINI.md.template",
      "templates/OPENCODE.md.template",
      ".codex/agents/explore-sdl.toml",
      ".claude/agents/explore-sdl.md",
    ];

    for (const relativePath of workflowSurfaces) {
      assertRuntimeInspectionGuidance(
        readFileSync(resolve(repoRoot, relativePath), "utf8"),
        relativePath,
      );
    }

    const initSource = readFileSync(
      resolve(repoRoot, "src/cli/commands/init.ts"),
      "utf8",
    );
    const sharedGuidanceMatch = initSource.match(
      /const RUNTIME_REPOSITORY_TOOLING_GUIDANCE\s*=\s*([\s\S]*?);\r?\n/,
    );
    assert.ok(sharedGuidanceMatch, "missing shared runtime repository tooling guidance");
    assertRuntimeInspectionGuidance(
      sharedGuidanceMatch[0],
      "src/cli/commands/init.ts#RUNTIME_REPOSITORY_TOOLING_GUIDANCE",
    );
    assert.equal(
      initSource.match(/runtimeExecute executes repository tooling/g)?.length,
      1,
      "init generator should define the canonical runtime guidance once",
    );
    for (const [functionName, nextFunctionName] of [
      ["buildClaudeRuntimeHook", "buildClaudeExploreHook"],
      ["buildClaudeExploreAgent", "buildClaudePrompt"],
      ["buildClaudePrompt", "buildOpenCodeProjectConfig"],
      ["buildOpenCodePlugin", "buildCodexProjectConfig"],
      ["buildCodexSessionStartHook", "buildCodexPreToolUseHook"],
      ["buildCodexPreToolUseHook", "buildAgentInstructionAssets"],
    ] as const) {
      assert.match(
        functionSection(initSource, functionName, nextFunctionName),
        /RUNTIME_REPOSITORY_TOOLING_GUIDANCE/,
        `src/cli/commands/init.ts#${functionName}`,
      );
    }
  });
});
