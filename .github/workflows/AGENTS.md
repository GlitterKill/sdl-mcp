# GitHub Actions Troubleshooting Notes

This directory contains the CI workflows for `sdl-mcp`. Use this file as the first stop when a GitHub Actions run fails.

Future agents must update this document when they confirm a new root cause, land a CI-related fix, or learn something that materially changes how the workflows should be debugged. Append new findings instead of rewriting history, and separate confirmed facts from hypotheses.

## Current CI Shape

The main workflow is [ci.yml](\\?\F:\Claude\projects\sdl-mcp\sdl-mcp\.github\workflows\ci.yml). The `Tests` job runs on `ubuntu-latest` and `windows-latest` with Node `20.x`.

The job installs dependencies with `npm ci --ignore-scripts --legacy-peer-deps`, rebuilds `tree-sitter*`, runs Kuzu setup if `node_modules/kuzu/install.js` exists, then runs `build`, `typecheck`, `lint`, `check:config-sync`, `npm audit --audit-level=moderate`, `npm test`, `npm run test:harness`, and a few smoke checks.

The test step writes the full `npm test` output to `${RUNNER_TEMP}/test-output.txt`, prints it to the log, and uploads it as an artifact on failure. The GitHub step summary only shows a filtered excerpt, so do not rely on the summary alone for root-cause work.

## Investigation Workflow

Use the `gh` CLI first. This sequence is the fastest path that produced useful signal in this repo:

```powershell
gh run view <run-id> --json databaseId,headBranch,headSha,jobs,name,status,conclusion,url
gh run view <run-id> --log-failed
gh run download <run-id> -n test-output-windows-latest -D $env:TEMP\gha-artifacts
gh run download <run-id> -n test-output-ubuntu-latest -D $env:TEMP\gha-artifacts
```

Compare the failing job against the workflow definition before changing code. In this repo, many apparent failures are caused by native dependency behavior on Windows, not by the workflow YAML itself.

When a failure comes from `tests/runner.test.ts`, remember that the file imports all `tests/**/*.test.ts` in sorted path order. If the process dies between two test files, inspect the next file in that order, not the last test that printed `ok`.

## Confirmed Findings

### 2026-07-17: Repeat Provider Materialization Duplicate Primary Key (Hosted Validation Pending)

Run `29580560720` failed only in `benchmarks (ubuntu-latest)`, step `Run Benchmark CI Guardrails (locked OSS repo)`, on commit `c4f55d79c9d169c674d6157124c1503f77e13895`. Attempts 1 through 4 used jobs `87884983590`, `87898973114`, `87900355505`, and `87903760317`.

Every attempt failed before benchmark thresholds with the same symbol ID:

```text
Fatal error: index phase providerFirstMaterialize failed: Copy exception: Found duplicated primary key value c5ca46326d5a620a62bd6c138d6aa210033eb7f4e5777107e5734aec5245f273, which violates the uniqueness constraint of the primary key column.
```

Confirmed evidence and root cause:

- Deleting the Linux benchmark-repository cache and rerunning produced the same failure after a fresh locked-repository setup.
- Deleting the Linux `node_modules` cache and rerunning produced the same failure after a fresh dependency install and fresh locked-repository setup.
- Provider rows are validated for duplicate symbol IDs before database writes.
- The provider planner used a 50,000-symbol replacement ceiling even though `ladybug-symbols.ts` already limits safe deletion or mutation of COPY-loaded `Symbol` tables to 2,048 rows for LadybugDB 0.18.1. Zod's 4,414 provider symbols therefore entered the unsafe path.
- A local failed database returned 4,628 `Symbol` rows but only 4,160 unique IDs after repeat fallback mutations. This physical duplication despite the primary key explains both the original materialization failure and later version snapshot duplicates.

Current fix: the provider planner now uses the shared 2,048-row safety limit. Above it, unchanged repeats reuse the complete verified graph only when provider rows are reusable, the generated provider fingerprint matches the active record, and every scanned source file is unchanged. The no-op is verified against the persisted graph digest and reuses the active version, avoiding both provider and legacy fallback `Symbol` mutations.

