import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { join, resolve } from "path";

import { resolveGraphDbPath } from "../../src/db/initGraphDb.js";

describe("resolveGraphDbPath", () => {
  let originalGraphDbPath: string | undefined;
  let originalGraphDbDir: string | undefined;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    originalGraphDbPath = process.env.SDL_GRAPH_DB_PATH;
    originalGraphDbDir = process.env.SDL_GRAPH_DB_DIR;
    originalDbPath = process.env.SDL_DB_PATH;
    delete process.env.SDL_GRAPH_DB_PATH;
    delete process.env.SDL_GRAPH_DB_DIR;
    delete process.env.SDL_DB_PATH;
  });

  afterEach(() => {
    if (originalGraphDbPath === undefined) {
      delete process.env.SDL_GRAPH_DB_PATH;
    } else {
      process.env.SDL_GRAPH_DB_PATH = originalGraphDbPath;
    }

    if (originalGraphDbDir === undefined) {
      delete process.env.SDL_GRAPH_DB_DIR;
    } else {
      process.env.SDL_GRAPH_DB_DIR = originalGraphDbDir;
    }

    if (originalDbPath === undefined) {
      delete process.env.SDL_DB_PATH;
    } else {
      process.env.SDL_DB_PATH = originalDbPath;
    }
  });

  it("uses a .kuzu file by default", () => {
    const configPath = resolve("C:/tmp/sdlmcp.config.json");
    const resolved = resolveGraphDbPath(
      {
        repos: [{ repoId: "test", rootPath: "." }],
        policy: { maxWindowLines: 180, maxWindowTokens: 1400 },
      },
      configPath,
    );

    assert.strictEqual(resolved, resolve("C:/tmp/sdl-mcp-graph.kuzu"));
  });

  it("maps a legacy directory-style graph path to a Kuzu file inside that directory", () => {
    const configPath = resolve("C:/tmp/sdlmcp.config.json");
    const resolved = resolveGraphDbPath(
      {
        repos: [{ repoId: "test", rootPath: "." }],
        graphDatabase: { path: "./data/sdl-mcp-graph" },
        policy: { maxWindowLines: 180, maxWindowTokens: 1400 },
      },
      configPath,
    );

    assert.strictEqual(
      resolved,
      resolve(join("data", "sdl-mcp-graph", "sdl-mcp-graph.kuzu")),
    );
  });

  it("preserves an explicit .kuzu file path", () => {
    const configPath = resolve("C:/tmp/sdlmcp.config.json");
    const resolved = resolveGraphDbPath(
      {
        repos: [{ repoId: "test", rootPath: "." }],
        graphDatabase: { path: "./data/custom-graph.kuzu" },
        policy: { maxWindowLines: 180, maxWindowTokens: 1400 },
      },
      configPath,
    );

    assert.strictEqual(resolved, resolve(join("data", "custom-graph.kuzu")));
  });
});
