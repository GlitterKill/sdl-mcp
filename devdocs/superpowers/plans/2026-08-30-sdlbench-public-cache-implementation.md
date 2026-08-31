# SDLBench Public Workflow and Prompt Cache Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SDLBench's internal SDL tool ladder with public MCP sessions and add deterministic plus provider-reported prompt-cache metrics for every benchmark product.

**Architecture:** A shared session runner records one canonical model-input transcript for each product and task. SDL-MCP uses its public `sdl.context` tool through an MCP client; the Traditional baseline implements the same adapter contract without pretending to be an MCP server. Deterministic cache simulation is always computed from saved transcripts, while optional provider usage is imported later and never blocks ordinary benchmark participation.

**Tech Stack:** TypeScript, Node.js 24, `node:test`, `@modelcontextprotocol/sdk`, Zod 4, existing SDL token estimator, JSON benchmark artifacts.

---

## Scope Notes

- Current SDLBench has no configured competing token-saving product beyond SDL-MCP and the Traditional baseline. The repository's “external benchmark” code benchmarks SDL-MCP against external repositories, not external products.
- This plan adds the shared adapter contract and reusable conformance tests now. Any competitor added to SDLBench must implement that contract and run the same conformance/cache suite; this plan does not invent unsupported product commands or response mappings.
- Existing capped context tokens, uncapped Traditional tokens, coverage, precision, recall, and composite scoring remain available. New session-input and cache metrics do not silently redefine the existing `tokens` field.
- Claim-bearing SDL runs use public MCP only. Direct database access may remain for indexing and scoring-oracle construction, but never for selecting or constructing SDL context.
- Do not call `index.refresh` or run `sdl-mcp index` during execution without explicit approval in that turn. Artifact regeneration uses `--skip-index` against a verified prepared index.

## File Map

**Create:**

- `src/benchmark/prompt-cache.ts`: shared cache metric types, deterministic prefix simulation, cold/warm aggregation, percentile summaries.
- `src/benchmark/provider-cache.ts`: provider-usage validation, effective-token pricing math, join/ranking rules.
- `src/benchmark/session-runner.ts`: product adapter contract, canonical prompt assembly, transcript persistence metadata.
- `src/benchmark/product-registry.ts`: the single registration point enumerated by real-world, synthetic, matrix, and conformance tests.
- `src/benchmark/traditional-product-adapter.ts`: Traditional baseline adapter using the shared session contract.
- `src/benchmark/mcp-product-adapter.ts`: MCP SDK client boundary, structured-content projection, SDL `sdl.context` step mapping.
- `scripts/import-benchmark-provider-usage.ts`: post-run provider telemetry importer.
- `tests/unit/benchmark-prompt-cache.test.ts`: deterministic cache formulas and prefix invalidation.
- `tests/unit/benchmark-provider-cache.test.ts`: telemetry validation, pricing, ranking, and unavailable states.
- `tests/unit/benchmark-session-runner.test.ts`: canonical transcript and adapter-independent behavior.
- `tests/integration/benchmark-public-session.test.ts`: public catalog/tool-call behavior and SDL guidance placement.
- `tests/helpers/benchmark-product-adapter-contract.ts`: registry-driven conformance suite for every product.
- `tests/unit/synthetic-benchmark-script.test.ts`: versioned real-world-to-replay-to-synthetic round trip.
- `docs/sdlbench.md`: public SDLBench methodology and cache metric definitions.
- `devdocs/benchmarks/sdlbench-public-cache-results.md`: generated evidence, metric deltas, digests, and reproduction commands.
- `benchmarks/real-world/provider-usage.example.json`: credential-free import example.
- `benchmarks/real-world/cache-baseline.json`: generated deterministic cache floors and catalog digest.
- `benchmarks/real-world/results-current.transcripts.json`: canonical real-world session transcripts used for recomputation.
- `benchmarks/synthetic/results.json`: generated synthetic summary.

**Modify:**

- `src/util/tokenize.ts`: expose unrounded and complete estimated-token counts without changing existing rounded accounting.
- `scripts/real-world-benchmark.ts`: remove internal SDL retrieval and run all products through the registry and shared session runner.
- `scripts/real-world-benchmark-matrix.ts`: aggregate cache metrics per product and preserve product eligibility.
- `scripts/record-trace.ts`: verify persisted transcripts and emit generic product traces with cache summaries.
- `scripts/benchmark.ts`: summarize generic product traces and cache results.
- `scripts/check-benchmark-claims.ts`: hard-gate deterministic cache floors; leave provider metrics report-only.
- `tests/unit/real-world-benchmark-script.test.ts`: assert the public-only SDL path and smoke the runner.
- `tests/unit/real-world-benchmark-matrix.test.ts`: verify registry-complete product/cache aggregation.
- `tests/unit/check-benchmark-claims.test.ts`: verify deterministic cache gates and provider non-gating.
- `package.json`: add the provider-usage import command.
- `.gitignore`: explicitly track the new transcript, synthetic result, and claim-delta artifacts.
- `.github/workflows/ci.yml`: pass the committed cache baseline to SDLBench claims after it is generated.
- `benchmarks/real-world/results-current.json`: regenerate schema 4 results.
- `benchmarks/synthetic/replay-traces.json`: regenerate schema 2 traces.
- `docs/README.md`: link the SDLBench methodology.
- `docs/prompt-cache-hygiene.md`: link guarantees to measured SDLBench fields.
- `docs/benchmark-guardrails.md`: document deterministic versus provider gates.
- `docs/benchmark-baseline-management.md`: document cache baseline updates.

