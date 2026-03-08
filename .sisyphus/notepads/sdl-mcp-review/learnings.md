# Learnings — sdl-mcp-review

## [2026-03-07] Session 1 — Code Review + Fixes 1, 4, 5

### ESM / Import Rules

- All imports MUST have `.js` extension (ESM requirement)
- Integration tests import from `dist/` (compiled), NOT `src/`
- Test framework: Node.js built-in `node:test` with `assert` from `node:assert`

### Test Patterns

- Integration tests: `tests/integration/` — use `dist/` imports
- Unit tests: `tests/unit/` — use `dist/` imports
- KuzuDB setup: `initKuzuDb(path)`, `getKuzuConn()`, `createSchema(conn)`, cleanup with `closeKuzuDb()` + `rmSync`
- Test runner: `bun test` (runs all tests in `tests/`)
- Reference integration test: `tests/integration/kuzu-slice-build.test.ts`
- Reference unit test: `tests/unit/beam-parallel-parity.test.ts`

### beamSearchKuzu Signature

```typescript
beamSearchKuzu(
  conn: Connection,
  repoId: RepoId,
  startNodes: ResolvedStartNode[],
  budget: Required<SliceBudget>,
  request: BeamSearchRequest,
  edgeWeights: Record<EdgeType, number>,
  minConfidence: number
): Promise<BeamSearchResult>
```

- `ResolvedStartNode`: `{ symbolId: string, source: "entrySymbol" | "entryFirstHop" | ... }`
- `BeamSearchResult`: `{ sliceCards: Set<SymbolId>, frontier: FrontierItem[], wasTruncated: boolean, droppedCandidates: number }`
- Located in: `src/graph/slice/beam-search-engine.ts` (lines 436–802)

### DB Setup Helpers (for tests)

- `kuzuDb.upsertRepo(conn, { repoId, rootPath, configJson, createdAt })`
- `kuzuDb.upsertFile(conn, { fileId, repoId, relPath, contentHash, language, byteSize, lastIndexedAt, directory })`
- `kuzuDb.upsertSymbol(conn, { symbolId, repoId, fileId, kind, name, exported, visibility, language, rangeStartLine, rangeStartCol, rangeEndLine, rangeEndCol, astFingerprint, signatureJson, summary, invariantsJson, sideEffectsJson, updatedAt })`
- `kuzuDb.insertEdge(conn, { repoId, fromSymbolId, toSymbolId, edgeType, weight, confidence, resolution, provenance, createdAt })`
- `kuzuDb.createVersion(conn, { versionId, repoId, createdAt, reason, prevVersionHash, versionHash })`

### Fixes Applied

- **Fix 1 (DONE)**: `src/server.ts` — centralized Zod `safeParse` before handler dispatch; returns `VALIDATION_ERROR` with path details
- **Fix 4 (NO-OP)**: LRUCache `lock` IS used correctly in `set()`. False finding.
- **Fix 5 (DONE)**: `src/mcp/tools/slice.ts` + `src/graph/slice.ts` — typed `instanceof DatabaseError/ValidationError` replaces string-matching catch blocks

### kuzu-queries.ts Split (Fix 3)

- File: `src/db/kuzu-queries.ts` — 4,225 lines, 279 symbols
- Strategy: Create `src/db/modules/` with domain files, re-export everything from `kuzu-queries.ts` for backward compat
- Domain modules: `file-queries.ts`, `symbol-queries.ts`, `edge-queries.ts`, `cluster-queries.ts`, `metrics-queries.ts`, `version-queries.ts`, `repo-queries.ts`
- MUST maintain all existing exports (backward compat — many files import from kuzu-queries.ts)

### Policy / Architecture

- Hexagonal architecture: indexer produces domain objects, db owns persistence
- Windows path handling required: use `src/util/paths.ts`
- All DB operations through `src/db/kuzu-queries.ts`
- Typed errors from `src/mcp/errors.ts`: `DatabaseError`, `ValidationError`, `PolicyError`, `ConfigError`, `IndexError`
