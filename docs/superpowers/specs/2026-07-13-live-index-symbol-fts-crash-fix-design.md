# Live-index Symbol FTS Crash Fix Design

## Problem

`sdl.file.write` and `sdl.search.edit` reconcile indexed source files through `syncLiveIndex()` and `patchSavedFile()`. With LadybugDB 0.16.1, repeated Symbol row updates inside that reconciliation transaction can terminate Node with Windows access violation `0xC0000005` while the Symbol FTS index is active. The crash is independent of HTTP transport and file watching, so `--no-watch` does not mitigate it.

The isolated real-graph trace dies during the fourteenth consecutive matched-symbol `upsertSymbol()`, before matched-edge insertion or removed-symbol deletion. Dropping the Symbol FTS index before the same transaction makes it complete.

## Design

Keep the fix at the shared `patchSavedFile()` boundary so every caller is covered. The helper `withSymbolFtsPausedForPatch()` wraps the existing mutation transaction and keeps the file/reference/Symbol/edge reconciliation logic unchanged.

1. Skip FTS lifecycle work when the FTS extension is unavailable or semantic Symbol FTS is disabled in config.
2. Drop the configured Symbol FTS index before beginning the mutation transaction.
3. If the drop fails, abort before mutating Symbol rows.
4. Run the existing transaction unchanged.
5. Rebuild the Symbol FTS index after a successful mutation when the drop result was `dropped` or `absent`. This lets a database recover if the index was previously absent because the Symbol table was empty.
6. Accept `created`, `exists`, and `empty` rebuild results. `empty` means the Symbol table still has no rows, so there is no index to build yet.
7. If the mutation fails, rebuild only when this call dropped the index. Preserve the mutation error as primary. If rebuild also fails, append `Symbol FTS may be absent` context to the mutation error and log the rebuild failure.
8. If the mutation succeeds but rebuild fails or throws, return an explicit `IndexError` so callers do not silently operate without Symbol search.

The fix exports `SYMBOL_FTS_INDEX_NAME` from `index-lifecycle.ts` and reuses the existing `dropFtsIndex()` and `ensureFtsIndexForNonEmptyTable()` helpers. It does not add a new dependency.

## Tradeoffs

`search.edit` operations that patch multiple indexed files now rebuild Symbol FTS once per patched file. That is the smallest shared fix and protects `file.write`, `search.edit`, and checkpoint-driven callers without changing batch application semantics.

The acceptance threshold for the real 27,000-symbol crash fixture is under 2 seconds for a planner-only patch and under 5 seconds for a two-file sequential patch. The measured run after the fix was 1.56 seconds for `src/agent/planner.ts` and 4.47 seconds total for `src/agent/planner.ts` plus `src/server.ts`.

If broader multi-file edit timing becomes disproportionate, add a batch-level wrapper around `search.edit` apply so it can drop once, patch all files, and rebuild once. Do not add that wrapper until a measured multi-file case exceeds the threshold above or shows repeated latency in normal use.

During the write window, readers can briefly observe a missing Symbol FTS index. Existing retrieval paths already handle missing FTS as an index availability issue. The alternative is a broader read/write coordination change, which is larger than the crash fix and not needed to prevent process termination.

## Testing

- Add unit coverage for `withSymbolFtsPausedForPatch()` covering disabled FTS, drop failure before mutation, absent-index recovery after success, accepted empty rebuilds, no rebuild after an absent-index mutation failure, rebuild after a dropped-index mutation failure, rebuild failure after success, mutation-error precedence when mutation and rebuild both fail, and non-`Error` rejection values such as `undefined`.
- Add an opt-in subprocess regression that copies a realistic FTS-enabled graph supplied by `SDL_LIVE_INDEX_FTS_FIXTURE`, verifies that `SYMBOL_FTS_INDEX_NAME` exists, patches `src/agent/planner.ts`, and asserts that the child exits normally. The parent owns the temporary graph copy and removes it in `finally`, so cleanup runs after success or native child termination. The subprocess protects the test runner from native termination and has a 30-second timeout so deadlocks fail instead of hanging the suite.
- Keep the realistic graph test opt-in because generating a 27,000-symbol FTS graph inside the suite exceeded three minutes, and checking in the database would add roughly 117 MB of opaque test data.
- Run `npm run build:all`, the new lifecycle unit test, the fixture-backed crash test, the existing file-patcher test, `npm run typecheck`, and `npm run lint`.
