# SDLBench

SDLBench is an isolated benchmark harness for comparing agent runs with and without SDL-MCP context. V1 keeps all code under `sdlbench/` and writes append-only records to `sdlbench/results/sessions.jsonl`.

## Commands

```bash
node sdlbench/src/cli.mjs setup all
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent codex --variant baseline --model gpt-5.5
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent codex --variant sdl --model gpt-5.5
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent codex --variant sdl --model gpt-5.5 --behavior
# opencode agent + Neuralwatt-hosted GLM-5.2 / Kimi K2.7 Code (see docs/opencode.md):
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent opencode --variant sdl --model glm-5.2 --behavior
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent opencode --variant sdl --model kimi-k2.7-code --behavior
node sdlbench/src/cli.mjs scaling --sizes tiny,small --agent codex --variant baseline,sdl --repetitions 2 --i-understand-cost
node sdlbench/src/cli.mjs claims --in sdlbench/results/sessions.jsonl --profile realism --variant sdl
node sdlbench/src/cli.mjs analyze --in sdlbench/results/sessions.jsonl
node sdlbench/src/cli.mjs view --port 4177
```

## Honest Reporting

Schema v4 separates provider billing usage (`providerUsage`) from independently tokenized observed prompt and output text (`observedContent`). Observed text has partial coverage: it does not capture every tool message, tool schema, hidden reasoning token, or repeated model-request input. Counting it once cannot establish total billed input.

- **Paired savings** compare matching baseline and SDL attempts only when both pass. Failed attempts remain in the raw records, and ambiguous duplicate attempts fail analysis before pass-gating.
- **Cache reporting** uses explicit provider cache counters and reports availability. Cache reads describe billing discounts; they are not raw tokens saved.
- **Cost reporting** separates model usage from indexing. Missing indexing or enrichment spend stays unknown; the index response JSON is not a token-cost measurement. Scaling requires `--i-understand-cost`; its pre-run budget is unknown.
- **Execution reporting** distinguishes fixture plumbing from behavior runs. Only `baseline` and `sdl` are executable variants. Warm-session execution is rejected until the server can prove it indexes the exact agent worktree.
- **Claim gates** require measured evidence and remain separate from performance targets. A fair experiment can show negative savings. See [claims](docs/claims.md) and the [measurement audit](docs/measurement-audit.md) for evidence limits.

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



Provider usage and independently counted visible prompt/output text are separate measurements. `context.raw`, `context.sdl`, and `context.sdlQueries` are fixture metadata, not privileged behavior-mode prompt input. If HTTP indexing fails, or if both Codex attribution and server observability report zero SDL tool activity, the SDL run fails instead of writing savings evidence.

## Metrics

`results/sessions.jsonl` is the canonical chart source. `analyze` writes `results/summary.json`; the viewer renders paired raw-token deltas, cost, time, correctness, timeline, weighted cache efficiency, and a product matrix.

Tokenization selects the model from `--model`, then the agent configuration, then the pricing default. Independently counted prompt/output text records tokenizer provenance and partial coverage. Behavior runs use provider session counters for billing usage; provider counters are not labeled as tiktoken measurements. Fixture runs only test the observable-text accounting and supplied-solution path.

Cost estimates use `sdlbench/config/pricing.json`. When that file declares a `models` map, the selected model must have a matching pricing entry; otherwise the run fails instead of silently using another model's rates. `contextPerMTok` defaults to `0` for API cost estimates because prompt/context tokens are already included in input token charges.

Raw paired token savings and prompt-cache savings are separate measurements:

- Raw paired savings are `baseline.tokens.total - product.tokens.total`, reported only when both runs passed.
- Cache hit percent is `cache.readTokens / cache.inputTokens`.
- Cache discount savings compare billed input cost with the cost of billing every input token at the normal rate.
- Cache telemetry coverage is the share of records with explicit provider cache counters. A valid zero-hit record is available telemetry, not missing telemetry.
- Cache metrics are report-only. They do not alter raw token savings, claim gates, or command exit status.

