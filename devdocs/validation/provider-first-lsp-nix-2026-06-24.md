# Nix Provider-First LSP Validation Attempt - 2026-06-24

## Scope

- Language: Nix
- Planned LSP-IO server: nil
- Parser pack: tree-sitter-nix@^0.0.2
- Status: not supported yet; provider-first validation is blocked by unavailable local LSP server.

## SDL-MCP State

Nix has lazy language-pack metadata only. The root package dependencies were not changed, and tree-sitter-nix should only be installed when a repository explicitly configures language nix.

Configured metadata:

- languageId: nix
- extensions: .nix
- parserPackage: tree-sitter-nix
- lspServerId: nil
- installMode: onDemand

## LSP-IO State

Commands:

```powershell
cd F:/Claude/projects/lsp-io
cargo run -q -p lsp-io-cli -- status
cargo run -q -p lsp-io-cli -- install nil
```

Observed result:

- status reports nil / Nix as missing with installer system/manual.
- install nil fails: nil is not available for managed install. Install nil through Nix, Mason, or your package manager and ensure nil is on PATH.

## Decision

Do not mark Nix provider-first as supported until nil or another Nix LSP server is available through lsp-io and the normal validation path passes: LSP export, explicit SDL repo config, provider-first index, graph check, and symbol/card/slice/source-window smoke checks.
