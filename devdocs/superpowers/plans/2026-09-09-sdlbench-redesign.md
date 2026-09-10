# SDLBench Experimental Core Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SDLBench's unreliable control preparation and evidence pipeline with auditable ordinary-work and retrieval comparisons, without requiring SDL to win.

**Architecture:** Keep the existing CLI and historical reader. Extract concrete preparation, session, measurement, evaluation, and analysis owners from the current monolith, with immutable manifests and append-only attempt evidence connecting them. Codex capability qualification gates live execution; deterministic offline work does not stand in for proof of the real client.

**Tech Stack:** Existing Node.js ESM, `node:test`, Git, installed Codex CLI, existing SDL HTTP/MCP transport, existing pinned tokenizer. No new framework, database, agent SDK, or viewer.

**Approved specification:** `devdocs/superpowers/specs/2026-09-09-sdlbench-redesign-design.md`.

---

## Operating rules and evidence baseline

All paths below are repository-relative to `F:/Claude/projects/sdl-mcp/sdl-mcp`. For implementation, create an isolated `codex/sdlbench-redesign` worktree from the approved planning revision with @using-git-worktrees. Check for an existing branch first; never reset it. Preserve the dirty main checkout and all prior results. Read code through SDL; if unavailable, use the documented targeted fallback in `SDL.md` and disclose that limitation.

This plan authorizes no model run or index refresh by itself. Offline tests use fake child processes, saved/synthetic event fixtures, fake SDL transports, and disposable Git repositories. Do not import a test that silently indexes. Obtain the applicable explicit execution/indexing approval for a concrete manifest before live qualification. No pushes or releases are part of implementation.

Each task uses @test-driven-development for nontrivial behavior and @test-scope for relevant verification. Follow @verification-before-completion before success claims/commits. Steps are intended as bounded edit/test actions; when one case requires more than one edit, keep it within the same owner rather than widening scope. Commit only the task's named files after reviewing the staged diff. The suggested commit messages below are local checkpoints, not permission to include other work.

### Verified owner map (planning checkout `44ea32c3`)

| Owner | Verified finding / disposition |
| --- | --- |
| `sdlbench/src/sdlbench.mjs:113` | Copies the complete task source, including its `AGENTS.md`, into each arm. Preserve existing fixture behavior only as legacy; new preparation must declare instruction adaptations. |
| `sdlbench/tests/fixtures/repo/AGENTS.md` | Contains SDL-default workflow requirements. This is the direct source of the observed baseline contamination. |
| `sdlbench/src/sdlbench.mjs:764`, `:840`, `:916` | Isolated Codex home still copies auth, enables hooks, and launches through an inherited environment and shell command template. Replace for new experiments with explicit inputs and structured execution. |
| `sdlbench/src/sdlbench.mjs:965` | Post-hoc sterility scans only selected markers; it has no condition-aware instruction inventory. Replace with manifest comparisons; retain old behavior only for labeled legacy analysis. |
| `sdlbench/src/sdlbench.mjs:1402` | Usage joins all matching-cwd session files. New adapter binds exact session IDs/segments and rejects ambiguity. |
| `sdlbench/src/sdlbench.mjs:1866`, `:1891` | SDL arm requires nonzero SDL activity and installs enforcement assets. Neither belongs to `sdl-available`. |
| `sdlbench/src/sdlbench.mjs:873`, `:979`, `:1952` | Git-aware snapshots, owned HTTP setup, and exact-root/index preflight are useful candidates for extraction, with strengthened lifecycle coverage. |
| `sdlbench/src/fairness.mjs`, `stats.mjs`, `coverage.mjs`, `claim-gates.mjs` | Current prompt-count fairness, task-only clustering, symbol-name coverage, and savings targets do not implement the approved v5 contracts. Keep arithmetic helpers where verified; add explicit v5 behavior. |

Existing benchmark transcripts expose `session_meta` identity/base instructions, `world_state` instruction state, `turn_context` model/effort/permissions, `token_count` totals, and response-level `token_usage_record` IDs. Initial metadata inspected so far does **not** establish a complete exposed tool inventory. Tool search outputs only establish discovered tools. Actual tool-surface capture and earliest reliable validation point remain the bounded Task 1 decision, not an assumed feature.

