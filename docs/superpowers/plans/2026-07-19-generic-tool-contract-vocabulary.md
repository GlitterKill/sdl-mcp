# Generic Tool-Contract Vocabulary Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded generic-only tool-contract vocabulary that reaches at least four accepted contract symbols without changing named-action behavior or output noise.

**Architecture:** `buildActionSeedQueries()` selects one static ordered term list only for the existing no-action generic fallback. Named-action requests continue to use the existing catalog-derived terms, and every downstream retrieval, ranking, response, and focus-path stage stays unchanged.

**Tech Stack:** TypeScript, Node.js built-in test runner, SDL-MCP live context tools, existing seed-resolution benchmark.

---

## File map

- Modify `tests/unit/agent/context-action-seeding.test.ts`: change only the generic expected query; retain activation, negative, generic-`tests`, and exact named-action regressions.
- Modify `src/agent/context-seeding.ts`: select the static vocabulary only when `useGenericToolContractFallback` is true.
- Modify `devdocs/benchmarks/seed-resolution-evaluation-v1.json`: regenerate source metadata after the accepted local implementation; restore the retained baseline if any gate fails.
- Modify `devdocs/qaplans/2026-07-18-sdl-tool-qa-live-v0-12-4.md`: preserve accepted or reverted live evidence in the intentionally ignored local report; never force-add it.
- Do not change schemas, response fixtures, ranking code, catalog metadata, configuration, database code, or public documentation.

## Chunk 1: Red-green implementation and benchmark proof

### Task 1: Capture baselines and write the failing vocabulary expectation

**Files:**
- Modify: `tests/unit/agent/context-action-seeding.test.ts:6`
- Reference: `docs/superpowers/specs/2026-07-19-generic-tool-contract-vocabulary-design.md`
- Read and retain: `devdocs/benchmarks/seed-resolution-evaluation-v1.json`

- [ ] **Step 1: Confirm clean tracked scope**

Run through SDL `runtimeExecute`:

```powershell
git status --short
git log -1 --oneline
```

Expected: no tracked or untracked output from status. Stop if unrelated changes exist.

- [ ] **Step 2: Capture the benchmark baseline**

Read `devdocs/benchmarks/seed-resolution-evaluation-v1.json` with `sdl.file.read` and retain its exact content for restoration. Record:

- `quality.contextAssemblyRecall === 0.375`;
- `quality.sliceStartNodeRecall === 0.917`;
- `quality.autopilotExplicitScopeRecall === 1`;
- every `cases[*].id` and `cases[*].contextAssembly.ftsQuery`.

Do not run the writer yet.

- [ ] **Step 3: Change only the generic expected query**

In `tests/unit/agent/context-action-seeding.test.ts`, replace:

```typescript
const PROJECTION_QUERY = "context response projection";
```

with:

```typescript
const PROJECTION_QUERY =
  "context response projection tool descriptor registration response envelope structured content output schema runtime query";
```

Do not change the negative matrix or the named-action expected array.

- [ ] **Step 4: Rebuild unchanged production source**

Run:

```powershell
npm.cmd run build:all
```

Expected: exit code 0. This refreshes `dist` from unchanged source before red evidence.

- [ ] **Step 5: Run the focused red test**

Run:

```powershell
node --experimental-strip-types --test tests/unit/agent/context-action-seeding.test.ts
```

Expected: 2 pass and 3 fail. The canonical, determinism-only, and generic-`tests` expectations fail because production still returns `context response projection`. The negative-boundary and named-action tests pass.

If the named-action or negative test fails, stop before editing production.

### Task 2: Add the static vocabulary at the shared generic boundary

**Files:**
- Modify: `src/agent/context-seeding.ts:250-270`
- Test: `tests/unit/agent/context-action-seeding.test.ts`

- [ ] **Step 1: Select projection terms by the existing generic flag**

Inside the existing projection branch, replace the direct ranked-action spread with this local term selection:

```typescript
    const projectionTerms = useGenericToolContractFallback
      ? [
          "tool",
          "descriptor",
          "registration",
          "response",
          "envelope",
          "structured",
          "content",
          "output",
          "schema",
          "runtime",
          "query",
        ]
      : new Set(
          rankedActions.flatMap((action) => [
            action.fn,
            ...action.action.split("."),
          ]),
        );
    const projectionQuery = [
      "context",
      "response",
      "projection",
      ...projectionTerms,
    ].join(" ");
```