The exact local two-sample Zod guardrail passed all 10 thresholds against a fresh database after this change. Hosted Ubuntu validation on the fix SHA is still required.

Useful inspection commands:

```powershell
gh run view 29580560720 --repo GlitterKill/sdl-mcp --json databaseId,headSha,jobs,status,conclusion,url
gh run view 29580560720 --repo GlitterKill/sdl-mcp --attempt 4 --log-failed
gh cache list --repo GlitterKill/sdl-mcp --limit 100 --json id,key,createdAt,lastAccessedAt,sizeInBytes
```

Focused local verification:

```powershell
npm run build:runtime
node --experimental-strip-types --test --test-name-pattern "reuses active provider rows|reuses the full graph only" tests/unit/provider-first-indexing.test.ts
node dist/cli/index.js benchmark:ci --repo-id zod-oss --threshold-path config/benchmark.ci.config.json --json
npm run typecheck
npm run lint
```

### 2026-04-24: Semantic Embedding Refresh Race Regression

Run `24870184275` failed in `CI`, jobs `72814789964` (`tests (ubuntu-latest, 24.x)`) and `72814789967` (`tests (windows-latest, 24.x)`), step `Run tests (including 6 new language adapters + cross-platform paths)`, on commit `2a7dcd47abd4413968caa4b9db00ae91cd723cf3` from `main`.

The exact failing assertion in both jobs was:

```text
tests/unit/semantic-pipeline-regressions.test.ts
error: 'refreshSymbolEmbeddings should recheck cache after embed for race avoidance'
```

Commands that produced the useful signal:

```powershell
gh run view 24870184275 --repo GlitterKill/sdl-mcp --json name,conclusion,status,url,event,headBranch,headSha,jobs
gh run view 24870184275 --repo GlitterKill/sdl-mcp --job 72814789964 --log | Select-String -Pattern 'semantic-pipeline-regressions|not ok|error:|AssertionError' -Context 3,5
gh run view 24870184275 --repo GlitterKill/sdl-mcp --job 72814789967 --log | Select-String -Pattern 'semantic-pipeline-regressions|not ok|error:|AssertionError' -Context 3,5
git show b19a21f:src/indexer/embeddings.ts
git show 2a7dcd4:src/indexer/embeddings.ts
```

Confirmed root cause: the batching optimization in `2a7dcd4` kept the pre-pass cache check but dropped the post-embed cache recheck that had been present in `b19a21f`. That changed behavior, not just structure. The regression test was correctly catching that another writer could now win the race while a batch was embedding, and the current process would still persist a redundant write.

Smallest confirmed fix: restore the post-embed cache recheck in `src/indexer/embeddings.ts`, but keep it batched. Re-read embeddings for the current batch after `await provider.embed(batchTexts)`, filter out items whose `cardHash` is already current, then send only the remaining items through `setSymbolEmbeddingBatchOnNode(...)`.

Local verification command:

```powershell
node --experimental-strip-types --test tests/unit/semantic-pipeline-regressions.test.ts
```

Expected result after the fix: the regression suite passes, and the write-lock optimization remains in place because only the stale subset is written.

### 2026-03-10 to 2026-03-11: Security Audit Failure

Run `22932145223` failed in the `Security audit` step on both Ubuntu and Windows. Build, typecheck, and lint all passed before the audit step failed.

The root cause was stale `npm overrides` in `package.json`, not an upstream dependency dead end. The repo pinned `hono` to `4.12.5` and `tar` to `7.5.10`, which were the exact vulnerable versions the audit reported.

The effective fix was to update the overrides to patched versions and regenerate `package-lock.json` with the same install mode CI uses. The related low-risk dependency pass also bumped `onnxruntime-node` and `@types/node`.

### 2026-03-11: Windows Test Crash After Audit Fix

Run `22933995850`, job `66561262194`, still failed after the audit issue was resolved. The remaining failure was Windows-only in `Tests (windows-latest)` during `Run tests (including 6 new language adapters + cross-platform paths)`.

The observable failure was:

