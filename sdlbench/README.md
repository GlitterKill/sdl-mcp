# SDLBench

SDLBench is an isolated benchmark harness for comparing agent runs with and without SDL-MCP context. V1 keeps all code under `sdlbench/` and writes append-only records to `sdlbench/results/sessions.jsonl`.

## Commands

```bash
node sdlbench/src/cli.mjs setup all
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent codex --variant baseline --model gpt-5.5
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent codex --variant sdl --model gpt-5.5
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent codex --variant sdl --model gpt-5.5 --behavior
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent codex --variant sdl --warm-session
# opencode agent + Neuralwatt-hosted GLM-5.2 / Kimi K2.7 Code (see docs/opencode.md):
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent opencode --variant sdl --model glm-5.2 --behavior
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent opencode --variant sdl --model kimi-k2.7-code --behavior
node sdlbench/src/cli.mjs scaling --sizes tiny,small --agent codex --variant baseline,sdl --i-understand-cost
node sdlbench/src/cli.mjs claims --in sdlbench/results/sessions.jsonl --profile realism --variant sdl
node sdlbench/src/cli.mjs analyze --in sdlbench/results/sessions.jsonl
node sdlbench/src/cli.mjs view --port 4177
```

## Honest Reporting

SDLBench enforces truth in savings claims:

- **Schema v3**: every session record carries explicit `cache` telemetry. Fixture and tokenizer-only records use `{ "available": false, "reason": "provider-usage-unavailable" }`; provider-backed Codex and OpenCode behavior records save measured cache reads and writes.
- **Pass-gated paired deltas**: `paired[]` compares `tokens.total` only when both baseline and the selected product passed. `deltas.<variant>.tokensSaved` comes from those paired rows, not from per-record `tokens.saved`.
- **Headline claim**: `summary.headlineClaim` is always "median paired savings
  on tasks both solved."
- **Claim gates**: run `sdlbench claims --profile realism --variant sdl` to validate one product against baseline. The default variant is `sdl`; cache fields are report-only and never change gate results. See `docs/claims.md`.
- **Prompt-cache hygiene**: reports weighted provider cache hit rate, telemetry coverage, and the input-price discount relative to billing all input at the normal rate. Cache reads are not labeled as raw tokens saved.
- **Cost guardrails**: `scaling` command requires `--i-understand-cost` and
  prints predicted USD before launching.
- **Attribution**: behavior records carry `attribution.toolCalls[]` (parsed
  from Codex `function_call` items) and `attribution.phaseBreakdown` (retrieval
  vs reasoning vs output). SDL records carry `artifacts.sdl.observability`
  (polled from `/api/observability/snapshot`).
- **Amortization**: `--warm-session` reuses the SDL HTTP server across tasks
  of the same repo; `tokens.indexCost` is non-zero only on the first warm task.
- **Coverage**: tasks with `contextTargets` produce `record.coverage` with
  file/symbol coverage, precision, and recall.
- **Prompt specificity**: tasks declare `sparse`, `normal`, or `explicit`; records persist the tier and `analyze` reports `byPromptSpecificity` so sparse-task savings remain visible.

`setup all` creates `sdlbench/.work/tiktoken-venv` and installs OpenAI `tiktoken` from the pinned GitHub tag `0.13.0`. Benchmark runs fail if tiktoken cannot count tokens; they do not fall back to estimates.

## Viewer Data Load

The viewer auto-loads `/results/sessions.jsonl` from the local server. It also has a `Data` file picker for loading any JSONL result file directly, plus `Load Current JSONL` to reload the server-side benchmark data.

Open the viewer at:

```text
http://127.0.0.1:4177
```

## Fixture Suite

The acceptance fixture suite has four longer agentic tasks:

- `bugfix-discount-tax`: fixes a cart tax calculation after discounts.
- `feature-tiered-checkout`: implements a multi-file checkout summary feature across discounts, cart totals, and shipping.
- `security-order-audit`: hardens order placement and audit output across two files.
- `review-checkout-risk`: performs a broader checkout code review and writes `review-report.md`.

Each task copies `sdlbench/tests/fixtures/repo` into `sdlbench/.work/repos/<taskRunId>`, applies task-local solution files in that isolated copy, runs the task verifier, and appends one `SessionRecord` JSON object per task. The source fixture is not modified by benchmark runs; edit-heavy task mutations stay confined to the copied work directory, so the next task starts from a clean fixture copy.

## SDL Evidence

For `--variant sdl`, the runner prepares a normal SDL-MCP HTTP server and indexes the copied fixture repo before the task starts. By default it starts a temporary `serve --http` process, waits until `/health` is reachable, then runs `POST /api/repo/:repoId/reindex-stream` with `mode: "full"`. It does not pre-run task-specific searches or paste fixture SDL context; behavior agents discover context through live tools. Tests can pass `sdlHttpBaseUrl` to use an existing server. Codex behavior runs using an external server must also pass `sdlConfigPath` so the production hook targets that server's pidfile.

