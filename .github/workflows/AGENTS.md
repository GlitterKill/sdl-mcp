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

### 2026-10-07: OpenSSL candidate provenance must use the FTS artifact fields

The runtime verifier consumed `fts.sha256` and `fts.size`, but the pinned
`ladybug-fts-0.19.0.json` contract names those fields `artifactSha256` and
`artifactSize`. Downloads were checked correctly, but generated provenance
omitted the FTS hash and size. Use the artifact fields in provenance and keep
the generated-package assertions. The 3.5.9-sdl.1 local candidate passed signed
source verification, all 4,283 upstream OpenSSL tests, clean-environment FTS
mutation checks, native DLL-origin checks, and all eight package-contract tests.
It remains unpublished; root dependency and loader pins stay at 3.5.8-sdl.1
until the runtime publication and installed-package adoption gates pass.

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

### 2026-08-28: Stale Artifact and Windows Test-Environment Regressions

Run `33228840410` failed in jobs `99037773532` (`tests (ubuntu-latest, 24.x)`)
and `99037773651` (`tests (windows-latest, 24.x)`), step
`Run tests (including 6 new language adapters + cross-platform paths)`, on
commit `af4783ba77e63e62a4b29a204fc3bb7b67b0e1ff` from `main`. Build,
typecheck, lint, config sync, security audit, native, and benchmark jobs passed.

Confirmed causes and fixes:

- `seed-resolution-evaluation.test.ts` failed on both platforms because commit
  `6a49d8b2` changed `src/retrieval/orchestrator.ts` without regenerating the
  checked source hash. `npm run benchmark:seed-resolution` refreshed the
  deterministic artifact.
- `semantic-pipeline-regressions.test.ts` used LF-only multiline `indexOf`
  needles against a CRLF Windows checkout. Its shared source reader now
  normalizes CRLF and lone CR to LF before structural assertions.
- `mcp-runtime-tool.test.ts` selected hosted Windows PowerShell 5 for one case,
  reintroducing the 30-second hang previously avoided by commit `a4625045`.
  The case now uses `pwsh.exe`; the existing stderr detector strips VT control
  sequences and recognizes PowerShell 7's concise `.ps1:<line>` error record.

The remaining Windows-only lifetime failures were traced with high confidence
to `%TEMP%` using the `RUNNER~1` short-path alias. The production lifetime
validator correctly rejects a requested path whose `realpath` differs, so the
three test helpers now canonicalize each fresh `mkdtemp` directory with
`realpath`. The production security boundary was not relaxed.

Focused local verification passed 213/213 tests across the seven affected test
files. Hosted validation of all four fixes is still pending; no workflow YAML
change was needed.

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

### 2026-09-06: Structural benchmark requested semantic readiness from mock embeddings

Run `34068993668`, job `101582753074`, aborted before threshold evaluation with `SEMANTIC_FINAL_ASSESSMENT_DEGRADED`. The structural lane inherited enabled mock semantics from the shared config. It now derives a temporary runner config with only `semantic.enabled: false`; the shared config, production readiness checks, thresholds, fresh database isolation, and exit-139-only retry remain unchanged. `tests/unit/benchmark-scope.test.ts` executes the workflow config preparation and checks that no other setting changes. Hosted validation remains required.

### 2026-10-08: Windows FTS artifact and version qualification gaps

Confirmed on base `383bbdabdc9e1b0b7ff61bd60cb1507bcbb033b0`: the OpenSSL verifier
checked a downloaded FTS file but its runtime child independently installed a
cache copy without hashing that copy. It also read nonexistent `fts.sha256` and
`fts.size` contract properties when writing provenance. Use `artifactSha256` and
`artifactSize`, and verify the isolated installed file before loading and after
use. Successful compatibility logs now retain the digest and actual DLL origins.

