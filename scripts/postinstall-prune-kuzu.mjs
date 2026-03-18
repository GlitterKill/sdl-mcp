#!/usr/bin/env node
/**
 * postinstall-prune-kuzu.mjs
 *
 * Prunes the kuzu (@ladybugdb/core) npm package after install.
 *
 * The upstream package ships:
 *   - prebuilt/ with binaries for ALL 4 platforms (~80 MB)
 *   - lbug-source/ with full C++ source tree + test datasets (~405 MB)
 *
 * After kuzu's own install.js copies the correct binary to lbugjs.node,
 * none of that is needed. This script removes it, saving ~470 MB.
 */

import { rm, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platform, arch } from "node:process";

const kuzuDir = resolve(
  new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1"),
  "..",
  "node_modules",
  "kuzu",
);

async function dirExists(p) {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function dirSize(p) {
  let total = 0;
  try {
    const entries = await readdir(p, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        try {
          const s = await stat(join(entry.parentPath ?? entry.path, entry.name));
          total += s.size;
        } catch {
          // skip inaccessible files
        }
      }
    }
  } catch {
    // directory doesn't exist
  }
  return total;
}

function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function run() {
  if (!(await dirExists(kuzuDir))) {
    // kuzu not installed (optional dependency) — nothing to do
    return;
  }

  let totalSaved = 0;

  // 1. Remove prebuilt binaries for other platforms
  const prebuiltDir = join(kuzuDir, "prebuilt");
  if (await dirExists(prebuiltDir)) {
    const currentBinary = `lbugjs-${platform}-${arch}.node`;
    try {
      const files = await readdir(prebuiltDir);
      for (const file of files) {
        if (file !== currentBinary && file.endsWith(".node")) {
          const filePath = join(prebuiltDir, file);
          try {
            const s = await stat(filePath);
            const size = s.size;
            await rm(filePath, { force: true });
            totalSaved += size;
            console.log(`  pruned: prebuilt/${file} (${formatMB(size)})`);
          } catch (err) {
            console.warn(`  warning: could not remove ${file}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`  warning: could not read prebuilt dir: ${err.message}`);
    }
  }

  // 2. Remove the entire lbug-source directory (C++ source + test datasets)
  const sourceDir = join(kuzuDir, "lbug-source");
  if (await dirExists(sourceDir)) {
    const size = await dirSize(sourceDir);
    try {
      await rm(sourceDir, { recursive: true, force: true });
      totalSaved += size;
      console.log(`  pruned: lbug-source/ (${formatMB(size)})`);
    } catch (err) {
      console.warn(`  warning: could not remove lbug-source/: ${err.message}`);
    }
  }

  if (totalSaved > 0) {
    console.log(`  ladybugdb pruned: saved ${formatMB(totalSaved)}`);
  }
}

run().catch((err) => {
  // postinstall failures should not break npm install
  console.warn(`sdl-mcp: ladybugdb prune warning: ${err.message}`);
});
