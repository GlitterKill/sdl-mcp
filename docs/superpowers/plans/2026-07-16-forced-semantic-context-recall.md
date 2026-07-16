# Forced-Semantic `sdl.context` Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task by task, `test-driven-development` for every behavior change, and `verification-before-completion` before reporting success.

**Goal:** Raise the unchanged 26-case benchmark's forced-semantic (`options.semantic: true`) expected-symbol recall from 56.5% to at least 85%, while keeping noise at or below 10%, returning zero failed cases, minimizing measured wall time, and leaving omitted/false semantic modes and every other tool unchanged.

**Architecture:** Keep the shared retrieval APIs and result schemas intact. Change only the `buildSeedContext()` policy that currently suppresses its already-bounded Stage 2 lexical lane after forced-semantic Stage 1 produces enough candidates. Measure that one-line policy correction first; add deterministic per-query lexical coverage only if the minimal candidate misses 85%.

**Tech Stack:** TypeScript, Node.js built-in test runner, LadybugDB, existing `ContextEngine` benchmark harness, PowerShell.

---

## Success contract

- The benchmark corpus remains exactly `tests/benchmark/context-quality-cases.json`: 26 cases with unchanged task text, focus paths, expected useful symbols, and unexpected symbols.
- Only the `semantic` benchmark variant (`options.semantic: true`) gains new hard gates: aggregate recall `>= 85%`, noise `<= 10%`, and failures `=== 0`.
- Precise recall, broad recall, all latency percentiles, and total wall time remain visible but report-only.
- The selected implementation is the lowest-median-wall-time candidate among qualifying candidates, measured on the same build, configuration, and immutable index with one discarded warmup plus three measured full forced-semantic passes and no concurrent repository workload.
- Calls with `options.semantic` omitted or `false`, shared retrieval functions, MCP schemas, response ordering, and all non-`sdl.context` tools retain their current behavior.

## Task 1: Make the benchmark express the approved forced-semantic contract

**Files:**

- Modify: `tests/benchmark/context-quality.test.ts`
- Test: `tests/benchmark/context-quality.test.ts`

- [ ] **Step 1: Add the reporting assertion before changing the gate.**

  Extend the report with a deterministic `Total wall:` line calculated as the sum of the existing per-case durations. Keep precise/broad recall and p50/p95/max output unchanged so they remain diagnostic.

- [ ] **Step 2: Pin and build the immutable QA index, then confirm the old 56.5% forced-semantic failure.**

  ```powershell
  $env:SDL_CONFIG = 'F:\Claude\sdl-mcp\sdlmcp.config.json'
  $env:SDL_GRAPH_DB_PATH = 'F:\Claude\sdl-mcp\qa\forced-semantic-recall-588cf86d.lbug'
  npm run build
  node dist/cli/index.js index --repo-id sdl-mcp --force
  node dist/cli/index.js health --repo-id sdl-mcp --json
  $env:SDL_CONTEXT_QUALITY_REQUIRE_INDEX = '1'
  node --experimental-strip-types --test tests/benchmark/context-quality.test.ts
  ```

  Expected: health identifies `sdl-mcp`, the benchmark availability note prints the exact pinned database path, and the semantic aggregate recall assertion fails below 85%. The report still prints precise, broad, noise, latency, and total wall time. Record the index directory's last-write time; do not mutate or rebuild it for the remainder of candidate comparison.

- [ ] **Step 3: Replace obsolete hard thresholds with the approved contract.**

  Delete `SEMANTIC_PRECISE_RECALL_MIN`, `SEMANTIC_BROAD_RECALL_MIN`, `UNSCOPED_P50_MAX_MS`, `UNSCOPED_P95_MAX_MS`, and `SCOPED_PRECISE_P95_MAX_MS`. Remove only their assertions. Preserve:

  - `semantic.failures === 0`
  - aggregate forced-semantic recall `>= 85`
  - forced-semantic noise `<= 10`
  - the scoped precise execution and its zero-failure assertion
  - all report-only measurements

- [ ] **Step 4: Verify the case fixtures were not edited.**

  ```powershell
  git diff --exit-code -- tests/benchmark/context-quality-cases.json
  ```

- [ ] **Step 5: Commit only the benchmark-contract change.**

  ```powershell
  git add tests/benchmark/context-quality.test.ts
  git diff --cached --check
  git commit -m "test(context): focus semantic benchmark on recall and noise"
  ```

## Task 2: Prove and implement the minimal forced-semantic policy correction

**Files:**

