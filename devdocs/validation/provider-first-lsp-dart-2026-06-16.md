# Provider-First LSP Dart Validation - 2026-06-16

This validation uses `dart-lang/http` as the Dart Wave 1 repository.

## Repository

`F:\Claude\projects\sdl-lsp-provider-first-repos\dart-http`

## Graph DB

`F:\Claude\projects\sdl-lsp-provider-first-repos\dart-http\.tmp\sdl-provider-first-lsp-dart.lbug`

## LSP-IO Status And Export

`lsp-io status` reports Dart as a system/manual server after installing the Dart SDK:

```text
dart-sdk-lsp                       Dart                   system         system/manual
```

`lsp-io export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\dart-http --validate-launch` exported:

```json
{
  "dart-sdk-lsp": {
    "enabled": true,
    "serverId": "dart-sdk-lsp",
    "command": "C:\\Users\\glitt\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Google.DartSDK_Microsoft.Winget.Source_8wekyb3d8bbwe\\dart-sdk\\bin\\dart.exe",
    "args": ["language-server"],
    "languages": ["dart"],
    "documentLanguageIds": ["dart"],
    "filePatterns": ["**/*.dart", "**/pubspec.yaml"],
    "capabilities": ["documentSymbol", "diagnostics", "definition", "references"],
    "readiness": "manual"
  }
}
```

## Provider-First Index

```text
Provider-first: lspFull (provider-first-lsp:1781639255199)
Provider-first shadow staging: csv files=324 symbols=10173 externals=0 edges=0 (parquet requested)
Provider-first shadow DB loaded: files=324 symbols=10173 edges=0
Provider-first shadow DB finalized: files=324 symbols=10173 edges=0 versions=1 metrics=10173 fileSummaries=324 copy=bulkCsv artifacts=20
Provider-first shadow DB activated: F:/Claude/projects/sdl-lsp-provider-first-repos/dart-http/.tmp/sdl-provider-first-lsp-dart.lbug
Provider-first coverage: 324/324 files provider-primary (0 full, 324 partial)
Files: 324
Symbols: 10173 new (10173 total)
Edges: 0 new (0 total)
Duration: 346396ms
```

## Graph Gate

```text
PASS provider-first graph check: 0/5 gate(s) failed
```

## Smoke Checks

`symbol.search` returned Dart LSP symbols:

```text
query=Client total=5
9567040b706f56f599a2dee26cac2ccdafbd0ab811e981c00c4b498a879d7c94 pkgs/http/lib/src/client.dart class Client
```

`symbol.getCard`, `slice.build`, and `code.needWindow` passed for `Client`:

```text
card file=pkgs/http/lib/src/client.dart kind=class name=Client
sliceHandle=8db72cc7a03b68b53dfd77c14b7c4a40
code.needWindow approved=true range=36:0-36:33
```

## Result

Dart is validated for Wave 1 provider-first LSP document-symbol materialization. The current provider facts are partial because the Dart LSP document-symbol pass did not produce call/reference edges in this run.
