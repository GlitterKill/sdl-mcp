# Index preflight — 2026-09-07

Status: **Both Moshi tasks and verifiers pass in the 2026-09-09 rerun, with usable fresh SCIP and zero generator, coverage, fallback, or incomplete-call-proof failures.** Earlier runs below remain historical evidence.

## Corrections

| Check | Correction | Verification boundary |
| --- | --- | --- |
| Fixture source and test coverage | Configuration accepts explicit `mjs`, `cjs`, `mts`, and `cts` selectors, with scanner, parser, native-extension, and provider routing. Existing `js` and `ts` selectors retain their exact extension scope. SDLBench selects module extensions for JavaScript/TypeScript repositories. | The actual scanner admits all 13 tracked fixture source/test files: seven `.js` files and six `.mjs` files, including all four task verifiers. Fresh disposable indexing processed all 13 files and produced 37 symbols and 13 edges; provider file coverage passed, with partial reference coverage explicitly reported. |
| Moshi Java/Kotlin launcher | The scrubbed Windows child environment now sets `OS=Windows_NT`. Without it, `scip-java.bat` takes its legacy argument loop; `SHIFT` changes `%0`, so the final output argument becomes the jar basename. | The installed launcher's `--help` fails without `OS` and succeeds when that one variable is added. The runner regression preserves launcher identity. Fresh Moshi generation now reaches Gradle, confirming the launcher correction. It fails on the generated initialization script's Windows jar path; see the live result below. |
| Semantic mode | Generated configs explicitly retain local embeddings and mock summaries. Records label `local-embeddings/mock-summaries` in `artifacts.sdl.preflight.semanticMode`. | This is a mock-summary comparison mode, not a real-summary/full-feature claim. Mock summaries do not mean mocked embeddings. |
| Runtime limit | Records retain the effective `runtime.maxDurationMs` alongside the mode. The generated default remains 30,000 ms. | Agents must respect the server limit; omitting `timeoutMs` uses its default. |
| Readiness before agent execution | The harness reads the server's effective configuration, requires its root to match the copied agent worktree, scans with SDL's schema/scanner, and checks required files. After indexing, it requires successful provider execution, matching scan counts, no uncovered/full-fallback files, no SCIP failures, and no reported summary failures. | HTTP success alone no longer passes. Failed index responses are retained in error records, and the agent does not start. Count checks do not prove the quality or completeness of every symbol or edge. |

The initial audit counted the four task-verifier `.mjs` files but did not inventory the tracked root-level `math.mjs` and `test.mjs` fixtures. Both were also excluded and are now covered. Historical records remain unchanged.

## Harness contract

`config/repos.lock.json` supports repository-relative `expectedIndexFiles`. The fixture entry lists its 13 required source/test files. Missing, ignored, oversized, or language-excluded required files fail setup before indexing. The scanner inventory and effective semantic/runtime labels are recorded under `artifacts.sdl.preflight`; provider failures remain under `artifacts.sdl.index`.

Both temporary and externally supplied HTTP servers must expose a valid `GET /api/config` snapshot with the exact agent worktree root. Missing or mismatched configuration fails before the reindex request. The harness does not silently repoint an external server.

The empty/unrecognized-language fallback still uses the example configuration's default languages; it does not mean every supported extension. Expected-file assertions catch omissions in repositories that declare them. Other repositories require an explicit coverage inventory before making completeness claims.

## Verification

Run from the repository root after building runtime output:

```sh
npm run build:runtime
node --test sdlbench/tests/*.test.mjs
node --experimental-strip-types --test tests/unit/module-extension-config.test.ts tests/unit/language-support.test.ts tests/unit/scip-io-runner.test.ts
```

Verified: all 95 harness tests and 37 module/SCIP tests passed; TypeScript and scoped ESLint passed. The offline checks exercise actual configuration parsing/scanning, module routing, the Windows launcher environment, and rejection before agent execution. HTTP test servers return controlled configuration/index evidence; they do not build indexes or run paid agents.

