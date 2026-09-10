# SDLBench experimental core redesign

Date: 2026-09-09 (America/Chicago)

Status: Design direction approved; independent specification review passed; awaiting user review of the detailed specification.

## 1. Decision and scope

Replace the experiment preparation, execution evidence, and measurement core inside `sdlbench/`. Preserve raw historical evidence and reuse existing assets only after their contracts are checked. Do not build a second benchmark application, new agent framework, database, or dashboard.

The primary question is: **Does making SDL available improve ordinary agent work under declared conditions?** A separate track asks: **Does SDL return sufficient evidence in less context for fixed information needs?** Neither track may substitute for the other.

First implementation supports Codex behavior experiments and deterministic retrieval experiments. Existing other-agent integrations remain legacy until separately qualified. Tiny fixture tasks qualify the harness, not claims about representative repositories. Moshi remains excluded until its compiler/index prerequisites are independently ready.

This specification defines observable contracts, not an assertion that current code implements them. Current documentation, file inventory, and saved sessions were inspected; source-level ownership and the origin of injected instructions still require SDL-guided inspection during implementation planning. SDL tools were unavailable during this specification session.

### Evidence motivating replacement

The `codex-fixture-20260910T013430Z` records show all eight attempts passing, but all four baseline session transcripts contain SDL-default workflow instructions while `codexSterility.passed` is true. The tiered-checkout baseline explicitly attempts to follow the SDL workflow and reports its document missing. Identical task prompt files therefore do not prove a clean control.

For that pair, final provider counters exactly match the recorded totals. SDL's 1,293,701 total comprises 1,276,242 input, including 1,183,616 cached input, plus 17,459 output. Uncached input plus output is 110,085. This reconciles two different token displays; it does not establish a clean experiment or independently reconstructed requests.

Evidence: `sdlbench/results/codex-fixture-20260910T013430Z.isolation-audit.md`. Preserve this finding and the original JSONL. Do not rewrite old attempts into valid controls.

## 2. Conditions and comparison boundaries

| Condition | Common native tools | SDL | Additional instructions | Use |
| --- | --- | --- | --- | --- |
| `native` | Enabled | No server, hooks, skills, registration, or SDL-specific instructions | Common neutral task/development instructions | Headline control |
| `sdl-available` | Identical permissions and tools | Enabled and verified | Pinned minimal onboarding describing available retrieval; no mandatory ladder or native prohibition | Headline treatment |
| `sdl-enforced` | Restrictions declared explicitly | Enabled | Pinned production policy/skills/hooks | Separately labeled future experiment; not implemented in the first slice |

The headline estimates the effect of adding the declared SDL package, including its schemas and onboarding. It does not isolate the retrieval algorithm from onboarding. Native fallbacks, zero SDL calls, tool errors, schema discovery, and voluntary agent choices are legitimate treatment outcomes. Zero SDL calls must not invalidate an otherwise correctly configured attempt. Missing advertised SDL capability is a setup defect.

Do not modify SDL product policies just to improve scores. If its current installed configuration cannot provide the `sdl-available` condition without silently enforcing another workflow, preparation fails and reports the conflict. Production enforcement is not smuggled into the headline condition.

Pin model identifier, reasoning setting, CLI build, harness build, SDL build/configuration, native tools, common instructions, task bytes, source revision/tree, grading rules, limits, and environment policy. Record provider model revision when exposed; otherwise report it unavailable. Same model name does not prove identical backend weights across dates.

No persistent agent conversation, cross-attempt memory, task-specific pre-retrieval, or index warmed with the task question. Each attempt has a fresh repository and agent state. Provider-managed prompt cache is observable but not assumed controllable; do not label such runs cache-cold.

## 3. Frozen experiment manifest

An immutable manifest is finalized before launching agents. It contains:

| Group | Required content |
| --- | --- |
| Identity | Schema version, experiment ID, track, creation time, manifest digest, harness revision |
| Population | Selected task IDs, repository revisions/content digests, tiny/representative label, selection rationale, exclusions |
| Conditions | Condition IDs, builds, model/reasoning, tool/config/skill/hook/instruction inventories and hashes, explicit permitted differences |
| Schedule | Repetition count, random seed, exact task/condition execution order, time/tool/output limits, retry policy |
| Measurement | Provider counter semantics, tokenizer identity for observed text, timing boundaries, optional pricing snapshot |
| Evaluation | Versioned task graders or retrieval references, expected pre-task failures, rubric, admissibility checks |