The compatibility workflow derives the runtime package version from the root
optional dependency and tests its agreement with the loader constant. The
release packed-install harness must copy `scripts/ladybug-fts-artifact.mjs` and
`ladybug-openssl/ladybug-fts-0.19.0.json` alongside the fixture. The candidate
staging version can differ from the published consumer version until publication;
do not select an unpublished registry dependency in the ordinary root lockfile.

The locked native installation lacked the fixture's content-parser contract.
The final lockfile inspection found that the Windows platform entry says 0.13.7
but resolves the 0.12.4 tarball; this is not evidence that the actual 0.13.7
registry tarball lacks the API. Building this branch's native addon and setting
`SDL_LADYBUG_WINDOWS_FTS_NATIVE_ADDON_PATH` resolved that preflight failure. This
is why fixed-regression CI and release packed tests must use their branch-built
addon, not treat the registry addon as equivalent evidence.

The local candidate overlay also exposed an install-mode problem:
`npm install --no-save --no-package-lock` ignored the committed graph and changed
135 packages, including `@types/node` 24.12.0 to 24.19.1. The latter caused the
existing `src/observability/service.ts` import of `IntervalHistogram` to fail.
Restore with `npm ci`; do not patch observability as part of the OpenSSL update.
The OpenSSL and compatibility probe install commands retain `--no-save` but no
longer disable reading the lockfile. Local candidate qualification can unpack
the verified dependency-free runtime tarball into its isolated package directory
and restore a byte-for-byte backup afterward, leaving other resolutions intact.

The generated `sbom.spdx.json` previously contained tag-value text without
required creation/package-verification metadata. It now contains SPDX 2.3 JSON,
actual file SHA-256 checksums, relationships, creation metadata, a package
verification code excluding the SBOM itself, and the package's declared license.
The focused contract checks these against the shipped files; the final local
artifact also passed the official SPDX 2.3 JSON schema using existing Ajv.

The Oct 8 local aggregate run passed 764 of 772 files with both 3.5.8 and 3.5.9.
The same eight failures reproduced from unmodified 383bbda: context-overlay
evidence, determinism, agent-editing ergonomics, context response artifacts,
structural search/edit, stale seed evaluation, terminal colors, and symbol-node
resolution. Treat these and the existing npm audit findings as unresolved release
gates. The base lockfile also labels Windows native 0.13.7 while resolving 0.12.4,
and labels two Watchman entries 0.13.7 while resolving 0.11.8. These pre-existing
lock inconsistencies were documented without unrelated dependency edits.

### 2026-10-10: Baseline test repair and release-coupled lock metadata

Confirmed locally on the isolated 383bbda-based branch: all eight previously
failing files reproduced. Context card consolidation, workflow error envelopes,
top-level response continuations and the file-write discovery example had changed
without corresponding fixture updates. Tests now assert current public contracts
while retaining exact IDs, signature equality, error codes, recovery arguments,
schema validity and LF/CRLF behavior. The workflow projector also removes the
duplicate nested nextCalls when a validated step nextAction exists.

The terminal failure came from inherited NO_COLOR=1; the test now restores its
environment after checking both modes. The seed-evaluation artifact had one stale
source hash (context/engine.ts), and regeneration preserved quality floors. Two
Kotlin tests failed before their assertions because the bundled native grammar
was missing. A scripts-enabled clean install restored the grammar; no Kotlin
test was skipped or altered. All eight targeted files now pass.

The version-sync script rewrote installed-package version fields while retaining
old resolved URLs/integrities. Ten entries were affected: all seven native and
three Watchman package entries. Verified npm 0.13.7 metadata and downloaded
tarball SHA-512/manifest checks corrected these fields. The sync script now only
updates the root dependency requirements in the lockfile, leaving npm to resolve
new published artifacts. Its new regression test proves resolved records remain
intact. A clean install matched all 478 installed package versions.

After correcting the lockfile, the genuine registry native 0.13.7 still lacks
parseContent/parserIdentityContractVersion, although it has the Windows loader.
This is a newly verified fact and supersedes the earlier lack of evidence about
the real 0.13.7 artifact. Retain the required native preflight. The existing
branch-built addon has contract 1; publication of a new release-coupled native
version and hosted validation remain separate gates. Do not republish 0.13.7.

