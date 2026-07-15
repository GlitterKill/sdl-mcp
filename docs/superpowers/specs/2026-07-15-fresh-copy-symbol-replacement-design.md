# Provider-First Symbol Integrity Design

## Goal

Keep provider-first fallback replacement duplicate-safe and prevent LadybugDB
0.18.1 from corrupting bulk-loaded Symbol rows during placeholder cleanup.

## Root Cause

Provider and fallback inputs contain unique, non-overlapping IDs. Their bulk
Symbol COPY operations also remain unique. Corruption begins when
`pruneIsolatedPlaceholderSymbols()` mutates the tail of a large Symbol table.
On LadybugDB 0.18.1, deleting an isolated placeholder node, deleting its
`SYMBOL_IN_REPO` relationship, or updating the node in place can alias values
from rows 2,048 positions earlier. Later Metrics COPY then observes duplicate
`symbolId` values and finalization stops before semantic embeddings run.

## Design

Retain isolated placeholders when the Symbol table has more than 2,048 rows.
This avoids every Symbol-adjacent mutation that reproduced the LadybugDB 0.18.1
aliasing defect. Keep the existing physical cleanup for smaller databases, where
the delete path remains safe. Placeholder IDs are deterministic, so unchanged
indexes reuse the retained rows; newly encountered unresolved targets can
accumulate until the compatibility guard is removed after an engine fix.

Keep the existing scalar-probed placeholder COPY path. Routing placeholders
through MERGE did not prevent corruption in a release-scale topology, so it is
not part of this fix.

Apply the same fail-closed boundary before shadow finalization. A staged shadow
with more than 2,048 Symbol rows must return `skipped` before
`resetBulkFinalizationTargets()` deletes relationships or nodes. This preserves
the staged candidate for inspection and keeps activation disabled until shadow
finalization can build the final topology without destructive reset mutations.

Fresh-copy fallback still replaces every distinct incoming ID before COPY.
Remove `filterExistingSymbolIds()` and pass `incomingSymbolIds` directly to
`deleteSymbolsByIds()`: deleting an absent ID is a no-op and avoids making
replacement correctness depend on a separate read-pool probe.

Replace the source-regex test with a real temporary-LadybugDB regression. It
preloads 4,096 symbols, drains multiple fresh-copy batches with overlapping IDs,
creates 58 dependency placeholders through the public API, exercises guarded
pruning, and then asserts exact counts plus symbol/name/file mappings across the
2,048 boundary.

## Verification

1. Prove the real database regression fails when placeholder cleanup mutates a
   release-scale Symbol table.
2. Retain isolated placeholders above the safe row limit and confirm the
   regression passes without changing the small-database cleanup behavior.
3. Run the focused batch, edge, and Ladybug write suites.
4. Run type checking, linting, and a clean provider-first CLI index.
5. Verify physical Symbol count equals distinct `symbolId` count and that symbol
   and file-summary embeddings complete.

The release-scale verification completed against a fresh isolated active DB:
28,001 physical Symbol rows equaled 28,001 distinct IDs; all 27,864 real,
file-backed symbols had Jina embeddings; all 1,407 file summaries had Nomic
embeddings; and Metrics and SymbolVersion each contained 27,864 rows. The guard
retained 51 isolated placeholders.

The release-scale run also exposed the same engine defect in the separately
staged shadow candidate: destructive reset aliased Symbol identities, after
which the existing count gate rejected 25,881 joined Metrics and SymbolVersion
rows instead of 27,864. The active DB was not replaced and remained correct.
The final guard now skips that reset before mutation. A separate temporary-DB
regression loads 2,049 shadow symbols, invokes finalization, and confirms all
2,049 physical and distinct IDs remain intact.

## Deferred Work

Do not enable parallel CSV COPY, coalesce fresh-copy transactions, or use
`SKIP_DUPLICATE_PK` in this fix. Those changes alter performance or replacement
semantics and require separate benchmarks. Remove the large-table retention
guard only after an upstream LadybugDB fix is verified against this regression.
Large shadow finalization remains disabled by the fail-closed guard. Re-enable
it only after the final shadow topology can be constructed without destructive
reset mutations, while retaining the existing activation count gate.
