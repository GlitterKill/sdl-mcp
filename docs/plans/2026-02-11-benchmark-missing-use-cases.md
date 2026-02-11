# Missing Use-Case Benchmark Coverage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand real-world benchmark coverage so we can credibly test whether SDL-MCP sustains `>=50%` capped token reduction across currently missing coding-agent use-case families.

**Architecture:** Keep `scripts/real-world-benchmark.ts` as the per-run engine, add pack-based task files for missing use cases, and add a matrix runner that executes packs across repos and aggregates per-family stats. Use explicit pass/fail thresholds per family rather than a single global average.

**Tech Stack:** Node.js, TypeScript, existing benchmark scripts (`benchmark:real`, `benchmark:setup-external`, `benchmark:sweep`), JSON task packs, GitHub Actions.

---

### Task 1: Freeze Current Baseline and Targets

**Files:**
- Create: `benchmarks/real-world/runs/2026-02-11-baseline/README.md`
- Create: `benchmarks/real-world/runs/2026-02-11-baseline/my-repo.json`
- Create: `benchmarks/real-world/runs/2026-02-11-baseline/zod-oss.json`
- Modify: `benchmarks/real-world/README.md`

**Step 1: Run current benchmark for local repo**

Run: `npm run benchmark:real -- -- --repo-id my-repo --skip-index --out benchmarks/real-world/runs/2026-02-11-baseline/my-repo.json`
Expected: command succeeds, summary written with `taskCount > 0`.

**Step 2: Run current benchmark for zod repo**

Run: `npm run benchmark:real -- -- --repo-id zod-oss --skip-index --out benchmarks/real-world/runs/2026-02-11-baseline/zod-oss.json`
Expected: command succeeds, includes 3 `zod-oss` tasks.

**Step 3: Record explicit baseline numbers**

Write baseline metrics and date into `benchmarks/real-world/runs/2026-02-11-baseline/README.md`.
Expected: README contains capped reduction and task counts by repo.

**Step 4: Define pass/fail targets**

Add target rubric to `benchmarks/real-world/README.md`:
- Per-family `p50 capped >= 50%`
- Per-family `p25 capped >= 40%`
- No task below `20%` capped reduction

Expected: documented thresholds are concrete and testable.

**Step 5: Commit**

```bash
git add benchmarks/real-world/runs/2026-02-11-baseline benchmarks/real-world/README.md
git commit -m "bench: freeze baseline and define token-reduction targets"
```

### Task 2: Add Missing-Use-Case Taxonomy and Tags

**Files:**
- Modify: `scripts/real-world-benchmark.ts`
- Create: `tests/unit/real-world-benchmark-tags.test.ts`
- Modify: `benchmarks/real-world/tasks.json`

**Step 1: Write failing test for task tags propagation**

Test should assert `tags` survive normalization and appear in output payload.
Expected: FAIL because tags are not yet modeled/serialized.

**Step 2: Run the failing test**

Run: `npm test -- tests/unit/real-world-benchmark-tags.test.ts`
Expected: FAIL with missing `tags` assertion.

**Step 3: Implement minimal tag support**

Add optional `tags: string[]` on `WorkflowTask` and include tags in task result output.
Expected: compile succeeds.

**Step 4: Run test again**

Run: `npm test -- tests/unit/real-world-benchmark-tags.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/real-world-benchmark.ts tests/unit/real-world-benchmark-tags.test.ts benchmarks/real-world/tasks.json
git commit -m "bench: add task tags for use-case family tracking"
```

### Task 3: Expand External Repos for Missing Domains

**Files:**
- Modify: `scripts/setup-external-benchmark-repos.ts`
- Modify: `benchmarks/real-world/external-repos.config.json`
- Modify: `config/sdlmcp.config.example.json`

**Step 1: Add external repo specs**

Add at least:
- one frontend-heavy repo
- one infra/devops-heavy repo
- one non-TS repo

Expected: `EXTERNAL_REPOS` contains 3+ new entries beyond `zod-oss`.

