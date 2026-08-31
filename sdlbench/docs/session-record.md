# SessionRecord

Each line in `sdlbench/results/sessions.jsonl` is one session record. Session records and analysis summaries use schema v3.

## Required Fields

- `schemaVersion`, `runId`, `sessionId`, `timestamp`
- `agent`, `model`, `variant`, `product`, `repoId`, `taskId`, `category`
- `status`, `durationMs`, `setupMs`, `agentMs`, `claimGrade`
- `tokens`, `cost`, `cache`, `quality`, `workflow`, `artifacts`

## Tokens And Cost

Token fields include `input`, `output`, `total`, `productContext`, `rawEquivalent`, `saved`, `savingsPercent`, `model`, `encoding`, `modelHint`, `tokenizerResolution`, `tokenizerVersion`, and `tokenizerSource`. Provider-backed behavior records may also include `cachedInput`, `cachedWriteInput`, `uncachedInput`, `reasoningOutput`, `usageSource`, provider session identifiers, and model context limits.

`tokens.input` is the provider's total input count. Cache read and write counts are subsets used for cost and cache-efficiency reporting; they are not added to `tokens.input`. Per-record `tokens.saved` remains zero. Raw savings are calculated later from pass-gated baseline/product pairs using `tokens.total`.

Cost fields include `inputUsd`, `cachedInputUsd`, `cacheWriteUsd`, `uncachedInputUsd`, `outputUsd`, `reasoningUsd`, `contextUsd`, `totalUsd`, and their configured per-million-token rates. If `config/pricing.json` declares a `models` map, the selected model must have a matching pricing row. Cache writes use a configured write rate when present and otherwise use the normal input rate.

## Cache Telemetry

When explicit provider cache counters are available, `cache` contains:

- `available: true`, `source`, `inputTokens`, `readTokens`, `writeTokens`, `uncachedTokens`
- `hitPercent`
- `uncachedEquivalentInputUsd`, `billedInputUsd`
- `discountSavingsUsd`, `discountSavingsPercent`

`hitPercent` is `readTokens / inputTokens`. Discount savings compare actual billed input cost with billing all input tokens at the normal input rate. A valid provider record with zero cache reads remains `available: true`.

Fixture, tiktoken-only, imported, or otherwise non-provider-backed records use `{ "available": false, "reason": "provider-usage-unavailable" }`. Current Codex and OpenCode behavior paths can provide cache telemetry. Cache metrics are report-only and never alter raw token savings, claim gates, or command exit status.

## Behavior Evidence

All non-baseline products receive the same neutral task prompt. SDLBench does not add product instructions through prompt text, skills, repository files, or hooks. SDL behavior runs expose the normal live MCP server; SDL's workflow is presented by that server when its tools load.

For behavior records, `artifacts.promptPath` points at the rendered prompt, `artifacts.agent` contains command evidence, and `artifacts.changedFiles` lists files changed by the agent. Codex records include `artifacts.codexSession` and `artifacts.codexSterility`; OpenCode usage comes from the matching session in its isolated SQLite database.

For SDL records, `artifacts.sdl` contains HTTP setup evidence. SDLBench waits for `/health`, explicitly indexes the copied fixture, and does not pre-run task-specific retrieval. Missing indexing evidence fails the run instead of writing savings evidence.

`workflow.executionMode` is `fixture` for canned-solution runs and `behavior` for agent-command runs. Quality fields include `passed`, `errorRate`, `weightedErrorRate`, and `rubricScore`.

## Migration Note

Schema v2 introduced `claimGrade` and removed synthetic per-record savings. Schema v3 adds explicit cache telemetry and cache-aware input cost fields. Re-run `sdlbench analyze` for old JSONL files; do not use v1 fixture-derived savings as evidence.
