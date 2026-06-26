# SDLBench

SDLBench is an isolated benchmark harness for comparing agent runs with and without SDL-MCP context. V1 keeps all code under `sdlbench/` and writes append-only records to `sdlbench/results/sessions.jsonl`.

## Commands

```bash
node sdlbench/src/cli.mjs setup all
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent codex --variant baseline --model gpt-5.5
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent codex --variant sdl --model gpt-5.5
node sdlbench/src/cli.mjs run --matrix sdlbench/tasks/matrix.json --agent codex --variant sdl --model gpt-5.5 --behavior
node sdlbench/src/cli.mjs analyze --in sdlbench/results/sessions.jsonl
node sdlbench/src/cli.mjs view --port 4177
```

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

For `--variant sdl`, the runner indexes and retrieves context through the SDL-MCP HTTP server before applying task solution files. By default it starts a temporary `serve --http` process for the copied fixture repo, waits on `/health`, runs `POST /api/repo/:repoId/reindex-stream` with `mode: "full"`, and retrieves task context with `GET /api/symbol/:repoId/search` for each task's `context.sdlQueries`. Tests can pass `sdlHttpBaseUrl` to use an existing HTTP server.

The temporary config mirrors the production SDL-MCP shape closely enough for benchmark evidence: Rust indexing with `pipeline: "auto"`, concurrency 12, pass2 concurrency 8, provider-first LSP `primaryWithCaps`, file watching enabled, policy windows at 180 lines / 1400 tokens, local semantic embeddings with DML/CPU fallback and hybrid retrieval, SCIP auto-ingest/generation, prefetch off, HTTP local-only, and auth disabled for local Codex MCP access. Provider-first only counts as evidence when the HTTP indexing response reports provider-first execution; otherwise the record still proves real HTTP indexing/retrieval but not provider-first savings.



SDL token counts use the retrieved HTTP context, not the canned `context.sdl` task text. If indexing or retrieval returns no symbols, the SDL run fails instead of writing savings evidence.

## Metrics

`results/sessions.jsonl` is the canonical chart source. `analyze` writes `results/summary.json`; the viewer reads the JSONL directly and renders token use, cost, time to completion, correctness, timeline, and product matrix charts with per-chart PNG export.

Token counts use the selected model first: `--model`, then `config/agents/<agent>.json` `model`, then `config/pricing.json` `defaultModel`. Fixture-mode records use the tokenizer subprocess, which calls `tiktoken.encoding_for_model(model)` and falls back to the configured encoding only when tiktoken does not know that model. Codex behavior-mode records prefer Codex session JSONL `token_count` totals for the matching run worktree, including `input`, `cachedInput`, `output`, `reasoningOutput`, and `total`; the prompt estimate is kept at `artifacts.estimatedTokens` only when session counts are available.

Cost estimates use `sdlbench/config/pricing.json`. When that file declares a `models` map, the selected model must have a matching pricing entry; otherwise the run fails instead of silently using another model's rates. `contextPerMTok` defaults to `0` for API cost estimates because prompt/context tokens are already included in input token charges.

## Model Behavior Mode

Default runs stay in fixture mode: they apply task-local `solution.files`, then run the verifier. Use this for harness and token plumbing checks.

Pass `--behavior` to test model behavior. In behavior mode, SDLBench writes `.sdlbench-prompt.md` into the copied repo, runs the configured agent command template from `config/agents/<agent>.json`, then verifies the files the command changed. The checked-in Codex config defaults to `gpt-5.5` with `model_reasoning_effort="xhigh"`. The command template can use `{repo}`, `{prompt}`, `{taskId}`, `{variant}`, `{model}`, `{sdlMcpConfig}`, and `{sdlMcpUrl}` placeholders. Override it directly with `--agent-command "cmd {repo} {prompt}"` for local smoke tests.

Codex behavior runs are isolated from the developer's normal Codex environment. By default, behavior worktrees are copied outside this repository under the OS temp directory so parent `AGENTS.md` files cannot bleed into the baseline. For each Codex task, SDLBench creates a temporary `CODEX_HOME`, copies only `auth.json`, disables plugin/app/memory/personality/browser/computer-use features, and disables every discovered user/plugin/system skill path in the temporary config. SDL hooks remain enabled so the `sdl` variant can still use the benchmark-installed SDL workflow hooks and local SDL instructions. A Codex behavior run fails instead of writing benchmark evidence if no matching Codex session token-count JSONL is found or if the captured session contains Ponytail, generic plugin/app/skill instructions, or memory context.

Behavior records include `artifacts.promptPath`, `artifacts.agent`, and `artifacts.changedFiles`. A pass means the agent command exited successfully and the verifier passed.
