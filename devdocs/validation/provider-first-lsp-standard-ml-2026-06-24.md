# Standard ML Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Standard ML
- Validation repo: pending
- SDL lazy metadata: not configured

## Parser Pack

No parser package was installed during this pass. Package availability checks:

```text
npm view tree-sitter-sml version -> E404
npm view tree-sitter-standard-ml version -> E404
npm view @tree-sitter-grammars/tree-sitter-sml version -> E404
```

## LSP-IO

Server: `millet`

```text
lsp-io status reports millet as managed via GitHub release, but no loadable npm parser package was found.
```

## Decision

Standard ML remains unsupported for provider-first LSP indexing. SDL lazy language-pack metadata was intentionally not added because no loadable npm parser package artifact is available in this environment.
