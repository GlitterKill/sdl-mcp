#!/usr/bin/env node

import { parseArgs } from "util";
import type { CLIOptions, DoctorOptions, VersionOptions } from "./types.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { versionCommand } from "./commands/version.js";
import { indexCommand } from "./commands/index.js";
import { serveCommand } from "./commands/serve.js";
import { exportCommand } from "./commands/export.js";
import { importCommand } from "./commands/import.js";
import { pullCommand } from "./commands/pull.js";
import { benchmarkCICommand } from "./commands/benchmark.js";
import {
  parseInitOptions,
  parseIndexOptions,
  parseServeOptions,
  parseExportOptions,
  parseImportOptions,
  parsePullOptions,
  parseBenchmarkOptions,
} from "./argParsing.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      config: { type: "string", short: "c" },
      "log-level": { type: "string" },
      "log-format": { type: "string" },
      languages: { type: "string" },
      client: { type: "string" },
      "repo-path": { type: "string" },
      force: { type: "boolean", short: "f" },
      watch: { type: "boolean", short: "w" },
      "repo-id": { type: "string" },
      stdio: { type: "boolean" },
      http: { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
      "version-id": { type: "string" },
      "commit-sha": { type: "string" },
      branch: { type: "string" },
      output: { type: "string", short: "o" },
      "artifact-path": { type: "string" },
      verify: { type: "boolean" },
      list: { type: "boolean" },
      fallback: { type: "boolean" },
      retries: { type: "string" },
      "baseline-path": { type: "string" },
      "threshold-path": { type: "string" },
      "update-baseline": { type: "boolean" },
      "skip-indexing": { type: "boolean" },
    },
  });

  if (values.help) {
    showHelp();
    process.exit(0);
  }

  if (values.version) {
    await versionCommand({});
    process.exit(0);
  }

  const global: CLIOptions = {
    config: values.config as string | undefined,
    logLevel: values["log-level"] as
      | "debug"
      | "info"
      | "warn"
      | "error"
      | undefined,
    logFormat: values["log-format"] as "json" | "pretty" | undefined,
  };

  const command = positionals[0];

  if (!command) {
    showHelp();
    process.exit(1);
  }

  switch (command) {
    case "init": {
      const options = parseInitOptions(
        positionals.slice(1),
        global,
        values as Record<string, unknown>,
      );
      await initCommand(options);
      break;
    }

    case "doctor": {
      const options = { ...global } as DoctorOptions;
      await doctorCommand(options);
      break;
    }

    case "version": {
      const options = { ...global } as VersionOptions;
      await versionCommand(options);
      break;
    }

    case "index": {
      const options = parseIndexOptions(
        positionals.slice(1),
        global,
        values as Record<string, unknown>,
      );
      await indexCommand(options);
      break;
    }

    case "serve": {
      const options = parseServeOptions(
        positionals.slice(1),
        global,
        values as Record<string, unknown>,
      );
      await serveCommand(options);
      break;
    }

    case "export": {
      const options = parseExportOptions(
        positionals.slice(1),
        global,
        values as Record<string, unknown>,
      );
      await exportCommand(options);
      break;
    }

    case "import": {
      const options = parseImportOptions(
        positionals.slice(1),
        global,
        values as Record<string, unknown>,
      );
      await importCommand(options);
      break;
    }

    case "pull": {
      const options = parsePullOptions(
        positionals.slice(1),
        global,
        values as Record<string, unknown>,
      );
      await pullCommand(options);
      break;
    }

    case "benchmark:ci": {
      const options = parseBenchmarkOptions(
        positionals.slice(1),
        global,
        values as Record<string, unknown>,
      );
      const exitCode = await benchmarkCICommand(options);
      process.exit(exitCode);
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("");
      showHelp();
      process.exit(1);
  }
}

function showHelp(): void {
  console.log(`
SDL-MCP - Symbol Delta Ledger MCP Server

Usage:
  sdl-mcp [global-options] <command> [command-options]

Commands:
  init              Initialize SDL-MCP configuration
  doctor            Validate SDL-MCP environment
  version           Show version information
  index             Index repositories (optional: --watch, --repo-id)
  serve             Start MCP server (default: stdio, optional: --http, --port, --host)
  export            Export indexed state as sync artifact
  import            Import indexed state from sync artifact
  pull              Pull latest state from artifact or fallback to full index
  benchmark:ci      Run CI benchmark with threshold evaluation

Global Options:
  -c, --config PATH     Path to configuration file
  --log-level LEVEL      Log level: debug, info, warn, error (default: info)
  --log-format FORMAT    Log format: json, pretty (default: pretty)
  -h, --help           Show this help message
  -v, --version        Show version

 Init Options:
    --client NAME         Client template: claude-code, codex, gemini, opencode
    --repo-path PATH      Repository root path (default: current directory)
    --languages LIST      Comma-separated languages: ts, tsx, js, jsx, py, go, java, cs, c, cpp, php, rs, kt, sh (default: all)
    -f, --force           Force overwrite existing configuration

 Index Options:
   -w, --watch          Watch for file changes
   --repo-id ID         Index specific repository by ID

 Serve Options:
   --stdio               Use stdio transport (default)
   --http               Use HTTP transport
   --port NUMBER         HTTP port (default: 3000)
   --host HOST          HTTP host (default: localhost)

 Export Options:
   --repo-id ID         Export specific repository by ID
   --version-id ID      Export specific version
   --commit-sha SHA     Link artifact to commit SHA
   --branch NAME        Link artifact to branch name
   -o, --output PATH    Output artifact path (default: .sdl-sync/)
   --list               List available artifacts

 Import Options:
   --artifact-path PATH  Path to artifact file (required)
   --repo-id ID         Target repository ID
   -f, --force          Force import even if repo_id mismatch
   --verify             Verify artifact integrity (default: true)

 Pull Options:
   --repo-id ID         Pull for specific repository by ID
   --version-id ID      Pull specific version
   --commit-sha SHA     Pull artifact matching commit SHA
   --fallback            Fallback to full index if artifact not found (default: true)
   --retries NUMBER     Max retry attempts (default:3)

 Benchmark:ci Options:
   --repo-id ID         Benchmark specific repository by ID
   --baseline-path PATH Path to baseline file (default: .benchmark/baseline.json)
   --threshold-path PATH Path to threshold config (default: config/benchmark.config.json)
   --out PATH           Output path for results (default: .benchmark/latest.json)
   --json               Output JSON results
   --update-baseline    Update baseline with current results
   --skip-indexing      Skip re-indexing, use existing data

 Examples:
   sdl-mcp init
   sdl-mcp doctor
   sdl-mcp index --watch
   sdl-mcp serve --stdio
   sdl-mcp serve --http --port 3000
   sdl-mcp export
   sdl-mcp export --list
   sdl-mcp import --artifact-path .sdl-sync/repo-xxx.sdl-artifact.json
   sdl-mcp pull
   sdl-mcp benchmark:ci
   sdl-mcp benchmark:ci --repo-id my-repo --json
   sdl-mcp benchmark:ci --update-baseline

For more information, visit: https://github.com/your-org/sdl-mcp
`);
}

main().catch((error) => {
  console.error(
    `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
