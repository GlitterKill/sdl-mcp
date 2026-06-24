# Common Lisp Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Common Lisp
- Validation repo: pending
- SDL lazy metadata: configured

## Parser Pack

No parser package was installed during this pass. Package availability checks:

```text
npm view tree-sitter-commonlisp -> 0.4.1
npm view @tree-sitter-grammars/tree-sitter-commonlisp -> E404
```

## LSP-IO

Server: `cl-lsp`

```text
Error: cl-lsp is not available for managed install. Install cl-lsp with upstream instructions and ensure `cl-lsp` is on PATH.
```

## Decision

Common Lisp has SDL lazy language-pack metadata, but remains unsupported for provider-first LSP indexing until a local cl-lsp server is available through `lsp-io` or the system PATH and provider-first graph validation can run against a real Common Lisp repository.