**Step 2: Regenerate external repo config**

Run: `npm run benchmark:setup-external`
Expected: clones/refreshes repos and writes config snippet.

**Step 3: Merge generated entries into benchmark config**

Update `benchmarks/real-world/external-repos.config.json` and example config.
Expected: each new repo has `repoId`, `rootPath`, `languages`, and `ignore`.

**Step 4: Validate setup script idempotence**

Run: `npm run benchmark:setup-external` a second time.
Expected: no errors; repos update cleanly.

**Step 5: Commit**

```bash
git add scripts/setup-external-benchmark-repos.ts benchmarks/real-world/external-repos.config.json config/sdlmcp.config.example.json
git commit -m "bench: add external repos for missing use-case domains"
```

### Task 4: Author Task Packs for Missing Use Cases

**Files:**
- Create: `benchmarks/real-world/packs/security.tasks.json`
- Create: `benchmarks/real-world/packs/infra-devops.tasks.json`
- Create: `benchmarks/real-world/packs/db-migration.tasks.json`
- Create: `benchmarks/real-world/packs/dependency-migration.tasks.json`
- Create: `benchmarks/real-world/packs/incident-debugging.tasks.json`
- Create: `benchmarks/real-world/packs/frontend-ui.tasks.json`
- Create: `benchmarks/real-world/packs/multirepo.tasks.json`
- Create: `benchmarks/real-world/packs/greenfield.tasks.json`
- Create: `benchmarks/real-world/packs/tiny-tasks.tasks.json`
- Create: `benchmarks/real-world/packs/cross-language.tasks.json`

**Step 1: Add 5 tasks per pack**

Write realistic `workflow` steps with `triage/investigate/change/validate`, explicit `contextTargets`, and `tags`.
Expected: each pack has `>=5` tasks.

**Step 2: Validate JSON shape**

Run: `node -e "for (const f of require('fs').readdirSync('benchmarks/real-world/packs')) { JSON.parse(require('fs').readFileSync('benchmarks/real-world/packs/'+f,'utf8')); } console.log('ok')"`
Expected: `ok`.

**Step 3: Smoke run one pack**

Run: `npm run benchmark:real -- -- --tasks benchmarks/real-world/packs/security.tasks.json --skip-index --out benchmarks/real-world/runs/security-smoke.json`
Expected: benchmark completes with non-zero task count.

**Step 4: Fix pack quality gaps**

Adjust tasks with low/zero context targets or ambiguous prompts.
Expected: no pack task produces empty relevant context unless intentional.

**Step 5: Commit**

```bash
git add benchmarks/real-world/packs
git commit -m "bench: add missing use-case task packs"
```

### Task 5: Add Matrix Runner for Pack x Repo Execution

**Files:**
- Create: `scripts/real-world-benchmark-matrix.ts`
- Create: `benchmarks/real-world/matrix.json`
- Create: `tests/integration/benchmark-matrix.test.ts`
- Modify: `package.json`

**Step 1: Write failing integration test**

Test should assert matrix runner executes at least 2 runs and writes aggregate JSON.
Expected: FAIL because runner does not exist.

**Step 2: Run failing test**

Run: `npm test -- tests/integration/benchmark-matrix.test.ts`
Expected: FAIL with missing script/module.

**Step 3: Implement runner**

Create script to iterate `matrix.json`, call `scripts/real-world-benchmark.ts`, and aggregate per-family stats (`p50`, `p25`, `min` capped reduction).
Expected: `npm run benchmark:matrix` creates aggregate output.

**Step 4: Re-run test**

Run: `npm test -- tests/integration/benchmark-matrix.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/real-world-benchmark-matrix.ts benchmarks/real-world/matrix.json tests/integration/benchmark-matrix.test.ts package.json
git commit -m "bench: add matrix runner for pack and repo coverage"
```

### Task 6: Run Full Coverage Sweep and Budget Tuning