Follow-up verification completed: 773/773 aggregate files passed with each
OpenSSL runtime (3.5.8 and 3.5.9), with zero segfault-on-exit classifications.
Required FTS checks passed using the branch-built addon for both runtimes.
The registry-native preflight still fails the missing parser contract. Golden
validation and a fresh packed candidate install passed; that install uses local
native tarballs. Missing-runtime, mutation/patchSavedFile, two reopen processes,
parser verification and native-disabled MCP startup passed. Root/installed/
compiled runtime selection was restored to 3.5.8. Hosted and registry-native
release gates remain; nothing was published.

### 2026-10-10: Native parser API omission was in the umbrella wrapper

Direct inspection of registry sdl-mcp-native-win32-x64-msvc@0.13.7 confirms
parseContent, parseFilesAsync and parserIdentityContractVersion exist and the
identity contract is 1. The public sdl-mcp-native@0.13.7 wrapper omitted them.
This corrects any interpretation of the earlier preflight as missing binary
implementation. native/index.js now forwards all three APIs; Rust is unchanged.

Raw-addon overrides/local fallback let prior native and packed FTS checks bypass
the wrapper. Release packed verification now checks the installed umbrella API,
binary origin, matching package versions and content/disk/async parity before
FTS, with no addon override. publish-native independently qualifies its packed
Linux x64 GNU pair on its matching Ubuntu x64 publish runner before publishing.
Do not move raw target execution into cross-compilation matrix jobs.

Fresh local Windows 0.13.8-rc.1 native tarballs passed the normal installed SDL
parser and FTS paths without overrides, plus two reopens. The source manifests
and lock retain published versions; only disposable staging manifests adopt
the prerelease. All 774 aggregate files passed, as did the focused native tests.
Hosted/platform/registry gates remain. Do not republish 0.13.7 or infer registry
success from local tarball qualification.

### 2026-10-11: Maintenance dependency remediation and native platform gates

The refreshed root audit reported 13 findings and the earlier packed consumer
reported 10 (the previous 12-count snapshot is historical). Scoped upgrades of
MCP SDK within 1.x, ONNX within 1.x, five existing overrides, and proxy-addr's
compatible lock resolution clear both audits. ONNX 1.30 removes the vulnerable
global-agent/roarr/sprintf-js chain. A scripts-enabled clean install, grammar
verification, typecheck, and 775/775 aggregate files passed with zero exit-crash
classifications; a real CPU Identity inference also passed on ONNX 1.30.

Native publication previously built six targets but executed only Linux GNU.
The native-only workflow now qualifies each supported target on a matching host,
using Alpine for musl, and publishes the exact qualified tarballs. Shared wrapper
text is normalized to LF so Windows/POSIX packages can be compared byte-for-byte.
An explicit native-only version input changes staging, not root SDL/Watchman
manifests. Registry consumers verify parser APIs, identity, exact binary hashes,
and npm signatures/attestations after publication. The new workflow regression
checks pass locally. Hosted runs remain separate evidence; do not infer success
or publication from local checks. OpenSSL dry run 38162784659 started from
61fe9f288317ef6894e5026185d28a7113f64c23. No main merge or SDL release is implied.

### 2026-10-11: Native publisher provenance permission approved

The user explicitly approved id-token: write on publish-native.yml's publish
job only. That job now grants contents: read and id-token: write; contents read
preserves its previous checkout access when job permissions replace the inherited
map. Workflow-wide contents: read and all other jobs remain unchanged. This does
not change credentials, token scopes, or authorize publication before the musl
qualification and remaining hosted release gates pass.

### 2026-10-11: musl target linked against host glibc