## Chunk 1: Prove capture and freeze experiments

### Task 1: Establish the real Codex capture boundary

**Files:** Create `sdlbench/docs/codex-capture-contract.md`; create `sdlbench/tests/fixtures/codex-v5-capture.jsonl`; create `sdlbench/tests/codex-capture.test.mjs`; create `sdlbench/src/agents/codex.mjs`. Read current `sdlbench/config/agents/codex.json`, `sdlbench/tests/measurement-audit.test.mjs`, and the owner functions above.

- [ ] Inspect the installed client's supported local diagnostic/session protocol and effective configuration resolution. Use @context7 when checking current external CLI/API documentation, and official OpenAI documentation if unavailable. Do not invent command flags or use a model conversation to discover capability silently. Record exact client version, evidence sources, and the source of fixture instruction injection in the capture contract.
- [ ] Resolve the complete configurable instruction/tool-source inventory and how it binds to an exact spawned process/session. Specifically prove native tool exposure, SDL registration/schema identity, lazy discovery semantics, hooks, ancestors, client home, environment, and instruction world-state updates. Record which surface is fully observable, partially observable, or unavailable. Hidden nonconfigurable provider instructions are explicitly outside capture.
- [ ] Make a small synthetic fixture preserving actual event shapes for initial instructions, model/effort, session IDs, and state updates; strip private paths/text. Add a representative test that `inspectSession` rejects neutral prompt + SDL-default instruction in the `native` condition and accepts a task merely mentioning SDL as source data.
- [ ] Run `node --test sdlbench/tests/codex-capture.test.mjs`; first failure must demonstrate absent/rejecting capture logic, not a live client error. Implement only pure parsing/comparison needed for those cases in `agents/codex.mjs`; repeat until passing.
- [ ] Document the selected capture mechanism, launch/session correlation, termination latency bound, qualification commands, and exact missing surfaces. If supported local diagnostics cannot expose a known configurable source/tool surface, mark `capabilityStatus: blocked`; STOP Track A adapter integration and live agent execution. Preserve the plan and report the specific missing capability for a design decision. Shared offline contracts and Track B are not proof of this capability and do not depend on a Codex profile; they remain subject to their own qualification. Do not weaken the specification to keep moving.
- [ ] Review and commit these files as `test(sdlbench): define Codex session capture contract`. Real-client qualification remains pending until performed under its approved manifest; synthetic tests cannot mark it qualified.

**Interface fixed for downstream work:**

```js
// A complete mismatch is fail; incomplete required observation is unavailable.
inspectSession({ expected, events, processBinding })
// -> { status: 'pass'|'fail'|'unavailable', checks, sessionIds, artifacts }
```

The adapter format follows the mechanism proven above; do not choose a new client transport just because its schema is easier to test. A transport change requires recording its changed experimental condition and validating ordinary-agent equivalence.

### Task 2: Validate and freeze the v5 manifest

**Files:** Create `sdlbench/src/manifest.mjs`, `sdlbench/tests/manifest.test.mjs`, `sdlbench/tests/fixtures/experiment-v5.json`; modify `sdlbench/src/cli.mjs` only to expose offline manifest validation.

