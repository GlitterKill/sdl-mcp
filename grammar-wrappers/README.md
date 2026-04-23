# sdl-mcp grammar wrappers

Eleven tiny npm packages (`sdl-mcp-tree-sitter-*`) that exist solely to silence `ERESOLVE overriding peer dependency` warnings during `npm install sdl-mcp`.

## Why these exist

sdl-mcp aliases `tree-sitter` to `@keqingmoe/tree-sitter@0.26.2` (Node 24 / C++20 compat fix — see [commit 73e5856](https://github.com/GlitterKill/sdl-mcp/commit/73e5856)). Upstream `tree-sitter` is stuck at 0.25.0 and every upstream grammar declares a `peerOptional tree-sitter` range capped at `^0.25.0` or lower. That mismatch triggers ~10 warnings per consumer install. The warnings are cosmetic (installs succeed) but look broken.

Each wrapper:

1. Depends on the upstream grammar via an npm alias (`upstream-grammar: npm:tree-sitter-c@~0.24.1`).
2. Uses `bundleDependencies` to ship the upstream grammar **inside** the wrapper's own tarball. npm does not re-resolve bundled deps, so the upstream grammar's narrow peer range is never evaluated at consumer install.
3. Declares its own permissive `peerDependencies: { "tree-sitter": ">=0.21.0" }` (optional) that matches keqingmoe@0.26.2.
4. Re-exports upstream unchanged via `module.exports = require("upstream-grammar")`.

The upstream grammar's prebuilt `.node` binaries ship transitively in the bundled `node_modules/upstream-grammar/prebuilds/` dir, so no compilation happens at consumer install.

## Package matrix

| Wrapper | Upstream pin | Notes |
|---------|--------------|-------|
| `sdl-mcp-tree-sitter-bash` | `~0.25.1` | |
| `sdl-mcp-tree-sitter-c` | `~0.24.1` | |
| `sdl-mcp-tree-sitter-c-sharp` | `0.23.1` (exact) | 0.23.5 is ESM; CJS consumers can't `require()` it. |
| `sdl-mcp-tree-sitter-cpp` | `~0.23.4` | |
| `sdl-mcp-tree-sitter-go` | `~0.25.0` | |
| `sdl-mcp-tree-sitter-java` | `~0.23.5` | |
| `sdl-mcp-tree-sitter-kotlin` | `~0.3.8` | No Rust-native support; JS-only path. |
| `sdl-mcp-tree-sitter-php` | `~0.24.2` | Multi-export (`.php`). |
| `sdl-mcp-tree-sitter-python` | `~0.25.0` | |
| `sdl-mcp-tree-sitter-rust` | `~0.24.0` | |
| `sdl-mcp-tree-sitter-typescript` | `~0.23.2` | Multi-export (`.typescript`, `.tsx`). |

All wrappers are versioned independently starting at `1.0.0`. Wrapper version bumps do not need to track upstream version bumps — only republish a wrapper when its upstream pin changes or its own wrapper code changes.

## Bumping an upstream pin

1. Check the new upstream version is still CJS: `npm view tree-sitter-<lang>@<version> type`. If it prints `module`, STOP — ESM grammars break sdl-mcp's CJS `grammarLoader.ts`.
2. Edit the `WRAPPERS` table in [`scripts/scaffold-grammar-wrappers.mjs`](../scripts/scaffold-grammar-wrappers.mjs). Use `~X.Y.Z` for patch-level updates or an exact `X.Y.Z` pin to lock to a single version.
3. `node scripts/scaffold-grammar-wrappers.mjs` — regenerates all wrapper files idempotently.
4. `cd grammar-wrappers/<wrapper>` → `rm -rf node_modules package-lock.json` → `npm install --ignore-scripts`.
5. Bump the wrapper's `version` field in its `package.json` (patch bump if only the upstream pin changed).
6. Run the manifest drift test: `npm run test -- tests/unit/grammar-wrapper-manifest.test.ts`.
7. Publish: `cd grammar-wrappers/<wrapper> && npm publish --access public --provenance`.

## Local smoke test

Verify a wrapper end-to-end without publishing:

```bash
cd grammar-wrappers/sdl-mcp-tree-sitter-c
npm install --ignore-scripts
npm pack

mkdir /tmp/wrapper-test && cd /tmp/wrapper-test
npm init -y
npm install \
  "F:/Claude/projects/sdl-mcp/sdl-mcp/grammar-wrappers/sdl-mcp-tree-sitter-c/sdl-mcp-tree-sitter-c-1.0.0.tgz" \
  "tree-sitter@npm:@keqingmoe/tree-sitter@0.26.2"

# Expect zero "ERESOLVE overriding peer" warnings.
node -e "const P=require('tree-sitter');const C=require('sdl-mcp-tree-sitter-c');const p=new P();p.setLanguage(C);console.log(p.parse('int x;').rootNode.type);"
# → translation_unit
```

## How sdl-mcp consumes these

[sdl-mcp/package.json](../package.json) aliases the upstream grammar name to the wrapper, so `grammarLoader.ts`'s `require("tree-sitter-c")` resolves to the wrapper with no code change:

```json
"dependencies": {
  "tree-sitter": "npm:@keqingmoe/tree-sitter@0.26.2",
  "tree-sitter-c": "npm:sdl-mcp-tree-sitter-c@^1.0.0",
  ...
}
```

## Long-term exit

These wrappers can be deprecated and the aliases removed once either:

- Upstream `tree-sitter` ships a 0.26.x release (allowing sdl-mcp to drop the keqingmoe alias), **or**
- Every upstream grammar bumps its `tree-sitter` peer range to accept 0.26.x.

Until then, the wrappers are the cheapest way to keep `npm install sdl-mcp` quiet.