Run `38163622459` built Rust for `x86_64-unknown-linux-musl` on Ubuntu,
but its build log reports `zig: not found`. The installed napi CLI disables
`crt-static` for shared musl addons and falls back to the normal linker when
Zig is unavailable. Installing `musl-tools` alone did not configure Cargo's
final linker. The downloaded musl ELF directly needs `libc.so.6`,
`ld-linux-x86-64.so.2`, and GLIBC symbol versions through 2.34. This is a
build/linkage defect already present before packing, not a wrapper export bug.
The musl SHA-256 is `a095f6405660ae864a1db03e0882e7a0e39bad98574554f6b8b8ef72050ca46d`;
the separate GNU artifact is `e248d5b93af7c102cd7f7fbaab9c2a241732f1ef80b72aa7705d9ed989c3ea07`.

The musl build now runs in `rust:alpine` with Alpine's Rust/C/C++ linker
and a separate Cargo target directory. `verify-musl-elf.mjs` checks ELF64,
x86-64 shared-object identity, musl libc, an explicit runtime dependency list,
and absence of glibc versions, executable interpreters and RPATH/RUNPATH.
It runs before upload and again on the selected binding before packaging.
Qualification installs fresh umbrella/platform tarballs into a clean Alpine
consumer using npm, checks the normal wrapper API and content/disk/async
parity, and compares the installed platform name and binary hash to its input.
The contract artifact records ELF dependencies and tarball SHA-256 hashes.
Do not add a glibc shim or weaken qualification to handle this failure.

Focused checks:

```sh
node --experimental-strip-types --test tests/unit/native-musl-elf.test.ts tests/unit/native-platform-qualification.test.ts tests/unit/native-package-exports.test.ts tests/unit/release-publish-lockfile.test.ts
node scripts/verify-musl-elf.mjs /path/to/sdl-mcp-native.node
```

Hosted qualification must run with `dry_run=true`; publication and registry
verification are separate release operations. See the musl qualification
report in `devdocs/` for exact tested commit, run and artifact evidence.

Hosted follow-up: commit `063bafb2d40a963b890492f625a9ad2ad08c82c5`, run
`38165460944`, passed all six builds, all six fresh packed consumers and 22
focused regression tests. Independently extracted musl package ELF requires
only `libgcc_s.so.1` and `libc.musl-x86_64.so.1`. The overall dry run failed
later in unchanged `Validate exact qualified tarballs`: `info.name` was
undefined when parsing npm dry-run JSON. The actual JSON was not retained,
and local npm 11.9.0 does not reproduce it; inspect hosted output before
assuming its shape. This remaining release gate is outside the musl patch.
No publication occurred. Exact hashes, commands and limits are in
`devdocs/alpine-musl-qualification-2026-10-11.md`.

### 2026-10-11: Realism semantics and canonical probe family isolation

Maintenance run `38163624167`, job `114541518992`, and baseline run
`38146269523` failed the realism matrix with
`SEMANTIC_FINAL_ASSESSMENT_DEGRADED`, then `SafeRebuildRequiredError`.
The shared config uses mock embeddings, which are deliberately not persisted
as healthy model vectors. The realism job now verifies immutable local models
and selects the local provider with semantics enabled. The benchmark activates
its explicit CLI config for nested no-argument config reads. A failed repository
blocks its dependent matrix runs, preserves the failed DB, and still makes the
matrix exit nonzero; independent repositories continue. No quality floor changed.

The baseline context-quality jobs failed strict close because canonical probe
JSON files used the database filename as a prefix. Family guards correctly
treated them as unexpected database members. The canonical clone now lives in
its own directory and probe filenames do not start with its database filename.
The regression test reproduced the old collision and exercises all three probes
with the actual family inventory function. Fresh-process and no-op re-index
determinism comparisons remain enabled. Local build, script typecheck, changed
test lint and 57 focused tests passed. Hosted verification: `38166992257` on
`56164c462dfcc743880a77ef4077ffb7977335a0` (pending at this entry).

### 2026-10-11: npm 11.19 dry-run result shape

