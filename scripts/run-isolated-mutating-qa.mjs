#!/usr/bin/env node

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MAX_SCENARIO_BYTES = 256 * 1024;
const MAX_SCENARIO_CALLS = 50;
const FORBIDDEN_ARGUMENT_KEYS = new Set([
  "command",
  "code",
  "endpoint",
  "executable",
  "host",
  "port",
  "stdin",
  "uri",
  "url",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalizePath(value) {
  const absolutePath = resolve(value);
  const canonicalPath = existsSync(absolutePath)
    ? realpathSync.native(absolutePath)
    : absolutePath;
  return process.platform === "win32"
    ? canonicalPath.toLowerCase()
    : canonicalPath;
}

function databaseFamilyRoot(value) {
  return canonicalizePath(value).replace(
    /\.wal(?:\.checkpoint)?(?:\.quarantine-\d+)?$/i,
    "",
  );
}

export function assertDistinctDatabaseFamilies(qaDbPath, deniedDbPaths) {
  const qaFamily = databaseFamilyRoot(qaDbPath);
  for (const deniedPath of deniedDbPaths.filter(Boolean)) {
    if (qaFamily === databaseFamilyRoot(deniedPath)) {
      throw new Error(
        `QA database family must differ from active/configured database family: ${deniedPath}`,
      );
    }
  }
}

export function buildIsolatedChildEnv(baseEnv, qaDbPath) {
  const childEnv = {
    ...baseEnv,
    SDL_GRAPH_DB_PATH: resolve(qaDbPath),
  };
  delete childEnv.SDL_GRAPH_DB_DIR;
  delete childEnv.SDL_DB_PATH;
  return childEnv;
}

function validateScenarioValue(value, path = "arguments") {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateScenarioValue(item, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_ARGUMENT_KEYS.has(key)) {
      throw new Error(
        `Scenario cannot declare arbitrary commands or external endpoints (${path}.${key})`,
      );
    }
    if (
      key === "fn" &&
      typeof child === "string" &&
      /runtime|http/i.test(child)
    ) {
      throw new Error(`Scenario runtime/HTTP action is not allowed: ${child}`);
    }
    validateScenarioValue(child, `${path}.${key}`);
  }
}

export function validateScenario(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Scenario must be a non-empty JSON array");
  }
  if (value.length > MAX_SCENARIO_CALLS) {
    throw new Error(
      `Scenario exceeds the ${MAX_SCENARIO_CALLS}-call safety limit`,
    );
  }

  for (const [index, step] of value.entries()) {
    if (
      !isRecord(step) ||
      Object.keys(step).some((key) => key !== "tool" && key !== "arguments") ||
      typeof step.tool !== "string" ||
      step.tool.length === 0 ||
      !isRecord(step.arguments)
    ) {
      throw new Error(
        `Scenario step ${index} must contain only { tool, arguments }`,
      );
    }
    if (/runtime|http/i.test(step.tool)) {
      throw new Error(
        `Scenario runtime/HTTP tool is not allowed: ${step.tool}`,
      );
    }
    validateScenarioValue(step.arguments);
  }

  return value;
}

function assertPathInsideFixture(value, fixtureRoot) {
  const canonicalFixture = canonicalizePath(fixtureRoot);
  const canonicalValue = canonicalizePath(value);
  const pathFromFixture = relative(canonicalFixture, canonicalValue);
  if (
    pathFromFixture === ".." ||
    pathFromFixture.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(pathFromFixture)
  ) {
    throw new Error(
      `Repository root must remain inside the disposable fixture root: ${value}`,
    );
  }
}

function collectRootPaths(value, roots) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectRootPaths(item, roots));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "rootPath" && typeof child === "string") {
      roots.push(child);
    }
    collectRootPaths(child, roots);
  }
}