```text
not ok 1 - D:\a\sdl-mcp\sdl-mcp\tests\runner.test.ts
failureType: 'testCodeFailure'
exitCode: 3221225477
code: 'ERR_TEST_FAILURE'
```

`3221225477` is a Windows access violation. Treat that as a native crash unless proven otherwise.

The last useful CI log line before the crash was LadybugDB schema initialization for the `file-patcher` test database:

```text
# [INFO] LadybugDB schema initialized {"path":"C:/Users/RUNNER~1/AppData/Local/Temp/.lbug-file-patcher-test-db.lbug"}
```

`tests/runner.test.ts` loads files in sorted order, and the next file after the `fan-in-trend` tests is `tests/unit/file-patcher.test.ts`. That made `file-patcher` the highest-confidence suspect even though the crash surfaced as a failure on `runner.test.ts`.

The confirmed root cause was test DB path reuse in Windows-sensitive Kuzu/Ladybug tests. `tests/unit/file-patcher.test.ts` used a fixed `%TEMP%` database path, which can leave behind WAL or file-handle state and crash in native code instead of throwing a JavaScript assertion.

During local investigation, `tests/integration/ladybug-slice-build.test.ts` showed the same class of problem. It used a fixed DB path and also swallowed setup errors, which turned a setup failure into a later `Cannot read properties of undefined (reading 'upsertRepo')` error. That specific JS failure was local noise, but it exposed the same fragile test pattern.

The focused test hardening that cleared local failures was:

- `tests/unit/file-patcher.test.ts`: use a fresh `mkdtempSync(...)` directory for the DB on every run, and delete the whole temp directory in teardown.
- `tests/integration/ladybug-slice-build.test.ts`: use a fresh `mkdtempSync(...)` directory for the DB, preserve setup errors, and skip explicitly if Ladybug/Kuzu setup is unavailable instead of continuing with undefined state.

Local verification after those changes:

```powershell
npm test
```

Result:

```text
# tests 1586
# pass 1582
# fail 0
```

## Local Reproduction Caveats

Use the same Node major version as CI when you investigate native crashes. CI runs Node `20.x`, and local reproductions become unreliable if `node_modules` contains native artifacts built under Node `22`.

Do not over-interpret local Windows `EPERM` unlink failures during `npm ci`. Fresh GitHub runners do not carry the same `%TEMP%` and file-lock state as a reused local workstation.

Keep `--legacy-peer-deps` in place when you regenerate the lockfile or reproduce CI installs. The current repo depends on that resolution mode, and dropping it changes the dependency graph in ways that do not match CI.

## Heuristics That Helped

If the failing job dies inside `runner.test.ts` with no assertion message, download the test-output artifact and inspect the last 20-50 lines. The final printed DB path or test banner is often more useful than the GitHub summary.

If the log ends right after a LadybugDB or Kuzu initialization line, suspect temp DB reuse, WAL leftovers, or native binary state before suspecting application logic. Native crashes often do not print a stack trace.

If a test file catches setup errors and flips a `ladybugAvailable` flag, verify that the test also records the error reason. Silent setup failure can mask the real cause and send debugging in the wrong direction.

## Update Protocol For Future Agents

When you learn something new, append a dated entry under `Confirmed Findings` or add a new section if the topic does not fit an existing one. Preserve older entries unless they are factually wrong, and if you correct one, say why.

Each update should include:

- Date
- Run ID and job ID when available
- Branch or commit SHA when relevant
- Exact failing step name
- Whether the root cause is `confirmed` or still a `hypothesis`
- Commands used to inspect the failure
- The smallest fix that resolved it, or why no fix has been confirmed yet
- Verification commands and results

Do not mix workflow bugs, dependency audit issues, and native test crashes into one vague summary. Keep them separate so the next agent can decide quickly whether the right fix belongs in workflow YAML, dependency metadata, or test code.

If you change the workflows themselves, document why a workflow change was necessary and why a code or test fix was insufficient. If you change only repo code or tests, record that too so future agents do not keep editing CI YAML to compensate for an application-level problem.
