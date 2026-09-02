# SDL.md - SDL-MCP Agent Workflow

Use this file as the repository fallback for the `sdl-mcp-agent-workflow` skill. If that skill is loaded by the client or by a session-start hook, treat the skill as authoritative and use this file as a compact local reference.

SDL-MCP is the normal repository interface. Native filesystem and shell tools are fallback-only when SDL-MCP is unavailable, or when accessing agent memory and other internal client data outside the indexed repository.

When a client bridge returns the raw MCP result, prefer `structuredContent`; use text `content` only as a fallback for older servers. Do not emit both or return the whole MCP response envelope to the agent.

---

## 1. Start Every Task

1. Confirm server and repository state with `repo.status`.
2. For code context, use the cheapest SDL surface that can answer the question:
   - Use `sdl.context` for task-shaped evidence. Always provide `budget.maxTokens`; add flat `focusPaths`, `focusSymbols`, or `chatMentions` when the request names exact targets.
   - Use `sdl.retrieve` for one-hop retrieval: `symbolSearch`, `symbolGetCard`, `sliceBuild`, `codeSkeleton`, `codeHotPath`, or a bounded `codeNeedWindow`.
   - Use `sdl.workflow` only when steps need result piping, transforms, runtime execution, batch operations, or mutations.
3. Prefer structured SDL retrieval for indexed source. When structured retrieval is unavailable, use a targeted, bounded `sdl.file` `op: "read"` fallback. Use `file.read` directly for non-indexed files such as docs, configs, templates, JSON, and YAML.
4. Treat focus fields as seed priorities, not output boundaries. The task profile and token budget determine expansion and evidence rungs.
5. Keep `responseMode: "auto"` for potentially large responses. When a result returns a canonical `response.get` continuation (`nextAction` or `action`) for `sdl.retrieve` with `op: "responseGet"`, replay its returned action and arguments unchanged; do not reconstruct the continuation. The outer `repoId` owns trusted dispatch, while `detail` and `includeDiagnostics` remain outer `sdl.retrieve` controls. Nested `args` contains only artifact view and paging fields; nested `repoId` is invalid. Request only the needed field or page: for JSON artifacts, prefer `jsonPath` with dot or bracket array paths, add `offset`/`limit` for large arrays, and use `raw: true` only when byte-slicing JSON text is intentional. Use workflow `responseGet` only when direct `sdl.retrieve` is unavailable or an existing multi-step workflow needs the result. A missing path reports the available top-level keys and returns a same-handle direct continuation, preferring `evidence` and then `omitted`.
6. Use focused `sdl.manual` only when composing a non-obvious request. Use `sdl.action.search` when the correct SDL action is unclear.

Never call `index.refresh`, directly, through `sdl.workflow`, or via `sdl-mcp index`, without explicit user approval in the current turn. Status flags, graph verification, parser-state/provenance warnings, and refresh recommendations are diagnostics, not approval.

Use `repo.unregister` only to permanently remove a runtime registration. Confirm with the exact same `repoId`; remove configured repositories from `SDL_CONFIG` first. Dirty live buffers require an explicit `discardDrafts: true`, which discards those drafts.

---

## 2. Retrieval Ladder

Use `sdl.context` for task-shaped understanding. It returns deterministic `evidence`, compact selected-symbol `edges`, bounded `omitted` details, and logical `nextActions`; it does not synthesize an answer. Use `sdl.retrieve` for one-hop retrieval when the task already names a symbol, API, operation, or focused code target. If you need to decide which files or symbols to edit, build a slice through `sdl.retrieve` before requesting code.

SDL-MCP selects available lexical, vector, graph, overlay, feedback, and memory
lanes automatically. The response reports the resulting retrieval level and
lane availability. Callers do not select a retrieval mode.

Use `sdl.workflow` only when steps need fields from earlier results, transforms, runtime execution, batch operations, mutations, or result piping. With `onError: "continueAll"`, failed and policy-denied gateway results continue execution but retain `status: "error"` and count as errors in the workflow summary.
Workflow continuations return the same model-projected data as their first page, while internal `$N` piping retains raw step data. When a `codeSkeleton` response is truncated, repeat the original target and all original arguments, then change only `skeletonOffset` to the returned value. `workflowContinuationGet` pages array paths in items and JSON/text values in characters; its `limit` is capped at `1000`.

