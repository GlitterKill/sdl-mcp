# src/cli/ - CLI Commands & Transports

## OVERVIEW
CLI binary (`sdl-mcp`) with subcommands. Supports stdio (default for MCP clients) and HTTP transports.

## STRUCTURE
- `index.ts` - CLI entry point, command dispatch
- `commands/` - Individual command implementations
- `transport/` - Transport layer (stdio, http)

### Commands
- `init.ts` - Initialize config + database
- `doctor.ts` - Health check and validation
- `index.ts` - Index repositories
- `serve.ts` - Start MCP server (`--stdio` or `--http`)
- `version.ts` - Show version info
- `benchmark.ts` - CI benchmark runner
- `export.ts` / `import.ts` / `pull.ts` - Sync artifact operations
- `summary.ts` - Token-bounded context summary
- `health.ts` - Index health score

### Transports
- `http.ts` - HTTP/SSE transport for development (serves static UI from `src/ui/`)
- stdio is handled by `@modelcontextprotocol/sdk` directly

## CONVENTIONS
- Commands register themselves in `index.ts`
- Serve command instantiates `MCPServer` from `src/server.ts`
- HTTP transport also serves static graph visualization UI
