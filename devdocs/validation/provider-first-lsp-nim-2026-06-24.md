# Nim Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Nim
- LSP-IO server: `nimlangserver`
- Parser package candidate checked: `tree-sitter-nim`
- Validation result: blocked before SDL language metadata or parser installation

## LSP-IO Server Check

`lsp-io` installed `nimlangserver` from GitHub release:

```text
nimlangserver                      Nim                    missing        github release
Installed nimlangserver
C:\Users\glitt\AppData\Local\lsp-io\servers\nimlangserver\github-release\nimlangserver.exe
```

## Parser Package Check

No npm package was available for SDL's lazy language-pack loader:

```text
npm view tree-sitter-nim version
npm error 404 Not Found - GET https://registry.npmjs.org/tree-sitter-nim - Not found
```

Public tree-sitter Nim grammars exist on GitHub, but the current SDL lazy-pack registry expects a loadable package artifact. Metadata was not added.

## Result

Nim remains unsupported for provider-first LSP indexing because SDL-MCP cannot resolve an installable parser package. Do not mark Nim supported until a loadable parser package artifact is available and the normal validation path passes.
