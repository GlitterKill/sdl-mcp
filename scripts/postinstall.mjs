#!/usr/bin/env node
/**
 * postinstall.mjs — top-level npm postinstall entrypoint.
 *
 * Runs each sub-step as a separate Node process. A failure in any sub-step
 * logs a warning but never aborts npm install.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STEPS = [
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
  }
}

process.exit(0);
