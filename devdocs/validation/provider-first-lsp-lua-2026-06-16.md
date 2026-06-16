# Provider-First LSP Lua Validation Attempt - 2026-06-16

This validation uses `nvim-lua/plenary.nvim` as the Lua Wave 1 repository. It proves the Lua lazy language-pack path can install/resolve a parser pack only after Lua is configured, consume `lsp-io` exported server config, materialize LSP-owned provider facts, pass the provider-first graph gate, and serve the normal symbol/card/slice/source-window smoke ladder on a bounded real-repo subset.

Repository:

`F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim`

Graph database:

`F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim\.tmp\sdl-provider-first-lsp-lua-subset.lbug`

Source file list:

`F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim\.tmp\lua-source-list.txt`

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

The full repo attempt was started first, but it remained running without DB progress after the client tool timeout. The validation PIDs were stopped and the run was narrowed to a deterministic 40-file source list for bounded evidence.

Command:

```powershell
$env:SDL_CONFIG='F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim\sdlmcp.lua.config.json'
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim\.tmp\sdl-provider-first-lsp-lua-subset.lbug'
node dist\cli\index.js -c $env:SDL_CONFIG index --repo-id plenary-lua --force
```

Relevant result:

```text
Provider-first: lspFull (provider-first-lsp:1781635876561)
Provider-first shadow staging skipped: shadow staging skipped because repo.sourceFileListPath scopes this run to a benchmark subset
Provider-first coverage: 40/40 files provider-primary (0 full, 40 partial)
Files: 40
Symbols: 3245 new (3245 total)
Edges: 0 new (0 total)
Duration: 140532ms
```

LSP provider-primary rows are partial because this wave materializes document symbols and diagnostics, not references/call proof. Shadow activation is intentionally skipped for source-list subset runs.

## Graph Check

Command:

```powershell
npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim\.tmp\sdl-provider-first-lsp-lua-subset.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\plenary.nvim
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
sliceHandle: 7a2725546c5eb0319258ee4695856646
ledgerVersion: v1781635966010
```

`code.needWindow` succeeded:

```text
approved: true
file: lua/plenary/async_lib/api.lua
range: L6-L13
whyApproved: Identifiers matched: async
```

## Outcome

Lua is implementation-ready and subset-validated for Wave 1 provider-first LSP document-symbol materialization. It should remain marked as partial/pending until full-repo validation completes without requiring a source-list cap and shadow staging can activate.
