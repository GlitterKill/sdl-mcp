# Provider-First LSP Shell Validation Attempt - 2026-06-16

This validation uses `bats-core/bats-core` as the Shell/Bash Wave 0 repository. It proves the SDL-MCP LSP provider-first execution path can run against a real repo with LSP-IO-managed server configuration, materialize LSP-owned graph rows, activate the shadow graph, pass the provider-first graph gate, and serve the normal symbol/slice/source-window smoke ladder.

Repository:

`F:\Claude\projects\sdl-lsp-provider-first-repos\bats-core`

Graph database:

`F:\Claude\projects\sdl-lsp-provider-first-repos\bats-core\.tmp\sdl-provider-first-lsp-shell-fixed.lbug`

## LSP-IO Setup

Command:

```powershell
cargo run --manifest-path F:\Claude\projects\lsp-io\Cargo.toml -p lsp-io-cli -- install bash-language-server
```

Result:

```text
Installed bash-language-server 5.6.0
Command: C:\Users\glitt\AppData\Local\lsp-io\servers\bash-language-server\npm\node_modules\.bin\bash-language-server.cmd
```

Export command:

```powershell
cargo run --manifest-path F:\Claude\projects\lsp-io\Cargo.toml -p lsp-io-cli -- export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\bats-core --include-missing --output F:\Claude\projects\sdl-lsp-provider-first-repos\bats-core\sdl-lsp-export.json
```

Relevant result:

```text
Exported 10 SDL-MCP server entries
bash-language-server readiness: ready
```

## Provider-First Index

Command:

```powershell
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\bats-core\.tmp\sdl-provider-first-lsp-shell-fixed.lbug'
node dist\cli\index.js -c F:\Claude\projects\sdl-lsp-provider-first-repos\bats-core\sdlmcp.shell.config.json index --repo-id bats-core-shell --force
```

Relevant result:

```text
Provider-first: lspFull (provider-first-lsp:...)
Provider-first shadow DB finalized: files=54 symbols=474 edges=0 versions=1 metrics=474 fileSummaries=54 copy=bulkCsv artifacts=20
Provider-first shadow DB activated: F:/Claude/projects/sdl-lsp-provider-first-repos/bats-core/.tmp/sdl-provider-first-lsp-shell-fixed.lbug
Provider-first coverage: 54/54 files provider-primary (0 full, 54 partial)
Symbols: 474 new (474 total)
```

The Shell provider-primary rows are partial because this wave materializes document symbols and diagnostics, not references/call proof. Same-run legacy fallback remains the path for uncovered facts until definitions/references are collected.

## Graph Check

Command:

```powershell
npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\bats-core\.tmp\sdl-provider-first-lsp-shell-fixed.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\bats-core
```

Result:

```text
PASS provider-first graph check: 0/5 gate(s) failed
```

This validates graph integrity after LSP provider materialization and shadow activation.

## Smoke Queries

`symbol.search` returned symbols from the indexed graph. First symbol used for follow-up checks:

```text
6d560e12f4f87f4b536110cdd0db418162c2e8fab48a601820ccfd7e096678a3
```

`symbol.getCard` returned a card for `BATS_EXE_CONTENTS` in `install.sh`.

`slice.build` succeeded:

```text
sliceHandle: 0736d31e9cb13c6e0e9a5031c8fdac4f
fileIds: bats-core-shell:install.sh
```

`code.getHotPath` returned the expected excerpt around `BATS_EXE_CONTENTS`.

`code.needWindow` succeeded:

```text
approved: true
file: install.sh
range: L26
whyApproved: Identifiers matched: BATS_EXE_CONTENTS
```

## Outcome

Shell/Bash is marked validated for Wave 0 provider-first LSP document-symbol materialization. Remaining quality work should collect definitions/references from `bash-language-server` so provider coverage can move beyond partial and produce exact edges.
