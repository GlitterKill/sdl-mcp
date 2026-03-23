import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

describe("CLI doctor command - LadybugDB", () => {
  let tempDir: string;
  let originalExit: typeof process.exit;
  let originalSDLConfig: string | undefined;
  let originalSDLConfigPath: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `sdl-mcp-doctor-ladybug-test-${Date.now()}`);
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

  it("reports LadybugDB status when configured", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");
    const ladybugPath = join(tempDir, "sdl-mcp-graph.lbug");

    const config = {
      repos: [{ repoId: "test", rootPath: tempDir }],
      dbPath: join(tempDir, "sdlmcp.sqlite"),
      graphDatabase: { path: ladybugPath },
    };
    writeFileSync(configPath, JSON.stringify(config));

    const { initLadybugDb, closeLadybugDb } =
      await import("../../dist/db/ladybug.js");
    const { doctorCommand } = await import("../../dist/cli/commands/doctor.js");
    await initLadybugDb(ladybugPath);

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
      await closeLadybugDb();
      console.log = originalLog;
    }

    assert.ok(
      output.includes("Graph database") || output.includes("LadybugDB"),
      "Output should mention graph database or LadybugDB",
    );
  });

  it("warns when LadybugDB file does not exist", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");

    const config = {
      repos: [{ repoId: "test", rootPath: tempDir }],
      dbPath: join(tempDir, "sdlmcp.sqlite"),
      graphDatabase: { path: join(tempDir, "nonexistent-ladybugdb.lbug") },
    };
    writeFileSync(configPath, JSON.stringify(config));

    const { doctorCommand } = await import("../../dist/cli/commands/doctor.js");

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
      "Output should indicate LadybugDB file not found",
    );
  });

  it("warns when graphDatabase not configured", async () => {
    const configPath = join(tempDir, "sdlmcp.config.json");

    const config = {
      repos: [{ repoId: "test", rootPath: tempDir }],
      dbPath: join(tempDir, "sdlmcp.sqlite"),
    };
    writeFileSync(configPath, JSON.stringify(config));

    const { doctorCommand } = await import("../../dist/cli/commands/doctor.js");

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
      output.includes("Graph database") || output.includes("LadybugDB"),
      "Output should mention graph database",
    );
  });
});
