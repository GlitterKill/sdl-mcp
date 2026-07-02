# SDL-MCP Tool Output QA Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the QA friction points found in active SDL-MCP tools while keeping the tool surface compact and useful for agents.

**Architecture:** Prefer output shaping at the handler/formatter boundary over changing indexed data. Add compatibility knobs only where a compact default would otherwise hide real diagnostics. Keep ingest/index.refresh behavior out of scope.

**Tech Stack:** TypeScript ESM, Zod schemas in `src/mcp/tools.ts`, SDL code-mode catalog/manual generation, Node `node:test` test suites with `--experimental-strip-types`.

---

## Scope And Guardrails

- Do not change ingest or `index.refresh` semantics.
- Keep default outputs agent-sized. Add `detail: "full"` or focused limits only where an existing user may still need raw detail.
- Do not add dependencies.
- Prefer deleting noisy fields from default responses over adding post-processing layers.
- Do not return raw timing `diagnostics` objects in any agent-visible tool output, including `sdl.context`, `sdl.workflow`, `sdl.file`, direct gateway actions, handles, continuations, and error envelopes. Timing data belongs in telemetry/logs or explicit non-model debug artifacts, not ordinary result payloads.

## Files To Touch

- Modify: `src/semantic/enrichment.ts` - compact semantic enrichment status DTO and run metadata shaping.
- Modify: `src/mcp/tools/semantic-enrichment.ts` - pass status detail/limits to semantic status handler.
- Modify: `src/mcp/tools.ts` - schema knobs for status/register/runtime/manual-facing operation unions, and remove/deprecate agent-visible diagnostics response fields.
- Modify: `src/server.ts` - strip timing diagnostics from every agent-visible response envelope.
- Modify: `src/mcp/context-response-projection.ts` - remove diagnostics from context projection and response handles.
- Modify: `src/mcp/tools/context.ts` - stop attaching diagnostics to `sdl.context` results.
- Modify: `src/code-mode/workflow-executor.ts` - stop returning diagnostics from `sdl.workflow` and continuations.
- Modify: `src/mcp/tools/file-gateway.ts` - stop returning diagnostics from `sdl.file` operations.
- Modify: `src/mcp/tools/repo.ts` - compact unchanged `repo.register` dry-run response.
- Modify: `src/code-mode/action-catalog.ts` - action search ranking and discriminated-union schema summaries.
- Modify: `src/code-mode/manual-generator.ts` - examples and schema rendering for `symbol.edit`, `runtime.execute`, and transforms.
- Modify: `src/code-mode/transforms.ts` - fix `dataPick` mapping or alias it to the working projection path.
- Modify: `src/mcp/tools/runtime.ts` - align shell runtime schema/behavior and suppress shell prompt noise where possible.
- Modify: `src/mcp/tools/code.ts` - make `code.needWindow` anchor windows around requested identifiers.
- Modify: `src/mcp/tools/prRisk.ts` - enrich bare changed-symbol IDs with available name/file/kind or mark them unresolved compactly.
- Modify: `src/mcp/context-response-projection.ts` or the response projection helper that emits directory exports - dedupe/filter generated export names in continuation/repo overview payloads.
- Modify: summary producer found by `rg "using available signature" src` - stop emitting filler summaries.
- Test: `tests/unit/code-mode-transforms.test.ts`.
- Test: `tests/unit/code-mode-manual.test.ts`.
- Test: `tests/unit/mcp-action-search.test.ts`.
- Test: `tests/unit/code-mode-workflow-executor.test.ts`.
- Test: `tests/unit/code-mode-retrieve.test.ts` or `tests/unit/friction-fixes.test.ts` if that existing file is the local convention for code-window regressions.
- Test: semantic/repo/runtime/pr-risk unit tests nearest existing coverage; locate with `rg "semantic.enrichment|repo.register|runtime.execute|pr.risk" tests/unit src` before adding files.

---

## Chunk 1: Remove Agent-Visible Diagnostics And Compact Noisy Status Outputs

### Task 0: Remove `diagnostics` From Every Agent-Visible Tool Output

