# Provider-First LSP Elixir Validation - 2026-06-17

This validation uses `elixir-plug/plug` as the Elixir Wave 2 repository. It proves the Elixir lazy language-pack path can resolve an on-demand parser pack after the repository config enables `elixir`, consume `lsp-io` exported Expert metadata, materialize LSP-owned provider facts, pass the provider-first graph gate, and serve the normal symbol/card/slice/source-window smoke ladder on a real repository.

## Repository

`F:\Claude\projects\sdl-lsp-provider-first-repos\plug`

## Graph DB

`F:\Claude\projects\sdl-lsp-provider-first-repos\plug\.tmp\sdl-provider-first-lsp-elixir.lbug`

## LSP-IO Status

```text
expert                             Elixir                 managed        github release
```

## LSP-IO Export

Command:

```powershell
cargo run --manifest-path F:\Claude\projects\lsp-io\Cargo.toml -p lsp-io-cli -- export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\plug --validate-launch
```

Relevant exported server:

```json
{
  "expert": {
    "enabled": true,
    "serverId": "expert",
    "command": "C:\\Users\\glitt\\AppData\\Local\\lsp-io\\servers\\expert\\github-release\\expert.exe",
    "args": ["--stdio"],
    "languages": ["elixir"],
    "documentLanguageIds": ["elixir"],
    "filePatterns": ["**/*.ex", "**/*.exs", "**/mix.exs"],
    "documentSymbolRetryCount": 1,
    "documentSymbolRetryDelayMs": 30000,
    "capabilities": ["documentSymbol", "diagnostics", "definition", "references"],
    "readiness": "ready"
  }
}
```

The Expert export includes `--stdio` and a first-document retry because Expert can return an empty `textDocument/documentSymbol` response before its project engine is initialized.

## Server Setup

Expert was installed and managed by `lsp-io`:

```text
C:\Users\glitt\AppData\Local\lsp-io\servers\expert\github-release\expert.exe
Expert 0.1.4
```

The validation PATH exposed the local Erlang/OTP and Elixir runtime used by Expert:

```text
C:\Users\glitt\AppData\Local\lsp-io\servers\expert\otp_win64_27.3.4.13\bin
C:\Users\glitt\AppData\Local\lsp-io\servers\expert\elixir-otp-27\bin
Erlang/OTP 27 [erts-15.2.7.9]
Elixir 1.20.1 (compiled with Erlang/OTP 27)
Mix 1.20.1 (compiled with Erlang/OTP 27)
```

## Parser Pack

Elixir is configured as a lazy language pack. The parser package is not a root SDL-MCP dependency; it resolves through the on-demand language-pack cache only when the repo config includes `elixir`.

```text
C:\Users\glitt\.sdl-mcp\cache\language-packs\node_modules\tree-sitter-elixir\package.json
name=tree-sitter-elixir
version=0.3.5
```

## Provider-First Index

Command:

```powershell
$env:Path='C:\Users\glitt\AppData\Local\lsp-io\servers\expert\elixir-otp-27\bin;C:\Users\glitt\AppData\Local\lsp-io\servers\expert\otp_win64_27.3.4.13\bin;' + $env:Path
$env:SDL_CONFIG='F:\Claude\projects\sdl-lsp-provider-first-repos\plug\sdlmcp.elixir.config.json'
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\plug\.tmp\sdl-provider-first-lsp-elixir.lbug'
node dist\cli\index.js -c $env:SDL_CONFIG index --repo-id plug-elixir --force
```

Result:

```text
Provider-first: lspFull (provider-first-lsp:1781664339280)
Provider-first timings: total=164454ms; slowest=collect 121227ms
Provider-first shadow staging: csv files=121 symbols=1176 externals=0 edges=0 (parquet requested)
Provider-first shadow DB finalized: files=121 symbols=1176 edges=0 versions=1 metrics=1176 fileSummaries=121 copy=bulkCsv artifacts=20
Provider-first shadow DB activated: F:/Claude/projects/sdl-lsp-provider-first-repos/plug/.tmp/sdl-provider-first-lsp-elixir.lbug
Provider-first coverage: 43/78 files provider-primary (0 full, 43 partial); 35 provider unusable; legacy fallback parsed 78 file(s)
Provider-first provider-unusable diagnostics: no usable provider symbols: 35 file(s)
Files: 121
Symbols: 1176 new (1176 total)
Edges: 0 new (0 total)
Duration: 164456ms
```

## Graph Gate

Command:

```powershell
npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\plug\.tmp\sdl-provider-first-lsp-elixir.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\plug --repo-id plug-elixir
```

Result:

```text
PASS provider-first graph check: 0/5 gate(s) failed
```

## Smoke Checks

`symbol.search` returned Elixir LSP symbols from the graph:

```text
query=Plug total=5
c9b45120487e09d0b735bfb448bd07d0d1b937d0f89c9861def9e1e84b90870d lib/plug.ex module Plug
```

`symbol.getCard` returned the `Plug` module card:

```text
symbolId=c9b45120487e09d0b735bfb448bd07d0d1b937d0f89c9861def9e1e84b90870d
file=lib/plug.ex
kind=module
name=Plug
range=1:0-179:3
signature="module Plug"
```

`slice.build` succeeded:

```text
sliceHandle=c3822afdd16ad77fde7a531b80bc19b6
ledgerVersion=v1781664461053
```

`code.needWindow` approved a source window:

```text
approved=true
file=lib/plug.ex
range=81:0-120:5
whyApproved=Identifiers matched: Plug
```

## Result

Elixir is validated for Wave 2 provider-first LSP document-symbol materialization. Expert produced usable provider symbols for 43 files and 35 files fell back to full legacy parsing. Provider-owned symbols are materialized for the usable files, fallback covers unusable files, and the graph gate plus smoke ladder pass.
