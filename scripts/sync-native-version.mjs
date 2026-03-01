#!/usr/bin/env node

// Sync native version across all platform npm dirs and main optionalDependencies.
//
// Usage:
//   node scripts/sync-native-version.mjs [version]
//
// If no version is provided, reads from native/package.json.
// Propagates to all native/npm/*/package.json, native/package.json
// optionalDependencies, and the main package.json sdl-mcp-native entry.

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// Determine version
const explicitVersion = process.argv[2];
const nativePkgPath = join(root, "native", "package.json");
const nativePkg = readJson(nativePkgPath);
const version = explicitVersion || nativePkg.version;

console.log(`Syncing native version: ${version}`);

// 1. Update native/package.json version + optionalDependencies
let nativeChanged = false;
if (nativePkg.version !== version) {
  nativePkg.version = version;
  nativeChanged = true;
}
if (nativePkg.optionalDependencies) {
  for (const dep of Object.keys(nativePkg.optionalDependencies)) {
    if (nativePkg.optionalDependencies[dep] !== version) {
      nativePkg.optionalDependencies[dep] = version;
      nativeChanged = true;
    }
  }
}
if (nativeChanged) {
  writeJson(nativePkgPath, nativePkg);
  console.log(`  Updated native/package.json -> ${version}`);
} else {
  console.log(`  native/package.json already at ${version}`);
}

// 2. Update all native/npm/*/package.json
const npmDir = join(root, "native", "npm");
let platformCount = 0;
for (const entry of readdirSync(npmDir)) {
  const pkgPath = join(npmDir, entry, "package.json");
  try {
    if (!statSync(pkgPath).isFile()) continue;
  } catch {
    continue;
  }

  const pkg = readJson(pkgPath);
  if (pkg.version !== version) {
    pkg.version = version;
    writeJson(pkgPath, pkg);
    console.log(`  Updated native/npm/${entry}/package.json -> ${version}`);
  } else {
    console.log(`  native/npm/${entry}/package.json already at ${version}`);
  }
  platformCount++;
}

// 3. Update main package.json optionalDependencies
const mainPkgPath = join(root, "package.json");
const mainPkg = readJson(mainPkgPath);
if (
  mainPkg.optionalDependencies &&
  mainPkg.optionalDependencies["sdl-mcp-native"] !== version
) {
  mainPkg.optionalDependencies["sdl-mcp-native"] = version;
  writeJson(mainPkgPath, mainPkg);
  console.log(`  Updated package.json sdl-mcp-native -> ${version}`);
} else {
  console.log(`  package.json sdl-mcp-native already at ${version}`);
}

console.log(
  `\nDone. Synced version ${version} across ${platformCount} platform packages.`
);
