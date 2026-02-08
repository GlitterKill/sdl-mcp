#!/usr/bin/env node

import { parseArgs } from "util";
import type {
  CLIOptions,
  DoctorOptions,
  VersionOptions,
} from "./types.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { versionCommand } from "./commands/version.js";
import { indexCommand } from "./commands/index.js";
import { serveCommand } from "./commands/serve.js";
import {
  parseInitOptions,
  parseIndexOptions,
  parseServeOptions,
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

Examples:
  sdl-mcp init
  sdl-mcp doctor
  sdl-mcp index --watch
  sdl-mcp serve --stdio
  sdl-mcp serve --http --port 3000

For more information, visit: https://github.com/your-org/sdl-mcp
`);
}

main().catch((error) => {
  console.error(
    `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
