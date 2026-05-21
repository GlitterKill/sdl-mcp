import assert from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

describe("init agent enforcement", () => {
  let tempDir: string;
  let originalSDLConfig: string | undefined;
  let originalSDLConfigPath: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `sdl-mcp-init-enforce-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    originalSDLConfig = process.env.SDL_CONFIG;
    originalSDLConfigPath = process.env.SDL_CONFIG_PATH;
  });

  afterEach(() => {
    if (originalSDLConfig === undefined) {
      delete process.env.SDL_CONFIG;
    } else {
      process.env.SDL_CONFIG = originalSDLConfig;
    }

    if (originalSDLConfigPath === undefined) {
      delete process.env.SDL_CONFIG_PATH;
    } else {
      process.env.SDL_CONFIG_PATH = originalSDLConfigPath;
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes runtime and code-mode config when enforceAgentTools is enabled", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");
    const { initCommand } = await import("../../dist/cli/commands/init.js");

    await initCommand({
      config: configPath,
      repoPath: tempDir,
      yes: true,
      autoIndex: false,
      force: true,
      enforceAgentTools: true,
    });

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepStrictEqual(config.codeMode, {
      enabled: true,
      exclusive: true,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50000,
      maxWorkflowDurationMs: 60000,
      ladderValidation: "warn",
      etagCaching: true,
    });
    assert.strictEqual(config.runtime.enabled, true);
    assert.deepStrictEqual(config.runtime.allowedRuntimes, [
      "node",
      "typescript",
      "python",
      "ruby",
      "php",
      "shell",
    ]);
  });

  it("creates Claude enforcement assets", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");
    const { initCommand } = await import("../../dist/cli/commands/init.js");

    await initCommand({
      config: configPath,
      repoPath: tempDir,
      yes: true,
      autoIndex: false,
      force: true,
      client: "claude-code",
      enforceAgentTools: true,
    });

    assert.ok(existsSync(join(tempDir, "AGENTS.md")));
    assert.ok(existsSync(join(tempDir, "CLAUDE.md")));
    assert.ok(existsSync(join(tempDir, ".claude", "settings.json")));
    assert.ok(
      existsSync(join(tempDir, ".claude", "hooks", "force-sdl-mcp.sh")),
    );
    assert.ok(
      existsSync(join(tempDir, ".claude", "hooks", "force-sdl-runtime.sh")),
    );
    assert.ok(existsSync(join(tempDir, ".claude", "agents", "explore-sdl.md")));

    const agentsText = readFileSync(join(tempDir, "AGENTS.md"), "utf8");
    const claudeText = readFileSync(join(tempDir, "CLAUDE.md"), "utf8");
    for (const generatedText of [agentsText, claudeText]) {
      assert.match(generatedText, /searchEditPreview/);
      assert.match(generatedText, /targeting:"identifier"/);
      assert.match(generatedText, /operations\[\]/);
      assert.match(generatedText, /stdin/);
    }

    const settings = JSON.parse(
      readFileSync(join(tempDir, ".claude", "settings.json"), "utf8"),
    );
    for (const tool of [
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Bash",
    ]) {
      assert.ok(settings.permissions.allow.includes(tool));
      assert.ok(
        settings.hooks.PreToolUse.some(
          (entry: { matcher: string }) => entry.matcher === tool,
        ),
      );
    }
  });

  it("creates Codex enforcement assets", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");
    const { initCommand } = await import("../../dist/cli/commands/init.js");

    mkdirSync(join(tempDir, ".codex", "hooks"), { recursive: true });
    writeFileSync(
      join(tempDir, ".codex", "hooks.json"),
      JSON.stringify({ hooks: { PostToolUse: [] } }),
    );
    writeFileSync(
      join(tempDir, ".codex", "hooks", "force-sdl-mcp.mjs"),
      "stale",
    );

    await initCommand({
      config: configPath,
      repoPath: tempDir,
      yes: true,
      autoIndex: false,
      force: true,
      client: "codex",
      enforceAgentTools: true,
    });

    assert.ok(existsSync(join(tempDir, "AGENTS.md")));
    assert.ok(existsSync(join(tempDir, "CODEX.md")));
    assert.ok(existsSync(join(tempDir, ".codex", "config.toml")));
    assert.ok(existsSync(join(tempDir, ".codex", "hooks.json")));
    assert.ok(
      existsSync(join(tempDir, ".codex", "hooks", "load-sdl-skill.mjs")),
    );
    assert.ok(
      existsSync(join(tempDir, ".codex", "hooks", "force-sdl-mcp.mjs")),
    );

    const agentsText = readFileSync(join(tempDir, "AGENTS.md"), "utf8");
    const codexText = readFileSync(join(tempDir, "CODEX.md"), "utf8");
    for (const generatedText of [agentsText, codexText]) {
      assert.match(generatedText, /searchEditPreview/);
      assert.match(generatedText, /targeting:"identifier"/);
      assert.match(generatedText, /operations\[\]/);
      assert.match(generatedText, /stdin/);
    }

    const sessionHookPath = join(
      tempDir,
      ".codex",
      "hooks",
      "load-sdl-skill.mjs",
    );
    const hookPath = join(tempDir, ".codex", "hooks", "force-sdl-mcp.mjs");
    const hooks = JSON.parse(
      readFileSync(join(tempDir, ".codex", "hooks.json"), "utf8"),
    );
    assert.strictEqual(hooks.hooks.SessionStart[0].hooks[0].timeout, 5);
    assert.match(
      hooks.hooks.SessionStart[0].hooks[0].command,
      /load-sdl-skill\.mjs/,
    );
    assert.strictEqual(hooks.hooks.PreToolUse[0].matcher, ".*");
    assert.strictEqual(hooks.hooks.PostToolUse, undefined);

    const skillPath = join(tempDir, "SKILL.md");
    writeFileSync(
      skillPath,
      [
        "---",
        "name: sdl-mcp-agent-workflow",
        "description: test skill",
        "---",
        "",
        "Start with repo.status and sdl.context.",
      ].join("\n"),
    );
    const sessionHookRun = spawnSync(process.execPath, [sessionHookPath], {
      input: JSON.stringify({ hook_event_name: "SessionStart", cwd: tempDir }),
      encoding: "utf8",
      env: {
        ...process.env,
        SDL_MCP_AGENT_WORKFLOW_SKILL_PATH: skillPath,
      },
    });
    assert.strictEqual(sessionHookRun.status, 0, sessionHookRun.stderr);
    const sessionHookOutput = JSON.parse(sessionHookRun.stdout);
    assert.match(sessionHookOutput.systemMessage, /skill auto-loaded/);
    assert.match(sessionHookOutput.systemMessage, /sdl-mcp-agent-workflow/);
    assert.match(sessionHookOutput.systemMessage, /repo\.status/);

    const runHook = (payload: Record<string, unknown>): string => {
      const hookRun = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify(payload),
        encoding: "utf8",
      });
      assert.strictEqual(hookRun.status, 0, hookRun.stderr);
      return hookRun.stdout;
    };

    const shellReadPayload = {
      hook_event_name: "PreToolUse",
      cwd: tempDir,
      tool_name: "functions.shell_command",
      tool_input: { command: "Get-Content src/cli/commands/init.ts" },
    };

    assert.strictEqual(runHook(shellReadPayload), "");
    assert.strictEqual(
      runHook({
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "Write",
        tool_input: { file_path: join(tempDir, "README.md") },
      }),
      "",
    );

    writeFileSync(join(tempDir, "sdl-mcp.pid"), `${process.pid}\n`);

    const expectDenied = (
      payload: Record<string, unknown>,
      reasonPattern: RegExp,
    ): void => {
      const hookOutput = JSON.parse(runHook(payload));
      assert.strictEqual(
        hookOutput.hookSpecificOutput.permissionDecision,
        "deny",
      );
      assert.match(
        hookOutput.hookSpecificOutput.permissionDecisionReason,
        reasonPattern,
      );
    };

    for (const [payload, reasonPattern] of [
      [shellReadPayload, /runtimeExecute/],
      [
        {
          hook_event_name: "PreToolUse",
          cwd: tempDir,
          tool_name: "Bash",
          tool_input: { command: "git status --short" },
        },
        /runtimeExecute/,
      ],
      [
        {
          hook_event_name: "PreToolUse",
          cwd: tempDir,
          tool_name: "Read",
          tool_input: { file_path: join(tempDir, "README.md") },
        },
        /file\.read/,
      ],
      [
        {
          hook_event_name: "PreToolUse",
          cwd: tempDir,
          tool_name: "Write",
          tool_input: { file_path: join(tempDir, "docs", "guide.md") },
        },
        /file\.write/,
      ],
      [
        {
          hook_event_name: "PreToolUse",
          cwd: tempDir,
          tool_name: "Read",
          tool_input: {
            file_path: join(tempDir, "src", "cli", "commands", "init.ts"),
          },
        },
        /Iris retrieval ladder/,
      ],
      [
        {
          hook_event_name: "PreToolUse",
          cwd: tempDir,
          tool_name: "Edit",
          tool_input: {
            file_path: join(tempDir, "src", "server.ts"),
            old_string: "old",
            new_string: "new",
          },
        },
        /targeting:"identifier"/,
      ],
      [
        {
          hook_event_name: "PreToolUse",
          cwd: tempDir,
          tool_name: "MultiEdit",
          tool_input: {
            file_path: join(tempDir, "CHANGELOG.md"),
            edits: [{ old_string: "old", new_string: "new" }],
          },
        },
        /file\.write/,
      ],
      [
        {
          hook_event_name: "PreToolUse",
          cwd: tempDir,
          tool_name: "apply_patch",
          tool_input: {
            patch:
              "*** Begin Patch\n*** Update File: src/cli/commands/init.ts\n@@\n-old\n+new\n*** End Patch",
          },
        },
        /targeting:"identifier"/,
      ],
      [
        {
          hook_event_name: "PreToolUse",
          cwd: tempDir,
          tool_name: "apply_patch",
          tool_input: {
            patch:
              "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch",
          },
        },
        /file\.write/,
      ],
      [
        {
          hook_event_name: "PreToolUse",
          cwd: tempDir,
          tool_name: "mcp__filesystem__read_file",
          tool_input: { path: join(tempDir, "src", "server.ts") },
        },
        /non-SDL MCP/,
      ],
      [
        {
          hook_event_name: "PreToolUse",
          cwd: tempDir,
          tool_name: "mcp__filesystem__search_files",
          tool_input: { query: "handleSymbolSearch" },
        },
        /non-SDL MCP/,
      ],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      expectDenied(payload, reasonPattern);
    }

    const home = process.env.USERPROFILE ?? process.env.HOME ?? tempDir;
    for (const payload of [
      {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "Read",
        tool_input: {
          file_path: join(tempDir, ".codex", "hooks", "load-sdl-skill.mjs"),
        },
      },
      {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "Write",
        tool_input: {
          file_path: join(tempDir, ".claude", "settings.json"),
        },
      },
      {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "Read",
        tool_input: {
          file_path: join(home, ".codex", "skills", "x", "SKILL.md"),
        },
      },
      {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "functions.shell_command",
        tool_input: { command: "Get-Content .codex/hooks.json" },
      },
      {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "mcp__sdl_mcp__sdl_context",
        tool_input: { repoId: "sdl-mcp", taskText: "explain init hooks" },
      },
    ]) {
      assert.strictEqual(runHook(payload), "");
    }
  });

  it("creates OpenCode enforcement assets", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");
    const { initCommand } = await import("../../dist/cli/commands/init.js");

    await initCommand({
      config: configPath,
      repoPath: tempDir,
      yes: true,
      autoIndex: false,
      force: true,
      client: "opencode",
      enforceAgentTools: true,
    });

    assert.ok(existsSync(join(tempDir, "AGENTS.md")));
    assert.ok(existsSync(join(tempDir, "OPENCODE.md")));
    assert.ok(existsSync(join(tempDir, "opencode.json")));
    assert.ok(
      existsSync(join(tempDir, ".opencode", "plugins", "enforce-sdl.ts")),
    );
  });
});
