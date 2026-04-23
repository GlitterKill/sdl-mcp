# SDL.md — SDL-MCP Optimized Agent Workflow

Token-lean playbook for agents consuming an SDL-MCP server. Replace native `Read`/`Write` with `sdl.file`. Route indexed source through the context ladder. Escalate only when the current rung can't answer.

Applies to any SDL-MCP consumer. Replace `<repoId>` with the target repository ID (see `sdl.repo.status` output or local config).

> Verified against **SDL-MCP v0.10.7** live manual: 42 actions — 4 meta + 32 gateway + 6 workflow-only transforms.

---

## 1. Session Bootstrap (once)

```
1. sdl.repo.status({ repoId })             # health + version; cache result
2. sdl.policy.get({ repoId })              # honor maxWindowLines / maxWindowTokens / requireIdentifiers
3. sdl.index.refresh({ mode: "incremental" }) # only if repo.status reports stale
```

Skip step 3 unless `repo.status` says indexing is stale. Never run `mode: "full"` unless you registered the repo this session or policy demands it.

---

## 2. Action Inventory

### Meta (always available; prefer these as entry points)

| Action              | Use when                                                                    |
| ------------------- | --------------------------------------------------------------------------- |
| `sdl.action.search` | Unsure which action fits — pass a keyword, read ranked candidates           |
| `sdl.manual`        | Need exact schema / example for a known action; `actions: [...]` or `query` |
| `sdl.context`       | Explain / debug / review / implement — task-shaped context                  |
| `sdl.workflow`      | 2+ steps with `$N` piping, runtime, or batch mutations                      |

### Internal transforms (valid only inside `sdl.workflow` steps)

`dataPick`, `dataMap`, `dataFilter`, `dataSort`, `dataTemplate`, `workflowContinuationGet`

For full schemas: `sdl.manual({ actions: ["<name>"], includeExamples: true })`.

---

## 3. Decision Ladder — Pick By Intent

| Task intent                          | First call                                                                 | Stop here if                                  |
| ------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------- |
| Explain / debug / review / implement | `sdl.context` (`precise` default, `broad` for wide exploration)            | Autopilot returns cards/skeletons that answer |
| Find a named symbol                  | `sdl.symbol.search` (`limit: 5-20`, `kinds: [...]`)                        | Single clear match                            |
| Inspect one symbol                   | `sdl.symbol.getCard` (`symbolRef` if no ID)                                | Card answers question                         |
| Dependency subgraph                  | `sdl.slice.build` (budget + `minConfidence`)                               | Cards cover the task                          |
| Re-use prior slice                   | `sdl.slice.refresh` (`sliceHandle`)                                        | Delta returned, no rebuild                    |
| Fetch overflow from slice            | `sdl.slice.spillover.get`                                                  | —                                             |
| See code structure                   | `sdl.code.getSkeleton` (`symbolId` or `file`)                              | Signatures / control flow enough              |
| Find logic inside a symbol           | `sdl.code.getHotPath` (`symbolId` + `identifiersToFind`)                   | Hot-path shows the lines                      |
| Raw lines (last resort)              | `sdl.code.needWindow` (`reason`, `expectedLines≤180`, `identifiersToFind`) | —                                             |
| Read non-source file                 | `sdl.file` `op:"read"` with `offset/limit` OR `search` OR `jsonPath`       | —                                             |
| Write any file                       | `sdl.file` `op:"write"` (targeted mode)                                    | Auto-syncs DB for indexed                     |
| Cross-file edit                      | `sdl.file` `op:"searchEditPreview"` → `op:"searchEditApply"`               | —                                             |
| Run command                          | `sdl.runtime.execute` (`outputMode:"minimal"`, `timeoutMs`)                | Result fits minimal response                  |
| Probe large output                   | `sdl.runtime.queryOutput` (`artifactHandle` + `queryTerms`)                | —                                             |
| Version diff                         | `sdl.delta.get`                                                            | —                                             |
| PR risk                              | `sdl.pr.risk.analyze` (`fromVersion` + `toVersion`)                        | —                                             |
| Multi-step dependent calls           | `sdl.workflow` with `$N` refs                                              | —                                             |
| Discover action                      | `sdl.action.search` (`limit: 5`, `summaryOnly` for triage)                 | —                                             |