- Modify: `src/agent/context-seeding.ts`
- Modify: `tests/unit/agent/context-seeding-policy.test.ts`
- Add: `tests/unit/agent/context-seeding-runtime.test.ts`
- Test: `tests/unit/agent/context-seeding-policy.test.ts`
- Test: `tests/unit/agent/context-seeding-runtime.test.ts`

- [ ] **Step 1: Write a failing runtime regression test.**

  Build an isolated temporary LadybugDB in `context-seeding-runtime.test.ts`, insert at least four FTS-matching symbols, create the existing `symbol_search_text_v1` FTS index, and call the compiled `buildSeedContext()` for the same broad task three times: `semantic: true`, omitted, and `semantic: false`. Assert through `diagnosticTimings` that:

  - forced semantic runs both `seed.semanticEntitySearch` and `seed.lexicalFallback`;
  - omitted semantic retains its current semantic-plus-lexical broad behavior;
  - `semantic: false` retains lexical fallback and does not run semantic entity search.

  The forced-semantic assertion must fail before the production change because four semantic candidates trigger the current suppression gate. This test exercises compiled runtime behavior; it must not inspect production source text.

  In the existing source-policy suite, retain structural invariants that:

  - `options.semantic === true` still forces Stage 1 entity search;
  - `options.semantic === false` still disables Stage 1 semantic search;
  - `const useHybridLexical = false` remains unchanged;
  - `sourceCounts.lexical < lexicalTargetCap` and its loop caps remain present.

  While touching this file, make the existing function-body boundary check accept both LF and CRLF. This removes worktree-only line-ending brittleness without changing production behavior.

- [ ] **Step 2: Build and run the focused tests to prove RED.**

  ```powershell
  npm run build
  node --experimental-strip-types --test tests/unit/agent/context-seeding-runtime.test.ts tests/unit/agent/context-seeding-policy.test.ts
  ```

  Expected: the forced-semantic runtime assertion fails because `semanticLaneHasCoverage` still suppresses Stage 2; omitted/false assertions pass.

- [ ] **Step 3: Apply the smallest production change.**

  In `buildSeedContext()`, remove `semanticLaneHasCoverage` and its `&& !semanticLaneHasCoverage` gate. Leave the existing outer capacity check, query plan, limits, result scoring, deduplication, source caps, and final sorting untouched. Update the nearby comment to state that forced-semantic uses the same bounded lexical fallback policy as the other modes.

- [ ] **Step 4: Run focused tests to prove GREEN.**

  ```powershell
  npm run build
  node --experimental-strip-types --test tests/unit/agent/context-seeding-runtime.test.ts tests/unit/agent/context-seeding-policy.test.ts tests/unit/agent/seed-scope-filter.test.ts tests/unit/agent/focus-path-inference.test.ts
  ```

  Expected: all focused tests pass.

- [ ] **Step 5: Commit the minimal candidate.**

  ```powershell
  git add src/agent/context-seeding.ts tests/unit/agent/context-seeding-policy.test.ts tests/unit/agent/context-seeding-runtime.test.ts
  git diff --cached --check
  git commit -m "fix(context): retain lexical coverage in semantic mode"
  ```

## Task 3: Benchmark the minimal candidate and stop if it qualifies

**Files:**

- Read: `tests/benchmark/context-quality-cases.json`
- Test: `tests/benchmark/context-quality.test.ts`

- [ ] **Step 1: Build once and point every run at the same immutable index.**

  Reuse the exact paths and database built in Task 1 for every candidate and repetition. Never refresh or mutate it after the baseline.

  ```powershell
  $env:SDL_CONFIG = 'F:\Claude\sdl-mcp\sdlmcp.config.json'
  $env:SDL_GRAPH_DB_PATH = 'F:\Claude\sdl-mcp\qa\forced-semantic-recall-588cf86d.lbug'
  npm run build
  node dist/cli/index.js health --repo-id sdl-mcp --json
  $env:SDL_CONTEXT_QUALITY_REQUIRE_INDEX = '1'
  ```

  Confirm the health output identifies `sdl-mcp`, and confirm every benchmark report's availability note prints the exact pinned database path. Save the index directory's last-write time after indexing; it must remain unchanged across candidate comparisons.

- [ ] **Step 2: Run one discarded warmup and three measured full benchmark passes serially.**

  ```powershell
  1..4 | ForEach-Object {
    node --experimental-strip-types --test tests/benchmark/context-quality.test.ts
  }
  ```

  Record each forced-semantic aggregate recall, noise, failures, and total wall time. Treat run 1 as warmup. Compute the median of runs 2-4.

