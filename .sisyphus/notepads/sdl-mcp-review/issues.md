# Issues — sdl-mcp-review

## [2026-03-07] Remaining Review Issues

### HIGH Priority

- [ ] Fix 2: `beamSearchKuzu` has zero test coverage — primary production hot path
- [ ] Fix 3: Split `src/db/kuzu-queries.ts` (4,225 lines / 279 symbols) into domain modules
- [ ] Issue #14: `createTsCallResolver` called even when Rust engine used — unnecessary TS compiler startup

### MEDIUM Priority

- [ ] Issue #8: Tighten `env-variable` redaction pattern in `src/code/redact.ts` — too broad, false positives
- [ ] Issue #9: Fix `password` redaction pattern (matches code comments and schema field names)
- [ ] Issue #10: Fix incomplete Windows path traversal check in `handleRepoRegister` — missing `startsWith("..\\")`
- [ ] Issue #21: Add unit tests for `generateClusterLabel` heuristics in `cluster-orchestrator.ts`

### LOW Priority

- [ ] Issue #15: Fix `any` cast in `convertSchema` in `server.ts`
- [ ] Issue #17: Remove duplicate `uniqueLimit` in `src/mcp/tools/symbol.ts`
- [ ] Issue #22: Fix language detection by file extension in `live-index/coordinator.ts` — `.tsx`, `.mts`, `.cts` not handled
- [ ] Issue #23: Fix CRLF line endings in `src/agent/planner.ts`
- [ ] Issue #25: Move `fix_prRisk.js` from repo root to `scripts/` or delete it