Escalate through `sdl.retrieve` in this order:

1. `symbolSearch`
2. `symbolGetCard`
3. `sliceBuild` when a graph frontier or file list helps plan the edit
4. `codeSkeleton`
5. `codeHotPath`
6. `codeNeedWindow`

For `codeHotPath`, pass AST identifier names in `identifiersToFind`; use `codeSkeleton` for keywords and control-flow structure such as `return` or `throw`.

Use `codeNeedWindow` only as a last resort. Include a concrete `reason`, bounded `expectedLines`, and precise `identifiersToFind`. If SDL-MCP returns `nextBestAction`, `fallbackTools`, `fallbackRationale`, or denial guidance, follow that guidance instead of retrying broader native reads, `file.read` on indexed source, or larger raw windows.

In exclusive Code Mode, recovery guidance names a registered top-level gateway and includes the nested route, such as `sdl.retrieve` with `op: "codeSkeleton"` or `sdl.workflow` with a step `fn`. Flat action names remain unchanged only when the flat tool surface is registered.

For `codeSkeleton` file-mode retrieval, `file` is canonical. `sdl.retrieve` also accepts `args.filePath` and maps it to `file` for compatibility with other file-oriented SDL surfaces.

When workflow steps need fields from earlier `$N` references, force JSON-compatible output on the earlier step. Keep limits tight; `sdl.workflow` manages ETags automatically. Do not include retrieval evidence unless you are debugging retrieval quality.

### Focused Context

```json
{
  "repoId": "<repoId>",
  "taskType": "debug",
  "taskText": "Check why parseConfig rejects valid timeout values",
  "budget": { "maxTokens": 4000 },
  "focusPaths": ["src/config/parse.ts"],
  "includeTests": false,
  "responseMode": "auto",
  "refsMode": "auto",
  "wireFormat": "auto"
}
```

### Exploratory Context

```json
{
  "repoId": "<repoId>",
  "taskType": "explain",
  "taskText": "Trace the request dispatch path from server entrypoint to tool handler",
  "budget": { "maxTokens": 7000 },
  "includeTests": false,
  "responseMode": "auto",
  "refsMode": "auto",
  "wireFormat": "auto"
}
```

### Edit Planning Slice

Use this when you need likely files and symbols before choosing `symbol.edit` or `search.edit`:

```json
{
  "repoId": "<repoId>",
  "steps": [
    {
      "fn": "sliceBuild",
      "args": {
        "taskText": "Rename timeout option handling across the config parser",
        "wireFormat": "json",
        "cardDetail": "signature",
        "includeRetrievalEvidence": false,
        "budget": { "maxCards": 25, "maxEstimatedTokens": 3000 }
      }
    }
  ],
  "budget": { "maxTokens": 3500 },
  "onError": "stop"
}
```

### Batched Escalation

```json
{
  "repoId": "<repoId>",
  "steps": [
    {
      "fn": "symbolSearch",
      "args": { "query": "handleRequest", "limit": 10, "wireFormat": "json" }
    },
    {
      "fn": "symbolGetCard",
      "args": { "symbolIds": ["$0.results.0.symbolId"] }
    },
    {
      "fn": "codeSkeleton",
      "args": {
        "symbolId": "$0.results.0.symbolId",
        "maxLines": 120,
        "maxTokens": 900
      }
    },
    {
      "fn": "codeHotPath",
      "args": {
        "symbolId": "$0.results.0.symbolId",
        "identifiersToFind": ["validate", "result"],
        "contextLines": 2,
        "maxTokens": 900
      }
    }
  ],
  "budget": { "maxTokens": 6000 },
  "onError": "stop"
}
```

### Last-Resort Window

```json
{
  "repoId": "<repoId>",
  "steps": [
    {
      "fn": "codeNeedWindow",
      "args": {
        "symbolId": "src/auth.ts::handleAuth",
        "reason": "Need exact branch ordering for token refresh regression",
        "expectedLines": 70,
        "identifiersToFind": ["refreshToken", "catch", "expired"],
        "maxTokens": 1200,
        "responseMode": "auto"
      }
    }
  ],
  "budget": { "maxTokens": 2000 },
  "onError": "stop"
}
```