- [ ] Write tests for missing tasks/repetitions, duplicate pair identities, unsupported conditions/tracks, undeclared condition differences, path escapes, credential values, and unknown schema versions. Require nonempty populations, integer repetitions > 0, nonnegative explicit resource limits, frozen tool/config/task/grader/build hashes, and `native`/`sdl-available` only in the initial ordinary-work schedule.
- [ ] Represent experimental arms independently of condition profiles: `arms: [{id:'a', condition:'native'}, {id:'b', condition:'native'}]` is valid A/A qualification; two repeated arm IDs are invalid. Attempt identity is experiment + track + repository/tree + task + repetition + arm ID. Pair keys omit arm ID; the pair holds two distinct arm slots and retains both condition IDs. Comparison manifests require native versus available; same-condition arms are permitted only for qualification. Test all collisions explicitly.
- [ ] Run `node --test sdlbench/tests/manifest.test.mjs`; expect missing module/validation failure. Implement `validateManifest`, `canonicalManifest`, `manifestDigest`, and `buildSchedule` using builtins. Reject unknown fields at control boundaries; preserve explicitly allowed diagnostic metadata separately. Canonicalize object keys recursively, retain array order, use UTF-8 SHA-256, and exclude only the digest field itself from its digest.
- [ ] Make ordering reproducible: sort task blocks by SHA-256 of `[seed, taskId, blockIndex]` with lexical tie-breaker; derive the initial condition order from the same block hash, reverse it for the second repetition. Freeze the resulting schedule. Odd repetition count is permitted with an explicit `balanced: false`; zero/implicit repetitions are rejected.
- [ ] Add required manifest `purpose: 'qualification'|'comparison'`. Qualification also declares its case (`aa`, `capture`, `negative-control`, or `retrieval-controls`), expected check outcomes, approved execution envelope, and pending/completed evidence references. Track A comparisons reference passing real-client qualification bound to exact client/configuration/capture adapter versions. Track B comparisons instead require qualified retrieval procedure/transport, owned index identity, and approved reference evidence; no Codex profile or task-solving model qualification is required. Add offline `run --manifest PATH --prepare-only` dispatch that validates and writes the frozen schedule without launching agents or SDL. Reject mixing `--manifest` with legacy variant/matrix overrides. The full prepare-only semantics are completed in Task 3.
- [ ] Verify exact replay and known perturbation with this test, run the focused suite, and commit as `feat(sdlbench): freeze versioned experiment manifests`.

```js
import assert from 'node:assert/strict';
import { buildSchedule } from '../src/manifest.mjs';
const input = { seed: 'qualification', tasks: ['a'], repetitions: 2,
  arms: [{ id: 'a', condition: 'native' },
    { id: 'b', condition: 'sdl-available' }] };
const rows = buildSchedule(input);
assert.equal(rows.length, 4);
assert.deepEqual(rows.map(r => r.armId).slice(0, 2),
  rows.map(r => r.armId).slice(2).reverse());
assert.deepEqual(buildSchedule(input), rows);
```

### Task 3: Prepare equivalent repositories and explicit condition inputs

**Files:** Create `sdlbench/src/workspace.mjs`, `sdlbench/tests/workspace.test.mjs`; modify `sdlbench/src/fairness.mjs`, `sdlbench/tests/pairing-fairness.test.mjs`, `sdlbench/src/cli.mjs`. Reuse `snapshotFiles` after extraction without changing its legacy export.

- [ ] Build tiny disposable Git fixtures for native and SDL conditions; inject hostile ancestor/repository instruction files, junction/symlink escapes, and a dirty protected source. Add a fixture matching the actual contaminated `AGENTS.md`. Test that both conditions have equal history and equal common instruction bytes after a declared adaptation, while source files remain unchanged.
- [ ] Run `node --test sdlbench/tests/workspace.test.mjs sdlbench/tests/snapshot-files.test.mjs`. Expect the new preparation contract to fail. Implement `prepareWorkspace({ manifest, attempt, root })` using a pinned source commit or one frozen fixture commit prepared identically for both arms. Use structured Git arguments; do not copy a linked worktree's `.git` pointer. Record original and adapted content hashes/diffs.
- [ ] Implement supported configuration inventory in `fairness.mjs` from Task 1's contract. Compare full common source bytes and an explicit allowed difference set, not just token counts or a word blacklist. Reject unknown configurable sources. No SDL requirement/hook/skill in native; no enforcement asset installation or native permission changes in available.
- [ ] Construct child environment from the manifest allowlist, not `{...process.env}`. Give both conditions equivalent isolated homes/temp roots and approved credentials; omit credential contents/hashes from evidence. Resolve Windows executable and required OS variables without exposing private home/memory directories. Record and test the actual OS access boundary: changing `HOME` alone is not filesystem isolation.
- [ ] Finish prepare-only: emit prepared inventory/identity/adaptation evidence and list pending live/index/session checks as unavailable. It never calls index refresh, launches a model, or reports fully qualified. Reject an existing attempt directory rather than recursively deleting/reusing it.
- [ ] Run focused preparation/isolation/snapshot tests; expect all pass and the protected source digest unchanged. Commit as `feat(sdlbench): isolate declared benchmark conditions`.

