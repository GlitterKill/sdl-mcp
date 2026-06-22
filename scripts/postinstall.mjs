#!/usr/bin/env node
/**
 * postinstall.mjs - top-level npm postinstall entrypoint.
 *
 * Runs each sub-step as a separate Node process. Sub-step failures are
 * warnings by default; CI can set SDL_MCP_STRICT_TREE_SITTER_POSTINSTALL=1
 * to fail fast when grammar bindings cannot be verified.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STEPS = [
  { name: "tree-sitter", script: "postinstall-tree-sitter.mjs" },
  { name: "watchman", script: "postinstall-watchman.mjs" },
  { name: "prune", script: "postinstall-prune.mjs" },
  { name: "models", script: "postinstall-models.mjs" },
];

function runStep(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(__dirname, script)], {
      stdio: "inherit",
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
      env.SDL_MCP_SKIP_SETUP_WIZARD !== "1",
  );
}

function askWithTimeout(question, timeoutMs) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const timer = setTimeout(() => resolve(""), timeoutMs);
    process.stdin.once("data", (chunk) => {
      clearTimeout(timer);
      resolve(String(chunk));
    });
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
    10_000,
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

  await offerSetupWizard();
  process.exit(0);
}