Require explicit repetition count and selected task set; there is no hidden full-matrix expansion. Generate balanced AB/BA ordering in two-repetition blocks, randomizing block order and task order with the recorded seed. An odd final repetition gets a declared order. It remains descriptive and cannot claim perfect balance.

The manifest must describe the entire selected population, including failed or unrun attempts. Paired identity includes experiment, track, repository tree, task, repetition, and condition. Condition-specific instruction/config differences are compared against the declared difference set, not by demanding identical full hashes across conditions.

No implicit retry. An operator-authorized rerun gets a new experiment ID linked to its predecessor. Original outcomes remain visible. Any changed model, prompt, grade, dependency resolution, or timeout also requires a new manifest.

## 4. Isolation and effective configuration

Build disposable repositories outside the SDL checkout and any known ancestor instruction directory. Use equivalent Git checkouts for both conditions, including equal access to history. Do not compare a plain directory with a Git worktree. Protect source worktrees and never repair them as part of setup.

Construct an isolated client home and environment allowlist. Inventory every supported instruction/configuration source: parent and repository instruction files, client defaults, memories, skills, hook configuration, plugins, MCP registrations, and environment-provided overrides. Start from the pinned repository's legitimate common instructions. If these already require SDL, declare a single common neutralization applied to both copies before measurement, preserve the original and diff, and classify the experiment as that adapted repository. Do not remove unrelated instructions.

Credentials may be supplied through the same approved mechanism to both conditions. Record names and credential-presence evidence, never values or credential hashes. Absolute paths required in local forensic artifacts are not included in agent-facing benchmark instructions unnecessarily. No user home, private memory, or unrelated project content is mounted into agent-accessible roots by default.

Two checks are mandatory:

1. **Prepared environment check:** independently enumerate the effective supported configuration sources and compare their bytes/hashes with the manifest. Baseline rejection is semantic/source-based: an instruction to use SDL is contamination; a task's legitimate mention of SDL is not automatically contamination. A substring scan alone is insufficient.
2. **Actual-session check:** bind evidence to the exact launched process and session, capture initial visible instruction messages and exposed tool surface, and compare them with the manifest. Continue validating configuration stability and session identity through termination.

The adapter must prove its capture/control mechanism in qualification tests. If it can inspect initial session state before releasing task work, block until inspection passes. Otherwise, environment checks occur before launch and actual-session mismatch stops work as soon as detected; any work already performed is preserved, charged, and ineligible. Do not promise inspection of hidden provider instructions or complete model requests when the client does not expose them. Record supported surfaces and explicit unobservable surfaces. Missing access to a known configurable instruction/tool source is a qualification blocker, not a passing check.

Same-process evidence capture must not require an extra model conversation silently excluded from usage. A preparatory diagnostic invocation, if necessary, is recorded as qualification/setup and cannot substitute for attestation of the actual attempt. Native and SDL conditions use the same launcher path.

The regression that matters is the observed failure: a baseline actual session containing SDL-default instructions cannot pass isolation even when the generated prompt is neutral.

### Index ownership and worktree binding

For initial Track A, each SDL attempt owns a fresh server process, database, repository registration, and generated configuration. No database or index is reused across attempts. Record server process/endpoint identity, database identity, effective registered repository root, source-tree digest, index build/config digests, and index-result provenance. Resolve the real paths and require the server's root to equal the prepared agent checkout, not the source checkout or another attempt. Indexing must start from the frozen pre-task tree. Reject wrong roots, wrong tree/revision, undeclared reused databases, incomplete required coverage, and generator failures before agent launch. Verify the actual session connects to that owned server. Merely seeing a healthy server or nonzero symbol counts is insufficient.

Record initial index readiness and any later indexing operations. Agent edits naturally change the working tree; do not require a full refresh after every edit or redefine ordinary semantic lag as initial setup failure. Pin the production live-update policy in the condition manifest and report its behavior. Close owned servers before deleting owned disposable data; cleanup must never delete source repositories or another attempt's index.

