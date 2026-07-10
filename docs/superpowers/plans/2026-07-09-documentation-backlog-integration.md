# Documentation, Backlog, and Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document the supported document-heavy planning path, preserve every deferred backlog item with concrete next actions, and close the multi-track batch only from fresh integrated evidence.

**Architecture:** Treat documentation guidance as a synchronized acceptance track, not a code feature. Land the same retrieval rule and example in the context deep dive and SDL workflow source/template, then serialize final status-note and `BACKLOG.md` edits after all code tracks. The external benchmark plan owns the one cold smoke; this plan consumes its persisted result and runs the final cross-track reconciliation without rerunning into an existing artifact directory.

**Tech Stack:** Markdown, SDL-MCP file tools, Node.js 24/npm verification scripts, Git, ignored local evidence.

---

Use `@document-writer` for prose, `@sdl-mcp-agent-workflow` for all repository reads/edits/runtime commands, `@test-scope` for focused integration commands, and `@verification-before-completion` before final claims. Execute this plan's documentation chunk before the clean external smoke and its backlog chunk after all other plans finish.

## Chunk 1: Document-heavy Planning Guidance

### File responsibility map

- Modify: `docs/feature-deep-dives/agent-context.md:57-75` — define `sdl.context` as code-oriented and add the supported document-planning switch rule.
- Modify: `SDL.md:184-188,209-235` — add the same switch rule and targeted `sdl.file` example to the canonical workflow.
- Synchronize: `templates/SDL.md` — generated workflow template; it must match `SDL.md`.
- Verify: `scripts/check-agent-workflows.mjs` and `scripts/check-tool-inventory.ts` through their package scripts.
- Do not modify: context engine, schema, ranking, Markdown adapters, determinism fixtures, or MCP tool schemas.

### Task 1: Prove the documentation gap and add the detailed guidance

**Files:**
- Modify: `docs/feature-deep-dives/agent-context.md:57-75`

- [ ] **Step 1: Capture the pre-change acceptance failure**

Use targeted SDL reads for the exact sentence below in all three documents:

> For document-heavy planning, locate the relevant README, ADR, specification, or plan and use targeted `sdl.file` `op: "read"` with `search`, bounded ranges, or `jsonPath`. If broad `sdl.context` returns irrelevant symbol evidence, switch retrieval surfaces instead of widening symbol budgets.

Expected before editing: no exact match in `agent-context.md`, `SDL.md`, or `templates/SDL.md`.

- [ ] **Step 2: Add a “Document-heavy planning” subsection**

Insert it after the procedural `sdl.workflow` list and before the separation rationale. Use the exact shared sentence from Step 1, then explain that first-class document entities, Markdown indexing, ranking, citations, and planning benchmarks are product work outside this batch.

- [ ] **Step 3: Add the concrete targeted-read example**

Use this same example here and in the workflow source:

```json
{
  "op": "read",
  "repoId": "sdl-mcp",
  "filePath": "docs/feature-deep-dives/agent-context.md",
  "search": "## When To Use It",
  "searchContext": 8,
  "limit": 4
}
```

Explain that `searchContext` and `limit` bound the result. Do not suggest `file.read` for indexed source.

- [ ] **Step 4: Re-read the edited subsection**

Expected: it distinguishes code understanding, procedural work, and document-heavy planning; it includes the exact shared rule and valid example; it does not promise first-class document ranking.

### Task 2: Synchronize the canonical workflow and template

**Files:**
- Modify: `SDL.md:184-188,209-235`
- Synchronize: `templates/SDL.md`

- [ ] **Step 1: Add the exact shared rule to the targeted-files guidance**

Place the sentence from Task 1 immediately after the current “Targeted files” bullet. Keep the existing indexed-source prohibition intact.

- [ ] **Step 2: Add the targeted-read example to “Non-Indexed Reads”**

Place the exact `sdl.file` example before the existing multi-step workflow example. Label the first as a direct targeted document read and the second as a multi-file workflow.

- [ ] **Step 3: Synchronize the workflow template**

Run through SDL `runtimeExecute`:

```powershell
npm run docs:workflows:write
```

Expected: `templates/SDL.md` receives the canonical workflow delta and no unrelated generated file changes.

- [ ] **Step 4: Verify exact rule/example parity**

