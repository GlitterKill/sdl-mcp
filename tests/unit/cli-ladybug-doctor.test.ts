import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
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


// ---------------------------------------------------------------------------
// Recovery guidance (Task 8)
// ---------------------------------------------------------------------------
describe("doctor recovery guidance", () => {
  const doctorSrc = readFileSync(
    join(process.cwd(), "src/cli/commands/doctor.ts"),
    "utf8",
  );
  const ladybugSrc = readFileSync(
    join(process.cwd(), "src/db/ladybug.ts"),
    "utf8",
  );

  it("doctor distinguishes corruption from index absence", () => {
    assert.ok(
      doctorSrc.includes("Database corruption detected"),
      "doctor should detect and report corruption",
    );
  });

  it("doctor provides reindex guidance for missing indexes", () => {
    assert.ok(
      doctorSrc.includes("sdl-mcp index"),
      "doctor should suggest 'sdl-mcp index' for missing indexes",
    );
  });

  it("ladybug.ts has WAL-specific recovery guidance", () => {
    assert.ok(
      ladybugSrc.includes("WAL (write-ahead log) corruption"),
      "ladybug.ts should have WAL-specific guidance",
    );
  });

  it("ladybug.ts distinguishes lock errors from corruption", () => {
    assert.ok(
      ladybugSrc.includes("locked by another process"),
      "ladybug.ts should distinguish lock errors",
    );
  });

  it("recovery guidance mentions semantic embeddings are recomputable", () => {
    assert.ok(
      ladybugSrc.includes("recomputed"),
      "should mention embeddings are recomputable artifacts",
    );
  });
});

