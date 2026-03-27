#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CHANGELOG_PATH = join(ROOT, "CHANGELOG.md");
const PACKAGE_PATH = join(ROOT, "package.json");
const NATIVE_PACKAGE_PATH = join(ROOT, "native", "package.json");
const NATIVE_NPM_DIR = join(ROOT, "native", "npm");
const TARBALL_WARN_BYTES = 25 * 1024 * 1024;
const NPM_COMMAND = "npm";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function runCommand(command, args, options = {}) {
  const invocation =
    process.platform === "win32" && command === NPM_COMMAND
      ? {
          command: "cmd.exe",
          args: ["/d", "/s", "/c", command, ...args],
        }
      : { command, args };

  return execFileSync(invocation.command, invocation.args, {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

export function hasChangelogEntry(changelogSource, version) {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^## \\[${escapedVersion}\\](?:\\s|$)`, "m");
  return pattern.test(changelogSource);
}

export function findNativeVersionMismatches(packageJson, nativePackageJson, nativePlatformPackages) {
  const mismatches = [];
  if (packageJson.optionalDependencies?.["sdl-mcp-native"] !== packageJson.version) {
    mismatches.push("package.json optionalDependencies.sdl-mcp-native");
  }
  if (nativePackageJson.version !== packageJson.version) {
    mismatches.push("native/package.json version");
  }
  for (const pkg of nativePlatformPackages) {
    if (pkg.version !== packageJson.version) {
      mismatches.push(`native/npm/${pkg.name}/package.json version`);
    }
  }
  return mismatches;
}

export function classifyBranchStatus(branchName, statusLine) {
  return {
    nonMainBranch: branchName !== "main",
    unsynced: /\[(ahead|behind|diverged)/.test(statusLine),
  };
}

export function findSelfTarballDependencies(packageJson) {
  const dependencySpec = packageJson.dependencies?.["sdl-mcp"];
  if (typeof dependencySpec !== "string") {
    return [];
  }

  return /^file:.*\.tgz$/i.test(dependencySpec)
    ? [`dependencies.sdl-mcp (${dependencySpec})`]
    : [];
}

export function getRequiredPackEntries() {
  return [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/main.js",
    "dist/cli/index.js",
    "config/sdlmcp.config.schema.json",
    "templates/codex.json",
    "templates/CODEX.md.template",
  ];
}

export function findMissingPackEntries(packFileEntries) {
  const packedPaths = new Set(packFileEntries.map((entry) => entry.path));
  return getRequiredPackEntries().filter((path) => !packedPaths.has(path));
}

async function runJsonRpcSmokeTest() {
  const tempDir = mkdtempSync(join(tmpdir(), "sdl-mcp-prepare-release-"));
  const configPath = join(tempDir, "sdlmcp.config.json");
  const dbPath = join(tempDir, "prepare-release-graph.lbug");
  const logPath = join(tempDir, "prepare-release.log");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        repos: [],
        policy: {},
      },
      null,
      2,
    ),
    "utf-8",
  );

  const client = new Client({
    name: "prepare-release",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/main.js"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      SDL_CONFIG: configPath,
      SDL_GRAPH_DB_PATH: dbPath,
      SDL_LOG_FILE: logPath,
      SDL_CONSOLE_LOGGING: "false",
    },
  });

  try {
    await client.connect(transport);
    const response = await client.request(
      { method: "tools/list", params: {} },
      ListToolsResultSchema,
    );
    assert.ok(Array.isArray(response.tools), "tools/list should return tools");
    assert.ok(
      response.tools.some((tool) => tool.name === "sdl.info"),
      "tools/list should include sdl.info",
    );
  } finally {
    await client.close().catch(() => {});
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function readNativePlatformPackages() {
  return readdirSync(NATIVE_NPM_DIR)
    .map((entry) => {
      const packagePath = join(NATIVE_NPM_DIR, entry, "package.json");
      if (!existsSync(packagePath) || !statSync(packagePath).isFile()) {
        return null;
      }
      return { name: entry, ...readJson(packagePath) };
    })
    .filter(Boolean);
}

function warn(message) {
  console.warn(`[warn] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

async function main() {
  const pkg = readJson(PACKAGE_PATH);
  const nativePkg = readJson(NATIVE_PACKAGE_PATH);
  const nativePlatformPackages = readNativePlatformPackages();
  const changelog = readFileSync(CHANGELOG_PATH, "utf-8");

  const branchName = runCommand("git", ["branch", "--show-current"], {
    capture: true,
  }).trim();
  const gitStatus = runCommand("git", ["status", "--short", "--branch"], {
    capture: true,
  }).split(/\r?\n/, 1)[0] ?? "";
  const branchStatus = classifyBranchStatus(branchName, gitStatus);

  if (branchStatus.nonMainBranch) {
    warn(`current branch is ${branchName}, not main`);
  }
  if (branchStatus.unsynced) {
    warn(`branch appears unsynced with remote: ${gitStatus}`);
  }

  const mismatches = findNativeVersionMismatches(
    pkg,
    nativePkg,
    nativePlatformPackages,
  );
  if (mismatches.length > 0) {
    fail(`version mismatch detected: ${mismatches.join(", ")}`);
  }

  const selfTarballDeps = findSelfTarballDependencies(pkg);
  if (selfTarballDeps.length > 0) {
    fail(
      `invalid self tarball dependency detected: ${selfTarballDeps.join(", ")}`,
    );
  }

  if (!hasChangelogEntry(changelog, pkg.version)) {
    fail(`CHANGELOG.md is missing an entry for version ${pkg.version}`);
  }

  try {
    const published = runCommand(
      NPM_COMMAND,
      ["view", `sdl-mcp@${pkg.version}`, "version", "--json"],
      { capture: true },
    ).trim();
    if (published && published !== "null") {
      fail(`version ${pkg.version} is already published to npm`);
    }
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? "";
    if (!/E404|404/.test(stderr)) {
      throw error;
    }
  }

  runCommand(NPM_COMMAND, ["run", "build:all"]);
  runCommand(NPM_COMMAND, ["run", "lint"]);
  runCommand(NPM_COMMAND, ["run", "typecheck"]);
  runCommand(NPM_COMMAND, ["test"]);
  runCommand(NPM_COMMAND, ["audit", "--audit-level=high"]);

  let outdatedOutput = "";
  try {
    outdatedOutput = runCommand(NPM_COMMAND, ["outdated", "--json"], {
      capture: true,
    }).trim();
  } catch (error) {
    outdatedOutput = error?.stdout?.toString?.().trim?.() ?? "";
  }
  if (outdatedOutput && outdatedOutput !== "{}") {
    warn("npm outdated reports dependency updates");
  }

  const packOutput = runCommand(NPM_COMMAND, ["pack", "--json"], {
    capture: true,
  });
  const [packResult] = JSON.parse(packOutput);
  const missingPackEntries = findMissingPackEntries(packResult.files ?? []);
  if (missingPackEntries.length > 0) {
    fail(`npm pack is missing required files: ${missingPackEntries.join(", ")}`);
  }
  if ((packResult.size ?? 0) > TARBALL_WARN_BYTES) {
    warn(`tarball is large (${packResult.size} bytes)`);
  }

  const tarballPath = resolve(ROOT, packResult.filename);
  if (existsSync(tarballPath)) {
    unlinkSync(tarballPath);
  }

  await runJsonRpcSmokeTest();

  console.log("prepare-release completed successfully");
}

const isEntrypoint =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error(
      `[fail] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
