#!/usr/bin/env node
/**
 * postinstall.mjs - top-level npm postinstall entrypoint.
 *
 * Runs each sub-step as a separate Node process. Sub-step failures are
 * warnings by default; CI can set SDL_MCP_STRICT_TREE_SITTER_POSTINSTALL=1
 * to fail fast when grammar bindings cannot be verified.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

process.exit(0);