Native run `38165460944`, Publish job `114548420020`, passed all six target
qualifications but failed `Validate exact qualified tarballs` at `info.name`.
The job used npm 11.19.0. Reproducing its exact command with that npm version
and the qualified umbrella tarball confirms an object keyed by package name;
npm 11.9.0 returns the metadata object directly. Validation accepts only the
single expected key when wrapped, checks the same exact name/version/SHA-512,
and writes normalized metadata for the later registry checks. Regression tests
exercise both observed formats and reject wrong names, versions, integrity and
extra package results. This is release assembly only; musl build and ELF checks,
publication permissions and registry attestations are unchanged.

Hosted follow-up: native dry run `38167249461` on
`45193a6b54599dd121336717688c3f0fd08dbe01` passed all six builds, all six
packed-consumer qualifications, and exact release-tarball validation/assembly.
The local npm 11.19.0 reproduction also passed the repaired SHA-512 validator
against the actual qualified `sdl-mcp-native@0.13.8` umbrella tarball. All 23
focused packaging tests passed. Publication and registry checks were skipped.

### 2026-10-11: Frozen corpus predates a required contract regression

Original maintenance run `38163624167`, Ubuntu context-quality job
`114541518674`, failed paired evaluation with two independent errors: the
canonical probe family collision described above, and the exact `sdl.info`
contract-title assertion at `context-quality.test.ts:2856` (empty actual set).
The corpus is pinned to `fcf4f2e11c5a1bb9b301a245af42b28556414b8e` (July 26).
`git show <corpus>:tests/unit/code-mode-tool-validation.test.ts` confirms it
contains the discoverability case but not
`rejects info and sdl.info as sdl.workflow actions`. That case first appears in
`3aff7a6af7de8cd4b45e406b5394d97b7f75bef7` (July 28); the exact-title benchmark
assertion was added in `3cfa4a6eab9e53cb02af263a68b3132b81678d70` (July 29).
The existing immutable corpus therefore cannot satisfy the full assertion.

This fixture mismatch is confirmed, not a reason to lower retrieval thresholds,
synthesize missing evidence, skip the contract test, or silently repin/rebaseline
the frozen corpus. A separate versioned contract corpus or an explicit corpus
and baseline update is needed. That decision remains open. The repaired CI run
`38166992257` is still pending semantic jobs; its two OS test jobs, six native
build jobs, structural benchmark and both background-integrity benchmarks have
passed. No publication or main merge has occurred.

At 20:06 UTC, repaired Windows job `114551502940` is terminal-failed (19:55:10
UTC): 29 tests pass, one exact-contract-title assertion fails, and the previous
strict-close/family-member failure is absent. Full cross-process/no-op-index
determinism remains blocked by that first probe's contract assertion. Original
run `38163624167` is terminal-failed on both context-quality jobs and the matrix;
its 11 other runnable jobs passed. Repaired run `38166992257` has 11 successes,
one failure, two skipped sync jobs, and two still running: Ubuntu graph build
since 19:12:54 UTC and realism matrix since 19:14:19 UTC. Both running-job log
endpoints return HTTP 404; internal progress or a stall is not established.
Publication remains gated on the unresolved corpus decision and hosted results.

### 2026-10-11: Separate versioned contract corpus and qualified test retrieval

The user selected a separate versioned corpus; repository policy has no additional
owner-approval requirement. `tests/fixtures/info-contract/v1` pins the complete
12-case source file from `3aff7a6a` with a normalized SHA-256 manifest and two
indexed retrieval distractors. Both scheduled context-quality OS jobs now run
`tests/benchmark/info-contract.test.ts` after provisioning real FTS/local models.
The frozen `fcf4f2e` corpus, benchmark baseline, configs and thresholds are unchanged.

The isolated fixture exposed two additional causes hidden behind the old corpus
mismatch: V2 hot-path test metadata lives under `content.card`, and fused retrieval
ranked an unrelated gateway case ahead of the requested qualified test titles.
The scoped ranking fix promotes matching qualified test titles only for queries
explicitly asking for tests, preserving pins, stable ties and directory focus.
The relocated assertion reads both card shapes and checks omitted requested
symbol IDs, rather than treating unrelated cases in the same file as omissions.
It retains both exact titles, both assertion excerpts, repeated-response equality,
indexed distractor exclusion and the 2,400-token ceiling, and additionally requires
available FTS/vector lanes with full vector coverage.

