# D Provider-First LSP Validation - 2026-06-24

## Scope

- Language: D
- Validation repo: `dlang/dub`
- Repo path: `F:\Claude\projects\sdl-lsp-provider-first-repos\dub`
- Source list: `F:\Claude\projects\sdl-lsp-provider-first-repos\dub\.tmp\d-provider-first-files.txt` (40 tracked D files)
- SDL config: `F:\Claude\projects\sdl-lsp-provider-first-repos\dub\sdlmcp.d.config.json`
- Graph DB: `F:\Claude\projects\sdl-lsp-provider-first-repos\dub\.tmp\sdl-provider-first-lsp-d.lbug`
- LSP-IO server: `serve-d`
- Parser pack: `tree-sitter-d@^0.8.2`

## Lazy Parser Install Check

Before D validation:

```text
TREE_SITTER_D_NOT_INSTALLED_BEFORE
```

After the explicitly D-configured index run:

```text
TREE_SITTER_D_INSTALLED_AFTER
```

No root `package.json` dependency was added.

## LSP-IO Export

`lsp-io` detected D in `dlang/dub` and exported `serve-d` for SDL-MCP:

```text
command: C:\Users\glitt\AppData\Local\lsp-io\servers\serve-d\github-release\serve-d.exe
documentLanguageIds: ["d"]
filePatterns: **/*.d, **/*.di, **/dub.json, **/dub.sdl
capabilities: documentSymbol, diagnostics, definition, references
readiness: ready
```

## Provider-First Index Result

```text
Provider-first: lspFull (provider-first-lsp:1782302923392)
Coverage: 4/40 files provider-primary (0 full, 4 partial); 36 provider unusable; legacy fallback parsed 40 file(s)
Files: 44
Symbols: 718
Edges: 0
Duration: 141478ms
```

The run used a source file list, so provider-first shadow staging was skipped for the subset run. The activated graph still passed the provider-first graph checker.

## Graph And Smoke Validation

```text
npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\dub\.tmp\sdl-provider-first-lsp-d.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\dub --repo-id dub-d
PASS provider-first graph check: 0/5 gate(s) failed
```

CLI smoke checks used symbol `2e42f1635ff661b949f507fed472d8fb559a25f3aea3e5e9f80191d2afd23381`:

```text
symbol.search query=Package -> PackageBuildCommand, source/dub/commandline.d, kind=class
symbol.getCard -> range 1276:0-1436:1, signature "class PackageBuildCommand"
slice.build -> sliceHandle c062e780434c64eb281815e8a5e7295c
code.needWindow -> approvedRaw, identifiers matched: PackageBuildCommand
```

## Result

D is validated for bounded LSP provider-first indexing through `serve-d` with lazy parser installation.
