# Racket Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Racket
- Validation repo: pending
- SDL lazy metadata: not configured

## Parser Pack

No Racket parser package was installed. Package availability checks failed for both likely npm package names:

```text
npm view tree-sitter-racket version -> E404
npm view @tree-sitter-grammars/tree-sitter-racket version -> E404
```

## LSP-IO

`lsp-io status` reports `racket-langserver` as `missing` with `system/manual` install mode.

Managed install is not available:

```text
Error: racket-langserver is not available for managed install. Install racket-langserver with Racket package tools and ensure `racket-langserver` is on PATH.
```

## Decision

Racket remains unsupported for provider-first LSP indexing. SDL lazy language-pack metadata was intentionally not added because neither a loadable npm parser package nor a managed local LSP server is available in this environment.
