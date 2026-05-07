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
  });

  it("creates Codex enforcement assets", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");
    const { initCommand } = await import("../../dist/cli/commands/init.js");

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
      existsSync(join(tempDir, ".codex", "hooks", "force-sdl-mcp.mjs")),
    );

    const hookPath = join(tempDir, ".codex", "hooks", "force-sdl-mcp.mjs");
    const hooks = JSON.parse(
      readFileSync(join(tempDir, ".codex", "hooks.json"), "utf8"),
    );
    assert.strictEqual(hooks.hooks.PreToolUse[0].matcher, ".*");

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

    writeFileSync(join(tempDir, "sdl-mcp.pid"), `${process.pid}\n`);

    const deniedPayloads = [
      shellReadPayload,
      {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "Read",
        tool_input: {
          file_path: join(tempDir, "src", "cli", "commands", "init.ts"),
        },
      },
      {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "apply_patch",
        tool_input: {
          patch:
            "*** Begin Patch\n*** Update File: src/cli/commands/init.ts\n@@\n-old\n+new\n*** End Patch",
        },
      },
      {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      },
      {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "mcp__filesystem__read_file",
        tool_input: { path: join(tempDir, "src", "server.ts") },
      },
      {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "mcp__filesystem__search_files",
        tool_input: { query: "handleSymbolSearch" },
      },
    ];

    for (const payload of deniedPayloads) {
      const hookOutput = JSON.parse(runHook(payload));
      assert.strictEqual(
        hookOutput.hookSpecificOutput.permissionDecision,
        "deny",
      );
    }

    for (const payload of [
      {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
      },
      {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "Read",
        tool_input: { file_path: join(tempDir, "README.md") },
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
