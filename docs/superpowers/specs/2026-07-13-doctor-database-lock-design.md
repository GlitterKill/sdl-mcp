# Doctor Database-Lock Diagnostics Design

**Issue:** [#37](https://github.com/GlitterKill/sdl-mcp/issues/37)

## Goal

When an active SDL-MCP server owns LadybugDB, `sdl-mcp doctor` reports the database-access problem once and marks dependent database checks as skipped instead of claiming extensions or retrieval indexes are missing.

## Design

Reuse `findExistingProcess()` from `src/util/pidfile.ts` to identify a live server for the configured graph database before attempting the offline database check. Ignore a PID file owned by the current process.

Make the graph-database check the gate for stale-index, extension-capability, and retrieval-index checks. Add a `skip` doctor status so unavailable evidence is not rendered as a pass or counted as another warning. Independent checks continue normally.

## Verification

Add a regression test that keeps a real LadybugDB instance open in the test process and runs the compiled doctor CLI in a child process. Assert that the active-owner warning is present, dependent checks are skipped, and the false missing-extension/index messages are absent.
