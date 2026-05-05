---
name: test-scope
description: Determine which test suites are affected by recent code changes and run only the relevant ones. Avoids running the full test matrix when only specific areas changed.
disable-model-invocation: true
---

# Targeted Test Runner

Analyze recent code changes to determine which test suites need to run, then execute only those.

## Test Suite Map

| Source Path Pattern | Test Suite | Run Command |
|---|---|---|
| `src/indexer/**`, `src/indexer/adapter/**` | Adapter harness | `npm run test:harness` |
| `src/mcp/tools/**`, `src/server.ts` | Golden snapshots | `npm run test:golden` |
| `src/code/skeleton*` | Skeleton determinism | `node --import tsx --test tests/skeleton-determinism.test.ts` |
| `src/graph/**`, `src/delta/**` | Slice/blast radius | `node --import tsx --test tests/slice-cache.test.ts tests/blastRadius.test.ts` |
| `src/mcp/**`, `src/db/**`, `src/config/**` | Unit tests | `npm test` |
| `native/**` | Native parity | `npm run test:native-parity` |
| `tests/property/**` | Property tests | `node --import tsx --test tests/property/*.test.ts` |
| Any `*.ts` in `src/` | Typecheck | `npm run typecheck` |

## Steps

1. **Detect changed files**:
   ```bash
   git diff --name-only HEAD
   git diff --name-only --cached
   ```
   If no uncommitted changes, use `git diff --name-only HEAD~1` instead.

2. **Map changes to test suites** using the table above. A single change can trigger multiple suites.

3. **Always run typecheck** if any `.ts` file in `src/` changed.

4. **Report the plan** before running:
   ```
   Changed files: 3
   Affected suites: typecheck, golden snapshots, unit tests
   Skipping: adapter harness, native parity, property tests, stress tests
   ```

5. **Execute the affected suites** sequentially. Use `sdl.workflow` with `runtimeExecute` if SDL-MCP is running, otherwise use Bash directly.

6. **Report results** with pass/fail status for each suite.

## Rules

- If changes touch `package.json`, `tsconfig.json`, or `eslint.config.mjs`, run the full suite (`npm test`)
- If changes touch only `.md`, `.json` (non-package), or config files, skip all test suites and report "No code changes — tests not needed"
- Never run `test:stress` or `test:mutation` automatically — those are opt-in only
- Run `npm run build:all` before any test suite that reads from `dist/`