Local regression: the unmodified ranking failed on this complete fixture; the
repair passes with real Windows FTS and local embeddings (no skips). All 109
focused context/retrieval/CI tests, `build:all`, changed-file ESLint and diff checks
passed. Initial sandbox attempts failed Windows checkpoint renames; verification
used the authorized unsandboxed isolated test. General determinism fixtures remain
unchanged because their native-disabled setup does not provision Windows FTS.

Independent review confirmed fixture source/hash equality and found one runner
wiring issue: `scripts/run-tests.mjs` discovers all benchmark test files while
forcing native addons off. The new real-model contract is now excluded there,
alongside `context-quality.test.ts`, and remains mandatory in both scheduled OS
jobs. A regression executes the actual discovery/filter code and checks the
mandatory workflow invocation; it failed before the exclusion and passes after
(14 CI tests pass). Hosted Ubuntu on `50abd2bf` already passed the explicit
contract step. The runner-only follow-up requires a new ordinary test run.

### 2026-10-11: Hosted PID-file race and targeted follow-up verification

Full CI `38172249874` at `76830281` passed the versioned contract check on both
OSes, all six native builds, structural benchmarks and both background-integrity
benchmarks. Ubuntu's ordinary suite passed 775/776 files; only
`pidfile.test.ts` failed because both concurrent claimants returned success.
The exclusive file create can expose an empty entry before JSON is written;
the previous EEXIST path treated an unreadable competing claim as stale and
overwrote it. The fix rejects unreadable competing claims. Valid dead-PID and
same-PID replacement remain supported. Permanently malformed orphan files now
need confirmed-owner-free cleanup, which the error explains.

A deterministic empty-file regression failed before the fix; all 36 focused
PID/CI-scope tests pass after it, including the original two-process race.
Build and lint passed (the existing unused `mkdirSync` warning is unchanged).
Independent review found no blocker. The older Ubuntu semantic job
`114551502932` is terminal-failed solely on the old contract assertion: 29 pass,
one fail, four intentional mode skips; the family-close error is absent.

Manual CI dispatch now defaults to `verification_scope: full`. Explicit `fast`
dispatch omits only the long context-quality and realism jobs so a PID-only
follow-up can rerun affected ordinary/native/structural/background checks while
the separately tracked semantic runs continue. Schedules always include those
jobs; push/PR behavior and every quality threshold are unchanged. Truth-table
regressions cover scheduled, full/default/fast manual, push and PR conditions.
Fast success alone is not evidence that semantic release gates passed.

### 2026-10-11: Canonical reindex validation requires a fresh copy capability

Ubuntu context job `114567117410` in run `38172249874` passed the versioned
contract and both initial canonical probes (29 pass, zero failures, four
intentional mode skips per probe), then completed the no-op index. Its next
validation called `validateCopiedFamily(path)` without the required opaque
copy capability and failed before paired quality evaluation. The validator
correctly rejected this; database lineage checks must not be relaxed.

The runner now creates a verified `reindexed.lbug` copy of the closed reindexed
family, validates it with its newly issued single-use capability, and probes
that validated copy. All three canonical comparisons and immutable source/cache
fingerprint checks remain. The regression uses actual copy issuance/consumption,
reproduces the hosted error before the fix, and passes after it (14 harness
tests). Independent review found no blocker. Windows sandbox `realpath` blocks
the real identity checks; the isolated local regression passed unsandboxed.

Manual `context-quality` scope runs ordinary checks plus both context-quality
jobs, omitting only the separately tracked nightly realism matrix. Default/full
dispatch and schedules still include every semantic gate. Scope truth tables
cover the new option; its success cannot replace a terminal realism result.

