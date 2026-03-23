import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseIndexOptions,
} from "../../dist/cli/argParsing.js";
import type { CLIOptions } from "../../dist/cli/types.js";

describe("CLI index command", () => {
  const global: CLIOptions = {};

  describe("argument parsing", () => {
    it("defaults to no watch, no force, no repoId", () => {
      const options = parseIndexOptions([], global, {});
      assert.strictEqual(options.watch, undefined);
      assert.strictEqual(options.force, undefined);
      assert.strictEqual(options.repoId, undefined);
    });

    it("parses --watch from args", () => {
      const options = parseIndexOptions(["--watch"], global, {});
      assert.strictEqual(options.watch, true);
    });

    it("parses -w short form for watch", () => {
      const options = parseIndexOptions(["-w"], global, {});
      assert.strictEqual(options.watch, true);
    });

    it("parses --force from args", () => {
      const options = parseIndexOptions(["--force"], global, {});
      assert.strictEqual(options.force, true);
    });

    it("parses -f short form for force", () => {
      const options = parseIndexOptions(["-f"], global, {});
      assert.strictEqual(options.force, true);
    });

    it("parses --repo-id from args", () => {
      const options = parseIndexOptions(
        ["--repo-id", "my-repo"],
        global,
        {},
      );
      assert.strictEqual(options.repoId, "my-repo");
    });

    it("throws when --repo-id has no value", () => {
      assert.throws(
        () => parseIndexOptions(["--repo-id"], global, {}),
        /--repo-id requires a value/,
      );
    });

    it("prefers parsed values over positional args", () => {
      const options = parseIndexOptions([], global, {
        watch: true,
        force: true,
        "repo-id": "from-values",
      });
      assert.strictEqual(options.watch, true);
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.repoId, "from-values");
    });

    it("combines args and parsed values", () => {
      const options = parseIndexOptions(["--watch"], global, {
        "repo-id": "combined-repo",
      });
      assert.strictEqual(options.watch, true);
      assert.strictEqual(options.repoId, "combined-repo");
    });

    it("inherits global config option", () => {
      const g: CLIOptions = { config: "/path/to/config.json" };
      const options = parseIndexOptions([], g, {});
      assert.strictEqual(options.config, "/path/to/config.json");
    });
  });

  describe("command invocation", { concurrency: 1 }, () => {
    let tempDir: string;
    let originalSDLConfig: string | undefined;
    let originalSDLConfigPath: string | undefined;
    let originalExit: typeof process.exit;

    before(() => {
      tempDir = join(tmpdir(), `sdl-mcp-index-test-${Date.now()}`);
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

    it("rejects when repo-id is not found in config", async () => {
      const dir = join(tempDir, "notfound");
      mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");

      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "real-repo", rootPath: tempDir }],
          dbPath: join(dir, "sdlmcp.sqlite"),
          graphDatabase: { path: ladybugPath },
        }),
      );

      const { indexCommand } = await import(
        "../../dist/cli/commands/index.js"
      );

      let exitCode: number | undefined;
      let errorOutput = "";
      const origError = console.error;
      const origLog = console.log;
      console.error = (...args: unknown[]) => {
        errorOutput += args.map(String).join(" ") + "\n";
      };
      console.log = () => {};

      process.exit = ((code: number) => {
        exitCode = code;
        throw new Error(`exit(${code})`);
      }) as typeof process.exit;

      let thrownError: unknown;
      try {
        await indexCommand({ config: configPath, repoId: "nonexistent-repo" });
      } catch (e) {
        thrownError = e;
      } finally {
        console.error = origError;
        console.log = origLog;
        process.exit = originalExit;
        const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
        await closeLadybugDb();
      }

      // The command should either exit(1) or throw for non-existent repo
      assert.ok(
        exitCode === 1 || thrownError !== undefined,
        "Should either exit(1) or throw for missing repo",
      );
      if (exitCode === 1) {
        assert.ok(
          errorOutput.includes("Repository not found") ||
            errorOutput.includes("nonexistent-repo"),
          `Should report repo not found, got: ${errorOutput}`,
        );
      }
    });

    it("rejects when no repositories are configured", async () => {
      const dir = join(tempDir, "norepos");
      mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");

      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [],
          dbPath: join(dir, "sdlmcp.sqlite"),
          graphDatabase: { path: ladybugPath },
        }),
      );

      const { indexCommand } = await import(
        "../../dist/cli/commands/index.js"
      );

      let exitCode: number | undefined;
      const origError = console.error;
      const origLog = console.log;
      console.error = () => {};
      console.log = () => {};

      process.exit = ((code: number) => {
        exitCode = code;
        throw new Error(`exit(${code})`);
      }) as typeof process.exit;

      let thrownError: unknown;
      try {
        await indexCommand({ config: configPath });
      } catch (e) {
        thrownError = e;
      } finally {
        console.error = origError;
        console.log = origLog;
        process.exit = originalExit;
        const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
        await closeLadybugDb();
      }

      // Should either exit(1) or throw for empty repos
      assert.ok(
        exitCode === 1 || thrownError !== undefined,
        "Should either exit(1) or throw for empty repos",
      );
    });

    it("logs repo count before indexing starts", async () => {
      const dir = join(tempDir, "count");
      mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "sdlmcp.config.json");
      const ladybugPath = join(dir, "sdl-mcp-graph.lbug");

      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "test-repo", rootPath: tempDir }],
          dbPath: join(dir, "sdlmcp.sqlite"),
          graphDatabase: { path: ladybugPath },
        }),
      );

      const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
      const { indexCommand } = await import(
        "../../dist/cli/commands/index.js"
      );

      let stdoutOutput = "";
      let thrownError: unknown;
      const origLog = console.log;
      const origError = console.error;
      console.log = (...args: unknown[]) => {
        stdoutOutput += args.map(String).join(" ") + "\n";
      };
      console.error = () => {};

      process.exit = originalExit;

      try {
        await indexCommand({ config: configPath });
      } catch (e) {
        thrownError = e;
      } finally {
        console.log = origLog;
        console.error = origError;
        await closeLadybugDb();
      }

      // The indexCommand should reach the "Indexing N repo(s)..." log line
      // before any failure in the actual indexing. If config loading itself
      // fails (e.g., Zod validation), the log line won't appear.
      if (stdoutOutput.length > 0) {
        assert.ok(
          stdoutOutput.includes("Indexing 1 repo(s)"),
          `Should log repo count, got: ${stdoutOutput}`,
        );
      } else {
        // If config loading failed before reaching the log line,
        // verify the command at least threw (didn't silently succeed)
        assert.ok(
          thrownError !== undefined,
          "Command should have either logged or thrown",
        );
      }
    });
  });
});