Use targeted SDL reads in all three documents. Expected: the rule sentence and JSON example are byte-identical; only the deep dive's surrounding explanation is longer.

- [ ] **Step 5: Run documentation acceptance checks**

```powershell
npm run docs:workflows:check
npm run docs:tools:check
```

Expected: both commands exit 0 and report no source/template drift.

- [ ] **Step 6: Commit the documentation track**

```powershell
git add docs/feature-deep-dives/agent-context.md SDL.md templates/SDL.md
git diff --cached --check
git commit -m "docs: explain document-heavy SDL retrieval"
```

Expected: one documentation-only commit; no source, schema, fixture, or generated inventory change.

## Chunk 2: Integrated Verification and Backlog Continuity

### Execution order and shared-file ownership

1. Commit the requested `/BACKLOG.md` ignore rule before creating the implementation worktree.
2. Execute the Claude setup, safe-glob, response-projection, database-remediation, and benchmark implementation chunks. Code/test work may run concurrently only when files do not overlap.
3. The response-projection plan commits all non-benchmark corrections to `devdocs/plans/notes/2026-07-05-token-economy-status.md`.
4. Execute Chunk 1 of this plan and commit the documentation source/template.
5. Finish every tracked code/doc commit and reach a clean worktree.
6. Execute Chunk 4 of `2026-07-09-external-benchmark-isolation.md` exactly once. It owns default-DB before/after proof, the cold smoke, executable evidence verification, and the later benchmark-only status-note edit.
7. Reconcile `BACKLOG.md` here after consuming all fresh results. No parallel task may edit `BACKLOG.md` during this final step.

### File responsibility map

- Update locally: `BACKLOG.md` — authoritative ignored queue; completed items receive actual fresh evidence and deferred items remain unchecked.
- Verify: `.gitignore` — `/BACKLOG.md` remains tracked as an ignore rule.
- Verify: all files named by the five implementation plans.
- Persist ignored evidence: `.benchmark/external/scip-io-cold-smoke-v1/**` and its sibling default-DB before/after fingerprint files.
- Inspect: `devdocs/plans/notes/2026-07-05-token-economy-status.md` — response and benchmark plans own their serialized edits.
- Do not publish a release or add a language.

### Task 3: Run the integrated static and focused gates

- [ ] **Step 1: Confirm tracked implementation state is clean**

```powershell
git status --short
git log --oneline -12
```

Expected: no tracked/untracked implementation files remain outside commits. Ignored `BACKLOG.md`, the pinned external checkout, and benchmark evidence do not appear.

- [ ] **Step 2: Run the complete build and typecheck**

Run separately through SDL `runtimeExecute` with persisted output:

```powershell
npm run build:all
npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 3: Run the Claude setup focused tests**

```powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/init-client-config.test.ts tests/unit/init-claude-config-dir.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 4: Run the shared safe-glob compiler/scanner/watcher tests**

```powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/safeRegex.test.ts tests/unit/safe-glob-parity.test.ts tests/unit/file-walker.test.ts tests/unit/file-scanner-glob-compat.test.ts tests/unit/watcher-health.test.ts
```

Expected: every accepted/rejected grammar row passes and scanner/watcher parity has zero failures.

- [ ] **Step 5: Run the response-projection tests**

```powershell
node --test tests/unit/context-response-projection.test.ts
```

Expected: compact/full usage and approved/downgraded code-window tests pass, including exact key order and nested-object boundaries.

- [ ] **Step 6: Run the focused LadybugDB migration set**

```powershell
node --test --test-concurrency=1 tests/unit/symbol-embedding-remediation.test.ts tests/unit/migration-symbol-embedding-remediation.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-upgrade.test.ts tests/unit/migration-runner.test.ts tests/unit/ladybug-embeddings-queries.test.ts tests/unit/ladybug-auxiliary-queries.test.ts
```

Run this command through SDL `runtimeExecute` with `env: { SDL_MCP_DISABLE_NATIVE_ADDON: "1" }`. Expected: version paths, decoder/classifier, copy/delete revalidation, rollback/retry, physical identity, batching, and compatibility tests all pass.

- [ ] **Step 7: Run the focused external-benchmark tests without launching the smoke**

