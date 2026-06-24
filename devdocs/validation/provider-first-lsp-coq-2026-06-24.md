# Coq Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Coq
- Validation repo: pending
- SDL lazy metadata: not configured

## Parser Pack

No parser package was installed during this pass. Package availability checks:

```text
npm view tree-sitter-coq version -> E404
npm view @tree-sitter-grammars/tree-sitter-coq version -> E404
```

## LSP-IO

Server: `coq-lsp`

```text
Error: coq-lsp is not available for managed install. Install coq-lsp through opam and ensure `coq-lsp` is on PATH.
```

## Decision

Coq remains unsupported for provider-first LSP indexing. SDL lazy language-pack metadata was intentionally not added because neither a loadable npm parser package nor a managed local LSP server is available in this environment.
