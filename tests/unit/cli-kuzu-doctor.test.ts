import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

describe("CLI doctor command - KuzuDB", () => {
  let tempDir: string;
  let originalExit: typeof process.exit;
  let originalSDLConfig: string | undefined;
  let originalSDLConfigPath: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `sdl-mcp-doctor-kuzu-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    originalSDLConfig = process.env.SDL_CONFIG;
    originalSDLConfigPath = process.env.SDL_CONFIG_PATH;

    originalExit = process.exit;
    process.exit = ((code: number) => {
      throw new Error(`Process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;

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

  it("reports KuzuDB status when configured", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");
    const kuzuPath = join(tempDir, "sdl-mcp-graph");
    mkdirSync(kuzuPath, { recursive: true });

    const config = {
      repos: [{ repoId: "test", rootPath: tempDir }],
      dbPath: join(tempDir, "sdlmcp.sqlite"),
      graphDatabase: { path: kuzuPath },
    };
    writeFileSync(configPath, JSON.stringify(config));

    const { doctorCommand } = await import("../../src/cli/commands/doctor.js");

    let output = "";
    const originalLog = console.log;
    console.log = (msg: string) => {
      output += `${msg}\n`;
    };

    try {
      await doctorCommand({ config: configPath });
    } catch (e) {
      // May throw on failed checks
    } finally {
      console.log = originalLog;
    }

    assert.ok(
      output.includes("Graph database") || output.includes("KuzuDB"),
      "Output should mention graph database or KuzuDB"
    );
  });

  it("warns when KuzuDB directory does not exist", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");

    const config = {
      repos: [{ repoId: "test", rootPath: tempDir }],
      dbPath: join(tempDir, "sdlmcp.sqlite"),
      graphDatabase: { path: join(tempDir, "nonexistent-kuzudb") },
    };
    writeFileSync(configPath, JSON.stringify(config));

    const { doctorCommand } = await import("../../src/cli/commands/doctor.js");

    let output = "";
    const originalLog = console.log;
    console.log = (msg: string) => {
      output += `${msg}\n`;
    };

    try {
      await doctorCommand({ config: configPath });
    } catch (e) {
      // Expected
    } finally {
      console.log = originalLog;
    }

    assert.ok(
      output.includes("not found") || output.includes("warn"),
      "Output should indicate KuzuDB directory not found"
    );
  });

  it("warns when graphDatabase not configured", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");

    const config = {
      repos: [{ repoId: "test", rootPath: tempDir }],
      dbPath: join(tempDir, "sdlmcp.sqlite"),
    };
    writeFileSync(configPath, JSON.stringify(config));

    const { doctorCommand } = await import("../../src/cli/commands/doctor.js");

    let output = "";
    const originalLog = console.log;
    console.log = (msg: string) => {
      output += `${msg}\n`;
    };

    try {
      await doctorCommand({ config: configPath });
    } catch (e) {
      // Expected
    } finally {
      console.log = originalLog;
    }

    assert.ok(
      output.includes("Graph database") || output.includes("KuzuDB"),
      "Output should mention graph database"
    );
  });
});