**Never skip down the ladder.** `needWindow` denials cite the missing prerequisite.

---

## 4. Context Retrieval (the 90% path)

```json
sdl.context({
  "repoId": "<repoId>",
  "taskType": "explain" | "debug" | "review" | "implement",
  "taskText": "<one-sentence intent>",
  "options": {
    "contextMode": "precise",
    "focusPaths": ["src/auth/*.ts"],
    "focusSymbols": ["<symbolId>"],
    "semantic": true,
    "includeRetrievalEvidence": false
  },
  "budget": { "maxTokens": 4000, "maxCards": 20 }
})
```

Rung cost: card ≈50 · skeleton ≈200 · hotPath ≈500 · raw ≈2000 tokens. Planner trims rungs from the end if `budget.maxTokens` is tight.

**When `sdl.context` returns too little**, escalate manually:

```json
// 1. Narrow to a symbol
sdl.symbol.search({ "repoId": "<repoId>", "query": "handleRequest", "kinds": ["function"], "limit": 10 })

// 2. Get the card (ETag-aware)
sdl.symbol.getCard({ "repoId": "<repoId>", "symbolRef": { "name": "handleRequest", "file": "src/server.ts" }, "ifNoneMatch": "<prevEtag>" })

// 3. Build a bounded slice
sdl.slice.build({
  "repoId": "<repoId>",
  "entrySymbols": ["<symbolId>"],
  "taskText": "trace auth failure",
  "budget": { "maxCards": 30, "maxEstimatedTokens": 4000 },
  "minConfidence": 0.5,
  "wireFormat": "compact",
  "cardDetail": "signature",
  "knownCardEtags": { "<symId>": "<etag>" }
})

// 4. If still need code
sdl.code.getSkeleton({ "repoId": "<repoId>", "symbolId": "<id>", "maxLines": 120, "maxTokens": 900 })
sdl.code.getHotPath({ "repoId": "<repoId>", "symbolId": "<id>", "identifiersToFind": ["validate","throw"], "contextLines": 2 })

// 5. Last resort — must cite reason + identifiers
sdl.code.needWindow({ "repoId": "<repoId>", "symbolId": "<id>", "reason": "confirm branch ordering", "expectedLines": 60, "identifiersToFind": ["validate"] })
```

Reuse the returned `sliceHandle` with `sdl.slice.refresh` instead of rebuilding.

---

## 5. File I/O — `sdl.file` Replaces Native Read/Write

`sdl.file` is the unified gateway. It is smarter and cheaper than native `Read`/`Write`:

- `read` supports `offset/limit`, `search`+`searchContext`, `jsonPath`, `maxBytes` — never pulls the whole file unless asked.
- `write` modes avoid rewriting entire files.
- **Indexed sources auto-sync to the graph DB** via `syncLiveIndex` → `patchSavedFile` inside `file-write-internals.ts`. No follow-up `buffer.push` or `index.refresh` needed after a saved write to `.ts/.js/.py/.go/.rs/...` files. The symbol graph is consistent when `file.write` returns.
- `searchEditPreview` / `searchEditApply` add sha256 + mtime preconditions and rollback on mid-batch failure — safer than N separate writes.

### Read modes

```json
// Line range
sdl.file({ "op":"read", "repoId":"<repoId>", "filePath":"config/app.yaml", "offset":10, "limit":20 })

// Keyword slice
sdl.file({ "op":"read", "repoId":"<repoId>", "filePath":"docs/guide.md", "search":"authentication", "searchContext":3 })

// JSON pointer
sdl.file({ "op":"read", "repoId":"<repoId>", "filePath":"package.json", "jsonPath":"dependencies" })
```

Prefer `search` or `jsonPath` over raw `offset/limit` when you don't know where the match lives.

### Write modes (mutually exclusive — pick one)