- [ ] **Step 3: Make the stop/go decision.**

  If every measured run has recall `>= 85%`, noise `<= 10%`, and zero failures, keep the minimal candidate and skip Task 4. If any measured run misses a hard gate, continue to Task 4 without changing fixtures or thresholds.

## Task 4: Conditional fallback — preserve one deterministic result per existing lexical query batch

**Run this task only if Task 3 does not qualify.**

**Files:**

- Modify: `src/agent/context-seeding.ts`
- Modify: `tests/unit/agent/seed-scope-filter.test.ts`
- Modify: `tests/unit/agent/context-seeding-policy.test.ts`
- Test: `tests/unit/agent/seed-scope-filter.test.ts`
- Test: `tests/unit/agent/context-seeding-policy.test.ts`

- [ ] **Step 1: Write a failing behavioral coverage test.**

  Add and export a small `orderForcedSemanticLexicalResults()` helper that accepts already-returned query batches plus a cap. Before implementing it, add synthetic runtime tests that require it to reserve at most one unseen symbol from each non-empty batch in query order, then fill remaining capacity from the same batches without duplicates. Include an empty batch and cross-batch duplicate. The new import/test is RED because the orchestration helper does not exist yet; do not duplicate the existing `selectFirstUnseenPerBatch()` tests.

  Extend `context-seeding-runtime.test.ts` with a synthetic forced-semantic task whose compound batch can fill the lexical cap before later individual-term batches. Assert that each non-empty planned query batch contributes its deterministic anchor. Omitted/false modes must continue through the pre-existing append-and-cap path.

- [ ] **Step 2: Run the focused tests and prove RED.**

  ```powershell
  npm run build
  node --experimental-strip-types --test tests/unit/agent/seed-scope-filter.test.ts tests/unit/agent/context-seeding-runtime.test.ts tests/unit/agent/context-seeding-policy.test.ts
  ```

- [ ] **Step 3: Implement bounded coverage using only already-issued searches.**

  For forced-semantic calls only, execute every query already present in the bounded action/compound/individual query plan even when an earlier batch could fill `lexicalTargetCap`; retain those result arrays instead of stopping early. Implement `orderForcedSemanticLexicalResults()` with the existing `selectFirstUnseenPerBatch()` helper, add selected anchors in query order, then fill remaining `lexicalTargetCap` slots from the same arrays with the current scoring and deduplication rules. This may execute planned queries that the current early-cap break skips, so include that cost in candidate timing. Do not add a query to the plan, raise a limit, hydrate metadata, modify shared search functions, or alter omitted/false paths.

- [ ] **Step 4: Run focused tests and prove GREEN.**

  ```powershell
  npm run build
  node --experimental-strip-types --test tests/unit/agent/seed-scope-filter.test.ts tests/unit/agent/context-seeding-runtime.test.ts tests/unit/agent/context-seeding-policy.test.ts tests/unit/agent/focus-path-inference.test.ts
  ```

- [ ] **Step 5: Repeat Task 3's warmup plus three measured benchmark passes.**

  Keep this candidate only if all hard gates pass and its measured median total wall time is lower than every other qualifying candidate. If it still misses any hard gate, stop before Tasks 5-6, report the measured failure, and amend the approved design with another bounded candidate. Do not document or report completion below 85%.

- [ ] **Step 6: Commit only if this fallback is selected.**

  ```powershell
  git add src/agent/context-seeding.ts tests/unit/agent/seed-scope-filter.test.ts tests/unit/agent/context-seeding-policy.test.ts tests/unit/agent/context-seeding-runtime.test.ts
  git diff --cached --check
  git commit -m "fix(context): preserve semantic query coverage"
  ```

## Task 5: Update behavior and benchmark documentation

**Files:**

- Modify: `docs/feature-deep-dives/context-modes.md`
- Modify: `docs/benchmark-guardrails.md`
- Modify: `CHANGELOG.md`
- Test: `tests/benchmark/context-quality.test.ts`

- [ ] **Step 1: Document only the selected behavior.**

  Explain that explicit `semantic: true` keeps hybrid entity retrieval as the primary lane and now retains the same bounded lexical fallback for exact identifiers and domain terms. State explicitly that omitted/false behavior and other tools are unchanged.

- [ ] **Step 2: Correct the benchmark gate table.**

  Document the unchanged 26-case corpus and the three hard forced-semantic gates: aggregate recall `>= 85%`, noise `<= 10%`, and zero failures. Label precise/broad recall, p50/p95/max, scoped precise latency, and total wall time as report-only diagnostics.