## Chunk 2: Execute and record without inventing evidence

### Task 4: Correlate usage events and normalize measured categories

**Files:** Extend `sdlbench/src/agents/codex.mjs`; create `sdlbench/tests/codex-usage.test.mjs`; update relevant cases in `sdlbench/tests/measurement-audit.test.mjs` only when legacy behavior changes.

- [ ] Add event-replay cases for duplicate cumulative events, decreasing totals, a truncated final line, a known complete final counter, two unrelated sessions with the same cwd, distinct response IDs, reasoning included in output, unknown cache semantics, and explicit resumed segments. In initial v5 live runs resume is prohibited; ambiguous historical resume is unavailable rather than guessed.
- [ ] Add an explicit incremental fixture: segment A has uniquely identified increments `{input:100, cachedRead:50, output:10}` and `{input:20, cachedRead:0, output:2}`, plus a duplicate of the first event; a separately identified, explicitly correlated segment B adds `{input:5, cachedRead:0, output:1}`. Expected totals are input 125, cached-read 50, uncached 75, output 13, total 138. Unknown increment semantics or missing correlation returns unavailable. Synthetic segment normalization does not authorize resumed live attempts.
- [ ] Run `node --test sdlbench/tests/codex-usage.test.mjs`. Implement `normalizeUsage({ binding, events, semantics })` with session/response deduplication and exact declared category identities. Use final cumulative totals once; never sum repeated cumulative events. Use per-response records as a reconciliation source only when their semantics are verified, not an additional billable bucket.
- [ ] Return `{status, categories, coverage, reasons, eventRefs}`. Missing/inconsistent usage yields unavailable with raw evidence retained. Preserve independently observed text and tokenizer provenance under a separate field. An unavailable text tokenizer must not erase valid provider counters.
- [ ] Assert the known real arithmetic with sanitized synthetic events: input 1,276,242; cached-read 1,183,616; output 17,459; total 1,293,701; uncached input 92,626; uncached-plus-output 110,085. An identical duplicate event must not change any value.
- [ ] Run usage and existing measurement tests; commit as `fix(sdlbench): reconcile exact-session usage without double counting`.

### Task 5: Durable attempts and bounded structured execution

**Files:** Create `sdlbench/src/attempt.mjs`, `sdlbench/src/agents/codex-runtime.mjs`, `sdlbench/tests/attempt.test.mjs`, `sdlbench/tests/codex-runtime.test.mjs`; modify `sdlbench/tests/command-timeout.test.mjs` for the shared extracted process helper where applicable.

- [ ] Write fake-child tests for launch failure, clean completion, stdin prompt bytes, argument paths with spaces/metacharacters, held output pipes, timeout, cancellation, record-write failure, and partial journal recovery. Assert neither arbitrary command text nor inherited environment reaches the v5 launcher. Windows launcher resolution must be proven for the actual installed executable; do not pretend a `.cmd` file is directly executable with `shell:false`.
- [ ] Run `node --test sdlbench/tests/attempt.test.mjs sdlbench/tests/codex-runtime.test.mjs sdlbench/tests/command-timeout.test.mjs`. Implement owned-process launching from executable + argument array + stdin using Task 1's verified contract. Preserve bounded output artifacts and a bounded user-facing tail; enforce declared capture quota and record dropped bytes. Avoid silent last-N-byte-only evidence loss.
- [ ] Implement a per-attempt append-only JSONL journal with ordinal, attempt/manifest identity, transition, artifact digest/reference, and terminal outcome. Open new attempts exclusively, append and flush state boundaries, tolerate only an incomplete final line during recovery, and mark interruption instead of resuming work. Invalid middle lines are corruption, not skipped events.
- [ ] Own all timing in `attempt.mjs` using an injected monotonic clock; workspace, SDL session, runtime, and evaluator owners emit named start/end boundaries into it. Record repository preparation, SDL preparation/index build, agent execution, grading, cleanup, and full attempt durations. Agent time is process launch through termination, including tool waits; full time is preparation start through cleanup end. Record overlaps explicitly; never reconstruct total by summing overlapping phases.
- [ ] Add a fake-clock case with sequential durations repository 20 ms, SDL 30 ms, agent 40 ms, grader 10 ms, cleanup 5 ms: full attempt is 105 ms and agent time 40 ms. Add overlapping SDL subphases whose sum exceeds SDL preparation but does not inflate full time. Add launch failure, timeout with cleanup, and interrupted-journal recovery: partial timing retains observed boundaries, but an unobserved final boundary stays unavailable. Never subtract monotonic readings from different process lifetimes.
- [ ] Start actual-session observation with the launched process, bind IDs using the proven mechanism, validate every relevant state transition, and terminate on mismatch/unavailable required capture. Evidence already consumed remains recorded. Keep a bounded final drain; cleanup does not hang if the process killer or pipes fail.
- [ ] Expose `runCodexAttempt({ prepared, manifest, sink, signal })` returning execution facts and frozen evidence references, never a task grade or savings value. Reconciliation runs even after failed/cancelled execution when final evidence is available. A post-launch infrastructure failure must not discard cost evidence.
- [ ] Run lifecycle/process tests and commit as `feat(sdlbench): record durable bounded agent attempts`.

