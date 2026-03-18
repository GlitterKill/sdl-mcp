#!/usr/bin/env node
/**
 * build.mjs — Repackage @ladybugdb/core into platform-specific npm packages.
 *
 * Reads the installed kuzu (aliased @ladybugdb/core) package and produces:
 *
 *   @sdl-mcp/ladybug                  (~50 KB)  — JS wrappers + types + native loader
 *   @sdl-mcp/ladybug-win32-x64        (~13 MB)  — Windows x64 binary
 *   @sdl-mcp/ladybug-linux-x64        (~25 MB)  — Linux x64 binary
 *   @sdl-mcp/ladybug-linux-arm64      (~24 MB)  — Linux ARM64 binary
 *   @sdl-mcp/ladybug-darwin-arm64     (~18 MB)  — macOS ARM64 binary
 *
 * Usage:
 *   node packages/kuzu-split/build.mjs [--kuzu-dir path] [--out-dir path]
 *
 * After running, cd into each out/<pkg> directory and `npm publish`.
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const UPSTREAM_VERSION = "0.15.1";           // @ladybugdb/core version we're wrapping
const WRAPPER_VERSION = "0.15.1-sdl.1";      // our wrapper version (tracks upstream + sdl rev)
const SCOPE = "@sdl-mcp";
const PKG_BASE = "ladybug";                  // package name base

const PLATFORMS = [
  { os: "win32",  cpu: "x64",   binary: "lbugjs-win32-x64.node" },
  { os: "linux",  cpu: "x64",   binary: "lbugjs-linux-x64.node" },
  { os: "linux",  cpu: "arm64", binary: "lbugjs-linux-arm64.node" },
  { os: "darwin", cpu: "arm64", binary: "lbugjs-darwin-arm64.node" },
];

// JS files to copy into the wrapper (everything except install.js and lbug_native.js which we replace)
const WRAPPER_JS_FILES = [
  "index.js",
  "index.mjs",
  "connection.js",
  "database.js",
  "prepared_statement.js",
  "query_result.js",
  "lbug.d.ts",
];

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const kuzuDir = resolve(getArg("--kuzu-dir", join(__dirname, "..", "..", "node_modules", "kuzu")));
const outDir = resolve(getArg("--out-dir", join(__dirname, "out")));

if (!existsSync(kuzuDir)) {
  console.error(`ERROR: kuzu directory not found at ${kuzuDir}`);
  console.error("Install kuzu first or pass --kuzu-dir");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build platform packages
// ---------------------------------------------------------------------------

console.log(`Source:  ${kuzuDir}`);
console.log(`Output:  ${outDir}`);
console.log();

for (const plat of PLATFORMS) {
  const pkgName = `${PKG_BASE}-${plat.os}-${plat.cpu}`;
  const fullName = `${SCOPE}/${pkgName}`;
  const pkgDir = join(outDir, pkgName);
  mkdirSync(pkgDir, { recursive: true });

  const binarySrc = join(kuzuDir, "prebuilt", plat.binary);
  if (!existsSync(binarySrc)) {
    console.warn(`  SKIP ${fullName}: binary not found at ${binarySrc}`);
    continue;
  }

  // Copy binary
  copyFileSync(binarySrc, join(pkgDir, "lbugjs.node"));

  // package.json
  const pkg = {
    name: fullName,
    version: WRAPPER_VERSION,
    description: `LadybugDB ${UPSTREAM_VERSION} native binary for ${plat.os}-${plat.cpu}`,
    os: [plat.os],
    cpu: [plat.cpu],
    main: "lbugjs.node",
    files: ["lbugjs.node", "LICENSE"],
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/GlitterKill/sdl-mcp.git",
      directory: `packages/kuzu-split`,
    },
  };
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  // Copy LICENSE from upstream
  const licenseSrc = join(kuzuDir, "LICENSE");
  if (existsSync(licenseSrc)) {
    copyFileSync(licenseSrc, join(pkgDir, "LICENSE"));
  }

  console.log(`  built: ${fullName} (${plat.binary})`);
}

// ---------------------------------------------------------------------------
// Build wrapper package
// ---------------------------------------------------------------------------

const wrapperDir = join(outDir, PKG_BASE);
mkdirSync(wrapperDir, { recursive: true });

// Copy JS files from upstream
for (const file of WRAPPER_JS_FILES) {
  const src = join(kuzuDir, file);
  if (existsSync(src)) {
    copyFileSync(src, join(wrapperDir, file));
  } else {
    console.warn(`  WARN: wrapper file not found: ${file}`);
  }
}

// Write our custom lbug_native.js that loads from platform package
writeFileSync(join(wrapperDir, "lbug_native.js"), `\
/**
 * Native module loader for @sdl-mcp/ladybug.
 *
 * Resolves the correct platform-specific binary from the matching
 * @sdl-mcp/ladybug-{os}-{arch} optional dependency, then falls back
 * to a local lbugjs.node (for backwards compat / manual installs).
 */

const process = require("process");
const constants = require("constants");
const { join } = require("path");
const { existsSync } = require("fs");
const { createRequire } = require("module");

const localRequire = createRequire(__filename);