Remove only the old inline `new Set(rankedActions.flatMap(...))` spread. Do not change the branch condition, activation predicate, response-test condition, query deduplication, comments, or limits.

- [ ] **Step 2: Build the changed source**

Run:

```powershell
npm.cmd run build
```

Expected: exit code 0.

- [ ] **Step 3: Run the focused green test**

Run:

```powershell
node --experimental-strip-types --test tests/unit/agent/context-action-seeding.test.ts
```

Expected: 5 pass, 0 fail. The named-action expected array remains byte-identical.

- [ ] **Step 4: Run adjacent relevance suites**

Run:

```powershell
node --experimental-strip-types --test tests/unit/agent/context-ranking.test.ts
node --experimental-strip-types --test tests/benchmark/context-quality.test.ts
```

Expected: no failures. The context-quality suite may skip its documented optional live/default-database case; the restarted-server gates in Chunk 2 remain mandatory.

- [ ] **Step 5: Verify source lint**

Run:

```powershell
npx.cmd eslint src/agent/context-seeding.ts
```

Expected: exit code 0 with no finding in the changed file.

- [ ] **Step 6: Commit the green source and test**

Stage only the two planned files:

```powershell
git add src/agent/context-seeding.ts tests/unit/agent/context-action-seeding.test.ts
git diff --cached --check
git diff --cached --stat
git commit -m "Target generic tool-contract retrieval"
```

Expected: exactly two files in the commit.

### Task 3: Regenerate and validate the benchmark artifact

**Files:**
- Modify: `devdocs/benchmarks/seed-resolution-evaluation-v1.json`

- [ ] **Step 1: Require a clean tracked worktree**

Run `git status --short`.

Expected: no output.

- [ ] **Step 2: Run the benchmark writer**


Run with a 600000 ms timeout:

```powershell
npm.cmd run benchmark:seed-resolution
```

Expected: exit code 0 and only `devdocs/benchmarks/seed-resolution-evaluation-v1.json` changes. If the writer fails or changes any other path, do not commit. Restore the retained artifact, confirm whether any other diff was writer-produced before restoring it, and enter Task 6's **pre-artifact correction** path.

- [ ] **Step 3: Mechanically compare stable fields with `HEAD`**

Run this exact PowerShell assertion through SDL `runtimeExecute`:

```powershell
$artifact = "devdocs/benchmarks/seed-resolution-evaluation-v1.json"
$baseline = (& git show "HEAD:$artifact" | Out-String | ConvertFrom-Json)
$current = (Get-Content -Raw $artifact | ConvertFrom-Json)

if ($current.quality.contextAssemblyRecall -lt 0.375) {
  throw "contextAssemblyRecall regressed"
}
if ($current.quality.sliceStartNodeRecall -lt 0.917) {
  throw "sliceStartNodeRecall regressed"
}
if ($current.quality.autopilotExplicitScopeRecall -ne 1) {
  throw "autopilotExplicitScopeRecall changed"
}

$baselineById = @{}
foreach ($case in $baseline.cases) {
  $baselineById[$case.id] = $case.contextAssembly.ftsQuery
}
$currentById = @{}
foreach ($case in $current.cases) {
  $currentById[$case.id] = $case.contextAssembly.ftsQuery
}
if ($baselineById.Count -ne $currentById.Count) {
  throw "case-ID set changed"
}
foreach ($id in $baselineById.Keys) {
  if (-not $currentById.ContainsKey($id)) {
    throw "case ID removed: $id"
  }
  if ($currentById[$id] -cne $baselineById[$id]) {
    throw "ftsQuery changed for case: $id"
  }
}
```

Expected: exit code 0. Also inspect the diff; changes outside source hash, Git baseline metadata, measured latency, or approved generic evidence require investigation.

If an assertion fails, do not commit the artifact. Restore it with `sdl.file.write` from Task 1 and enter Task 6's **pre-artifact correction** path.

- [ ] **Step 4: Run the artifact verifier**

Run:

```powershell
node --experimental-strip-types scripts/evaluate-seed-resolution.ts --check
```

Expected: `seed-resolution-evaluation: OK`.

If the verifier exits nonzero or does not print `seed-resolution-evaluation: OK`, do not commit. Restore the retained artifact and enter Task 6's **pre-artifact correction** path.

- [ ] **Step 5: Commit the benchmark update**

```powershell
git add devdocs/benchmarks/seed-resolution-evaluation-v1.json
git diff --cached --check
git diff --cached --stat
git commit -m "Update generic vocabulary seed evaluation"
```

