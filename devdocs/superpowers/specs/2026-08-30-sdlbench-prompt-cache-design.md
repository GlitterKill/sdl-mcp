# SDLBench Public Workflow and Prompt Cache Design

**Status:** Approved design
**Date:** 2026-08-30

## Problem

SDLBench no longer represents the current SDL-MCP product path. The real-world benchmark calls internal handlers directly and encodes an older search-to-card-to-slice-to-skeleton workflow. This bypasses the public MCP catalog, current workflow guidance, compact response projection, and exact bytes that a model receives.

The benchmark also treats input tokens as equally expensive. It cannot distinguish a stable prompt prefix that receives cache reads from a changing prefix that forces full-price input processing. This omission can hide the value of SDL-MCP's prompt-cache hygiene and can overstate products that reduce visible tokens while invalidating the reusable prefix.

## Goals

1. Exercise SDL-MCP and competing products through their public MCP surfaces.
2. Capture the exact ordered tool catalog and model-facing transcript used by each benchmark run.
3. Measure deterministic prompt-prefix reuse for every product.
4. Import optional provider usage and calculate provider-reported cache efficiency.
5. Preserve existing quality, coverage, and raw token measurements.
6. Regenerate synthetic traces from the corrected benchmark contract.

## Non-Goals

- SDLBench does not call model-provider APIs or manage provider credentials.
- SDLBench does not install the retired SDL workflow skill.
- SDLBench does not infer cache usage from provider billing totals.
- SDLBench does not give SDL-MCP product-specific scoring exceptions.
- Provider cache metrics do not become CI gates until repeated runs establish variance bounds.

## Architecture

```text
task fixture
  -> product adapter
  -> public MCP session
  -> exact tools/list and turn transcript
  -> benchmark result
       -> quality and coverage metrics
       -> raw token metrics
       -> deterministic cache simulation
       -> imported provider cache usage
```

The shared runner owns task prompts, turn assembly, transcript serialization, token counting, cache calculations, result persistence, and cross-product aggregation.

Each product adapter owns only the product boundary:

- start or connect to the product's MCP server
- return product identity and version
- return the public ordered tool catalog
- execute public tool calls
- return the exact model-facing tool result

SDL-MCP receives no private cache logic. Its workflow guidance enters the benchmark through the first public `tools/list` response, exactly as it enters an agent session. Repeated catalog loads must be byte-identical, and the guidance must appear only where the public server normally exposes it.

The current internal-handler runner may remain temporarily as a diagnostic, but its results must be labeled legacy and excluded from claim-bearing comparisons.

## Session Contract

Every product run emits one canonical session transcript:

```ts
interface BenchmarkSession {
  productId: string;
  productVersion: string;
  taskId: string;
  runId: string;
  toolCatalog: unknown;
  turns: BenchmarkTurn[];
}

interface BenchmarkTurn {
  turnIndex: number;
  request: unknown;
  toolCalls: unknown[];
  toolResults: unknown[];
}
```

The persisted representation uses deterministic JSON serialization. Tool order, object key order, and result bytes are part of the measured cache surface. Operational timestamps, durations, request IDs, absolute paths, and other non-actionable noise remain outside the model-facing transcript.

The same task fixture defines the user request, turn limit, context budget, quality oracle, and completion criteria for every product. Product-specific instructions are allowed only when they arrive through that product's normal public installation or MCP loading path.

## Cache Model

Each benchmark result contains deterministic simulated metrics and optional provider metrics:

```ts
interface CacheResult {
  simulated: CacheMetrics;
  provider:
    | CacheMetrics
    | { status: "unavailable"; reason: string };
}

interface CacheMetrics {
  totalInputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitPct: number;
  effectiveInputTokens: number;
  effectiveSavingsTokens: number;
  effectiveSavingsPct: number;
  cold: CachePhaseMetrics;
  warm: CachePhaseMetrics;
  turns: CacheTurnMetrics[];
}
```

### Common formulas

```text
cacheHitPct = cacheReadTokens / totalInputTokens
effectiveSavingsTokens = totalInputTokens - effectiveInputTokens
effectiveSavingsPct = effectiveSavingsTokens / totalInputTokens
```

Zero-input runs report zero percentages rather than `NaN`.

### Deterministic simulation

The simulator compares consecutive serialized model-input prefixes. A byte is reusable only while every preceding byte is unchanged. Content moved earlier, reordered keys, changing tool definitions, and injected runtime metadata invalidate the prefix from the first differing byte.

Token counts use SDLBench's existing tokenizer. The simulator records:

- tool catalog tokens
- first-load workflow guidance tokens
- tool-result tokens
- reusable-prefix tokens
- invalidated-prefix tokens
- reusable-prefix percentage

For simulation, reusable-prefix tokens are cache reads and all remaining input tokens are uncached. Cache writes are reported separately but use a neutral weight of `1.0`, so the simulated gate measures deterministic reuse rather than provider pricing.

### Provider normalization

Imported provider records are normalized before aggregation.

For Anthropic-style usage, total input is the sum of uncached input, cache creation input, and cache read input. Cache creation input maps to writes; cache read input maps to reads.

For OpenAI-style usage, total input is the reported input total, cached input comes from the cached-token detail, and uncached input is the difference. Cache writes remain zero when the provider does not expose them.

The effective input calculation applies a versioned pricing profile:

