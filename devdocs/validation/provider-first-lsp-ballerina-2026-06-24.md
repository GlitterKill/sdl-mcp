# Ballerina Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Ballerina
- Validation repo: pending
- SDL lazy metadata: not configured

## Parser Pack

No parser package was installed during this pass. Package availability checks:

```text
npm view tree-sitter-ballerina version -> E404
npm view @tree-sitter-grammars/tree-sitter-ballerina version -> E404
```

## LSP-IO

Server: `ballerina-language-server`

```text
Error: Ballerina Language Server is not available for managed install. Install Ballerina and ensure `bal` is on PATH.
```

## Decision

Ballerina remains unsupported for provider-first LSP indexing. SDL lazy language-pack metadata was intentionally not added because neither a loadable npm parser package nor a managed local LSP server is available in this environment.