```powershell
node --test tests/unit/external-benchmark-output.test.ts tests/unit/external-benchmark-manifest.test.ts tests/unit/external-benchmark-runner.test.ts tests/unit/real-world-benchmark-matrix.test.ts
node --experimental-strip-types --test tests/unit/setup-external-benchmark-repos.test.ts tests/unit/benchmark-baseline-repo.test.ts
```

Expected: all tests pass; no network or external `benchmark:ci` child runs.

- [ ] **Step 8: Run lint and repository consistency checks**

```powershell
npm run lint
npm run docs:tools:check
node --experimental-strip-types scripts/check-tool-inventory.ts
npm run check:config-sync
npm run check:schema-sync
```

Expected: every command exits 0; lint has zero errors and workflow/template/schema/config/generated-inventory checks report no drift.

- [ ] **Step 9: Stop on any static or focused-gate failure**

If Steps 1–8 fail, stop before the external smoke. Persist/query the SDL runtime artifact and send the root-workspace backlog owner the exact command, exit code, artifact handle, failed boundary, and next action. That owner records the four-field evidence in `BACKLOG.md` and leaves the related checkbox unchecked. Do not weaken an assertion, skip a focused suite, or continue into Task 4 as if the track passed.

### Task 4: Run shared response-contract and full-suite gates

- [ ] **Step 1: Run prompt-cache determinism**

```powershell
npm run build
node --experimental-strip-types --test-concurrency=1 --test tests/integration/determinism.test.ts
```

Expected: exit 0 and no byte-stability diff.

- [ ] **Step 2: Validate golden MCP responses**

```powershell
npm run test:golden
```

Expected: exit 0; any committed golden delta is limited to a response directly changed by an approved plan.

- [ ] **Step 3: Run the full repository suite**

```powershell
npm test
```

Expected: exit 0. A digest that mentions passing TAP summaries does not override the process exit code.

- [ ] **Step 4: Stop on any shared-gate failure**

If Steps 1–3 fail, persist/query the SDL runtime artifact and send exact command, exit code, artifact handle, boundary, and next action to the root-workspace backlog owner. That owner records it in `BACKLOG.md` and leaves the related checkbox unchecked. Do not proceed to the external smoke or weaken an assertion or threshold.

### Task 5: Consume the one bounded external smoke

- [ ] **Step 1: Execute the benchmark plan's clean-state preparation and cold smoke**

Follow Chunk 4, Task 6 Steps 3–6 in `2026-07-09-external-benchmark-isolation.md` verbatim, including the absent-name preflight and default-DB before/after fingerprints. The sole measurement command is:

```powershell
npm run benchmark:external -- --repo-id scip-io --out-dir .benchmark/external/scip-io-cold-smoke-v1 --cache-mode cold --repeats 1
```

Expected green result: the measurement exits 0, `results.json.passed === true`, the after-fingerprint is captured even if measurement fails, and the stable artifact name is used once. Do not rerun into the same directory, delete evidence, or edit thresholds on failure.

- [ ] **Step 2: Require the persisted integrity proof**

Run the exact `benchmark:external:verify` command from benchmark-plan Task 6 Step 6. Expected: exit 0 after executable validation of target/ref/commit, clean flags, cold semantics, complete repeat count, relative containment, prohibited fields, every declared artifact/hash, strict threshold evidence, and byte-identical default-DB before/after families.

- [ ] **Step 3: Complete the benchmark plan's status-note handoff**

On green, commit the exact artifact path, manifest hash, target commit, cache mode, repeat count, and pass state to the token-economy note. On failure, preserve the artifact, record the exact boundary/next action, and keep the benchmark backlog item unchecked.

### Task 6: Reconcile the authoritative local backlog

**Files:**
- Update locally: `BACKLOG.md`

- [ ] **Step 1: Re-read the whole backlog through SDL**

Confirm every existing section and item is present before editing. Do not replace the queue from memory.

- [ ] **Step 2: Reconcile user-facing correctness items**

Mark these complete only when their focused and shared gates passed:

- Correct Claude Code MCP setup output.
- Support bounded bracket character classes in watcher/scanner ignore globs.

Under each, record the actual focused-test and final-suite artifact handles or durable commit/test evidence.

- [ ] **Step 3: Reconcile token-economy work without closing the deferred card task**

Mark “Reconcile the token-economy status note” complete after its note commit.

