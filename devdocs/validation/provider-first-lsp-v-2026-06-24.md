# V Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: V
- Validation repo: `F:\Claude\projects\sdl-lsp-provider-first-repos\v` (`vlang/v`)
- SDL config: `F:\Claude\projects\sdl-lsp-provider-first-repos\v\sdlmcp.v.config.json`
- Bounded source list: `F:\Claude\projects\sdl-lsp-provider-first-repos\v\.tmp\v-provider-first-files.txt` (40 V files)
- Graph DB: `F:\Claude\projects\sdl-lsp-provider-first-repos\v\.tmp\sdl-provider-first-lsp-v.lbug`

## LSP-IO

`lsp-io` installed `v-analyzer` as a managed GitHub release:

```text
C:\Users\glitt\AppData\Local\lsp-io\servers\v-analyzer\github-release\v-analyzer.exe
```

The initial SDL-MCP export selected `v-analyzer` but omitted `**/*.v` because V detection keeps the ambiguous `.v` extension gated behind `v.mod`. `lsp-io` was updated so SDL export includes `**/*.v` once `v-analyzer` has already been selected, without relaxing detection for unrelated repositories.

Validation for the export fix:

```text
cargo test -q -p lsp-io-core language::tests::ambiguous_v_extension_needs_project_marker
cargo test -q -p lsp-io-core server::registry::tests::v_analyzer_exports_v_sources_without_loose_detection
```

## Parser Pack

`tree-sitter-v` was not installed before the explicit V-configured validation attempt:

```text
TREE_SITTER_V_NOT_INSTALLED_BEFORE
```

During validation, the lazy language-pack flow installed `tree-sitter-v@1.0.7`, but direct parser loading failed under the current Node 24 / tree-sitter runtime:

```text
TypeError: Invalid language object
```

The package was removed after the failed validation:

```text
TREE_SITTER_V_ABSENT
```

## Provider-First Result

The V-configured provider-first run completed, but produced no usable provider-owned files or symbols:

```text
Provider-first: lspFull (provider-first-lsp:1782303381302)
Coverage: 0/40 provider-primary; 40 provider unusable
Legacy fallback parsed: 40
Files: 40
Symbols: 0
Edges: 0
```

The failing provider boundary was `textDocument/documentSymbol` availability for the indexed V files.

## Decision

V remains unsupported for provider-first LSP indexing. SDL lazy language-pack metadata was intentionally not committed because the parser package fails runtime compatibility and the local LSP validation produced no provider facts. The support chart now records V separately from the remaining pending Wave 3 languages.
