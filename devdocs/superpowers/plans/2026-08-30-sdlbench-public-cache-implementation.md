# SDLBench Cache Hygiene Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents are available) or superpowers:executing-plans to implement this plan. Track every checkbox.

**Goal:** Update the active sdlbench harness so it measures SDL-MCP's current tool-discovery workflow and reports provider-observed prompt-cache hit rate and cache discount savings for every claim-bearing benchmark variant.

**Architecture:** Remove the obsolete benchmark-only SDL workflow files, skill-loading hook, force-SDL hook, and duplicated prompt guidance. Reuse the Codex and OpenCode provider session usage already captured by SDLBench; derive cache statistics beside each session record, aggregate them by variant, and compare matched behavior runs. Keep raw token savings, cache reuse, discounted cost, correctness, and coverage as separate metrics.

**Tech Stack:** Node.js ESM, node:test, JSONL SessionRecord files, Codex session JSONL, OpenCode SQLite usage, browser-native viewer modules.

---

## Scope And Safety

- Implementation scope is sdlbench/** plus this plan.
- Do not modify scripts/, src/benchmark/, benchmarks/, root benchmark tests, or .github/workflows/ci.yml.
- Do not add a cache simulator. The active harness already captures provider usage, which is stronger evidence.
- Do not redefine tokens.total or the headline raw-token claim. Cached reads are still input tokens; caching changes price, not raw token count.
- Fixture records stay non-claim-bearing.
- CRG and Repomix are dry-run declarations, not executable adapters. Generic tests must cover arbitrary competing variants, but no benchmark claim may imply those products ran until real commands and context boundaries exist.
- Planning, implementation, and fixture tests do not require index refresh. Claim-bearing SDL behavior runs reindex copied benchmark fixtures and require explicit user approval in the turn that runs them.

## File Map

- Modify sdlbench/src/sdlbench.mjs: remove obsolete reinforcement, save cache metrics, aggregate by variant, and pair baseline against every executed non-baseline variant.
- Modify sdlbench/src/agents/opencode.mjs: preserve and document its cache read/write decomposition.
- Modify sdlbench/src/claim-gates.mjs and sdlbench/src/cli.mjs: gate one explicit target variant, defaulting to SDL.
- Modify sdlbench/src/scaling.mjs: pair every requested product with baseline.
- Modify sdlbench/viewer/app.mjs and sdlbench/viewer/index.html: expose cache coverage, hit rate, and discount savings.
- Modify sdlbench/tests/sdlbench.test.mjs: add integrity, accounting, generic-product, claims, scaling, and viewer coverage.
- Modify sdlbench/README.md and sdlbench/docs/{session-record,claims,opencode}.md.
- Regenerate only applicable sdlbench/results evidence. Do not touch old-harness traces.

## Chunk 1: Current SDL Workflow Integrity

### Task 1: Remove benchmark-only SDL instructions

**Files:**
- Modify sdlbench/src/sdlbench.mjs
- Test sdlbench/tests/sdlbench.test.mjs

- [x] **Step 1: Write the failing behavior-integrity test**

Extend the existing SDL behavior test. Assert that the run root does not contain AGENTS.md, SDL.md, or .codex/hooks.json. Read record.artifacts.promptPath and assert it contains the task but not Use SDL-MCP, sdl.context, sdl.workflow, or workflow skill. Keep the existing assertion that artifacts.sdl.transport is http.

- [x] **Step 2: Verify the test fails**

Run:

~~~powershell
node --test --test-name-pattern="SDL behavior mode exposes a live MCP server" sdlbench/tests/sdlbench.test.mjs
~~~

Expected: FAIL because the harness currently installs those files/hooks and repeats SDL workflow guidance in the prompt.

- [x] **Step 3: Remove the obsolete reinforcement**

Delete the behavior-run call to installSdlBenchmarkReinforcement. Delete installSdlBenchmarkReinforcement and sdlBenchmarkInstructions, then remove imports made unused by that deletion.

Do not replace them with another hook, skill, file, or prompt. The normal MCP tool surface is the workflow-discovery mechanism under test.

- [x] **Step 4: Render a neutral non-baseline prompt**

Keep task.context.raw only for the baseline. For every non-baseline variant, render only the task and the neutral edit instruction:

~~~js
function promptContextForVariant(task, variant) {
  return variant === "baseline" ? task.context.raw : "";
}

function renderAgentPrompt(task, variant) {
  const context = promptContextForVariant(task, variant);
  return [
    "Task: " + task.taskId,
    task.prompt,
    context ? "Context:\n\n" + context : "",
    "Edit this repository in place. Keep changes limited to the task.",
  ].filter(Boolean).join("\n\n");
}
~~~

Keep promptContextForVariant because countSessionTokens also calls it. This applies the same prompt boundary to SDL and any real competing product.

- [x] **Step 5: Run integrity and sterility tests**

~~~powershell
node --test --test-name-pattern="SDL behavior mode|sterile temporary CODEX_HOME|sterility inspection" sdlbench/tests/sdlbench.test.mjs
~~~

Expected: PASS. The live MCP configuration remains available, while benchmark-only workflow material is absent.

- [x] **Step 6: Commit**

~~~powershell
git add sdlbench/src/sdlbench.mjs sdlbench/tests/sdlbench.test.mjs
git commit -m "fix(sdlbench): measure natural SDL tool discovery"
~~~

## Chunk 2: Provider Cache Accounting

### Task 2: Save normalized cache metrics on SessionRecord v3

**Files:**
- Modify sdlbench/src/sdlbench.mjs
- Modify sdlbench/src/agents/opencode.mjs
- Test sdlbench/tests/sdlbench.test.mjs

- [x] **Step 1: Write failing cache-accounting tests**

Export computeCacheMetrics from sdlbench.mjs. Test this provider-backed example:

~~~js
const result = computeCacheMetrics({
  tokens: {
    input: 1000,
    cachedInput: 800,
    cachedWriteInput: 100,
    usageSource: "opencode_session_usage",
  },
  cost: {
    inputPerMTok: 10,
    cachedInputPerMTok: 2,
    cacheWriteInputPerMTok: 10,
  },
});
assert.equal(result.hitPercent, 80);
assert.equal(result.discountSavingsUsd, 0.0064);
assert.equal(result.discountSavingsPercent, 64);
~~~

Also test:
- tiktoken records return available false with reason provider-usage-unavailable;
- zero input returns zero percentages;
- read plus write never exceeds input;
- no result contains NaN or Infinity.

- [x] **Step 2: Verify the tests fail**

~~~powershell
node --test --test-name-pattern="cache accounting|cached-input and reasoning pricing" sdlbench/tests/sdlbench.test.mjs
~~~

Expected: FAIL because schema v2 has no record.cache and cost has no explicit cache-write line.

- [x] **Step 3: Decompose input pricing once**

In estimateCost:
- bound cachedInput to input;
- bound cachedWriteInput to the remaining input;
- calculate uncachedInput as input minus both;
- default cacheWriteInputPerMTok to inputPerMTok;
- return cacheWriteInputUsd and cacheWriteInputPerMTok;
- include each input bucket exactly once in totalUsd.

The full-rate write default is conservative and preserves current OpenCode totals until a verified write-specific rate is configured.

- [x] **Step 4: Implement computeCacheMetrics**

The provider-backed object has exactly these fields:

~~~text
available
source
inputTokens
readTokens
writeTokens
uncachedTokens
hitPercent
uncachedEquivalentInputUsd
billedInputUsd
discountSavingsUsd
discountSavingsPercent
~~~

Use provider pricing to compare actual input cost against charging every input token at the normal rate. Never label readTokens as raw tokens saved.

Treat cache telemetry as available only when tokens.usageSource exists and the token object explicitly owns cachedInput or cachedWriteInput. This preserves valid zero-hit sessions without mislabeling a future provider adapter that reports usage but no cache fields. Otherwise return:

~~~js
{ available: false, reason: "provider-usage-unavailable" }
~~~

- [x] **Step 5: Attach cache data and bump the schema**

Build cost once, derive cache once, and save both on every record. Set SCHEMA_VERSION to 3. Fixture and imported records save the explicit unavailable object. Codex and OpenCode behavior records save provider-observed metrics, including valid zero-hit sessions.

- [x] **Step 6: Preserve OpenCode's normalized input invariant**

Keep tokens.input as total provider input and cachedInput/cachedWriteInput as subsets. Add one concise explanatory comment above tokensFromOpencodeSessionCounts. Do not add another adapter layer.

- [x] **Step 7: Extend existing behavior tests**

For both Codex and OpenCode behavior records, assert:
- cache.available is true;
- cache.source equals tokens.usageSource;
- cache.readTokens equals tokens.cachedInput;
- cache.writeTokens equals tokens.cachedWriteInput or zero;
- hitPercent uses readTokens divided by inputTokens;
- discountSavingsUsd is non-negative.

- [x] **Step 8: Run focused tests**

~~~powershell
node --test --test-name-pattern="cache accounting|Codex tiktoken session counts|opencode records session usage|cached-input and reasoning pricing" sdlbench/tests/sdlbench.test.mjs
~~~

Expected: PASS.

- [x] **Step 9: Commit**

~~~powershell
git add sdlbench/src/sdlbench.mjs sdlbench/src/agents/opencode.mjs sdlbench/tests/sdlbench.test.mjs
git commit -m "feat(sdlbench): record provider cache efficiency"
~~~

## Chunk 3: Product Comparison And Reporting

### Task 3: Aggregate cache statistics without changing claims

**Files:**
- Modify sdlbench/src/sdlbench.mjs
- Modify sdlbench/src/claim-gates.mjs
- Modify sdlbench/src/cli.mjs
- Test sdlbench/tests/sdlbench.test.mjs

- [x] **Step 1: Write a failing generic-product test**

Create passed behavior records for baseline, SDL, and a fake competitor with the same task, agent, model, and execution mode. Assert:
- summary.paired contains one SDL row and one competitor row;
- each byVariant bucket has cache totals;
- available cache pairs expose baseline/product values and deltas;
- unavailable cache remains in raw-token comparisons but is marked non-comparable;
- headlineClaim remains median paired savings on tasks both solved;
- an extreme competitor delta does not change the backward-compatible top-level pairedMedianDeltaPct for SDL.

- [x] **Step 2: Verify it fails**

~~~powershell
node --test --test-name-pattern="generic product cache|pass-gated paired ledger" sdlbench/tests/sdlbench.test.mjs
~~~

Expected: FAIL because buildPairedDeltas currently reads only slot.sdl.

- [x] **Step 3: Aggregate weighted cache statistics**

For each variant and execution-mode bucket, sum only cache.available records. Return:

~~~text
totalSessions
availableSessions
coveragePercent
inputTokens
readTokens
writeTokens
hitPercent
discountSavingsUsd
discountSavingsPercent
~~~

Derive percentages from summed numerators and denominators. Do not average session percentages.

- [x] **Step 4: Pair baseline with every executed product**

Within each existing task/agent/model/execution-mode key, pair baseline with every non-baseline record. Use generic variant and productTok fields. Retain sdlVariant and sdlTok only on SDL rows for old readers. Keep pass-gating unchanged. Keep the backward-compatible top-level pairedMedianDeltaPct scoped to SDL rows, and expose per-product medians under deltas[variant], so adding a competitor cannot silently redefine the SDL headline.

Add a nested cache comparison only when both sides are provider-backed. Otherwise return comparable false and a reason.

- [x] **Step 5: Keep claim validation product-specific**

Change validateClaims to accept variant, defaulting to sdl, and filter paired rows before existing raw-token, coverage, and fairness gates run. Pass --variant from the CLI.

Cache fields must never change claim pass/fail or process exit status.

- [x] **Step 6: Test claim isolation**

Use a passing SDL row and a competitor row with extreme cache and token values. Assert the default evaluates only SDL, an explicit competitor variant evaluates only the competitor, and changing cache fields alone changes neither result.

- [x] **Step 7: Run analysis and claim tests**

~~~powershell
node --test --test-name-pattern="analyzeSessions|validateClaims|generic product cache" sdlbench/tests/sdlbench.test.mjs
~~~

Expected: PASS.

- [x] **Step 8: Commit**

~~~powershell
git add sdlbench/src/sdlbench.mjs sdlbench/src/claim-gates.mjs sdlbench/src/cli.mjs sdlbench/tests/sdlbench.test.mjs
git commit -m "feat(sdlbench): compare cache hygiene by product"
~~~

### Task 4: Make scaling and viewer output product-generic

**Files:**
- Modify sdlbench/src/scaling.mjs
- Modify sdlbench/viewer/app.mjs
- Modify sdlbench/viewer/index.html
- Test sdlbench/tests/sdlbench.test.mjs

- [x] **Step 1: Write failing scaling and viewer tests**

Run scaling with baseline,sdl,competitor and assert one baseline-paired row per non-baseline variant and size class.

Extend buildChartModel tests so cacheEfficiency contains weighted hit rate, telemetry coverage, and summed discount savings for SDL and the fake competitor.

- [x] **Step 2: Verify the tests fail**

~~~powershell
node --test --test-name-pattern="scaling|buildChartModel|viewer parses" sdlbench/tests/sdlbench.test.mjs
~~~

Expected: FAIL because scaling and viewer pairing are SDL-specific and there is no cache series.

- [x] **Step 3: Generalize scaling**

Build the baseline task map once per size class. Emit one paired row for every requested non-baseline variant. Preserve current SDL compatibility fields on the SDL row.

- [x] **Step 4: Add one cache-efficiency viewer series**

Reuse record.cache; do not reimplement provider pricing in the browser. Add a cacheEfficiency series and a single chart. Show hit percent, discount dollars saved, and telemetry coverage or n/a in the product matrix.

- [x] **Step 5: Run scaling and viewer tests**

~~~powershell
node --test --test-name-pattern="scaling|buildChartModel|viewer" sdlbench/tests/sdlbench.test.mjs
~~~

Expected: PASS.

- [x] **Step 6: Commit**

~~~powershell
git add sdlbench/src/scaling.mjs sdlbench/viewer/app.mjs sdlbench/viewer/index.html sdlbench/tests/sdlbench.test.mjs
git commit -m "feat(sdlbench): report cache efficiency across products"
~~~

## Chunk 4: Documentation And Evidence

### Task 5: Document schema v3 and current behavior

**Files:**
- Modify sdlbench/README.md
- Modify sdlbench/docs/session-record.md
- Modify sdlbench/docs/claims.md
- Modify sdlbench/docs/opencode.md

- [x] **Step 1: Define the metrics precisely**

Document:
1. raw paired savings compare tokens.total only when both variants solved the task;
2. cache hit rate is cache.readTokens divided by cache.inputTokens;
3. cache discount savings compare actual input pricing with full-rate input pricing;
4. cache telemetry is available on current Codex and OpenCode behavior paths, not fixture/tiktoken records;
5. cache metrics are report-only.

- [x] **Step 2: Correct workflow setup documentation**

Remove current-behavior statements that SDLBench installs AGENTS.md, SDL.md, hooks, generic SDL guidance, or the workflow skill. State that SDLBench supplies the normal live MCP server and agents discover workflow guidance from its tool surface.

- [x] **Step 3: State competitor status honestly**

All executed variants receive identical record, analysis, scaling, and cache tests. CRG and Repomix remain dry-run declarations until real integrations exist, so they cannot appear in claim-bearing results yet.

- [x] **Step 4: Check for stale text**

~~~powershell
rg -n "benchmark-installed|load-sdl-skill|force-sdl-mcp|generic SDL guidance|Schema v2" sdlbench/README.md sdlbench/docs
~~~

Expected: no stale current-behavior claims. Historical migration notes may mention schema v2.

- [x] **Step 5: Commit**

~~~powershell
git add sdlbench/README.md sdlbench/docs/session-record.md sdlbench/docs/claims.md sdlbench/docs/opencode.md
git commit -m "docs(sdlbench): define prompt cache metrics"
~~~

### Task 6: Verify and regenerate active SDLBench evidence

**Files:**
- Modify sdlbench/results only after successful behavior runs

- [x] **Step 1: Run the isolated suite**

~~~powershell
npm --prefix sdlbench test
~~~

Expected: every sdlbench test passes.

- [x] **Step 2: Run fixture smoke**

Run baseline and SDL fixture variants into a temporary JSONL and analyze it. Assert schemaVersion 3, claimGrade none, and cache.available false on every record. Do not present fixture output as savings evidence.

- [x] **Step 3: Obtain refresh approval, then run matched Codex behavior sessions**

Before starting the SDL behavior run, obtain explicit user approval in the current turn for SDLBench to reindex its copied fixture repositories. Use one fresh output and the same matrix/model:

~~~powershell
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent codex --variant baseline --model gpt-5.5 --behavior --out sdlbench/results/cache-hygiene-codex-paired.jsonl
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent codex --variant sdl --model gpt-5.5 --behavior --out sdlbench/results/cache-hygiene-codex-paired.jsonl
node sdlbench/src/cli.mjs analyze --in sdlbench/results/cache-hygiene-codex-paired.jsonl --out sdlbench/results/cache-hygiene-codex-summary.json
node sdlbench/src/cli.mjs claims --in sdlbench/results/cache-hygiene-codex-paired.jsonl --profile realism --variant sdl
~~~

Expected: provider-backed records, paired raw-token and cache comparisons, and unchanged raw-token claim gates.

- [x] **Step 4: Run matched OpenCode behavior sessions when credentials exist**

Run baseline and SDL with the same OpenCode model. Assert the same schema plus cache read/write metrics. If credentials are unavailable, report the gap; do not substitute estimates.

OpenCode was not run because `NEURALWATT_API_KEY` was unavailable; no estimates were substituted.

- [x] **Step 5: Do not fabricate external-product evidence**

Do not create CRG or Repomix rows from fake records or smoke commands. Once a real integration exists, run the same baseline/product matrix and provider-cache checks.

- [x] **Step 6: Verify scope and formatting**

~~~powershell
git diff --check
git diff --name-only 1d4997b9..HEAD
~~~

Expected: only this plan and sdlbench/**. No old-harness or CI path.

- [x] **Step 7: Commit regenerated evidence separately**

~~~powershell
git add sdlbench/results
git commit -m "bench(sdlbench): refresh cache hygiene evidence"
~~~

Skip this commit when claim-bearing behavior runs cannot complete. Never commit estimator-backed replacement evidence.

The derived summary and claims were committed. The ignored raw Codex transcript remains local because it contains machine-specific absolute paths and fixture-secret strings.