### 2026-10-11: Realism execution restored; claim audit remains below its floor

Nightly matrix jobs `114551502994` (`38166992257`, `56164c46`) and
`114567117143` (`38172249874`, `76830281`) completed all 50 tasks successfully
without the original semantic-final-assessment/rebuild failure. Their overall
average token reductions were 60.0% and 60.2%, with median 61.9% in both.
However, the existing non-blocking claims audit failed: tiny-task median was
46.8% and 48.2%, respectively, below the unchanged 50% floor. The audit was
already non-blocking at `8bea6b1`; green job status must not be represented as
proof that this quality claim passed. No claim floor or audit policy was changed.

### 2026-10-11: Isolated QA transport could terminate a Windows checkpoint

Run `38173913684` passed all ordinary/native/benchmark jobs except Windows's
ordinary suite: `isolated-mutating-qa.test.ts` retained checkpoint apply/intent
locks, the family lock, shadow and WAL checkpoint files after `client.close()`.
The PID-file tests passed. The installed SDK's stdio close ends stdin, waits
only two seconds, then sends SIGTERM (forceful on Windows), while SDL allows
60 seconds for graceful database cleanup. A 2.5-second delayed-child regression
fails with that transport because its cleanup receipt is never written.

The QA-only transport now waits for SDL's existing 60-second graceful deadline
before SDK escalation, then bounds the final close-event wait to five seconds.
It rejects timeouts and nonzero exits, and retains the existing strict sidecar
assertion and failure-fixture preservation. The SDK has no public close-timeout
option, so this adapter explicitly documents its `_process` dependency; real
child regressions guard it. Tests also cover absent close events, both forced
termination signals and nonzero exit. All 20 focused unit/integration tests
passed locally without skips; lint and syntax checks passed. Independent review
caught the initially unbounded final wait and confirmed its correction.

### 2026-10-11: Ordinary checks green; canonical repair exposes V2 quality failures

All 11 applicable ordinary/native/structural/background jobs in
`38176282327` passed on `49efd660d391488d2b2abda43b901e3e0c0c1c2c`.
Its explicit fast scope omitted the separately tracked semantic jobs.

Ubuntu context job `114575236015` in `38174940287` on `dc2df094` passed
the versioned contract and all three canonical probes, including the verified
post-reindex copy. Each probe reported 29 pass, zero failures and four intended
mode skips. The full quality evaluation then failed three unchanged assertions:

- The broad server-instructions hard floor omitted code-bearing `MCPServer`
  evidence.
- Scoped precise p95 was 3,502 ms against the 250 ms limit.
- Scoped tool-QA returned some `scripts/` and `src/` evidence outside `tests/`.

The full evaluation reported 28 passing tests, three failures and two intended
mode skips; overall semantic recall was 93/137 (67.9%). These are quality
failures reached after the harness repair, not another copy-capability error.
The origin of the missing code rung and latency cost is not yet established.
Directory focus currently has explicit soft-priority semantics in
`ContextCandidateSearchOptions` and stable-partition unit tests retaining the
remainder. Making it a hard boundary is a retrieval contract decision, not a
safe harness-only correction. No threshold or evidence assertion was relaxed.

Artifact `context-quality-ubuntu-latest` (11717252157) contains the failed child
stdout/stderr; the runner removes its pending structured result on child failure.
The completed job log is the authoritative evidence for the assertions above.
Windows context verification was still active when this finding was recorded.

Final result: Windows context job `114575235965` completed at 22:34 UTC with
the same three quality failures: missing code-bearing `MCPServer` evidence,
scoped precise p95 6,978 ms against 250 ms, and paths outside `tests/`.
Its versioned contract and all three canonical probes passed; the full suite
reported 28 pass, three failures and two intended mode skips. It completed
without a child timeout. Run `38174940287` is terminal-failed only in the two
context-quality jobs; all 11 ordinary/native/structural/background jobs passed.
Both OS jobs stop after the SDL corpus failure, so neutral-corpus quality
evaluation remains unverified despite successful construction of its graph.

