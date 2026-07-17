# Repeat Provider Materialization Safety Design

## Problem

CI run `29580560720` fails deterministically on the hosted Ubuntu benchmark runner while materializing the second sample against an existing LadybugDB graph. The provider-first planner deletes the existing provider symbols, then treats that database as fresh enough for `COPY Symbol`. LadybugDB still reports a duplicate primary key for the same symbol ID. Fresh local Windows and WSL runs pass, so the failure is specific to the hosted runtime's handling of delete followed by primary-key `COPY`, not duplicate provider input.

Deleting the benchmark repository cache and the Linux `node_modules` cache did not change the failure. The failure occurs before benchmark thresholds are evaluated.

## Design

Use known-fresh `COPY` writers only when no provider rows existed before the materialization plan was created. Repeat runs that are small enough to retire stale rows will:

1. delete the old provider symbols;
2. upsert replacement symbols with the merge-safe writer; and
3. rebuild edges with the generic edge writer.

Fresh databases retain the fast `COPY` path. Large repeat runs retain their existing row-reuse behavior. The benchmark continues to measure a real repeat index instead of resetting the database or turning the second sample into a no-op.

## Alternatives Rejected

- Retry `COPY` after the duplicate-key error: the native transaction may already be aborted, and retrying does not remove the unsafe assumption.
- Reset the database between benchmark samples: this hides repeat-index correctness and changes what the benchmark measures.
- Reuse rows for the second sample: this makes the sample a no-op and produces misleading timing.

## Verification

- Update the planner regression to require `deleteExistingFileSymbols: true`, `useKnownFreshWriters: false`, and `writeEdges: true` for small repeat runs.
- Add a materializer regression proving that delete plus merge-safe symbol upsert still rebuilds edges without symbol `COPY`.
- Run the focused provider-first suite, typecheck, lint, and the affected benchmark guardrail.
- Rerun GitHub Actions run `29580560720`; hosted Ubuntu success is the final proof for the environment-specific failure.