### Task 6: Bind SDL preparation to the exact owned attempt

**Files:** Create `sdlbench/src/sdl-session.mjs`, `sdlbench/tests/sdl-session.test.mjs`; modify `sdlbench/src/sdlbench.mjs` to delegate extracted helpers without breaking legacy imports; retain `sdlbench/tests/index-preflight.test.mjs` and `sdlbench/tests/measurement-audit.test.mjs` coverage.

- [ ] Extract `startSdlHttpSession`, `createSdlHttpConfig`, preflight/index validation, and their immediate transport helpers into this owner. Keep old named exports as compatibility re-exports. Do not refactor SDL database/indexer internals.
- [ ] Add fake-transport tests for wrong root/tree, nonempty reused DB root, incorrect process/session endpoint, incomplete coverage, generator error, missing index evidence, runtime identity mismatch, and failed cleanup. Retain original index failure/log evidence. Track A rejects externally supplied/reused servers; Track B requires its declared reuse identity.
- [ ] Run `node --test sdlbench/tests/sdl-session.test.mjs sdlbench/tests/index-preflight.test.mjs`. Tests inject fake transports/scanners and never index. For any retained compiled-config test, build `npm run build:runtime` once before running it; label that dependency explicitly.
- [ ] Record server process/endpoint, effective registered root, DB identity, source/index/config digests and coverage before agent work. Recheck source digest after preparation so generator/build mutations cannot silently alter the agent starting tree. Declared required generated files must be applied equivalently to both conditions; undeclared tracked source changes fail preparation.
- [ ] Make available-condition attachment require actual matching server/tool registration, not tool usage. Remove `assertSdlBehaviorIntegrity` from the v5 path only. Never call `installCodexEnforcementAssets` there. Preserve pinned live-update behavior and log subsequent index events rather than forcing a refresh after every edit.
- [ ] Run extraction regressions and commit as `refactor(sdlbench): own and attest disposable SDL sessions`.

## Chunk 3: Evaluate tasks and compare evidence

### Task 7: Freeze submissions and grade task behavior

**Files:** Create `sdlbench/src/evaluation.mjs`, `sdlbench/tests/evaluation.test.mjs`; modify `sdlbench/tasks/fixture.tasks.json` to separate public development checks from private grader metadata without deleting legacy solutions; create `sdlbench/tests/fixtures/grading/` containing original, correct-alternative, and plausible-wrong submissions used only by tests.

- [ ] Write tests proving an agent cannot change grader bytes or race grading after capture, the original bug fails, two different correct implementations pass, and a plausible wrong implementation fails. Include unavailable grading and valid timeout/product-error noncompletion in expected outcomes.
- [ ] Run `node --test sdlbench/tests/evaluation.test.mjs`. Implement `freezeSubmission` and `gradeSubmission` in separate disposable grading roots after the agent and owned writers are stopped. Reject external symlinks/path traversal; run the pinned grader with its own limits and record its digest and the submitted-tree digest.
- [ ] Keep hidden grader fixtures/tests outside the agent/index-visible source roots and access boundary. Public task-scoped development checks remain identical in both arms. Record pre-existing task failures; do not require agents to fix unrelated fixture tests. If the platform cannot keep hidden evaluation inputs inaccessible, the affected task cannot qualify.
- [ ] Add review-rubric import as data, not an LLM grader: require rubric digest, anonymous submission ID, reviewer decision/evidence, and binding to the frozen submission. No submitted grade means unavailable. First live pilot selects fix/feature tasks; review tasks are not admitted until independently qualified.
- [ ] Run the focused grader tests and commit as `feat(sdlbench): grade frozen submissions independently`.

