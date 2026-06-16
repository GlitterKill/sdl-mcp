# Provider-First LSP Wave 0 Smoke Evidence - 2026-06-16

This smoke validates SDL-MCP's Wave 0 LSP-IO integration boundary with a tiny local fixture. It does not mark PHP real-repo validated; the chart keeps PHP pending until `phpunit/phpunit` completes full provider-first graph validation. Shell/Bash real-repo validation is recorded separately in `devdocs/validation/provider-first-lsp-shell-2026-06-16.md`.

Fixture:

`F:\Claude\projects\sdl-lsp-provider-first-repos\wave0-smoke`

Files:

- `composer.json`
- `src/Tool.php`
- `scripts/run.sh`
- `.lsp-io.toml` with explicit `phpactor` and `bash-language-server` overrides

## LSP-IO Detect

Command:

```powershell
cargo run -p lsp-io-cli -- detect F:\Claude\projects\sdl-lsp-provider-first-repos\wave0-smoke --all-evidence
```

Result:

```text
PHP    Programming    High    composer.json, src\Tool.php
TOML   Data           High    .lsp-io.toml
```

## LSP-IO Status

Command:

```powershell
cargo run --manifest-path F:\Claude\projects\lsp-io\Cargo.toml -p lsp-io-cli -- status
```

Relevant result:

```text
phpactor                           PHP                    missing        system/manual
bash-language-server               Bash                   missing        npm
```

## LSP-IO Export

Command:

```powershell
cargo run -p lsp-io-cli -- export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\wave0-smoke --include-missing
```

Relevant exported server entries:

```json
{
  "bash-language-server": {
    "enabled": true,
    "serverId": "bash-language-server",
    "args": ["start"],
    "languages": ["bash"],
    "documentLanguageIds": ["shellscript", "bash"],
    "filePatterns": ["**/*.bash", "**/*.bats", "**/*.sh", "**/.bash_profile", "**/.bashrc"],
    "capabilities": ["documentSymbol", "diagnostics", "definition", "references"],
    "readiness": "missing"
  },
  "phpactor": {
    "enabled": true,
    "serverId": "phpactor",
    "args": [],
    "languages": ["php"],
    "documentLanguageIds": ["php"],
    "filePatterns": ["**/*.php", "**/composer.json"],
    "capabilities": ["documentSymbol", "diagnostics", "definition", "references"],
    "readiness": "missing"
  }
}
```

The commands confirm SDL-MCP should consume LSP server configuration from LSP-IO export and should not own LSP package-manager install recipes.
