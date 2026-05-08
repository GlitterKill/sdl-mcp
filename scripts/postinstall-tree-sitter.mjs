#!/usr/bin/env node
/**
 * postinstall-tree-sitter.mjs
 *
 * Verifies that tree-sitter and all grammar packages can load on the target
 * machine. If a grammar package is installed but its native binding is missing,
 * rebuild the grammar set before postinstall-prune removes source directories.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const requireFromPackage = createRequire(join(PACKAGE_ROOT, "package.json"));

const args = new Set(process.argv.slice(2));
const VERIFY_ONLY = args.has("--verify-only");
const STRICT =
  args.has("--strict") ||
  process.env.SDL_MCP_STRICT_TREE_SITTER_POSTINSTALL === "1";

const GRAMMAR_PACKAGES = [
  { name: "tree-sitter", sample: "" },
  { name: "tree-sitter-bash", sample: "echo hi" },
  { name: "tree-sitter-c", sample: "int x;" },
  { name: "tree-sitter-c-sharp", sample: "class A{}" },
  { name: "tree-sitter-cpp", sample: "int x;" },
  { name: "tree-sitter-go", sample: "package m" },
  { name: "tree-sitter-java", sample: "class A{}" },
  { name: "tree-sitter-kotlin", sample: "fun x(){}" },
  { name: "tree-sitter-php", exportName: "php", sample: "<?php $x=1;" },
  { name: "tree-sitter-python", sample: "x=1" },
  { name: "tree-sitter-rust", sample: "fn m(){}" },
  {
    name: "tree-sitter-typescript",
    exportName: "typescript",
    sample: "let x=1;",
  },
];

function log(message) {
  console.log(`sdl-mcp tree-sitter: ${message}`);
}

function warn(message) {
  console.warn(`sdl-mcp tree-sitter warning: ${message}`);
}

function loadParser() {
  return requireFromPackage("tree-sitter");
}

function verifyPackage(spec) {
  try {
    const Parser = loadParser();
    const parser = new Parser();
    if (spec.name === "tree-sitter") {
      return null;
    }

    const mod = requireFromPackage(spec.name);
    const grammar = spec.exportName ? mod?.[spec.exportName] : mod;
    if (!grammar) {
      throw new Error(
        `${spec.exportName ? `export "${spec.exportName}"` : "default export"} is missing`,
      );
    }

    parser.setLanguage(grammar);
    parser.parse(spec.sample);
    return null;
  } catch (error) {
    return {
      packageName: spec.name,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function verifyAll() {
  return GRAMMAR_PACKAGES.map(verifyPackage).filter(Boolean);
}

function packageDir(packageName) {
  try {
    return dirname(requireFromPackage.resolve(`${packageName}/package.json`));
  } catch {
    return null;
  }
}

function findInstallRoot() {
  const treeSitterDir = packageDir("tree-sitter");
  if (!treeSitterDir) {
    return PACKAGE_ROOT;
  }

  let current = treeSitterDir;
  while (current !== dirname(current)) {
    const parent = dirname(current);
    if (basename(parent) === "node_modules") {
      return dirname(parent);
    }
    current = parent;
  }

  return PACKAGE_ROOT;
}

function patchTreeSitterBindingGyp() {
  const treeSitterDir = packageDir("tree-sitter");
  if (!treeSitterDir) {
    warn("could not locate tree-sitter package for C++20 binding.gyp patch");
    return;
  }

  const bindingGypPath = join(treeSitterDir, "binding.gyp");
  if (!existsSync(bindingGypPath)) {
    return;
  }

  const before = readFileSync(bindingGypPath, "utf8");
  const after = before.replace(/c\+\+17/g, "c++20");
  if (after !== before) {
    writeFileSync(bindingGypPath, after);
    log("patched tree-sitter binding.gyp from c++17 to c++20");
  }
}

function rebuildTreeSitterPackages() {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const rebuildPackages = GRAMMAR_PACKAGES.map((spec) => spec.name);
  const installRoot = findInstallRoot();

  log(`rebuilding ${rebuildPackages.join(", ")} from ${installRoot}`);
  const result = spawnSync(npmCmd, ["rebuild", ...rebuildPackages], {
    cwd: installRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`npm rebuild exited with code ${result.status ?? 1}`);
  }
}

function reportFailures(failures) {
  for (const failure of failures) {
    warn(`${failure.packageName}: ${failure.message}`);
  }
}

if (process.env.SDL_MCP_SKIP_TREE_SITTER_POSTINSTALL === "1") {
  log("SDL_MCP_SKIP_TREE_SITTER_POSTINSTALL=1 set; skipping grammar verification");
  process.exit(0);
}

let failures = verifyAll();
if (failures.length === 0) {
  log("all grammar packages load");
  process.exit(0);
}

reportFailures(failures);

if (VERIFY_ONLY) {
  process.exit(1);
}

try {
  patchTreeSitterBindingGyp();
  rebuildTreeSitterPackages();
  failures = verifyAll();
} catch (error) {
  warn(error instanceof Error ? error.message : String(error));
}

if (failures.length === 0) {
  log("grammar packages load after rebuild");
  process.exit(0);
}

reportFailures(failures);
warn(
  "tree-sitter grammar rebuild did not complete. Kotlin and other fallback parsers may be unavailable. Run `npm rebuild tree-sitter tree-sitter-kotlin` after installing build tools.",
);
process.exit(STRICT ? 1 : 0);