function findNativeBinary() {
  const platform = process.platform;
  const arch = process.arch;
  const platformPkg = \`@sdl-mcp/ladybug-\${platform}-\${arch}\`;

  // 1. Try the platform-specific package
  try {
    const pkgDir = localRequire.resolve(\`\${platformPkg}/package.json\`);
    const binaryPath = join(pkgDir, "..", "lbugjs.node");
    if (existsSync(binaryPath)) {
      return binaryPath;
    }
  } catch {
    // Platform package not installed — fall through
  }

  // 2. Fallback: local lbugjs.node (e.g. upstream kuzu installed directly)
  const localPath = join(__dirname, "lbugjs.node");
  if (existsSync(localPath)) {
    return localPath;
  }

  throw new Error(
    \`No LadybugDB binary found for \${platform}-\${arch}. \\n\` +
    \`Install the platform package: npm install \${platformPkg}\`
  );
}

const modulePath = findNativeBinary();
const lbugNativeModule = { exports: {} };

if (process.platform === "linux") {
  process.dlopen(
    lbugNativeModule,
    modulePath,
    constants.RTLD_LAZY | constants.RTLD_GLOBAL
  );
} else {
  process.dlopen(lbugNativeModule, modulePath);
}

module.exports = lbugNativeModule.exports;
`);

// Build optionalDependencies
const optDeps = {};
for (const plat of PLATFORMS) {
  optDeps[`${SCOPE}/${PKG_BASE}-${plat.os}-${plat.cpu}`] = WRAPPER_VERSION;
}

// Wrapper package.json
const wrapperPkg = {
  name: `${SCOPE}/${PKG_BASE}`,
  version: WRAPPER_VERSION,
  description: `LadybugDB ${UPSTREAM_VERSION} — repackaged with per-platform binaries (saves ~460 MB vs upstream)`,
  type: "commonjs",
  main: "index.js",
  module: "./index.mjs",
  types: "./lbug.d.ts",
  exports: {
    ".": {
      require: "./index.js",
      import: "./index.mjs",
      types: "./lbug.d.ts",
    },
  },
  files: [
    "index.js",
    "index.mjs",
    "lbug.d.ts",
    "lbug_native.js",
    "connection.js",
    "database.js",
    "prepared_statement.js",
    "query_result.js",
    "LICENSE",
    "README.md",
  ],
  optionalDependencies: optDeps,
  license: "MIT",
  repository: {
    type: "git",
    url: "git+https://github.com/GlitterKill/sdl-mcp.git",
    directory: "packages/kuzu-split",
  },
  keywords: [
    "ladybugdb",
    "graph-database",
    "cypher",
    "native",
  ],
};
writeFileSync(join(wrapperDir, "package.json"), JSON.stringify(wrapperPkg, null, 2) + "\n");

// Copy LICENSE
const licenseSrc = join(kuzuDir, "LICENSE");
if (existsSync(licenseSrc)) {
  copyFileSync(licenseSrc, join(wrapperDir, "LICENSE"));
}

// README
writeFileSync(join(wrapperDir, "README.md"), `\
# @sdl-mcp/ladybug

LadybugDB ${UPSTREAM_VERSION} repackaged with per-platform native binaries.

## Why?

The upstream \`@ladybugdb/core\` npm package ships all platform binaries plus the
full C++ source tree (~496 MB installed). This repackaging splits the native
binaries into platform-specific optional dependencies, so you only download the
binary for your platform (~13-25 MB).

## Install

\`\`\`bash
npm install @sdl-mcp/ladybug
\`\`\`

npm automatically selects the correct platform package via \`optionalDependencies\`
with \`os\`/\`cpu\` constraints.

## Packages

| Package | Platform | Size |
|---------|----------|------|
| \`@sdl-mcp/ladybug\` | All (JS wrapper) | ~50 KB |
| \`@sdl-mcp/ladybug-win32-x64\` | Windows x64 | ~13 MB |
| \`@sdl-mcp/ladybug-linux-x64\` | Linux x64 | ~25 MB |
| \`@sdl-mcp/ladybug-linux-arm64\` | Linux ARM64 | ~24 MB |
| \`@sdl-mcp/ladybug-darwin-arm64\` | macOS ARM64 | ~18 MB |

## API

100% compatible with \`@ladybugdb/core\`. Just change your import:

\`\`\`js
// Before
const kuzu = require("@ladybugdb/core");
// After
const kuzu = require("@sdl-mcp/ladybug");
\`\`\`

## License

MIT (same as upstream LadybugDB)
`);

console.log(`  built: ${SCOPE}/${PKG_BASE} (wrapper)`);
console.log();
console.log("Done! Packages ready in:", outDir);
console.log();
console.log("To publish:");
for (const plat of PLATFORMS) {
  console.log(`  cd ${join(outDir, `${PKG_BASE}-${plat.os}-${plat.cpu}`)} && npm publish --access public`);
}
console.log(`  cd ${join(outDir, PKG_BASE)} && npm publish --access public`);
console.log();
console.log("Then update sdl-mcp/package.json:");
console.log(`  "kuzu": "npm:${SCOPE}/${PKG_BASE}@${WRAPPER_VERSION}"`);