### Task 8: Compute eligibility and descriptive comparisons

**Files:** Create `sdlbench/src/analysis.mjs`, `sdlbench/tests/analysis-v5.test.mjs`; modify `sdlbench/src/stats.mjs`, `sdlbench/src/claim-gates.mjs`, `sdlbench/tests/clustered-stats.test.mjs`; keep `coverage.mjs` and `attribution-signals.mjs` as legacy-only diagnostics unless explicitly called as labeled observations.

- [ ] Write a small complete schedule with pass, task failure, timeout, invalid environment, missing grade, missing usage, and missing price. Assert planned/valid/unavailable/noncompletion counts separately. A fully graded schedule with one missing usage must still expose completion while full token comparison is unavailable; include failed-attempt resource use in cost-per-success.
- [ ] Run `node --test sdlbench/tests/analysis-v5.test.mjs`. Implement `analyzeExperiment({ manifest, attempts })` from immutable artifacts. Reject duplicates/mismatched manifest hashes. Return per-metric status/completeness, denominators, exclusions, values, and source references; never promote a subset to complete.
- [ ] Implement paired totals only for legitimate paired evidence, with jointly solved usage explicitly conditional. Show total and task-balanced ratios separately. Complete actual-spend accounting includes known invalid/setup attempt costs separately and unknown counts; never label a lower-bound subtotal complete expense.
- [ ] Add seeded repository-cluster bootstrap for cross-repository summaries and explicitly task-cluster bootstrap within a repository. Aggregate repetitions within task first. Require at least two independent cluster units for intervals. Sort inputs/tie-breakers deterministically and freeze the resampling seed; preserve old stats semantics for legacy records.
- [ ] Add priced/unpriced category tests using explicitly passed rate snapshots. Cache reads are subsets, reasoning is not double charged, missing categories/rates suppress cost only. No legacy savings threshold participates in v5 validity. A valid SDL loss passes validity; it does not pass a product target automatically.
- [ ] Run analysis/stats/claim regression suites, including an identical-evidence A/A fixture with exact zero differences. Commit as `feat(sdlbench): analyze metric-specific admissibility and outcomes`.

### Task 9: Wire one ordinary-work execution path and legacy safeguards

**Files:** Create `sdlbench/src/experiment.mjs`, `sdlbench/tests/experiment.test.mjs`; modify `sdlbench/src/cli.mjs`, `sdlbench/src/sdlbench.mjs`, `sdlbench/src/scaling.mjs`; modify `sdlbench/viewer/app.mjs` for a version guard rather than a redesign.

- [ ] Add fake-client/fake-SDL end-to-end tests covering preparation, actual-session check, successful zero-SDL-use treatment, grading, usage, analysis, and cancellation. Feed the contaminated fixture/session pair: it must terminate as isolation-invalid and never enter a clean paired result. Assert the schedule is selected before setup. Same-condition A/A arms must remain distinct in storage and pairing even though their condition profiles match.
- [ ] Run `node --test sdlbench/tests/experiment.test.mjs`. Implement `runExperiment({manifest, dependencies})` to call the established owners in schedule order. Persist the full planned schedule and every transition, stop on environment capability loss, preserve planned unrun rows, and produce an offline reproducible report. Dependency parameters are concrete test seams, not an agent/plugin framework.
- [ ] Route `run --manifest PATH` through v5; `--prepare-only` performs only offline preparation. Reject unsupported transports/conditions, resume, task overrides, accidental paid retries, and unqualified client profiles for comparison purpose. An explicitly operator-approved qualification manifest may use a pending profile to collect the first real-client proof through the same launcher and evidence pipeline; it never bypasses an unsupported known capture capability or is admitted as product-comparison evidence. Legacy `run --variant` remains explicitly labeled legacy and cannot enter v5 analysis/claims. Scaling generates a manifest and calls this same v5 execution path; no second scheduler.
- [ ] Implement qualification admission tests: comparison rejects a pending profile; qualification with the required operator approval can collect real-session evidence; fake/synthetic events can test control flow but cannot produce a live-qualified profile. Bind completed qualification to client/config/adapter identities. A negative control declares an intentional mutation at its test boundary, records it separately, and expects the normal isolation check to fail and stop the attempt. That attempt remains invalid even when its expected rejection makes the qualification case pass. Retain its complete known costs/evidence.
- [ ] Route `analyze --manifest PATH --in JOURNAL` and `claims --manifest PATH --in JOURNAL` to v5 evidence/validity reporting. Legacy schema-v4 imports remain historical; no automatic condition relabeling or fabricated missing fields. Existing viewer refuses unsupported v5 data with an actionable message instead of silently charting legacy semantics.
- [ ] Verify fake end-to-end plus CLI tests, source snapshots unchanged, and eight planned attempts retained even when one is invalid/unrun. Commit as `feat(sdlbench): run auditable ordinary-work experiments`.

