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
  const platformPkg = `@sdl-mcp/ladybug-${platform}-${arch}`;

  // 1. Try the platform-specific package
  try {
    const pkgDir = localRequire.resolve(`${platformPkg}/package.json`);
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
    `No LadybugDB binary found for ${platform}-${arch}. \n` +
    `Install the platform package: npm install ${platformPkg}`
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
