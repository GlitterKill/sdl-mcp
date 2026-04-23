# sdl-mcp-tree-sitter-c

Peer-range wrapper around [`tree-sitter-c`](https://www.npmjs.com/package/tree-sitter-c) maintained by the [sdl-mcp](https://github.com/GlitterKill/sdl-mcp) project.

## Why this package exists

sdl-mcp aliases `tree-sitter` to `@keqingmoe/tree-sitter@0.26.2` for Node 24 / C++20 compatibility. Upstream `tree-sitter-c` declares a narrower peer range that rejects 0.26.x, producing `ERESOLVE overriding peer dependency` warnings on install. This wrapper re-exports upstream unchanged but widens the peer range so consumers see no warnings.

## What it does

```js
const grammar = require("sdl-mcp-tree-sitter-c");
// equivalent to:
const grammar = require("tree-sitter-c");
```

No native compilation happens here — the upstream grammar ships prebuilt `.node` binaries that are reused transitively.

## Pins

- Upstream pin: `~0.24.1`
- Wrapper version: `1.0.0`
- Peer `tree-sitter`: `>=0.21.0` (optional)

Bump by editing [`scripts/scaffold-grammar-wrappers.mjs`](../../scripts/scaffold-grammar-wrappers.mjs) and re-running.

## License

MIT (matches upstream).
