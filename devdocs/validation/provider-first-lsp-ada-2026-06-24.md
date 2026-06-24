# Ada Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Ada
- LSP-IO server: `ada-language-server`
- Parser package candidates checked: `tree-sitter-ada`, `@tree-sitter-grammars/tree-sitter-ada`
- Validation result: blocked before SDL language metadata or parser installation

## LSP-IO Server Check

`lsp-io status` reports Ada Language Server as managed:

```text
ada-language-server                Ada / SPARK            managed        github release
```

Managed install is already present:

```text
Ada Language Server is already managed by LSP-IO
C:\Users\glitt\AppData\Local\lsp-io\servers\ada-language-server\github-release\integration\vscode\ada\x64\win32\ada_language_server.exe
```

## Parser Package Check

No npm package was available for SDL's lazy language-pack loader:

```text
npm view tree-sitter-ada version
npm error 404 Not Found - GET https://registry.npmjs.org/tree-sitter-ada - Not found

npm view @tree-sitter-grammars/tree-sitter-ada version
npm error 404 Not Found - GET https://registry.npmjs.org/@tree-sitter-grammars%2ftree-sitter-ada - Not found
```

Cache check:

```text
C:\Users\glitt\.sdl-mcp\cache\language-packs\node_modules\tree-sitter-ada: not present
C:\Users\glitt\.sdl-mcp\cache\language-packs\node_modules\@tree-sitter-grammars\tree-sitter-ada: not present
```

## Result

Ada remains unsupported for provider-first LSP indexing because SDL-MCP cannot resolve an installable parser package. SDL lazy language-pack metadata was intentionally not added.

Do not mark Ada supported until an installable parser package artifact is available and the normal validation path passes: explicit SDL repo config, lazy parser install, lsp-io export, provider-first index with explicit `SDL_GRAPH_DB_PATH`, graph check, and symbol/card/slice/source-window smoke checks.
