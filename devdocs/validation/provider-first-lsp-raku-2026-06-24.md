# Raku Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Raku
- Validation repo: pending
- SDL lazy metadata: not configured

## Parser Pack

No Raku parser package was installed. Package availability checks failed for both likely npm package names:

```text
npm view tree-sitter-raku version -> E404
npm view @tree-sitter-grammars/tree-sitter-raku version -> E404
```

## LSP-IO

`lsp-io status` reports `raku-navigator` as `missing` with `system/manual` install mode.

Managed install is not available:

```text
Error: Raku Navigator is not available for managed install. Install Raku Navigator with upstream instructions and ensure `raku-navigator` is on PATH.
```

## Decision

Raku remains unsupported for provider-first LSP indexing. SDL lazy language-pack metadata was intentionally not added because neither a loadable npm parser package nor a managed local LSP server is available in this environment.