## Disposable index validation

Run on 2026-09-07 at 20:24–20:27 UTC with a freshly rebuilt local runtime. Each source was copied to a new temporary directory and indexed into its own new database. Moshi's source checkout was clean at commit `889013ec2edb8d8034902662a1dc8c4f3b3f8111`.

| Repository | Result | Evidence |
| --- | --- | --- |
| Fixture | Passed the configured readiness gates | 13 files processed/provider-covered, 37 symbols, 13 edges, no uncovered or full-fallback files, no SCIP failures. All 37 mock summaries generated without failure; local embedding progress reached 37/37. Request-to-completion elapsed time was 2.4 seconds. |
| Moshi | Failed the readiness gates | 156 files admitted. Both Java and Kotlin SCIP generation failed; no generated SCIP index was available and provider-first status was `fallback`. The fallback graph is not successful provider evidence. Request-to-completion elapsed time was 175.6 seconds. |

Fixture reference coverage remains partial for all 13 files (`fullyCoveredFiles:0`, `partialFiles:13`, `callProofIncompleteFiles:0`). Passing these gates proves file admission and successful provider execution, not complete symbol/reference precision. Both runs used local embeddings and mock summaries. Values labeled cost by the mock summary provider are not measured billing expense.

The Moshi failure is now inside the generated Gradle initialization script, line 3:

```text
Could not compile initialization script .../init-script.gradle
Unexpected character: '"' @ line 3, column 26.
classpath(files("C:\Users\...\gradle-plugin.jar"))
```

The captured script line contains a Windows path inside a Groovy string. The generator's path serialization is the next investigation target; it has not been repaired or verified by this run. The earlier `Unable to access jarfile .../java` failure did not recur.

Raw index responses, scanner inventories, timestamps, and log locations are retained locally in `.work/disposable-index-validation.json`. The temporary root is recorded there. Both owned HTTP servers were stopped; a process check found no remaining command lines referencing that temporary root. No agent benchmark ran and historical benchmark records were left unchanged.

## Before another benchmark

Correct the `scip-java` Gradle initialization-script path handling and rerun disposable Moshi indexing. Require a passing provider result before including Moshi in a counterbalanced comparison. The fixture is ready for its configured mock-summary mode, subject to the reference-coverage limit above.

Implementation: `src/sdlbench.mjs` configuration/readiness helpers; repository-root `src/config/types.ts`, `src/indexer/fileScanner.ts`, `src/indexer/language-support.ts`, `src/indexer/rustIndexer.ts`, and `src/scip/scip-io-runner.ts`. The original evidence is experiment `codex-20260907T150307Z`; the local launcher reproduction is `.work/scip-launcher-diagnostic.mjs`.

## Patched-artifact integration rerun — September 7 evening / September 8 UTC

The local profile now routes the normal SDLBench server through a staged patched scip-io executable, the source-built scip-java pack, and the distinct `0.5.1-kotlin-2.3.21-SNAPSHOT` SemanticDB coordinate. Artifact hashes are retained in `.work/products/moshi-kotlin-2.3.21/artifacts.json`; the Kotlin JAR SHA-256 is `94ae99ffbb72cf9a6436839db564573faf153a200608e630cfc43465d3304929`. No installed release JAR was substituted. Repeat with `node sdlbench/scripts/rerun-moshi-jvm.mjs` from the repository root; staging instructions are in the README.

The first integration runs exposed concurrent Gradle builds: Java and Kotlin both invoked `clean` in the same copied root. Gradle daemon logs `daemon-30380.out.log` and `daemon-33272.out.log` show overlapping builds; KSP failed with `NoSuchFileException` for its generated `META-INF` directory. The profile now passes scip-io's existing `--parallel 1` option. This serializes both requested generators; neither is skipped and failures remain fatal to readiness.

