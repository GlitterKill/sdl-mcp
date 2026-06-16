# Provider-First LSP Ruby Validation - 2026-06-16

This validation uses `sinatra/sinatra` as the Ruby Wave 1 repository. It proves the Ruby lazy language-pack path can resolve an on-demand parser pack only after Ruby is configured, consume `lsp-io` exported server metadata, materialize LSP-owned provider facts, pass the provider-first graph gate, and serve the normal symbol/card/slice/source-window smoke ladder on a real repository.

## Repository

`F:\Claude\projects\sdl-lsp-provider-first-repos\sinatra`

## Graph DB

`F:\Claude\projects\sdl-lsp-provider-first-repos\sinatra\.tmp\sdl-provider-first-lsp-ruby-minimal.lbug`

## LSP-IO Status

```text
ruby-lsp                           Ruby                   managed        gem
```

## LSP-IO Export

Command:

```powershell
cargo run --manifest-path F:\Claude\projects\lsp-io\Cargo.toml -p lsp-io-cli -- export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\sinatra --validate-launch
```

Relevant exported server:

```json
{
  "ruby-lsp": {
    "enabled": true,
    "serverId": "ruby-lsp",
    "command": "C:\\Users\\glitt\\AppData\\Local\\lsp-io\\servers\\ruby-lsp\\gems\\bin\\ruby-lsp.bat",
    "args": [],
    "languages": ["ruby"],
    "documentLanguageIds": ["ruby"],
    "filePatterns": ["**/*.rake", "**/*.rb", "**/gemfile"],
    "capabilities": ["documentSymbol", "diagnostics", "definition", "references"],
    "readiness": "ready"
  }
}
```

The SDL validation config adds `--use-launcher` plus `BUNDLE_GEMFILE`, `GEM_HOME`, and `GEM_PATH` env values around the lsp-io export because Ruby LSP otherwise tries to compose Sinatra's full development bundle. The full bundle hits local Windows native-extension prerequisites (`psych`/libyaml via MSYS keyring), while the minimal Ruby LSP bundle still lets the server parse and return symbols for the real Sinatra source files.

## Parser Pack

Ruby is configured as a lazy language pack. The parser package is not a root SDL-MCP dependency; it resolves through the on-demand language-pack cache only when the repo config includes `ruby`.

## Provider-First Index

Command:

```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
$env:SDL_CONFIG='F:\Claude\projects\sdl-lsp-provider-first-repos\sinatra\sdlmcp.ruby.config.json'
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\sinatra\.tmp\sdl-provider-first-lsp-ruby-minimal.lbug'
node dist\cli\index.js -c $env:SDL_CONFIG index --repo-id sinatra-ruby --force
```

Result:

```text
Provider-first: lspFull (provider-first-lsp:1781638189512)
Provider-first shadow staging: csv files=147 symbols=1557 externals=0 edges=0 (parquet requested)
Provider-first shadow DB loaded: files=147 symbols=1557 edges=0
Provider-first shadow DB finalized: files=147 symbols=1557 edges=0 versions=1 metrics=1557 fileSummaries=147 copy=bulkCsv artifacts=20
Provider-first shadow DB activated: F:/Claude/projects/sdl-lsp-provider-first-repos/sinatra/.tmp/sdl-provider-first-lsp-ruby-minimal.lbug
Provider-first coverage: 147/147 files provider-primary (0 full, 147 partial)
Files: 147
Symbols: 1557 new (1557 total)
Edges: 0 new (0 total)
Duration: 41041ms
```

## Graph Gate

Command:

```powershell
npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\sinatra\.tmp\sdl-provider-first-lsp-ruby-minimal.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\sinatra
```

Result:

```text
PASS provider-first graph check: 0/5 gate(s) failed
```

## Smoke Checks

`symbol.search` returned Ruby LSP symbols from the graph:

```text
query=Sinatra total=5
2f1424bb930f23e94bdcdcdd1c8d39fee86309b002e4414e48bc738f26a0cc11 lib/sinatra/base.rb module Sinatra
```

`symbol.getCard` returned the `Sinatra` module card:

```text
symbolId=2f1424bb930f23e94bdcdcdd1c8d39fee86309b002e4414e48bc738f26a0cc11
file=lib/sinatra/base.rb
kind=module
name=Sinatra
signature="module Sinatra"
```

`slice.build` succeeded:

```text
sliceHandle=3085119757007ed775387ee2eef93246
ledgerVersion=v1781638193988
```

`code.needWindow` approved a source window:

```text
approved=true
file=lib/sinatra/base.rb
range=1823:0-1862:59
whyApproved=Identifiers matched: Sinatra
```

## Result

Ruby is validated for Wave 1 provider-first LSP document-symbol materialization. The current provider facts are partial because Ruby LSP document symbols do not produce call/reference edges in this run, but all configured Ruby files are provider-primary and the graph gate plus smoke ladder pass.
