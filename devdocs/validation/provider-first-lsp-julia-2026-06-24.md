# Provider-First LSP Validation: Julia

Date: 2026-06-24

## Scope

- Language: Julia
- Validation repo: `JuliaLang/Example.jl`
- Local repo path: `F:\Claude\projects\sdl-lsp-provider-first-repos\Example.jl`
- SDL-MCP config: `F:\Claude\projects\sdl-lsp-provider-first-repos\Example.jl\sdlmcp.julia.config.json`
- Graph DB: `F:\Claude\projects\sdl-lsp-provider-first-repos\Example.jl\.tmp\sdl-provider-first-lsp-julia.lbug`
- LSP server: `julia-language-server` via LanguageServer.jl
- Parser pack: `tree-sitter-julia`

## Setup Evidence

- `tree-sitter-julia` was absent before the Julia repo config was used.
- The parser pack installed on demand after indexing a repo with `languages: ["julia"]`.
- Installed parser pack:
  - path: `C:\Users\glitt\.sdl-mcp\cache\language-packs\node_modules\tree-sitter-julia\package.json`
  - name: `tree-sitter-julia`
  - version: `0.23.1`
- Julia toolchain:
  - `julia --version`: `julia version 1.12.6`
  - `LanguageServer.runserver` is available from LanguageServer.jl.
- LSP-IO exported Julia through the validation repo `.lsp-io.toml` override:
  - command: `C:/Users/glitt/AppData/Local/Programs/Julia-1.12.6/bin/julia.exe`
  - args: `["--startup-file=no", "--history-file=no", "-e", "using LanguageServer; runserver()"]`
  - readiness: `manual`

## Commands

```powershell
winget install --id Julialang.Julia -e --silent --accept-package-agreements --accept-source-agreements
& 'C:\Users\glitt\AppData\Local\Programs\Julia-1.12.6\bin\julia.exe' -e 'using Pkg; Pkg.add("LanguageServer")'

cargo run -p lsp-io-cli -- export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\Example.jl --validate-launch

$env:SDL_CONFIG='F:\Claude\projects\sdl-lsp-provider-first-repos\Example.jl\sdlmcp.julia.config.json'
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\Example.jl\.tmp\sdl-provider-first-lsp-julia.lbug'
node dist\cli\index.js -c $env:SDL_CONFIG doctor
node dist\cli\index.js -c $env:SDL_CONFIG index --repo-id example-julia --force

npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\Example.jl\.tmp\sdl-provider-first-lsp-julia.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\Example.jl --repo-id example-julia

node dist\cli\index.js -c $env:SDL_CONFIG tool symbol.search --repo-id example-julia --query "hello" --limit 10 --json
node dist\cli\index.js -c $env:SDL_CONFIG tool symbol.getCard --symbol-id 4c81220c01a903196d45fb20119a97abfaf4f9dccf4af9910fa25c1298a82c96 --json
node dist\cli\index.js -c $env:SDL_CONFIG tool slice.build --repo-id example-julia --entry-symbols 4c81220c01a903196d45fb20119a97abfaf4f9dccf4af9910fa25c1298a82c96 --task-text "inspect Julia hello function" --max-cards 5 --json
node dist\cli\index.js -c $env:SDL_CONFIG tool code.needWindow --repo-id example-julia --symbol-id 4c81220c01a903196d45fb20119a97abfaf4f9dccf4af9910fa25c1298a82c96 --reason "validate Julia provider-first source window" --expected-lines 5 --identifiers "hello" --granularity symbol --json
```

## Index Result

- Provider-first executor: `lspFull`
- Provider run: `provider-first-lsp:1782274948587`
- Total wall time: `39165ms`
- Collection time: `35526ms`
- Provider-primary files: `1/3`
- Provider coverage: `0 full`, `1 partial`
- Provider-unusable files: `2`
- Legacy fallback: `3` files parsed
- Provider-unusable files: `docs/make.jl`, `test/runtests.jl`
- Activated graph:
  - files: `4`
  - symbols: `5`
  - edges: `0`
  - metrics: `5`
  - file summaries: `4`

## Validation

- `npm run build:runtime`: passed.
- `node --test tests\unit\language-pack-registry.test.ts tests\unit\repo-register-languages.test.ts`: passed.
- `npm run docs:language-support:check`: passed.
- `npm run check:config-sync`: passed.
- `git diff --check`: passed.
- `npm run check:provider-first-graph -- --db ... --repo-root ... --repo-id example-julia`: passed, `0/5` gates failed.

The first Julia provider-first runs produced no LSP symbols because SDL opened `.jl` documents as `plaintext`. The fix adds `.jl -> julia` to the provider-first LSP document language inference. Julia LanguageServer.jl also needed `documentSessionMode: "document"`; workspace-session collection still returned no usable provider symbols for this repo.

## Smoke Results

- `symbol.search`: returned Julia symbol `hello`.
  - symbol ID: `4c81220c01a903196d45fb20119a97abfaf4f9dccf4af9910fa25c1298a82c96`
  - file: `src/Example.jl`
  - kind: `function`
- `symbol.getCard`: passed.
  - range: `9:0-9:34`
  - ledger version: `v1782274984294`
  - etag: `3bfce9a5b1b19897bc368e24af4b33c95d57b944396e45e836dd82ff37cfd58f`
- `slice.build`: passed.
  - slice handle: `aa11710f8115d0dff911e2deaa365885`
  - ledger version: `v1782274984294`
- `code.needWindow`: passed.
  - approved: `true`
  - file: `src/Example.jl`
  - approval reason: `Identifiers matched: hello`

## Notes

- `julia-language-server` remains a system/manual `lsp-io` server. This validation uses the supported `.lsp-io.toml` project override path rather than adding a global shim.
- `docs/make.jl` and `test/runtests.jl` did not yield provider symbols; same-run legacy fallback kept the graph complete.