- [ ] **Step 3: Add a concise changelog entry.**

  Note the forced-semantic recall improvement and the benchmark result without claiming a latency ceiling.

- [ ] **Step 4: Run documentation checks.**

  ```powershell
  npm run docs:tools:check
  git diff --check
  ```

- [ ] **Step 5: Commit documentation.**

  ```powershell
  git add docs/feature-deep-dives/context-modes.md docs/benchmark-guardrails.md CHANGELOG.md
  git diff --cached --check
  git commit -m "docs(context): describe semantic recall guardrail"
  ```

## Task 6: Verify isolation, correctness, and final benchmark evidence

**Files:**

- Verify: `src/agent/context-seeding.ts`
- Verify: `tests/unit/agent/context-seeding-policy.test.ts`
- Verify: `tests/benchmark/context-quality.test.ts`
- Verify: `tests/integration/determinism.fixtures.json`

- [ ] **Step 1: Prove the change surface is isolated.**

  ```powershell
  git diff 588cf86d...HEAD -- src/retrieval src/mcp src/server.ts tests/integration/determinism.fixtures.json
  ```

  Expected: no changes. Review the complete diff and confirm every production change is inside forced-semantic `buildSeedContext()` policy.

- [ ] **Step 2: Run static and focused verification.**

  ```powershell
  npm run typecheck
  npm run lint
  npm run build
  node --experimental-strip-types --test tests/unit/agent/context-seeding-policy.test.ts tests/unit/agent/seed-scope-filter.test.ts tests/unit/agent/focus-path-inference.test.ts
  npm run docs:tools:check
  ```

- [ ] **Step 3: Run the full test suite serially.**

  ```powershell
  Remove-Item Env:SDL_CONTEXT_QUALITY_REQUIRE_INDEX -ErrorAction SilentlyContinue
  npm test
  ```

  Expected: all tests pass. Do not stage test-generated fixture path rewrites from the isolated worktree.

- [ ] **Step 4: Capture final benchmark evidence.**

  Restore `$env:SDL_CONTEXT_QUALITY_REQUIRE_INDEX = '1'`. Against the same pinned config and immutable QA index, run one discarded warmup plus three measured passes. Record each measured forced-semantic recall/noise/failures/total-wall line and the median total wall time. Confirm the case file is unchanged from the base commit:

  ```powershell
  git diff --exit-code 588cf86d...HEAD -- tests/benchmark/context-quality-cases.json
  ```

- [ ] **Step 5: Audit prompt-cache and cross-tool stability.**

  Run the concrete determinism and golden checks selected by `test-scope`:

  ```powershell
  node --experimental-strip-types --test tests/integration/determinism.test.ts
  npm run test:golden
  ```

  Confirm tool names, descriptions, schemas, response key ordering, and non-context handlers did not change.

- [ ] **Step 6: Make one fresh-process MCP probe.**

  With the pinned `SDL_CONFIG` and `SDL_GRAPH_DB_PATH` still set, launch a new stdio server through the installed MCP SDK and call `sdl.context` with `options.semantic: true`:

  ```powershell
  node --input-type=module -e "import { Client } from '@modelcontextprotocol/sdk/client/index.js'; import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'; const client = new Client({ name: 'forced-semantic-smoke', version: '1.0.0' }); const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/main.js'], env: process.env }); await client.connect(transport); const result = await client.callTool({ name: 'sdl.context', arguments: { repoId: 'sdl-mcp', taskType: 'explain', taskText: 'Explain the context seeding retrieval pipeline', options: { contextMode: 'broad', semantic: true, includeRetrievalEvidence: true } } }); console.log(JSON.stringify(result.structuredContent ?? result.content)); await client.close();"
  ```

  Expected: a successful structured response with non-empty evidence and no protocol/server error.

- [ ] **Step 7: Request an independent code review.**

  Give the reviewer the approved design, this plan, the full base-to-head diff, focused/full test output, and the three measured benchmark runs. Require the reviewer to check scope isolation, metric integrity, unchanged fixtures, TDD coverage, benchmark reproducibility, and the claimed `>=85%` result. Resolve every correctness finding and rerun affected verification.

- [ ] **Step 8: Final repository hygiene check.**

  ```powershell
  git status --short
  git diff --check
  git log --oneline 588cf86d..HEAD
  ```

  Expected: only intentional branch commits; generated absolute-path fixture rewrites are excluded from commits.
