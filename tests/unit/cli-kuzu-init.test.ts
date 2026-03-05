import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("CLI init command - KuzuDB", () => {
  let tempDir: string;
  let originalSDLConfig: string | undefined;
  let originalSDLConfigPath: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `sdl-mcp-init-kuzu-test-${Date.now()}`);
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

  it("creates kuzudb directory alongside sqlite database", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");
    const expectedKuzuPath = join(tempDir, "sdl-mcp-graph");

    const { initCommand } = await import("../../src/cli/commands/init.js");

    await initCommand({
      config: configPath,
      repoPath: tempDir,
      yes: true,
      autoIndex: false,
      force: true,
    });

    assert.ok(existsSync(configPath), "Config file should exist");
    assert.ok(existsSync(expectedKuzuPath), "KuzuDB directory should exist");

    const configContent = JSON.parse(
      readFileSync(configPath, "utf-8"),
    );
    assert.ok(configContent.graphDatabase, "Config should have graphDatabase");
    assert.strictEqual(
      configContent.graphDatabase.path,
      expectedKuzuPath,
      "graphDatabase.path should point to kuzudb directory"
    );
  });

  it("includes graphDatabase section in generated config", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");

    const { initCommand } = await import("../../src/cli/commands/init.js");

    await initCommand({
      config: configPath,
      repoPath: tempDir,
      yes: true,
      autoIndex: false,
      force: true,
    });

    const configContent = JSON.parse(
      readFileSync(configPath, "utf-8"),
    );

    assert.ok(configContent.graphDatabase, "Config should have graphDatabase");
    assert.ok(configContent.graphDatabase.path, "graphDatabase should have path");
    assert.ok(
      configContent.graphDatabase.path.endsWith("sdl-mcp-graph"),
      "graphDatabase.path should end with sdl-mcp-graph",
    );
  });

  it("dry-run mode does not create kuzudb directory", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");
    const expectedKuzuPath = join(tempDir, "sdl-mcp-graph");

    const { initCommand } = await import("../../src/cli/commands/init.js");

    await initCommand({
      config: configPath,
      repoPath: tempDir,
      yes: true,
      autoIndex: false,
      dryRun: true,
    });

    assert.ok(!existsSync(configPath), "Config file should not exist in dry-run");
    assert.ok(!existsSync(expectedKuzuPath), "KuzuDB directory should not exist in dry-run");
  });
});