| Verification | Result |
| --- | --- |
| SDL generator orchestration | Direct `runScipIoBeforeIndex` on the benchmark's disposable Moshi worktree returned `attempted:true`, `ok:true`, `failures:[]`, `cache.status:disabled`. Both Java and Kotlin invocations succeeded, then merged. Duration: 80,942 ms. Full result: `.work/products/moshi-kotlin-2.3.21/generator-verification.json`. This isolates generation from the subsequent native indexing crash. |
| SCIP content | Java, Kotlin, and merged outputs from the sequential benchmark copies passed protobuf/source validation. Each contains 218 documents (57 Java, 161 Kotlin), 13,496 symbols, 79,704 occurrences, 13,619 definitions, 66,085 references, and 14,590 resolved cross-file reference occurrences. Paths are unique, relative, and present; occurrence ranges obey source UTF-16 bounds. |
| Actual two-task behavior rerun | Experiment `moshi-jvm-2026-09-08T00-05-48-941Z` used the staged profile and clean pinned source. Both copied roots produced fresh SCIP. The SDL server exited before readiness completed; the first recorded exit was `3221225477` (`0xC0000005`). Both task records are errors with no agent execution. This is **not a passing benchmark**. |
| Harness regression | 97 harness tests passed, including generator binary/arguments reaching the server configuration and refusal to overwrite an existing copied `.scip-io.toml`. Runtime build passed. |

Validated task roots are recorded in the experiment JSONL. The second diagnostic task root ends in `4f309513-4be2-4ab6-83dd-83992192a715-moshi-add-version-constant-sdl`; its `java.scip`, `kotlin.scip`, and `index.scip` all passed. The direct generator report uses the prior sequential task root ending in `0c8a2175-f491-4d64-8891-a5f311b8d8a1-moshi-json-data-exception-tostring-sdl`.

Validation command, using the existing standalone validator and source-built pack:

```powershell
java -cp "$env:TEMP/semanticdb-kotlinc-windows-fix/.verification;$env:TEMP/scip-java-windows-fix/scip-java/target/pack/lib/*" ValidateScip $taskRoot "$taskRoot/java.scip" "$taskRoot/kotlin.scip" "$taskRoot/index.scip"
```

At this stage, the remaining blocker was the SDL native access violation after generation and pass 2. The harness retains server logs and the original child exit code. The diagnosis and correction are recorded below; readiness gates and historical failed experiments remain unchanged.

## SDL native crash diagnosis — September 8 UTC

The crash is downstream of SCIP generation, in the installed LadybugDB 0.19.0 native module (`kuzu/lbugjs.node`). Microsoft DebugEng captured a second-chance access violation (`0xC0000005`) during a native node-table scan. Query tracing identifies `getFilesByRepoLite` as the unfinished operation: it reads file IDs, relative paths, and content hashes through `FILE_IN_REPO`. Exported symbols locate the failing module and scan path; without matching PDBs they do not establish the exact faulty C++ instruction.

A fresh-database, ingest-only CLI run reproduces the same crash in approximately seven seconds using the already validated Moshi SCIP input. This diagnostic isolates ingestion and is not fresh-generation benchmark evidence. SQL-only replays, including captured COPY data and connection assignments, pass; reopened databases also read successfully. Serializing metrics before file-summary materialization removes the crash. More narrowly, excluding readers for the file-summary COPY transaction also removes it while retaining concurrent indexing phases.

`src/db/ladybug-file-summaries.ts` now uses the existing exclusive operation gate around the complete new-summary COPY transaction, including `BEGIN`, both ownership relations, and `COMMIT`. The previous shared admission allowed this bulk import to overlap native readers. The change drains admitted readers and prevents new reads until the transaction settles. It does not change generator selection, SCIP caching, or readiness requirements.

The write-batching regression checks exclusive admission at all five transaction boundaries. It fails with the previous shared behavior; all 49 write-batching and operation-gate tests pass with the fix. The runtime build and a fresh ingest-only run without diagnostic instrumentation also pass.

