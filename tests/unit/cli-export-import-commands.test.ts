import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseExportOptions,
  parseImportOptions,
} from "../../src/cli/argParsing.js";
import type { CLIOptions } from "../../src/cli/types.js";

describe("CLI export command", () => {
  const global: CLIOptions = {};

  describe("argument parsing", () => {
    it("defaults to no options", () => {
      const options = parseExportOptions([], global, {});
      assert.strictEqual(options.repoId, undefined);
      assert.strictEqual(options.versionId, undefined);
      assert.strictEqual(options.commitSha, undefined);
      assert.strictEqual(options.branch, undefined);
      assert.strictEqual(options.output, undefined);
      assert.strictEqual(options.list, undefined);
    });

    it("parses --repo-id from args", () => {
      const options = parseExportOptions(
        ["--repo-id", "my-repo"],
        global,
        {},
      );
      assert.strictEqual(options.repoId, "my-repo");
    });

    it("parses --version-id from args", () => {
      const options = parseExportOptions(
        ["--version-id", "v1.0"],
        global,
        {},
      );
      assert.strictEqual(options.versionId, "v1.0");
    });

    it("parses --commit-sha from args", () => {
      const options = parseExportOptions(
        ["--commit-sha", "abc123"],
        global,
        {},
      );
      assert.strictEqual(options.commitSha, "abc123");
    });

    it("parses --branch from args", () => {
      const options = parseExportOptions(
        ["--branch", "feature/test"],
        global,
        {},
      );
      assert.strictEqual(options.branch, "feature/test");
    });

    it("parses --output / -o from args", () => {
      const options = parseExportOptions(
        ["-o", "/tmp/export.json"],
        global,
        {},
      );
      assert.strictEqual(options.output, "/tmp/export.json");
    });

    it("parses --list from args", () => {
      const options = parseExportOptions(["--list"], global, {});
      assert.strictEqual(options.list, true);
    });

    it("prefers parsed values over positional args", () => {
      const options = parseExportOptions([], global, {
        "repo-id": "values-repo",
        "version-id": "v2",
        "commit-sha": "def456",
        branch: "main",
        output: "/tmp/out",
        list: true,
      });
      assert.strictEqual(options.repoId, "values-repo");
      assert.strictEqual(options.versionId, "v2");
      assert.strictEqual(options.commitSha, "def456");
      assert.strictEqual(options.branch, "main");
      assert.strictEqual(options.output, "/tmp/out");
      assert.strictEqual(options.list, true);
    });

    it("throws when --repo-id has no value", () => {
      assert.throws(
        () => parseExportOptions(["--repo-id"], global, {}),
        /--repo-id requires a value/,
      );
    });

    it("throws when --version-id has no value", () => {
      assert.throws(
        () => parseExportOptions(["--version-id"], global, {}),
        /--version-id requires a value/,
      );
    });

    it("throws when --commit-sha has no value", () => {
      assert.throws(
        () => parseExportOptions(["--commit-sha"], global, {}),
        /--commit-sha requires a value/,
      );
    });

    it("throws when --branch has no value", () => {
      assert.throws(
        () => parseExportOptions(["--branch"], global, {}),
        /--branch requires a value/,
      );
    });

    it("throws when --output has no value", () => {
      assert.throws(
        () => parseExportOptions(["--output"], global, {}),
        /--output requires a value/,
      );
    });

    it("inherits global config option", () => {
      const g: CLIOptions = { config: "/path/to/config.json" };
      const options = parseExportOptions([], g, {});
      assert.strictEqual(options.config, "/path/to/config.json");
    });
  });

  describe("command invocation", { concurrency: 1 }, () => {
    let tempDir: string;
    let originalSDLConfig: string | undefined;
    let originalSDLConfigPath: string | undefined;
    let originalExit: typeof process.exit;

    before(() => {
      tempDir = join(tmpdir(), `sdl-mcp-export-test-${Date.now()}`);
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

    it("rejects when no repos configured and --list is used", async () => {
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
        "../../src/db/ladybug.js"
      );
      const { exportCommand } = await import(
        "../../src/cli/commands/export.js"
      );

      await initLadybugDb(ladybugPath);

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
        await exportCommand({ config: configPath, list: true });
      } catch (e) {
        thrownError = e;
      } finally {
        console.error = origError;
        console.log = origLog;
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

describe("CLI import command", () => {
  const global: CLIOptions = {};

  describe("argument parsing", () => {
    it("defaults to no options", () => {
      const options = parseImportOptions([], global, {});
      assert.strictEqual(options.artifactPath, undefined);
      assert.strictEqual(options.repoId, undefined);
      assert.strictEqual(options.force, undefined);
      assert.strictEqual(options.verify, undefined);
    });

    it("parses --artifact-path from args", () => {
      const options = parseImportOptions(
        ["--artifact-path", "/tmp/artifact.json"],
        global,
        {},
      );
      assert.strictEqual(options.artifactPath, "/tmp/artifact.json");
    });

    it("parses --repo-id from args", () => {
      const options = parseImportOptions(
        ["--repo-id", "my-repo"],
        global,
        {},
      );
      assert.strictEqual(options.repoId, "my-repo");
    });

    it("parses --force / -f from args", () => {
      const options = parseImportOptions(["--force"], global, {});
      assert.strictEqual(options.force, true);

      const optionsShort = parseImportOptions(["-f"], global, {});
      assert.strictEqual(optionsShort.force, true);
    });

    it("parses --verify from args", () => {
      const options = parseImportOptions(["--verify"], global, {});
      assert.strictEqual(options.verify, true);
    });

    it("prefers parsed values over positional args", () => {
      const options = parseImportOptions([], global, {
        "artifact-path": "/tmp/from-values.json",
        "repo-id": "values-repo",
        force: true,
        verify: true,
      });
      assert.strictEqual(options.artifactPath, "/tmp/from-values.json");
      assert.strictEqual(options.repoId, "values-repo");
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.verify, true);
    });

    it("throws when --artifact-path has no value", () => {
      assert.throws(
        () => parseImportOptions(["--artifact-path"], global, {}),
        /--artifact-path requires a value/,
      );
    });

    it("throws when --repo-id has no value", () => {
      assert.throws(
        () => parseImportOptions(["--repo-id"], global, {}),
        /--repo-id requires a value/,
      );
    });

    it("inherits global config option", () => {
      const g: CLIOptions = { config: "/path/to/config.json" };
      const options = parseImportOptions([], g, {});
      assert.strictEqual(options.config, "/path/to/config.json");
    });
  });

  describe("command invocation", { concurrency: 1 }, () => {
    let tempDir: string;
    let originalSDLConfig: string | undefined;
    let originalSDLConfigPath: string | undefined;
    let originalExit: typeof process.exit;

    before(() => {
      tempDir = join(tmpdir(), `sdl-mcp-import-test-${Date.now()}`);
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

    it("rejects when no artifact path is provided", async () => {
      const configPath = join(tempDir, "sdlmcp.config.json");
      const ladybugPath = join(tempDir, "sdl-mcp-graph.lbug");

      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [{ repoId: "test-repo", rootPath: tempDir }],
          dbPath: join(tempDir, "sdlmcp.sqlite"),
          graphDatabase: { path: ladybugPath },
        }),
      );

      const { initLadybugDb, closeLadybugDb } = await import(
        "../../src/db/ladybug.js"
      );
      const { importCommand } = await import(
        "../../src/cli/commands/import.js"
      );

      await initLadybugDb(ladybugPath);

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
        await importCommand({ config: configPath });
      } catch (e) {
        thrownError = e;
      } finally {
        console.error = origError;
        console.log = origLog;
        process.exit = originalExit;
        await closeLadybugDb();
      }

      // Should either exit(1) or throw for missing artifact path
      assert.ok(
        exitCode === 1 || thrownError !== undefined,
        "Should exit(1) or throw when no artifact path",
      );
      if (exitCode === 1) {
        assert.ok(
          errorOutput.includes("Artifact path is required"),
          `Should report artifact path required, got: ${errorOutput}`,
        );
      }
    });
  });
});