## Chunk 1: Shared Session and Cache Core

### Task 1: Deterministic prompt-cache simulator

**Files:**
- Modify: `src/util/tokenize.ts`
- Create: `src/benchmark/prompt-cache.ts`
- Create: `tests/unit/benchmark-prompt-cache.test.ts`

- [ ] **Step 1: Write failing tests for complete estimated-token boundaries**

Cover first-turn writes, stable-prefix reads, first-byte invalidation, reordered tool keys, zero-input percentages, UTF-8 boundary backtracking, and cold-plus-warm totals.

Add a boundary case where the changed byte falls inside one estimated token. The reusable count must use only complete estimated tokens before the change:

```ts
it("counts only complete estimated tokens before the changed byte", () => {
  const reusablePrefix = '{"tools":["abc';
  assert.notEqual(
    estimateCompleteTokens(reusablePrefix),
    estimateTokens(reusablePrefix),
    "fixture must distinguish floor from ceil",
  );

  const result = simulatePromptCache([
    turn(0, '{"tools":["abcdef"],"messages":[]}'),
    turn(1, '{"tools":["abcXYZ"],"messages":[]}'),
  ]);

  assert.equal(
    result.turns[1].cacheReadTokens,
    estimateCompleteTokens(reusablePrefix),
  );
  assert.equal(
    result.turns[1].totalInputTokens,
    result.turns[1].cacheReadTokens + result.turns[1].cacheWriteTokens,
  );
});
```

Pass explicit `PromptSurfaceInput` segments for the serialized tool catalog, optional first-load workflow guidance, and each model-facing tool result. Assert the simulator reports their exact diagnostic token counts plus reusable-prefix tokens, invalidated-prefix tokens, and reusable-prefix percentage.

- [ ] **Step 2: Run the new test and verify it fails**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/benchmark-prompt-cache.test.ts
```

Expected: FAIL because the simulator and complete-token estimator do not exist.

- [ ] **Step 3: Expose additive token-estimate units**

Refactor the existing estimator without changing its public rounded result:

```ts
export function estimateTokenUnits(text: string): number {
  // Return the existing structural + prose/3.5 calculation before rounding.
}

export function estimateTokens(text: string): number {
  return Math.ceil(estimateTokenUnits(text));
}

export function estimateCompleteTokens(text: string): number {
  return Math.floor(estimateTokenUnits(text));
}
```

This keeps current policy accounting unchanged while giving prefix simulation an explicit complete-estimated-token boundary.

- [ ] **Step 4: Implement cache and surface contracts**

Add:

```ts
export interface PromptSurfaceInput {
  toolCatalog: string;
  workflowGuidance: string | null;
  toolResults: string[];
}

export interface PromptTurnInput {
  canonicalModelInput: string;
  surface: PromptSurfaceInput;
}

export interface PromptSurfaceMetrics {
  toolCatalogTokens: number;
  workflowGuidanceTokens: number;
  toolResultTokens: number;
  reusablePrefixTokens: number;
  invalidatedPrefixTokens: number;
  reusablePrefixPct: number;
}

export interface SimulatedCacheMetrics extends CacheMetrics {
  surface: PromptSurfaceMetrics;
}
```

Compare `canonicalModelInput` UTF-8 bytes, backtrack to a valid UTF-8 boundary with a fatal `TextDecoder`, and count the reusable prefix with `estimateCompleteTokens`. Count each turn's catalog as `estimateTokens(surface.toolCatalog)`, guidance as zero or `estimateTokens(surface.workflowGuidance)`, and tool results as `sum(estimateTokens(result))`; session surface totals are sums across turns and are diagnostic exposures, not an additive partition of total input. Define `invalidatedPrefixTokens` as `sum(max(0, previousTurn.totalInputTokens - currentTurn.cacheReadTokens))`, and `reusablePrefixPct` as `100 * sum(cacheReadTokens) / sum(totalInputTokens)`, or zero for zero input. Use `estimateTokens` for each turn's total input, then:

```ts
const cacheWriteTokens = totalInputTokens - cacheReadTokens;
const effectiveInputTokens = cacheWriteTokens;
const effectiveSavingsTokens = cacheReadTokens;
```

Turn `0` is cold; turns `1..` are warm. Simulated uncached input is zero. Use one private aggregation helper and keep `average`/`percentile` private; export only `summarizeCacheMetrics`.

- [ ] **Step 5: Run focused tests**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/benchmark-prompt-cache.test.ts
```