Keep “Finish residual token-economy cleanup” unchecked because it remains a parent with unfinished work. Set its children to:

- `[x]` model-facing `code.needWindow` approval/downgrade field cleanup;
- `[x]` `usage.stats.formattedSummary` model/text deduplication;
- `[ ]` profile `buildCardForSymbol` CPU/allocation cost and prove a meaningful gain before removing canonical fields.

- [ ] **Step 4: Reconcile benchmark status from persisted results**

Mark reproducible external benchmark validation complete only when `.benchmark/external/scip-io-cold-smoke-v1/results.json` is green and the executable verifier passed, including default-DB identity. Record the manifest and threshold hashes and that source thresholds were unchanged. Otherwise leave it unchecked with exact command, exit code, runtime/artifact handle, failed boundary, and next action.

- [ ] **Step 5: Preserve SymbolEmbedding follow-up work**

Keep the parent compatibility-schema retirement item unchecked. Add/check subitems as follows:

- `[x]` harden m007 and add forward remediation m021 with real rollback/race/version-path proof;
- `[x]` deprecate but retain the exported compatibility writer;
- `[ ]` validate persisted databases across an authorized release boundary;
- `[ ]` drop the compatibility table idempotently only after that evidence;
- `[ ]` remove the deprecated writer only in the same announced compatibility boundary.

State explicitly that old rows already deleted by the shipped unsafe m007 require backup recovery and cannot be reconstructed by m021.

- [ ] **Step 6: Close the retrieval-path investigation but retain product work**

Mark the current “Decide whether `sdl.context` should support document-heavy planning tasks” investigation complete because the supported targeted `sdl.file.read` path is documented.

Add a separate unchecked product item for first-class document entities, Markdown section indexing, ranking, citations, determinism fixtures, and a planning-task benchmark. Do not represent documentation as first-class indexing.

- [ ] **Step 7: Leave language, release, and graph-recovery decisions unchecked**

Preserve the provider-first language-demand/tooling item and conditional release-boundary item exactly as future work. Also preserve the operational item for backup-aware repair or rebuild of the corrupted default LadybugDB graph; isolated implementation graphs do not satisfy its completion criterion. Do not select a language, version, publication action, or destructive graph recovery in this batch.

- [ ] **Step 8: Assign the successful backlog write and verify the authoritative result**

Only the root-workspace owner writes the successful status edits from Steps 2–7. After the write, that owner re-reads the complete `BACKLOG.md` through SDL and confirms every completed item, every retained unchecked item, the four-field evidence for any failure, and the corrupted-graph recovery item are present. A subagent may propose text but must not write the root-workspace backlog.

- [ ] **Step 9: Validate local-only continuity**

```powershell
git check-ignore -q BACKLOG.md
git status --short
```

Expected: the ignore check exits 0, the final SDL backlog readback matches the intended statuses, and `BACKLOG.md` does not appear in status. If a tracked implementation/doc change remains, resolve it before completion.

### Task 7: Final evidence and handoff

- [ ] **Step 1: Remove only temporary test/edit artifacts**

Each test suite must remove its own named temporary directories. Remove only edit-backup paths explicitly captured by the individual plans after verifying each lies in the implementation worktree; if no paths were captured, delete nothing. Preserve the pinned checkout, external benchmark evidence, both default-DB fingerprint files, and the complete corrupted `data/sdl-mcp-graph.lbug*` family. Do not run broad cleanup against pre-existing data and do not attempt graph recovery in this batch.

- [ ] **Step 2: Run final lightweight repository checks**

```powershell
git diff --check
git diff --cached --check
git status --short
```

Expected: both diff checks exit 0 and status is clean.

- [ ] **Step 3: Produce the completion summary**

Report:

- commits by track;
- focused/shared gate results and artifact handles;
- LadybugDB expert approval;
- external smoke result, executable-verifier success, manifest hash, threshold source/copy hashes, and persisted artifact hashes;
- byte-for-byte identity of the default DB family from the before/after fingerprints;
- the final SDL readback of `BACKLOG.md`, including the retained corrupted-graph recovery item;
- backlog items completed;
- every remaining unchecked backlog item and its next prerequisite;
- explicit confirmation that no release or language was added.

Do not claim a failed/unchecked track complete.
