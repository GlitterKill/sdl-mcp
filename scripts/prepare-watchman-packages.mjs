#!/usr/bin/env node
/**
 * Stages official Watchman release archives into SDL-MCP npm platform packages.
 *
 * Watchman's upstream release assets are not consistently available for every
 * OS on the same tag. Keep the upstream tag pinned per platform and publish
 * SDL-MCP package versions independently from the Watchman upstream version.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WATCHMAN_NPM_DIR = join(ROOT, "watchman", "npm");

const WATCHMAN_ASSETS = [
  {
    packageDir: "linux-x64",
    packageName: "sdl-mcp-watchman-linux-x64",
    releaseTag: "v2026.06.15.00",
    assetName: "watchman-v2026.06.15.00-linux.zip",
    binaryRelativePath: join("vendor", "bin", "watchman"),
    wrapper: "linux",
  },
  {
    packageDir: "win32-x64",
    packageName: "sdl-mcp-watchman-win32-x64",
    releaseTag: "v2025.02.24.00",
    assetName: "watchman-v2025.02.24.00-windows.zip",
    binaryRelativePath: join("vendor", "bin", "watchman.exe"),
  },
];

async function main() {
  for (const asset of WATCHMAN_ASSETS) {
    await stageAsset(asset);
  }
}

async function stageAsset(asset) {
  const packageRoot = join(WATCHMAN_NPM_DIR, asset.packageDir);
  const tempRoot = mkdtempSync(join(tmpdir(), `sdl-watchman-${asset.packageDir}-`));
  const archivePath = join(tempRoot, asset.assetName);
  const extractRoot = join(tempRoot, "extract");
  const url = `https://github.com/facebook/watchman/releases/download/${asset.releaseTag}/${asset.assetName}`;

  try {
    console.log(`Downloading ${asset.assetName} for ${asset.packageName}`);
    await download(url, archivePath);
    mkdirSync(extractRoot, { recursive: true });
    unzip(archivePath, extractRoot);

    const sourceRoot = findExtractedRoot(extractRoot);
    const vendorRoot = join(packageRoot, "vendor");
    rmSync(vendorRoot, { recursive: true, force: true });
    cpSync(sourceRoot, vendorRoot, { recursive: true });

    const binaryPath = join(packageRoot, asset.binaryRelativePath);
    if (!existsSync(binaryPath)) {
      throw new Error(`Expected Watchman binary missing: ${binaryPath}`);
    }

    if (asset.wrapper === "linux") {
      writeLinuxWrapper(packageRoot);
      chmodSync(binaryPath, 0o755);
    }

    writeFileSync(
      join(packageRoot, "README.md"),
      `# ${asset.packageName}\n\n` +
        `Contains Watchman ${asset.releaseTag} staged from ${url}.\n`,
      "utf8",
    );
    console.log(`Staged ${asset.packageName}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { "User-Agent": "sdl-mcp-release" },
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, buffer);
}

function unzip(archivePath, destination) {
  const result = spawnSync("unzip", ["-q", archivePath, "-d", destination], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `unzip failed for ${basename(archivePath)}: ${result.stderr || result.stdout}`,
    );
  }
}

function findExtractedRoot(extractRoot) {
  const entries = readdirSync(extractRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 1) {
    return join(extractRoot, directories[0].name);
  }
  return extractRoot;
}

function writeLinuxWrapper(packageRoot) {
  const binDir = join(packageRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  const wrapperPath = join(binDir, "watchman");
  writeFileSync(
    wrapperPath,
    `#!/usr/bin/env sh\n` +
      `set -eu\n` +
      `SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n` +
      `ROOT_DIR=$(dirname -- "$SELF_DIR")\n` +
      `export LD_LIBRARY_PATH="$ROOT_DIR/vendor/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\n` +
      `exec "$ROOT_DIR/vendor/bin/watchman" "$@"\n`,
    "utf8",
  );
  chmodSync(wrapperPath, 0o755);
}

await main();
