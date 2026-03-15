/**
 * Core CLI tool dispatcher — invokes MCP tool handlers directly without
 * an MCP server, transport, or SDK dependency.
 *
 * Usage:
 *   sdl-mcp tool <action> [flags]
 *   sdl-mcp tool --list
 *   sdl-mcp tool <action> --help
 *   echo '{"repoId":"x"}' | sdl-mcp tool symbol.search --query "foo"
 */

import { resolve } from "path";
import { parseArgs } from "util";
import type { ToolDispatchOptions } from "../types.js";
import { activateCliConfigPath } from "../../config/configPath.js";
import { loadConfig } from "../../config/loadConfig.js";
import { initGraphDb } from "../../db/initGraphDb.js";
import { createActionMap } from "../../gateway/router.js";
import {
  ACTION_DEFINITIONS,
  ACTION_MAP,
  ALL_ACTION_NAMES,
} from "./tool-actions.js";
import type { ActionDefinition } from "./tool-actions.js";
import { parseToolArgs, buildParseArgsOptions } from "./tool-arg-parser.js";
import { formatOutput, formatError, detectOutputFormat } from "./tool-output.js";

/**
 * Resolve repoId from options, config, or cwd.
 * Same logic as summary.ts / health.ts.
 */
export function resolveRepoId(
  explicit: string | undefined,
  repos: Array<{ repoId: string; rootPath: string }>,
): string | undefined {
  if (explicit) return explicit;

  // Try to match cwd to a configured repo
  const cwd = resolve(process.cwd()).toLowerCase();
  const matched = repos.find((repo) => {
    const root = resolve(repo.rootPath).toLowerCase();
    return cwd.startsWith(root);
  });
  if (matched) return matched.repoId;

  // Single configured repo fallback
  if (repos.length === 1) return repos[0].repoId;

  return undefined;
}

/**
 * Read JSON from stdin if it's not a TTY (piped input).
 */
async function readStdinJson(): Promise<Record<string, unknown> | undefined> {
  if (process.stdin.isTTY) return undefined;

  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      if (!data.trim()) {
        resolve(undefined);
        return;
      }
      try {
        const parsed = JSON.parse(data.trim());
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          resolve(parsed as Record<string, unknown>);
        } else {
          process.stderr.write("Warning: stdin JSON must be an object, ignoring\n");
          resolve(undefined);
        }
      } catch {
        process.stderr.write("Warning: stdin is not valid JSON, ignoring\n");
        resolve(undefined);
      }
    });
    process.stdin.on("error", () => {
      resolve(undefined);
    });
  });
}

/**
 * Print the action listing grouped by namespace.
 */
function printActionList(): void {
  const namespaces = ["query", "code", "repo", "agent"] as const;
  const labels: Record<string, string> = {
    query: "Query — Read-only intelligence queries",
    code: "Code — Gated raw code access",
    repo: "Repo — Repository lifecycle",
    agent: "Agent — Agentic + live-edit operations",
  };

  console.log("\nAvailable actions:\n");

  for (const ns of namespaces) {
    const actions = ACTION_DEFINITIONS.filter((a) => a.namespace === ns);
    console.log(`  ${labels[ns]}:`);
    for (const action of actions) {
      console.log(`    ${action.action.padEnd(26)} ${action.description}`);
    }
    console.log("");
  }

  console.log("Usage:");
  console.log("  sdl-mcp tool <action> [flags]");
  console.log("  sdl-mcp tool <action> --help     Show action-specific help");
  console.log('  echo \'{"repoId":"x"}\' | sdl-mcp tool <action>   Pipe JSON args\n');
}

/**
 * Print action-specific help.
 */