**Files:**
- Modify: `src/server.ts`
- Modify: `src/mcp/context-response-projection.ts`
- Modify: `src/mcp/tools/context.ts`
- Modify: `src/code-mode/workflow-executor.ts`
- Modify: `src/mcp/tools/file-gateway.ts`
- Modify: `src/mcp/tools/runtime.ts`
- Modify: `src/mcp/tools/repo.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/unit/tool-response-envelope.test.ts`
- Test: `tests/unit/context-response-projection.test.ts`
- Test: `tests/unit/code-mode-workflow-executor.test.ts`
- Test: `tests/unit/response-artifacts.test.ts`

- [ ] Step 1: Write failing tests proving diagnostics are absent from all agent-visible result shapes.

Cover these calls with `includeDiagnostics: true` where the schema still accepts it:

```ts
assert.equal("diagnostics" in contextResult, false);
assert.equal("diagnostics" in workflowResult, false);
assert.equal("diagnostics" in fileGatewayResult, false);
assert.equal("diagnostics" in directGatewayResult, false);
assert.equal(JSON.stringify(responseHandlePayload).includes('"diagnostics"'), false);
assert.equal(JSON.stringify(errorEnvelope).includes('"diagnostics"'), false);
```

- [ ] Step 2: Keep timing diagnostics internal only.

Rules:
- no `diagnostics` field in any payload the agent sees: direct tools, `sdl.context`, `sdl.workflow`, `sdl.file`, response handles, continuations, formatter output, and error envelopes.
- do not remove internal timers, telemetry logging, or trace data used by server internals.
- if callers need performance data later, expose it through a separate non-default debug command or telemetry artifact, not ordinary tool results.

- [ ] Step 3: Strip diagnostics at the outer response boundary.

Use the highest shared boundary in `src/server.ts` and projection helpers first. Then remove direct per-tool attachments that would reintroduce the field.

- [ ] Step 4: Deprecate or neutralize `includeDiagnostics` in model-facing schemas.

Preferred minimal behavior:
- keep accepting `includeDiagnostics` for compatibility.
- document it as internal/no-op for agent-visible output.
- remove `diagnostics` from response schemas where tests show it is advertised to agents.

- [ ] Step 5: Run focused diagnostics-output tests.

Run:

```bash
node --test --experimental-strip-types \
  tests/unit/tool-response-envelope.test.ts \
  tests/unit/context-response-projection.test.ts \
  tests/unit/code-mode-workflow-executor.test.ts \
  tests/unit/response-artifacts.test.ts
```

Expected: PASS, with no `diagnostics.timings.phases` strings in serialized agent-visible results.

- [ ] Step 6: Commit.

```bash
git add src/server.ts src/mcp/context-response-projection.ts src/mcp/tools/context.ts src/code-mode/workflow-executor.ts src/mcp/tools/file-gateway.ts src/mcp/tools/runtime.ts src/mcp/tools/repo.ts src/mcp/tools.ts tests/unit/tool-response-envelope.test.ts tests/unit/context-response-projection.test.ts tests/unit/code-mode-workflow-executor.test.ts tests/unit/response-artifacts.test.ts
git commit -m "fix: remove diagnostics from agent-visible tool outputs"
```

### Task 1: Trim `semantic.enrichment.status` Defaults

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/tools/semantic-enrichment.ts`
- Modify: `src/semantic/enrichment.ts`
- Test: nearest existing semantic enrichment unit test, or create `tests/unit/semantic-enrichment-status.test.ts`

- [ ] Step 1: Write a failing test for compact status.

Expected compact response:

```ts
assert.equal(result.ok, true);
assert.equal(result.repoId, "sdl-mcp");
assert.ok(result.lastRuns.length <= 3);
assert.equal("metadataJson" in result.lastRuns[0], false);
assert.deepEqual(Object.keys(result.lastRuns[0]).sort(), [
  "cacheHit",
  "diagnosticsCount",
  "documentsProcessed",
  "finishedAt",
  "languages",
  "providerId",
  "providerType",
  "runId",
  "selected",
  "startedAt",
  "status",
  "symbolsMatched",
].sort());
```

- [ ] Step 2: Add schema fields with compact defaults.

Minimal schema shape:

```ts
detail: z.enum(["compact", "full"]).default("compact").optional(),
lastRunsLimit: z.number().int().min(0).max(25).default(3).optional(),
```

- [ ] Step 3: Implement compact shaping in `getSemanticEnrichmentStatus`.

Rules:
- compact omits `metadataJson`, `sourceIndexPath`, raw coverage samples, and long provider internals.
- compact keeps status, selected provider, counts, diagnostics count, and timestamps.
- full preserves current response for debugging.
- `lastRunsLimit` applies before serialization.

- [ ] Step 4: Run focused tests.

Run: `node --test --experimental-strip-types tests/unit/semantic-enrichment-status.test.ts`
Expected: PASS.

- [ ] Step 5: Commit.

```bash
git add src/semantic/enrichment.ts src/mcp/tools/semantic-enrichment.ts src/mcp/tools.ts tests/unit/semantic-enrichment-status.test.ts
git commit -m "fix: compact semantic enrichment status output"
```

### Task 2: Compact Unchanged `repo.register` Dry Runs

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/tools/repo.ts`
- Test: existing repo tool unit test or create `tests/unit/repo-register-output.test.ts`