## Product Status

Only `baseline` and `sdl` execute. Unsupported variant names fail before task execution. `crg` and `repomix` remain declarations in `config/products.lock.json` until real behavior integrations exist.

## Model Behavior Mode

Default runs stay in fixture mode: they apply task-local `solution.files`, then run the verifier. Use this for harness and token plumbing checks.

Pass `--behavior` to test model behavior. In behavior mode, SDLBench writes `.sdlbench-prompt.md` into the copied repo, runs the configured agent command template from `config/agents/<agent>.json`, then verifies the files the command changed. The checked-in Codex config defaults to `gpt-5.5` with `model_reasoning_effort="xhigh"`. The command template can use `{repo}`, `{prompt}`, `{taskId}`, `{variant}`, `{model}`, `{sdlMcpConfig}`, and `{sdlMcpUrl}` placeholders. Override it directly with `--agent-command "cmd {repo} {prompt}"` for local smoke tests.
Every variant receives the same neutral task prompt. SDLBench supplies the normal live MCP server, and the SDL Codex variant installs the production enforcement assets (`SDL.md`, `AGENTS.md`, `CODEX.md`, and `.codex/hooks/`) in the copied run root. These measured product assets provide workflow guidance and enforce SDL use without adding task-specific hints to the prompt.

Codex behavior runs are isolated from the developer environment. SDLBench uses an OS-temp worktree and temporary `CODEX_HOME`, copies only `auth.json`, and disables plugin, app, memory, personality, browser, computer-use, and discovered skill paths. A run fails if no matching Codex session token counts exist or if captured context contains Ponytail, generic plugin/app/skill instructions, or memory context.

The `opencode` agent uses the same neutral prompt and a per-run `XDG_DATA_HOME`. `OPENCODE_CONFIG_CONTENT` contains only the live SDL MCP entry for SDL or an empty MCP block for baseline. Provider token and cache counts come from the matching session row in the isolated `opencode.db`. See `docs/opencode.md` for models, pricing, and limits.

Behavior records include `artifacts.promptPath`, `artifacts.agent`, and `artifacts.changedFiles`. A pass means the agent command exited successfully and the verifier passed. Agent execution is asynchronous so observability sampling can continue; the runner awaits initial and final snapshots before recording the delta. Errors and timeouts remain unsuccessful attempt records.

## Comparison limitations and pairing safety

See [the measurement audit](docs/measurement-audit.md) before interpreting results as product effectiveness claims.

Analysis pairs by repository, task, agent, model, execution mode, warm-session setting, experiment ID, and repetition ID, with recorded provenance checks. Each input must contain at most one attempt per variant for that key, including failed attempts. Assign the same explicit `--experiment-id` and `--repetition-id` to separately launched baseline and SDL counterparts. Reusing those IDs for a retry creates an ambiguous attempt; preserve failures and assign a new planned repetition instead.

Paired uncertainty uses equally weighted repository/task means across repetitions and bootstraps those task means. Reports include independent task and paired observation counts; fewer than two tasks produce no interval. This does not prove that the selected tasks represent real workloads.

Historical records without complete provenance do not establish identical revisions, prompts, agent configurations, or pricing. Preserve the original JSONL rather than retroactively inventing missing evidence.

## Scaling experiments

Scaling defaults to behavior execution. Use `--execution-mode fixture` only for harness checks. It selects the requested size class before agent execution or indexing, records actual selected counts, and uses the same pairing rules as ordinary analysis.

`--repetitions N` rotates variant order across repetitions. Counterparts share an experiment ID and repetition ID. Selected counts include attempted tasks; paired counts include only matching attempts that both pass. Neither count proves representativeness or statistical independence.

## Offline verification

Run the harness tests from the repository root:

```bash
node --test sdlbench/tests/*.test.mjs
```

Offline tests use fixture or fake-agent evidence. They do not establish live product savings, actual enrichment expenses, or a validated warm-session experiment.