Expected: PASS with no changes to existing `estimateTokens` results.

- [ ] **Step 6: Commit**

```powershell
git add src/util/tokenize.ts src/benchmark/prompt-cache.ts tests/unit/benchmark-prompt-cache.test.ts
git commit -m "feat: add deterministic benchmark cache metrics"
```

### Task 2: Provider usage normalization and ranking

**Files:**
- Create: `src/benchmark/provider-cache.ts`
- Create: `tests/unit/benchmark-provider-cache.test.ts`

- [ ] **Step 1: Write failing normalization and completeness tests**

Support three explicit usage formats:

```ts
type ProviderUsageFile =
  | NormalizedProviderUsageFile
  | AnthropicProviderUsageFile
  | OpenAiProviderUsageFile;

// Shared envelope fields: provider, model, pricingProfileId,
// fixtureRevision, transcriptSha256, and identified sessions.
```

Anthropic turns use `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and `output_tokens`. OpenAI turns use `input_tokens`, `input_tokens_details.cached_tokens`, and `output_tokens`. Normalized turns use the spec's total/uncached/read/write fields.

Test:

- Anthropic total input equals uncached + creation + read
- OpenAI reads come from `cached_tokens`, uncached is total minus reads, writes are zero
- duplicate, negative, non-finite, or inconsistent totals fail
- a known session with one missing expected turn fails as partial telemetry
- unknown sessions or runs fail instead of being ignored
- product identity must exactly match the recorded transcript session
- conflicting fixture revision, transcript digest, provider, model, or pricing-profile metadata fails
- no telemetry file for a session produces `unavailable`
- pricing may make cold savings negative
- matching provider/model/profile records rank together
- valid cross-product mismatches remain unranked with a reason
- dollar savings never determine rank order

- [ ] **Step 2: Run the new test and verify it fails**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/benchmark-provider-cache.test.ts
```

Expected: FAIL because the provider module does not exist.

- [ ] **Step 3: Implement the Zod union and normalization**

Use the installed Zod dependency at the import trust boundary. Normalize all three formats to:

```ts
interface NormalizedProviderTurn {
  turnIndex: number;
  totalInputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}
```

Reject OpenAI `cached_tokens > input_tokens`, zero/negative normal input price, unknown sessions/runs/turns, duplicate joins, product identity mismatches, and any fixture revision or transcript digest that differs from the recorded run. For an expected run, zero supplied turns means provider telemetry is `unavailable`; one through `expectedTurns - 1` supplied turns is partial telemetry and rejects. Provider, model, pricing profile ID, and pricing-profile values must be consistent across every turn in one imported run.

Compute effective input with versioned profile ratios:

```ts
const effectiveInputTokens =
  uncachedInputTokens +
  cacheReadTokens *
    (profile.cacheReadUsdPerMillion / profile.normalInputUsdPerMillion) +
  cacheWriteTokens *
    (profile.cacheWriteUsdPerMillion / profile.normalInputUsdPerMillion);
```

- [ ] **Step 4: Implement join and ranking**

Export `parseProviderUsageFile`, `normalizeProviderUsage`, `attachProviderUsage`, and `rankProviderCacheResults`. `attachProviderUsage(transcriptArtifact, transcriptSha256, usageFile)` treats the saved transcript plus its trusted result-record digest as the complete expected session/turn set. Unknown or identity-conflicting records reject; an expected run with no records is `unavailable`; an expected run with only some records rejects as partial.

Join only on `productId + taskId + runId + turnIndex`. Rank only identical provider, model, profile ID, and profile values. Sort on whole-session `effectiveSavingsPct`; persist dollar savings as informational.

