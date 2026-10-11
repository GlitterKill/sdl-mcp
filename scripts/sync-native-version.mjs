#!/usr/bin/env node

// Sync release-coupled package versions across native packages, Watchman
// packages, the create wrapper package, and the main package.
//
// Usage:
//   node scripts/sync-native-version.mjs [version]
//
// If no version is provided, reads from native/package.json.
import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const RELEASE_ROOT_OPTIONAL_DEPENDENCIES = [
  "sdl-mcp-native",
  "sdl-mcp-watchman",
  "sdl-mcp-watchman-linux-x64",
  "sdl-mcp-watchman-win32-x64",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function syncPackageVersion(pkgPath, label, version) {
  const pkg = readJson(pkgPath);
  let changed = false;
  if (pkg.version !== version) {
    pkg.version = version;
    changed = true;
  }
  if (pkg.optionalDependencies) {
    for (const dep of Object.keys(pkg.optionalDependencies)) {
      if (pkg.optionalDependencies[dep] !== version) {
        pkg.optionalDependencies[dep] = version;
        changed = true;
      }
    }
  }
  if (changed) {
    writeJson(pkgPath, pkg);
    console.log(`  Updated ${label} -> ${version}`);
  } else {
    console.log(`  ${label} already at ${version}`);
  }
  return pkg;
}

function syncPackageDirVersions(dirPath, label, version) {
  let count = 0;
  for (const entry of readdirSync(dirPath)) {
    const pkgPath = join(dirPath, entry, "package.json");
    try {
      if (!statSync(pkgPath).isFile()) continue;
    } catch {
      continue;
    }
    syncPackageVersion(pkgPath, `${label}/${entry}/package.json`, version);
    count++;
  }
  return count;
}

const explicitVersion = process.argv[2];
const nativePkgPath = join(root, "native", "package.json");
const nativePkg = readJson(nativePkgPath);
const version = explicitVersion || nativePkg.version;

console.log(`Syncing release-coupled package versions: ${version}`);

syncPackageVersion(
  nativePkgPath,
  "native/package.json",
  version,
);
const nativePlatformCount = syncPackageDirVersions(
  join(root, "native", "npm"),
  "native/npm",
  version,
);

const watchmanPkgPath = join(root, "watchman", "package.json");
syncPackageVersion(
  watchmanPkgPath,
  "watchman/package.json",
  version,
);
const watchmanPlatformCount = syncPackageDirVersions(
  join(root, "watchman", "npm"),
  "watchman/npm",
  version,
);

syncPackageVersion(
  join(root, "packages", "create-sdl-mcp", "package.json"),
  "packages/create-sdl-mcp/package.json",
  version,
);

const mainPkgPath = join(root, "package.json");
const mainPkg = readJson(mainPkgPath);
let mainChanged = false;
for (const depName of RELEASE_ROOT_OPTIONAL_DEPENDENCIES) {
  if (
    mainPkg.optionalDependencies &&
    mainPkg.optionalDependencies[depName] !== version
  ) {
    mainPkg.optionalDependencies[depName] = version;
    mainChanged = true;
    console.log(`  Updated package.json ${depName} -> ${version}`);
  } else {
    console.log(`  package.json ${depName} already at ${version}`);
  }
}
if (mainChanged) {
  writeJson(mainPkgPath, mainPkg);
}

const lockPath = join(root, "package-lock.json");
let lockChanged = false;
try {
  const lock = readJson(lockPath);
  const lockRoot = lock.packages?.[""];
  for (const depName of RELEASE_ROOT_OPTIONAL_DEPENDENCIES) {
    if (
      lockRoot?.optionalDependencies &&
      lockRoot.optionalDependencies[depName] !== version
    ) {
      lockRoot.optionalDependencies[depName] = version;
      lockChanged = true;
    }
  }

  // Resolved entries describe immutable registry artifacts. Updating only their
  // version would keep the old tarball URL/integrity and silently install old code.
  // After publishing the new packages, let npm resolve the complete metadata.
  console.log("  Resolve published versions with npm install --package-lock-only --ignore-scripts --legacy-peer-deps before release verification");
  if (lockChanged) {
    writeJson(lockPath, lock);
    console.log(`  Updated package-lock.json root optional requirements -> ${version}`);
  } else {
    console.log("  package-lock.json root optional requirements already in sync");
  }
} catch {
  console.log("  package-lock.json not found or unreadable, skipping lock sync");
}

console.log(
  `\nDone. Synced version ${version} across ${nativePlatformCount} native platform packages, ${watchmanPlatformCount} Watchman platform packages, and create-sdl-mcp.`,
);
