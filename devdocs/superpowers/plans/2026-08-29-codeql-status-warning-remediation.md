# CodeQL Status Warning Remediation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace automatic CodeQL setup with one scoped advanced workflow that scans production-relevant languages and removes the verified Rust, C#, and Go fixture diagnostics from tool status.

**Architecture:** Add one GitHub Actions workflow with a four-language `build-mode: none` matrix and an inline CodeQL `paths-ignore` configuration for only the two standalone Rust fixture trees. Keep local implementation separate from the live cutover: default-setup disablement, push, rollback, analyzed-file verification, and stale-configuration deletion require separate explicit authorization.

**Tech Stack:** GitHub Actions, `github/codeql-action@v4`, `actions/checkout@v6`, CodeQL advanced setup, Python 3 with installed PyYAML for local structural validation, GitHub CLI.

---

**Approved spec:** `devdocs/superpowers/specs/2026-08-29-codeql-status-warning-remediation-design.md`

**Required implementation skills:** `@subagent-driven-development`, `@test-scope`, and `@verification-before-completion`.

## Baseline constraints

- Create only `.github/workflows/codeql.yml`; do not edit product code, fixture code, dependencies, or public runtime documentation.
- Keep Actions, JavaScript/TypeScript, Python, and Rust analysis. Do not add fixture-only C/C++, C#, or Go matrix jobs.
- Ignore only `tests/fixtures/rust/**` and `tests/stress/fixtures/src/rust/**` inside CodeQL analysis.
- Preserve the existing `/language:${{ matrix.language }}` categories so retained-language analyses replace automatic results cleanly.
- `main` is currently the only protected branch, and its ruleset has no required status checks. Recheck both facts before publication.
- Commit locally only during Chunk 1. Do not push, disable default setup, delete a CodeQL configuration, or otherwise mutate GitHub security state without separate explicit authorization.
- Do not run product tests for this workflow-only change. Validate the YAML contract directly and run Git diff hygiene checks.

## File map

- Create `.github/workflows/codeql.yml`: own the complete advanced CodeQL trigger, permissions, language matrix, fixture exclusions, and result categories.
- No persistent test file: a Python/PyYAML contract check validates the declarative workflow without adding a dependency or a second implementation file.

## Chunk 1: Local workflow implementation

### Task 1: Add the scoped advanced CodeQL workflow

**Files:**

- Create: `.github/workflows/codeql.yml`

- [ ] **Step 1: Verify the local baseline**

Run:

```powershell
git status --short --branch
Test-Path -LiteralPath ".github/workflows/codeql.yml"
```

Expected: `main` is ahead only by the approved design/plan commits, the worktree has no unrelated changes, and `Test-Path` prints `False`. If the workflow already exists, stop and inspect it instead of overwriting it.

- [ ] **Step 2: Create the minimum workflow**

Create `.github/workflows/codeql.yml` with exactly this content:

```yaml
name: CodeQL

"on":
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
  schedule:
    - cron: "41 8 * * 3"

jobs:
  analyze:
    name: Analyze (${{ matrix.language }})
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      security-events: write
    strategy:
      fail-fast: false
      matrix:
        language:
          - actions
          - javascript-typescript
          - python
          - rust
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6

      - name: Initialize CodeQL
        uses: github/codeql-action/init@v4
        with:
          languages: ${{ matrix.language }}
          build-mode: none
          config: |
            paths-ignore:
              - tests/fixtures/rust/**
              - tests/stress/fixtures/src/rust/**

      - name: Perform CodeQL analysis
        uses: github/codeql-action/analyze@v4
        with:
          category: "/language:${{ matrix.language }}"
```

The Wednesday 08:41 UTC schedule avoids the repository's existing daily 07:23 UTC and Monday 09:17 UTC schedules. Do not add caching, autobuild, concurrency, a reusable workflow, or a separate configuration file.

- [ ] **Step 3: Parse and assert the workflow contract**

Run this installed-PyYAML check:

