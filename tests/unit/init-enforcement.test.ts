import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
    assert.ok(existsSync(join(tempDir, ".claude", "hooks", "force-sdl-mcp.sh")));
    assert.ok(existsSync(join(tempDir, ".claude", "hooks", "force-sdl-runtime.sh")));
    assert.ok(existsSync(join(tempDir, ".claude", "agents", "explore-sdl.md")));
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
