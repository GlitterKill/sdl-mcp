# @sdl-mcp/ladybug

LadybugDB 0.15.1 repackaged with per-platform native binaries.

## Why?

The upstream `@ladybugdb/core` npm package ships all platform binaries plus the
full C++ source tree (~496 MB installed). This repackaging splits the native
binaries into platform-specific optional dependencies, so you only download the
binary for your platform (~13-25 MB).

## Install

```bash
npm install @sdl-mcp/ladybug
```

npm automatically selects the correct platform package via `optionalDependencies`
with `os`/`cpu` constraints.

## Packages

| Package | Platform | Size |
|---------|----------|------|
| `@sdl-mcp/ladybug` | All (JS wrapper) | ~50 KB |
| `@sdl-mcp/ladybug-win32-x64` | Windows x64 | ~13 MB |
| `@sdl-mcp/ladybug-linux-x64` | Linux x64 | ~25 MB |
| `@sdl-mcp/ladybug-linux-arm64` | Linux ARM64 | ~24 MB |
| `@sdl-mcp/ladybug-darwin-arm64` | macOS ARM64 | ~18 MB |

## API

100% compatible with `@ladybugdb/core`. Just change your import:

```js
// Before
const kuzu = require("@ladybugdb/core");
// After
const kuzu = require("@sdl-mcp/ladybug");
```

## License

MIT (same as upstream LadybugDB)
