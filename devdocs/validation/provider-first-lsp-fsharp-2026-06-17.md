# Provider-First LSP F# Validation - 2026-06-17

This validation uses `fsprojects/FSharpPlus` as the F# Wave 2 repository. `FSharp.Data` was checked first, but its `global.json` requires .NET SDK `10.0.201`, which was not installed on this workstation. `FSharpPlus` pins .NET 8 with `latestFeature` roll-forward and restores successfully with the installed .NET 8 SDK.

The run proves the F# lazy language-pack path can resolve an on-demand parser pack after the repository config enables `fsharp`, consume `lsp-io` exported FsAutoComplete metadata, materialize LSP-owned provider facts, pass the provider-first graph gate, and serve the normal symbol/card/slice/source-window smoke ladder on a real repository.

## Repository

`F:\Claude\projects\sdl-lsp-provider-first-repos\fsharp-plus`

## Graph DB

`F:\Claude\projects\sdl-lsp-provider-first-repos\fsharp-plus\.tmp\sdl-provider-first-lsp-fsharp.lbug`

## LSP-IO Status

```text
fsautocomplete                     F#                     managed        dotnet tool
```

## LSP-IO Export

Command:

```powershell
cargo run --manifest-path F:\Claude\projects\lsp-io\Cargo.toml -p lsp-io-cli -- export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\fsharp-plus --validate-launch
```

Relevant exported server:

```json
{
  "fsautocomplete": {
    "enabled": true,
    "serverId": "fsautocomplete",
    "command": "C:\\Users\\glitt\\AppData\\Local\\lsp-io\\servers\\fsautocomplete\\dotnet-tools\\fsautocomplete.exe",
    "args": [],
    "languages": ["fsharp"],
    "documentLanguageIds": ["fsharp"],
    "filePatterns": ["**/*.fs", "**/*.fsi", "**/*.fsproj", "**/*.fsx", "**/paket.dependencies"],
    "initializationOptions": {
      "AutomaticWorkspaceInit": true
    },
    "documentSymbolRetryCount": 1,
    "documentSymbolRetryDelayMs": 30000,
    "capabilities": ["documentSymbol", "diagnostics", "definition", "references"],
    "readiness": "ready"
  }
}
```

FsAutoComplete requires `AutomaticWorkspaceInit` for clients that do not manually run `fsharp/workspacePeek` and `fsharp/workspaceLoad`. The retry metadata handles transient `textDocument/documentSymbol` failures while projects finish loading.

## Server Setup

FsAutoComplete was installed and managed by `lsp-io`:

```text
C:\Users\glitt\AppData\Local\lsp-io\servers\fsautocomplete\dotnet-tools\fsautocomplete.exe
0.83.0+96fabed8e9181b74e19e211717626c204c32b2c2
```

The validation repository restored with the installed .NET 8 SDK:

```powershell
dotnet restore FSharpPlus.sln
```

## Parser Pack

F# is configured as a lazy language pack. The parser package is not a root SDL-MCP dependency; it resolves through the on-demand language-pack cache only when the repo config includes `fsharp`.

```text
C:\Users\glitt\.sdl-mcp\cache\language-packs\node_modules\tree-sitter-fsharp\package.json
name=tree-sitter-fsharp
version=0.1.0
```

## Provider-First Index

Command:

```powershell
$env:SDL_CONFIG='F:\Claude\projects\sdl-lsp-provider-first-repos\fsharp-plus\sdlmcp.fsharp.config.json'
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\fsharp-plus\.tmp\sdl-provider-first-lsp-fsharp.lbug'
node dist\cli\index.js -c $env:SDL_CONFIG index --repo-id fsharp-plus-fsharp --force
```

Result:

```text
Provider-first: lspFull (provider-first-lsp:1781665718597)
Provider-first timings: total=306745ms; slowest=collect 301003ms
Provider-first shadow staging: csv files=362 symbols=6090 externals=0 edges=0 (parquet requested)
Provider-first shadow DB finalized: files=362 symbols=6090 edges=0 versions=1 metrics=6090 fileSummaries=362 copy=bulkCsv artifacts=20
Provider-first shadow DB activated: F:/Claude/projects/sdl-lsp-provider-first-repos/fsharp-plus/.tmp/sdl-provider-first-lsp-fsharp.lbug
Provider-first coverage: 145/217 files provider-primary (0 full, 145 partial); 55 provider unusable, 17 uncovered; legacy fallback parsed 217 file(s)
Provider-first provider-unusable diagnostics: no usable provider symbols: 55 file(s)
Files: 362
Symbols: 6090 new (6090 total)
Edges: 0 new (0 total)
Duration: 306746ms
```

The validation config disables semantic embeddings for this local proof run so graph validation remains focused on provider-first LSP materialization.

## Graph Gate

Command:

```powershell
npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\fsharp-plus\.tmp\sdl-provider-first-lsp-fsharp.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\fsharp-plus --repo-id fsharp-plus-fsharp
```

Result:

```text
PASS provider-first graph check: 0/5 gate(s) failed
```

## Smoke Checks

`symbol.search` returned F# LSP symbols from the graph:

```text
query=ParallelArrayOperators total=1
005900fa111b354fb853d97b7e7ed47402ed579ee58dd93c69ffd943b3cfe8a1 src/FSharpPlus/Data/ParallelArray.fs module ParallelArrayOperators
```

`symbol.getCard` returned the `ParallelArrayOperators` module card:

```text
symbolId=005900fa111b354fb853d97b7e7ed47402ed579ee58dd93c69ffd943b3cfe8a1
file=src/FSharpPlus/Data/ParallelArray.fs
kind=module
name=ParallelArrayOperators
range=60:0-63:28
signature="module ParallelArrayOperators"
```

`slice.build` succeeded:

```text
sliceHandle=74334adec95e125de88d149b644922bf
ledgerVersion=v1781666020670
```

`code.needWindow` approved a source window:

```text
approved=true
file=src/FSharpPlus/Data/ParallelArray.fs
range=60:0-63:28
whyApproved=Identifiers matched: ParallelArrayOperators
```

## Result

F# is validated for Wave 2 provider-first LSP document-symbol materialization. FsAutoComplete produced usable provider symbols for 145 files, 55 files were provider-unusable, 17 files were uncovered by the bounded LSP document collection, and full legacy fallback covered all repository files. Provider-owned symbols are materialized for the usable files, fallback covers unusable and uncovered files, and the graph gate plus smoke ladder pass.
