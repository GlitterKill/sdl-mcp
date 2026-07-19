# Generic Tool-Contract Candidate Seeding Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let broad generic tool-contract reviews seed the existing response-projection query while preserving named-action behavior and all current output contracts.

**Architecture:** Keep the change inside `buildActionSeedQueries()`, where every action-seed caller already routes. A narrow no-action fallback reuses the existing projection query; no retrieval lane, scorer, schema, response field, configuration, or database mutation is added.

**Tech Stack:** TypeScript, Node.js built-in test runner, SDL-MCP runtime and live context tools, existing seed-resolution benchmark.

---

## File map

- Create `tests/unit/agent/context-action-seeding.test.ts`: direct pure-function regressions for generic activation, negative boundaries, test-query suppression, and named-action preservation.
- Modify `src/agent/context-seeding.ts`: add the bounded no-action predicate and reuse the existing projection branch.
- Modify `devdocs/benchmarks/seed-resolution-evaluation-v1.json`: regenerate the existing source-hash-backed benchmark artifact after the source change.
- Modify `devdocs/qaplans/2026-07-18-sdl-tool-qa-live-v0-12-4.md`: record the root cause and live acceptance evidence. This private QA artifact is intentionally ignored by `devdocs/*`; verify it locally and do not force-add it.
- Do not change public tool documentation, response fixtures, schemas, ranking weights, or catalog metadata.

## Chunk 1: Test-first implementation and local verification

### Task 1: Add the pure action-seeding contract tests

**Files:**
- Create: `tests/unit/agent/context-action-seeding.test.ts`
- Reference: `docs/superpowers/specs/2026-07-19-generic-tool-contract-seeding-design.md`

- [ ] **Step 1: Create the focused test file**

Use the existing Node test style and import the built implementation:

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildActionSeedQueries } from "../../../dist/agent/context-seeding.js";

const PROJECTION_QUERY = "context response projection";
const GENERIC_TOOL_QA_TASK =
  "Review the current SDL-MCP tool surface for contracts, output noise, deterministic responses, and safe errors.";

describe("generic tool-contract action seeding", () => {
  it("reuses the projection seed for the canonical generic review", () => {
    assert.deepEqual(buildActionSeedQueries(GENERIC_TOOL_QA_TASK), [
      PROJECTION_QUERY,
    ]);
  });

  it("uses determinism itself as bounded review intent", () => {
    assert.deepEqual(buildActionSeedQueries("tool determinism"), [
      PROJECTION_QUERY,
    ]);
  });

  it("does not activate for partial or ordinary formatting intent", () => {
    for (const taskText of [
      "debug tool output formatting",
      "fix schema response error",
      "review tool output formatting",
      "review tool registration safety",
      "debug tool contract formatting",
      "audit response contracts for application output",
    ]) {
      assert.deepEqual(
        buildActionSeedQueries(taskText),
        [],
        `unexpected generic seed for: ${taskText}`,
      );
    }
  });

  it("does not emit an empty response-test query for generic reviews", () => {
    assert.deepEqual(
      buildActionSeedQueries(
        "Review SDL-MCP tool schemas, contracts, deterministic responses, and tests.",
      ),
      [PROJECTION_QUERY],
    );
  });

  it("preserves named-action query text and ordering", () => {
    assert.deepEqual(
      buildActionSeedQueries(
        "Review runtime.queryOutput output contract tests",
      ),
      [
        "handleRuntimeQueryOutput RuntimeQueryOutputRequestSchema RuntimeQueryOutputResponseSchema runtimeQueryOutput runtime.queryOutput",
        "context response projection runtimeQueryOutput runtime queryOutput",
        "response runtime queryOutput",
      ],
    );
  });
});
```

- [ ] **Step 2: Rebuild unchanged source, then run the red test**

Run through SDL `runtimeExecute`:

```powershell
npm.cmd run build
```

Expected: exit code 0. This refreshes `dist` from the still-unchanged source before collecting red evidence.

Then run:

```powershell
node --experimental-strip-types --test tests/unit/agent/context-action-seeding.test.ts
```

Expected: FAIL because the generic positive cases currently return `[]`. The named-action preservation case must already pass. If the named-action case fails, correct the captured baseline before changing source.

### Task 2: Implement the narrow shared fallback

**Files:**
- Modify: `src/agent/context-seeding.ts:191-265`
- Test: `tests/unit/agent/context-action-seeding.test.ts`

- [ ] **Step 1: Replace only the early-return control flow**

Immediately after `mentionedActions` is built, replace the unconditional no-action return with:

```typescript
  // Generic tool-surface reviews have no catalog action name, but still need
  // the existing shared response-projection seed.
  const useGenericToolContractFallback =
    mentionedActions.length === 0 &&
    /\b(?:tools?|schemas?|descriptors?|registr(?:ation|ations|y|ies))\b/i.test(
      taskText,
    ) &&
    /\b(?:contracts?|projections?|determinism|deterministic)\b/i.test(
      taskText,
    ) &&
    /\b(?:review|reviews|reviewing|audit|audits|auditing|qa|determinism|deterministic)\b/i.test(
      taskText,
    );

  if (mentionedActions.length === 0 && !useGenericToolContractFallback) {
    return [];
  }