```powershell
python -c 'from pathlib import Path; import yaml; d=yaml.safe_load(Path(".github/workflows/codeql.yml").read_text(encoding="utf-8")); o=d["on"]; assert o["push"]["branches"]==["main"]; assert o["pull_request"]["branches"]==["main"]; assert o["schedule"]==[{"cron":"41 8 * * 3"}]; j=d["jobs"]["analyze"]; assert j["permissions"]=={"actions":"read","contents":"read","security-events":"write"}; assert j["strategy"]["fail-fast"] is False; assert j["strategy"]["matrix"]["language"]==["actions","javascript-typescript","python","rust"]; init=next(s for s in j["steps"] if s["name"]=="Initialize CodeQL"); assert init["uses"]=="github/codeql-action/init@v4"; assert init["with"]["languages"]=="${{ matrix.language }}"; assert init["with"]["build-mode"]=="none"; assert yaml.safe_load(init["with"]["config"])=={"paths-ignore":["tests/fixtures/rust/**","tests/stress/fixtures/src/rust/**"]}; analyze=next(s for s in j["steps"] if s["name"]=="Perform CodeQL analysis"); assert analyze["uses"]=="github/codeql-action/analyze@v4"; assert analyze["with"]["category"]=="/language:${{ matrix.language }}"; print("CodeQL workflow contract OK")'
```

Expected: `CodeQL workflow contract OK` and exit `0`.

- [ ] **Step 4: Stage and inspect the complete workflow diff**

Run:

```powershell
git status --short
git add -- .github/workflows/codeql.yml
git diff --cached --check
git diff --cached -- .github/workflows/codeql.yml
git diff --cached --name-only
```

Expected: status shows `.github/workflows/codeql.yml` as the only untracked file before staging; no whitespace errors; the cached diff displays the complete approved workflow; the staged name list contains only `.github/workflows/codeql.yml`. Product tests are intentionally out of scope because no product code, package metadata, generated contract, or runtime behavior changed.

- [ ] **Step 5: Commit the reviewed workflow locally**

Run:

```powershell
git commit -m "ci: add scoped CodeQL analysis"
```

Expected: the staged name list contains only `.github/workflows/codeql.yml`; the commit succeeds locally. Do not push.

## Chunk 2: Separately authorized GitHub cutover

### Task 2: Revalidate and request publication authority

**Files:**

- No local file changes.

- [ ] **Step 1: Recheck drift-prone GitHub state and bind the proposed push**

Run read-only checks:

```powershell
$env:GH_CONFIG_DIR = "C:\Users\glitt\AppData\Roaming\GitHub CLI"
git fetch --no-tags origin main
if ($LASTEXITCODE -ne 0) { throw "Could not refresh origin/main" }
$trackingSha = (git rev-parse origin/main).Trim()
$liveOriginSha = ((git ls-remote origin refs/heads/main) -split "\s+")[0]
if ($trackingSha -ne $liveOriginSha) { throw "origin/main does not match the live remote" }
$cutoverSha = (git rev-parse HEAD).Trim()
$originSha = $liveOriginSha
git merge-base --is-ancestor $originSha $cutoverSha
if ($LASTEXITCODE -ne 0) { throw "The proposed cutover is not a fast-forward of live main" }
$commitRange = "$originSha..$cutoverSha"
Write-Output "CUTOVER_SHA=$cutoverSha"
Write-Output "ORIGIN_SHA=$originSha"
git log --format="%H %s" $commitRange
gh api "repos/GlitterKill/sdl-mcp/branches?per_page=100&protected=true" --jq "[.[].name]"
gh api repos/GlitterKill/sdl-mcp/rules/branches/main
$defaultSetupJson = gh api repos/GlitterKill/sdl-mcp/code-scanning/default-setup
if ($LASTEXITCODE -ne 0) { throw "Could not read default setup" }
$defaultSetup = $defaultSetupJson | ConvertFrom-Json
if ($defaultSetup.state -ne "configured") { throw "Default setup is not configured" }
Write-Output "DEFAULT_SETUP_JSON=$($defaultSetup | ConvertTo-Json -Compress)"
gh api "repos/GlitterKill/sdl-mcp/code-scanning/alerts?state=open&per_page=100" --jq "[.[] | {number,category:.most_recent_instance.category,path:.most_recent_instance.location.path}]"
git status --short --branch
```

