# SDLBench: opencode + GLM-5.2 + Kimi K2.7 Code Implementation Plan

**Goal:** Add opencode as a runnable SDLBench agent backed by GLM-5.2 and Kimi K2.7 Code (via Neuralwatt.com), with sterile-runtime + per-session token extraction parallel to the Codex path.

**Architecture:** Reuse Codex's three-piece shape — agent config JSON, sterile runtime preparation, session-token extraction — for opencode. Two parallel pieces are simpler than Codex: (1) MCP works via `OPENCODE_CONFIG_CONTENT` inline JSON (no hook reinforcement, no `-c mcp_servers.x.url=` flags); (2) per-message `usage` records are richer than Codex's single cumulative blob. New `pricing.json` entries for `glm-5.2` and `kimi-k2.7-code` (Neuralwatt rate card).

**Tech Stack:** Node.js ESM (`.mjs`), `node:test`, existing tiktoken subprocess, OpenAI-compatible Neuralwatt API.

**User decisions (locked):**
- Ships **before** P2.4 (opencode is real & documented; Claude/Cursor/Aider follow later).
- Support **standard `kimi-k2.7-code` only** (no highspeed).
- **Neuralwatt.com for both** models: `glm-5.2` and `kimi-k2.7-code`. Base URL `https://api.neuralwatt.com/v1`.

**Grounding (cited findings):**
- `prepareCodexSterileRuntime` (`sdlbench.mjs:571`) and `findCodexSessionTokenCounts` (`sdlbench.mjs:1021`) are the templates to mirror.
- `tokensFromCodexSessionCounts` (`sdlbench.mjs:1102`) is the reshape-into-`tokens` template.
- `pricing.json` already uses `cachedInputPerMTok`/`reasoningOutputPerMTok` — schema is ready.
- `products.lock.json:3-7` already lists baseline/sdl with `supportedAgents: ["codex","claude"]`; opencode needs to be added.
- opencode storage path: `~/.local/share/opencode/storage/` per `sst/opencode` source + third-party tooling docs.
- opencode `getUsage` (src/session/session.ts) populates `tokens.{input, output, reasoning, cache.write, cache.read}` from provider `usage`.
- Neuralwatt `cached_input_per_million` defaults to 25% of input rate (`/v1/models` metadata).
- opencode MCP `remote` server config requires `type: "remote"`, `url`, optional `headers`.

---

## Chunk 1 — Pricing + agent config (additive)

### Task 1: Neuralwatt pricing entries

**Files:**
- Modify: `sdlbench/config/pricing.json`
- Test: `sdlbench/tests/sdlbench.test.mjs`

- [ ] **Step 1: Write failing test** asserting `estimateCost({input:1_000, output:200, cachedInput:900, reasoningOutput:100}, {model:"glm-5.2"})` returns split-out lines: `inputUsd=0.00145`, `cachedInputUsd=0.000324`, `outputUsd=0.0009`, `reasoningOutputUsd=0.00045`. For `kimi-k2.7-code`: `inputUsd=0.00095`, `cachedInputUsd=0.000216`, `outputUsd=0.0008`, `reasoningOutputUsd=0.0004`.
- [ ] **Step 2: Run -> FAIL**
- [ ] **Step 3: Add two entries to pricing.json**
- [ ] **Step 4: Run test -> PASS**
- [ ] **Step 5: Commit:** `feat(sdlbench): Neuralwatt pricing for glm-5.2 and kimi-k2.7-code`

### Task 2: opencode agent config

**Files:**
- Create: `sdlbench/config/agents/opencode.json`
- Test: `sdlbench/tests/sdlbench.test.mjs`

- [ ] **Step 1: Write failing test** for `loadAgentConfig(root, "opencode", {})` asserting it returns the expected shape.
- [ ] **Step 2: Run -> FAIL**
- [ ] **Step 3: Create `sdlbench/config/agents/opencode.json`**
- [ ] **Step 4: Run test -> PASS**
- [ ] **Step 5: Commit:** `feat(sdlbench): opencode agent config`

---

## Chunk 2 — Sterility + harness invocation

### Task 3: Sterile opencode runtime

**Files:**
- Modify: `sdlbench/src/sdlbench.mjs:571` region (add `prepareOpencodeSterileRuntime`)
- Modify: `sdlbench/src/sdlbench.mjs:100` region (`runBenchmark` behavior dispatch)
- Test: `sdlbench/tests/sdlbench.test.mjs`

- [ ] **Step 1: Write failing test** mirroring existing Codex sterile-runtime test for `agent:"opencode"`
- [ ] **Step 2: Run -> FAIL**
- [ ] **Step 3: Add `prepareOpencodeSterileRuntime`**
- [ ] **Step 4: Dispatch from `runBenchmark` behavior path**
- [ ] **Step 5: Redirect `OPENCODE_DATA_DIR` to temp**
- [ ] **Step 6: Run test -> PASS**
- [ ] **Step 7: Commit:** `feat(sdlbench): sterile opencode runtime with inline MCP config`

