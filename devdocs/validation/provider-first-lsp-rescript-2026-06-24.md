# ReScript Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: ReScript
- Validation repo: pending
- SDL lazy metadata: not configured

## Parser Pack

No ReScript parser package was installed. Package availability checks failed for both likely npm package names:

```text
npm view tree-sitter-rescript version -> E404
npm view @tree-sitter-grammars/tree-sitter-rescript version -> E404
```

## LSP-IO

`lsp-io status` reports `rescript-language-server` as `missing` with `system/manual` install mode.

Managed install is not available:

```text
Error: ReScript language server is not available for managed install. Install ReScript editor tooling or language server and ensure `rescript-language-server` is on PATH.
```

## Decision

ReScript remains unsupported for provider-first LSP indexing. SDL lazy language-pack metadata was intentionally not added because neither a loadable npm parser package nor a managed local LSP server is available in this environment.
