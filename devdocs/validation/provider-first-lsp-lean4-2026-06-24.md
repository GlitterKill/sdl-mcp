# Lean4 Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Lean4
- Validation repo: pending
- SDL lazy metadata: not configured

## Parser Pack

No parser package was installed during this pass. Package availability checks:

```text
npm view tree-sitter-lean version -> E404
npm view tree-sitter-lean4 version -> E404
npm view @tree-sitter-grammars/tree-sitter-lean version -> E404
```

## LSP-IO

Server: `lean-language-server`

```text
Error: Lean 4 language server is not available for managed install. Install Lean 4 with elan and ensure `lake` or `lean` is on PATH.
```

## Decision

Lean4 remains unsupported for provider-first LSP indexing. SDL lazy language-pack metadata was intentionally not added because neither a loadable npm parser package nor a managed local LSP server is available in this environment.
