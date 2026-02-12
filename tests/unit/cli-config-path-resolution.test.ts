import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCliConfigPath } from "../../dist/config/configPath.js";

describe("CLI config path resolution", () => {
  it("prefers explicit config path over environment", () => {
    const oldConfig = process.env.SDL_CONFIG;
    const oldConfigPath = process.env.SDL_CONFIG_PATH;

    try {
      process.env.SDL_CONFIG = "/tmp/env-config.json";
      process.env.SDL_CONFIG_PATH = "/tmp/env-config-path.json";

      const resolved = resolveCliConfigPath("./custom/sdlmcp.config.json");
      assert.strictEqual(resolved, resolve("./custom/sdlmcp.config.json"));
    } finally {
      if (oldConfig === undefined) {
        delete process.env.SDL_CONFIG;
      } else {
        process.env.SDL_CONFIG = oldConfig;
      }

      if (oldConfigPath === undefined) {
        delete process.env.SDL_CONFIG_PATH;
      } else {
        process.env.SDL_CONFIG_PATH = oldConfigPath;
      }
    }
  });

  it("uses SDL_CONFIG when no explicit config path is provided", () => {
    const oldConfig = process.env.SDL_CONFIG;
    const oldConfigPath = process.env.SDL_CONFIG_PATH;

    try {
      const envPath = resolve("./tmp/env/sdlmcp.config.json");
      process.env.SDL_CONFIG = envPath;
      delete process.env.SDL_CONFIG_PATH;

      const resolved = resolveCliConfigPath();
      assert.strictEqual(resolved, envPath);
    } finally {
      if (oldConfig === undefined) {
        delete process.env.SDL_CONFIG;
      } else {
        process.env.SDL_CONFIG = oldConfig;
      }

      if (oldConfigPath === undefined) {
        delete process.env.SDL_CONFIG_PATH;
      } else {
        process.env.SDL_CONFIG_PATH = oldConfigPath;
      }
    }
  });

  it("uses SDL_CONFIG_HOME default path in write mode", () => {
    const oldConfig = process.env.SDL_CONFIG;
    const oldConfigPath = process.env.SDL_CONFIG_PATH;
    const oldConfigHome = process.env.SDL_CONFIG_HOME;
    const configHome = mkdtempSync(join(tmpdir(), "sdl-config-home-"));

    try {
      delete process.env.SDL_CONFIG;
      delete process.env.SDL_CONFIG_PATH;
      process.env.SDL_CONFIG_HOME = configHome;

      const resolved = resolveCliConfigPath(undefined, "write");
      assert.strictEqual(resolved, resolve(configHome, "sdlmcp.config.json"));
    } finally {
      if (oldConfig === undefined) {
        delete process.env.SDL_CONFIG;
      } else {
        process.env.SDL_CONFIG = oldConfig;
      }

      if (oldConfigPath === undefined) {
        delete process.env.SDL_CONFIG_PATH;
      } else {
        process.env.SDL_CONFIG_PATH = oldConfigPath;
      }

      if (oldConfigHome === undefined) {
        delete process.env.SDL_CONFIG_HOME;
      } else {
        process.env.SDL_CONFIG_HOME = oldConfigHome;
      }

      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it("prefers cwd config path over global config path in read mode", () => {
    const oldCwd = process.cwd();
    const oldConfig = process.env.SDL_CONFIG;
    const oldConfigPath = process.env.SDL_CONFIG_PATH;
    const oldConfigHome = process.env.SDL_CONFIG_HOME;

    const workspace = mkdtempSync(join(tmpdir(), "sdl-config-cwd-priority-"));
    const configDir = join(workspace, "config");
    const cwdConfigPath = join(configDir, "sdlmcp.config.json");
    const configHome = mkdtempSync(join(tmpdir(), "sdl-config-home-with-global-"));
    const globalConfigPath = join(configHome, "sdlmcp.config.json");

    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(cwdConfigPath, "{}");
      writeFileSync(globalConfigPath, "{}");
      process.chdir(workspace);

      delete process.env.SDL_CONFIG;
      delete process.env.SDL_CONFIG_PATH;
      process.env.SDL_CONFIG_HOME = configHome;

      const resolved = resolveCliConfigPath(undefined, "read");
      assert.strictEqual(resolved, resolve(cwdConfigPath));
    } finally {
      process.chdir(oldCwd);

      if (oldConfig === undefined) {
        delete process.env.SDL_CONFIG;
      } else {
        process.env.SDL_CONFIG = oldConfig;
      }

      if (oldConfigPath === undefined) {
        delete process.env.SDL_CONFIG_PATH;
      } else {
        process.env.SDL_CONFIG_PATH = oldConfigPath;
      }

      if (oldConfigHome === undefined) {
        delete process.env.SDL_CONFIG_HOME;
      } else {
        process.env.SDL_CONFIG_HOME = oldConfigHome;
      }

      rmSync(workspace, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it("falls back to cwd config path in read mode when global config is absent", () => {
    const oldCwd = process.cwd();
    const oldConfig = process.env.SDL_CONFIG;
    const oldConfigPath = process.env.SDL_CONFIG_PATH;
    const oldConfigHome = process.env.SDL_CONFIG_HOME;

    const workspace = mkdtempSync(join(tmpdir(), "sdl-config-cwd-"));
    const configDir = join(workspace, "config");
    const configPath = join(configDir, "sdlmcp.config.json");
    const emptyHome = mkdtempSync(join(tmpdir(), "sdl-config-home-empty-"));

    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, "{}");
      process.chdir(workspace);

      delete process.env.SDL_CONFIG;
      delete process.env.SDL_CONFIG_PATH;
      process.env.SDL_CONFIG_HOME = emptyHome;

      const resolved = resolveCliConfigPath(undefined, "read");
      assert.strictEqual(resolved, resolve(configPath));
    } finally {
      process.chdir(oldCwd);

      if (oldConfig === undefined) {
        delete process.env.SDL_CONFIG;
      } else {
        process.env.SDL_CONFIG = oldConfig;
      }

      if (oldConfigPath === undefined) {
        delete process.env.SDL_CONFIG_PATH;
      } else {
        process.env.SDL_CONFIG_PATH = oldConfigPath;
      }

      if (oldConfigHome === undefined) {
        delete process.env.SDL_CONFIG_HOME;
      } else {
        process.env.SDL_CONFIG_HOME = oldConfigHome;
      }

      rmSync(workspace, { recursive: true, force: true });
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});