- [ ] Step 1: Write a failing test for unchanged dry run.

Expected unchanged response:

```ts
assert.equal(result.dryRun, true);
assert.equal(result.changed, false);
assert.equal(result.currentConfig, undefined);
assert.equal(result.proposedConfig, undefined);
assert.deepEqual(result.configChanges, []);
```

- [ ] Step 2: Add an explicit full-detail escape hatch.

```ts
detail: z.enum(["summary", "full"]).default("summary").optional(),
```

- [ ] Step 3: Change `handleRepoRegister` output logic.

Rules:
- if `dryRun && !changed && detail !== "full"`, return summary only.
- if `changed` or `detail === "full"`, preserve current/proposed config fields.
- keep `configChanges` because it is concise and useful.

- [ ] Step 4: Run focused tests.

Run: `node --test --experimental-strip-types tests/unit/repo-register-output.test.ts`
Expected: PASS.

- [ ] Step 5: Commit.

```bash
git add src/mcp/tools.ts src/mcp/tools/repo.ts tests/unit/repo-register-output.test.ts
git commit -m "fix: summarize unchanged repo register dry runs"
```

---

## Chunk 2: Catalog, Manual, And Transform Friction

### Task 3: Fix `dataPick` Mapping

**Files:**
- Modify: `src/code-mode/transforms.ts`
- Test: `tests/unit/code-mode-transforms.test.ts`

- [ ] Step 1: Write failing tests for manual-style mapping.

```ts
const input = [{ symbolId: "s1", name: "Alpha" }];
const result = execDataPick({ input, fields: { id: "symbolId", label: "name" } });
assert.deepEqual(result, [{ id: "s1", label: "Alpha" }]);
```

Also test `$0.results`-style array references if coverage already exists in workflow tests.

- [ ] Step 2: Implement the smallest fix.

Preferred fix: make `dataPick` use the same path-resolution helper as `dataMap`, or delegate `dataPick` to `dataMap` if semantics are identical.

- [ ] Step 3: Keep warning behavior only for genuinely missing fields.

Expected missing-field result should still name the unresolved fields, but successful mappings must return an array, not a warning object.

- [ ] Step 4: Run focused tests.

Run: `node --test --experimental-strip-types tests/unit/code-mode-transforms.test.ts`
Expected: PASS.

- [ ] Step 5: Commit.

```bash
git add src/code-mode/transforms.ts tests/unit/code-mode-transforms.test.ts
git commit -m "fix: map dataPick fields correctly"
```

### Task 4: Make Catalog Search Useful For Broad Queries

**Files:**
- Modify: `src/code-mode/action-catalog.ts`
- Test: `tests/unit/mcp-action-search.test.ts`

- [ ] Step 1: Add failing tests for broad discovery.

Queries that should return non-empty results:

```ts
"repo symbol slice code delta policy usage file search edit buffer runtime response agent feedback semantic"
"all tools"
"tool catalog"
```

- [ ] Step 2: Fix ranking without adding a search subsystem.

Minimal logic:
- tokenize query by whitespace/punctuation.
- score if any token matches action, fn, namespace, tags, description, or schema field names.
- special-case `all tools`, `tool catalog`, and `list tools` to return catalog-like top results.
- keep `excludeDisabled` behavior.

