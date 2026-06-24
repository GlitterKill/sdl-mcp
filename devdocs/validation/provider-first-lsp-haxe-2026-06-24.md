# Haxe Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Haxe
- Validation repo: pending
- SDL lazy metadata: configured
- Parser package: `tree-sitter-haxe@^0.13.0`
- LSP-IO server: `haxe-language-server`

## Parser Pack

No Haxe parser package was installed during this pass. The package exists on npm and is configured for lazy installation only when a repo config explicitly enables Haxe:

```text
npm view tree-sitter-haxe version -> 0.13.0
TREE_SITTER_HAXE_ABSENT
```

`@tree-sitter-grammars/tree-sitter-haxe` is not published, so SDL uses `tree-sitter-haxe`.

## LSP-IO

`lsp-io status` reports `haxe-language-server` as `missing` with `system/manual` install mode.

Managed install is not available:

```text
Error: Haxe Language Server is not available for managed install. Install Haxe and haxe-language-server with haxelib/upstream instructions and ensure the binary is on PATH.
```

## Decision

Haxe has SDL lazy language-pack metadata, but remains unsupported for provider-first LSP indexing until a local Haxe Language Server is available through `lsp-io` or the system PATH and provider-first graph validation can run against a real Haxe repository.
