# Incremental FileSummary Embedding Backlog Design

## Problem

Incremental indexing scopes FileSummary embedding refreshes to the files changed in the current run. The HNSW safety debounce defers fewer than 50 uncached vectors, but later runs do not reconsider rows deferred by earlier scopes. Small incremental runs can therefore leave Nomic vectors stale indefinitely, and the delegated CLI does not explain that the work was deferred.

## Decision

Keep the 50-row rebuild threshold. When a scoped refresh finds fewer uncached rows than the threshold, expand the candidate set to every FileSummary in the repository and compare stored embedding hashes. This reuses the database as the backlog: deferred rows remain hash-uncached and join later incremental work without a queue, migration, or new persisted state.

If the combined backlog still remains below the threshold, return the existing deferred count and emit an embedding progress event with a model-specific message. The CLI renders that event as a FileSummary embedding status such as `nomic: 33 deferred`.

## Data Flow

1. Load FileSummary rows for the current incremental file IDs.
2. Compute payload hashes and identify uncached rows.
3. If the scoped uncached count is below the rebuild threshold, load the repository-wide FileSummary set and recompute candidates.
4. Rebuild HNSW and embed when the combined backlog reaches the threshold.
5. Otherwise, preserve the uncached hashes and report the deferred count through `IndexProgress`.

Large incremental runs retain the scoped fast path. Small runs pay one repository-wide FileSummary hash scan, which is the minimum state-free mechanism that lets deferred work accumulate.

## Failure Handling

The existing checkpoint, HNSW drop/write/recreate, and degraded-result handling remain unchanged. Full bootstrap refreshes continue to bypass the debounce. FTS and FileSummary search text remain current while vectors wait for a safe rebuild batch.

## Verification

- Add an integration regression in `semantic-embedding.test.ts` that performs two disjoint sub-threshold incremental scopes and verifies that the second run embeds the combined backlog.
- Add a CLI renderer regression that verifies a deferred Nomic progress event prints the model and deferred count.
- Run the focused semantic embedding and CLI progress tests after rebuilding `dist`.
- Run TypeScript typechecking and the test-scope suites required by the changed source paths.
