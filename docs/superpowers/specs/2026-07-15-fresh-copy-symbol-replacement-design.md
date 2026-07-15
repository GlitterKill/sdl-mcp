# Fresh-Copy Symbol Replacement Design

## Goal

Restore duplicate-safe symbol replacement in provider-first legacy fallback and cover the LadybugDB vector boundary with a real database regression.

## Design

Replace the source-regex assertion in `tests/unit/batch-persist.test.ts` with a temporary-LadybugDB regression. The test preloads more than 2,048 symbols, then sends an incoming `fresh-copy` batch with more than 2,048 distinct IDs and overlaps that straddle the boundary. A second batch forces another flush and connection reuse. The test verifies the exact expected Symbol total, confirms that the physical Symbol count equals the distinct `symbolId` count, and checks that replaced and untouched symbols retain the expected names and file relationships.

In `src/indexer/parser/batch-persist.ts`, remove `filterExistingSymbolIds()` and its read-pool dependency. Before raw COPY, pass every distinct incoming symbol ID to `deleteSymbolsByIds()` on the serialized write connection. Deleting an absent ID remains a no-op, while every overlapping row is removed before COPY.

## Verification

Follow a red-green cycle:

1. Rebuild `dist`, add the real database regression, and confirm it fails against the existing filtered-delete implementation for the expected count, duplicate, or stale-mapping invariant.
2. Apply the unconditional-delete change, rebuild `dist`, and confirm the regression passes.
3. Run the focused batch-persist tests, type checking, and linting.
4. Close LadybugDB and remove the temporary database plus any WAL artifacts in `finally`, including when an assertion fails.
5. Confirm the worktree retains only task changes plus the user's pre-existing `native/index.d.ts` modification.

## Deferred Work

Do not enable parallel CSV COPY, coalesce fresh-copy transactions, or use `SKIP_DUPLICATE_PK` in this fix. Those changes alter performance or replacement semantics and require separate persisted benchmarks and parity checks.