- [ ] **Step 5: Run focused tests**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/benchmark-provider-cache.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/benchmark/provider-cache.ts tests/unit/benchmark-provider-cache.test.ts
git commit -m "feat: normalize provider cache usage"
```

### Task 3: Replayable session runner, adapters, and registry

**Files:**
- Create: `src/benchmark/session-runner.ts`
- Create: `src/benchmark/mcp-product-adapter.ts`
- Create: `src/benchmark/traditional-product-adapter.ts`
- Create: `src/benchmark/product-registry.ts`
- Modify: `scripts/real-world-benchmark.ts`
- Create: `tests/helpers/benchmark-product-adapter-contract.ts`
- Create: `tests/unit/benchmark-session-runner.test.ts`
- Create: `tests/integration/benchmark-public-session.test.ts`
- Modify: `tests/unit/real-world-benchmark-script.test.ts`

- [ ] **Step 1: Write the exact transcript schema tests**

The persisted artifact must contain:

```ts
interface BenchmarkTranscriptArtifact {
  schemaVersion: 1;
  assemblyVersion: 1;
  serializationVersion: 1;
  encoding: "utf-8";
  tokenizer: { id: "sdl-estimateTokens"; version: 1 };
  fixtureRevision: string;
  sessions: Array<{
    product: { id: string; version: string; adapterVersion: string };
    taskId: string;
    runId: string;
    toolCatalog: unknown[];
    workflowGuidance: string | null;
    turns: Array<{
      turnIndex: number;
      request: BenchmarkStepInput;
      toolCalls: Array<{
        callId: string;
        name: string;
        arguments: Record<string, unknown>;
      }>;
      toolResults: Array<{
        callId: string;
        modelFacingContent: string;
      }>;
      canonicalModelInput: string;
      files: string[];
      symbolIds: string[];
    }>;
  }>;
}
```

Assert every result references an existing call ID exactly once, multiple calls/results retain order, and deterministic product/task/turn/call ordering produces the exact canonical top-level order `assemblyVersion`, `tools`, `messages`.

- [ ] **Step 2: Write a disk round-trip reproduction test**

Define the trusted digest boundary explicitly:

```ts
writeBenchmarkTranscriptArtifact(
  path: string,
  artifact: BenchmarkTranscriptArtifact,
): Promise<{ sha256: string }>;

loadBenchmarkTranscriptArtifact(
  path: string,
  options: { expectedSha256: string },
): Promise<BenchmarkTranscriptArtifact>;
```

The writer hashes the exact UTF-8 artifact bytes and the real-world result record stores that returned SHA-256 beside the transcript path. The loader's `expectedSha256` comes from that result record, not from the transcript file itself.

Write an artifact to a temporary file, load it with the returned digest, and recompute whole-session, cold, warm, per-turn, and surface metrics using only saved artifact content. Change one byte after writing and assert digest verification fails before parsing or metric acceptance.

- [ ] **Step 3: Write the registry-driven adapter conformance test**

Define:

```ts
export interface BenchmarkProductRegistration {
  id: string;
  create(context: BenchmarkProductContext): Promise<BenchmarkProductAdapter>;
}

export const BENCHMARK_PRODUCT_REGISTRATIONS: readonly BenchmarkProductRegistration[];
```

The test enumerates this production registry. For every registration it must verify stable identity, two byte-identical catalog loads, deterministic normal and completion step calls with byte-identical repeated model-facing results, clean close, transcript creation, and simulated metrics.

A future competitor is not registered until added to this array, so the same test automatically covers it.

- [ ] **Step 4: Write characterization and public-path tests before adapters**

In `tests/unit/real-world-benchmark-script.test.ts`, freeze one existing Traditional fixture's search/read outputs, context cap, selected files, and capped/uncapped token counts. This must pass before extraction and remain unchanged afterward.

Then add the public-path integration tests:

Using `MCPServer`, SDK `Client`, and `InMemoryTransport`, assert:

- repeated catalogs are byte-identical
- canonical workflow guidance occurs exactly once on the first tool
- a normal turn sends exactly one `sdl.context` call with the required arguments
- a completion turn also sends exactly one `sdl.context` call
- two unchanged calls return byte-identical model-facing results
- adapter failure propagates and no legacy/internal fallback runs
- no installed workflow skill is loaded

- [ ] **Step 5: Run unit and integration tests and verify they fail**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/benchmark-session-runner.test.ts tests/unit/real-world-benchmark-script.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/benchmark-public-session.test.ts
```

Expected: FAIL because session I/O, adapters, and registry do not exist.

- [ ] **Step 6: Implement canonical assembly and artifact I/O**

Use:

```ts
export function assembleCanonicalModelInput(params: {
  tools: unknown[];
  messages: BenchmarkMessage[];
}): string {
  return JSON.stringify({
    assemblyVersion: 1,
    tools: params.tools,
    messages: params.messages,
  });
}
```

Keep run IDs and generated timestamps outside canonical inputs. Export `runRegisteredProductsForTask(registrations, context, steps)` from `session-runner.ts`; it creates every adapter through the supplied registrations and records identical ordered normal/completion step inputs for each product. Implement the exact writer/loader signatures from Step 2. Validate schema, trusted digest, metadata versions, reference integrity, and deterministic order before recomputing cache metrics.

- [ ] **Step 7: Implement the MCP adapter**

Use SDK `Client` and `StdioClientTransport`, with a small injected `McpClientLike` for tests. Prefer `structuredContent`; use text content only as fallback; never serialize the whole MCP envelope.

The generic transcript supports multiple public calls, but the SDL mapper issues exactly one public call per normal or completion turn:

```ts
{
  name: "sdl.context",
  arguments: {
    repoId,
    taskType,
    taskText,
    budget: { maxTokens },
    focusPaths,
    focusSymbols,
    responseMode: "inline",
    refsMode: "off",
  },
}
```