### Task 4: `sdlMcpConfigArgs` dispatch

**Files:**
- Modify: `sdlbench/src/sdlbench.mjs:562`
- Modify: `sdlbench/src/sdlbench.mjs:538-549` (thread `agent`)
- Test: `sdlbench/tests/sdlbench.test.mjs`

- [ ] **Step 1: Write failing test** for opencode config JSON output
- [ ] **Step 2: Run -> FAIL**
- [ ] **Step 3: Add `agent` param to `sdlMcpConfigArgs`;** add `opencodeConfigJson` helper
- [ ] **Step 4: Thread `agent` through `runAgentCommand`**
- [ ] **Step 5: Run test -> PASS; existing Codex tests pass**
- [ ] **Step 6: Commit:** `fix(sdlbench): dispatch sdlMcpConfigArgs by agent`

---

## Chunk 3 — Token extraction

### Task 5: `findOpencodeSessionTokenCounts` parser

**Files:**
- Modify: `sdlbench/src/sdlbench.mjs`
- Test: `sdlbench/tests/sdlbench.test.mjs`

- [ ] **Step 1: Write failing test** with a fake `~/.local/share/opencode/storage/` tree
- [ ] **Step 2: Run -> FAIL**
- [ ] **Step 3: Implement `findOpencodeSessionTokenCounts`**
- [ ] **Step 4: Add `defaultOpencodeStorageDir()`**
- [ ] **Step 5: Run test -> PASS**
- [ ] **Step 6: Commit:** `feat(sdlbench): findOpencodeSessionTokenCounts parser`

### Task 6: `tokensFromOpencodeSessionCounts` + dispatcher

**Files:**
- Modify: `sdlbench/src/sdlbench.mjs:1102` region
- Modify: `sdlbench/src/sdlbench.mjs:127` region (dispatch)
- Test: `sdlbench/tests/sdlbench.test.mjs`

- [ ] **Step 1: Write failing test**
- [ ] **Step 2: Run -> FAIL**
- [ ] **Step 3: Implement `tokensFromOpencodeSessionCounts`**
- [ ] **Step 4: Refactor token-count dispatch into `findAgentSessionTokenCounts`**
- [ ] **Step 5: Update "no matching session" error**
- [ ] **Step 6: Run test -> PASS; existing Codex tests pass**
- [ ] **Step 7: Commit:** `feat(sdlbench): tokensFromOpencodeSessionCounts + agent dispatcher`

---

## Chunk 4 — Products lock + smoke + docs

### Task 7: `products.lock.json` entries

**Files:**
- Modify: `sdlbench/config/products.lock.json`

- [ ] **Step 1: Extend `baseline` and `sdl` `supportedAgents`** to include `"opencode"`
- [ ] **Step 2: Run existing tests**
- [ ] **Step 3: Commit:** `feat(sdlbench): register opencode in products.lock`

### Task 8: Documentation + smoke test

**Files:**
- Modify: `sdlbench/README.md`
- Create: `sdlbench/docs/opencode.md`
- Test: `sdlbench/tests/sdlbench.test.mjs`

- [ ] **Step 1: Write end-to-end smoke test**
- [ ] **Step 2: Run -> FAIL**
- [ ] **Step 3: Hook up fixtures**
- [ ] **Step 4: Run test -> PASS**
- [ ] **Step 5: Write `sdlbench/docs/opencode.md`**
- [ ] **Step 6: Update `sdlbench/README.md`**
- [ ] **Step 7: Commit:** `docs(sdlbench): opencode agent + smoke test`

### Task 9: One validating run (per user approval)

- [ ] Confirm `opencode --version` + `NEURALWATT_API_KEY` set
- [ ] Smoke baseline run (opencode + GLM-5.2)
- [ ] Smoke SDL run (opencode + GLM-5.2)
- [ ] Swap to Kimi K2.7 Code; repeat both variants
- [ ] Run `sdlbench analyze`; confirm 4 records per agent+variant
- [ ] **Cost guardrail:** print predicted $$; require explicit user approval

---

## Sequencing & gates

| Phase | Exit gate | Cost |
|---|---|---|
| Chunk 1 | pricing.json carries both models; opencode.json loads | 0 |
| Chunk 2 | runBenchmark can launch opencode behavior-mode with sterile config | 0 |
| Chunk 3 | Per-session usage extraction works against mocked storage | 0 |
| Chunk 4 (config+docs) | Smoke test passes; docs committed | 0 |
| Chunk 4 (Task 9) | Real behavior run with each model produces real sessions.jsonl records | Real $$ — requires explicit `--i-understand-cost` |

**Decisions punted to execution time:**
- Exact opencode storage JSON shape (Task 5) — fetch authoritative opencode source via context7 if shape doesn't match
- Windows storage path — Task 3 step 5 sets `OPENCODE_DATA_DIR` so OS detection is moot
- Reasoning-mode flag — default to model defaults; `--variant` reasoning toggle is a follow-up
