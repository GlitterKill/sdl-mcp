# src/code-mode/ - Code Mode (Chain Execution)

## OVERVIEW
Code Mode enables LLMs to batch multiple SDL-MCP operations in a single MCP round-trip. Two tools (`sdl.manual` + `sdl.chain`) replace N sequential tool calls with one chain request that uses `$N` inter-step references, budget tracking, context-ladder validation, and cross-step ETag caching.

## KEY FILES

| File | Purpose |
|------|---------|
| `index.ts` | `registerCodeModeTools()` — registers `sdl.manual` + `sdl.chain` on MCPServer |
| `types.ts` | Zod schemas (`ChainRequestSchema`, `ChainBudgetSchema`, etc.) + TS types |
| `descriptions.ts` | `MANUAL_DESCRIPTION` and `CHAIN_DESCRIPTION` tool description strings |
| `manual-generator.ts` | `FN_NAME_MAP` (29 actions), `generateManual()`, `getManualCached()` |
| `chain-parser.ts` | `parseChainRequest()` — validates chain JSON, maps fn→action, checks `$N` refs |
| `ref-resolver.ts` | `resolveRefs()`, `resolveRef()`, `RefResolutionError` — `$N` path resolution |
| `chain-budget.ts` | `ChainBudgetTracker` class — token/step/duration limits with min(request, config) |
| `ladder-validator.ts` | `validateLadder()` — context ladder rung ordering enforcement |
| `etag-cache.ts` | `ChainEtagCache` class — cross-step ETag injection/extraction for card requests |
| `chain-executor.ts` | `executeChain()` — sequential execution with budget, etag, ladder, abort support |

## CONVENTIONS
- Tools are registered via `registerCodeModeTools()` called from `src/mcp/tools/index.ts`
- Can run in three modes: exclusive (only code-mode tools), alongside gateway, alongside flat tools
- Chain steps execute sequentially; `$N` references resolve to prior step results
- Budget is min(request budget, server config limits)
- Ladder validation checks context escalation order (search→card→skeleton→hotPath→window)
- ETag cache spans the entire chain execution; injected on card requests, extracted from results

## ANTI-PATTERNS
- No parallel step execution (steps depend on prior results via `$N` refs)
- No direct DB access — all operations route through gateway `routeGatewayCall()`
- No schema definitions here — chain request schemas are in `types.ts`, action schemas are in `src/mcp/tools.ts`