Extract coverage evidence only from public `evidence`.

- [ ] **Step 8: Extract Traditional and implement the production registry**

Move only the existing Traditional baseline search/read behavior from `scripts/real-world-benchmark.ts` into `TraditionalProductAdapter`; leave the SDL ladder for Task 4 to remove. Do not duplicate the behavior or grow the 2,748-line script. Register Traditional and SDL-MCP in `BENCHMARK_PRODUCT_REGISTRATIONS`, sorted by ID. The registry rejects duplicate IDs.

- [ ] **Step 9: Run focused tests**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/benchmark-session-runner.test.ts tests/unit/real-world-benchmark-script.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/benchmark-public-session.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```powershell
git add src/benchmark/session-runner.ts src/benchmark/mcp-product-adapter.ts src/benchmark/traditional-product-adapter.ts src/benchmark/product-registry.ts scripts/real-world-benchmark.ts tests/helpers/benchmark-product-adapter-contract.ts tests/unit/benchmark-session-runner.test.ts tests/unit/real-world-benchmark-script.test.ts tests/integration/benchmark-public-session.test.ts
git commit -m "feat: record replayable public benchmark sessions"
```

## Chunk 2: Real-World and Matrix Integration

### Task 4: Replace the internal SDL ladder in the real-world runner

**Files:**
- Modify: `scripts/real-world-benchmark.ts`
- Modify: `tests/unit/real-world-benchmark-script.test.ts`
- Modify: `tests/integration/benchmark-public-session.test.ts`

- [ ] **Step 1: Add failing source-boundary and behavioral tests**

Keep the existing glob `exclude`, compatibility-index, and matrix smoke assertions. Add source assertions rejecting `handleSymbolGetCard`, `buildSlice`, `generateSymbolSkeleton`, and “tool-ladder workflow.”

Add behavior tests around the shared task runner, not regexes alone:

- a normal workflow step invokes only the registered SDL adapter and records one public `sdl.context` turn
- a completion step is offered to every registered adapter when required targets remain; SDL records one public `sdl.context` call
- an adapter error rejects the task with no internal or legacy fallback
- the returned product IDs exactly equal `BENCHMARK_PRODUCT_REGISTRATIONS`
- every product result has catalog metadata, a transcript reference, and simulated metrics

- [ ] **Step 2: Run tests and verify they fail**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/real-world-benchmark-script.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/benchmark-public-session.test.ts
```

Expected: FAIL because the internal ladder remains and the script does not use the registry.

- [ ] **Step 3: Add schema 4 product/session fields**

Set `benchmarkVersion` to `"4.0"`. Keep `baseline`, `sdl`, natural/post-completion coverage, capped `tokens`, `tokensUncapped`, precision, recall, and existing comparisons.

Add:

```ts
products: Record<string, {
  product: { id: string; version: string; adapterVersion: string };
  session: BenchmarkSessionSummary;
  metrics: ApproachMetrics;
  cache: {
    simulated: SimulatedCacheMetrics;
    provider: ProviderCacheResult;
  };
}>
```

Project Traditional and SDL-MCP metrics into the legacy fields so old report readers keep working during migration. Add separate `sessionInputTokens`; do not redefine legacy context tokens.

- [ ] **Step 4: Run every registered product through the shared runner**

Create adapters only through `BENCHMARK_PRODUCT_REGISTRATIONS`. Call the `runRegisteredProductsForTask` exported by `session-runner.ts` with identical ordered normal and completion inputs, task text, context budget, focus paths, and focus symbols.

Map categories deterministically:

```ts
const TASK_TYPE_BY_CATEGORY = {
  "code-review": "review",
  "feature-review": "review",
  "bug-fix": "debug",
  "test-triage": "debug",
  performance: "debug",
  understanding: "explain",
  "impact-analysis": "explain",
  "code-change": "implement",
} as const;
```

SDL context selection comes only from public `evidence`. Database reads remain scoring-oracle inputs and must not add context.

- [ ] **Step 5: Route completion through every registered adapter**

When required targets remain, pass the same final `BenchmarkStepInput` with `phase: "completion"` to every registered adapter through `runRegisteredProductsForTask`:

```ts
{
  phase: "completion",
  taskText: `Complete benchmark context for missing targets: ...`,
  focusPaths: missingFiles,
  focusSymbols: missingSymbols,
  maxTokens: completionBudget,
}
```

`TraditionalProductAdapter` preserves its characterized completion behavior. SDL maps this input to exactly one public `sdl.context` call. Every future registration must pass the shared normal/completion conformance test. Completion contributes to post-completion coverage and cache totals, not natural coverage.

- [ ] **Step 6: Persist, reload, and verify transcripts**

For `--out <name>.json`, write `<name>.transcripts.json`. Before writing the result summary:

1. reload the transcript artifact
2. verify SHA-256
3. verify assembly, serialization, tokenizer, and fixture versions
4. recompute whole-session, cold, warm, per-turn, and surface metrics
5. compare recomputed metrics byte-for-byte with the result

Fail the run on any mismatch.

- [ ] **Step 7: Run focused tests and one smoke**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/real-world-benchmark-script.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/benchmark-public-session.test.ts
node scripts/real-world-benchmark-matrix.ts --matrix benchmarks/real-world/matrix.json --config benchmarks/real-world/benchmark.config.json --out-dir .tmp/sdlbench-public-smoke --limit-runs 1 --skip-index
```

