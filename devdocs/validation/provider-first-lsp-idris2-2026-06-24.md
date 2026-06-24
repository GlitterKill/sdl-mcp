# Idris2 Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Idris2
- Validation repo: pending
- SDL lazy metadata: not configured

## Parser Pack

No parser package was installed during this pass. Package availability checks:

```text
npm view tree-sitter-idris version -> E404
npm view tree-sitter-idris2 version -> E404
npm view @tree-sitter-grammars/tree-sitter-idris version -> E404
```

## LSP-IO

Server: `idris2-lsp`

```text
Error: idris2-lsp is not available for managed install. Install idris2-lsp with Idris2 package tooling and ensure `idris2-lsp` is on PATH.
```

## Decision

Idris2 remains unsupported for provider-first LSP indexing. SDL lazy language-pack metadata was intentionally not added because neither a loadable npm parser package nor a managed local LSP server is available in this environment.