---

## Token Economy

Use the cheapest rung that answers the task. Static price tags in `sdl.manual` and `sdl.action.search` are release-time estimates, not live telemetry; use them to choose the first probe, then use `usage.stats` and `signalDensity` only when you need a savings or waste report.

- Runtime: prefer `outputMode: "digest"` for build/test/lint and other noisy commands. The digest keeps a compact parsed status and persists full output for `runtimeQueryOutput`. Do not guess `runtimeQueryOutput` arguments; replay a returned action unchanged or call focused `sdl.manual` for `runtime.queryOutput` first.
  ```json
  {
    "fn": "runtimeExecute",
    "args": {
      "runtime": "shell",
      "code": "npm test -- --runInBand",
      "outputMode": "digest",
      "persistOutput": true,
      "timeoutMs": 120000
    }
  }
  ```
- Dedupe refs: `{ "ref": { "key": "card:<repo>:<symbol>", "etag": "..." }, "unchanged": true }` means SDL already delivered the content in this session. Do not re-request it; set `refsMode: "off"` only after compaction or lost context to recover full content.
- Short IDs: packed payloads may introduce `s1`, `s2`, ... aliases with an `@ids=s1:<full-symbol-id>` line. Use `sN` anywhere a symbol ID is accepted; if an alias is unknown, re-run the producing call or use the full ID from the introducing `@ids` line.
- Action discovery: set `sdl.action.search` `maxTokens` to bound a catalog page; use its `offset` to request the next page rather than increasing the first response.
- Search misses: when `symbol.search` returns `nearMisses`, retry with one listed `name` instead of inventing broader queries.
- Evidence first: inspect `evidence`, then follow `nextActions` or use `symbol.getCard` only when the selected content is insufficient.
- Targeted files: if `file.read` returns the large-read hint, retry with `search` plus `searchContext`, `offset` plus `limit`, `jsonPath`, `maxTokens`, or `maxBytes`.

For document-heavy planning, locate the relevant README, ADR, specification, or plan and use targeted `sdl.file` `op: "read"` with `search`, bounded ranges, or `jsonPath`. If broad `sdl.context` returns irrelevant symbol evidence, switch retrieval surfaces instead of widening symbol budgets.

---

## 3. File And Edit Rules

Use SDL file and edit tools instead of native read/write paths.

- Use `sdl.context`, `sdl.retrieve`, `symbol.getCard`, `slice.build`, `codeSkeleton`, `codeHotPath`, or `codeNeedWindow` for indexed source. When structured retrieval is unavailable, use a targeted, bounded `sdl.file` `op: "read"` fallback instead of retrying the ladder.
- Read non-indexed files with `file.read` or `sdl.file` `op: "read"`. Prefer `search`, `jsonPath`, `maxTokens`, `maxBytes`, or bounded ranges over full reads; the same targeting is required for the indexed-unparseable fallback.
- Write non-indexed files with `file.write` or `sdl.file` `op: "write"` using exactly one targeted write mode.
- For one-symbol indexed-source edits, use `symbol.edit` `mode: "preview"` then `mode: "apply"`, or `sdl.file` `symbolEditPreview` followed by `symbolEditApply`. This is the default surgical edit path.
- Use `symbol.edit` `mode: "applyNow"` only with a fresh `astFingerprint` and range from a current symbol card.
- For cross-file or repeated indexed-source edits, use `search.edit` `mode: "preview"` then `mode: "apply"`, or `sdl.file` `searchEditPreview` followed by `searchEditApply`. Bound the edit with files or symbols from `sdl.context`, `sdl.retrieve`, or `slice.build` first.
- Prefer `targeting: "identifier"` for exact AST identifier replacements in supported structural languages that must avoid comments and strings, `targeting: "structural"` for tree-sitter capture edits such as calls, imports, properties, or plugin-defined grammar captures, and `operations[]` for heterogeneous batches.
- Apply a returned plan handle only after reviewing snippets, file counts, and operation summaries.
- If preview snippets are insufficient, use plan-bound `previewWindow` or `sourceWindow` with the `planHandle`, `symbolId`, `reason`, `expectedLines`, and `identifiersToFind`; do not bypass an available structured window with `file.read`. If SDL reports structured retrieval unavailable, use the targeted, bounded fallback.
- `file.write` can make a targeted single-file write, including indexed files, but treat it as fallback for indexed source when `symbol.edit` cannot anchor the change and `search.edit` would be broader than necessary.
- Use `sdl.workflow` plus `runtimeExecute` for a targeted script only when SDL edit tools cannot express the edit; pass multiline payloads through `stdin`.
- `file.write` retains a sibling `.bak` by default and returns `backupPath` when it creates that backup; remove the backup after verification if it is no longer needed. With `createBackup: false`, no backup is created and `backupPath` is absent. `symbol.edit` and `search.edit` use temporary rollback copies only and remove them after a successful apply, so they do not return a retained backup path. Do not run broad native cleanup commands.

