# Provider-First LSP Validation: Fortran

Date: 2026-06-17

## Scope

- Language: Fortran
- Validation repo: `fortran-lang/stdlib`
- Local repo path: `F:\Claude\projects\sdl-lsp-provider-first-repos\stdlib`
- SDL-MCP config: `F:\Claude\projects\sdl-lsp-provider-first-repos\stdlib\sdlmcp.fortran.config.json`
- Graph DB: `F:\Claude\projects\sdl-lsp-provider-first-repos\stdlib\.tmp\sdl-provider-first-lsp-fortran.lbug`
- LSP server: `fortls`
- Parser pack: `tree-sitter-fortran`

## Setup Evidence

- `tree-sitter-fortran` was absent before the Fortran repo config was used.
- The parser pack installed on demand after indexing a repo with `languages: ["fortran"]`.
- Installed parser pack:
  - path: `C:\Users\glitt\.sdl-mcp\cache\language-packs\node_modules\tree-sitter-fortran\package.json`
  - name: `tree-sitter-fortran`
  - version: `0.6.0`
- LSP-IO status after repair reported `fortls` as `managed` with install method `pipx`.
- LSP-IO SDL-MCP export for `fortran-lang/stdlib` emitted `fortls` with:
  - command: `C:\Users\glitt\AppData\Local\lsp-io\servers\fortls\pipx\home\venvs\fortls\Scripts\python.exe`
  - args: `["-m", "fortls"]`
  - readiness: `ready`

## Commands

```powershell
npm run build:runtime
node --test tests\unit\provider-first-lsp-normalizer.test.ts tests\unit\process-file.test.ts

$env:SDL_CONFIG='F:\Claude\projects\sdl-lsp-provider-first-repos\stdlib\sdlmcp.fortran.config.json'
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\stdlib\.tmp\sdl-provider-first-lsp-fortran.lbug'
node dist\cli\index.js -c $env:SDL_CONFIG doctor
node dist\cli\index.js -c $env:SDL_CONFIG index --repo-id stdlib-fortran --force

npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\stdlib\.tmp\sdl-provider-first-lsp-fortran.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\stdlib --repo-id stdlib-fortran

node dist\cli\index.js -c $env:SDL_CONFIG tool symbol.search --query "example_svd" --repo-id stdlib-fortran --limit 5 --output-format json-compact
node dist\cli\index.js -c $env:SDL_CONFIG tool symbol.getCard --symbol-id bb9a67d322341233c14762a62fcd85ad5b5eda93d988f8cc4021bb32ca4e43c4 --output-format json-compact
node dist\cli\index.js -c $env:SDL_CONFIG tool slice.build --repo-id stdlib-fortran --entry-symbols bb9a67d322341233c14762a62fcd85ad5b5eda93d988f8cc4021bb32ca4e43c4 --task-text "Inspect Fortran module example_all" --max-cards 10 --output-format json-compact
node dist\cli\index.js -c $env:SDL_CONFIG tool code.needWindow --repo-id stdlib-fortran --symbol-id bb9a67d322341233c14762a62fcd85ad5b5eda93d988f8cc4021bb32ca4e43c4 --reason "Validate Fortran LSP provider-first source-window access" --expected-lines 20 --identifiers example_all --output-format json-compact
```

## Index Result

- Provider-first executor: `lspFull`
- Provider run: `provider-first-lsp:1781667523240`
- Total wall time: `310706ms`
- Collection time: `305548ms`
- Provider-primary files: `109/408`
- Provider coverage: `0 full`, `109 partial`
- Provider-unusable files: `91`
- Uncovered files: `208`
- Legacy fallback: `408` files parsed
- Staged rows:
  - files: `517`
  - symbols: `114`
  - edges: `0`
- Activated graph:
  - files: `517`
  - symbols: `114`
  - edges: `0`
  - metrics: `114`
  - file summaries: `517`

## Validation

- `npm run build:runtime`: passed.
- `node --test tests\unit\provider-first-lsp-normalizer.test.ts tests\unit\process-file.test.ts`: passed, `38` tests.
- `node dist\cli\index.js -c $env:SDL_CONFIG doctor`: passed with expected warnings for a never-indexed temporary DB.
- `npm run check:provider-first-graph -- --db ... --repo-root ... --repo-id stdlib-fortran`: passed, `0/5` gates failed.

The initial graph gate found a source-fidelity mismatch on `example/linalg/example_svd.f90`: the provider/fallback row stored a decoded-text SHA-256 while the gate compares against raw source bytes. The fix was to hash LSP document bytes directly and to prefer scanner raw-byte hashes when legacy fallback writes file rows.

## Smoke Results

- `symbol.search`: returned Fortran symbols for query `example_svd`; selected symbol:
  - symbol ID: `bb9a67d322341233c14762a62fcd85ad5b5eda93d988f8cc4021bb32ca4e43c4`
  - name: `example_all`
  - file: `example/bitsets/example_bitsets_all.f90`
  - kind: `module`
- `symbol.getCard`: passed for `example_all`.
  - range: `1:0-15:0`
  - signature: `module example_all`
  - ledger version: `v1781667830224`
  - etag: `4d33231efaad8475cb709692c779a24e72f522bb52f322c3453e136f57cb5c61`
- `slice.build`: passed.
  - slice handle: `97b4d5fa70aa3a63ac21bd64c5049aeb`
  - ledger version: `v1781667830224`
- `code.needWindow`: passed.
  - approved: `true`
  - file: `example/bitsets/example_bitsets_all.f90`
  - range: `1:0-15:23`
  - approval reason: `Identifiers matched: example_all`

## Notes

- Fortls document-symbol collection is slow for this repo and consumed almost all provider collection time.
- Fortls returned usable symbols for 109 files and document-symbol failures for 91 files; full legacy fallback kept the graph complete for provider-unusable and uncovered files.
- LSP-IO needed a Windows-specific managed Fortls launch repair because the pipx shim pointed at the staging directory after promotion. The durable launch is the managed venv Python with `-m fortls`.
