# Provider-First LSP Validation: Haskell

Date: 2026-06-17

## Scope

- Language: Haskell
- Validation repo: `haskell/parsec`
- Local repo path: `F:\Claude\projects\sdl-lsp-provider-first-repos\parsec`
- SDL-MCP config: `F:\Claude\projects\sdl-lsp-provider-first-repos\parsec\sdlmcp.haskell.config.json`
- Graph DB: `F:\Claude\projects\sdl-lsp-provider-first-repos\parsec\.tmp\sdl-provider-first-lsp-haskell.lbug`
- LSP server: `haskell-language-server`
- Parser pack: `tree-sitter-haskell`

## Setup Evidence

- `tree-sitter-haskell` was absent before the Haskell repo config was used.
- The parser pack installed on demand after indexing a repo with `languages: ["haskell"]`.
- Installed parser pack:
  - path: `C:\Users\glitt\.sdl-mcp\cache\language-packs\node_modules\tree-sitter-haskell\package.json`
  - name: `tree-sitter-haskell`
  - version: `0.23.1`
- Haskell toolchain:
  - `ghc --version`: `9.6.7`
  - `cabal --version`: `3.14.2.0`
  - `haskell-language-server-wrapper --version`: `2.13.0.0`
- LSP-IO status reported `haskell-language-server` as `system` with install method `system/manual`.
- LSP-IO SDL-MCP export for `haskell/parsec` emitted `haskell-language-server` with:
  - command: `C:\ghcup\bin\haskell-language-server-wrapper.exe`
  - args: `["--lsp", "--log-stderr", "False"]`
  - readiness: `manual`

## Commands

```powershell
$env:PATH='C:\ghcup\bin;C:\cabal\bin;' + $env:PATH
cargo run -p lsp-io-cli -- export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\parsec --validate-launch

$env:SDL_CONFIG='F:\Claude\projects\sdl-lsp-provider-first-repos\parsec\sdlmcp.haskell.config.json'
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\parsec\.tmp\sdl-provider-first-lsp-haskell.lbug'
node dist\cli\index.js -c $env:SDL_CONFIG doctor
node dist\cli\index.js -c $env:SDL_CONFIG index --repo-id parsec-haskell --force

npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\parsec\.tmp\sdl-provider-first-lsp-haskell.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\parsec --repo-id parsec-haskell

node dist\cli\index.js -c $env:SDL_CONFIG tool symbol.search --repo-id parsec-haskell --query "Text.Parsec" --limit 10 --json
node dist\cli\index.js -c $env:SDL_CONFIG tool symbol.getCard --symbol-id 7e556899b96c7cdf158adee86dc9ec991a8749ca09819088448c4d037563da0d --json
node dist\cli\index.js -c $env:SDL_CONFIG tool slice.build --repo-id parsec-haskell --entry-symbols 7e556899b96c7cdf158adee86dc9ec991a8749ca09819088448c4d037563da0d --task-text "inspect Haskell provider-first Text.Parsec module" --max-cards 5 --json
node dist\cli\index.js -c $env:SDL_CONFIG tool code.needWindow --repo-id parsec-haskell --symbol-id 7e556899b96c7cdf158adee86dc9ec991a8749ca09819088448c4d037563da0d --reason "validate Haskell provider-first source window" --expected-lines 130 --identifiers "Text.Parsec" --granularity symbol --json
```

## Index Result

- Provider-first executor: `lspFull`
- Provider run: `provider-first-lsp:1781669889479`
- Total wall time: `67572ms`
- Collection time: `63580ms`
- Provider-primary files: `38/39`
- Provider coverage: `0 full`, `38 partial`
- Provider-unusable files: `1`
- Legacy fallback: `39` files parsed
- Provider-unusable diagnostic: `Setup.hs` had no usable provider symbols
- Staged rows:
  - files: `77`
  - symbols: `542`
  - edges: `0`
- Activated graph:
  - files: `77`
  - symbols: `542`
  - edges: `0`
  - metrics: `542`
  - file summaries: `77`

## Validation

- `cargo test -p lsp-io-core haskell_language_server_exports_lsp_mode_without_stderr_logs`: passed.
- `cargo test -p lsp-io-core sdl_mcp`: passed, `12` tests.
- `node dist\cli\index.js -c $env:SDL_CONFIG doctor`: passed with expected warnings for a never-indexed temporary DB.
- `npm run check:provider-first-graph -- --db ... --repo-root ... --repo-id parsec-haskell`: passed, `0/5` gates failed.

The first Haskell provider-first run used an `lsp-io` export with empty HLS args and collected `0/39` provider-primary files. Direct LSP probing showed HLS returns document symbols when launched as `haskell-language-server-wrapper --lsp --log-stderr False`. The `lsp-io` Haskell SDL-MCP metadata now exports those args so SDL-MCP continues to treat `lsp-io` as the server authority.

## Smoke Results

- `symbol.search`: returned Haskell symbols for query `Text.Parsec`; selected symbol:
  - symbol ID: `7e556899b96c7cdf158adee86dc9ec991a8749ca09819088448c4d037563da0d`
  - name: `Text.Parsec`
  - file: `src/Text/Parsec.hs`
  - kind: `variable`
- `symbol.getCard`: passed for `Text.Parsec`.
  - range: `1:0-130:0`
  - signature: `variable Text.Parsec`
  - ledger version: `v1781669953422`
  - etag: `d6d141aa1fec1e6fde1d2e3f176d75d0289871b359ef9545d12ae656bc2b336d`
- `slice.build`: passed.
  - slice handle: `d921f984032b5793581302ec3219f650`
  - ledger version: `v1781669953422`
- `code.needWindow`: passed.
  - approved: `true`
  - file: `src/Text/Parsec.hs`
  - range: `1:0-130:0`
  - approval reason: `Identifiers matched: Text.Parsec`

## Notes

- HLS returned module/import-oriented document symbols for the Parsec modules. SDL materialized those provider-owned facts and used full legacy fallback to keep coverage complete.
- `Setup.hs` remained provider-unusable because HLS returned no usable document symbols for that file; full legacy fallback parsed it.
- HLS option booleans are case-sensitive in practice for this wrapper; `False` works, while lowercase `false` failed during diagnostic probing.