## Chunk 4: Retrieval track, documentation, and qualification

### Task 10: Deterministic retrieval comparison and reference grading

**Files:** Create `sdlbench/src/retrieval.mjs`, `sdlbench/tests/retrieval.test.mjs`, `sdlbench/tests/fixtures/retrieval-v5.json`; extend `sdlbench/src/evaluation.mjs`, `sdlbench/src/experiment.mjs`, `sdlbench/src/analysis.mjs`. Reuse the existing tokenizer process and SDL transport through bounded dependencies, without adding another client or launcher.

- [ ] Freeze synthetic information needs with public question/terms and hidden reference evidence units. Add tests for literal case-insensitive terms, file ranking by distinct matches/path, five-line windows, overlap merging, whole-window budget stop, UTF-8 text, no matches, an oversized first window, duplicates, empty output, and unsupported references.
- [ ] Run `node --test sdlbench/tests/retrieval.test.mjs`. Implement native retrieval exactly as specification section 8: canonical public query JSON/terms are identical inputs to both arms; SDL task text is question + one deterministic serialized terms line. Use budgets 1000/3000/6000 unless a different set is frozen before execution. No adaptive query rewriting or task-solving model.
- [ ] Tokenize the complete model-facing serialization, including path/line wrappers. Native windows stop at the first nonfitting whole window; SDL over-budget output is reported rather than silently trimmed. First implementation consumes one SDL response per query/budget and does not follow optional continuations; count returned continuation metadata, mark omitted evidence/truncation, and keep that policy fixed in the manifest.
- [ ] Grade sufficiency against independently reviewed source facts, not SDL IDs or reference solution spelling. Deterministic source-backed checks use a frozen reference; semantic relationships accept blinded manual grades bound to output/reference hashes. Unreviewed/disputed references remain unavailable. Secondary excerpt/duplicate diagnostics follow the approved definitions and are not treated as billing buckets.
- [ ] Own one immutable Track B repository/index per revision/configuration, validate its root/tree identity, disable declared feedback mutation, and freeze query order. Record index cost/time once. Query timing is labeled cache-uncontrolled; optional immediate-repeat count comes only from the manifest. No mixing query repeats with independent tasks.
- [ ] Add fake-SDL end-to-end retrieval tests through the shared manifest/journal/analyzer. Assert tiny irrelevant output loses sufficiency, changing references creates a new digest, and no hidden oracle enters index/task inputs. Include a qualified Track B comparison with only retrieval/index/reference dependencies; supply a throwing Codex-adapter factory and assert it is never constructed. Missing Codex qualification must not block this retrieval comparison, while missing retrieval/index/reference qualification must block it. Commit as `feat(sdlbench): compare retrieval sufficiency at fixed context budgets`.

### Task 11: Document contracts and prepare qualification manifests

**Files:** Modify `sdlbench/README.md`, `sdlbench/docs/session-record.md`, `sdlbench/docs/claims.md`, `sdlbench/docs/measurement-audit.md`; create `sdlbench/docs/qualification.md`. Qualification manifest examples live in `sdlbench/config/qualification/` and reference only tiny offline fixtures until live inputs are approved.

