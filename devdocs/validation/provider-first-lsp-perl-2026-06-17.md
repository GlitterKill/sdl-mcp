# Provider-First LSP Perl Validation - 2026-06-17

This validation uses `Perl-Critic/Perl-Critic` as the Perl Wave 2 repository. It proves the Perl lazy language-pack path can resolve an on-demand parser pack only after Perl is configured, consume `lsp-io` exported server metadata, materialize LSP-owned provider facts, pass the provider-first graph gate, and serve the normal symbol/card/slice/source-window smoke ladder on a real repository.

## Repository

`F:\Claude\projects\sdl-lsp-provider-first-repos\perl-critic`

## Graph DB

`F:\Claude\projects\sdl-lsp-provider-first-repos\perl-critic\.tmp\sdl-provider-first-lsp-perl.lbug`

## LSP-IO Status

```text
perl-navigator                     Perl                   managed        github release
```

## LSP-IO Export

Command:

```powershell
cargo run --manifest-path F:\Claude\projects\lsp-io\Cargo.toml -p lsp-io-cli -- export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\perl-critic --validate-launch
```

Relevant exported server:

```json
{
  "perl-navigator": {
    "enabled": true,
    "serverId": "perl-navigator",
    "command": "C:\\Users\\glitt\\AppData\\Local\\lsp-io\\servers\\perl-navigator\\github-release\\perlnavigator-win-x86_64\\perlnavigator.exe",
    "args": [],
    "languages": ["perl"],
    "documentLanguageIds": ["perl"],
    "filePatterns": ["**/*.pl", "**/*.pm", "**/*.t", "**/cpanfile", "**/makefile.pl"],
    "capabilities": ["documentSymbol", "diagnostics", "definition", "references"],
    "readiness": "ready"
  }
}
```

The export command also warned about unrelated missing servers (`docker-language-server`, `dockerfile-language-server`, `github-actions-language-server`, and `marksman`). Perl Navigator exported as ready.

## Parser Pack

Perl is configured as a lazy language pack. The parser package is not a root SDL-MCP dependency; it resolves through the on-demand language-pack cache only when the repo config includes `perl`.

## Provider-First Index

Command:

```powershell
$env:SDL_CONFIG='F:\Claude\projects\sdl-lsp-provider-first-repos\perl-critic\sdlmcp.perl.config.json'
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\perl-critic\.tmp\sdl-provider-first-lsp-perl.lbug'
node dist\cli\index.js -c $env:SDL_CONFIG index --repo-id perl-critic-perl --force
```

Result:

```text
Provider-first: lspFull (provider-first-lsp:1781658149787)
Provider-first timings: total=73244ms; slowest=collect 51622ms
Provider-first shadow staging: csv files=326 symbols=516 externals=0 edges=0 (parquet requested)
Provider-first shadow DB loaded: files=326 symbols=516 edges=0
Provider-first shadow DB finalized: files=326 symbols=516 edges=0 versions=1 metrics=516 fileSummaries=326 copy=bulkCsv artifacts=20
Provider-first shadow DB activated: F:/Claude/projects/sdl-lsp-provider-first-repos/perl-critic/.tmp/sdl-provider-first-lsp-perl.lbug
Provider-first coverage: 67/259 files provider-primary (0 full, 67 partial); 188 provider unusable, 4 uncovered; legacy fallback parsed 259 file(s)
Provider-first provider-unusable diagnostics: no usable provider symbols: 188 file(s)
Files: 326
Symbols: 516 new (516 total)
Edges: 0 new (0 total)
Duration: 73245ms
```

Perl Navigator returns broad document-symbol ranges with inflated end columns for some files. SDL-MCP clamps LSP symbol and diagnostic ranges to the opened document text before materialization; the final graph gate below validates those stored ranges against the physical source files.

## Graph Gate

Command:

```powershell
npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\perl-critic\.tmp\sdl-provider-first-lsp-perl.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\perl-critic --repo-id perl-critic-perl
```

Result:

```text
PASS provider-first graph check: 0/5 gate(s) failed
```

## Smoke Checks

`symbol.search` returned Perl LSP symbols from the graph:

```text
query=import total=2
6dbc53abef05a1ec8e50cd782583f6f6502f21662949dbc6ce2d832ad75efdd6 inc/Devel/AssertOS.pm function import
```

`symbol.getCard` returned the `import` function card:

```text
symbolId=6dbc53abef05a1ec8e50cd782583f6f6502f21662949dbc6ce2d832ad75efdd6
file=inc/Devel/AssertOS.pm
kind=function
name=import
range=34:0-38:1
signature="function import"
```

`slice.build` succeeded:

```text
sliceHandle=aea0626feada4e084d6406d19f8fff58
ledgerVersion=v1781658202433
```

`code.needWindow` approved a source window:

```text
approved=true
file=inc/Devel/AssertOS.pm
range=34:0-38:1
whyApproved=Identifiers matched: import
```

## Result

Perl is validated for Wave 2 provider-first LSP document-symbol materialization. The current provider facts are partial because Perl Navigator timed out or failed document-symbol requests for 188 files and did not produce call/reference edges in this run. Provider-owned symbols are still materialized for 67 files, full legacy fallback covers unusable and uncovered files, and the graph gate plus smoke ladder pass.
