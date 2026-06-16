# Provider-First LSP PowerShell Validation - 2026-06-16

This validation uses `PowerShell/PowerShellGet` as the PowerShell Wave 1 repository. It proves the PowerShell lazy language-pack path can consume a project-local `lsp-io` server override, initialize PowerShell Editor Services over stdio, materialize LSP-owned provider facts, pass the provider-first graph gate, and serve the normal symbol/card/slice/source-window smoke ladder.

## Repository

`F:\Claude\projects\sdl-lsp-provider-first-repos\PowerShellGet`

Graph database:

`F:\Claude\projects\sdl-lsp-provider-first-repos\PowerShellGet\.tmp\sdl-provider-first-lsp-powershell-fixed.lbug`

## Tooling Installed

- PowerShell 7.6.2 installed through winget.
- PowerShell Editor Services 4.6.0 downloaded from the upstream GitHub release zip and extracted under `C:\Users\glitt\AppData\Local\lsp-io\servers\powershell-editor-services\manual\PowerShellEditorServices`.
- Project-local `.lsp-io.toml` override exports `pwsh.exe` with `Start-EditorServices.ps1 -Stdio`.

## LSP-IO Export

`lsp-io export sdl-mcp F:\Claude\projects\sdl-lsp-provider-first-repos\PowerShellGet --validate-launch` exported the PowerShell server override with readiness `manual`:

```json
{
  "powershell-editor-services": {
    "enabled": true,
    "serverId": "powershell-editor-services",
    "command": "C:/Users/glitt/AppData/Local/Microsoft/WindowsApps/pwsh.exe",
    "args": ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/Users/glitt/AppData/Local/lsp-io/servers/powershell-editor-services/manual/PowerShellEditorServices/PowerShellEditorServices/Start-EditorServices.ps1", "-Stdio"],
    "languages": ["powershell"],
    "documentLanguageIds": ["powershell"],
    "filePatterns": ["**/*.ps1", "**/*.psd1", "**/*.psm1"],
    "capabilities": ["documentSymbol", "diagnostics", "definition", "references"],
    "readiness": "manual"
  }
}
```

## Initialize Fix

The initial SDL run sent a diagnostics-only client capabilities object. A raw LSP probe showed PowerShell Editor Services received `initialize` but failed while deriving rename registration options:

```text
Failed to handle request initialize 1
System.NullReferenceException: Object reference not set to an instance of an object.
at Microsoft.PowerShell.EditorServices.Handlers.RenameHandler.GetRegistrationOptions(...)
```

SDL now advertises conservative standard initialize capabilities, including `textDocument.rename`, `textDocument.documentSymbol`, `textDocument.definition`, `textDocument.references`, workspace folders, and UTF-16 position encoding. The direct raw probe then returned an `initialize` result from PowerShell Editor Services.

## Provider-First Index

Command:

```powershell
$env:SDL_CONFIG='F:\Claude\projects\sdl-lsp-provider-first-repos\PowerShellGet\sdlmcp.powershell.config.json'
$env:SDL_GRAPH_DB_PATH='F:\Claude\projects\sdl-lsp-provider-first-repos\PowerShellGet\.tmp\sdl-provider-first-lsp-powershell-fixed.lbug'
node dist\cli\index.js -c $env:SDL_CONFIG index --repo-id powershellget-powershell --force
```

Relevant result:

```text
Provider-first: lspFull (provider-first-lsp:1781640890061)
Provider-first shadow DB activated: F:/Claude/projects/sdl-lsp-provider-first-repos/PowerShellGet/.tmp/sdl-provider-first-lsp-powershell-fixed.lbug
Provider-first coverage: 31/31 files provider-primary (0 full, 31 partial)
Files: 31
Symbols: 856 new (856 total)
Edges: 0 new (0 total)
Duration: 82183ms
```

LSP provider-primary rows are partial because this wave materializes document symbols and diagnostics, not references/call proof.

## Graph Check

Command:

```powershell
npm run check:provider-first-graph -- --db F:\Claude\projects\sdl-lsp-provider-first-repos\PowerShellGet\.tmp\sdl-provider-first-lsp-powershell-fixed.lbug --repo-root F:\Claude\projects\sdl-lsp-provider-first-repos\PowerShellGet
```

Result:

```text
PASS provider-first graph check: 0/5 gate(s) failed
```

## Smoke Queries

`symbol.search` returned PowerShell LSP symbols from the indexed graph:

```text
query=Install total=5
2106831c9c694d85a07e7ac87b4a6097f625272c71d5f085163b0e23c7661d26 src/PowerShellGet.psm1 function "function Install-Module ()"
```

`symbol.getCard` returned a card for `Install-Module`:

```text
file: src/PowerShellGet.psm1
range: L1037-L1184
kind: function
signature: function function Install-Module ()
```

`slice.build` succeeded:

```text
sliceHandle: b5df4134bd8dede9dbff1abc1be789ee
ledgerVersion: v1781640954546
```

`code.needWindow` succeeded:

```text
approved: true
file: src/PowerShellGet.psm1
range: L1122-L1201
whyApproved: Identifiers matched: Install-Module
```

## Outcome

PowerShell is validated for Wave 1 provider-first LSP document-symbol materialization. Remaining quality work should collect definitions/references from PowerShell Editor Services and normalize PowerShell display names so signatures do not duplicate the `function` prefix.