- [ ] Update docs from implemented behavior: v5 schema, both tracks, available versus enforced, exact public CLI, metric categories/denominators, environmental limits, local index mode, unavailable fields, legacy exclusion, and how to reproduce analysis offline. Correct the existing schema-v3/no-injection statements; link the historical isolation finding and preserve original records.
- [ ] Define exact offline qualification commands using the new tests. Every acceptance row in specification section 10 maps to one test/evidence case, including counter resets, wrong index binding, missing usage with complete grades, output-pipe hangs, and comparator oversized-window behavior. No undocumented real service dependencies.
- [ ] Prepare but do not execute concrete manifests for: native/native and SDL/SDL A/A using distinct arm IDs; deliberate negative-control contamination; a two-repetition AB/BA fix/feature pilot; and fixed-query retrieval qualification. Use qualification purpose for capability/control runs and comparison purpose for the qualified pilot. Assign separate experiment IDs, exact versions/tasks/budgets/timeouts, pending approval status, and known unknown pricing. Use existing credential approval mechanisms, never copy secrets into manifests.
- [ ] Validate every example manifest offline and exercise its schedule through fake execution using the same orchestration path. Expected: distinct A/A slots persist, pending qualification blocks the comparison pilot, an approved test qualification can collect simulated evidence marked synthetic, and the negative-control mismatch never becomes a valid product observation. Production manifests remain pending until real qualification/approval replaces these test-only artifacts.
- [ ] Make approval-required live execution a separate operator action. It must record real-client capture qualification, exact worktree index proof, frozen grade/reference approval, and full usage reconciliation. Synthetic pass status cannot satisfy this gate. Failure stops qualification with preserved evidence, not an automatic retry or relaxed condition.
- [ ] Run the offline matrix below, request independent code/security review where changes warrant it, and commit docs as `docs(sdlbench): document qualified experiment and reporting contracts`. No live model call, index refresh, push, or publication is implied by this task.

### Verification and execution handoff

Before a task's implementation, verify the listed file exists or is explicitly marked Create. Do not run guessed commands against a changed client. Current test commands use the project's native Node runner; new tests are created by their owning tasks.

```text
node --test sdlbench/tests/codex-capture.test.mjs sdlbench/tests/manifest.test.mjs sdlbench/tests/workspace.test.mjs
node --test sdlbench/tests/codex-usage.test.mjs sdlbench/tests/attempt.test.mjs sdlbench/tests/codex-runtime.test.mjs
node --test sdlbench/tests/sdl-session.test.mjs sdlbench/tests/index-preflight.test.mjs
node --test sdlbench/tests/evaluation.test.mjs sdlbench/tests/analysis-v5.test.mjs sdlbench/tests/experiment.test.mjs sdlbench/tests/retrieval.test.mjs
```

Expected: every selected offline case passes without agent credentials, model requests, or index refresh. After focused suites pass, run the existing SDLBench offline suite once using its inspected file list and build prerequisites; do not repeatedly rerun unrelated full-project tests. On PowerShell, enumerate only `sdlbench/tests/*.test.mjs` into an argument array and invoke `node --test` with it after verifying no live dependencies; never include the `.bak` file. The existing `npm run lint` covers `src` and tests rather than automatically covering `sdlbench`; inspect the ESLint configuration and apply `npm exec -- eslint` to the explicitly supported changed `.mjs` paths, reporting any missing lint coverage. Run `git diff --check`. Check real subprocess/protocol code on Windows and the project's Linux CI before qualifying both platforms; unsupported platforms remain explicitly unqualified.

The implementation is complete only when all selected offline contracts and applicable review findings pass, the docs describe the actual implementation, raw historical evidence is retained, and the user has a concrete manifest to approve for live qualification. It is **not** complete merely because a fabricated agent transcript passes or because SDL's scores improve.

Plan review status: all four chunks independently approved; no remaining review blocker. Revisions resolved same-condition arm identity, qualification bootstrap, monotonic timing ownership, incremental counter coverage, and track-specific qualification. Source findings and Task 1's unresolved tool-capture capability are explicit; plan approval is not evidence that the installed client is already qualified.