- [ ] Step 3: Run focused tests.

Run: `node --test --experimental-strip-types tests/unit/mcp-action-search.test.ts`
Expected: PASS.

- [ ] Step 4: Commit.

```bash
git add src/code-mode/action-catalog.ts tests/unit/mcp-action-search.test.ts
git commit -m "fix: broaden action search matching"
```

### Task 5: Expand Manual Schemas For Discriminated Unions

**Files:**
- Modify: `src/code-mode/action-catalog.ts`
- Modify: `src/code-mode/manual-generator.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/unit/code-mode-manual.test.ts`

- [ ] Step 1: Write failing tests for `symbol.edit` and `runtime.execute` docs.

Assertions:
- `symbol.edit.operation` lists concrete `kind` values, including `replaceSymbol`.
- manual example does not mention `replaceBody`.
- shell runtime docs show `code`, not `command`, as the supported shell input.

- [ ] Step 2: Teach schema summary rendering to unwrap discriminated unions.

Output should stay compact:

```text
operation.kind: replaceSymbol | replaceSignature | rename | insertBefore | insertAfter | delete
```

Do not dump full Zod internals.

- [ ] Step 3: Update manual examples.

Replace the stale example:

```json
{ "kind": "replaceBody", "content": "return true;\n" }
```

with:

```json
{ "kind": "replaceSymbol", "content": "export function target() { return true; }\n" }
```

- [ ] Step 4: Run manual/catalog tests.

Run: `node --test --experimental-strip-types tests/unit/code-mode-manual.test.ts tests/unit/mcp-action-search.test.ts`
Expected: PASS.

- [ ] Step 5: Commit.

```bash
git add src/code-mode/action-catalog.ts src/code-mode/manual-generator.ts src/mcp/tools.ts tests/unit/code-mode-manual.test.ts tests/unit/mcp-action-search.test.ts
git commit -m "fix: document concrete tool operation variants"
```

---

## Chunk 3: Code And Runtime Tool Behavior

### Task 6: Anchor `code.needWindow` Around Requested Identifiers

**Files:**
- Modify: `src/mcp/tools/code.ts`
- Test: `tests/unit/code-mode-retrieve.test.ts` or `tests/unit/friction-fixes.test.ts`

- [ ] Step 1: Write a failing regression.

Scenario:
- request `codeNeedWindow` for `handleRepoStatus` with `identifiersToFind: ["watcherHealth", "prefetchStats"]` and `expectedLines: 35`.
- assert returned code contains at least one requested identifier when the identifier exists in the symbol.

- [ ] Step 2: Reuse existing hot-path/location logic.

Do not add a second parser. The lazy fix is to use the same identifier location path as `codeHotPath` to choose the initial cursor/window before slicing raw code.

- [ ] Step 3: Preserve denial behavior.

Rules:
- if identifiers do not exist, return the current denial/suggested-next-request behavior.
- if identifiers exist but cannot fit together, return the best first matching window and include continuation guidance.
- if a cursor is provided, respect the cursor.

- [ ] Step 4: Run focused tests.

Run: `node --test --experimental-strip-types tests/unit/code-mode-retrieve.test.ts tests/unit/friction-fixes.test.ts`
Expected: PASS.

- [ ] Step 5: Commit.

```bash
git add src/mcp/tools/code.ts tests/unit/code-mode-retrieve.test.ts tests/unit/friction-fixes.test.ts
git commit -m "fix: anchor raw code windows to requested identifiers"
```