**Files:**
- Create: `benchmarks/real-world/runs/coverage-matrix/aggregate.json`
- Create: `benchmarks/real-world/runs/coverage-matrix/summary.md`
- Create: `benchmarks/real-world/runs/coverage-matrix/sweep/`

**Step 1: Run matrix once (fresh index)**

Run: `npm run benchmark:matrix`
Expected: aggregate output with per-family metrics.

**Step 2: Identify weak families**

Find families where `p50 < 50` or `p25 < 40`.
Expected: explicit weak-family list in `summary.md`.

**Step 3: Sweep budgets for weak families**

Run (example): `npm run benchmark:sweep -- -- --tasks benchmarks/real-world/packs/security.tasks.json --repo-id <repoId> --out-dir benchmarks/real-world/runs/coverage-matrix/sweep/security`
Expected: sweep CSV and per-point results written.

**Step 4: Lock default budget candidates**

Promote chosen `maxCards/maxTokens` into pack defaults.
Expected: matrix rerun improves weak-family metrics.

**Step 5: Commit**

```bash
git add benchmarks/real-world/runs/coverage-matrix benchmarks/real-world/packs
git commit -m "bench: tune budgets for weak use-case families"
```

### Task 7: Add CI Gates for Coverage Claims

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `scripts/check-benchmark-claims.ts`
- Create: `tests/unit/check-benchmark-claims.test.ts`

**Step 1: Write failing test for claim checker**

Test should fail when any family violates thresholds.
Expected: FAIL before checker implementation.

**Step 2: Implement checker**

Read aggregate JSON and enforce:
- per-family `p50 >= 50`
- per-family `p25 >= 40`
- no task `< 20`

Expected: local checker passes on compliant data.

**Step 3: Add CI jobs**

Add:
- PR smoke matrix subset
- nightly full matrix + checker

Expected: CI runs checker and fails on threshold regressions.

**Step 4: Validate locally**

Run: `node scripts/check-benchmark-claims.ts --in benchmarks/real-world/runs/coverage-matrix/aggregate.json`
Expected: exit code `0` on success.

**Step 5: Commit**

```bash
git add .github/workflows/ci.yml scripts/check-benchmark-claims.ts tests/unit/check-benchmark-claims.test.ts
git commit -m "ci: gate benchmark token-reduction claims by use-case family"
```

### Task 8: Publish Claim Language and Residual Risk

**Files:**
- Create: `benchmarks/real-world/CLAIMS.md`
- Modify: `README.md`

**Step 1: Document approved claim wording**

Add language like: ">=50% capped reduction across benchmarked families and repos in current matrix."
Expected: no universal/unbounded wording.

**Step 2: Document residual gaps**

List any families not yet represented or under threshold.
Expected: transparent risk section.

**Step 3: Link reproducibility commands**

Include exact commands for setup, run, and checker.
Expected: one-command copy/paste path for verification.

**Step 4: Review for consistency**

Ensure README and CLAIMS wording match CI thresholds.
Expected: no contradictory claim text.

**Step 5: Commit**

```bash
git add benchmarks/real-world/CLAIMS.md README.md
git commit -m "docs: publish benchmark claim rubric and reproducibility steps"
```

### Task 9: Universal-Claim Readiness Review

**Files:**
- Create: `benchmarks/real-world/runs/coverage-matrix/readiness-report.md`

**Step 1: Compile per-family scorecard**

Include task counts, repos, p50/p25/min, and failures.
Expected: single-page decision artifact.

**Step 2: Decide claim level**

Choose:
- "broad coverage claim" if all thresholds pass
- "partial claim" if any family fails

Expected: explicit yes/no for universal-style claim.

**Step 3: Record next actions for failing families**

List concrete fixes (task design vs ladder behavior vs budget).
Expected: actionable backlog.

**Step 4: Sign off with timestamp**

Add run date and aggregate artifact hash.
Expected: reproducible audit trail.

**Step 5: Commit**

```bash
git add benchmarks/real-world/runs/coverage-matrix/readiness-report.md
git commit -m "bench: produce universal-claim readiness report"
```

