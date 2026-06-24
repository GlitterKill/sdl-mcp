# Erlang Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Erlang
- LSP-IO server: `elp`
- Parser package candidates checked: `tree-sitter-erlang`, `@tree-sitter-grammars/tree-sitter-erlang`
- Validation result: blocked before SDL language metadata or parser installation

## LSP-IO Server Check

`lsp-io status` reports:

```text
elp                                Erlang                missing        system/manual
```

Managed install is unavailable:

```text
Error: Erlang Language Platform is not available for managed install. Install ELP or erlang_ls with upstream release/package-manager instructions and ensure the binary is on PATH.
```

## Parser Package Check

The unscoped npm package is not usable as a parser dependency:

```text
npm view tree-sitter-erlang version
0.0.1-security
```

The scoped grammar package is not published:

```text
npm view @tree-sitter-grammars/tree-sitter-erlang version
npm error 404 Not Found - GET https://registry.npmjs.org/@tree-sitter-grammars%2ftree-sitter-erlang - Not found
```

`npm search tree-sitter-erlang --json` did not return a maintained Erlang grammar package candidate.

## Result

Erlang remains unsupported for provider-first LSP indexing in this environment. SDL lazy language-pack metadata was intentionally not added because the parser package cannot be resolved and `elp` cannot be installed or exported by lsp-io without a manual upstream installation.

Do not mark Erlang supported until both prerequisites are available and the normal validation path passes: explicit SDL repo config, parser pack install through the lazy flow, lsp-io export, provider-first index with explicit `SDL_GRAPH_DB_PATH`, graph check, and symbol/card/slice/source-window smoke checks.
