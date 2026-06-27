# opencode Agent for SDLBench

SDLBench supports `opencode` as a behavior-mode agent alongside Codex, backed by
**Neuralwatt.com** as the model provider. Supported models are `glm-5.2`
(Zhipu AI) and `kimi-k2.7-code` (Moonshot AI).

## Prerequisites

1. **opencode CLI** installed and on `PATH` (verify with `opencode --version`).
2. **Neuralwatt API key** exported as `NEURALWATT_API_KEY` (e.g.,
   `setx NEURALWATT_API_KEY "sk-..."` on Windows or `export
   NEURALWATT_API_KEY=sk-...` on POSIX shells).
3. SDLBench tooling set up via `node sdlbench/src/cli.mjs setup all`.

## Commands

```bash
# Baseline run (no SDL-MCP context) with GLM-5.2:
node sdlbench/src/cli.mjs run \
  --matrix sdlbench/tasks/matrix.json \
  --agent opencode --variant baseline --model glm-5.2 --behavior

# SDL variant (with live MCP server wired via inline opencode config):
node sdlbench/src/cli.mjs run \
  --matrix sdlbench/tasks/matrix.json \
  --agent opencode --variant sdl --model glm-5.2 --behavior

# Same two runs but with Kimi K2.7 Code:
node sdlbench/src/cli.mjs run ... --model kimi-k2.7-code --behavior
```

The `--model` flag selects both the agent's model ID and the pricing row.
Values shipped: `glm-5.2` and `kimi-k2.7-code`. The agent's default model
(per `config/agents/opencode.json`) is `glm-5.2`.

## Sterility Guarantees

opencode behavior runs are isolated from the developer's normal opencode
environment by:

- **Per-run storage redirection**: `OPENCODE_DATA_DIR` is set to a per-`taskRunId`
  temp dir under `<workDir>/../opencode-home/<taskRunId>/storage/`, so opencode
  does not read from or write to the user's
  `~/.local/share/opencode/storage/`. This prevents contamination from prior
  user sessions and means the per-run isolated tree is the only place
  `extractOpencodeSessionUsage` needs to walk.
- **Inline config override**: `OPENCODE_CONFIG_CONTENT` is set to a JSON object
  containing only the SDL MCP remote server entry (for `--variant sdl`) or an
  empty `mcp: {}` block (for `--variant baseline`). No user-installed opencode
  plugins, skills, or memory entries are loaded.

A behavior run **fails instead of writing a fake-evidence record** when no
session usage records are found under the isolated `OPENCODE_DATA_DIR` (mirrors
the Codex `did not find matching session token_count JSONL` rejection).

## Token Extraction

opencode writes fragmented session storage at
`<OPENCODE_DATA_DIR>/storage/session/<sessionId>/info.json`,
`<OPENCODE_DATA_DIR>/storage/session/<sessionId>/message/<msgId>/index.json`,
and `<OPENCODE_DATA_DIR>/storage/message/<msgId>/part/<partId>.json`. Assistant
parts carry a top-level `usage` object populated by opencode's `getUsage`
activation from the provider response.

`extractOpencodeSessionUsage({ storageDir })` (in
`sdlbench/src/agents/opencode.mjs`) walks every JSON file under the per-run
isolated storage tree and sums the provider usage fields:

| Field | Map |
|---|---|
| `usage.inputTokens` | `tokens.input` |
| `usage.outputTokens` | `tokens.output` |
| `usage.reasoningTokens` | `tokens.reasoningOutput` |
| `usage.cacheReadInputTokens` | `tokens.cachedInput` |
| `usage.cacheWriteInputTokens` | `tokens.cachedWriteInput` |
| `usage.totalTokens` | `tokens.total` |

Files without a top-level `usage` object (e.g. `info.json`, message
`index.json`, parts without consumption frames) are skipped. Zero-stat
frames (records where every field is 0) are also skipped to stay defensive
against provider-emitted cache-write-only entries.

`tokensFromOpencodeSessionCounts` resphes the summed counts into the v2
tokens schema, populating `tokenizerSource: "opencode-session"`,
`usageSource: "opencode_session_usage"`, and the standard
`cachedInput`/`uncachedInput`/`reasoningOutput` fields used by
`estimateCost` and the viewer.

## Pricing

Pricing for both models is in `sdlbench/config/pricing.json`, sourced from
Neuralwatt's published rate card (`https://portal.neuralwatt.com/pricing`):

| Model            | Input / MTok | Cached Input / MTok | Output / MTok | Reasoning / MTok | Context |
|------------------|--------------|---------------------|---------------|------------------|---------|
| `glm-5.2`        | $1.45        | $0.36               | $4.50         | $4.50            | 1048K   |
| `kimi-k2.7-code` | $0.95        | $0.24               | $4.00         | $4.00            | 262K    |

Cache reads billed at 25% of the input rate (Neuralwatt platform default).
Reasoning tokens (thinking-mode output) charged at the output rate: Kimi
K2.7 Code is always in thinking mode per Moonshot's spec; GLM-5.2 follows
Z.AI's reasoning-tier output rate.

## Known Limits

- **No `--variant sdl` reinforcement injections**: opencode wires SDL-MCP via
  the inline `OPENCODE_CONFIG_CONTENT` config, not via repo-injected
  `AGENTS.md`/`SDL.md`/hook files like Codex. This is by design — cleaner
  sterility, but it means the fairness auditor's "reinforcement injection"
  cost line does not apply to opencode runs (the
  `fairness.promptTokenImbalance` should be subtracted to zero for opencode
  until/unless we add an explicit `installSdlBenchmarkReinforcement` for
  opencode).
- **No attribution from `function_call` items yet**: the attribution engine
  (Tasks P1.3 of the 10x plan) parses Codex session JSONL `function_call`
  events. opencode's per-message files contain tool calls under
  `message/<msgId>/part/<pid>.json` with `type:"tool"` — extending the
  attribution parser to walk those is a follow-up.
- **Highspeed variant not priced**: only the standard `kimi-k2.7-code`
  variant is supported; the highspeed variant
  (`kimi-k2.7-code-highspeed`) is intentionally out of scope per the
  approved implementation plan.
- **Reasoning flags**: reasoning effort is left at model defaults. If a
  future comparison requires toggling thinking depth on GLM-5.2 or Kimi
  K2.7 Code, use opencode's `--thinking` CLI flag in a custom
  `commandTemplate` override via `--agent-command`.

## File Map

- `sdlbench/config/agents/opencode.json` — agent config (model, command
  template, env passthrough, timeout).
- `sdlbench/src/agents/opencode-runtime.mjs` — `prepareOpencodeSterileRuntime`
  (per-run OPENCODE_DATA_DIR + OPENCODE_CONFIG_CONTENT generation).
- `sdlbench/src/agents/opencode.mjs` — `extractOpencodeSessionUsage` +
  `tokensFromOpencodeSessionCounts` (token-extraction and reshape).
- `sdlbench/config/products.lock.json` — `baseline` and `sdl` products declare
  `"opencode"` in their `supportedAgents`.
- `sdlbench/config/pricing.json` — `glm-5.2` and `kimi-k2.7-code` pricing
  rows.
