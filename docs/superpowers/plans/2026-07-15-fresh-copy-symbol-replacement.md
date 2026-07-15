# Fresh-Copy Symbol Replacement Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and restore duplicate-safe replacement of provider symbols during fresh-copy fallback batches.

**Architecture:** Replace the source-regex assertion with a real temporary-LadybugDB test that crosses the 2,048-ID boundary and drains two batches. Then remove the read-pool existence probe so the serialized writer deletes every distinct incoming ID before raw COPY.

**Tech Stack:** TypeScript, Node.js `node:test`, LadybugDB 0.18.1, SDL-MCP `BatchPersistAccumulator`.

---

## Chunk 1: Fresh-copy correctness fix

### Task 1: Add the real database regression

**Files:**
- Modify: `tests/unit/batch-persist.test.ts`
- Reference: `docs/superpowers/specs/2026-07-15-fresh-copy-symbol-replacement-design.md`

- [ ] **Step 1: Replace the regex-only fresh-copy test with a real LadybugDB test**

Import the filesystem, temporary-directory, Ladybug lifecycle, write-connection, query, and row types already used by nearby tests. In one test:

1. Create a temporary root and database path.
2. Initialize LadybugDB, a repository, one provider file, and one fallback file.
3. Preload 2,321 symbols: 2,305 IDs that the first incoming batch replaces and 16 untouched IDs.
4. Construct `BatchPersistAccumulator(512, { autoDrain: false, symbolWriteMode: "fresh-copy" })`.
5. Add one 2,305-row replacement array so the incoming existence/deletion boundary itself exceeds 2,048 IDs.
6. Add a second 64-row array containing 32 repeated replacement IDs and 32 new IDs, then call `drain()` so two queued batches use the real writer lifecycle.
7. Query the physical Symbol count, `count(DISTINCT s.symbolId)`, and selected symbol/name/file mappings.
8. Assert both counts equal the exact expected total of 2,353; assert boundary IDs `2047` and `2048`, a twice-replaced ID, a new ID, and an untouched ID map to the expected names and files.
9. In `finally`, use a nested `try/finally`: attempt `closeLadybugDb()` first, then recursively remove the temporary root in the inner `finally` so the database and WAL are removed even if close throws.

- [ ] **Step 2: Build the runtime used by tests**

Run: `npm run build:runtime`

Expected: exit 0 and `dist/indexer/parser/batch-persist.js` reflects the current filtered-delete implementation.

- [ ] **Step 3: Run the focused test and verify RED**

Run: `node --experimental-strip-types --test tests/unit/batch-persist.test.ts`

Expected: the new real-DB test fails on an exact-count, duplicate-count, or symbol/file-mapping assertion while the existing implementation still filters IDs through the read pool. If it passes, stop before production edits and diagnose build freshness, fixture construction, actual queued batch sizes, and the assumed boundary; do not manipulate the fixture merely to manufacture a failure.

### Task 2: Restore unconditional incoming-ID deletion

**Files:**
- Modify: `src/indexer/parser/batch-persist.ts:1-5`
- Modify: `src/indexer/parser/batch-persist.ts:425-434`
- Modify: `src/indexer/parser/batch-persist.ts:776-810`

- [ ] **Step 1: Apply the minimal production fix**

Remove `getLadybugConn` from the import, delete `filterExistingSymbolIds()`, remove `existingIncomingSymbolIds`, and pass `incomingSymbolIds` directly to both the diagnostic row count and `deleteSymbolsByIds(txConn, incomingSymbolIds)`. Do not change COPY, transaction structure, batching, or duplicate-key behavior.

- [ ] **Step 2: Rebuild and verify GREEN**

Run: `npm run build:runtime`

Run: `node --experimental-strip-types --test tests/unit/batch-persist.test.ts`

Expected: both commands exit 0 and the real database regression passes.

### Task 3: Verify and hand off

**Files:**
- Verify: `src/indexer/parser/batch-persist.ts`
- Verify: `tests/unit/batch-persist.test.ts`

- [ ] **Step 1: Run static verification**

Run: `npm run typecheck`

Run: `npm run lint`

Expected: both commands exit 0.

- [ ] **Step 2: Verify cleanup and diff scope**

Run: `git diff --check`

Run: `git status --short`

Expected: no diagnostic database remains; only the implementation/test changes and the user's pre-existing `native/index.d.ts` modification are uncommitted.

- [ ] **Step 3: Commit the implementation**

```powershell
git add -- src/indexer/parser/batch-persist.ts tests/unit/batch-persist.test.ts
git commit -m "fix: make fresh-copy symbol replacement duplicate-safe"
```
