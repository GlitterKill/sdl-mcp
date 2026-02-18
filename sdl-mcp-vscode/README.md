# SDL MCP VSCode Extension

Provides inline SDL-MCP insights in VSCode/Cursor:

- Status bar connection + symbol count
- CodeLens fan-in/fan-out on declarations
- Hover symbol summary
- Commands:
  - `SDL: Show Blast Radius`
  - `SDL: Refresh Index`
  - `SDL: Show Diagnostics`

## Requirements

- SDL MCP server running in HTTP mode (`sdl-mcp serve --transport http`)
- REST endpoints available at `http://localhost:3000`

## Settings

- `sdl.serverUrl`: SDL server URL
- `sdl.repoId`: target repo id
- `sdl.autoConnect`: auto poll status
- `sdl.enableCodeLens`: toggle CodeLens
- `sdl.enableOnSaveReindex`: trigger incremental re-index on save (500ms debounce)
