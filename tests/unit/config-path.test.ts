import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";

import { resolveCliConfigPath } from "../../src/config/configPath.ts";

const originalEnv = {
  SDL_CONFIG: process.env.SDL_CONFIG,
  SDL_CONFIG_PATH: process.env.SDL_CONFIG_PATH,
  SDL_CONFIG_HOME: process.env.SDL_CONFIG_HOME,
};

let tempConfigHome: string | undefined;

afterEach(() => {
  for (const key of Object.keys(originalEnv) as Array<keyof typeof originalEnv>) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  if (tempConfigHome) {
    rmSync(tempConfigHome, { recursive: true, force: true });
    tempConfigHome = undefined;
  }
});

test("resolveCliConfigPath reads the repo-local config when running from package root", () => {
  delete process.env.SDL_CONFIG;
  delete process.env.SDL_CONFIG_PATH;
  tempConfigHome = resolve(tmpdir(), `sdl-mcp-config-path-${process.pid}-${Date.now()}`);
  mkdirSync(tempConfigHome, { recursive: true });
  process.env.SDL_CONFIG_HOME = tempConfigHome;

  const expected = resolve(process.cwd(), "config", "sdlmcp.config.json");

  assert.equal(resolveCliConfigPath(undefined, "read"), expected);
});

test("resolveCliConfigPath writes to the global config path by default", () => {
  delete process.env.SDL_CONFIG;
  delete process.env.SDL_CONFIG_PATH;
  tempConfigHome = resolve(tmpdir(), `sdl-mcp-config-write-${process.pid}-${Date.now()}`);
  mkdirSync(tempConfigHome, { recursive: true });
  process.env.SDL_CONFIG_HOME = tempConfigHome;

  assert.equal(
    resolveCliConfigPath(undefined, "write"),
    resolve(tempConfigHome, "sdlmcp.config.json"),
  );
});
