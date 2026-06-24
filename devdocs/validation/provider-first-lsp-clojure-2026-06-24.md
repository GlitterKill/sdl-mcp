# Clojure Provider-First LSP Validation - 2026-06-24

## Scope

- Language: Clojure
- Validation repo: `clojure/tools.logging`
- Repo path: `F:\Claude\projects\sdl-lsp-provider-first-repos\tools.logging`
- SDL config: `F:\Claude\projects\sdl-lsp-provider-first-repos\tools.logging\sdlmcp.clojure.config.json`
- Graph DB: `F:\Claude\projects\sdl-lsp-provider-first-repos\tools.logging\.tmp\sdl-provider-first-lsp-clojure.lbug`
- LSP-IO server: `clojure-lsp`
- Parser pack: `@yogthos/tree-sitter-clojure`

## Lazy Parser Install Check

The original `tree-sitter-clojure` package failed to build on Node 24, so the configured lazy parser pack uses `@yogthos/tree-sitter-clojure`.

Before Clojure validation, the SDL cache did not contain the Clojure parser pack. After the explicitly Clojure-configured index run, the cache contained:

```text
C:\Users\glitt\.sdl-mcp\cache\language-packs\node_modules\@yogthos\tree-sitter-clojure
```

No root `package.json` dependency was added.

## LSP-IO Export

`lsp-io` detected Clojure in `clojure/tools.logging` and exported `clojure-lsp` for SDL-MCP:

```text
command: C:\Users\glitt\AppData\Local\lsp-io\servers\clojure-lsp\github-release\clojure-lsp.exe
args: []
documentLanguageIds: ["clojure"]
filePatterns: **/*.clj, **/*.cljc, **/*.cljs, **/*.edn, **/deps.edn, **/project.clj, **/shadow-cljs.edn
```

`clojure-lsp` returns an `initialize` Internal error in this repo but still serves `textDocument/documentSymbol`. SDL-MCP now scopes that continuation behavior to `clojure-lsp` only.

## Provider-First Index Result

```text
Provider-first: lspFull (provider-first-lsp:1782301441276)
Coverage: 9/10 files provider-primary (0 full, 9 partial); 1 provider unusable; legacy fallback parsed 10 file(s)
Provider-unusable file: project.clj
Files: 19
Symbols: 199
Edges: 0
Duration: 5866ms
```

## Graph And Smoke Validation

```text
npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\tools.logging\.tmp\sdl-provider-first-lsp-clojure.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\tools.logging --repo-id tools-logging-clojure
PASS provider-first graph check: 0/5 gate(s) failed
```

CLI smoke checks used symbol `ae684c64b5b7bf3c97231b3fba067a628e8c18b559641347bf0f14a0d031a5bf`:

```text
symbol.search query=logging -> log, src/main/clojure/clojure/tools/logging.clj, kind=function
symbol.getCard -> range 68:0-80:54, signature "function log"
slice.build -> sliceHandle 23be1045c611b899eacbecb152ceec4e
code.needWindow -> approvedRaw, identifiers matched: log
```

## Result

Clojure is validated for bounded LSP provider-first indexing through `clojure-lsp` with lazy parser installation. The support chart row is now marked validated and points to this evidence file.
