# Vala Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Vala
- Validation repo: pending
- SDL lazy metadata: not configured

## Parser Pack

No Vala parser package was installed. Package availability checks failed for both likely npm package names:

```text
npm view tree-sitter-vala version -> E404
npm view @tree-sitter-grammars/tree-sitter-vala version -> E404
TREE_SITTER_VALA_ABSENT
```

## LSP-IO

`lsp-io status` reports `vala-language-server` as `missing` with `system/manual` install mode.

Managed install is not available:

```text
Error: vala-language-server is not available for managed install. Install vala-language-server with your package manager or upstream release and ensure it is on PATH.
```

## Decision

Vala remains unsupported for provider-first LSP indexing. SDL lazy language-pack metadata was intentionally not added because neither a loadable npm parser package nor a managed local LSP server is available in this environment.