All dispatched maintenance runs are now terminal. Implementation is verified
by the green ordinary run `38176282327`, passing six-platform packed-consumer
native qualification `38167249461`, both completed realism matrices, and the
repaired contract/canonical stages on both OSes. This is not an all-quality-gates
pass: the V2 assertions and tiny-task claims audit above remain unresolved.
No semantic threshold was weakened; publication/registry verification remains
pending, and no main merge or final SDL release was performed.

### 2026-10-28 — maintenance verification after later main changes

Maintenance run `40711214503` at `059ebb54` passed all six native builds,
the structural benchmark, and the 50-task realism matrix. The matrix's
claims audit also passed (overall average 60.2%, median 61.9%). Ubuntu's
background-integrity benchmark passed; Windows measured background p95
4,130.7 ms against the unchanged 4,000 ms limit. The other Windows background
checks passed. Its timing failure remains a gate, not a waived result.

Both ordinary test jobs exposed an isolated-QA fixture that omitted the now
default-enabled gateway setting, plus a stale seed-evaluation source hash.
The fixture explicitly selects the flat tool surface, and the generated seed
artifact was refreshed with unchanged rankings and recall. Windows additionally
timed out while downloading the pinned FTS extension inside the native seed
child. The fixture now stages and verifies the same extension in the parent;
native child timeouts and runtime assertions are unchanged. Its focused
Windows suite passed all 16 tests locally.

Ubuntu context quality reached its semantic assertions and failed missing
MCPServer code evidence, scoped precise latency (3,026 ms versus 250 ms), and
outside-directory evidence. Local frozen-corpus reproduction identified
duplicated card/code identity costs in admission and final budget enforcement.
Pricing the consolidated wire payload and actual metadata-derived card content
restores broad MCPServer code and focused MCPServer card evidence within the
original 1,800-token budget. Database aggregation and bounded per-file fallback
batching remove measured row-transfer and round-trip costs without changing
ranking. These improvements do not establish a latency-gate pass.

Verified graph families are now saved immediately after both publish/validation
steps, before quality evaluation. Previously a quality failure prevented the
cache action's success-only post-save and forced expensive graph reconstruction
on the next run. Restore validation and all semantic failure behavior remain
unchanged. The cache ordering regression test passes.

Directory focus still has its existing soft-priority behavior. The strict
directory benchmark conflicts with that contract; a contract decision remains
pending. Do not relax its assertion or report all quality gates as passed.
At this checkpoint the Windows context job is still constructing graph families;
follow-up hosted results must be recorded separately.

The complete local paired V2 gate subsequently passed: 8/8 required symbols,
zero explicit noise tokens, and control p95 3,952.7 ms within the unchanged
1.25x committed-baseline bound (baseline p95 5,730.1 ms). The same run still
failed absolute scoped p95 (4,427 ms versus 250 ms) and directory-only evidence.
This is not an overall context-quality pass.

Run `40721523981` at `1edf628b` passed both background-integrity jobs without
threshold changes, all six native builds, structural benchmarks, and Ubuntu
ordinary tests. Its two context jobs failed earlier in the versioned sdl.info
contract: the corrected token pricing allowed an unrelated third test case.
Explicit qualified test-discovery requests now select matching test cases when
available, retaining pins and the no-match fallback. Explanatory requests and
directory-focus semantics are unchanged. The unchanged real-model sdl.info
contract passes locally, as do 105 focused regression tests and type checking.

Independent neutral-corpus verification exposed a hardcoded SDL canonical
probe case in the runner and benchmark. Probe selection now uses a case from
the requested corpus. The neutral run passed all three canonical probes,
100% recall, zero noise, paired V2 gates, and scoped p95 117 ms; its full suite
reported 29 passes, zero failures, and four intended corpus/mode skips.
The CI evaluation step now runs both corpora and exits nonzero if either
fails, so a failing SDL gate no longer prevents neutral verification.
