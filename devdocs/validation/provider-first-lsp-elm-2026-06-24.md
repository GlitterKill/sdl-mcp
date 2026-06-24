# Elm Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Elm
- Validation repo: `elm/http`
- Repo path: `F:\Claude\projects\sdl-lsp-provider-first-repos\elm-http`
- LSP-IO server: `elm-language-server`
- Parser package candidate: `tree-sitter-elm@4.5.0`
- Validation result: blocked; SDL metadata not committed

## LSP-IO Server Check

`lsp-io` detected Elm in `elm/http` and installed/exported `elm-language-server`:

```text
elm-language-server                Elm                    missing        npm
Installed elm-language-server
C:\Users\glitt\AppData\Local\lsp-io\servers\elm-language-server\npm\node_modules\.bin\elm-language-server.cmd
```

Exported SDL-MCP server config included:

```text
command: C:\Users\glitt\AppData\Local\lsp-io\servers\elm-language-server\npm\node_modules\.bin\elm-language-server.cmd
documentLanguageIds: ["elm"]
filePatterns: **/*.elm, **/elm.json
capabilities: documentSymbol, diagnostics, definition, references
readiness: ready
```

## Parser Package Check

`tree-sitter-elm@4.5.0` exists on npm and was installed only after an explicit Elm-configured validation run. The package did not load with SDL-MCP's current Node tree-sitter binding:

```text
TREE_SITTER_ELM_INSTALLED_AFTER
TypeError: Invalid language object
    at Parser.setLanguage (...node_modules\tree-sitter\index.js:351:17)
```

The failed cache package was removed after the validation attempt:

```text
TREE_SITTER_ELM_REMOVED
```

## Provider-First Index Attempt

A clean provider-first index ran against `elm/http` with explicit `SDL_GRAPH_DB_PATH`, but did not produce provider symbols:

```text
Provider-first: lspFull (provider-first-lsp:1782302408881)
Provider-first coverage: 0/1 files provider-primary (0 full, 0 partial); 1 provider unusable; legacy fallback parsed 1 file(s)
Provider-unusable: documentSymbol request failed for src/Http.elm
Files: 1
Symbols: 0
Edges: 0
```

## Result

Elm remains unsupported for provider-first LSP indexing. SDL lazy language-pack metadata was intentionally reverted because the available npm parser package fails the runtime compatibility check and the LSP validation produced no usable document symbols.

Do not mark Elm supported until a loadable parser package and a document-symbol-producing LSP validation are available, followed by graph check and symbol/card/slice/source-window smoke checks.