function printActionHelp(definition: ActionDefinition): void {
  console.log(`\n${definition.action} — ${definition.description}\n`);

  console.log("Flags:");
  for (const arg of definition.args) {
    const short = arg.short ? `, ${arg.short}` : "";
    const req = arg.required ? " (required)" : "";
    const typeStr = arg.type === "boolean" ? "" : ` <${arg.type}>`;
    console.log(`  ${arg.flag}${short}${typeStr}${req}`);
    console.log(`      ${arg.description}`);
  }

  console.log("\nGlobal Flags:");
  console.log("  --output-format <format>   json|json-compact|pretty|table (default: json)");
  console.log("  --help                     Show this help");

  if (definition.examples.length > 0) {
    console.log("\nExamples:");
    for (const example of definition.examples) {
      console.log(`  ${example}`);
    }
  }

  console.log("");
}

/**
 * Suggest the closest action name for typos.
 */
export function suggestAction(input: string): string | undefined {
  // Simple prefix match
  const matches = ALL_ACTION_NAMES.filter((name) => name.startsWith(input));
  if (matches.length === 1) return matches[0];

  // Substring match
  const subMatches = ALL_ACTION_NAMES.filter((name) => name.includes(input));
  if (subMatches.length === 1) return subMatches[0];
  if (subMatches.length > 0) {
    return undefined; // too many matches
  }

  return undefined;
}

/**
 * Main tool dispatch entrypoint.
 */
export async function toolDispatchCommand(
  options: ToolDispatchOptions,
): Promise<void> {
  const { action, rawArgs } = options;

  // --list: show all actions
  if (options.list) {
    printActionList();
    return;
  }

  // No action provided
  if (!action) {
    throw new Error("no action specified. Run: sdl-mcp tool --list");
  }

  // Look up action definition
  const definition = ACTION_MAP.get(action);
  if (!definition) {
    const suggestion = suggestAction(action);
    const parts = [`unknown action "${action}"`];
    if (suggestion) {
      parts.push(`Did you mean: ${suggestion}?`);
    }
    parts.push("Run: sdl-mcp tool --list");
    throw new Error(parts.join(". "));
  }

  // --help for specific action
  if (options.showHelp) {
    printActionHelp(definition);
    return;
  }

  // Parse action-specific args (strict: true catches typos like --repoid)
  const actionParseOpts = buildParseArgsOptions(definition);
  let actionValues: Record<string, unknown>;

  try {
    const { values: parsed } = parseArgs({
      args: rawArgs,
      strict: true,
      options: {
        ...actionParseOpts,
        "output-format": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    actionValues = parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${formatError(err)}. Run: sdl-mcp tool ${action} --help`,
    );
  }

  // Read stdin JSON if piped
  const stdinArgs = await readStdinJson();

  // Initialize config (needed for repoId auto-resolution before arg validation)
  const configPath = activateCliConfigPath(options.config);
  const config = loadConfig(configPath);

  // Auto-resolve repoId if not specified in flags or stdin
  if (!actionValues["repo-id"] && (!stdinArgs || !stdinArgs.repoId)) {
    const resolved = resolveRepoId(undefined, config.repos);
    if (resolved) {
      actionValues["repo-id"] = resolved;
    }
  }

  // Build handler args (validates required fields — repoId is resolved above)
  const handlerArgs = parseToolArgs(definition, actionValues, stdinArgs);

  // Initialize DB
  await initGraphDb(config, configPath);

  // Build action map (gateway router — no MCP server needed)
  // liveIndex is undefined in CLI mode; buffer.* actions will error gracefully
  const actionHandlerMap = createActionMap(undefined);

  // Look up handler
  const entry = actionHandlerMap[action];
  if (!entry) {
    throw new Error(`action "${action}" not found in handler map`);
  }

  // Validate with Zod schema and call handler
  const parsed = entry.schema.parse(handlerArgs);
  const result = await entry.handler(parsed);

  // Output
  const outputFormat = detectOutputFormat(
    (actionValues["output-format"] as string) ?? options.outputFormat,
  );
  formatOutput(result, outputFormat);
}