Expected: exactly one file in the commit.

## Chunk 2: Restarted-server acceptance, correction, and final proof

### Task 4: Prove the new build and fresh graph

**Prerequisite:** Restart the configured SDL-MCP server from this workspace after Chunk 1, then freshly index `sdl-mcp`.

- [ ] **Step 1: Prove the local build**

Run:

```powershell
node --input-type=module -e "import assert from 'node:assert/strict'; import { buildActionSeedQueries } from './dist/agent/context-seeding.js'; assert.deepEqual(buildActionSeedQueries('Review the current SDL-MCP tool surface for contracts, output noise, deterministic responses, and safe errors.'), ['context response projection tool descriptor registration response envelope structured content output schema runtime query']);"
```

Expected: exit code 0.

- [ ] **Step 2: Confirm the restarted server and fresh index**

Call `repo.status` and `symbol.getCard` for `buildActionSeedQueries`.

Require:

- latest version differs from pre-change `v1784483895766`;
- `stale` is false;
- `graphIntegrityState` is `verified`;
- graph-integrity version equals latest version;
- the symbol card ledger version equals latest version.

Do not accept the implementation based on restart confirmation alone; Task 5 proves the server behavior.

### Task 5: Run canonical and focus-path acceptance

- [ ] **Step 1: Run the exact canonical request**

Call `sdl.context`:

```json
{
  "repoId": "sdl-mcp",
  "taskType": "review",
  "taskText": "Review the current SDL-MCP tool surface for contracts, output noise, deterministic responses, and safe errors.",
  "options": {
    "contextMode": "broad",
    "semantic": true,
    "includeRetrievalEvidence": true,
    "evidenceOptimization": "off",
    "cardDetail": "task"
  },
  "includeDiagnostics": false
}
```

Take the first ten `symbolCard` entries in `finalEvidence` order.

- [ ] **Step 2: Count exact accepted pairs and noise**

Require at least four pairs:

- `buildFlatToolDescriptors` — `src/mcp/tools/tool-descriptors.ts`
- `registerTool` — `src/server.ts`
- `buildToolResponseEnvelope` — `src/server.ts`
- `asStructuredContent` — `src/server.ts`
- `handleRuntimeQueryOutput` — `src/mcp/tools/runtime-query.ts`

Require no first-ten path beginning `outputs/logos/` and none equal to `scripts/evaluate-seed-resolution.ts`.

If either gate fails, do not add terms or adjust ranking. Continue to Task 6.

- [ ] **Step 3: Run both precise focus guards**

Copy the canonical request twice. Preserve every field except:

1. Set `options.contextMode` to `"precise"` and `options.focusPaths` to `["outputs/logos"]`. Require a first-ten path beginning `outputs/logos/`.
2. Set `options.contextMode` to `"precise"` and `options.focusPaths` to `["scripts"]`. Require a first-ten path beginning `scripts/`.

If either fails, continue to Task 6.

- [ ] **Step 4: Choose the evidence-driven branch**

If the canonical threshold, noise exclusions, focus guards, graph integrity, and benchmark floors all pass, skip Task 6 and continue to Task 7.

If any gate fails, execute Task 6 completely.

### Task 6: Correct a failed vocabulary experiment

**Run only when Task 3 enters pre-artifact correction or Task 5 enters post-artifact correction.**

Choose and record one branch before editing:

- **Pre-artifact correction:** the benchmark writer, diff-scope check, mechanical assertions, or verifier failed before the benchmark artifact commit. Restore the retained artifact first; it must have no diff. The correction commit will contain only source and test.
- **Post-artifact correction:** live acceptance failed after the benchmark artifact commit. Restore the retained artifact as part of the correction. The correction commit will contain source, test, and benchmark artifact.

**Files:**
- Modify: `src/agent/context-seeding.ts`
- Modify: `tests/unit/agent/context-action-seeding.test.ts`
- Restore only for post-artifact correction: `devdocs/benchmarks/seed-resolution-evaluation-v1.json`

- [ ] **Step 1: Restore the prior production query construction**

Remove `projectionTerms` and restore the original projection query:

```typescript
    const projectionQuery = [
      "context",
      "response",
      "projection",
      ...new Set(
        rankedActions.flatMap((action) => [
          action.fn,
          ...action.action.split("."),
        ]),
      ),
    ].join(" ");
```

Do not remove the generic activation predicate or change any other branch.

