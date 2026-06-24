# Zig Provider-First LSP Validation - 2026-06-24

## Scope
- Language: Zig
- Validation repo: ziglibs/known-folders
- Repo path: F:/Claude/projects/sdl-lsp-provider-first-repos/known-folders
- SDL repo id: known-folders-zig
- LSP server: zls
- Parser package: tree-sitter-zig@0.2.0

## Lazy Parser Evidence
Before the configured Zig index:

```text
TREE_SITTER_ZIG_NOT_INSTALLED_BEFORE
```

After indexing with languages=["zig"]:

```text
"name": "tree-sitter-zig"
"version": "0.2.0"
```

## LSP-IO Evidence
```text
cargo run -p lsp-io-cli -- install zls
Installed zls
C:\Users\glitt\AppData\Local\lsp-io\servers\zls\github-release\zls.exe

cargo run -p lsp-io-cli -- status | findstr /i "zls Zig"
zls                                Zig                    managed        github release

cargo run -p lsp-io-cli -- detect F:\Claude\projects\sdl-lsp-provider-first-repos\known-folders
Zig	Programming	High	build.zig, build.zig.zon, known-folders.zig

cargo run -p lsp-io-cli -- export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\known-folders --validate-launch
zls readiness: ready
languages/documentLanguageIds: zig
filePatterns: **/*.zig, **/*.zon, **/build.zig, **/build.zig.zon
capabilities: documentSymbol, diagnostics, definition, references
```

## Provider-First Index Evidence
```text
SDL_CONFIG=F:/Claude/projects/sdl-lsp-provider-first-repos/known-folders/sdlmcp.zig.config.json
SDL_GRAPH_DB_PATH=F:/Claude/projects/sdl-lsp-provider-first-repos/known-folders/.tmp/sdl-provider-first-lsp-zig.lbug
node dist/cli/index.js -c %SDL_CONFIG% index --repo-id known-folders-zig --force

Provider-first: lspFull (provider-first-lsp:1782275678034)
Provider-first timings: total=17884ms; collect=5101ms, scan=9006ms, materialize=74ms, legacy=444ms
Provider-first shadow DB finalized: files=4 symbols=100 edges=0 versions=1 metrics=100 fileSummaries=4
Provider-first coverage: 2/2 files provider-primary (0 full, 2 partial); legacy fallback parsed 2 file(s)
Files: 4
Symbols: 100 new (100 total)
Edges: 0 new (0 total)
```

## Graph Gate
```text
npm run check:provider-first-graph -- --db F:/Claude/projects/sdl-lsp-provider-first-repos/known-folders/.tmp/sdl-provider-first-lsp-zig.lbug --repo-root F:/Claude/projects/sdl-lsp-provider-first-repos/known-folders --repo-id known-folders-zig
PASS provider-first graph check: 0/5 gate(s) failed
```

## Smoke Ladder
```text
symbol.search: folder -> 742 results; first symbol folder in known-folders.zig
symbol.getCard: folder (variable)
slice.build: passed, handle f106bd71...
code.needWindow: approved L673-L673
```
