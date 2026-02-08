import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../dist/config/loadConfig.js";

describe("loadConfig environment path resolution", () => {
  it("uses SDL_CONFIG when no explicit configPath is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdl-mcp-config-"));
    const configPath = join(dir, "sdlmcp.config.json");
    const oldEnv = process.env.SDL_CONFIG;

    try {
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            repos: [
              {
                repoId: "env-repo",
                rootPath: dir,
                ignore: [],
                languages: ["ts"],
                maxFileBytes: 1000,
              },
            ],
            dbPath: "./db-from-env.sqlite",
            policy: {
              maxWindowLines: 10,
              maxWindowTokens: 100,
              requireIdentifiers: true,
              allowBreakGlass: true,
            },
          },
          null,
          2,
        ),
      );

      process.env.SDL_CONFIG = configPath;
      const config = loadConfig();

      assert.strictEqual(config.dbPath, "./db-from-env.sqlite");
      assert.strictEqual(config.repos[0].repoId, "env-repo");
    } finally {
      if (oldEnv === undefined) {
        delete process.env.SDL_CONFIG;
      } else {
        process.env.SDL_CONFIG = oldEnv;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
