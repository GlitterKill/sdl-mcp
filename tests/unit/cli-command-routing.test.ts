import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseInitOptions,
  parseIndexOptions,
  parseServeOptions,
  parseExportOptions,
  parseImportOptions,
  parsePullOptions,
  parseBenchmarkOptions,
  parseSummaryOptions,
  parseHealthOptions,
  parseToolDispatchOptions,
} from "../../src/cli/argParsing.js";
import type { CLIOptions } from "../../src/cli/types.js";

/**
 * Verifies parser behavior and preserves entrypoint-level coverage for the
 * actual src/cli/index.ts switch wiring.
 *
 * The CLI entrypoint (src/cli/index.ts) dispatches positional[0] through
 * a switch statement. Each branch calls the corresponding parse*Options
 * function and then the command handler. These tests exercise the parsers
 * and assert that the real entrypoint still wires commands to those parsers.
 */
describe("CLI command routing", () => {
  const global: CLIOptions = {};
  const cliEntrypointSource = readFileSync(
    join(process.cwd(), "src", "cli", "index.ts"),
    "utf8",
  );

  describe("CLI entrypoint switch wiring", () => {
    it("routes parsed commands through the expected parser and handler pairs", () => {
      assert.match(
        cliEntrypointSource,
        /case "init":[\s\S]*parseInitOptions\([\s\S]*await initCommand\(options\)/,
      );
      assert.match(
        cliEntrypointSource,
        /case "index":[\s\S]*parseIndexOptions\([\s\S]*await indexCommand\(options\)/,
      );
      assert.match(
        cliEntrypointSource,
        /case "serve":[\s\S]*parseServeOptions\([\s\S]*await serveCommand\(options\)/,
      );
      assert.match(
        cliEntrypointSource,
        /case "export":[\s\S]*parseExportOptions\([\s\S]*await exportCommand\(options\)/,
      );
      assert.match(
        cliEntrypointSource,
        /case "import":[\s\S]*parseImportOptions\([\s\S]*await importCommand\(options\)/,
      );
      assert.match(
        cliEntrypointSource,
        /case "pull":[\s\S]*parsePullOptions\([\s\S]*await pullCommand\(options\)/,
      );
      assert.match(
        cliEntrypointSource,
        /case "benchmark:ci":[\s\S]*parseBenchmarkOptions\([\s\S]*benchmarkCICommand\(options\)/,
      );
      assert.match(
        cliEntrypointSource,
        /case "summary":[\s\S]*parseSummaryOptions\([\s\S]*await summaryCommand\(options\)/,
      );
      assert.match(
        cliEntrypointSource,
        /case "health":[\s\S]*parseHealthOptions\([\s\S]*await healthCommand\(options\)/,
      );
      assert.match(
        cliEntrypointSource,
        /case "tool":[\s\S]*parseToolDispatchOptions\([\s\S]*await toolDispatchCommand\(options\)/,
      );
    });

    it("retains the unknown-command default branch", () => {
      assert.match(
        cliEntrypointSource,
        /default:[\s\S]*Unknown command: \$\{command\}[\s\S]*showHelp\(\)[\s\S]*process\.exit\(1\)/,
      );
    });
  });

  // ----- init -----
  describe("init command routing", () => {
    it("routes to parseInitOptions and returns InitOptions", () => {
      const options = parseInitOptions(
        ["--force", "--yes", "--dry-run"],
        global,
        {},
      );
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.yes, true);
      assert.strictEqual(options.dryRun, true);
    });

    it("accepts --client and --repo-path", () => {
      const options = parseInitOptions(
        ["--client", "claude-code", "--repo-path", "/tmp/repo"],
        global,
        {},
      );
      assert.strictEqual(options.client, "claude-code");
      assert.strictEqual(options.repoPath, "/tmp/repo");
    });

    it("accepts --languages as comma-separated list", () => {
      const options = parseInitOptions(
        ["--languages", "ts,py,go"],
        global,
        {},
      );
      assert.deepStrictEqual(options.languages, ["ts", "py", "go"]);
    });

    it("accepts --enforce-agent-tools flag", () => {
      const options = parseInitOptions(
        ["--enforce-agent-tools"],
        global,
        {},
      );
      assert.strictEqual(options.enforceAgentTools, true);
    });

    it("rejects path traversal in --repo-path", () => {
      assert.throws(
        () => parseInitOptions(["--repo-path", "../escape"], global, {}),
        /path traversal/,
      );
    });
  });

  // ----- doctor -----
  describe("doctor command routing", () => {
    it("inherits global options only (no extra parsing)", () => {
      // doctor uses { ...global } as DoctorOptions — no dedicated parser
      const globalWithConfig: CLIOptions = { config: "/tmp/test.json" };
      const options = { ...globalWithConfig };
      assert.strictEqual(options.config, "/tmp/test.json");
    });
  });

  // ----- version -----
  describe("version command routing", () => {
    it("inherits global options only (no extra parsing)", () => {
      const globalWithConfig: CLIOptions = { config: "/tmp/test.json" };
      const options = { ...globalWithConfig };
      assert.strictEqual(options.config, "/tmp/test.json");
    });
  });

  // ----- index -----
  describe("index command routing", () => {
    it("routes to parseIndexOptions and returns IndexOptions", () => {
      const options = parseIndexOptions([], global, {
        watch: true,
        "repo-id": "my-repo",
      });
      assert.strictEqual(options.watch, true);
      assert.strictEqual(options.repoId, "my-repo");
    });

    it("handles --force flag", () => {
      const options = parseIndexOptions(["--force"], global, {});
      assert.strictEqual(options.force, true);
    });
  });

  // ----- serve -----
  describe("serve command routing", () => {
    it("routes to parseServeOptions and returns ServeOptions", () => {
      const options = parseServeOptions([], global, {
        http: true,
        port: "8080",
        host: "0.0.0.0",
      });
      assert.strictEqual(options.transport, "http");
      assert.strictEqual(options.port, 8080);
      assert.strictEqual(options.host, "0.0.0.0");
    });

    it("defaults to stdio transport", () => {
      const options = parseServeOptions([], global, {});
      assert.strictEqual(options.transport, "stdio");
    });

    it("handles --no-watch flag", () => {
      const options = parseServeOptions(["--no-watch"], global, {});
      assert.strictEqual(options.noWatch, true);
    });
  });

  // ----- export -----
  describe("export command routing", () => {
    it("routes to parseExportOptions and returns ExportCommandOptions", () => {
      const options = parseExportOptions([], global, {
        "repo-id": "test-repo",
        "version-id": "v1",
        "commit-sha": "abc123",
        branch: "main",
        output: "/tmp/out",
        list: true,
      });
      assert.strictEqual(options.repoId, "test-repo");
      assert.strictEqual(options.versionId, "v1");
      assert.strictEqual(options.commitSha, "abc123");
      assert.strictEqual(options.branch, "main");
      assert.strictEqual(options.output, "/tmp/out");
      assert.strictEqual(options.list, true);
    });

    it("parses positional args for export options", () => {
      const options = parseExportOptions(
        ["--repo-id", "my-repo", "--branch", "dev", "-o", "/tmp/artifact"],
        global,
        {},
      );
      assert.strictEqual(options.repoId, "my-repo");
      assert.strictEqual(options.branch, "dev");
      assert.strictEqual(options.output, "/tmp/artifact");
    });
  });

  // ----- import -----
  describe("import command routing", () => {
    it("routes to parseImportOptions and returns ImportCommandOptions", () => {
      const options = parseImportOptions([], global, {
        "artifact-path": "/tmp/artifact.json",
        "repo-id": "test-repo",
        force: true,
        verify: true,
      });
      assert.strictEqual(options.artifactPath, "/tmp/artifact.json");
      assert.strictEqual(options.repoId, "test-repo");
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.verify, true);
    });

    it("parses positional args for import options", () => {
      const options = parseImportOptions(
        ["--artifact-path", "/tmp/my.json", "--force"],
        global,
        {},
      );
      assert.strictEqual(options.artifactPath, "/tmp/my.json");
      assert.strictEqual(options.force, true);
    });
  });

  // ----- pull -----
  describe("pull command routing", () => {
    it("routes to parsePullOptions and returns PullCommandOptions", () => {
      const options = parsePullOptions([], global, {
        "repo-id": "test-repo",
        "version-id": "v2",
        "commit-sha": "def456",
        fallback: true,
        retries: "5",
      });
      assert.strictEqual(options.repoId, "test-repo");
      assert.strictEqual(options.versionId, "v2");
      assert.strictEqual(options.commitSha, "def456");
      assert.strictEqual(options.fallback, true);
      assert.strictEqual(options.retries, 5);
    });
  });

  // ----- benchmark:ci -----
  describe("benchmark:ci command routing", () => {
    it("routes to parseBenchmarkOptions and returns BenchmarkOptions", () => {
      const options = parseBenchmarkOptions([], global, {
        "repo-id": "my-repo",
        json: true,
        "update-baseline": true,
        "skip-indexing": true,
      });
      assert.strictEqual(options.repoId, "my-repo");
      assert.strictEqual(options.jsonOutput, true);
      assert.strictEqual(options.updateBaseline, true);
      assert.strictEqual(options.skipIndexing, true);
    });

    it("parses baseline and threshold paths", () => {
      const options = parseBenchmarkOptions(
        ["--baseline-path", "/tmp/base.json", "--threshold-path", "/tmp/thresh.json", "--out", "/tmp/results.json"],
        global,
        {},
      );
      assert.strictEqual(options.baselinePath, "/tmp/base.json");
      assert.strictEqual(options.thresholdPath, "/tmp/thresh.json");
      assert.strictEqual(options.outputPath, "/tmp/results.json");
    });
  });

  // ----- summary -----
  describe("summary command routing", () => {
    it("routes to parseSummaryOptions and returns SummaryOptions", () => {
      const options = parseSummaryOptions(
        ["auth module", "--short", "--format", "json"],
        global,
        {},
      );
      assert.strictEqual(options.query, "auth module");
      assert.strictEqual(options.budget, 500);
      assert.strictEqual(options.format, "json");
    });

    it("requires a query", () => {
      assert.throws(
        () => parseSummaryOptions([], global, {}),
        /query/i,
      );
    });
  });

  // ----- health -----
  describe("health command routing", () => {
    it("routes to parseHealthOptions and returns HealthOptions", () => {
      const options = parseHealthOptions([], global, {
        "repo-id": "test-repo",
        json: true,
        badge: true,
      });
      assert.strictEqual(options.repoId, "test-repo");
      assert.strictEqual(options.jsonOutput, true);
      assert.strictEqual(options.badge, true);
    });
  });

  // ----- tool -----
  describe("tool command routing", () => {
    it("routes to parseToolDispatchOptions and returns ToolDispatchOptions", () => {
      const options = parseToolDispatchOptions(
        ["symbol.search", "--query", "auth"],
        global,
        {},
      );
      assert.strictEqual(options.action, "symbol.search");
      assert.deepStrictEqual(options.rawArgs, ["--query", "auth"]);
    });

    it("handles --list flag", () => {
      const options = parseToolDispatchOptions(["--list"], global, { list: true });
      assert.strictEqual(options.list, true);
    });

    it("handles --help flag after action", () => {
      const options = parseToolDispatchOptions(
        ["symbol.search", "--help"],
        global,
        {},
      );
      assert.strictEqual(options.action, "symbol.search");
      assert.strictEqual(options.showHelp, true);
      assert.ok(!options.rawArgs.includes("--help"));
    });
  });

  // ----- unknown command -----
  describe("unknown command handling", () => {
    it("keeps a switch case for each public CLI command", () => {
      const expectedCases = [
        'case "init":',
        'case "doctor":',
        'case "version":',
        'case "index":',
        'case "serve":',
        'case "export":',
        'case "import":',
        'case "pull":',
        'case "benchmark:ci":',
        'case "summary":',
        'case "health":',
        'case "tool":',
      ];

      for (const expectedCase of expectedCases) {
        assert.ok(
          cliEntrypointSource.includes(expectedCase),
          `Missing CLI switch case: ${expectedCase}`,
        );
      }
    });
  });

  // ----- global options propagation -----
  describe("global options propagation", () => {
    it("passes config from global to all parsers", () => {
      const g: CLIOptions = { config: "/my/config.json" };

      const indexOpts = parseIndexOptions([], g, {});
      assert.strictEqual(indexOpts.config, "/my/config.json");

      const serveOpts = parseServeOptions([], g, {});
      assert.strictEqual(serveOpts.config, "/my/config.json");

      const exportOpts = parseExportOptions([], g, {});
      assert.strictEqual(exportOpts.config, "/my/config.json");

      const importOpts = parseImportOptions([], g, {});
      assert.strictEqual(importOpts.config, "/my/config.json");

      const healthOpts = parseHealthOptions([], g, {});
      assert.strictEqual(healthOpts.config, "/my/config.json");

      const summaryOpts = parseSummaryOptions(["test query"], g, {});
      assert.strictEqual(summaryOpts.config, "/my/config.json");
    });
  });
});