Track B owns one fresh immutable repository/index/server per manifest repository revision and SDL configuration. Its frozen query set may reuse that index, with exact root/tree proof and explicit query order. No query-derived enrichment or cross-query feedback writes are enabled. Record any unavoidable query-dependent cache/overlay state and declare it in the latency regime; reject undeclared state mutation. Index preparation is reported once per such repository/configuration, not charged as if rebuilt for every query. This declared Track B reuse must never leak into Track A.

## 5. Attempt lifecycle and evidence

Use a small explicit lifecycle: `planned -> preparing -> running -> grading -> finished`. Preparation failure, cancellation, launch failure, timeout, and interrupted grading are terminal outcomes with evidence. Persist the plan before work, capture process output continuously, and write transitions durably. Recovery identifies incomplete attempts without silently restarting them.

| Evidence object | Minimum fields |
| --- | --- |
| Attempt | Manifest/attempt IDs, condition/task/repetition, lifecycle transitions, worktree identity, terminal outcome |
| Execution | Start/end monotonic durations, process/session correlation, bounded stdout/stderr artifacts, exit/timeout/cancellation facts |
| Configuration | Prepared and actual inventories, permitted differences, checks with `pass/fail/unavailable`, reasons and artifact references |
| Usage | Raw provider events, counter semantic version, final normalized usage or explicit unavailability, reconciliation result |
| Grade | Grader identity, immutable submitted artifact/tree digest, pass/fail/unavailable, rubric detail and evidence |

Validity and task success are separate fields. A passed task can be invalid; a correctly executed failure is still an eligible effectiveness observation. Never encode validity as an optimistic boolean without reasons and evidence references.

Terminate only owned process trees on timeout/cancellation, bound stream draining and cleanup, and record cleanup errors. A crashed runner may recover durable evidence but cannot invent terminal provider counters. Output limits are predeclared; truncation preserves a byte-counted artifact reference where possible and declares lost coverage. Never truncate a provider usage record into a misleading valid record.

Before grading, stop/quiesce the agent and capture the submitted tree/artifacts. Run the grader in a separate copy with its own limits and no access to agent instructions or condition label. Hidden tests and rubrics remain outside the agent-visible tree. Grade the captured submission, not a file the agent can still mutate.

## 6. Usage, cost, and time

Provider usage is the authoritative reported-usage surface, not independently verified billing. Every adapter declares whether an event is cumulative or incremental, how session resets/resumes are represented, and whether output includes reasoning. For monotonic cumulative events from one segment, use the final counter once. Deduplicate repeated events. Aggregate only distinct, explicitly correlated segments; do not sum successive totals or attach the newest unrelated session. Missing segment boundaries or contradictory counters make usage unavailable pending diagnosis.

Validate nonnegative counters, declared cache subset relationships, and declared input/output/total identities. Reasoning tokens must not be added twice. Counter rollback, truncated final events, resume, duplicate events, and missing usage each have qualification cases. Report total input, cache-read input, cache-write input if separately exposed, uncached input if derivable, output, reasoning subset, and total. Derived fields require known provider semantics; otherwise remain unavailable.

Independently tokenized visible content is a separate observation with tokenizer/version and coverage. Distinguish task/instruction text, tool schemas if visible, tool responses, and assistant text. Never sum overlapping attribution categories or infer the full sequence of model requests from one transcript. Deltas in cumulative provider counters are interval usage, not proof that a specific tool caused that usage.

Pricing is an optional, dated, explicitly selected snapshot with adapter-compatible categories. Missing rate or cache semantics makes monetary estimates unavailable, without invalidating correctness or verified token measurements. A reported estimate is not an invoice. Index/enrichment expense is separate; unknown expense prevents a complete end-to-end cost claim.

Record monotonic durations for repository preparation, SDL preparation/indexing, agent execution, grading, and cleanup. Define agent execution as launch to termination, including its tool waits. Define full attempt wall time as start of preparation through cleanup. Keep phase overlap explicit rather than forcing overlapping timers to sum. No cold/amortized cost or time headline without complete relevant measurements. Index-once repeated-task amortization is deferred.

## 7. Track A: ordinary agent work

Each task declares the exact request, agent-visible repository, allowed tools, task-scoped verification command, and expected pre-task failures. Provide equivalent development guidance for both conditions, including how to run relevant tests. Do not make an unrelated deliberately failing fixture suite look like the required completion criterion. Such debugging may still occur voluntarily and remains part of observed behavior.