```

Do not extract these regexes into constants or configuration; they are used once.

- [ ] **Step 2: Reuse the existing projection branch**

Change only its condition:

```typescript
  if (hasOutputQaIntent || useGenericToolContractFallback) {
```

This makes the approved determinism-only fallback functional without broadening named-action behavior because `useGenericToolContractFallback` is false whenever an action is named.

- [ ] **Step 3: Prevent the empty generic response-test query**

Change the response-test condition to:

```typescript
  if (
    rankedActions.length > 0 &&
    hasOutputQaIntent &&
    /\btests?\b/i.test(taskText)
  ) {
```

Do not change the existing projection or response-test query text, deduplication, limits, or ordering.

- [ ] **Step 4: Build the changed source**

Run:

```powershell
npm.cmd run build
```

Expected: exit code 0.

- [ ] **Step 5: Run the focused test**

Run:

```powershell
node --experimental-strip-types --test tests/unit/agent/context-action-seeding.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 6: Run adjacent ranking and benchmark-contract tests**

Run:

```powershell
node --experimental-strip-types --test tests/unit/agent/context-ranking.test.ts
node --experimental-strip-types --test tests/benchmark/context-quality.test.ts
```

Expected: all existing cases pass with no snapshot or response changes.

- [ ] **Step 7: Commit the green implementation**

Stage only the source and focused test, verify `git diff --cached --check`, then commit:

```powershell
git add src/agent/context-seeding.ts tests/unit/agent/context-action-seeding.test.ts
git diff --cached --check
git commit -m "Improve generic tool-contract context seeding"
```

### Task 3: Regenerate and verify the affected benchmark artifact

**Files:**
- Modify: `devdocs/benchmarks/seed-resolution-evaluation-v1.json`

- [ ] **Step 1: Capture the clean benchmark baseline**

Run `git status --short` and require no output. Then read `devdocs/benchmarks/seed-resolution-evaluation-v1.json` with `sdl.file.read` and retain that exact content for restoration only.

If the worktree is not clean after the implementation commit, stop and resolve scope before running the writer.

- [ ] **Step 2: Run the existing benchmark writer**

Run with a 600000 ms runtime timeout:

```powershell
npm.cmd run benchmark:seed-resolution
```

Expected: exit code 0 and only `devdocs/benchmarks/seed-resolution-evaluation-v1.json` changes.

- [ ] **Step 3: Inspect the stable benchmark fields**

Verify:

- `quality.contextAssemblyRecall >= 0.375`;
- `quality.sliceStartNodeRecall >= 0.917`;
- `quality.autopilotExplicitScopeRecall === 1`;
- every existing named-action case FTS query remains unchanged; only a distinct generic-prompt case may gain the projection query;
- changes outside source hash, Git baseline metadata, timing, or evidence caused by the approved fallback are investigated before continuing.

If any threshold or evidence check fails, record the new values in task evidence, restore the artifact with `sdl.file.write` using the exact content captured in Step 1, verify its diff is empty, and stop. Do not commit a failed benchmark artifact.

- [ ] **Step 4: Verify the regenerated artifact**

Run:

```powershell
npm.cmd run build
node --experimental-strip-types scripts/evaluate-seed-resolution.ts --check
```

Expected: exit code 0 and no further artifact diff.

- [ ] **Step 5: Commit the benchmark update**

```powershell
git add devdocs/benchmarks/seed-resolution-evaluation-v1.json
git diff --cached --check
git commit -m "Update seed resolution evaluation"
```

## Chunk 2: Restarted-server acceptance and documentation

### Task 4: Verify the live candidate-seeding acceptance boundary

**Prerequisite:** After Task 3, first prove the local build contains the change:

```powershell
node --input-type=module -e "import assert from 'node:assert/strict'; import { buildActionSeedQueries } from './dist/agent/context-seeding.js'; assert.deepEqual(buildActionSeedQueries('Review the current SDL-MCP tool surface for contracts, output noise, deterministic responses, and safe errors.'), ['context response projection']);"
```

Then restart the configured SDL-MCP server from this workspace and freshly index the repository. The canonical broad call in Step 2 is the server-process proof: the old verified baseline returned zero expected pairs, so do not accept a restart claim without the Step 2 threshold.

- [ ] **Step 1: Confirm server and graph state**

Call `repo.status` for `sdl-mcp`.

Also call `symbol.getCard` for `buildActionSeedQueries`. Expected: watcher healthy, stale false, `graphIntegrityState: "verified"`, and the indexed symbol range differs from the pre-change baseline ending at line 265. The range check proves the fresh index includes the edited source.

- [ ] **Step 2: Run the canonical broad request**

Call `sdl.context` with:

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

Take the first ten `symbolCard` entries in `finalEvidence` order. Require at least four exact pairs:

- `buildFlatToolDescriptors` — `src/mcp/tools/tool-descriptors.ts`
- `registerTool` — `src/server.ts`
- `buildToolResponseEnvelope` — `src/server.ts`
- `asStructuredContent` — `src/server.ts`
- `handleRuntimeQueryOutput` — `src/mcp/tools/runtime-query.ts`

Also require no top-ten path beginning `outputs/logos/` and none equal to `scripts/evaluate-seed-resolution.ts`.

Stop this refactor if fewer than four expected pairs appear, if either output-noise exclusion fails, or if the local assertion passes while the live result still matches the old zero-of-five baseline. Treat the server build as unproven when applicable. Record the result; do not add vocabulary, another query, ranking weights, thresholds, or diagnostics.

- [ ] **Step 3: Verify explicit focus remains available**

Copy the canonical Step 2 request twice. Preserve `repoId`, `taskType`, the literal `taskText`, `semantic: true`, `includeRetrievalEvidence: true`, `evidenceOptimization: "off"`, `cardDetail: "task"`, and `includeDiagnostics: false`. Change only `contextMode` from `"broad"` to `"precise"` and add the stated `focusPaths`:

1. `focusPaths: ["outputs/logos"]` must return a top-ten `symbolCard` whose path begins `outputs/logos/`.
2. `focusPaths: ["scripts"]` must return a top-ten `symbolCard` whose path begins `scripts/`.

Expected: both pass. If graph integrity, either broad noise exclusion, or either focus-path guard fails, stop implementation and record a non-accepted result in Task 5; do not mark the finding accepted.

### Task 5: Update the QA acceptance record

**Files:**
- Modify: `devdocs/qaplans/2026-07-18-sdl-tool-qa-live-v0-12-4.md`

- [ ] **Step 1: Update only the broad-context finding**

Record:

- the early-return root cause in `buildActionSeedQueries()`;
- the narrow three-group activation predicate;
- the named-action preservation regression;
- benchmark quality values;
- graph-integrity status and canonical top-ten name/path evidence;
- focus-path results;
- either accepted status or the evidence-backed stop.

Do not add telemetry, durations, absolute machine paths, or token-savings claims.

- [ ] **Step 2: Preserve the local QA report**

Run:

```powershell
git check-ignore -v devdocs/qaplans/2026-07-18-sdl-tool-qa-live-v0-12-4.md
```

Expected: `.gitignore` reports the `devdocs/*` rule. Re-read the updated section with `sdl.file.read`, keep the local artifact, and do not use `git add -f`.

### Task 6: Final verification

- [ ] **Step 1: Run static checks**

```powershell
npm.cmd run typecheck
npm.cmd run lint
```

Expected: both exit 0.

- [ ] **Step 2: Run the affected automated checks together**

```powershell
node --experimental-strip-types --test tests/unit/agent/context-action-seeding.test.ts tests/unit/agent/context-ranking.test.ts tests/benchmark/context-quality.test.ts
node --experimental-strip-types scripts/evaluate-seed-resolution.ts --check
```

Expected: all tests pass and the benchmark artifact is current.

- [ ] **Step 3: Inspect Git scope**

Verify the tracked worktree is clean and commits touch only the planned source, test, benchmark artifact, and design/plan documents. Confirm the QA report remains ignored and locally updated. Do not push or alter unrelated changes.