### Non-Indexed Reads

Use this direct targeted document read when repository prose drives the task:

```json
{
  "op": "read",
  "repoId": "sdl-mcp",
  "filePath": "docs/feature-deep-dives/agent-context.md",
  "search": "## When To Use It",
  "searchContext": 8,
  "limit": 4
}
```

`searchContext` and `limit` bound the result.

Use a multi-file workflow when one task needs several non-indexed files:

```json
{
  "repoId": "<repoId>",
  "steps": [
    {
      "fn": "fileRead",
      "args": { "filePath": "package.json", "jsonPath": "scripts" }
    },
    {
      "fn": "fileRead",
      "args": {
        "filePath": "docs/guide.md",
        "search": "authentication",
        "searchContext": 3
      }
    },
    {
      "fn": "fileRead",
      "args": { "filePath": "config/app.yaml", "offset": 10, "limit": 40 }
    }
  ],
  "budget": { "maxTokens": 4000 },
  "onError": "stop"
}
```

### Non-Indexed Writes

```json
{
  "repoId": "<repoId>",
  "steps": [
    {
      "fn": "fileWrite",
      "args": {
        "filePath": "config/app.json",
        "jsonPath": "server.port",
        "jsonValue": 8080,
        "createBackup": true
      }
    }
  ],
  "budget": { "maxTokens": 2000 },
  "onError": "stop"
}
```

### One-Symbol Indexed Source Edit

Use this before line or file edits when the change belongs to one function, method, class, interface, or type:

```json
{
  "repoId": "<repoId>",
  "steps": [
    {
      "fn": "symbolEdit",
      "args": {
        "mode": "preview",
        "symbolRef": {
          "name": "parseConfig",
          "file": "src/config/parse.ts",
          "kind": "function"
        },
        "operation": {
          "kind": "replaceBody",
          "content": "return parseConfigWithDefaults(input);\n"
        },
        "createBackup": true
      }
    },
    {
      "fn": "symbolEdit",
      "args": { "mode": "apply", "planHandle": "$0.planHandle" }
    }
  ],
  "budget": { "maxTokens": 4000 },
  "onError": "stop"
}
```

### Batch Indexed Source Edit

Use this after `sdl.context` or `slice.build` identifies the affected files or symbol set:

```json
{
  "repoId": "<repoId>",
  "steps": [
    {
      "fn": "searchEdit",
      "args": {
        "mode": "preview",
        "targeting": "identifier",
        "query": {
          "literal": "oldTimeout",
          "replacement": "newTimeout",
          "global": true
        },
        "filters": { "include": ["src/config/**/*.ts"] },
        "editMode": "replacePattern",
        "previewContextLines": 2,
        "responseMode": "auto",
        "maxFiles": 20
      }
    },
    {
      "fn": "searchEdit",
      "args": { "mode": "apply", "planHandle": "$0.planHandle" }
    }
  ],
  "budget": { "maxTokens": 5000 },
  "onError": "stop"
}
```

---

## 4. Runtime Output Control