| Mode            | Field(s)                                            | Use when                           |
| --------------- | --------------------------------------------------- | ---------------------------------- |
| Full replace    | `content`                                           | File is small or new               |
| Line replace    | `replaceLines: { start, end, content }`             | You know the line range            |
| Pattern replace | `replacePattern: { pattern, replacement, global? }` | Regex fits                         |
| JSON mutate     | `jsonPath`, `jsonValue`                             | JSON/YAML/TOML value swap          |
| Insert          | `insertAt: { line, content }`                       | Add without shifting unknown lines |
| Append          | `append`                                            | Tack onto end                      |

`createBackup: true` (default) writes `.bak` and rolls back on failure. Set `createIfMissing: true` for new-file writes.

### Cross-file edits (two-phase)

```json
// Phase 1 — preview, no filesystem mutation
sdl.file({
  "op": "searchEditPreview",
  "repoId": "<repoId>",
  "targeting": "text",                         // or "symbol"
  "query": { "literal": "oldName", "replacement": "newName", "global": true },
  "editMode": "replacePattern",
  "previewContextLines": 2,
  "maxFiles": 50
})
// → planHandle + per-file diffs

// Phase 2 — commit with preconditions + rollback
sdl.file({ "op": "searchEditApply", "repoId": "<repoId>", "planHandle": "<handle>" })
```

Server holds the plan; stale mtimes/hashes abort the apply cleanly.

---

## 6. Runtime Execution

```json
sdl.runtime.execute({
  "repoId": "<repoId>",
  "runtime": "node",              // node|typescript|python|shell|ruby|php|perl|r|elixir|go|java|kotlin|rust|c|cpp|csharp
  "args": ["-e", "console.log('hi')"], // OR
  "code": "console.log('hi')",    // inline → temp file
  "outputMode": "minimal",        // ~50 tokens; summary|intent for more
  "timeoutMs": 30000,             // ALWAYS set
  "persistOutput": true
})
// → artifactHandle, exitCode, minimal tail
```

If you need detail after `minimal`:

```json
sdl.runtime.queryOutput({
  "artifactHandle": "<handle>",
  "queryTerms": ["error","failed"],
  "maxExcerpts": 10,
  "contextLines": 3,
  "stream": "both"
})
```

Never use `runtime.execute` as a workaround to read indexed source. Hooks may block it.

---

## 7. Multi-Step via `sdl.workflow`

Use when 2+ steps share data. `$N` references prior step output. Transforms (`dataPick`, `dataMap`, `dataFilter`, `dataSort`, `dataTemplate`) exist only inside workflow steps.

```json
sdl.workflow({
  "repoId": "<repoId>",
  "steps": [
    { "fn": "symbolSearch", "args": { "query": "parseConfig", "kinds":["function"], "limit": 5 } },
    { "fn": "dataPick",     "args": { "from": "$0.results", "path": "symbolId", "limit": 3 } },
    { "fn": "symbolGetCard","args": { "symbolIds": "$1" } },
    { "fn": "codeSkeleton", "args": { "symbolId": "$0.results[0].symbolId", "maxLines": 80 } }
  ],
  "budget": { "maxTokens": 6000 },
  "onError": "stop"
})
```

For context retrieval, prefer `sdl.context` — the planner picks rungs for you. Reserve `sdl.workflow` for runtime, batch mutations, and pipelines.

---

## 8. Token-Budget Patterns

1. **Ladder, don't leap.** Card (≈50) → skeleton (≈200) → hotPath (≈500) → window (≈2000).
2. **Bound everything.** `limit: 5-20` on search; `maxCards`/`maxEstimatedTokens` on slices; `maxLines`/`maxTokens` on code.
3. **Pass ETags.** `ifNoneMatch` on `getCard`/`getSkeleton`; `knownCardEtags` / `knownVersion` on slice calls — server returns `notModified` instead of bytes.
4. **Compact wire.** Leave `wireFormat: "compact"` and `wireFormatVersion: 2+` defaults. Only use `cardDetail: "full"` when necessary.
5. **Tighten confidence.** Default `minConfidence: 0.5`. Raise to `0.8`/`0.95` when payload is heavy or precision matters.
6. **Targeted reads.** `file.read` with `search`/`jsonPath` instead of full files.
7. **Persist-then-probe runtimes.** `outputMode: "minimal"` first, `runtime.queryOutput` for detail.
8. **Refresh, don't rebuild.** `slice.refresh` + `slice.spillover.get` reuse server state.
9. **Stats before full.** `repo.overview({ level: "stats" })` before `"directories"` or `"full"`.
10. **Check `usage.stats`.** Confirms savings and flags hot tools.

