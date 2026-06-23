#!/usr/bin/env node
/**
 * postinstall.mjs - top-level npm postinstall entrypoint.
 *
 * Runs each sub-step as a separate Node process. Sub-step failures are
 * warnings by default; CI can set SDL_MCP_STRICT_TREE_SITTER_POSTINSTALL=1
 * to fail fast when grammar bindings cannot be verified.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STEPS = [
  { name: "tree-sitter", script: "postinstall-tree-sitter.mjs" },
  { name: "watchman", script: "postinstall-watchman.mjs" },
  { name: "prune", script: "postinstall-prune.mjs" },
  { name: "models", script: "postinstall-models.mjs" },
];

export const SETUP_WIZARD_PROMPT_TIMEOUT_MS = 30_000;

function runStep(script) {
  return new Promise((resolve) => {
    const verbose = process.env.SDL_MCP_POSTINSTALL_VERBOSE === "1";
    const child = spawn(process.execPath, [join(__dirname, script)], {
      stdio: verbose ? "inherit" : "ignore",
      env: process.env,
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      console.warn(
        `sdl-mcp: postinstall step "${script}" failed: ${err.message}`,
      );
      resolve(1);
    });
  });
}

export function retrySetupCommands() {
  return ["sdl-mcp init", "npx --yes sdl-mcp@latest init"];
}

export function updateSetupCommands() {
  return [
    "sdl-mcp init",
    'sdl-mcp init --repo-path "<repo>"',
    'sdl-mcp init --repo-path "<repo>" --client codex --enforce-agent-tools',
  ];
}

export function isUpdateInstall(env) {
  return Boolean(
    env.SDL_MCP_UPDATE === "1" ||
      env.SDL_MCP_UPDATE === "true" ||
      env.npm_command === "update" ||
      env.npm_config_sdl_mcp_update === "true" ||
      env.npm_config_sdl_mcp_update === "1" ||
      env.npm_config_update === "true" ||
      env.npm_config_update === "1",
  );
}

export function shouldOfferSetupWizard({
  stdinIsTTY,
  stdoutIsTTY,
  env,
  distCliExists,
}) {
  return Boolean(
    stdinIsTTY &&
      stdoutIsTTY &&
      distCliExists &&
      env.CI !== "true" &&
      !isUpdateInstall(env) &&
      env.SDL_MCP_SKIP_SETUP_WIZARD !== "1",
  );
}

export function existingConfigCandidates(env, cwd = process.cwd()) {
  const home = env.SDL_CONFIG_HOME || join(homedir(), ".sdl-mcp");
  return [
    env.SDL_CONFIG,
    env.SDL_CONFIG_PATH,
    join(cwd, "sdlmcp.config.json"),
    join(home, "sdlmcp.config.json"),
  ].filter(Boolean);
}

async function printConfigUpdateNotes() {
  const configPath = existingConfigCandidates(
    process.env,
    process.env.INIT_CWD || process.cwd(),
  ).find((candidate) => existsSync(candidate));
  if (!configPath) {
    return;
  }

  try {
    const diffModule = await import(
      pathToFileURL(join(__dirname, "..", "dist", "cli", "setup-wizard", "config-diff.js")).href
    );
    const rawConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    const recommendations = diffModule.summarizeMissingConfigKeys(rawConfig);
    if (recommendations.length === 0) {
      return;
    }
    console.log(`sdl-mcp: config recommendations for ${configPath}:`);
    for (const item of recommendations) {
      console.log(`  - ${item.path}: ${JSON.stringify(item.recommendedValue)}`);
    }
  } catch {
    // Best-effort update notes; install success must not depend on config parsing.
  }
}

async function printUpdateSummary() {
  console.log("sdl-mcp: update install complete.");
  await printConfigUpdateNotes();
  console.log("sdl-mcp: setup commands:");
  for (const command of updateSetupCommands()) {
    console.log(`  ${command}`);
  }
}

function askWithTimeout(question, timeoutMs) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let settled = false;
    let timer;
    const finish = (answer) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      resolve(answer);
    };
    const onData = (chunk) => finish(String(chunk));
    timer = setTimeout(() => {
      process.stdout.write("\n");
      finish("");
    }, timeoutMs);
    process.stdin.once("data", onData);
  });
}

async function offerSetupWizard() {
  const distCli = join(__dirname, "..", "dist", "cli", "index.js");
  if (
    !shouldOfferSetupWizard({
      stdinIsTTY: process.stdin.isTTY,
      stdoutIsTTY: process.stdout.isTTY,
      env: process.env,
      distCliExists: existsSync(distCli),
    })
  ) {
    return;
  }

  const answer = await askWithTimeout(
    "sdl-mcp: run interactive setup wizard now? [y/N] ",
    SETUP_WIZARD_PROMPT_TIMEOUT_MS,
  );
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("sdl-mcp: setup skipped. Run later with:");
    for (const command of retrySetupCommands()) {
      console.log(`  ${command}`);
    }
    return;
  }

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [distCli, "init", "--from-postinstall"], {
      stdio: "inherit",
      env: process.env,
      cwd: process.env.INIT_CWD || process.cwd(),
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const updateInstall = isUpdateInstall(process.env);
  if (!updateInstall) {
    await offerSetupWizard();
  }

  for (const step of STEPS) {
    const code = await runStep(step.script);
    if (code !== 0) {
      console.warn(
        `sdl-mcp: postinstall step "${step.name}" exited with code ${code}`,
      );
      if (
        step.name === "tree-sitter" &&
        process.env.SDL_MCP_STRICT_TREE_SITTER_POSTINSTALL === "1"
      ) {
        process.exit(code);
      }
    }
  }

  if (updateInstall) {
    await printUpdateSummary();
  }

  process.exit(0);
}