export function assertQaInputsContained(config, scenario, fixtureRoot) {
  if (!existsSync(fixtureRoot)) {
    throw new Error(`Disposable fixture root does not exist: ${fixtureRoot}`);
  }
  const roots = [];
  collectRootPaths(config.repos ?? [], roots);
  collectRootPaths(scenario, roots);
  for (const rootPath of roots) {
    assertPathInsideFixture(rootPath, fixtureRoot);
  }
}

function extractActiveDbPath(result) {
  const activePath = result.structuredContent?.ladybug?.activePath;
  if (typeof activePath !== "string" || activePath.length === 0) {
    throw new Error("sdl.info did not report a LadybugDB activePath");
  }
  return activePath;
}

export const QA_TOOL_FAILURE_MESSAGE_MAX_CHARS = 2_000;
const QA_TOOL_FAILURE_STRUCTURED_MAX_CHARS = 1_500;

export function assertToolSucceeded(tool, result) {
  const structuredError = result.structuredContent?.error;
  if (!result.isError && !structuredError) {
    return;
  }

  const details = [`QA tool failed: ${tool}`];
  if (result.isError === true) details.push("isError=true");
  if (typeof structuredError?.code === "string") {
    details.push(`code=${structuredError.code}`);
  }
  // Pre-dispatch schema errors omit the domain formatter's default classification.
  const classification =
    structuredError?.classification ??
    (structuredError?.code === "VALIDATION_ERROR" ? "invalid_input" : undefined);
  if (typeof classification === "string") {
    details.push(`classification=${classification}`);
  }
  const childFailure = Array.isArray(result.structuredContent?.results)
    ? result.structuredContent.results.find((entry) => entry?.status === "error")
    : undefined;
  const structuredFailureDetail =
    childFailure ??
    (structuredError && Object.keys(structuredError).length > 0
      ? structuredError
      : undefined);
  if (structuredFailureDetail) {
    const serialized = JSON.stringify(structuredFailureDetail);
    if (typeof serialized === "string") {
      details.push(
        `structured=${serialized.slice(0, QA_TOOL_FAILURE_STRUCTURED_MAX_CHARS)}`,
      );
    }
  }
  const message = details.join(" | ");
  throw new Error(message.slice(0, QA_TOOL_FAILURE_MESSAGE_MAX_CHARS));
}

export function assertScenarioToolsAvailable(listToolsResult, scenario) {
  const available = new Set(listToolsResult.tools.map((tool) => tool.name));
  const required = new Set(["sdl.info", ...scenario.map((step) => step.tool)]);
  const missing = [...required].filter((tool) => !available.has(tool));
  if (missing.length === 0) {
    return;
  }

  const codeModeUnavailable = missing.some((tool) =>
    ["sdl.file", "sdl.retrieve", "sdl.workflow"].includes(tool),
  );
  throw new Error(
    `Scenario tools are not available: ${missing.join(", ")}.${
      codeModeUnavailable
        ? " Code Mode is unavailable because its required tools are missing."
        : ""
    }`,
  );
}

async function readScenario(path) {
  const source = await readFile(path, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_SCENARIO_BYTES) {
    throw new Error(
      `Scenario exceeds the ${MAX_SCENARIO_BYTES}-byte safety limit`,
    );
  }
  return validateScenario(JSON.parse(source));
}

function configuredDbPath(config) {
  const value = config.graphDatabase?.path;
  return typeof value === "string" && value.length > 0 ? resolve(value) : null;
}

export function assertNoDatabaseSidecars(qaDbPath) {
  const directory = dirname(qaDbPath);
  const databaseName = basename(qaDbPath);
  const dangling = readdirSync(directory)
    .filter((name) => name.startsWith(`${databaseName}.`))
    // The exact-build receipt is a durable member of the database family.
    .filter((name) => name !== `${databaseName}.sdl-lineage.json`)
    .map((name) => join(directory, name));
  if (dangling.length > 0) {
    throw new Error(
      `QA database did not close cleanly; retained sidecars: ${dangling.join(", ")}`,
    );
  }
}