```powershell
npm run build:runtime
node --experimental-strip-types --test tests/unit/ladybug-write-batching.test.ts tests/unit/ladybug-operation-gate.test.ts
node --experimental-strip-types --test tests/unit/http-reindex-progress.test.ts tests/unit/http-rest-readiness.test.ts
node sdlbench/scripts/rerun-moshi-jvm.mjs
```

Local native evidence is retained under `%TEMP%/sdl-native-debug`: `native-stack.log`, `queries-ingest.jsonl`, and `ingest-only-config.json`. Temporary query tracing and the diagnostic phase-serialization edit were removed. Experiment `moshi-jvm-2026-09-08T01-10-09-868Z` exposed the transport failure described below. The completed repeat with both fixes is `moshi-jvm-2026-09-08T01-21-33-830Z`; its coverage-gate outcome is recorded below.

### Quiet generation and HTTP keepalive

The first post-fix profile repeat encountered a second boundary: Java/Kotlin generation could exceed five minutes without an indexing progress event, while the SSE handler had not flushed a response. The client then reported `fetch failed` or `terminated` before indexing reached the database. These transport failures are not native-crash recurrences.

The reindex endpoint now sends SSE heartbeat comments immediately and on its existing two-second timer when no deferred progress is available. Heartbeats carry no success evidence. A real HTTP regression holds indexing without progress, requires two heartbeat frames, then releases an indexing failure and verifies that the error event remains visible. The test times out before this correction and passes afterward; all four HTTP progress/readiness tests and scoped lint pass.

Both the native and transport fixes are included in the completed fresh-generation profile repeat. Generator artifacts, the pinned Moshi revision, `--parallel 1`, disabled SCIP caching, local embeddings/mock summaries, and readiness requirements remain unchanged.

### Same-profile result with both fixes

Experiment `moshi-jvm-2026-09-08T01-21-33-830Z` uses the original two Moshi tasks and pinned source. Both tasks now complete native indexing, return `providerFirstExecution.status: executed`, report `scip.failures: []`, and confirm `generatorCache.status: disabled`. All six fresh Java, Kotlin, and merged SCIP artifacts pass the protobuf, source-path, UTF-16 range, definition/reference, and cross-file reference checks. Each has 218 documents, 13,496 symbols, 79,704 occurrences, and 14,590 resolved cross-file reference occurrences.

The benchmark still fails its unchanged coverage gate: 13 scanned Gradle `.kts` scripts have no SCIP documents, and `moshi/src/main/java/com/squareup/moshi/internal/RecordJsonAdapter.kt` has no usable provider symbols after ambiguity filtering. These 14 files require legacy fallback. Call proof is also incomplete for 30 provider-primary files because some Kotlin ranges include generic arguments or span multiple lines; derived semantic work remains deferred. No agent execution or full semantic-readiness success is claimed.

Both tasks report the same coverage gaps and stop before agent execution. Native indexing after generation takes 5,420 ms and 5,966 ms respectively. All six artifact validations pass. Captured fresh SCIP files and validation output are retained in `.work/products/moshi-kotlin-2.3.21/moshi-jvm-2026-09-08T01-21-33-830Z-scip/`. The copies preserve evidence before cleanup and are not inputs to generation or indexing.

## Follow-up Kotlin coverage repair — 2026-09-08

The original 66 rejected references had two owners. SemanticDB Kotlin emitted
whole generic supertypes and compiler-generated delegated-property accessor
ranges. The follow-up upstream patch selects type identifiers and omits those
synthetic accessor occurrences while preserving real delegate/property references.
SDL also needed target-bound source spellings for Kotlin companion `invoke`
and backtick-escaped constructor names.

Moshi contains both ordinary and Java-16 `RecordJsonAdapter` implementations.
The normalizer now retains JVM definitions with distinct source-backed SDL IDs
and resolves variant references only within their defining document. References
from other files remain unresolved without compilation-context evidence.
Coverage collision detection uses the existing SDL identity components
(provider, normalized source path, native symbol), and still rejects duplicate
source identities. The existing ambiguous C++ regression remains unchanged.
The normalized provider-collection cache revision advances to 3.

