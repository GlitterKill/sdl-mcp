# Provider-First LSP R Validation - 2026-06-17

This validation uses `r-lib/pkgdown` as the R Wave 2 repository. It proves the R lazy language-pack path can resolve an on-demand parser pack only after R is configured, consume `lsp-io` exported server metadata, materialize LSP-owned provider facts, pass the provider-first graph gate, and serve the normal symbol/card/slice/source-window smoke ladder on a real repository.

## Repository

`F:\Claude\projects\sdl-lsp-provider-first-repos\r-pkgdown`

## Graph DB

`F:\Claude\projects\sdl-lsp-provider-first-repos\r-pkgdown\.tmp\sdl-provider-first-lsp-r.lbug`

## LSP-IO Status

```text
r-languageserver                   R                      system         system/manual
```

## LSP-IO Export

Command:

```powershell
$env:Path='C:\Users\glitt\AppData\Local\lsp-io\servers\r-languageserver\bin;C:\Users\glitt\AppData\Local\Programs\R\R-4.6.0\bin;' + $env:Path
cargo run --manifest-path F:\Claude\projects\lsp-io\Cargo.toml -p lsp-io-cli -- export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\r-pkgdown --validate-launch
```

Relevant exported server:

```json
{
  "r-languageserver": {
    "enabled": true,
    "serverId": "r-languageserver",
    "command": "C:\\Users\\glitt\\AppData\\Local\\lsp-io\\servers\\r-languageserver\\bin\\R-languageserver.cmd",
    "args": [],
    "languages": ["r"],
    "documentLanguageIds": ["r"],
    "filePatterns": ["**/*.qmd", "**/*.r", "**/*.rmd", "**/description"],
    "capabilities": ["documentSymbol", "diagnostics", "definition", "references"],
    "readiness": "manual"
  }
}
```

The validation config adds uppercase R patterns (`**/*.R`, `**/*.Rmd`, `**/DESCRIPTION`) because `pkgdown` uses conventional uppercase `.R` source files. That metadata gap should be carried back to `lsp-io`.

## Server Setup

R 4.6.0 was installed into a user-writable directory from the cached R for Windows installer:

```text
C:\Users\glitt\AppData\Local\Programs\R\R-4.6.0\bin\Rscript.exe
Rscript (R) version 4.6.0 (2026-04-24)
```

The R package was installed with:

```powershell
Rscript.exe -e "options(repos=c(CRAN='https://cloud.r-project.org')); install.packages('languageserver')"
```

The `lsp-io` server cache exposes a wrapper:

```text
C:\Users\glitt\AppData\Local\lsp-io\servers\r-languageserver\bin\R-languageserver.cmd
"C:\Users\glitt\AppData\Local\Programs\R\R-4.6.0\bin\Rscript.exe" -e "languageserver::run()" %*
```

SDL-MCP resolves this wrapper as a narrow Rscript language-server shim and does not invoke arbitrary batch files.

## Parser Pack

R is configured as a lazy language pack. The parser package is not a root SDL-MCP dependency; it resolves through the on-demand language-pack cache only when the repo config includes `r`.

```text
C:\Users\glitt\.sdl-mcp\cache\language-packs\node_modules\@davisvaughan\tree-sitter-r\package.json
name=@davisvaughan/tree-sitter-r
version=1.2.0
```

## Provider-First Index

Command:

```powershell
$env:Path='C:\Users\glitt\AppData\Local\lsp-io\servers\r-languageserver\bin;C:\Users\glitt\AppData\Local\Programs\R\R-4.6.0\bin;' + $env:Path
$env:SDL_CONFIG='F:\Claude\projects\sdl-lsp-provider-first-repos\r-pkgdown\sdlmcp.r.config.json'
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\r-pkgdown\.tmp\sdl-provider-first-lsp-r.lbug'
node dist\cli\index.js -c $env:SDL_CONFIG index --repo-id pkgdown-r --force
```

Result:

```text
Provider-first: lspFull (provider-first-lsp:1781662313871)
Provider-first timings: total=57850ms; slowest=collect 34008ms
Provider-first shadow staging: csv files=232 symbols=761 externals=0 edges=0 (parquet requested)
Provider-first shadow DB finalized: files=232 symbols=761 edges=0 versions=1 metrics=761 fileSummaries=232
Provider-first shadow DB activated: F:/Claude/projects/sdl-lsp-provider-first-repos/r-pkgdown/.tmp/sdl-provider-first-lsp-r.lbug
Provider-first coverage: 99/133 files provider-primary (0 full, 99 partial); 34 provider unusable; legacy fallback parsed 133 file(s)
Provider-first provider-unusable diagnostics: no usable provider symbols: 34 file(s)
Files: 232
Symbols: 761 new (761 total)
Edges: 0 new (0 total)
Duration: 57851ms
```

## Graph Gate

Command:

```powershell
npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\r-pkgdown\.tmp\sdl-provider-first-lsp-r.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\r-pkgdown --repo-id pkgdown-r
```

Result:

```text
PASS provider-first graph check: 0/5 gate(s) failed
```

## Smoke Checks

`symbol.search` returned R LSP symbols from the graph:

```text
query=build_article total=5
c289688437e8673bd49e91aa94ea5e3e226387da57348b8f996fdab0b861935b R/build-article.R function build_article
```

`symbol.getCard` returned the `build_article` function card:

```text
symbolId=c289688437e8673bd49e91aa94ea5e3e226387da57348b8f996fdab0b861935b
file=R/build-article.R
kind=function
name=build_article
range=10:0-58:1
signature="function build_article"
```

`slice.build` succeeded:

```text
sliceHandle=2b32bb56b35e9d07d6994879c3f317a6
ledgerVersion=v1781662348546
```

`code.needWindow` approved a source window:

```text
approved=true
file=R/build-article.R
range=10:0-39:23
whyApproved=Identifiers matched: build_article
```

## Result

R is validated for Wave 2 provider-first LSP document-symbol materialization. The current provider facts are partial because R languageserver produced usable symbols for 99 files and no usable provider symbols for 34 files. Provider-owned symbols are materialized for the usable files, full legacy fallback covers unusable files, and the graph gate plus smoke ladder pass.