- [ ] **Step 2: Restore only the generic positive expectation**

In `tests/unit/agent/context-action-seeding.test.ts`, restore:

```typescript
const PROJECTION_QUERY = "context response projection";
```

Keep all five tests, the negative matrix, generic-`tests` assertion, and named-action expected array.

- [ ] **Step 3: Restore the retained benchmark artifact for the chosen branch**

- Pre-artifact: write the exact Task 1 baseline content back with `sdl.file.write`, then require `git diff -- devdocs/benchmarks/seed-resolution-evaluation-v1.json` to be empty.
- Post-artifact: write the exact Task 1 baseline content back with `sdl.file.write` and retain that artifact diff for the correction commit.

- [ ] **Step 4: Build and verify the corrected state**

Run:

```powershell
npm.cmd run build
node --experimental-strip-types --test tests/unit/agent/context-action-seeding.test.ts
node --experimental-strip-types --test tests/unit/agent/context-ranking.test.ts
node --experimental-strip-types --test tests/benchmark/context-quality.test.ts
node --experimental-strip-types scripts/evaluate-seed-resolution.ts --check
```

Expected: no failures, focused 5/5, benchmark verifier OK, and the artifact matches the retained baseline.

- [ ] **Step 5: Commit the correction**

For pre-artifact correction:

```powershell
git add src/agent/context-seeding.ts tests/unit/agent/context-action-seeding.test.ts
git diff --cached --check
git diff --cached --stat
git commit -m "Revert generic tool-contract vocabulary"
```

Expected: exactly two correction files and no benchmark artifact diff.

For post-artifact correction:

```powershell
git add src/agent/context-seeding.ts tests/unit/agent/context-action-seeding.test.ts devdocs/benchmarks/seed-resolution-evaluation-v1.json
git diff --cached --check
git diff --cached --stat
git commit -m "Revert generic tool-contract vocabulary"
```

Expected: exactly three correction files. In either branch, keep the experiment commits in history.

- [ ] **Step 6: Restart and freshly index the corrected build**

Restart the configured server and freshly index `sdl-mcp`. Require `repo.status` to report a new latest version, stale false, and verified graph integrity.

Run the canonical and both focus requests once more. Record the final reverted query behavior; do not require the failed four-of-five vocabulary threshold after correction.

### Task 7: Update the ignored QA report

**Files:**
- Modify locally: `devdocs/qaplans/2026-07-18-sdl-tool-qa-live-v0-12-4.md`

- [ ] **Step 1: Record the experiment**

Update only the broad-context finding with:

- exact static vocabulary;
- automated and benchmark results;
- fresh graph evidence;
- canonical first-ten name/path pairs;
- exact hit count and noise result;
- focus-path results;
- accepted or corrective-commit status.

Do not add durations, absolute machine paths, telemetry, or token-savings claims.

- [ ] **Step 2: Preserve the ignored local artifact**

Run:

```powershell
git check-ignore -v devdocs/qaplans/2026-07-18-sdl-tool-qa-live-v0-12-4.md
```

Expected: the `devdocs/*` rule. Re-read the updated section with `sdl.file.read`; never use `git add -f`.

### Task 8: Final scoped verification

- [ ] **Step 1: Rebuild all distributable code**

Run:

```powershell
npm.cmd run build:all
```

Expected: exit code 0.

- [ ] **Step 2: Run static checks**

Run:

```powershell
npm.cmd run typecheck
npm.cmd run lint
```

Expected: typecheck exits 0; lint reports 0 errors. Existing unrelated warnings may remain.

- [ ] **Step 3: Run affected suites and artifact check**

Run:

```powershell
node --experimental-strip-types --test tests/unit/agent/context-action-seeding.test.ts tests/unit/agent/context-ranking.test.ts tests/benchmark/context-quality.test.ts
node --experimental-strip-types scripts/evaluate-seed-resolution.ts --check
```

Expected: no failures. A documented optional live/default-database context-quality case may skip because Chunk 2 supplies direct live proof.

- [ ] **Step 4: Audit tracked and ignored scope**

Run:

```powershell
git status --short --branch
git diff --check
git check-ignore -v devdocs/qaplans/2026-07-18-sdl-tool-qa-live-v0-12-4.md
```

Require a clean tracked worktree. Commits may touch only the approved source, focused test, benchmark artifact, spec/plan documents, and any corrective files. The QA report remains ignored and locally updated. Do not push or alter unrelated files.
