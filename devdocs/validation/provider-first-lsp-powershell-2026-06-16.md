# Provider-First LSP PowerShell Validation Attempt - 2026-06-16

This validation attempt uses `PowerShell/PowerShellGet` as the PowerShell Wave 1 repository.

## Repository

`F:\Claude\projects\sdl-lsp-provider-first-repos\PowerShellGet`

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

## Provider-First Attempt

```text
Provider-first: lspFull (provider-first-lsp:1781638809277)
Provider-first coverage: 0/31 files provider-primary (0 full, 0 partial); 31 uncovered; legacy fallback parsed 31 file(s)
Files: 31
Symbols: 0 new (0 total)
Duration: 305521ms
```

## Direct LSP Probe

A direct `SemanticLspClient` probe using the same `Start-EditorServices.ps1 -Stdio` launch arguments timed out during `initialize` after 60 seconds.

The PowerShell Editor Services log shows the server starts:

```text
Editor Services version: 4.6.0
Transport is Stdio with debug disabled
PSES Startup Completed. Starting Language Server.
```

SDL did not receive an `initialize` response over stdio, so the provider-first run had no provider facts and correctly fell back.

## Result

PowerShell is not validated yet. The lazy parser pack and SDL/lsp-io configuration are present, but provider-first support remains pending until `powershell-editor-services` can complete the LSP initialize handshake through SDL's stdio client.