Expected before cutover: the exact SHA and complete `origin/main..HEAD` commit list are recorded; only `main` is protected; the effective branch-rules response contains no required status check that conflicts with `Analyze (<language>)`; default setup is `configured`; open alerts are reviewed before any configuration deletion; the workflow commit is local and the worktree is clean.

- [ ] **Step 2: Stop for explicit authorization**

Report the exact `ORIGIN_SHA`, `CUTOVER_SHA`, every commit in the proposed range, current default-setup JSON, open-alert count, protected branches and effective rules, and rollback operations. Obtain explicit authorization bound to both SHAs and the reported default-setup contract, covering all of: disabling default setup, pushing `main`, reverting the workflow if needed, pushing the rollback commit, re-enabling default setup, waiting for a recovery scan, and deleting the two named stale automatic configurations.

Expected: no external mutation until that authorization is recorded.

### Task 3: Cut over, verify coverage, and remove stale configurations

**Files:**

- No additional local file changes unless rollback requires reverting the workflow commit.

- [ ] **Step 1: Revalidate the authorized snapshot, disable default setup fail-closed, then push**

After explicit authorization, replace all three placeholders with the exact authorized values. The default-setup placeholder is the single-line JSON reported in Task 2.

```powershell
$env:GH_CONFIG_DIR = "C:\Users\glitt\AppData\Roaming\GitHub CLI"
$approvedOriginSha = "APPROVED_ORIGIN_SHA"
$approvedCutoverSha = "APPROVED_CUTOVER_SHA"
$approvedDefaultSetup = 'APPROVED_DEFAULT_SETUP_JSON' | ConvertFrom-Json

function Get-DefaultSetupContract([object]$setup) {
  [ordered]@{
    state = $setup.state
    languages = @($setup.languages | Sort-Object)
    query_suite = $setup.query_suite
    threat_model = $setup.threat_model
    schedule = $setup.schedule
    runner_type = $setup.runner_type
    runner_label = $setup.runner_label
  } | ConvertTo-Json -Compress -Depth 4
}

if ((git status --porcelain)) { throw "Worktree changed after authorization" }
$cutoverSha = (git rev-parse HEAD).Trim()
if ($cutoverSha -ne $approvedCutoverSha) { throw "HEAD changed after authorization" }
git fetch --no-tags origin main
if ($LASTEXITCODE -ne 0) { throw "Could not refresh origin/main" }
$trackingSha = (git rev-parse origin/main).Trim()
$remoteSha = ((git ls-remote origin refs/heads/main) -split "\s+")[0]
if ($trackingSha -ne $approvedOriginSha -or $remoteSha -ne $approvedOriginSha) { throw "Remote main changed after authorization" }

$defaultSetupJson = gh api repos/GlitterKill/sdl-mcp/code-scanning/default-setup
if ($LASTEXITCODE -ne 0) { throw "Could not re-read default setup" }
$defaultSetup = $defaultSetupJson | ConvertFrom-Json
if ($defaultSetup.state -ne "configured") { throw "Default setup is not configured" }
$approvedContract = Get-DefaultSetupContract $approvedDefaultSetup
$currentContract = Get-DefaultSetupContract $defaultSetup
if ($currentContract -ne $approvedContract) { throw "Default-setup contract changed after authorization" }

gh api --method PATCH repos/GlitterKill/sdl-mcp/code-scanning/default-setup -f state=not-configured | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Default-setup disable request failed; run Task 4" }

$disableDeadline = (Get-Date).AddMinutes(5)
do {
  $defaultState = (gh api repos/GlitterKill/sdl-mcp/code-scanning/default-setup --jq ".state").Trim()
  if ($LASTEXITCODE -ne 0) { throw "Default-setup state read failed; run Task 4" }
  if ($defaultState -eq "not-configured") { break }
  Start-Sleep -Seconds 5
} while ((Get-Date) -lt $disableDeadline)
if ($defaultState -ne "not-configured") { throw "Default setup did not disable within five minutes; run Task 4" }

$pushStartedAtUtc = (Get-Date).ToUniversalTime()
Write-Output "PUSH_STARTED_AT_UTC=$($pushStartedAtUtc.ToString('o'))"
git push origin "$cutoverSha`:refs/heads/main"
if ($LASTEXITCODE -ne 0) { throw "Push failed after default setup was disabled; run Task 4" }
$remoteSha = ((git ls-remote origin refs/heads/main) -split "\s+")[0]
if ($remoteSha -ne $cutoverSha) { throw "origin/main is not the authorized cutover SHA; run Task 4" }
Write-Output "CUTOVER_PUSHED=$cutoverSha"
```

Expected: both SHAs and the normalized default-setup contract still match the authorized snapshot; the PATCH request succeeds; the poll observes `not-configured`; and only then does `origin/main` advance to the authorized SHA. Record `PUSH_STARTED_AT_UTC` for Step 2. Any thrown error invokes Task 4 immediately; never continue to run verification from a failed cutover step.

- [ ] **Step 2: Enforce the bounded first-run gate**

Replace both placeholders with the values recorded in Step 1. Locate only the push run for that commit, then bind analyses to the same commit and workflow key:

```powershell
$cutoverSha = "APPROVED_CUTOVER_SHA"
$pushStartedAtUtc = [datetimeoffset]::Parse("PUSH_STARTED_AT_UTC")
$startDeadline = $pushStartedAtUtc.AddMinutes(5)
$earliestCreatedAt = $pushStartedAtUtc.AddSeconds(-30)
$run = $null
do {
  $runs = gh run list --workflow codeql.yml --branch main --event push --commit $cutoverSha --limit 10 --json databaseId,headSha,status,conclusion,createdAt,url | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "Could not list the cutover run; run Task 4" }
  $run = $runs | Where-Object {
    $_.headSha -eq $cutoverSha -and
    [datetimeoffset]$_.createdAt -ge $earliestCreatedAt -and
    [datetimeoffset]$_.createdAt -le $startDeadline
  } | Sort-Object createdAt -Descending | Select-Object -First 1
  if ($run) { break }
  Start-Sleep -Seconds 10
} while ([datetimeoffset]::UtcNow -lt $startDeadline)
if (-not $run) { throw "No cutover run started within five minutes; run Task 4" }