Grade fixes/features using hidden behavioral tests plus declared no-regression checks. Accept alternative correct implementations; do not compare with a prewritten solution or exact diff. Validate graders against the original defective state, a known correct submission, and plausible incorrect submissions. A grader that already passes the defective state cannot qualify that task.

Review tasks use a versioned evidence-based rubric with expected findings, acceptable alternatives, severity rules, and penalties for unsupported findings. A filename/keyword check is insufficient. Start with independent human grading blinded to condition; any later model grader requires its own qualification and identical budget/model on both arms. Pending review is `grade unavailable`, never inferred success.

Publish task completion and all attempted spend/time before conditional efficiency on jointly solved pairs. Preserve valid timeouts and product errors in the completion denominator. An invalid-environment attempt is separately reported; its expense is included in actual experiment spend but it supplies no product-effect estimate.

The following metric-specific eligibility rules are normative. A complete scheduled result for a metric requires every observation needed for that metric. Missing token data does not erase an otherwise valid completion outcome. A subset summary must disclose its missing observations and cannot be labeled the complete scheduled result.

| Metric | Required evidence | Missing evidence behavior |
| --- | --- | --- |
| Completion rate | Valid configuration/session and frozen task grading or a declared terminal noncompletion outcome | Grade/setup-unknown attempts remain unavailable; valid timeout/product-error outcomes count as unsuccessful |
| Total provider usage | Valid configuration/session and reconciled usage for every selected attempt, including failures | Report known usage and missing count; full usage comparison unavailable |
| Conditional paired usage | Valid configuration/session, both tasks passed, reconciled usage for both | Report jointly solved count, measurable pair count, exclusions; a measurable subset is explicitly partial |
| Agent time | Valid configuration/session and complete monotonic agent timing | Missing usage does not suppress measured time; missing timing makes the time comparison partial |
| Estimated cost | Usage plus compatible complete pricing for the scope being estimated | Missing prices suppress cost only; known spend stays a lower-bound subtotal if attempts/categories are missing |
| Task quality | Valid configuration/session and rubric/test result | Report separately from resource availability; never infer quality from token counts |

Actual experiment-spend accounting also includes known expenses from invalid/setup attempts, labeled separately from eligible product comparisons. Complete end-to-end expense requires setup/indexing/other applicable costs in addition to agent cost. Completion denominators show planned, valid observed, unavailable, and unsuccessful counts; do not silently divide only by returned grades.

Results include per-task pairs, success counts/denominators, total usage by category, aggregate agent time, paired differences, and experiment limitations. Display aggregate ratio and task-balanced summaries separately. Never call a provider cumulative-token ratio a context-size reduction. Any resource-per-success summary includes resources from valid failed attempts in its numerator and is unavailable when no task succeeds.

For repeated runs, average paired differences within each repository/task before an equally weighted task summary. Bootstrap repository clusters for cross-repository intervals; use task clusters only for explicitly within-repository summaries and state remaining dependence. No interval with fewer than two units at the chosen clustering level. A small sample is exploratory regardless of interval width. Live A/A runs characterize variability; equality is not a pass criterion.

Validity gates concern trustworthy observation and declared conditions, not a desired savings threshold. Legacy 30/45/50-percent savings targets are not validity tests and cannot promote a result to credible. An admitted experiment may show SDL losing.

## 8. Track B: retrieval sufficiency and context size

Run without a task-solving model. Freeze information needs and reference evidence before seeing results. Each query defines its natural-language question, task-independent search terms used by the native comparator, repository revision, evidence units required to answer, alternative acceptable evidence, prohibited answer leakage, and context budget. Neither arm receives hidden reference paths/symbols unless the same target is explicitly part of the query.

Use two declared deterministic retrieval procedures: SDL task-shaped retrieval with the specified budget, and a native lexical search followed by bounded source excerpts. Both receive the same public question and search-term list. The initial native procedure treats those terms as case-insensitive literal strings, searches the frozen agent-visible source-file set, ranks files by distinct terms matched (descending, repository-relative path as tie-breaker), and extracts matching lines with five context lines on either side. Merge overlapping windows within a file and order them by line number. Serialize path, line range, and excerpt body in a fixed format. No access to hidden reference evidence, model-generated query rewrite, or result-dependent search-term changes. SDL receives the public question followed by the same search terms through task-shaped retrieval. This comparison concerns these two retrieval procedures, not all possible native retrieval strategies.

