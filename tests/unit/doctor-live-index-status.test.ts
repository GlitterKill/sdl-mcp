import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeKuzuDb, getKuzuConn, initKuzuDb } from "../../src/db/kuzu.js";
import * as kuzuDb from "../../src/db/kuzu-queries.js";
import { handleBufferPush } from "../../src/mcp/tools/buffer.js";
import {
  resetDefaultLiveIndexCoordinator,
  waitForDefaultLiveIndexIdle,
} from "../../src/live-index/coordinator.js";

describe("doctor command - live index runtime health", () => {
  let tempDir = "";
  let configPath = "";
  let kuzuPath = "";
  let originalExit: typeof process.exit;
  let originalSDLConfig: string | undefined;
  let originalSDLConfigPath: string | undefined;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `sdl-mcp-doctor-live-index-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "example.ts"), "export const value = 1;\n");

    configPath = join(tempDir, "sdlmcp.config.json");
    kuzuPath = join(tempDir, "graph.kuzu");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [{ repoId: "doctor-live-repo", rootPath: tempDir }],
        graphDatabase: { path: kuzuPath },
        policy: {},
        liveIndex: {
          enabled: true,
          debounceMs: 75,
          idleCheckpointMs: 15_000,
          maxDraftFiles: 200,
          reconcileConcurrency: 1,
          clusterRefreshThreshold: 25,
        },
      }),
    );

    originalSDLConfig = process.env.SDL_CONFIG;
    originalSDLConfigPath = process.env.SDL_CONFIG_PATH;
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    originalExit = process.exit;
    process.exit = ((code: number) => {
      throw new Error(`Process.exit(${code})`);
    }) as typeof process.exit;

    await waitForDefaultLiveIndexIdle();
    resetDefaultLiveIndexCoordinator();
    await closeKuzuDb();
    await initKuzuDb(kuzuPath);
    const conn = await getKuzuConn();
    await kuzuDb.upsertRepo(conn, {
      repoId: "doctor-live-repo",
      rootPath: tempDir,
      configJson: JSON.stringify({
        repoId: "doctor-live-repo",
        rootPath: tempDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
      }),
      createdAt: "2026-03-07T12:00:00.000Z",
    });
  });

  afterEach(async () => {
    process.exit = originalExit;
    await waitForDefaultLiveIndexIdle();
    resetDefaultLiveIndexCoordinator();
    await closeKuzuDb();

    if (originalSDLConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = originalSDLConfig;
    if (originalSDLConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = originalSDLConfigPath;

    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports overlay counts and checkpoint state", async () => {
    await handleBufferPush({
      repoId: "doctor-live-repo",
      eventType: "change",
      filePath: "src/example.ts",
      content: "export const renamed = 2;\n",
      language: "typescript",
      version: 2,
      dirty: true,
      timestamp: "2026-03-07T12:05:00.000Z",
    });

    // Wait for debounced parse to complete so overlay state is stable
    // and KuzuDB is not accessed concurrently during doctorCommand
    await waitForDefaultLiveIndexIdle();

    const { doctorCommand } = await import("../../src/cli/commands/doctor.js");
    let output = "";
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output += `${String(message ?? "")}\n`;
    };

    try {
      await doctorCommand({ config: configPath });
    } catch {
      // Other doctor warnings are acceptable for this test.
    } finally {
      console.log = originalLog;
    }

    assert.match(output, /Live index runtime/i);
    assert.match(output, /pendingBuffers=1/i);
    assert.match(output, /dirtyBuffers=1/i);
    assert.match(output, /checkpointPending=false/i);
  });
});