```text
effectiveInputTokens =
  uncachedInputTokens
  + cacheReadTokens * cacheReadWeight
  + cacheWriteTokens * cacheWriteWeight
```

Weights are the provider's read and write prices divided by its normal input price for the recorded model. This expresses cache cost in full-price input-token equivalents. Cold writes can therefore produce negative savings when a provider charges a write premium. Dollar savings use the same profile but remain informational.

Provider comparisons are valid only when product results use the same provider, model, and pricing-profile version.

## Provider Usage Import

Provider usage is imported after a benchmark session. SDLBench never stores credentials or sends provider requests.

```json
{
  "productId": "sdl-mcp",
  "taskId": "bug-fix-policy-window",
  "runId": "run-001",
  "provider": "anthropic",
  "model": "claude-sonnet-*",
  "pricingProfile": "anthropic-2026-08-30",
  "turns": [
    {
      "turnIndex": 0,
      "inputTokens": 12000,
      "cacheReadTokens": 0,
      "cacheWriteTokens": 9000,
      "outputTokens": 800
    }
  ]
}
```

The importer joins records by `productId`, `taskId`, `runId`, and `turnIndex`. It rejects duplicate turns, negative or non-finite values, unknown runs, mismatched product identities, and incompatible provider/model/profile combinations.

Imported files must not contain raw prompts, tool results, API keys, provider request IDs, or user data.

## Aggregation

Whole-session amortized savings is the primary cache result. It includes cold cache writes and warm cache reads. Reports also retain cold and warm phase totals so readers can see startup cost and repeat-use benefit separately.

Per product, SDLBench reports:

- average, p25, p50, and minimum cache-hit percentage
- average, p25, p50, and minimum effective-input savings percentage
- total effective-input tokens and savings tokens
- cold and warm breakdowns
- number of ranked and unranked runs

A product without provider telemetry remains in all normal SDLBench quality and raw-token reports. Its provider-cache status is `unavailable`, and it is excluded from provider-cache rankings rather than treated as zero savings. Deterministic simulated metrics remain required for every product.

## Fairness Rules

1. Use the same task, model, provider, turn limit, and context policy for compared products.
2. Count each product's complete public tool catalog and normal workflow guidance.
3. Capture exact model-facing results; do not count hidden server logs or internal envelopes.
4. Reject provider-cache comparisons with mismatched provider, model, or pricing profile.
5. Require both the token/cache result and the existing quality result; token savings cannot compensate for lost coverage or correctness.

## Result Persistence

The next SDLBench result schema adds these fields without deleting existing raw-token or quality fields:

```ts
interface ProductBenchmarkResult {
  product: {
    id: string;
    version: string;
    adapterVersion: string;
  };
  session: BenchmarkSessionSummary;
  tokens: ExistingTokenMetrics;
  quality: ExistingQualityMetrics;
  cache: CacheResult;
}
```

Saved results include the benchmark schema version, tokenizer identity, fixture revision, pricing-profile identity, and transcript digest. Comparisons reject incompatible schema, tokenizer, or fixture revisions instead of silently combining them.

Synthetic traces are regenerated from the same session/result contract. Existing stale traces remain historical artifacts and must not be presented as current SDLBench evidence.

## CI Policy

Initial CI hard-gates deterministic behavior only:

- tool catalog and first-load workflow bytes remain stable
- workflow guidance appears exactly once in the captured public catalog
- simulated cache-hit and effective-savings metrics remain within approved tolerances
- cleaned tool outputs do not regress coverage, precision, or recall
- synthetic traces match the current schema and fixtures

Provider metrics are report-only until enough repeated samples exist to set defensible variance bounds. Promoting a provider metric to a gate requires a separate reviewed change containing the sample evidence and chosen tolerance.

## Failure Handling

- Missing provider telemetry: preserve the run and mark provider cache unavailable.
- Partial provider telemetry: reject the import for that run; do not estimate missing turns.
- Catalog or transcript nondeterminism: fail deterministic CI and report the first differing turn or catalog location.
- Adapter failure: fail that product run without substituting the legacy internal runner.
- Quality regression: fail the existing quality gate even if cache metrics improve.

## Rollout

1. Add the shared public MCP session/transcript runner and adapt SDL-MCP first.
2. Move the traditional baseline and each existing competitor onto the same adapter contract.
3. Add deterministic prefix simulation and persisted cache metrics.
4. Add provider-usage import, normalized reporting, and cache-ranking eligibility.
5. Regenerate synthetic traces and update SDLBench methodology documentation.

The rollout does not require provider credentials in CI. The first four steps can ship with provider telemetry absent and simulated cache metrics fully enforced.

## Acceptance Criteria

- SDLBench reaches SDL-MCP only through its public MCP protocol for claim-bearing runs.
- The captured first tool catalog includes current SDL workflow guidance without an installed skill.
- Repeated unchanged catalogs and tool results are byte-stable.
- SDL-MCP, the traditional baseline, and every tested competitor produce the same session/result shape.
- Every run saves simulated cache metrics; imported provider metrics are optional and explicitly ranked or unranked.
- Whole-session, cold, warm, and per-turn cache values are reproducible from saved inputs.
- Existing raw token, uncapped token, coverage, precision, and recall metrics remain available.
- Synthetic traces are regenerated and no stale-trace warning remains.
- SDLBench documentation explains cache formulas, fairness rules, ranking eligibility, and provider-profile compatibility.