The temporary config starts from `config/sdlmcp.config.example.json` and keeps provider-first indexing, Rust indexing, SCIP, semantic retrieval/enrichment, policy, prefetch, and exclusive Code Mode. SDLBench disables file watching because each copied repository is indexed explicitly before the measured run, and overrides only the copied root, graph DB path, local HTTP/auth settings, benchmark ignores, and repo languages. Provider-first counts as evidence only when the indexing response reports it.



SDL token counts use the rendered prompt plus measured agent session data when available. `context.raw`, `context.sdl`, and `context.sdlQueries` are fixture metadata, not privileged behavior-mode prompt input. If HTTP indexing fails, or if both Codex attribution and server observability report zero SDL tool activity, the SDL run fails instead of writing savings evidence.

## Metrics

`results/sessions.jsonl` is the canonical chart source. `analyze` writes `results/summary.json`; the viewer renders paired raw-token deltas, cost, time, correctness, timeline, weighted cache efficiency, and a product matrix.

Token counts use the selected model first: `--model`, then `config/agents/<agent>.json` `model`, then `config/pricing.json` `defaultModel`. Fixture-mode records use the tokenizer subprocess, which calls `tiktoken.encoding_for_model(model)` and falls back to the configured encoding only when tiktoken does not know that model. Codex behavior-mode records prefer Codex session JSONL `token_count` totals for the matching run worktree, including `input`, `cachedInput`, `output`, `reasoningOutput`, and `total`; the prompt estimate is kept at `artifacts.estimatedTokens` only when session counts are available.

Cost estimates use `sdlbench/config/pricing.json`. When that file declares a `models` map, the selected model must have a matching pricing entry; otherwise the run fails instead of silently using another model's rates. `contextPerMTok` defaults to `0` for API cost estimates because prompt/context tokens are already included in input token charges.

Raw paired token savings and prompt-cache savings are separate measurements:

- Raw paired savings are `baseline.tokens.total - product.tokens.total`, reported only when both runs passed.
- Cache hit percent is `cache.readTokens / cache.inputTokens`.
- Cache discount savings compare billed input cost with the cost of billing every input token at the normal rate.
- Cache telemetry coverage is the share of records with explicit provider cache counters. A valid zero-hit record is available telemetry, not missing telemetry.
- Cache metrics are report-only. They do not alter raw token savings, claim gates, or command exit status.

## Product Status

Every executed non-baseline product uses the same session, analysis, scaling, cache, and viewer paths. `crg` and `repomix` are currently dry-run declarations in `config/products.lock.json`; they cannot produce claim-bearing comparison rows until real behavior integrations exist.

## Model Behavior Mode

Default runs stay in fixture mode: they apply task-local `solution.files`, then run the verifier. Use this for harness and token plumbing checks.

Pass `--behavior` to test model behavior. In behavior mode, SDLBench writes `.sdlbench-prompt.md` into the copied repo, runs the configured agent command template from `config/agents/<agent>.json`, then verifies the files the command changed. The checked-in Codex config defaults to `gpt-5.5` with `model_reasoning_effort="xhigh"`. The command template can use `{repo}`, `{prompt}`, `{taskId}`, `{variant}`, `{model}`, `{sdlMcpConfig}`, and `{sdlMcpUrl}` placeholders. Override it directly with `--agent-command "cmd {repo} {prompt}"` for local smoke tests.
Every variant receives the same neutral task prompt. SDLBench supplies the normal live MCP server, and the SDL Codex variant installs the production enforcement assets (`SDL.md`, `AGENTS.md`, `CODEX.md`, and `.codex/hooks/`) in the copied run root. These measured product assets provide workflow guidance and enforce SDL use without adding task-specific hints to the prompt.

Codex behavior runs are isolated from the developer environment. SDLBench uses an OS-temp worktree and temporary `CODEX_HOME`, copies only `auth.json`, and disables plugin, app, memory, personality, browser, computer-use, and discovered skill paths. A run fails if no matching Codex session token counts exist or if captured context contains Ponytail, generic plugin/app/skill instructions, or memory context.

The `opencode` agent uses the same neutral prompt and a per-run `XDG_DATA_HOME`. `OPENCODE_CONFIG_CONTENT` contains only the live SDL MCP entry for SDL or an empty MCP block for baseline. Provider token and cache counts come from the matching session row in the isolated `opencode.db`. See `docs/opencode.md` for models, pricing, and limits.

Behavior records include `artifacts.promptPath`, `artifacts.agent`, and `artifacts.changedFiles`. A pass means the agent command exited successfully and the verifier passed.
