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
node sdlbench/src/cli.mjs claims --in sdlbench/results/sessions.jsonl --profile realism
node sdlbench/src/cli.mjs analyze --in sdlbench/results/sessions.jsonl
node sdlbench/src/cli.mjs view --port 4177
```

## Honest Reporting

SDLBench enforces truth in savings claims:

- **Schema v2**: fixture-mode records carry `claimGrade: "none"` and zeroed
  `tokens.saved`. Only behavior-mode Codex session counts (`claimGrade:
  "primary"`) can support savings assertions.
- **Pass-gated paired deltas**: the summary's `paired[]` array contains only
  tasks where both baseline and SDL passed. `deltas.sdl.tokensSaved` is derived
  from paired token-total deltas, not from a per-record `saved` field.
- **Headline claim**: `summary.headlineClaim` is always "median paired savings
  on tasks both solved."
- **Claim gates**: run `sdlbench claims --profile realism` to validate gates
  (p50 >= 50%, p25 >= 40%, min task >= 20%, coverage >= 0.5, fairness >= 20%).
  See `docs/claims.md` for the full policy.
- **Fairness auditor**: `fairness.mjs` measures the token cost of SDL
  reinforcement injections (AGENTS.md, SDL.md, hooks) and reports
  `netSavingsPct` after deducting them.
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

For `--variant sdl`, the runner prepares a normal SDL-MCP HTTP server and indexes the copied fixture repo before the task starts. By default it starts a temporary `serve --http` process, waits on `/health`, and runs `POST /api/repo/:repoId/reindex-stream` with `mode: "full"`. It does not pre-run task-specific symbol searches, paste `context.sdl`, or convert `context.sdlQueries` into seeded slice entries; behavior-mode agents must discover context through the live SDL tools during the measured session. Tests can pass `sdlHttpBaseUrl` to use an existing HTTP server.

The temporary config starts from `config/sdlmcp.config.example.json` so provider-first indexing, the Rust indexer, SCIP, semantic retrieval/enrichment, file watching, policy, prefetch, and exclusive Code Mode track the default SDL-MCP configuration. SDLBench only overrides the copied repo root, graph DB path, local HTTP/auth settings, benchmark ignore globs, and repo languages from `repos.lock`. Provider-first only counts as evidence when the HTTP indexing response reports provider-first execution; otherwise the record still proves real HTTP indexing/setup but not provider-first savings.



SDL token counts use the rendered prompt plus measured agent session data when available. `context.sdl` and `context.sdlQueries` are fixture metadata, not privileged prompt input. If HTTP indexing fails, the SDL run fails instead of writing savings evidence.

## Metrics

`results/sessions.jsonl` is the canonical chart source. `analyze` writes `results/summary.json`; the viewer reads the JSONL directly and renders token use, cost, time to completion, correctness, timeline, and product matrix charts with per-chart PNG export.

Token counts use the selected model first: `--model`, then `config/agents/<agent>.json` `model`, then `config/pricing.json` `defaultModel`. Fixture-mode records use the tokenizer subprocess, which calls `tiktoken.encoding_for_model(model)` and falls back to the configured encoding only when tiktoken does not know that model. Codex behavior-mode records prefer Codex session JSONL `token_count` totals for the matching run worktree, including `input`, `cachedInput`, `output`, `reasoningOutput`, and `total`; the prompt estimate is kept at `artifacts.estimatedTokens` only when session counts are available.

Cost estimates use `sdlbench/config/pricing.json`. When that file declares a `models` map, the selected model must have a matching pricing entry; otherwise the run fails instead of silently using another model's rates. `contextPerMTok` defaults to `0` for API cost estimates because prompt/context tokens are already included in input token charges.

## Model Behavior Mode

Default runs stay in fixture mode: they apply task-local `solution.files`, then run the verifier. Use this for harness and token plumbing checks.

Pass `--behavior` to test model behavior. In behavior mode, SDLBench writes `.sdlbench-prompt.md` into the copied repo, runs the configured agent command template from `config/agents/<agent>.json`, then verifies the files the command changed. The checked-in Codex config defaults to `gpt-5.5` with `model_reasoning_effort="xhigh"`. The command template can use `{repo}`, `{prompt}`, `{taskId}`, `{variant}`, `{model}`, `{sdlMcpConfig}`, and `{sdlMcpUrl}` placeholders. Override it directly with `--agent-command "cmd {repo} {prompt}"` for local smoke tests.
For SDL behavior runs, the rendered prompt includes generic SDL guidance and passes the live MCP server config so the agent can discover task context with tools during the measured session.

Codex behavior runs are isolated from the developer's normal Codex environment. By default, behavior worktrees are copied outside this repository under the OS temp directory so parent `AGENTS.md` files cannot bleed into the baseline. For each Codex task, SDLBench creates a temporary `CODEX_HOME`, copies only `auth.json`, disables plugin/app/memory/personality/browser/computer-use features, and disables every discovered user/plugin/system skill path in the temporary config. SDL hooks remain enabled so the `sdl` variant can still use the benchmark-installed SDL workflow hooks and local SDL instructions. A Codex behavior run fails instead of writing benchmark evidence if no matching Codex session token-count JSONL is found or if the captured session contains Ponytail, generic plugin/app/skill instructions, or memory context.

The `opencode` agent follows a parallel sterility model: a per-taskRunId `OPENCODE_DATA_DIR` redirects session storage away from
`~/.local/share/opencode/storage/`, and `OPENCODE_CONFIG_CONTENT` is set to an inline JSON config carrying only the SDL MCP remote server entry (for `--variant sdl`) or an empty `mcp: {}` block (baseline). Token counts come from per-message `usage` records in the fragmented storage tree (parsed by `extractOpencodeSessionUsage`). See `docs/opencode.md` for the full setup, supported models (GLM-5.2 / Kimi K2.7 Code via Neuralwatt), and known limits.

Behavior records include `artifacts.promptPath`, `artifacts.agent`, and `artifacts.changedFiles`. A pass means the agent command exited successfully and the verifier passed.
