# src/mcp/ - MCP Tool Layer

## OVERVIEW
JSON-RPC tool handlers for the MCP protocol. Centralized Zod validation in `server.ts`, tool-specific handlers in `tools/`.

## STRUCTURE
- `tools.ts` - ALL Zod request/response schemas (1650+ lines, single source of truth)
- `types.ts` - Re-export barrel pointing to `src/domain/types.ts`
- `errors.ts` - `PolicyDenialError`, `createPolicyDenial()`, `errorToMcpResponse()`
- `telemetry.ts` - Audit: `logToolCall()`, `logPolicyDecision()` (fire-and-forget)
- `token-usage.ts` - `attachRawContext()`, `computeTokenUsage()`, `stripRawContext()`

### tools/
- `index.ts` - `registerTools()`: maps every `sdl.*` name to schema + handler
- `repo.ts` - sdl.repo.register, status, overview, index.refresh
- `symbol.ts` - sdl.symbol.search, getCard, getCards
- `slice.ts` - sdl.slice.build, refresh, spillover.get
- `delta.ts` - sdl.delta.get
- `code.ts` - sdl.code.needWindow, getSkeleton, getHotPath
- `file-read.ts` - sdl.file.read
- `policy.ts` - sdl.policy.get, set
- `agent.ts` - sdl.agent.orchestrate
- `agent-feedback.ts` - sdl.agent.feedback, feedback.query
- `buffer.ts` - sdl.buffer.push, checkpoint, status
- `summary.ts` - 
- `prRisk.ts` - sdl.pr.risk.analyze

## ADDING A NEW TOOL

1. Define Zod schemas in `tools.ts` (`*RequestSchema` + `*ResponseSchema`)
2. Create handler in `tools/<domain>.ts` (receives validated args)
3. Register in `tools/index.ts`: `server.registerTool(name, desc, schema, handler)`
4. Handler pattern: re-parse args for type narrowing, `getLadybugConn()`, call domain logic

## CONVENTIONS
- Validation centralized in `server.ts` (`safeParse` before handler)
- Handlers re-parse defensively for type narrowing
- Tool naming: `sdl.<domain>.<verb>` (lowercase, dot-separated)
- DB access: `getLadybugConn()` per request, never hold connection refs
- Non-critical parallel calls: use `.catch(() => fallback)` to avoid cascading failures
- Prefetch: call `consumePrefetchedKey`/`prefetchCardsForSymbols` in handlers

## ANTI-PATTERNS
- No raw Cypher in tool handlers - use `ladybug-queries.ts`
- No tool registration outside `tools/index.ts`
- No schema definitions outside `tools.ts`