### Task 7: Align Shell Runtime Schema And Suppress Prompt Echo Noise

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/tools/runtime.ts`
- Modify: `src/code-mode/manual-generator.ts`
- Test: existing runtime unit test or create `tests/unit/runtime-tool-output.test.ts`

- [ ] Step 1: Write failing tests.

Cases:
- shell runtime rejects `command` with an actionable schema message, or accepts `command` by translating it to `code`.
- minimal shell output for `git status --short` does not include the shell prompt/echo line.

- [ ] Step 2: Choose the smallest compatible behavior.

Recommendation: accept `command` as an alias for shell only and normalize it into `code`. This matches the advertised schema and avoids breaking existing callers.

- [ ] Step 3: Strip shell prompt/echo lines from persisted stdout summaries where the tool injected them.

Keep real command output and stderr intact. Do not hide failures.

- [ ] Step 4: Update manual/schema wording.

Document shell accepted inputs clearly:

```text
shell: use code, or command as a compatibility alias; args are not executed directly.
```

- [ ] Step 5: Run focused tests.

Run: `node --test --experimental-strip-types tests/unit/runtime-tool-output.test.ts tests/unit/code-mode-manual.test.ts`
Expected: PASS.

- [ ] Step 6: Commit.

```bash
git add src/mcp/tools.ts src/mcp/tools/runtime.ts src/code-mode/manual-generator.ts tests/unit/runtime-tool-output.test.ts tests/unit/code-mode-manual.test.ts
git commit -m "fix: align shell runtime schema and output"
```

---

## Chunk 4: Agent-Relevant Result Shaping

### Task 8: Dedupe And Filter Directory Export Lists

**Files:**
- Modify: `src/mcp/context-response-projection.ts` or the repo overview projection helper identified by `rg "exports" src/mcp src/code-mode src/graph`
- Test: `tests/unit/code-mode-workflow-executor.test.ts` or nearest repo overview projection test

- [ ] Step 1: Write failing tests for export cleanup.

Input exports:

```ts
["__dirname", "__dirname", "__filename", "foo().(params)typeLiteral151:clock", "handleRepoStatus"]
```

Expected compact output:

```ts
["__dirname", "__filename", "handleRepoStatus"]
```

- [ ] Step 2: Implement one shared filter helper.

Rules:
- stable-dedupe while preserving order.
- filter generated type-literal names matching `typeLiteral\d+` and synthetic parameter property paths.
- keep real exported identifiers, modules, and test helpers.

- [ ] Step 3: Use the helper in repo overview and workflow continuation result shaping.

Do not mutate stored graph data.

- [ ] Step 4: Run focused tests.

Run: `node --test --experimental-strip-types tests/unit/code-mode-workflow-executor.test.ts`
Expected: PASS.

- [ ] Step 5: Commit.

```bash
git add src/mcp/context-response-projection.ts tests/unit/code-mode-workflow-executor.test.ts
git commit -m "fix: compact directory export summaries"
```

### Task 9: Replace Filler Symbol Summaries With Useful Empty/Fallback Output

**Files:**
- First locate: `rg "using available signature" src`
- Likely modify: `src/indexer/summary-generator.ts`, `src/indexer/symbol-embedding-context.ts`, or the exact producer found above.
- Test: nearest summary unit test, or create `tests/unit/symbol-summary-output.test.ts`

- [ ] Step 1: Locate the producer.

Run: `rg "using available signature|graph context metadata|Handles .* as handler" src tests`
Expected: one formatter/generator path.

- [ ] Step 2: Write failing tests.

Expected behavior:
- no summary should include `using available signature, role, path, language, and graph context metadata`.
- if there is no meaningful summary, return `undefined` or a terse role phrase like `Handles repo status.`.

- [ ] Step 3: Implement the smallest output change.

Preferred rule:
- if the fallback sentence would only restate metadata fields, omit it.
- keep genuine summaries from provider/indexer data.
- keep signatures separate; do not embed them in prose.

- [ ] Step 4: Run focused tests.

Run: `node --test --experimental-strip-types tests/unit/symbol-summary-output.test.ts`
Expected: PASS.

- [ ] Step 5: Commit.

```bash
git add <summary-producer-file> tests/unit/symbol-summary-output.test.ts
git commit -m "fix: remove filler symbol summaries"
```

### Task 10: Enrich PR Risk Changed Symbols

**Files:**
- Modify: `src/mcp/tools/prRisk.ts`
- Test: existing PR risk test or create `tests/unit/pr-risk-output.test.ts`

- [ ] Step 1: Write failing tests for bare ID output.

Given a changed symbol with only `symbolId`, expected output includes either:

```ts
{ symbolId, name: "<unresolved>", file: undefined, unresolved: true }
```

or a hydrated `{ symbolId, name, kind, file }` when the repository can resolve it.

- [ ] Step 2: Hydrate changed symbols from existing delta/card lookup path.

Do not add per-symbol DB queries in a loop if a batch helper exists. If no batch helper exists, add one narrow query in the PR risk module and cap by existing budget.

- [ ] Step 3: Keep truncation metadata.

If hydration fails, mark unresolved compactly instead of returning a bare hash.

- [ ] Step 4: Run focused tests.

Run: `node --test --experimental-strip-types tests/unit/pr-risk-output.test.ts`
Expected: PASS.

- [ ] Step 5: Commit.

```bash
git add src/mcp/tools/prRisk.ts tests/unit/pr-risk-output.test.ts
git commit -m "fix: include symbol context in pr risk output"
```

---

## Chunk 5: Final Verification And Docs

### Task 11: Re-run The QA Smoke Scenarios

**Files:**
- No source edits unless a regression is found.

- [ ] Step 1: Run focused unit tests from all chunks.

Run:

```bash
node --test --experimental-strip-types \
  tests/unit/code-mode-transforms.test.ts \
  tests/unit/code-mode-manual.test.ts \
  tests/unit/mcp-action-search.test.ts \
  tests/unit/code-mode-workflow-executor.test.ts \
  tests/unit/code-mode-retrieve.test.ts \
  tests/unit/friction-fixes.test.ts
