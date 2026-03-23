import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseSummaryOptions } from "../../dist/cli/argParsing.js";
import type { CLIOptions } from "../../dist/cli/types.js";

describe("CLI summary command", () => {
  const global: CLIOptions = {};

  describe("argument parsing", () => {
    it("requires a query", () => {
      assert.throws(
        () => parseSummaryOptions([], global, {}),
        /query/i,
      );
    });

    it("parses query from first positional argument", () => {
      const options = parseSummaryOptions(["auth module"], global, {});
      assert.strictEqual(options.query, "auth module");
    });

    it("defaults budget to 2000", () => {
      const options = parseSummaryOptions(["test"], global, {});
      assert.strictEqual(options.budget, 2000);
    });

    it("defaults format to markdown", () => {
      const options = parseSummaryOptions(["test"], global, {});
      assert.strictEqual(options.format, "markdown");
    });

    it("parses --short preset to 500 tokens", () => {
      const options = parseSummaryOptions(["test", "--short"], global, {});
      assert.strictEqual(options.budget, 500);
    });

    it("parses --medium preset to 2000 tokens", () => {
      const options = parseSummaryOptions(["test", "--medium"], global, {});
      assert.strictEqual(options.budget, 2000);
    });

    it("parses --long preset to 5000 tokens", () => {
      const options = parseSummaryOptions(["test", "--long"], global, {});
      assert.strictEqual(options.budget, 5000);
    });

    it("parses --budget with custom value", () => {
      const options = parseSummaryOptions(
        ["test", "--budget", "3000"],
        global,
        {},
      );
      assert.strictEqual(options.budget, 3000);
    });

    it("throws on invalid budget value", () => {
      assert.throws(
        () => parseSummaryOptions(["test", "--budget", "abc"], global, {}),
        /budget/i,
      );
    });

    it("throws on zero budget", () => {
      assert.throws(
        () => parseSummaryOptions(["test", "--budget", "0"], global, {}),
        /budget/i,
      );
    });

    it("throws on negative budget", () => {
      assert.throws(
        () => parseSummaryOptions(["test", "--budget", "-5"], global, {}),
        /budget/i,
      );
    });

    it("parses --format markdown", () => {
      const options = parseSummaryOptions(
        ["test", "--format", "markdown"],
        global,
        {},
      );
      assert.strictEqual(options.format, "markdown");
    });

    it("parses --format json", () => {
      const options = parseSummaryOptions(
        ["test", "--format", "json"],
        global,
        {},
      );
      assert.strictEqual(options.format, "json");
    });

    it("parses --format clipboard", () => {
      const options = parseSummaryOptions(
        ["test", "--format", "clipboard"],
        global,
        {},
      );
      assert.strictEqual(options.format, "clipboard");
    });

    it("throws on invalid format", () => {
      assert.throws(
        () => parseSummaryOptions(["test", "--format", "xml"], global, {}),
        /format/i,
      );
    });

    it("parses --scope symbol", () => {
      const options = parseSummaryOptions(
        ["test", "--scope", "symbol"],
        global,
        {},
      );
      assert.strictEqual(options.scope, "symbol");
    });

    it("parses --scope file", () => {
      const options = parseSummaryOptions(
        ["test", "--scope", "file"],
        global,
        {},
      );
      assert.strictEqual(options.scope, "file");
    });

    it("parses --scope task", () => {
      const options = parseSummaryOptions(
        ["test", "--scope", "task"],
        global,
        {},
      );
      assert.strictEqual(options.scope, "task");
    });

    it("throws on invalid scope", () => {
      assert.throws(
        () => parseSummaryOptions(["test", "--scope", "function"], global, {}),
        /scope/i,
      );
    });

    it("parses --output / -o", () => {
      const options = parseSummaryOptions(
        ["test", "-o", "/tmp/summary.md"],
        global,
        {},
      );
      assert.strictEqual(options.output, "/tmp/summary.md");
    });

    it("parses --repo for repo ID", () => {
      const options = parseSummaryOptions(
        ["test", "--repo", "my-repo"],
        global,
        {},
      );
      assert.strictEqual(options.repoId, "my-repo");
    });

    it("parses --repo-id for repo ID", () => {
      const options = parseSummaryOptions(
        ["test", "--repo-id", "my-repo"],
        global,
        {},
      );
      assert.strictEqual(options.repoId, "my-repo");
    });

    it("prefers parsed values for budget preset", () => {
      const options = parseSummaryOptions(["test"], global, {
        short: true,
      });
      assert.strictEqual(options.budget, 500);
    });

    it("prefers parsed values for format", () => {
      const options = parseSummaryOptions(["test"], global, {
        format: "json",
      });
      assert.strictEqual(options.format, "json");
    });

    it("prefers parsed values for scope", () => {
      const options = parseSummaryOptions(["test"], global, {
        scope: "file",
      });
      assert.strictEqual(options.scope, "file");
    });

    it("prefers parsed values for repo", () => {
      const options = parseSummaryOptions(["test"], global, {
        repo: "parsed-repo",
      });
      assert.strictEqual(options.repoId, "parsed-repo");
    });

    it("combines multiple options", () => {
      const options = parseSummaryOptions(
        ["search query", "--short", "--format", "json", "--scope", "task", "-o", "/tmp/out.json"],
        global,
        {},
      );
      assert.strictEqual(options.query, "search query");
      assert.strictEqual(options.budget, 500);
      assert.strictEqual(options.format, "json");
      assert.strictEqual(options.scope, "task");
      assert.strictEqual(options.output, "/tmp/out.json");
    });

    it("inherits global config option", () => {
      const g: CLIOptions = { config: "/path/to/config.json" };
      const options = parseSummaryOptions(["test"], g, {});
      assert.strictEqual(options.config, "/path/to/config.json");
    });
  });

  describe("command invocation", () => {
    let tempDir: string;
    let originalSDLConfig: string | undefined;
    let originalSDLConfigPath: string | undefined;
    let originalExit: typeof process.exit;
    let capturedStderr: string[];
    let originalLog: typeof console.log;
    let originalError: typeof console.error;

    beforeEach(() => {
      tempDir = join(tmpdir(), `sdl-mcp-summary-test-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });

      originalSDLConfig = process.env.SDL_CONFIG;
      originalSDLConfigPath = process.env.SDL_CONFIG_PATH;

      originalExit = process.exit;
      process.exit = ((code: number) => {
        throw new Error(`Process.exit(${code})`);
      }) as typeof process.exit;

      capturedStderr = [];
      originalLog = console.log;
      originalError = console.error;

      console.log = () => {};
      console.error = (...args: unknown[]) => {
        capturedStderr.push(args.map(String).join(" "));
      };
    });

    afterEach(() => {
      process.exit = originalExit;
      console.log = originalLog;
      console.error = originalError;

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

    it("rejects when no repository is configured", async () => {
      const configPath = join(tempDir, "sdlmcp.config.json");
      const ladybugPath = join(tempDir, "sdl-mcp-graph.lbug");

      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [],
          dbPath: join(tempDir, "sdlmcp.sqlite"),
          graphDatabase: { path: ladybugPath },
        }),
      );

      const { initLadybugDb, closeLadybugDb } = await import(
        "../../dist/db/ladybug.js"
      );
      const { summaryCommand } = await import(
        "../../dist/cli/commands/summary.js"
      );

      await initLadybugDb(ladybugPath);

      let exitCode: number | undefined;
      process.exit = ((code: number) => {
        exitCode = code;
        throw new Error(`exit(${code})`);
      }) as typeof process.exit;

      let thrownError: unknown;
      try {
        await summaryCommand({
          config: configPath,
          query: "test query",
        });
      } catch (e) {
        thrownError = e;
      } finally {
        process.exit = originalExit;
        await closeLadybugDb();
      }

      // Should either exit(1) or throw for empty repos
      assert.ok(
        exitCode === 1 || thrownError !== undefined,
        "Should exit(1) or throw when no repos configured",
      );
    });
  });
});