$runId = $run.databaseId
$runCreatedAt = [datetimeoffset]$run.createdAt
$finishDeadline = $runCreatedAt.AddMinutes(20)
do {
  $run = gh run view $runId --json databaseId,headSha,status,conclusion,updatedAt,url | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "Could not read the cutover run; run Task 4" }
  if ($run.status -eq "completed") { break }
  Start-Sleep -Seconds 15
} while ([datetimeoffset]::UtcNow -lt $finishDeadline)
if ($run.headSha -ne $cutoverSha -or $run.status -ne "completed" -or $run.conclusion -ne "success") { throw "Cutover run did not complete successfully; run Task 4" }
if ([datetimeoffset]$run.updatedAt -gt $finishDeadline) { throw "Cutover run exceeded the twenty-minute gate; run Task 4" }

$jobs = gh api "repos/GlitterKill/sdl-mcp/actions/runs/$($run.databaseId)/jobs" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Could not read cutover jobs; run Task 4" }
$expectedJobs = @("Analyze (actions)", "Analyze (javascript-typescript)", "Analyze (python)", "Analyze (rust)")
$successfulJobs = @($jobs.jobs | Where-Object { $_.status -eq "completed" -and $_.conclusion -eq "success" } | ForEach-Object name | Sort-Object)
if (Compare-Object ($expectedJobs | Sort-Object) $successfulJobs) { throw "Cutover job set is incomplete; run Task 4" }

