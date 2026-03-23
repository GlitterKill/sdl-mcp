import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("doctor command - call resolution capabilities", () => {
  let tempDir: string;
  let originalExit: typeof process.exit;
  let originalSDLConfig: string | undefined;
  let originalSDLConfigPath: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `sdl-mcp-doctor-capabilities-${Date.now()}`);
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

    rmSync(tempDir, { recursive: true, force: true });
  });

  async function runDoctorWithConfig(
    policy: Record<string, unknown>,
  ): Promise<string> {
    const configPath = join(tempDir, "sdlmcp.config.json");
    const ladybugPath = join(tempDir, "sdl-mcp-graph.lbug");

    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [{ repoId: "test", rootPath: tempDir }],
        graphDatabase: { path: ladybugPath },
        policy,
      }),
    );

    const { initLadybugDb, closeLadybugDb } =
      await import("../../dist/db/ladybug.js");
    const { doctorCommand } = await import("../../dist/cli/commands/doctor.js");
    await initLadybugDb(ladybugPath);

    let output = "";
    const originalLog = console.log;
    console.log = (msg?: unknown) => {
      output += `${String(msg ?? "")}\n`;
    };

    try {
      await doctorCommand({ config: configPath });
    } finally {
      console.log = originalLog;
      await closeLadybugDb();
    }

    return output;
  }

  it("reports pass2 resolvers, schema metadata, and request-only filtering by default", async () => {
    const output = await runDoctorWithConfig({});

    assert.match(output, /Call resolution capabilities/i);
    assert.match(output, /pass2-ts/i);
    assert.match(output, /pass2-go/i);
    assert.match(output, /pass2-java/i);
    assert.match(output, /pass2-php/i);
    assert.match(output, /pass2-python/i);
    assert.match(output, /pass2-csharp/i);
    assert.match(output, /pass2-kotlin/i);
    assert.match(output, /pass2-rust/i);
    assert.match(output, /pass2-cpp/i);
    assert.match(output, /pass2-c/i);
    assert.match(output, /pass2-shell/i);
    assert.match(output, /schema v6/i);
    assert.match(
      output,
      /confidence, resolution, resolverId, resolutionPhase/i,
    );
    assert.match(output, /request-only/i);
  });

  it("reports policy-default confidence filtering when configured", async () => {
    const output = await runDoctorWithConfig({
      defaultMinCallConfidence: 0.85,
    });

    assert.match(output, /Call resolution capabilities/i);
    assert.match(output, /policy default/i);
    assert.match(output, /0\.85/);
  });
});
