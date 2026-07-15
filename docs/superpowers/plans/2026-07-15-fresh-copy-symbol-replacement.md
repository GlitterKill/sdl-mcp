# Provider-First Symbol Integrity Implementation Plan

**Goal:** Preserve Symbol primary-key and file-mapping integrity across
provider-first fallback writes and placeholder finalization.

**Architecture:** Exercise the complete write sequence in a temporary LadybugDB:
large provider COPY, multiple overlapping fresh-copy fallback flushes,
dependency-target preparation, and isolated-placeholder pruning. Keep real
symbol and placeholder COPY paths unchanged, but retain isolated placeholders
when the Symbol table exceeds 2,048 rows because LadybugDB 0.18.1 corrupts
prior COPY vectors when the table tail or its relationships are mutated. Skip
large shadow finalization before its destructive reset for the same reason.

## Task 1: Add the real database regression

- [x] Replace the regex-only test in `tests/unit/batch-persist.test.ts`.
- [x] Preload more than 2,048 symbols and cross IDs 2,047/2,048.
- [x] Drain multiple fresh-copy batches with overlapping symbol IDs.
- [x] Create dependency placeholders and exercise guarded pruning through
  public DB APIs.
- [x] Assert `count(*) == count(DISTINCT symbolId)` and exact symbol/file
  mappings.
- [x] Close LadybugDB and remove the temporary DB in `finally`.

## Task 2: Apply the production fixes

- [x] Remove `filterExistingSymbolIds()` from fresh-copy persistence.
- [x] Delete every distinct `incomingSymbolId` before replacement COPY.
- [x] Retain isolated placeholders when the Symbol table exceeds 2,048 rows.
- [x] Preserve physical placeholder cleanup for small databases.
- [x] Preserve bulk COPY for real provider/fallback symbols, placeholders, and
  relationships.
- [x] Fail closed before shadow-finalization reset when the staged Symbol table
  exceeds 2,048 rows.
- [x] Add a real 2,049-row shadow regression that proves the skipped candidate
  remains physically distinct.

## Task 3: Verify and hand off

- [x] Rebuild runtime output and run the focused regression.
- [x] Run batch-persist, Ladybug edge-query, and write-batching suites.
- [x] Run type checking and linting.
- [x] Run a fresh isolated provider-first CLI index through active-DB
  completion.
- [x] Verify Symbol physical/distinct counts and completed embeddings.
- [x] Obtain independent `ladybug-db-expert` verification.
- [x] Preserve the shadow activation count gate and document non-destructive
  shadow construction as follow-up work.
- [x] Confirm diff scope excludes the user's `native/index.d.ts` change.
