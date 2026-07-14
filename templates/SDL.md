# SDL.md - SDL-MCP Agent Workflow

Use this file as the repository fallback for the `sdl-mcp-agent-workflow` skill. If that skill is loaded by the client or by a session-start hook, treat the skill as authoritative and use this file as a compact local reference.

SDL-MCP is the normal repository interface. Native filesystem and shell tools are fallback-only when SDL-MCP is unavailable, or when accessing agent memory and other internal client data outside the indexed repository.

---

## 1. Start Every Task

1. Confirm server and repository state with `repo.status`.
2. For code context, use the cheapest SDL surface that can answer the question:
   - Use `sdl.context` for explain, debug, review, implement, understand, or investigate prompts. For explain/debug, try `options.answerFirst: true` before card-heavy context.
   - Use `sdl.retrieve` for one-hop retrieval: `symbolSearch`, `symbolGetCard`, `sliceBuild`, `codeSkeleton`, `codeHotPath`, or a bounded `codeNeedWindow`.
   - Use `sdl.workflow` only when steps need result piping, transforms, runtime execution, batch operations, or mutations.
3. Never use `file.read` for indexed source. It is only for non-indexed files such as docs, configs, templates, JSON, and YAML.
4. Use `options.contextMode: "precise"` for named symbols, exact paths, narrow bugs, focused reviews, and implementation follow-up.
5. Use `options.contextMode: "broad"` for subsystem mapping, behavior tracing, unfamiliar areas, or broad investigation.
6. Keep `responseMode: "auto"` for potentially large responses. If a response handle is returned, use `response.get` only for the needed excerpt. For JSON artifacts, prefer `jsonPath` with dot or bracket array paths, add `offset`/`limit` for large arrays, and use `raw: true` only when byte-slicing JSON text is intentional.
7. Use focused `sdl.manual` only when composing a non-obvious request. Use `sdl.action.search` when the correct SDL action is unclear.

Do not run `index.refresh` by habit. Refresh only when `repo.status` shows stale or missing indexed state and the task depends on current code.

---

## 2. Retrieval Ladder

Use `sdl.context` for task-shaped understanding. For explain/debug tasks, start with `options.answerFirst: true` and expand through evidence IDs only when the answer is insufficient. Exact tool/action names are seeded from the action catalog, but use `sdl.retrieve` for one-hop retrieval when the task already names a symbol, API, operation, or focused code target. If you need to decide which files or symbols to edit, build a slice through `sdl.retrieve` before requesting code.

Use `sdl.workflow` only when steps need fields from earlier results, transforms, runtime execution, batch operations, mutations, or result piping. With `onError: "continueAll"`, failed and policy-denied gateway results continue execution but retain `status: "error"` and count as errors in the workflow summary.

Escalate through `sdl.retrieve` in this order:

1. `symbolSearch`
2. `symbolGetCard`
3. `sliceBuild` when a graph frontier or file list helps plan the edit
4. `codeSkeleton`
5. `codeHotPath`
6. `codeNeedWindow`

Use `codeNeedWindow` only as a last resort. Include a concrete `reason`, bounded `expectedLines`, and precise `identifiersToFind`. If SDL-MCP returns `nextBestAction`, `fallbackTools`, `fallbackRationale`, or denial guidance, follow that guidance instead of retrying broader native reads, `file.read` on indexed source, or larger raw windows.

For `codeSkeleton` file-mode retrieval, `file` is canonical. `sdl.retrieve` also accepts `args.filePath` and maps it to `file` for compatibility with other file-oriented SDL surfaces.

When workflow steps need fields from earlier `$N` references, force JSON-compatible output on the earlier step. Keep limits tight; `sdl.workflow` manages ETags automatically. Do not include retrieval evidence unless you are debugging retrieval quality.

### Precise Context

```json
{
  "repoId": "<repoId>",
  "taskType": "debug",
  "taskText": "Check why parseConfig rejects valid timeout values",
  "responseMode": "auto",
  "options": {
    "contextMode": "precise",
    "focusPaths": ["src/config/parse.ts"],
    "includeRetrievalEvidence": false
  },
  "budget": { "maxTokens": 4000 }
}
```

### Broad Context

