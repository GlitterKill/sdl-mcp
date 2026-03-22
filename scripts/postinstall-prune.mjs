#!/usr/bin/env node
/**
 * postinstall-prune.mjs
 *
 * Prunes unnecessary platform binaries and source files from native
 * dependencies after npm install. Saves ~750 MB on a typical install.
 *
 * Section 1 — LadybugDB (kuzu):
 *   - prebuilt/ binaries for non-native platforms
 *   - lbug-source/ C++ source tree + test datasets
 *
 * Section 2 — Tree-sitter grammars:
 *   - src/ directories (generated C parser files, only needed for compiling
 *     from source; runtime uses prebuilt .node binaries)
 *   - prebuilds/ subdirectories for non-native platforms
 *
 * Section 3 — ONNX Runtime:
 *   - bin/napi-v6/ subdirectories for non-native platforms
 */

import { rm, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platform, arch } from "node:process";

const nodeModulesDir = resolve(
  new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1"),
  "..",
  "node_modules",
);

const NATIVE_PLATFORM = `${platform}-${arch}`;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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

async function rmSafe(p) {
  const size = await dirSize(p);
  try {
    await rm(p, { recursive: true, force: true });
    return size;
  } catch (err) {
    console.warn(`  warning: could not remove ${p}: ${err.message}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Section 1: LadybugDB (kuzu) pruning
// ---------------------------------------------------------------------------

async function pruneKuzu() {
  const kuzuDir = join(nodeModulesDir, "kuzu");
  if (!(await dirExists(kuzuDir))) return 0;

  let saved = 0;

  // 1a. Remove prebuilt binaries for other platforms
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
            saved += size;
            console.log(`  pruned: kuzu/prebuilt/${file} (${formatMB(size)})`);
          } catch (err) {
            console.warn(`  warning: could not remove ${file}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`  warning: could not read prebuilt dir: ${err.message}`);
    }
  }

  // 1b. Remove the entire lbug-source directory (C++ source + test datasets)
  const sourceDir = join(kuzuDir, "lbug-source");
  if (await dirExists(sourceDir)) {
    const freed = await rmSafe(sourceDir);
    saved += freed;
    if (freed > 0) console.log(`  pruned: kuzu/lbug-source/ (${formatMB(freed)})`);
  }

  return saved;
}

// ---------------------------------------------------------------------------
// Section 2: Tree-sitter grammar pruning
// ---------------------------------------------------------------------------

// Packages with standard layout: src/ at top level, prebuilds/ at top level
const TREE_SITTER_STANDARD = [
  "tree-sitter-bash",
  "tree-sitter-c",
  "tree-sitter-c-sharp",
  "tree-sitter-cpp",
  "tree-sitter-go",
  "tree-sitter-java",
  "tree-sitter-javascript",
  "tree-sitter-python",
  "tree-sitter-rust",
];

// Packages with non-standard src/ layout
const TREE_SITTER_CUSTOM_SRC = {
  "tree-sitter-typescript": ["typescript/src", "tsx/src"],
  "tree-sitter-php": ["php/src", "php_only/src"],
};

// Packages with src/ but no prebuilds/ (use node-gyp build/ instead)
const TREE_SITTER_NO_PREBUILDS = ["tree-sitter-kotlin"];

async function pruneTreeSitterPackage(pkgName, srcPaths, hasPrebuilds) {
  const pkgDir = join(nodeModulesDir, pkgName);
  if (!(await dirExists(pkgDir))) return 0;

  let saved = 0;

  // Remove src/ directories (C grammar sources — not needed when prebuilds exist)
  for (const srcPath of srcPaths) {
    const fullPath = join(pkgDir, srcPath);
    if (await dirExists(fullPath)) {
      const freed = await rmSafe(fullPath);
      saved += freed;
      if (freed > 0) console.log(`  pruned: ${pkgName}/${srcPath}/ (${formatMB(freed)})`);
    }
  }

  // Remove non-native prebuilds
  if (hasPrebuilds) {
    const prebuildsDir = join(pkgDir, "prebuilds");
    if (await dirExists(prebuildsDir)) {
      try {
        const platforms = await readdir(prebuildsDir);
        for (const plat of platforms) {
          if (plat !== NATIVE_PLATFORM) {
            const platDir = join(prebuildsDir, plat);
            if (await dirExists(platDir)) {
              const freed = await rmSafe(platDir);
              saved += freed;
              if (freed > 0) console.log(`  pruned: ${pkgName}/prebuilds/${plat}/ (${formatMB(freed)})`);
            }
          }
        }
      } catch (err) {
        console.warn(`  warning: could not read ${pkgName}/prebuilds/: ${err.message}`);
      }
    }
  }

  return saved;
}

async function pruneTreeSitter() {
  let saved = 0;

  // Standard packages: src/ at top level + prebuilds/
  for (const pkg of TREE_SITTER_STANDARD) {
    saved += await pruneTreeSitterPackage(pkg, ["src"], true);
  }

  // Custom src/ layouts + prebuilds/
  for (const [pkg, srcPaths] of Object.entries(TREE_SITTER_CUSTOM_SRC)) {
    saved += await pruneTreeSitterPackage(pkg, srcPaths, true);
  }

  // Packages with src/ but node-gyp build/ (no prebuilds to prune)
  for (const pkg of TREE_SITTER_NO_PREBUILDS) {
    saved += await pruneTreeSitterPackage(pkg, ["src"], false);
  }

  return saved;
}

// ---------------------------------------------------------------------------
// Section 3: ONNX Runtime pruning
// ---------------------------------------------------------------------------

async function pruneOnnxRuntime() {
  const onnxBinDir = join(nodeModulesDir, "onnxruntime-node", "bin", "napi-v6");
  if (!(await dirExists(onnxBinDir))) return 0;

  let saved = 0;

  // platform names in onnxruntime-node: "darwin", "linux", "win32"
  try {
    const platforms = await readdir(onnxBinDir);
    for (const plat of platforms) {
      if (plat !== platform) {
        const platDir = join(onnxBinDir, plat);
        if (await dirExists(platDir)) {
          const freed = await rmSafe(platDir);
          saved += freed;
          if (freed > 0) console.log(`  pruned: onnxruntime-node/bin/napi-v6/${plat}/ (${formatMB(freed)})`);
        }
      }
    }
  } catch (err) {
    console.warn(`  warning: could not read onnxruntime-node bin dir: ${err.message}`);
  }

  return saved;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  let totalSaved = 0;

  const kuzuSaved = await pruneKuzu();
  totalSaved += kuzuSaved;

  const treeSitterSaved = await pruneTreeSitter();
  totalSaved += treeSitterSaved;

  const onnxSaved = await pruneOnnxRuntime();
  totalSaved += onnxSaved;

  if (totalSaved > 0) {
    console.log(`sdl-mcp postinstall: pruned ${formatMB(totalSaved)} of unused platform files`);
  }
}

run().catch((err) => {
  // postinstall failures should never break npm install
  console.warn(`sdl-mcp: postinstall prune warning: ${err.message}`);
});