The source-range plugin is staged in a new immutable bundle,
`.work/products/moshi-kotlin-2.3.21-ranges`, with coordinate
`0.5.1-kotlin-2.3.21-ranges-SNAPSHOT` and SHA-256
`2d5a1f6d0c3ca53eea760a9153f84a92f2cd1e09a6dcd97ff7b62eab487fa479`.
scip-java was rebuilt with that coordinate. Neither the previous bundle nor an
installed Maven cache was replaced.

Focused verification: 49 SDL coverage/normalization/call-proof tests pass;
the Kotlin plugin suite executes 59 tests successfully and skips 23.
`npm run build:runtime`, focused ESLint, and `git diff --check` pass.
The additive upstream patch passes `git apply --check` after the existing
compatibility patch.

Experiment `moshi-jvm-2026-09-08T04-02-40-445Z` verified both generations,
zero generator failures, 143 provider-primary files, no full-fallback files,
and 13 uncovered Gradle scripts. It exposed six remaining valid Kotlin spellings
in five files; the final call-proof regression covers these spellings and rejects
unrelated names. That experiment remains a failed readiness result.

The Gradle scripts are not project Kotlin source-set compilations. Gradle's
[embedded Kotlin DSL compiler](https://github.com/gradle/gradle/blob/master/platforms/core-configuration/kotlin-dsl/README.md)
handles them separately from the KotlinCompile tasks instrumented by scip-java.
A real script-semantic generation path is still required; no file exclusion,
empty SCIP document, or relaxed readiness condition has been added.

The initial `ranges` artifact is superseded. Review found that its shared identifier
helper could descend into a declaration's expression body. The regression now
asserts the definition name in `fun read() = annotations`; it failed with
`annotations` and passes with `read`. Traversal is restricted to type nodes.

The final source patch and stage scripts use
`0.5.1-kotlin-2.3.21-ranges2-SNAPSHOT`, SHA-256
`6b60a046592de6676e75c4542d9bb78a9efe680674ae6923286b15c0c5cdc80c`,
in `.work/products/moshi-kotlin-2.3.21-ranges2`. The complete Kotlin suite
passes again, and the updated additive patch passes its application check.
The previous `ranges` bundle is retained as historical evidence, not the
recommended artifact.

### Final verification

Experiment `moshi-jvm-2026-09-08T04-16-00-498Z` completes both tasks with the
corrected `ranges2` artifact. Each reports provider execution `executed`,
143 provider-primary files out of 156 scanned, zero full-fallback files, zero
incomplete call-proof files, and an empty generator-failure array. Generated-index
caching remains disabled. Semantic generation is no longer deferred:
`semanticDeferred: false`; 5,804 mock summaries are generated, 16 skipped,
and zero fail.

All six fresh SCIP files pass validation. Each has 57 Java documents and 161
Kotlin documents, 13,496 symbols, 79,680 occurrences, and 14,590 references
resolving to definitions in other source files. Evidence copies and validator
output are under
`.work/products/moshi-kotlin-2.3.21-ranges2/moshi-jvm-2026-09-08T04-16-00-498Z-scip/`.
The authoritative session records are
`results/moshi-jvm-2026-09-08T04-16-00-498Z.sessions.jsonl`.

Both readiness checks still fail with 13 uncovered Gradle scripts.
No agent starts. This is a verified repair of Kotlin call proof and the unusable
JVM variant file, **not completion of the requested coverage repair**.
The outstanding implementation is compiler-backed Gradle Kotlin DSL script
indexing in the generator path. Source exclusions, fabricated SCIP facts, or
accepting fallback would not resolve that gap.

Commands used from the SDL checkout:

```powershell
npm run build:runtime
node --experimental-strip-types --test --test-name-pattern "coverage|normaliz|SCIP|ambiguous|Kotlin companion|source-backed variant" tests/unit/provider-first-indexing.test.ts tests/unit/provider-first-scip-duplicate-definitions.test.ts tests/unit/provider-first-kotlin-call-proof.test.ts
node sdlbench/scripts/stage-moshi-jvm.mjs <patched-scip-io.exe> <rebuilt-scip-java-pack> <maven-ranges2>
node sdlbench/scripts/rerun-moshi-jvm.mjs
```

The upstream build uses `cli/pack` through sbt. The Kotlin build uses
`:semanticdb-kotlinc:spotlessApply :semanticdb-kotlinc:test :semanticdb-kotlinc:publishToMavenLocal`,
with `-Pversion=0.5.1-kotlin-2.3.21-ranges2-SNAPSHOT`,
`-Dmaven.repo.local=<dedicated-maven-ranges2>`, and
`-Porg.gradle.java.installations.paths=<JDK8>`.

The broader SDL regression command also passes: `node --experimental-strip-types --test tests/unit/*scip*.test.ts tests/unit/provider-first-kotlin-call-proof.test.ts` (227 passed, zero failed). The focused coverage suite passes 49 tests. The upstream Kotlin suite reports 59 passed and 23 skipped.

Inspection of the installed Gradle 9.5.1 `KotlinCompilerOptions` class with `javap -p` exposes JVM target, warnings-as-errors, and metadata-version-check settings; it provides no compiler-plugin or free-argument setting. This rules out simply forwarding the existing project-task compiler arguments through that options object. Gradle script indexing still needs a separate integration with its embedded compiler, including settings scripts and script compilation caching. No such integration is included in this patch.

## Gradle Kotlin DSL indexing — 2026-09-08

The generator now compiles settings and project scripts through Gradle's script
models and standalone K2 templates, including Gradle's assignment and
SAM-with-receiver compiler plugins. This pass uses the model's real classpaths
and implicit imports and does not evaluate scripts a second time. Every script
must produce fresh SemanticDB; compiler errors or missing output fail generation.

SemanticDB script members receive identities scoped by relative script path.
The shared emitter excludes generated script parameters, result properties, and
their accessors. Local script variables/functions carry explicit compiler kinds.
SDL admits those locals only for Kotlin Gradle scripts, with a real definition
whose source text matches the compiler name. It keeps local IDs and call-proof
names scoped to each document. Unknown kinds, missing/mismatched definitions,
and wrong reference text remain failures. The normalizer cache revision is 4.
No readiness denominator, source exclusion, or fallback acceptance was changed.

The initial script integration experiment
`moshi-jvm-2026-09-08T12-08-46-606Z` produced all 13 script documents and zero
generator failures, but both readiness checks rejected two scripts containing
only local declarations. That result exposed the missing consumer support;
it is not the final acceptance run.

Focused regressions pass: 231 SCIP/normalizer tests, 47 provider coverage tests,
and 59 upstream Kotlin tests (23 skipped). The Gradle integration fixture passes
fresh and warm-cache generation, source-local identity/reference assertions,
synthetic-field exclusion, explicit local-kind metadata, and invalid-script
failure propagation. Its disposable Windows path contains spaces and an apostrophe.

The final artifact is
`com.sourcegraph:semanticdb-kotlinc:0.5.1-kotlin-2.3.21-scripts4-SNAPSHOT`, SHA-256
`79e73306593b97ac87ab656ed072e3c3548514d32bfa1b7d8da35c056238c751`.
The independent bundle is `.work/products/moshi-kotlin-2.3.21-scripts4`.

### Final profile result

Experiment `moshi-jvm-2026-09-08T12-23-18-911Z` completed with overall status
**failed**: `moshi-json-data-exception-tostring` passed its verifier;
`moshi-add-version-constant` timed out during agent verification, and its final
record reports `EBUSY: resource busy or locked, read`. This is not a passing
two-task benchmark.

The first completed record reports 156 scanned, provider-covered, and
provider-primary files; zero uncovered, fallback, full-fallback, or
call-proof-incomplete files; zero generator failures; and `semanticDeferred:false`.
Reference coverage remains partial under the existing provider contract.
The second task passed preflight and launched its agent: its server log records
156 decoded source documents, 5,854 symbols, 4,136 edges, zero generator failures,
disabled generated-index caching, and verified persisted graph integrity.
Its timeout record omits the normal indexing detail, so it does not independently
preserve every final readiness counter.

Both tasks freshly generated Java, Kotlin, and merged SCIP. All six captured
files passed independent protobuf/source validation before agent edits:

| Source language | Documents | Symbols | Occurrences | Definitions | References |
| --- | ---: | ---: | ---: | ---: | ---: |
| Java | 57 | 3,569 | 27,638 | 3,568 | 24,070 |
| Kotlin | 161 | 9,927 | 52,042 | 10,051 | 41,991 |
| Gradle Kotlin DSL | 13 | 41 | 1,172 | 41 | 1,131 |
| Total | 231 | 13,537 | 80,852 | 13,660 | 67,192 |

Each artifact has 14,596 references resolving to definitions in other source
files. Validation checks unique relative document paths, source existence,
UTF-16 range bounds, semantic content, all 13 script documents, and exclusion
of synthetic script fields. The 231 raw SCIP documents include JVM variants;
SDL normalizes them to 156 source files.

Merged SHA-256:
- First task: `b9d7ce8f8d648c0c7dced41d8c54299d7dbba41b42095e2cfa6a18ddc6e87156`.
- Second task: `40b2f7966caa431f9149322a947c9b6502fb632d46f2b768edab089e2e7d1f48`.

Evidence is retained in `results/moshi-jvm-2026-09-08T12-23-18-911Z.sessions.jsonl`
and `.work/products/moshi-kotlin-2.3.21-scripts4/`: `last-run.json`,
`benchmark.log`, and the experiment's `-scip/` directory containing the six
artifacts, validation records, and `ValidateMoshiScip.java`. Copies were captured
for evidence only; none were substituted into generation. The second server log
is `C:/Users/glitt/.sdl-mcp/logs/sdl-mcp-20260908T123413.841Z-26852-1.log`.

Reproduction/check commands from the SDL checkout:

```powershell
node sdlbench/scripts/stage-moshi-jvm.mjs
node sdlbench/scripts/rerun-moshi-jvm.mjs
node --experimental-strip-types --test tests/unit/*scip*.test.ts tests/unit/provider-first-gradle-script-locals.test.ts tests/unit/provider-first-kotlin-call-proof.test.ts
node --experimental-strip-types --test --test-name-pattern "coverage|normaliz|SCIP|ambiguous" tests/unit/provider-first-indexing.test.ts
npm run build:runtime
```

The build and scoped lint pass. Both upstream additive patches pass
`git apply --check`. The remaining benchmark issue is the agent verification
timeout/locked read, not the initial generation or missing-script coverage.
Its precise cause is not established by this run. The generator fixes remain
local and unpublished, and Gradle versions beyond 9.5.1 remain unverified.


## Runtime timeout and source snapshots — 2026-09-09

The prior task-2 failure exposed two independently reproduced defects:

- SDL runtime awaited the child's `close` event after attempting process-tree
  termination. An exited launcher can leave a detached descendant holding its
  stdout/stderr pipes. A 500 ms request then took 6,079 ms, until the descendant
  exited. The executor now bounds post-termination draining with the existing
  five-second grace period, releases retained pipes, and reports timeout rather
  than success. Forced output abandonment is marked truncated.
- SDLBench's recursive source snapshot read ignored build caches. A disposable
  Git fixture with an exclusively locked `.gradle/cache.lock` reproduced `EBUSY`.
  Git snapshots now use tracked and unignored untracked paths. Tracked files
  remain included even if ignored; edits, additions, and deletions remain
  observable. Non-Git fixtures retain recursive snapshots. An unignored locked
  file still fails, with its relative path in the error. No index readiness
  denominator or generator behavior changes.

The old record did not retain the locked filename or process-tree state, so
these reproductions establish the defects but cannot prove those exact details
of the historical failure. Post-setup failure records now retain completed SDL
index evidence instead of losing it during artifact-collection errors.

All 119 runtime and SDLBench tests passed after the fixes. The resumed session
rechecked 86 focused tests, including real Windows locking and retained pipes:
all passed. The inherited-pipe test returns in about 5.6 seconds for a 500 ms
limit plus the five-second drain grace. Build and scoped ESLint passed.

Experiment `moshi-jvm-2026-09-08T13-03-30-302Z` was interrupted before producing
session records or captured SCIP; its stale running state is preserved as
`<experiment>.interrupted.json`. It is not counted as a pass.

The unchanged two-task profile restarted as
`moshi-jvm-2026-09-09T12-45-46-953Z`, using the same scripts4 artifacts, pinned
Moshi revision, generated-index cache disabled, and original readiness gates.
Final results are recorded below. Source hash
semantics now exclude ignored caches; do not compare old and new source hashes
as if their snapshot implementations were identical.

### Completed rerun

`moshi-jvm-2026-09-09T12-45-46-953Z` completed at
`2026-09-09T13:04:37.373Z` with status **passed**. Both
`moshi-json-data-exception-tostring` and `moshi-add-version-constant` have passing
agent exits and verifiers, with no task timeout or artifact-collection error.

Each task reports 156 scanned, provider-covered, and provider-primary files;
zero uncovered, fallback, full-fallback, and call-proof-incomplete files;
`semanticDeferred:false`; and zero generator failures. Generated-index caching
remains disabled. Partial external-reference coverage remains explicitly reported
under the existing provider contract; readiness checks were not weakened.

All six fresh Java, Kotlin, and merged SCIP artifacts validate against sources
captured before agent edits. Each contains 231 documents (57 Java, 161 Kotlin,
and 13 Gradle Kotlin DSL), 13,537 symbols, 80,852 occurrences, and 14,596 cross-file
resolved references. This is artifact-content proof, not just process-exit proof.

Merged SHA-256 hashes:

- JsonDataException task: `3b93d01d4dddca52312ac28f9ab352e9d6bb16f0885189db8bfd79c368165f99`.
- VERSION task: `e4d9b601caea0a3a1f1abf27fa72e2aa7c4d45a9c807a552ac5012ef5f1f8cdc`.

The first agent exercised the original timeout boundary: a 30-second PowerShell
request returned `timedOut:true`, `exitCode:null` in 35,122 ms, rather than hanging
until the 300-second client timeout. Later commands succeeded and the task passed.
The second agent completed its module check and verifier without the prior timeout
or `EBUSY`. A command timeout remains a timeout; it was not relabeled success.

Evidence is in `results/moshi-jvm-2026-09-09T12-45-46-953Z.sessions.jsonl` and the
scripts4 bundle's `<experiment>.run.json` and `<experiment>-scip/` directory.
The latter contains all six captures, `validation.json`, `verification.json`
(with SHA-256 hashes and task readiness), and `ValidateMoshiScip.java`.

Commands used on resumption:

```powershell
node --experimental-strip-types --test tests/unit/runtime-executor.test.ts sdlbench/tests/snapshot-files.test.mjs sdlbench/tests/sdlbench.test.mjs
node sdlbench/scripts/rerun-moshi-jvm.mjs
```

The 86 focused checks pass; the preceding full runtime/SDLBench suite passed
119 checks. No generator version, timeout budget, task prompt, readiness gate,
or SCIP cache setting changed for this rerun. The source snapshot implementation
and SDL runtime are the repaired components. Process-tree termination remains
best effort for independently detached descendants; the runtime now bounds its
own output-drain wait. Upstream generator artifacts remain local and unpublished.