runtimeExecute executes repository tooling. Permitted uses include build, test, lint, compiler, named scripts, and targeted edit scripts. Do not use it to inspect, search, or print repository files. Use sdl.context or sdl.retrieve for indexed source and sdl.file with op="read" for other files.

Run permitted repo-local tooling through `runtimeExecute` inside `sdl.workflow`.


Default to `outputMode: "digest"` for build, test, lint, and other noisy diagnostics; use `outputMode: "minimal"` when exit status is enough. Always set `persistOutput: true` and an explicit `timeoutMs`. Use `stdin` for multiline scripts/input instead of PowerShell here-strings, quote-heavy `node -e`, or base64 decode/eval workarounds. Query stored logs only when needed with `runtimeQueryOutput` and focused `queryTerms`. Use `outputMode: "intent"` when the command intent is already tied to known terms such as `FAIL`, `Error`, or a test name; set `contextLines: 0` when exact matched lines are cleaner than surrounding context.

Persisted runtime artifacts preserve the redacted command output byte-for-byte. Default model excerpts remove only leading command-prompt echoes and recognized Node test-duration suffixes; use `view: "raw"` when the unprojected, already-redacted artifact excerpt is required.

### Execute First

```json
{
  "repoId": "<repoId>",
  "steps": [
    {
      "fn": "runtimeExecute",
      "args": {
        "runtime": "node",
        "args": ["--test", "tests/config.test.ts"],
        "outputMode": "digest",
        "persistOutput": true,
        "timeoutMs": 30000
      }
    }
  ],
  "budget": { "maxTokens": 1000 },
  "onError": "stop"
}
```

### Query Only Needed Output

```json
{
  "repoId": "<repoId>",
  "steps": [
    {
      "fn": "runtimeQueryOutput",
      "args": {
        "artifactHandle": "runtime-<repoId>-...",
        "queryTerms": ["FAIL", "Error", "AssertionError", "config.test"],
        "maxExcerpts": 8,
        "contextLines": 3,
        "stream": "both"
      }
    }
  ],
  "budget": { "maxTokens": 3000 },
  "onError": "stop"
}
```

Node `code` snippets always run as ESM (`node --input-type=module`); use `import fs from "node:fs"` or `createRequire()` — bare `require()` fails.

For shell runtime, provide `code` when a shell wrapper is the right abstraction. On Windows, `runtime: "shell"` uses `cmd.exe`; use `runtime: "powershell"` for PowerShell `.ps1` snippets. In PowerShell runtime, call npm scripts through `npm.cmd` when the `npm.ps1` shim emits `$LASTEXITCODE` noise.

---

## 5. Memory And Indexing

Assume SDL memory is disabled unless `repo.status`, config, or tool discovery shows `memory.enabled: true`. If disabled, do not repeatedly call memory tools.

When memory is enabled:

- Use `memory.query` for task-text lookup.
- Use `memory.surface` after relevant symbol IDs are known.
- At completion, store durable decisions, bugfixes, patterns, conventions, architecture notes, performance findings, or security notes with `memory.store`.
- Link `symbolIds` and `fileRelPaths` when useful.

For indexing:

- Never call `index.refresh`, directly, through `sdl.workflow`, or via `sdl-mcp index`, without explicit user approval in the current turn.
- Read `derivedState.structuralStale` and `derivedState.semanticStale` as separate readiness classes. If only `summariesDirty` or `embeddingsDirty` is set, continue with available retrieval lanes; do not refresh the index.
- These dirty flags, `graphIntegrityState: "verifying"`, `PARSER_FILE_STATE_MISSING`, parser-state warnings, parser-provenance warnings, and refresh recommendations are diagnostics, not approval.
- Do not wait for semantic freshness or graph verification unless the current task explicitly requires latest-revision graph proof.
- On a parser-provenance failure, reindex only if AST/provenance-dependent behavior is required; otherwise use an SDL file-based fallback or report the limitation.
- Subagents may report that a refresh appears necessary, but only the root agent may request approval or initiate it.
- When `rootAvailability` is missing or unreadable, restore the root or unregister the repository; refresh advice is intentionally suppressed until the root is usable.
- After the user approves a refresh, prefer incremental mode unless the repository is new and unindexed or recovery explicitly requires a stopped safe rebuild.
- Read `derivedState.graphIntegrityRevision` and `graphIntegrityVerifiedRevision` together. Equal revisions with `graphIntegrityState: "verified"` prove the current persisted graph revision.
- A `verifying` state permits graph reads but does not prove the latest revision. Continue work when pending verification is acceptable, or poll `repo.status` when the task requires latest-revision proof. Do not refresh solely because verification is running.
- A `failed` state can remain graph-readable when a current manifest exists, but it does not prove the latest revision. Do not retry refresh automatically. Follow `nextBestAction` for stopped `index --force --safe-rebuild` recovery.
- An `unknown` state, null current revision, or missing-manifest guidance blocks graph retrieval. Request approval for one incremental refresh only for a new unindexed repository; a populated graph requires a stopped safe rebuild.
- Successful saved indexed edits commit graph and manifest changes together, advance the current revision, and return before background verification completes.
- If an approved refresh runs asynchronously, poll `repo.status` and wait for completion only when the task depends on its resulting graph state.
- Do not request a full refresh for a populated active graph. SDL-MCP rejects it before provider work or graph writes.

---

## 6. Delegated Exploration

When code exploration needs a sub-agent, team agent, or delegated codebase investigation and the client supports agents, use SDL Explorer instead of a generic Explore agent.

Keep the assignment read-only unless the user explicitly requests implementation. Tell SDL Explorer to follow the SDL-MCP Agent Workflow and return symbol IDs, files, card summaries, slice handles, runtime artifact handles, and unresolved questions rather than raw source dumps.

---

## 7. Hook Enforcement

Generated enforcement is conditional on the SDL-MCP PID file.

- When the PID file is absent, native tools are allowed.
- When the PID file is present, repo-targeting native shell, file read/write/edit, apply-patch, and non-SDL MCP file/search tools are denied.
- Repo `.codex/**`, repo `.claude/**`, and non-repo agent skills, memories, and session internals remain allowed.

If a hook denies a native tool:

1. Read the hook message; it lists the SDL action to use.
2. Follow SDL response guidance such as `nextBestAction`, `fallbackTools`, and `fallbackRationale`.
3. Do not retry the blocked native tool.
4. If still stuck, call `sdl.action.search({ query: "<intent>" })`.

---

## 8. Completion Checklist

Before the final response:

1. Verify the requested work through SDL-MCP runtime or focused SDL checks when applicable.
2. Remove `.bak` files created during the task, or clearly report any kept intentionally.
3. Call `usageStats` only when the user asks for token savings, you are debugging telemetry, or you need to persist/report a usage snapshot.
4. When `usageStats` is explicitly needed, compact output returns `formattedSummary`, including through `sdl.workflow`; use `detail: "full"` only for structured `session`, `history`, or `wire` diagnostics.

---

## 9. Anti-Patterns

- Starting with native `Read`, `Grep`, shell search, or repo-wide listing instead of SDL discovery (`sdl.context`, `sdl.retrieve`, `symbolSearch`, or `slice.build`).
- Calling `codeNeedWindow` before `symbolGetCard`, `sliceBuild`, `codeSkeleton`, and `codeHotPath`.
- Using `runtimeExecute` to inspect, search, or print repository files.
- Do not use `sdl.file` `sourceWindow` to read arbitrary source. It is only for inspecting files inside an edit preview plan and requires `planHandle`. Use `codeNeedWindow` for raw indexed source.
- Running `index.refresh` without explicit current-turn user approval or defaulting to full refresh.
- Reading whole non-indexed files when `search`, `jsonPath`, or bounded ranges would answer.
- Writing indexed source through native edits instead of `symbol.edit`, symbol edit preview/apply, or AST-aware `searchEditPreview`.
- Keeping `.bak` files without reporting them.
- Calling `usageStats` by habit when no user-facing savings report or telemetry debugging is needed.

## Symbolic Refactor Ops

Prefer `search.edit` `targeting:"rename"` for graph-scoped symbol renames and `targeting:"signature"` for TypeScript/JavaScript signature edits with callsite propagation.