Each evidence unit is an independently reviewed fact or code relationship with source support and accepted alternatives, not an SDL symbol ID or required implementation spelling. Freeze reference digests. Score retrieved content blindly against units; use deterministic source-backed checks where sufficient and blinded human judgment for semantic relationships. Missing or disputed reference coverage is adjudicated before admitting that query; preserve old reference versions rather than rewriting scores silently.

Measure required-evidence coverage, all-required-evidence sufficiency, returned tokens, truncation, and latency as the primary retrieval observations. Count the complete model-facing retrieval output, including wrappers, continuations consumed, errors, and any repeated content; do not count only useful code. Required-evidence recall is covered units divided by reference units. Zero output on a nonempty evidence need is insufficient, not perfect compression.

Secondary excerpt diagnostics require a versioned projection: one native merged source window or one SDL evidence item is an excerpt, retaining its type and source coordinates when available. Label each excerpt relevant, irrelevant, unsupported, or unscorable against the frozen reference; publish counts and denominators by excerpt type, without claiming different granularity makes these percentages directly interchangeable. Duplicate-content tokens are the standalone tokenizer counts for subsequent byte-identical excerpt bodies within one result, excluding their wrappers. This diagnostic is not subtracted from total tokens and is not a disjoint billing category. Near-duplicates are not estimated. Unavailable projection makes these diagnostics unavailable, without suppressing sufficiency and complete-output token measurements.

Both procedures target the same predeclared context budgets; initial defaults are 1,000, 3,000, and 6,000 tokens, frozen in the manifest with the scoring tokenizer. The native procedure appends whole windows in ranked order until the next would exceed the complete serialized-output budget, then stops and reports truncation. SDL uses its supported budget controls; independently count the returned output and report over-budget responses rather than silently trimming them into compliance. Any consumed continuation contributes to the same result budget and latency; never fetch beyond the declared budget. A smaller response is beneficial only with its sufficiency result attached. Report coverage-versus-context curves across the declared budget set rather than picking the winning budget afterward.

Do not mix latency regimes. The initial retrieval experiment uses a fresh query run with filesystem/provider cache state labeled uncontrolled, then separately records a fixed number of immediate repeats if requested by the manifest. No claim of cold cache without proof. Index build time is recorded separately. All generated queries/references remain inaccessible to the index preparation phase.

## 9. Small implementation boundaries

Keep five concrete responsibilities inside the existing harness; these are functions/modules, not a plugin framework:

| Responsibility | Input -> output | Must not own |
| --- | --- | --- |
| Experiment preparation | Validated manifest -> immutable schedule and disposable environments | Agent grading or inferred usage |
| Condition/session adapter | Prepared attempt -> actual session artifacts and terminal facts | Savings calculations or selecting successful retries |
| Evidence normalization | Raw correlated events -> validated usage/configuration/timing evidence | Launching agents or repairing missing facts |
| Evaluator | Frozen submission/retrieval output + frozen grade/reference -> grade | Condition-aware task assistance |
| Analyzer | Immutable manifest + attempts/evidence -> admissibility and descriptive comparisons | Re-running attempts or modifying evidence |

Implementation planning must inspect existing `sdlbench.mjs`, `fairness.mjs`, `stats.mjs`, `coverage.mjs`, `attribution-signals.mjs`, `claim-gates.mjs`, and agent adapters through SDL. These are candidate owners from the file inventory, not preapproved replacements. Reuse verified worktree snapshot, timeout/drain, index-preflight, and arithmetic helpers. Replace or delete old paths only when the corresponding contract is covered.

Use a versioned manifest and attempt schema (next record version: 5). Derived reports include manifest/evidence digests and normalizer/analyzer versions. Analysis is reproducible offline and byte-stable apart from an explicitly separate generated-at metadata field. Preserve schema-v4 import as historical evidence with its missing fields; never synthesize passing isolation.

Existing CLI commands remain the entry points. Implementation may add explicit track/condition selection, but must not silently reinterpret legacy `baseline/sdl` records as the new conditions. Legacy modes are labeled and blocked from new claims. No viewer redesign: provide readable Markdown and JSON reports first; prevent any legacy viewer from presenting v5 records under incompatible semantics.

