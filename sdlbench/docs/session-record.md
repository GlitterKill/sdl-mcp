# SessionRecord

Each line in `sdlbench/results/sessions.jsonl` is one session record.

Required top-level fields:

- `schemaVersion`, `runId`, `sessionId`, `timestamp`
- `agent`, `model`, `variant`, `product`, `repoId`, `taskId`, `category`
- `status`, `durationMs`, `setupMs`, `agentMs`
- `tokens`, `cost`, `quality`, `workflow`, `artifacts`

Token fields include `input`, `output`, `total`, `productContext`, `rawEquivalent`, `saved`, `savingsPercent`, `model`, `encoding`, `modelHint`, `tokenizerResolution`, `tokenizerVersion`, and `tokenizerSource`. Behavior-mode Codex records with matching session data also include `cachedInput`, `uncachedInput`, `reasoningOutput`, `usageSource`, `sessionId`, `sessionFile`, and `modelContextWindow`.

`tokenizerSource` is `tiktoken` for tokenizer-subprocess records and `codex-session` when the benchmark finds Codex session JSONL `token_count` totals for the exact behavior-mode worktree. The benchmark runner asks tiktoken for the selected model's encoding first and falls back only to the configured encoding when tiktoken does not know that model. When Codex session counts are present, they become the primary `tokens` values and the tokenizer prompt estimate is written to `artifacts.estimatedTokens`.

Cost fields include `inputUsd`, `outputUsd`, `contextUsd`, `totalUsd`, `pricingModel`, `pricingSource`, `inputPerMTok`, `outputPerMTok`, and `contextPerMTok`. If `config/pricing.json` declares a `models` map, the selected model must have a matching pricing row.

For behavior-mode records, `artifacts.promptPath` points at the rendered prompt, `artifacts.agent` contains the command, exit code, stdout, and stderr, and `artifacts.changedFiles` lists files changed by the agent command. Codex records with session counts include `artifacts.codexSession`; the prompt-tokenizer fallback is retained as `artifacts.estimatedTokens`.

For SDL-variant records, `artifacts.sdl` contains the HTTP evidence used for token counts: `transport`, `repoId`, `durationMs`, `index`, `retrieval`, and the retrieved `context`. `transport` is `"http"`; `index` is the `/reindex-stream` completion payload; `retrieval` contains query summaries and `/api/symbol/:repoId/search` results used to build the context. Missing or empty retrieval fails the run instead of writing estimator-backed savings.

`workflow.executionMode` is `fixture` for canned-solution runs and `behavior` for agent-command runs.

Quality fields include deterministic pass/fail values for fixture tasks: `passed`, `errorRate`, `weightedErrorRate`, and `rubricScore`.