Expected: tests PASS; smoke produces schema 4 results and verified transcript artifacts. If no verified prepared index exists, stop for explicit refresh authorization.

- [ ] **Step 8: Commit**

```powershell
git add scripts/real-world-benchmark.ts tests/unit/real-world-benchmark-script.test.ts tests/integration/benchmark-public-session.test.ts
git commit -m "refactor: benchmark SDL through public MCP"
```

### Task 5: Matrix aggregation, provider importer, and claim checks

**Files:**
- Create: `scripts/import-benchmark-provider-usage.ts`
- Create: `benchmarks/real-world/provider-usage.example.json`
- Modify: `scripts/real-world-benchmark-matrix.ts`
- Modify: `scripts/check-benchmark-claims.ts`
- Modify: `tests/unit/real-world-benchmark-matrix.test.ts`
- Modify: `tests/unit/check-benchmark-claims.test.ts`
- Modify: `tests/unit/benchmark-provider-cache.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing registry-complete matrix tests**

Run the shared session runner with a test registry containing Traditional, SDL-MCP, and a fake competitor registration. Do not inject product-shaped JSON directly.

Assert every registered product receives catalog/transcript/cache output and aggregate fields for average, p25, p50, minimum, cold/warm totals, effective tokens, and ranked/unranked provider counts.

Assert aggregate product IDs exactly equal registry IDs; adding a registration without result/baseline coverage must fail.

- [ ] **Step 2: Implement generic product aggregation**

Aggregate sorted product IDs and reuse `summarizeCacheMetrics`. Keep SDL-versus-Traditional compatibility fields. Missing provider telemetry remains in quality/raw/simulated reports but out of provider rankings.

Reject any product session whose transcript digest or assembly/serialization/tokenizer/fixture metadata cannot be reloaded and verified.

- [ ] **Step 3: Write failing importer CLI tests**

Spawn the importer against temporary artifacts. Verify source results remain unchanged, `--out` receives provider metrics, partial/unknown turns fail, and repeated imports are byte-stable.

Include available provider telemetry with deliberately extreme pricing and savings. Assert it cannot alter raw-token rankings, simulated rankings, claim pass/fail, or process exit status.

- [ ] **Step 4: Implement the post-run importer**

Add:

```json
"benchmark:import-usage": "node scripts/import-benchmark-provider-usage.ts"
```

Command:

```text
npm run benchmark:import-usage -- --results <schema-4-results.json> --usage <provider-usage.json> --out <results-with-provider-usage.json>
```

Load saved session keys, normalize usage, attach provider metrics, recompute provider aggregates, and write a new file. Reject raw prompts, tool results, API keys, and provider request IDs.

- [ ] **Step 5: Write failing deterministic claim tests**

The cache baseline contract stores:

- schema, assembly, serialization, tokenizer, and fixture revisions
- the exact registered product ID set
- catalog SHA-256 plus ordered catalog-entry digests per product
- ordered canonical turn-input digests per product/task/run
- SDL workflow guidance occurrence count
- simulated p25/p50 hit and effective-savings floors per product

Tests fail on a product-set mismatch, metadata mismatch, digest mismatch, guidance count mismatch, or simulated metric below floor. Catalog-drift errors name the first differing `catalog[index]`; transcript-drift errors name the first differing `taskId/runId/turn[index]` without printing prompt content. Provider values, including extreme available values, never affect the gate.

- [ ] **Step 6: Implement claim checks and explicit baseline update mode**

Add `--cache-baseline` and `--update-cache-baseline`. Normal mode reloads transcript artifacts, verifies digests and metadata, recomputes metrics, then compares deterministic values to committed floors. Compare ordered catalog-entry and turn-input digests to report the first differing location; report only its index/key and expected/actual digest, never raw content.

Update mode writes exact current deterministic values with zero allowed decrease. It is not called by CI and does not run implicitly.

- [ ] **Step 7: Run focused verification**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/real-world-benchmark-matrix.test.ts tests/unit/check-benchmark-claims.test.ts tests/unit/benchmark-provider-cache.test.ts
npm run typecheck
npm run lint
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add scripts/import-benchmark-provider-usage.ts benchmarks/real-world/provider-usage.example.json scripts/real-world-benchmark-matrix.ts scripts/check-benchmark-claims.ts tests/unit/real-world-benchmark-matrix.test.ts tests/unit/check-benchmark-claims.test.ts tests/unit/benchmark-provider-cache.test.ts package.json
git commit -m "feat: aggregate SDLBench cache metrics"
```

