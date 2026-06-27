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

- **Per-run storage redirection (opencode v1.17.11+)**: `XDG_DATA_HOME` is set
  to a per-`taskRunId` temp dir under `<workDir>/../opencode-home/<taskRunId>/`.
  opencode v1.17.11 honors `XDG_DATA_HOME` and writes its SQLite database
  (`opencode.db`), `snapshot/`, `log/`, and `bin/` under that dir.
  (`OPENCODE_DATA_DIR` env var was added in opencode PR #8963 (Jan 2026) but
  did not ship until v1.2+; opencode 1.1.6 ignores it. The harness uses
  `XDG_DATA_HOME` which is honored across versions.)
- **Inline config override**: `OPENCODE_CONFIG_CONTENT` is set to a JSON object
  containing only the SDL MCP remote server entry (for `--variant sdl`) or an
  empty `mcp: {}` block (for `--variant baseline`). It also sets `plugin: []`
  to override any plugins declared in the user's global
  `~/.config/opencode/opencode.json` (e.g. `code-mode` MCP) that would
  otherwise fail to start or pollute the benchmark. No user-installed opencode
  plugins, skills, or memory entries are loaded.

A behavior run **fails instead of writing a fake-evidence record** when no
session usage records are found in `opencode.db` under the isolated
`XDG_DATA_HOME` (mirrors the Codex `did not find matching session token_count
JSONL` rejection).

## Token Extraction

opencode v1.17.11+ stores sessions, messages, and parts in a SQLite database
at `<XDG_DATA_HOME>/opencode/opencode.db`. The `session` table exposes
per-session aggregated token counts as direct columns:

| SQLite column         | Tokens field        |
|-----------------------|---------------------|
| `tokens_input`        | `input`             |
| `tokens_output`       | `output`            |
| `tokens_reasoning`    | `reasoningOutput`   |
| `tokens_cache_read`   | `cachedInput`       |
| `tokens_cache_write`  | `cachedWriteInput`  |

`extractOpencodeSessionUsage({ storageDir, runRoot })` (in
`sdlbench/src/agents/opencode.mjs`) opens the SQLite DB read-only and matches
the `session.directory` column against `runRoot` (normalized to forward-slash
lowercase), returning the most-recent matching session's token totals. If no
directory match is found, it falls back to the most-recently-updated session
overall. If the DB file doesn't exist, it returns zero totals.

`tokensFromOpencodeSessionCounts` reshapes the summed counts into the v2
tokens schema, populating `tokenizerSource: "opencode-session"`,
`usageSource: "opencode_session_usage"`, and the standard
`cachedInput`/`uncachedInput`/`reasoningOutput` fields used by
`estimateCost` and the viewer.

### Note on opencode version compatibility

The earlier opencode v1.1.6 used a fragmented JSON storage layout
(`storage/session/<sid>/info.json`, `storage/message/<sid>/part/<pid>.json`,
etc.) with a different `tokens: { input, output, reasoning, cache: { read,
write } }` shape inside part files. v1.17.11 moved all of this to SQLite with
direct scalar columns per session. Current parser targets v1.17.11+. Support
for v1.1.6's JSON layout can be re-added later if needed.

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
