# Crystal Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Crystal
- LSP-IO server: `crystalline`
- Parser package candidate checked: `tree-sitter-crystal`
- Validation result: blocked before SDL language metadata or parser installation

## LSP-IO Server Check

`lsp-io status` reports:

```text
crystalline                        Crystal                missing        system/manual
```

## Parser Package Check

No npm package was available for SDL's lazy language-pack loader:

```text
npm view tree-sitter-crystal version
npm error 404 Not Found - GET https://registry.npmjs.org/tree-sitter-crystal - Not found
```

## Result

Crystal remains unsupported for provider-first LSP indexing. SDL lazy language-pack metadata was intentionally not added because neither a managed lsp-io server nor a loadable npm parser package is available in this environment.