export async function runIsolatedMutatingQa(options) {
  const projectRoot = resolve(
    options.projectRoot ??
      join(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const activeDbPath = resolve(options.activeDbPath);
  const fixtureRoot = resolve(options.fixtureRoot);
  const configPath = resolve(options.configPath);
  const scenarioPath = resolve(options.scenarioPath);
  const qaRootPath = await mkdtemp(join(tmpdir(), "sdl-mutating-qa-"));
  const qaDbPath = join(qaRootPath, "qa.lbug");
  let client;
  let closed = false;

  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const scenario = await readScenario(scenarioPath);
    assertQaInputsContained(config, scenario, fixtureRoot);
    assertDistinctDatabaseFamilies(qaDbPath, [
      activeDbPath,
      configuredDbPath(config),
      process.env.SDL_GRAPH_DB_PATH,
      process.env.SDL_GRAPH_DB_DIR,
      process.env.SDL_DB_PATH,
    ]);
    if (existsSync(qaDbPath)) {
      throw new Error(`QA database path must be initially absent: ${qaDbPath}`);
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(projectRoot, "dist", "cli", "index.js"),
        "--config",
        configPath,
        "serve",
        "--stdio",
        "--no-watch",
      ],
      cwd: projectRoot,
      env: buildIsolatedChildEnv(process.env, qaDbPath),
    });
    client = new Client({
      name: "sdl-isolated-mutating-qa",
      version: "1.0.0",
    });

    await client.connect(transport);
    const toolsResult = await client.listTools();
    assertScenarioToolsAvailable(toolsResult, scenario);
    const infoResult = await client.callTool({
      name: "sdl.info",
      arguments: { includeDiagnostics: true, redactPaths: false },
    });
    assertToolSucceeded("sdl.info", infoResult);
    const reportedDbPath = extractActiveDbPath(infoResult);
    if (databaseFamilyRoot(reportedDbPath) !== databaseFamilyRoot(qaDbPath)) {
      throw new Error(
        `sdl.info reported the wrong LadybugDB path: ${reportedDbPath}`,
      );
    }

    const completedTools = [];
    for (const step of scenario) {
      const result = await client.callTool({
        name: step.tool,
        arguments: step.arguments,
      });
      assertToolSucceeded(step.tool, result);
      completedTools.push(step.tool);
    }

    await client.close();
    closed = true;
    assertNoDatabaseSidecars(qaDbPath);

    const receipt = {
      qaDbPath,
      qaRootPath,
      fixtureRoot,
      completedTools,
      closed: true,
      sidecarsClean: true,
      cleaned: true,
    };
    await rm(qaRootPath, { recursive: true });
    return receipt;
  } catch (cause) {
    if (client && !closed) {
      try {
        await client.close();
      } catch {
        // Preserve the original failure and retain the complete QA fixture.
      }
    }
    const error = cause instanceof Error ? cause : new Error(String(cause));
    error.qaDbPath = qaDbPath;
    error.qaRootPath = qaRootPath;
    throw error;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --flag value pair near: ${flag ?? "<end>"}`);
    }
    if (flag === "--active-db") options.activeDbPath = value;
    else if (flag === "--fixture-root") options.fixtureRoot = value;
    else if (flag === "--config") options.configPath = value;
    else if (flag === "--scenario") options.scenarioPath = value;
    else throw new Error(`Unknown option: ${flag}`);
  }

  for (const key of [
    "activeDbPath",
    "fixtureRoot",
    "configPath",
    "scenarioPath",
  ]) {
    if (!options[key]) {
      throw new Error(`Missing required option: ${key}`);
    }
  }
  return options;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runIsolatedMutatingQa(parseArgs(process.argv.slice(2)))
    .then((receipt) => {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    })
    .catch((error) => {
      const retained = error?.qaRootPath
        ? ` Retained QA fixture: ${error.qaRootPath}`
        : "";
      process.stderr.write(
        `[sdl-mcp] isolated mutating QA failed: ${error instanceof Error ? error.message : String(error)}.${retained}\n`,
      );
      process.exitCode = 1;
    });
}