```json
{
  "repoId": "<repoId>",
  "taskType": "explain",
  "taskText": "Trace the request dispatch path from server entrypoint to tool handler",
  "responseMode": "auto",
  "options": {
    "contextMode": "broad",
    "semantic": true,
    "includeRetrievalEvidence": false
  },
  "budget": { "maxTokens": 7000 }
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
        "identifiersToFind": ["validate", "throw"],
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

- Runtime: prefer `outputMode: "digest"` for build/test/lint and other noisy commands. The digest keeps a compact parsed status and persists full output for `runtimeQueryOutput`.
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
- Search misses: when `symbol.search` returns `nearMisses`, retry with one listed `name` instead of inventing broader queries.
- Answer first: for explain/debug, call `sdl.context` with `options.answerFirst: true`; expand with `symbol.getCard` or a normal context call on the returned evidence IDs only if needed.
- Targeted files: if `file.read` returns the large-read hint, retry with `search` plus `searchContext`, `offset` plus `limit`, `jsonPath`, `maxTokens`, or `maxBytes`.

For document-heavy planning, locate the relevant README, ADR, specification, or plan and use targeted `sdl.file` `op: "read"` with `search`, bounded ranges, or `jsonPath`. If broad `sdl.context` returns irrelevant symbol evidence, switch retrieval surfaces instead of widening symbol budgets.

---

## 3. File And Edit Rules

Use SDL file and edit tools instead of native read/write paths.

- Never use `file.read` for indexed source. It will be denied and wastes a turn. Use `sdl.context`, `sdl.retrieve`, `symbol.getCard`, `slice.build`, `codeSkeleton`, `codeHotPath`, or `codeNeedWindow` instead.
- Read non-indexed files with `file.read` or `sdl.file` `op: "read"`. Prefer `search`, `jsonPath`, or bounded ranges over full reads; if SDL returns a large-read hint, retry with a targeted read.
- Write non-indexed files with `file.write` or `sdl.file` `op: "write"` using exactly one targeted write mode.
- For one-symbol indexed-source edits, use `symbol.edit` `mode: "preview"` then `mode: "apply"`, or `sdl.file` `symbolEditPreview` followed by `symbolEditApply`. This is the default surgical edit path.
- Use `symbol.edit` `mode: "applyNow"` only with a fresh `astFingerprint` and range from a current symbol card.
- For cross-file or repeated indexed-source edits, use `search.edit` `mode: "preview"` then `mode: "apply"`, or `sdl.file` `searchEditPreview` followed by `searchEditApply`. Bound the edit with files or symbols from `sdl.context`, `sdl.retrieve`, or `slice.build` first.
- Prefer `targeting: "identifier"` for exact AST identifier replacements in supported structural languages that must avoid comments and strings, `targeting: "structural"` for tree-sitter capture edits such as calls, imports, properties, or plugin-defined grammar captures, and `operations[]` for heterogeneous batches.
- Apply a returned plan handle only after reviewing snippets, file counts, and operation summaries.
- If preview snippets are insufficient, use plan-bound `previewWindow` or `sourceWindow` with the `planHandle`, `symbolId`, `reason`, `expectedLines`, and `identifiersToFind`; do not fall back to `file.read`.
- `file.write` can make a targeted single-file write, including indexed files, but treat it as fallback for indexed source when `symbol.edit` cannot anchor the change and `search.edit` would be broader than necessary.
- Use `sdl.workflow` plus `runtimeExecute` for a targeted script only when SDL edit tools cannot express the edit; pass multiline payloads through `stdin`.
- Track backup paths returned by edit/write tools and remove created `.bak` files after verification through SDL-governed runtime cleanup. Do not run broad native cleanup commands.

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

Run repo-local commands through `runtimeExecute` inside `sdl.workflow`.


Default to `outputMode: "digest"` for build, test, lint, and other noisy diagnostics; use `outputMode: "minimal"` when exit status is enough. Always set `persistOutput: true` and an explicit `timeoutMs`. Use `stdin` for multiline scripts/input instead of PowerShell here-strings, quote-heavy `node -e`, or base64 decode/eval workarounds. Query stored logs only when needed with `runtimeQueryOutput` and focused `queryTerms`. Use `outputMode: "intent"` when the command intent is already tied to known terms such as `FAIL`, `Error`, or a test name; set `contextLines: 0` when exact matched lines are cleaner than surrounding context.

Do not use runtime execution to print indexed source. Use the retrieval ladder instead.

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

- Do not refresh by habit.
- Run `index.refresh` only when `repo.status` shows stale or missing indexed state and the task depends on current code.
- Prefer incremental refresh.
- If refresh runs asynchronously, poll `repo.status` and wait for completion before continuing graph-backed retrieval.
- Avoid full refresh unless the repo is newly registered, unindexed, or explicitly required.

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
- Using `runtimeExecute` to print indexed source.
- Do not use `sdl.file` `sourceWindow` to read arbitrary source. It is only for inspecting files inside an edit preview plan and requires `planHandle`. Use `codeNeedWindow` for raw indexed source.
- Running `index.refresh` every session or defaulting to full refresh.
- Reading whole non-indexed files when `search`, `jsonPath`, or bounded ranges would answer.
- Writing indexed source through native edits instead of `symbol.edit`, symbol edit preview/apply, or AST-aware `searchEditPreview`.
- Keeping `.bak` files without reporting them.
- Calling `usageStats` by habit when no user-facing savings report or telemetry debugging is needed.

## Symbolic Refactor Ops

Prefer `search.edit` `targeting:"rename"` for graph-scoped symbol renames and `targeting:"signature"` for TypeScript/JavaScript signature edits with callsite propagation.
