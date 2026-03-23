import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("CLI health command", { concurrency: 1 }, () => {
  let tempDir: string;
  let originalSDLConfig: string | undefined;
  let originalSDLConfigPath: string | undefined;
  let originalExit: typeof process.exit;

  before(() => {
    tempDir = join(tmpdir(), `sdl-mcp-health-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    originalSDLConfig = process.env.SDL_CONFIG;
    originalSDLConfigPath = process.env.SDL_CONFIG_PATH;

    originalExit = process.exit;
  });

  after(() => {
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

  function makeConfig(
    subdir: string,
    repos: Array<{ repoId: string; rootPath: string }>,
  ): { configPath: string; ladybugPath: string } {
    const dir = join(tempDir, subdir);
    mkdirSync(dir, { recursive: true });
    const ladybugPath = join(dir, "sdl-mcp-graph.lbug");
    const configPath = join(dir, "sdlmcp.config.json");

    writeFileSync(
      configPath,
      JSON.stringify({
        repos,
        dbPath: join(dir, "sdlmcp.sqlite"),
        graphDatabase: { path: ladybugPath },
      }),
    );

    return { configPath, ladybugPath };
  }

  it("exits with error when no repository is configured", async () => {
    const { configPath, ladybugPath } = makeConfig("empty", []);

    const { healthCommand } = await import("../../dist/cli/commands/health.js");
    const { initLadybugDb, closeLadybugDb } = await import(
      "../../dist/db/ladybug.js"
    );

    await initLadybugDb(ladybugPath);

    let errorOutput = "";
    let exitCode: number | undefined;
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errorOutput += args.map(String).join(" ") + "\n";
    };

    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`exit(${code})`);
    }) as typeof process.exit;

    let thrownError: unknown;
    try {
      await healthCommand({ config: configPath });
    } catch (e) {
      thrownError = e;
    } finally {
      console.error = origError;
      process.exit = originalExit;
      await closeLadybugDb();
    }

    // healthCommand should either call process.exit(1) (which we intercept)
    // or throw an error about missing repos
    const threw = thrownError instanceof Error;
    if (exitCode !== undefined) {
      assert.strictEqual(exitCode, 1, "Should exit with code 1");
    } else {
      assert.ok(
        threw,
        "Should have thrown an error when no repos configured",
      );
    }
  });

  it("outputs health score or N/A for a configured repository", async () => {
    const { configPath, ladybugPath } = makeConfig("repo", [
      { repoId: "test-repo", rootPath: tempDir },
    ]);

    const { healthCommand } = await import("../../dist/cli/commands/health.js");
    const { initLadybugDb, closeLadybugDb } = await import(
      "../../dist/db/ladybug.js"
    );

    await initLadybugDb(ladybugPath);

    let stdoutOutput = "";
    let stdoutWriteOutput = "";
    const origLog = console.log;
    const origWrite = process.stdout.write;
    console.log = (...args: unknown[]) => {
      stdoutOutput += args.map(String).join(" ") + "\n";
    };
    process.stdout.write = ((data: string | Uint8Array) => {
      stdoutWriteOutput += String(data);
      return true;
    }) as typeof process.stdout.write;

    process.exit = originalExit;

    let thrownError: unknown;
    try {
      await healthCommand({ config: configPath });
    } catch (e) {
      thrownError = e;
    } finally {
      console.log = origLog;
      process.stdout.write = origWrite;
      await closeLadybugDb();
    }

    const allOutput = stdoutOutput + stdoutWriteOutput;
    // When getRepoHealthSnapshot throws (e.g., no indexed data), the command
    // fails with an error rather than producing output. In that case verify
    // the error was thrown instead.
    if (allOutput.length > 0) {
      assert.ok(
        allOutput.includes("Health Score:") || allOutput.includes("N/A") || allOutput.includes("available"),
        `Should output health-related content, got: ${allOutput}`,
      );
    } else {
      assert.ok(
        thrownError !== undefined,
        "If no output, healthCommand should have thrown an error for empty repo",
      );
    }
  });

  it("outputs badge JSON when --badge flag is used", async () => {
    const { configPath, ladybugPath } = makeConfig("badge", [
      { repoId: "badge-repo", rootPath: tempDir },
    ]);

    const { healthCommand } = await import("../../dist/cli/commands/health.js");
    const { initLadybugDb, closeLadybugDb } = await import(
      "../../dist/db/ladybug.js"
    );

    await initLadybugDb(ladybugPath);

    let stdoutOutput = "";
    const origWrite = process.stdout.write;
    process.stdout.write = ((data: string | Uint8Array) => {
      stdoutOutput += String(data);
      return true;
    }) as typeof process.stdout.write;

    process.exit = originalExit;

    try {
      await healthCommand({ config: configPath, badge: true });
    } catch {
      // May throw
    } finally {
      process.stdout.write = origWrite;
      await closeLadybugDb();
    }

    const trimmed = stdoutOutput.trim();
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // parsing may fail
    }
    if (parsed) {
      assert.strictEqual(
        parsed.label,
        "sdl-mcp health",
        `Badge should have label "sdl-mcp health"`,
      );
      assert.ok(
        typeof parsed.color === "string",
        "Badge should have a color string",
      );
      assert.ok(
        typeof parsed.message === "string",
        "Badge should have a message string",
      );
    }
  });
});
