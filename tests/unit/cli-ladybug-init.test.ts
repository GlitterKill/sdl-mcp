import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

describe("CLI init command - LadybugDB", () => {
  let tempDir: string;
  let originalSDLConfig: string | undefined;
  let originalSDLConfigPath: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `sdl-mcp-init-ladybug-test-${Date.now()}`);
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

    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("writes a .lbug graph database path alongside the legacy sqlite path", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");
    const expectedLadybugPath = join(tempDir, "sdl-mcp-graph.lbug");

    const { initCommand } = await import("../../dist/cli/commands/init.js");

    await initCommand({
      config: configPath,
      repoPath: tempDir,
      yes: true,
      autoIndex: false,
      force: true,
    });

    assert.ok(existsSync(configPath), "Config file should exist");
    assert.ok(
      existsSync(dirname(expectedLadybugPath)),
      "LadybugDB parent directory should exist",
    );
    assert.ok(
      !existsSync(expectedLadybugPath),
      "LadybugDB file should not be created before initialization",
    );

    const configContent = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.ok(configContent.graphDatabase, "Config should have graphDatabase");
    assert.strictEqual(
      configContent.graphDatabase.path,
      expectedLadybugPath,
      "graphDatabase.path should point to the LadybugDB file",
    );
  });

  it("includes graphDatabase section in generated config", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");

    const { initCommand } = await import("../../dist/cli/commands/init.js");

    await initCommand({
      config: configPath,
      repoPath: tempDir,
      yes: true,
      autoIndex: false,
      force: true,
    });

    const configContent = JSON.parse(readFileSync(configPath, "utf-8"));

    assert.ok(configContent.graphDatabase, "Config should have graphDatabase");
    assert.ok(
      configContent.graphDatabase.path,
      "graphDatabase should have path",
    );
    assert.ok(
      configContent.graphDatabase.path.endsWith("sdl-mcp-graph.lbug"),
      "graphDatabase.path should end with sdl-mcp-graph.lbug",
    );
  });

  it("dry-run mode does not create the LadybugDB file path", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");
    const expectedLadybugPath = join(tempDir, "sdl-mcp-graph.lbug");

    const { initCommand } = await import("../../dist/cli/commands/init.js");

    await initCommand({
      config: configPath,
      repoPath: tempDir,
      yes: true,
      autoIndex: false,
      dryRun: true,
    });

    assert.ok(
      !existsSync(configPath),
      "Config file should not exist in dry-run",
    );
    assert.ok(
      !existsSync(expectedLadybugPath),
      "LadybugDB file should not exist in dry-run",
    );
  });
});