```

Expected: PASS. If a listed file does not exist, replace it with the concrete test file created in the earlier task.

- [ ] Step 2: Run tool-level QA smoke through SDL-MCP.

Use `sdl.workflow` with small bounded calls:
- serialized outputs for `sdl.context`, `sdl.workflow`, `sdl.file`, direct gateway actions, response handles, continuations, and error envelopes contain no `"diagnostics"` key even when `includeDiagnostics: true` is sent.
- `semanticEnrichmentStatus({ languages:["typescript"] })` returns under 2k tokens by default.
- `repoRegister({ dryRun:true })` unchanged response omits duplicated config.
- `dataPick` maps literal arrays and `$N.results` arrays.
- `action.search` broad query returns relevant tools.
- `manual({ actions:["symbol.edit", "runtime.execute"] })` shows concrete operation/shell docs.
- `codeNeedWindow` with existing identifiers returns a matching window.
- `prRiskAnalyze` has no bare hash-only changed symbols in returned item samples.

- [ ] Step 3: Check no scratch files or accidental edits remain.

Run: `git status --short`
Expected: only intentional source/test/doc changes.

- [ ] Step 4: Run typecheck.

Run: `npm run typecheck`
Expected: PASS.

- [ ] Step 5: Run lint if typecheck passes.

Run: `npm run lint`
Expected: PASS.

- [ ] Step 6: Update docs if public tool schema changed.

Check and update:
- `SDL.md` if tool usage guidance mentions affected tools.
- `AGENTS.md` only if workflow guidance changes.
- any generated manual/golden snapshot docs if tests indicate drift.

- [ ] Step 7: Commit final verification/docs.

```bash
git add SDL.md AGENTS.md docs/superpowers/plans/2026-07-01-sdl-mcp-tool-output-qa-fixes.md
git commit -m "docs: record sdl tool output qa fix plan"
```

Only include docs that actually changed.

## Acceptance Criteria

- No agent-visible tool output contains a raw `diagnostics` field, including `sdl.context`, `sdl.workflow`, `sdl.file`, direct gateway actions, response handles, continuations, formatter output, and error envelopes.
- Default `semantic.enrichment.status` no longer returns raw `metadataJson` or historical sample dumps.
- Unchanged `repo.register` dry runs no longer duplicate full config blocks by default.
- `dataPick` manual-style mapping works.
- Broad `action.search` queries return useful catalog results.
- `symbol.edit` manual/catalog output exposes real operation variants and no stale `replaceBody` example.
- Shell runtime docs and behavior agree, and minimal output does not include injected prompt/command echo noise.
- `code.needWindow` returns code near requested identifiers when they exist.
- Directory export summaries are deduped and omit generated type-literal names.
- Filler summaries are removed or replaced with genuinely useful terse summaries.
- `pr.risk.analyze` does not return bare hash-only changed-symbol samples.
- Focused tests, typecheck, and lint pass.
