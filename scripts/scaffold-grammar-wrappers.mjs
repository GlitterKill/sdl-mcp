#!/usr/bin/env node
/**
 * scaffold-grammar-wrappers.mjs
 *
 * One-shot generator for the 11 sdl-mcp-tree-sitter-* wrapper packages under
 * grammar-wrappers/. Idempotent: re-running overwrites package.json / index.js /
 * index.d.ts / README.md / LICENSE with the authoritative template. Edit the
 * WRAPPERS table below and re-run to bump upstream pins.
 *
 * Why wrappers exist: upstream tree-sitter grammars declare peer
 * `tree-sitter@^0.2x` ranges that reject sdl-mcp's `@keqingmoe/tree-sitter@0.26.2`
 * alias (Node 24 / C++20 compat fix). Each wrapper re-exports its upstream
 * grammar unchanged but declares a permissive peer range so consumers installing
 * sdl-mcp see zero `ERESOLVE overriding peer dependency` warnings.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = dirname(__dirname);
const WRAPPERS_DIR = join(REPO_ROOT, "grammar-wrappers");

const WRAPPER_VERSION = "1.0.1";
// Upper bound prevents a future breaking upstream `tree-sitter@1.0.0` from
// silently satisfying our peer range. Adjust if tree-sitter's versioning
// conventions change.
const PEER_RANGE = ">=0.21.0 <1.0.0";

// Upstream grammar versions pinned at ~minor per plan.
// Bump entries here, then re-run scaffold + republish affected wrappers.
const WRAPPERS = [
  {
    name: "sdl-mcp-tree-sitter-bash",
    upstream: "tree-sitter-bash",
    pin: "~0.25.1",
  },
  { name: "sdl-mcp-tree-sitter-c", upstream: "tree-sitter-c", pin: "~0.24.1" },
  // c-sharp@0.23.5 converted to ESM (top-level await in bindings/node/index.js)
  // and cannot be loaded from CJS consumers. Use EXACT pin at 0.23.1 (last CJS
  // release) — ~0.23.1 would resolve up through 0.23.5. Revisit when upstream
  // ships a CJS-compatible update.
  {
    name: "sdl-mcp-tree-sitter-c-sharp",
    upstream: "tree-sitter-c-sharp",
    pin: "0.23.1",
  },
  {
    name: "sdl-mcp-tree-sitter-cpp",
    upstream: "tree-sitter-cpp",
    pin: "~0.23.4",
  },
  {
    name: "sdl-mcp-tree-sitter-go",
    upstream: "tree-sitter-go",
    pin: "~0.25.0",
  },
  {
    name: "sdl-mcp-tree-sitter-java",
    upstream: "tree-sitter-java",
    pin: "~0.23.5",
  },
  {
    name: "sdl-mcp-tree-sitter-kotlin",
    upstream: "tree-sitter-kotlin",
    pin: "~0.3.8",
  },
  {
    name: "sdl-mcp-tree-sitter-php",
    upstream: "tree-sitter-php",
    pin: "~0.24.2",
  },
  {
    name: "sdl-mcp-tree-sitter-python",
    upstream: "tree-sitter-python",
    pin: "~0.25.0",
  },
  {
    name: "sdl-mcp-tree-sitter-rust",
    upstream: "tree-sitter-rust",
    pin: "~0.24.0",
  },
  {
    name: "sdl-mcp-tree-sitter-typescript",
    upstream: "tree-sitter-typescript",
    pin: "~0.23.2",
  },
];

const LICENSE_TEXT = `MIT License

Copyright (c) 2026 sdl-mcp contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function buildPackageJson({ name, upstream, pin }) {
  return (
    JSON.stringify(
      {
        name,
        version: WRAPPER_VERSION,
        description: `sdl-mcp peer-range wrapper around ${upstream}. Re-exports upstream unchanged with a permissive tree-sitter peer range (${PEER_RANGE}) so installs of sdl-mcp avoid ERESOLVE peer-dependency warnings.`,
        main: "index.js",
        types: "index.d.ts",
        license: "MIT",
        repository: {
          type: "git",
          url: "git+https://github.com/GlitterKill/sdl-mcp.git",
          directory: `grammar-wrappers/${name}`,
        },
        homepage: "https://github.com/GlitterKill/sdl-mcp#readme",
        bugs: { url: "https://github.com/GlitterKill/sdl-mcp/issues" },
        keywords: ["tree-sitter", "sdl-mcp", "wrapper", upstream],
        files: ["index.js", "index.d.ts", "LICENSE", "README.md"],
        dependencies: {
          "upstream-grammar": `npm:${upstream}@${pin}`,
        },
        bundleDependencies: ["upstream-grammar"],
        peerDependencies: {
          "tree-sitter": PEER_RANGE,
        },
        peerDependenciesMeta: {
          "tree-sitter": { optional: true },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function buildIndexJs({ upstream }) {
  return `// Re-export of ${upstream} with a permissive tree-sitter peer range.
// Generated by scripts/scaffold-grammar-wrappers.mjs — do not edit by hand.
"use strict";
module.exports = require("upstream-grammar");
`;
}

function buildIndexDts({ upstream }) {
  // Upstream grammar packages export a single default binding plus occasional
  // named sub-grammars (typescript exports .typescript/.tsx; php exports .php).
  // Use the same shape that upstream publishes — a wildcard + default re-export
  // keeps sub-keys reachable without us needing to enumerate them.
  return `// Type re-export of ${upstream}.
// Generated by scripts/scaffold-grammar-wrappers.mjs — do not edit by hand.
declare const grammar: unknown;
export = grammar;
`;
}

function buildReadme({ name, upstream, pin }) {
  return `# ${name}

Peer-range wrapper around [\`${upstream}\`](https://www.npmjs.com/package/${upstream}) maintained by the [sdl-mcp](https://github.com/GlitterKill/sdl-mcp) project.

## Why this package exists

sdl-mcp aliases \`tree-sitter\` to \`@keqingmoe/tree-sitter@0.26.2\` for Node 24 / C++20 compatibility. Upstream \`${upstream}\` declares a narrower peer range that rejects 0.26.x, producing \`ERESOLVE overriding peer dependency\` warnings on install. This wrapper re-exports upstream unchanged but widens the peer range so consumers see no warnings.

## What it does

\`\`\`js
const grammar = require("${name}");
// equivalent to:
const grammar = require("${upstream}");
\`\`\`

No native compilation happens here — the upstream grammar ships prebuilt \`.node\` binaries that are reused transitively.

## Pins

- Upstream pin: \`${pin}\`
- Wrapper version: \`${WRAPPER_VERSION}\`
- Peer \`tree-sitter\`: \`${PEER_RANGE}\` (optional)

Bump by editing [\`scripts/scaffold-grammar-wrappers.mjs\`](../../scripts/scaffold-grammar-wrappers.mjs) and re-running.

## License

MIT (matches upstream).
`;
}

function writeWrapper(wrapper) {
  const dir = join(WRAPPERS_DIR, wrapper.name);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, "package.json"), buildPackageJson(wrapper));
  writeFileSync(join(dir, "index.js"), buildIndexJs(wrapper));
  writeFileSync(join(dir, "index.d.ts"), buildIndexDts(wrapper));
  writeFileSync(join(dir, "README.md"), buildReadme(wrapper));
  writeFileSync(join(dir, "LICENSE"), LICENSE_TEXT);

  return dir;
}

function main() {
  mkdirSync(WRAPPERS_DIR, { recursive: true });
  const created = [];
  for (const wrapper of WRAPPERS) {
    const dir = writeWrapper(wrapper);
    created.push(
      `${wrapper.name} (upstream ${wrapper.upstream}${wrapper.pin}) -> ${dir}`,
    );
  }
  console.log(`Scaffolded ${created.length} wrapper(s):`);
  for (const line of created) console.log(`  ${line}`);
}

main();