## 10. Qualification and acceptance

The replacement is ready for first live qualification only when all offline checks below pass. It is ready for a descriptive live comparison only after the live checks pass. Live qualification and indexing require the user's applicable execution approval; this design approval itself does not launch them.

| Check | Required result |
| --- | --- |
| Known usage replay | Exact expected totals for cumulative/incremental events; duplicates not double-counted; ambiguous reset/missing session rejected |
| Contamination injection | Ancestor, repository, client-home, skill, hook, environment, and actual-session SDL instructions cannot yield a clean native condition |
| Condition differences | Allowed onboarding/tool additions pass; native restrictions, tool removals, undeclared hooks or model settings fail |
| Missing observation | Unknown capture, pricing, usage, or grading remains unavailable with metric-specific eligibility; never fabricated zero |
| Metric denominators | A fully graded schedule with one unavailable usage record still reports completion; full token comparison is unavailable and any measurable subset lists its exclusions |
| Index binding | Wrong root, wrong revision/tree, reused Track A database, and session connected to another attempt's server fail preparation/attestation; declared immutable Track B reuse is allowed |
| Lifecycle faults | Launch error, timeout, held output pipes, crash, cancellation, grading failure, and cleanup failure retain attributable outcomes |
| Pairing/report replay | Duplicate identities and mismatched provenance reject; failures remain counted; identical artifacts yield identical analysis |
| Task grading | Original defect fails, correct alternatives pass, plausible wrong implementations fail; review rubric is blinded and substantive |
| Retrieval controls | Tiny irrelevant output loses sufficiency; duplicates cost tokens; native terms do not contain hidden oracle data; fixed outputs score reproducibly |
| Offline same-condition replay | Exact same evidence under two aliases yields zero numeric differences; deliberate perturbations yield known differences |
| Live A/A qualification | Exact session correlation and actual instruction/tool evidence reconcile for repeated native/native and SDL/SDL runs; outcomes can vary and are reported |
| Live negative control | A designated small qualification attempt with injected contamination is stopped/excluded and recorded; cannot reach report as a valid control |
| Live paired pilot | Complete counterbalanced schedule, independently graded outputs, valid index/config evidence, no undeclared intervention; no savings requirement |

Live pilot size, budget, and chosen tasks are explicit manifest inputs approved before launch. Qualify only graders required by the selected task types; a fixes-only pilot does not require implementing review-task grading first. A one-repetition smoke result remains smoke. Do not invent a universal sample size that makes tiny fixtures representative. Any general claim requires a declared representative task/repository population and enough independent units for the intended inference.

## 11. Migration and documentation

The first implementation-plan dependency is a bounded feasibility check for the actual-process instruction/tool capture mechanism, including the source of the observed contamination. Do not commit to an adapter implementation before establishing which evidence it can expose. Then deliver in dependency order: evidence schemas/replay checks; isolation/session qualification; ordinary-work pilot path; deterministic retrieval path; legacy report safeguards and documentation. This is one shared core with two evaluators, not two launch systems. Do not rewrite unrelated SDL indexing or retrieval code in this scope.

Update `sdlbench/README.md`, `docs/session-record.md`, `docs/claims.md`, and `docs/measurement-audit.md` when implementation changes those contracts. The current session-record document says schema v3 and asserts no injected product instructions; those statements must be corrected against implemented behavior, not copied into v5. Document restrictions on available versus enforced SDL. Keep all current reports, failed Moshi attempts, and the isolation finding accessible.

Completion requires exact evidence references for each acceptance check, an offline reproducible report, no dirty-worktree damage, and independent review of the detailed implementation plan before code changes. Performance improvement is not an acceptance criterion for the harness. Trustworthy unfavorable results are a valid outcome.

## 12. Specification review record

Independent review identified two blockers: absent exact index/worktree binding, and ambiguous eligibility when one metric is unavailable. Both were corrected in sections 4, 7, and 10. A second review approved the specification for implementation planning with no remaining blocker. The review also sharpened the deterministic retrieval protocol and scoped grader qualification to selected task types.

Retain the advisory edge case in implementation tests: a native merged window larger than the entire context budget deliberately yields no excerpt under the specified stop rule. Report that result as insufficient/truncated; do not hide it or change the comparator after seeing results.