CI wiring and the generated baseline land atomically in Task 7 after accepted evidence exists.

## Chunk 3: Synthetic Replay, Artifacts, and Documentation

### Task 6: Upgrade synthetic trace generation and replay

**Files:**
- Modify: `scripts/record-trace.ts`
- Modify: `scripts/benchmark.ts`
- Create: `tests/unit/synthetic-benchmark-script.test.ts`

- [ ] **Step 1: Write a failing registry-to-synthetic round-trip test**

Create a test registry containing Traditional, SDL-MCP, and a fake competitor registration. Run all three through the shared session runner, persist and reload the transcript artifact, and use that real output as the schema 4 fixture.

Spawn `record-trace.ts`, then `benchmark.ts`. Assert:

- replay schema is version 2 with sorted registered product IDs
- capped and uncapped context tokens survive
- canonical inputs and surface breakdowns survive
- transcript path/digest and assembly/serialization/tokenizer/fixture metadata survive
- whole-session, cold, warm, and per-turn metrics recompute from replay data
- unavailable provider status remains unavailable

- [ ] **Step 2: Prove provider metrics cannot change synthetic claims**

Attach valid provider telemetry with deliberately extreme effective and dollar savings. Assert raw-token ranking, simulated ranking, deterministic gate outcome, and process exit code remain unchanged. Provider ranking may change only inside the report-only provider section.

- [ ] **Step 3: Run the test and verify it fails**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/synthetic-benchmark-script.test.ts
```

Expected: FAIL because current scripts use fixed Traditional/SDL fields and do not replay transcripts.

- [ ] **Step 4: Upgrade `record-trace.ts`**

Require schema 4 results. For every product/task:

1. load the referenced transcript artifact
2. verify digest and metadata versions
3. recompute cache metrics
4. reject any mismatch with saved results
5. emit replay schema 2 with product identity, raw/capped/uncapped tokens, provider status, catalog/guidance/result token breakdowns, reusable/invalidated tokens, transcript metadata, and canonical turn inputs

Describe SDL as “public MCP workflow,” never “tool ladder.”

- [ ] **Step 5: Upgrade `benchmark.ts`**

Aggregate every sorted product against Traditional. Reuse `summarizeCacheMetrics`; do not duplicate formulas or percentile code.

Report separately:

- legacy capped/uncapped context-token reduction
- deterministic whole-session effective-input savings
- deterministic cold/warm and surface breakdowns
- report-only provider rankings and unavailable counts

Keep the seven-day stale warning and reject schema 1 traces for current claims.

- [ ] **Step 6: Run the round-trip test**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/synthetic-benchmark-script.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add scripts/record-trace.ts scripts/benchmark.ts tests/unit/synthetic-benchmark-script.test.ts
git commit -m "feat: replay multi-product cache traces"
```

### Task 7: Regenerate evidence, wire CI atomically, and synchronize docs

**Files:**
- Create: `docs/sdlbench.md`
- Modify: `docs/README.md`
- Modify: `docs/prompt-cache-hygiene.md`
- Modify: `docs/benchmark-guardrails.md`
- Modify: `docs/benchmark-baseline-management.md`
- Generate: `benchmarks/real-world/results-current.json`
- Generate: `benchmarks/real-world/results-current.transcripts.json`
- Generate: `benchmarks/real-world/cache-baseline.json`
- Generate: `benchmarks/synthetic/replay-traces.json`
- Generate: `benchmarks/synthetic/results.json`
- Create: `devdocs/benchmarks/sdlbench-public-cache-results.md`
- Modify: `.gitignore`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Make generated evidence trackable**

Add narrow exceptions after the existing benchmark and `devdocs/benchmarks` ignore rules:

```gitignore
!benchmarks/real-world/results-current.transcripts.json
!benchmarks/synthetic/results.json
!/devdocs/benchmarks/sdlbench-public-cache-results.md
```

Do not broaden the existing generated-artifact allowlist.

- [ ] **Step 2: Write the SDLBench methodology page**

Document public MCP sessions, the registry/conformance rule for competitors, capped versus uncapped context tokens, session input versus result tokens, deterministic ideal reuse versus provider telemetry, formulas, cold/warm boundaries, whole-session primacy, provider eligibility, artifact privacy, and commands.

State the current registered product set accurately. Do not imply external-repository benchmarks are competitor products.

- [ ] **Step 3: Synchronize existing docs**

Link SDLBench from `docs/README.md`. Connect `docs/prompt-cache-hygiene.md` guarantees to measured fields. Document deterministic gates, provider report-only behavior, and explicit cache-baseline updates in both benchmark governance documents.

Do not copy volatile provider prices into prose; versioned imported profiles remain the source of truth.