---

## 9. Task-Specific Recipes

| Task         | Sequence                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| Bug hunt     | `context(taskType:"debug", stackTrace)` → `slice.build` → `code.getHotPath` → `needWindow` only if still ambiguous    |
| Add feature  | `repo.overview(stats)` → `symbol.search` → `getCard` → `slice.build(taskText)` → edit via `file.write` / `searchEdit` |
| PR review    | `delta.get` → `pr.risk.analyze(riskThreshold:80)` → `getCard` / `getHotPath` on high-risk symbols                     |
| Rename       | `searchEditPreview` (targeting:`symbol`) → review plan → `searchEditApply`                                            |
| Config tweak | `file.read(jsonPath)` → `file.write(jsonPath, jsonValue)`                                                             |
| Run tests    | `runtime.execute(shell, timeoutMs)` → `runtime.queryOutput(["fail","error"])`                                         |

---

## 10. Anti-Patterns

- Native `Read` / `Write` on any repo file → use `sdl.file`.
- `code.needWindow` before `getSkeleton` / `getHotPath` — will be denied.
- `symbol.search` with no `limit` (defaults to 50, max 1000) — wastes tokens.
- `repo.overview({ level: "full" })` when `"stats"` answers.
- Rebuilding slices instead of `slice.refresh`.
- Running `index.refresh({ mode: "full" })` every session.
- Reading entire config files instead of `jsonPath` / `search`.
- Using `runtime.execute` to `cat` or `grep` indexed source — hooks block it and native tools have a cheaper equivalent anyway.
- Parallel full-file reads when one `sdl.context` call returns the same evidence.

---

## 11. When Hooks Block

If a native tool is denied by a hook:

1. Read the hook message — it lists the SDL action to use.
2. Follow `nextBestAction` / `fallbackTools` / `fallbackRationale` on the SDL response.
3. Don't retry the blocked native tool.
4. If still stuck, `sdl.action.search({ query: "<intent>" })` for candidates.

---

## 12. Deep Reference

```json
sdl.manual({ actions: ["slice.build","code.needWindow"], includeExamples: true })
sdl.action.search({ query: "risk analyze", includeSchemas: true, limit: 5 })
```

`sdl.manual` with no args returns the full API (~60 KB — use focused queries in a live session).

---

## 13. Feedback loop (`sdl.agent.feedback`)

After completing a task, call `sdl.agent.feedback` with:
- `versionId` (from `sdl.repo.status`), `sliceHandle` (from `sdl.slice.build`).
- `usefulSymbols` (required, min 1), `missingSymbols` (optional).
- `taskType` (`"debug"` | `"review"` | `"implement"` | `"explain"`), `taskText`, `taskTags`.

This trains the slice ranker and improves future context quality.

Use `sdl.agent.feedback.query` with `limit` and `since` (ISO timestamp) to review aggregated stats on which symbols are most frequently useful/missing.

---

## Appendix — Live-Index Sync Semantics

`sdl.file` `op:"write"` on an indexed extension (`.ts .tsx .js .jsx .mjs .cjs .py .pyw .go .java .cs .c .h .cpp .hpp .cc .cxx .hxx .php .phtml .rs .kt .kts .sh .bash .zsh`) triggers `syncLiveIndex(repoId, relPath, newContent)` which calls `patchSavedFile` against the live-index overlay. On return:

- Symbol graph reflects the new content.
- File-level card ETags bump.
- Slices referencing touched files can refresh via `sdl.slice.refresh`.

For **unsaved** IDE draft state (not yet written to disk), push with `sdl.buffer.push({ eventType: "change"|"save" })` and finalize with `sdl.buffer.checkpoint`. Saved-file writes go through `sdl.file` directly — no buffer calls required.
