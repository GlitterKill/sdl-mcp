# Provider-First LSP Swift Validation - 2026-06-16

This validation uses `apple/swift-argument-parser` as the Swift Wave 1 repository.

## Repository

`F:\Claude\projects\sdl-lsp-provider-first-repos\swift-argument-parser`

## Graph DB

`F:\Claude\projects\sdl-lsp-provider-first-repos\swift-argument-parser\.tmp\sdl-provider-first-lsp-swift.lbug`

## LSP-IO Status And Export

`lsp-io status` reports SourceKit-LSP as a system/manual server after installing the Swift toolchain:

```text
sourcekit-lsp                      Swift                  system         system/manual
```

`lsp-io export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\swift-argument-parser --validate-launch` exported:

```json
{
  "sourcekit-lsp": {
    "enabled": true,
    "serverId": "sourcekit-lsp",
    "command": "C:\\Users\\glitt\\AppData\\Local\\Programs\\Swift\\Toolchains\\6.3.2+Asserts\\usr\\bin\\sourcekit-lsp.exe",
    "args": [],
    "languages": ["swift"],
    "documentLanguageIds": ["swift"],
    "filePatterns": ["**/*.swift", "**/package.swift"],
    "capabilities": ["documentSymbol", "diagnostics", "definition", "references"],
    "readiness": "manual"
  }
}
```

## Provider-First Index

```text
Provider-first: lspFull (provider-first-lsp:1781639635017)
Provider-first shadow staging: csv files=165 symbols=4663 externals=0 edges=0 (parquet requested)
Provider-first shadow DB loaded: files=165 symbols=4663 edges=0
Provider-first shadow DB finalized: files=165 symbols=4663 edges=0 versions=1 metrics=4663 fileSummaries=165 copy=bulkCsv artifacts=20
Provider-first shadow DB activated: F:/Claude/projects/sdl-lsp-provider-first-repos/swift-argument-parser/.tmp/sdl-provider-first-lsp-swift.lbug
Provider-first coverage: 165/165 files provider-primary (0 full, 165 partial)
Files: 165
Symbols: 4663 new (4663 total)
Edges: 0 new (0 total)
Duration: 109174ms
```

## Graph Gate

```text
PASS provider-first graph check: 0/5 gate(s) failed
```

## Smoke Checks

`symbol.search` returned Swift LSP symbols:

```text
query=ArgumentParser total=5
7be1adffa25f687360b803c0b93611b80049eb9247d6587c64e928f79f167c40 Sources/ArgumentParser/Parsable Properties/Argument.swift class Argument
```

`symbol.getCard`, `slice.build`, and `code.needWindow` passed for `Argument`:

```text
card file=Sources/ArgumentParser/Parsable Properties/Argument.swift kind=class name=Argument
sliceHandle=affb8eb28c9ab682d4c3c111c9223ae5
code.needWindow approved=true range=44:0-83:16
```

## Result

Swift is validated for Wave 1 provider-first LSP document-symbol materialization. The current provider facts are partial because SourceKit-LSP document symbols did not produce call/reference edges in this run.