$analyses = gh api "repos/GlitterKill/sdl-mcp/code-scanning/analyses?ref=refs%2Fheads%2Fmain&per_page=100" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Could not read uploaded analyses; run Task 4" }
$cutoverAnalyses = @($analyses | Where-Object { $_.commit_sha -eq $cutoverSha -and $_.analysis_key -eq ".github/workflows/codeql.yml:analyze" })
$latestByCategory = @($cutoverAnalyses | Group-Object category | ForEach-Object { $_.Group | Sort-Object created_at -Descending | Select-Object -First 1 })
$expectedCategories = @("/language:actions", "/language:javascript-typescript", "/language:python", "/language:rust")
if (Compare-Object ($expectedCategories | Sort-Object) @($latestByCategory.category | Sort-Object)) { throw "Uploaded cutover categories are incomplete; run Task 4" }
if (@($latestByCategory | Where-Object { $_.error -or $_.warning }).Count -ne 0) { throw "A cutover analysis has an error or warning; run Task 4" }
Write-Output "CUTOVER_RUN_ID=$runId"
Write-Output "CUTOVER_ANALYSIS_KEY=.github/workflows/codeql.yml:analyze"
```

Expected: exactly four successful jobs and four empty-error/empty-warning analyses from `.github/workflows/codeql.yml:analyze` on the authorized commit. Any thrown error invokes Task 4.

- [ ] **Step 3: Verify exact analyzed-file coverage**

From the authenticated CodeQL tool-status page, select the new advanced configuration whose analysis key is `.github/workflows/codeql.yml:analyze`, then download the analyzed-files CSV. Record the advanced configuration identifier shown by the page. Filter validation to rows carrying that exact configuration identifier; stale `automatic` rows cannot satisfy coverage. Confirm the CSV columns identify configuration, path, language, and extraction status. Compare it with tracked files and require:

- every tracked JavaScript/TypeScript and Python source reports successful extraction;
- every tracked GitHub Actions workflow or action definition reports successful extraction;
- every tracked Rust file outside `tests/fixtures/rust/**` and `tests/stress/fixtures/src/rust/**` reports successful extraction;
- exactly the 10 known Rust fixtures are excluded, and no other Rust source is lost.

Expected: every assertion holds using only the new advanced configuration's rows. A missing production file or a report that cannot be bound to the new configuration invokes Task 4 rather than configuration deletion.

- [ ] **Step 4: Delete only the two stale automatic configurations**

Recheck that neither stale configuration owns an open alert. In the authenticated tool-status page, select and delete only:

- `992cdcf08f7eda28cb86fe9e8b79aff393ece38113384141a147527029fa11ed`
- `e9917bfbf66c6fe35a7723d990927ccd12570e4f46fd53426fd3a334fa0b10f4`

Do not delete the new advanced configuration. GitHub exposes configuration deletion through the tool-status page; do not substitute broad analysis-history deletion through the REST API.

### Task 4: Execute the exact rollback when any cutover gate fails

**Files:**

- Revert: `.github/workflows/codeql.yml` only when the workflow reached `origin/main`.

- [ ] **Step 1: Remove the advanced workflow if published and restore default setup**

Replace both placeholders with the authorized values. Restoration sends only `state=configured`; GitHub's GET response contains language aliases that are not a safe PATCH payload. The resulting normalized contract must still match the approved snapshot.

```powershell
$env:GH_CONFIG_DIR = "C:\Users\glitt\AppData\Roaming\GitHub CLI"
$cutoverSha = "APPROVED_CUTOVER_SHA"
$approvedDefaultSetup = 'APPROVED_DEFAULT_SETUP_JSON' | ConvertFrom-Json

function Get-DefaultSetupContract([object]$setup) {
  [ordered]@{
    state = $setup.state
    languages = @($setup.languages | Sort-Object)
    query_suite = $setup.query_suite
    threat_model = $setup.threat_model
    schedule = $setup.schedule
    runner_type = $setup.runner_type
    runner_label = $setup.runner_label
  } | ConvertTo-Json -Compress -Depth 4
}

if ((git status --porcelain)) { throw "Rollback requires a clean worktree" }
if ((git branch --show-current).Trim() -ne "main") { throw "Rollback requires local main" }
git fetch --no-tags origin main
if ($LASTEXITCODE -ne 0) { throw "Could not refresh origin/main for rollback" }
$remoteSha = (git rev-parse origin/main).Trim()
$liveRemoteSha = ((git ls-remote origin refs/heads/main) -split "\s+")[0]
if ($remoteSha -ne $liveRemoteSha) { throw "origin/main does not match the live remote" }

git merge-base --is-ancestor $cutoverSha $remoteSha
$cutoverPublished = $LASTEXITCODE -eq 0
if ($cutoverPublished) {
  $localSha = (git rev-parse HEAD).Trim()
  git merge-base --is-ancestor $localSha $remoteSha
  if ($LASTEXITCODE -ne 0) { throw "Local main has unpublished or divergent commits; renewed rollback authority is required" }
  git merge --ff-only origin/main
  if ($LASTEXITCODE -ne 0) { throw "Local main cannot fast-forward to the rollback base" }
  git diff --quiet $cutoverSha $remoteSha -- .github/workflows/codeql.yml
  if ($LASTEXITCODE -ne 0) { throw "The published CodeQL workflow changed after cutover; renewed rollback authority is required" }
  git revert --no-edit $cutoverSha
  if ($LASTEXITCODE -ne 0) { throw "Could not create the workflow rollback commit" }
  $recoverySha = (git rev-parse HEAD).Trim()
  git push origin main
  if ($LASTEXITCODE -ne 0) { throw "Could not push the workflow rollback; keep default setup disabled" }
  $liveRemoteSha = ((git ls-remote origin refs/heads/main) -split "\s+")[0]
  if ($liveRemoteSha -ne $recoverySha) { throw "origin/main did not reach the workflow rollback commit" }
} else {
  $recoverySha = $remoteSha
  git cat-file -e "$recoverySha`:.github/workflows/codeql.yml" 2>$null
  if ($LASTEXITCODE -eq 0) { throw "An unrecognized CodeQL workflow is published; renewed rollback authority is required" }
}

$restoreStartedAtUtc = (Get-Date).ToUniversalTime()
Write-Output "RESTORE_STARTED_AT_UTC=$($restoreStartedAtUtc.ToString('o'))"
gh api --method PATCH repos/GlitterKill/sdl-mcp/code-scanning/default-setup -f state=configured | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Default-setup restoration request failed" }

$restoreDeadline = (Get-Date).AddMinutes(5)
do {
  $defaultState = (gh api repos/GlitterKill/sdl-mcp/code-scanning/default-setup --jq ".state").Trim()
  if ($LASTEXITCODE -ne 0) { throw "Could not read restored default state" }
  if ($defaultState -eq "configured") { break }
  Start-Sleep -Seconds 5
} while ((Get-Date) -lt $restoreDeadline)
if ($defaultState -ne "configured") { throw "Default setup did not restore within five minutes" }

$restoredSetupJson = gh api repos/GlitterKill/sdl-mcp/code-scanning/default-setup
if ($LASTEXITCODE -ne 0) { throw "Could not verify the restored default setup" }
$restoredSetup = $restoredSetupJson | ConvertFrom-Json
if ((Get-DefaultSetupContract $restoredSetup) -ne (Get-DefaultSetupContract $approvedDefaultSetup)) {
  throw "Restored default-setup contract does not match the approved snapshot"
}
Write-Output "RECOVERY_SHA=$recoverySha"
```

Expected: the remote advanced workflow is absent before default setup is restored; default setup reads `configured` with the approved normalized contract; and the exact recovery SHA and `RESTORE_STARTED_AT_UTC` are recorded. If the workflow changed after cutover or pushing the rollback fails, stop with default setup disabled and request renewed authority.

- [ ] **Step 2: Bind and require a successful recovery scan**

Replace both placeholders with the values from Step 1:

```powershell
$recoverySha = "RECOVERY_SHA"
$restoreStartedAtUtc = [datetimeoffset]::Parse("RESTORE_STARTED_AT_UTC")
$startDeadline = $restoreStartedAtUtc.AddMinutes(5)
$earliestCreatedAt = $restoreStartedAtUtc.AddSeconds(-30)
$recoveryRun = $null
do {
  $runs = gh run list --workflow CodeQL --branch main --event dynamic --commit $recoverySha --limit 10 --json databaseId,headSha,status,conclusion,createdAt,url | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "Could not list recovery runs" }
  $recoveryRun = $runs | Where-Object {
    $_.headSha -eq $recoverySha -and
    [datetimeoffset]$_.createdAt -ge $earliestCreatedAt -and
    [datetimeoffset]$_.createdAt -le $startDeadline
  } | Sort-Object createdAt -Descending | Select-Object -First 1
  if ($recoveryRun) { break }
  Start-Sleep -Seconds 10
} while ([datetimeoffset]::UtcNow -lt $startDeadline)
if (-not $recoveryRun) { throw "No default-setup recovery run started within five minutes" }

$recoveryRunId = $recoveryRun.databaseId
$recoveryRunCreatedAt = [datetimeoffset]$recoveryRun.createdAt
$finishDeadline = $recoveryRunCreatedAt.AddMinutes(20)
do {
  $recoveryRun = gh run view $recoveryRunId --json databaseId,headSha,status,conclusion,updatedAt,url | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "Could not read the recovery run" }
  if ($recoveryRun.status -eq "completed") { break }
  Start-Sleep -Seconds 15
} while ([datetimeoffset]::UtcNow -lt $finishDeadline)
if ($recoveryRun.headSha -ne $recoverySha -or $recoveryRun.status -ne "completed" -or $recoveryRun.conclusion -ne "success") { throw "Default-setup recovery scan did not pass" }
if ([datetimeoffset]$recoveryRun.updatedAt -gt $finishDeadline) { throw "Default-setup recovery scan exceeded the twenty-minute gate" }
Write-Output "DEFAULT_RECOVERY_RUN_ID=$recoveryRunId"
```

Expected: rollback does not end until a successful dynamic default-setup run is bound to the recovery SHA.

### Task 5: Verify the final advanced security state

- [ ] **Step 1: Verify state after coverage passes and stale configurations are deleted**

Require the tool-status page to show the advanced configuration working without the C# low-quality, Go missing-package, or Rust fixture-extraction warnings. Re-run:

```powershell
$cutoverSha = "APPROVED_CUTOVER_SHA"
$defaultState = (gh api repos/GlitterKill/sdl-mcp/code-scanning/default-setup --jq ".state").Trim()
if ($defaultState -ne "not-configured") { throw "Default setup unexpectedly changed state" }
$analyses = gh api "repos/GlitterKill/sdl-mcp/code-scanning/analyses?ref=refs%2Fheads%2Fmain&per_page=100" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Could not read final analyses" }
$advanced = @($analyses | Where-Object { $_.commit_sha -eq $cutoverSha -and $_.analysis_key -eq ".github/workflows/codeql.yml:analyze" })
$latestByCategory = @($advanced | Group-Object category | ForEach-Object { $_.Group | Sort-Object created_at -Descending | Select-Object -First 1 })
$expectedCategories = @("/language:actions", "/language:javascript-typescript", "/language:python", "/language:rust")
if (Compare-Object ($expectedCategories | Sort-Object) @($latestByCategory.category | Sort-Object)) { throw "Final advanced categories do not match" }
if (@($latestByCategory | Where-Object { $_.error -or $_.warning }).Count -ne 0) { throw "Final advanced analysis contains an error or warning" }
git fetch --no-tags origin main
if ($LASTEXITCODE -ne 0) { throw "Could not refresh origin/main" }
$remoteSha = (git rev-parse origin/main).Trim()
$liveRemoteSha = ((git ls-remote origin refs/heads/main) -split "\s+")[0]
if ($remoteSha -ne $liveRemoteSha) { throw "origin/main does not match the live remote" }
git merge-base --is-ancestor $cutoverSha $remoteSha
if ($LASTEXITCODE -ne 0) { throw "The authorized cutover is not in remote main history" }
git diff --quiet $cutoverSha $remoteSha -- .github/workflows/codeql.yml
if ($LASTEXITCODE -ne 0) { throw "The advanced CodeQL workflow changed after verification" }
if ((git status --porcelain)) { throw "Local worktree is not clean" }
git status --short --branch
```

Expected: default setup remains `not-configured`; exactly four latest analyses from `.github/workflows/codeql.yml:analyze` belong to the authorized commit and have empty `error` and `warning`; the authorized workflow remains unchanged in remote `main` even if unrelated commits landed later; the worktree is clean; and the tool-status page shows only the healthy advanced configuration without the three verified warning types.

## References

- GitHub: [Configuring advanced setup](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configuring-advanced-setup-for-code-scanning)
- GitHub: [Workflow configuration options](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options)
- GitHub: [Use the tool status page](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/use-the-tools-status-page-for-code-scanning)
