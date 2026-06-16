# Provider-First LSP Lua Validation - 2026-06-16

This validation uses `nvim-lua/plenary.nvim` as the Lua Wave 1 repository. It proves the Lua lazy language-pack path can install and resolve a parser pack only after Lua is configured, consume `lsp-io` exported server config, materialize LSP-owned provider facts across the full repository, pass the provider-first graph gate, and serve the normal symbol/card/slice/source-window smoke ladder.

Repository:

`F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim`

Graph database:

`F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim\.tmp\sdl-provider-first-lsp-lua-full.lbug`

## LSP-IO Setup

Status command:

```powershell
cargo run --manifest-path F:\Claude\projects\lsp-io\Cargo.toml -p lsp-io-cli -- status
```

Relevant result:

```text
lua-language-server                Lua                    managed        github release
```

Detect command:

```powershell
cargo run --manifest-path F:\Claude\projects\lsp-io\Cargo.toml -p lsp-io-cli -- detect --all-evidence F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim
```

Relevant result:

```text
Lua    Programming    High    .luacheckrc, data\plenary\filetypes\base.lua, data\plenary\filetypes\builtin.lua, lua\luassert\array.lua, lua\luassert\assert.lua, +109 more
```

Export command:

```powershell
cargo run --manifest-path F:\Claude\projects\lsp-io\Cargo.toml -p lsp-io-cli -- export sdl-mcp --enable-semantic-enrichment F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim
```

Relevant result:

```json
{
  "serverId": "lua-language-server",
  "command": "C:\\Users\\glitt\\AppData\\Local\\lsp-io\\servers\\lua-language-server\\github-release\\bin\\lua-language-server.exe",
  "languages": ["lua"],
  "documentLanguageIds": ["lua"],
  "capabilities": ["documentSymbol", "diagnostics", "definition", "references"],
  "readiness": "ready"
}
```

## Lazy Parser Pack

The first configured Lua index run failed closed before scanning because `tree-sitter-lua` was absent from the SDL language-pack cache:

```text
Missing parser package for configured language lua. Install tree-sitter-lua or disable the language.
```

Direct package installation proved the package was available, and the implementation was corrected to invoke npm through `cmd.exe /d /s /c npm.cmd` on Windows because direct `execFile("npm.cmd", ...)` failed with `spawn EINVAL` in this environment.

Cache evidence after the retry:

```text
C:\Users\glitt\.sdl-mcp\cache\language-packs\node_modules\tree-sitter-lua
```

## Provider-First Index

Command:

```powershell
$env:SDL_CONFIG='F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim\sdlmcp.lua.full.config.json'
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim\.tmp\sdl-provider-first-lsp-lua-full.lbug'
node dist\cli\index.js -c $env:SDL_CONFIG index --repo-id plenary-lua --force
```

Relevant result:

```text
Provider-first: lspFull (provider-first-lsp:1781640159393)
Provider-first shadow DB activated: F:/Claude/projects/sdl-lsp-provider-first-repos/plenary.nvim/.tmp/sdl-provider-first-lsp-lua-full.lbug
Provider-first coverage: 113/113 files provider-primary (0 full, 113 partial)
Files: 113
Symbols: 11844 new (11844 total)
Edges: 0 new (0 total)
Duration: 400829ms
```

LSP provider-primary rows are partial because this wave materializes document symbols and diagnostics, not references/call proof.

## Graph Check

Command:

```powershell
npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim\.tmp\sdl-provider-first-lsp-lua-full.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim
```

Result:

```text
PASS provider-first graph check: 0/5 gate(s) failed
```

## Smoke Queries

`symbol.search` returned Lua symbols from the indexed graph:

```text
query=async total=5
1a8b53d793034c46bd8c0db4682f7bed6cd26e3e3d7ae465d8de05e02772276f lua/plenary/async_lib/api.lua function async
```

`symbol.getCard` returned a card for `async`:

```text
file: lua/plenary/async_lib/api.lua
range: L6-L13
kind: function
signature: function async
```

`slice.build` succeeded:

```text
sliceHandle: f25040a51e779984a0296f5cb711b713
ledgerVersion: v1781640410729
```

`code.needWindow` succeeded:

```text
approved: true
file: lua/plenary/async_lib/api.lua
range: L6-L13
whyApproved: Identifiers matched: async
```

## Outcome

Lua is validated for Wave 1 provider-first LSP document-symbol materialization across the full validation repository. Remaining quality work should collect definitions/references from `lua-language-server` so provider coverage can move beyond partial and produce exact edges.
