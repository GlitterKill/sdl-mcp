# Doctor Database-Lock Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `sdl-mcp doctor` from emitting cascading false extension and retrieval-index warnings when another healthy SDL-MCP process owns LadybugDB.

**Architecture:** Reuse the existing PID-file process discovery helper as the actionable lock-owner signal. Treat the graph-database check as a prerequisite and represent dependent checks with an explicit skipped result when that prerequisite is unavailable.

**Tech Stack:** TypeScript, Node.js built-in test runner, LadybugDB, existing SDL-MCP CLI and PID-file utilities.

---

## Chunk 1: Regression and fix

### Task 1: Gate database-dependent doctor checks

**Files:**
- Modify: `tests/unit/cli-ladybug-doctor.test.ts`
- Modify: `src/cli/commands/doctor.ts`
- Modify: `docs/cli-reference.md`

- [ ] **Step 1: Write the failing regression test**

Hold a temporary LadybugDB open in the test process, create its sibling PID file with the existing `writePidfile()` helper, invoke `dist/cli/index.js doctor --config <path>` in a child process, and assert:
- output identifies the active SDL-MCP process as the reason offline database checks cannot run;
- stale-index, extension-capability, and retrieval-index checks are marked skipped;
- output does not contain `No Kuzu extensions loaded` or `No retrieval indexes found`;
- an independent check after the skipped group still runs;
- the child exits successfully and the warning summary equals the actual warning-line count, proving skipped checks are excluded from totals.

Always close LadybugDB, remove the PID file, restore process state, and remove the temporary directory in cleanup.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/unit/cli-ladybug-doctor.test.ts
```

Expected: the new assertion fails because current doctor output emits the cascading warnings.

- [ ] **Step 3: Implement the minimum fix**

In `doctor.ts`:
- import and reuse `findExistingProcess`;
- return one actionable warning from the graph-database check when a different live process owns the configured database;
- run the graph-database check before its dependents;
- add `skip` to `DoctorResult.status`;
- add explicit prerequisite metadata to the three database-dependent checks;
- skip those checks when graph-database verification did not pass;
- render skipped checks with a neutral marker and exclude them from warning/failure totals.

- [ ] **Step 4: Verify GREEN**

Rebuild `dist`, then re-run the focused test and confirm it passes.

- [ ] **Step 5: Update CLI documentation**

Document that database-dependent checks are reported as skipped when LadybugDB cannot be opened for offline inspection.

- [ ] **Step 6: Run affected verification**

Run:
- `npm run build:runtime` because the focused test imports `dist`;
- the three doctor unit test files;
- `npm run typecheck`;
- `npm run lint`;
- `git diff --check`.

Do not run adapter, native, property, stress, or mutation suites because the change is confined to CLI diagnostics.
