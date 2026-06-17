# Provider-First LSP Groovy Validation - 2026-06-17

This validation uses `spockframework/spock` as the Groovy Wave 2 repository. It proves the Groovy lazy language-pack path can resolve an on-demand parser pack only after Groovy is configured, consume `lsp-io` exported server metadata, materialize LSP-owned provider facts, pass the provider-first graph gate, and serve the normal symbol/card/slice/source-window smoke ladder on a real repository.

## Repository

`F:\Claude\projects\sdl-lsp-provider-first-repos\spock`

## Graph DB

`F:\Claude\projects\sdl-lsp-provider-first-repos\spock\.tmp\sdl-provider-first-lsp-groovy.lbug`

## LSP-IO Status

```text
groovy-language-server             Groovy                 system         system/manual
```

## LSP-IO Export

Command:

```powershell
cargo run --manifest-path F:\Claude\projects\lsp-io\Cargo.toml -p lsp-io-cli -- export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\spock --validate-launch
```

Relevant exported server:

```json
{
  "groovy-language-server": {
    "enabled": true,
    "serverId": "groovy-language-server",
    "command": "C:\\Users\\glitt\\AppData\\Local\\lsp-io\\servers\\groovy-language-server\\bin\\groovy-language-server.cmd",
    "args": [],
    "languages": ["groovy"],
    "documentLanguageIds": ["groovy"],
    "filePatterns": ["**/*.gradle", "**/*.groovy"],
    "capabilities": ["documentSymbol", "diagnostics", "definition", "references"],
    "readiness": "manual"
  }
}
```

The export command also warned about unrelated missing servers (`github-actions-language-server`, `jdtls`, `json-language-server`, `kotlin-lsp`, `lemminx`, `marksman`, `taplo`, and `yaml-language-server`). Groovy exported as a manual system server managed through the `lsp-io` server cache.

## Parser Pack

Groovy is configured as a lazy language pack. The parser package is not a root SDL-MCP dependency; it resolves through the on-demand language-pack cache only when the repo config includes `groovy`.

```text
C:\Users\glitt\.sdl-mcp\cache\language-packs\node_modules\tree-sitter-groovy\package.json
name=tree-sitter-groovy
version=0.1.2
```

## Provider-First Index

Command:

```powershell
$env:SDL_CONFIG='F:\Claude\projects\sdl-lsp-provider-first-repos\spock\sdlmcp.groovy.config.json'
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\spock\.tmp\sdl-provider-first-lsp-groovy.lbug'
node dist\cli\index.js -c $env:SDL_CONFIG index --repo-id spock-groovy --force
```

Result:

```text
Provider-first: lspFull (provider-first-lsp:1781659766384)
Provider-first timings: total=305317ms; slowest=collect 243012ms
Provider-first shadow staging: csv files=573 symbols=1284 externals=0 edges=0 (parquet requested)
Provider-first shadow DB finalized: files=573 symbols=1284 edges=0 versions=1 metrics=1284 fileSummaries=573
Provider-first shadow DB activated: F:/Claude/projects/sdl-lsp-provider-first-repos/spock/.tmp/sdl-provider-first-lsp-groovy.lbug
Provider-first coverage: 33/540 files provider-primary (0 full, 33 partial); 47 provider unusable, 460 uncovered; legacy fallback parsed 540 file(s)
Provider-first provider-unusable diagnostics: no usable provider symbols: 47 file(s)
Provider-first skipped symbol diagnostics: documentSymbol request failed: 34 symbol(s)
Files: 573
Symbols: 1289 new (1284 total)
Edges: 0 new (0 total)
Duration: 305318ms
```

Groovy Language Server behaved as a single-document server in this repository: a workspace-scoped session initialized successfully but only returned document symbols for the first opened file. SDL-MCP now supports `documentSessionMode: "document"` for LSP servers that must be restarted per opened document, and this run used that mode for Groovy.

## Graph Gate

Command:

```powershell
npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\spock\.tmp\sdl-provider-first-lsp-groovy.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\spock --repo-id spock-groovy
```

Result:

```text
PASS provider-first graph check: 0/5 gate(s) failed
```

## Smoke Checks

`symbol.search` returned Groovy LSP symbols from the graph:

```text
query=SpockBasePlugin
6c4514e624de824e3fe6ac58ca3349578c5118103a8e7bc4aa735363492d7a9f build-logic/base/src/main/groovy/org/spockframework/gradle/SpockBasePlugin.groovy class org.spockframework.gradle.SpockBasePlugin
```

`symbol.getCard` returned the `SpockBasePlugin` class card:

```text
symbolId=6c4514e624de824e3fe6ac58ca3349578c5118103a8e7bc4aa735363492d7a9f
file=build-logic/base/src/main/groovy/org/spockframework/gradle/SpockBasePlugin.groovy
kind=class
name=org.spockframework.gradle.SpockBasePlugin
range=39:0-144:1
signature="class org.spockframework.gradle.SpockBasePlugin"
```

`slice.build` succeeded:

```text
sliceHandle=676d0d6ba0abdb929ef187ebd833cf2e
ledgerVersion=v1781660031045
```

`code.needWindow` approved a source window:

```text
approved=true
file=build-logic/base/src/main/groovy/org/spockframework/gradle/SpockBasePlugin.groovy
range=39:0-68:52
whyApproved=Identifiers matched: SpockBasePlugin
```

## Result

Groovy is validated for Wave 2 provider-first LSP document-symbol materialization. The current provider facts are partial because Groovy Language Server produced usable symbols for 33 files in this bounded run and failed or returned no usable provider symbols for the rest. Provider-owned symbols are still materialized for 33 files, full legacy fallback covers unusable and uncovered files, and the graph gate plus smoke ladder pass.
