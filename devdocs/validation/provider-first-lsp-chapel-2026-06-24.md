# Chapel Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Chapel
- Validation repo: pending
- SDL lazy metadata: not configured

## Parser Pack

No parser package was installed during this pass. Package availability checks:

```text
npm view tree-sitter-chapel version -> E404
npm view @tree-sitter-grammars/tree-sitter-chapel version -> E404
```

## LSP-IO

Server: `chapel-language-server`

```text
Error: Chapel Language Server is not available for managed install. Install Chapel language tooling and ensure `chapel-language-server` is on PATH.
```

## Decision

Chapel remains unsupported for provider-first LSP indexing. SDL lazy language-pack metadata was intentionally not added because neither a loadable npm parser package nor a managed local LSP server is available in this environment.
