# OCaml Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: OCaml
- LSP-IO server: `ocamllsp`
- Parser package: `tree-sitter-ocaml@^0.24.2`
- Validation result: lazy SDL metadata configured; provider-first validation blocked by unavailable LSP server

## Lazy Parser Metadata

SDL-MCP now has an on-demand OCaml language pack using `tree-sitter-ocaml` for `.ml` and `.mli` files. The package is intentionally not a root dependency and was not installed during this metadata-only change.

Cache check:

```text
C:\Users\glitt\.sdl-mcp\cache\language-packs\node_modules\tree-sitter-ocaml: not present
```

Package availability check:

```text
npm view tree-sitter-ocaml version
0.24.2
```

## LSP-IO Server Check

Managed install is unavailable in this Windows environment:

```text
Error: ocamllsp is not available for managed install. Install ocaml-lsp-server through opam and ensure `ocamllsp` is on PATH.
```

## Result

OCaml is not marked provider-first supported yet. Do not mark it supported until `ocamllsp` is available through lsp-io export and the normal validation path passes: explicit SDL repo config, lazy parser install, provider-first index with explicit `SDL_GRAPH_DB_PATH`, graph check, and symbol/card/slice/source-window smoke checks.
