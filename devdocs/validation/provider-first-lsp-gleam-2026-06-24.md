# Gleam Provider-First LSP Validation - 2026-06-24

## Scope

- Language: Gleam
- Validation repo: gleam-lang/stdlib
- Local path: F:/Claude/projects/sdl-lsp-provider-first-repos/gleam-stdlib
- SDL graph DB: F:/Claude/projects/sdl-lsp-provider-first-repos/gleam-stdlib/.tmp/sdl-provider-first-lsp-gleam.lbug
- LSP-IO server: gleam-lsp

## Lazy Parser Pack

Before the first Gleam-configured index, tree-sitter-gleam was not installed in the SDL language-pack cache. The configured Gleam index installed tree-sitter-gleam on demand; it was not added to root package dependencies.

## LSP-IO Export

After the lsp-io registry fix, export emitted the Gleam compiler LSP subcommand:

```json
{
  "serverId": "gleam-lsp",
  "command": "C:/Users/glitt/AppData/Local/lsp-io/servers/gleam-lsp/github-release/gleam.exe",
  "args": ["lsp"],
  "languages": ["gleam"],
  "documentLanguageIds": ["gleam"],
  "filePatterns": ["**/*.gleam", "**/gleam.toml"],
  "capabilities": ["documentSymbol", "diagnostics", "definition", "references"],
  "readiness": "ready"
}
```

Validated with:

```powershell
cargo test -p lsp-io-core gleam_lsp_uses_compiler_lsp_subcommand
cargo run -q -p lsp-io-cli -- export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\gleam-stdlib --validate-launch
```

## Provider-First Index

Command:

```powershell
$env:SDL_CONFIG = "F:/Claude/projects/sdl-lsp-provider-first-repos/gleam-stdlib/sdlmcp.gleam.config.json"
$env:SDL_GRAPH_DB_PATH = "F:/Claude/projects/sdl-lsp-provider-first-repos/gleam-stdlib/.tmp/sdl-provider-first-lsp-gleam.lbug"
node dist/cli/index.js -c $env:SDL_CONFIG index --repo-id gleam-stdlib --force
```

Result:

- Index completed successfully in 95.5s.
- Provider-first mode: lspFull.
- Provider-first coverage: 18/42 files provider-primary, 2 provider-unusable, 22 uncovered.
- Files: 60.
- Symbols: 518.
- Provider run: gleam-lsp completed, documentsProcessed=20, symbolsMatched=518, diagnosticsCount=62.
- Graph check: npm run check:provider-first-graph passed with 0/5 failed gates.

## Smoke Checks

Symbol used: 0e82eadc0097855207c87462ce3d65a96ad4ab1bcefcf93da29d421c7309a822 (from_string in src/gleam/bit_array.gleam).

Commands:

```powershell
node dist/cli/index.js tool symbol.search --repo-id gleam-stdlib --query from_string --limit 3 --json
node dist/cli/index.js tool symbol.getCard --repo-id gleam-stdlib --symbol-id 0e82eadc0097855207c87462ce3d65a96ad4ab1bcefcf93da29d421c7309a822 --json
node dist/cli/index.js tool slice.build --repo-id gleam-stdlib --entry-symbols 0e82eadc0097855207c87462ce3d65a96ad4ab1bcefcf93da29d421c7309a822 --task-text "inspect Gleam from_string provider-first slice" --max-cards 5 --max-tokens 3000 --json
node dist/cli/index.js tool code.needWindow --repo-id gleam-stdlib --symbol-id 0e82eadc0097855207c87462ce3d65a96ad4ab1bcefcf93da29d421c7309a822 --reason "provider-first Gleam smoke validation" --expected-lines 20 --identifiers from_string --json
```

Results:

- symbol.search returned from_string.
- symbol.getCard returned the function card with file src/gleam/bit_array.gleam and range 7:0-14:29.
- slice.build returned slice handle 8413bbab4ce01261eda52b7749637ff0.
- code.needWindow approved the source window and matched identifier from_string.
