# tests/ - Test Infrastructure

## OVERVIEW
580+ test files using Node.js built-in test runner (`node:test`). No vitest, no jest.

## STRUCTURE
- `runner.test.ts` - Dynamic test importer (entry point for `node --test`)
- `unit/` - ~145 files, isolated unit tests
- `integration/` - ~26 files, full indexer+DB round-trips
- `benchmark/` - 4 files, performance regression tests
- `native/` - 3 files, Rust/TS parity tests
- `property/` - 1 file, fast-check property tests (slice invariants)
- `mutation/` - 1 file, Stryker mutation test (`paths.ts` only)
- `type/` - 1 file, `.test-d.ts` branded-ID type tests
- `harness/` - MCP SDK client harness + golden file validator
- `golden/` - JSON snapshots for MCP tool response validation
- `fixtures/` - Multi-language test corpus (14 languages)

## RUNNING TESTS

```bash
npm test                                              # Full suite (builds first, parallel isolated workers)
npm run test:unit                                    # Unit test group only
npm run test:integration                             # Integration test group only
npm run test:native                                  # Native addon parity + smoke path (requires built addon)
node scripts/run-tests.mjs --group=golden            # Node tests in tests/golden/
SDL_TEST_JOBS=2 npm test                             # Override worker count
node --experimental-strip-types --test tests/unit/my.test.ts  # Single file (set SDL_GRAPH_DB_PATH)
```

## CONVENTIONS
- All tests use: `import { describe, it } from "node:test"` and `import assert from "node:assert"`
- Test concurrency: `scripts/run-tests.mjs` runs isolated test files through a small worker pool; `SDL_TEST_JOBS` overrides the default `min(4, availableParallelism - 1)`.
- Native addon disabled: `SDL_MCP_DISABLE_NATIVE_ADDON=1`
- Native parity is not proven by `npm test`; use `npm run test:native` after building/configuring the addon.
- DB in temp dir: each isolated test process receives its own `SDL_GRAPH_DB_PATH`
- Build runs automatically before tests (`scripts/run-tests.mjs`)
- `.test-d.ts` files run as normal `node:test` (not tsd tool)
- Golden snapshots: `npm run test:golden` validates response snapshots, `npm run golden:update` regenerates them; `npm run test:golden-files` runs the Node test files under `tests/golden/`

## ADDING A TEST
Drop a `*.test.ts` file in `unit/` or `integration/` - auto-discovered by `runner.test.ts`.

## TROUBLESHOOTING

### "Database ID does not match" / WAL Corruption Errors

LadybugDB unit tests create temp databases in `%TEMP%` (Windows) or `/tmp` (Unix). If tests crash or are killed mid-run, stale `.wal` files remain. Next run fails with:

```
Error [DatabaseError]: LadybugDB initialization failed ... Database ID for temporary file '...wal' does not match
```

**Fix**: Delete orphaned WAL files:

```javascript
// Node one-liner (cross-platform)
node -e "const fs=require('fs'),p=require('path'),t=process.env.TEMP||'/tmp';fs.readdirSync(t).filter(f=>f.startsWith('.lbug-')).forEach(f=>fs.rmSync(p.join(t,f),{recursive:true,force:true}))"
```

Or via SDL workflow:
```json
{"fn": "runtimeExecute", "args": {"runtime": "node", "code": "const fs=require('fs'),p=require('path'),t=process.env.TEMP||'/tmp';fs.readdirSync(t).filter(f=>f.startsWith('.lbug-')).forEach(f=>{fs.rmSync(p.join(t,f),{recursive:true,force:true});console.log('Deleted:',f)})"}}
```

Affected tests: `card-builder.test.ts`, `cluster-orchestrator-unit.test.ts`, `ladybug-algorithms.test.ts`, and others using `resetDb()` with temp LadybugDB paths.

## IMPORT PATHS

Tests import from `dist/` (compiled output), **not** `src/`. Static analysis tools like fallow will miss these imports when searching for consumers of a source export. Always check `tests/` for `dist/` imports before removing "unused" exports from `src/`.

Tests run with `--experimental-strip-types`, **not** tsx. Do not use `--import tsx` to run tests.

## ANTI-PATTERNS
- No vitest/jest imports (use `node:test`)
- No test-only DB instances (shared temp dir LadybugDB)
- No deleting tests to make CI pass
- No removing "unused" exports without checking test imports from `dist/`