- [ ] **Step 4: Regenerate real-world evidence without indexing**

```powershell
npm run build:all
npm run benchmark:real -- --config benchmarks/real-world/benchmark.config.json --tasks benchmarks/real-world/tasks.json --repo-id my-repo --mode realism --skip-index --out benchmarks/real-world/results-current.json
```

Expected:

- schema 4 result plus transcript artifact
- exact registry product set
- every SDL turn has `toolCalls.length === 1` and `toolCalls[0].name === "sdl.context"`
- no legacy/internal retrieval marker exists
- guidance occurs once
- transcript digests and metadata verify
- recomputed whole/cold/warm/per-turn/surface metrics match saved results
- capped/uncapped and quality metrics remain populated
- provider status is unavailable before import

If the verified prepared index is unavailable, stop for explicit approval. Never refresh automatically.

- [ ] **Step 5: Generate the deterministic baseline**

```powershell
npm run benchmark:claims -- --aggregate benchmarks/real-world/results-current.json --update-cache-baseline --cache-baseline benchmarks/real-world/cache-baseline.json
npm run benchmark:claims -- --aggregate benchmarks/real-world/results-current.json --cache-baseline benchmarks/real-world/cache-baseline.json
```

Expected: the baseline contains every registered product, verified metadata, exact catalog and ordered entry/turn digests, SDL guidance count one, and measured simulated floors. Normal claims pass without provider telemetry.

- [ ] **Step 6: Wire CI only after the baseline exists**

Update the existing SDLBench claims invocation in `.github/workflows/ci.yml` to pass:

```text
--cache-baseline benchmarks/real-world/cache-baseline.json
```

Run the exact local claims command again. This keeps the workflow and required baseline in one atomic commit.

- [ ] **Step 7: Regenerate replay traces and synthetic results**

```powershell
npm run benchmark:record-trace -- --input benchmarks/real-world/results-current.json --tasks benchmarks/real-world/tasks.json --out benchmarks/synthetic/replay-traces.json
npm run benchmark -- --trace-file benchmarks/synthetic/replay-traces.json --out benchmarks/synthetic/results.json
```

Expected: schema 2 traces, verified embedded transcript data, no stale warning, and separate raw/simulated/provider sections.

- [ ] **Step 8: Write the tracked claim delta**

Create `devdocs/benchmarks/sdlbench-public-cache-results.md` with the exact before/after evidence:

- raw capped and uncapped token savings
- tool catalog, workflow guidance, and tool-result token costs
- simulated whole-session hit and effective-savings percentages
- cold-write and warm-read breakdown
- coverage, precision, and recall deltas
- provider metrics explicitly unavailable or report-only
- command lines and artifact digests used

Do not label simulated values as provider savings.

- [ ] **Step 9: Run focused and full verification**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/benchmark-prompt-cache.test.ts tests/unit/benchmark-provider-cache.test.ts tests/unit/benchmark-session-runner.test.ts tests/unit/real-world-benchmark-script.test.ts tests/unit/real-world-benchmark-matrix.test.ts tests/unit/check-benchmark-claims.test.ts tests/unit/synthetic-benchmark-script.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/integration/benchmark-public-session.test.ts
npm run benchmark:claims -- --aggregate benchmarks/real-world/results-current.json --cache-baseline benchmarks/real-world/cache-baseline.json
npm run typecheck
npm run lint
npm test
git diff --check
```

Expected: all commands PASS. If full tests expose an unrelated pre-existing failure, record it separately; do not weaken benchmark gates.

- [ ] **Step 10: Commit the atomic evidence and CI update**

```powershell
git add .gitignore docs/sdlbench.md docs/README.md docs/prompt-cache-hygiene.md docs/benchmark-guardrails.md docs/benchmark-baseline-management.md benchmarks/real-world/results-current.json benchmarks/real-world/results-current.transcripts.json benchmarks/real-world/cache-baseline.json benchmarks/synthetic/replay-traces.json benchmarks/synthetic/results.json devdocs/benchmarks/sdlbench-public-cache-results.md .github/workflows/ci.yml
$expected = @('.github/workflows/ci.yml', '.gitignore', 'benchmarks/real-world/cache-baseline.json', 'benchmarks/real-world/results-current.json', 'benchmarks/real-world/results-current.transcripts.json', 'benchmarks/synthetic/replay-traces.json', 'benchmarks/synthetic/results.json', 'devdocs/benchmarks/sdlbench-public-cache-results.md', 'docs/README.md', 'docs/benchmark-baseline-management.md', 'docs/benchmark-guardrails.md', 'docs/prompt-cache-hygiene.md', 'docs/sdlbench.md')
$staged = @(git diff --cached --name-only | Sort-Object)
if (Compare-Object ($expected | Sort-Object) $staged) { throw 'Unexpected staged file set' }
git commit -m "docs: publish cache-aware SDLBench evidence"
```
