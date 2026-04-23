# sdl-mcp-tree-sitter-php

Peer-range wrapper around [`tree-sitter-php`](https://www.npmjs.com/package/tree-sitter-php) maintained by the [sdl-mcp](https://github.com/GlitterKill/sdl-mcp) project.

## Why this package exists

sdl-mcp aliases `tree-sitter` to `@keqingmoe/tree-sitter@0.26.2` for Node 24 / C++20 compatibility. Upstream `tree-sitter-php` declares a narrower peer range that rejects 0.26.x, producing `ERESOLVE overriding peer dependency` warnings on install. This wrapper re-exports upstream unchanged but widens the peer range so consumers see no warnings.

## What it does

```js
const grammar = require("sdl-mcp-tree-sitter-php");
// equivalent to:
const grammar = require("tree-sitter-php");
```

No native compilation happens here — the upstream grammar ships prebuilt `.node` binaries that are reused transitively.

## Pins

- Upstream pin: `~0.24.2`
- Wrapper version: `1.0.0`
- Peer `tree-sitter`: `>=0.21.0` (optional)

Bump by editing [`scripts/scaffold-grammar-wrappers.mjs`](../../scripts/scaffold-grammar-wrappers.mjs) and re-running.

## License

MIT (matches upstream).
