# `sdl.search.edit` — Cross-File Search and Edit

`sdl.search.edit` is a two-phase tool that replaces the hand-composed
`symbol.search` → `file.read` → `file.write` pattern with a single,
atomic cross-file mutation primitive.

The tool runs in two modes:

- **`preview`** - returns a summary of every file it would touch, the proposed edits, and the precondition snapshot (sha256 + mtime per file). When edits exist, it also returns a `planHandle` for apply. Nothing is written.
- **`apply`** — re-checks preconditions against current disk state,
  then writes the files sequentially in deterministic order. A
  mid-batch failure triggers rollback from backups.

Plan handles are stored in-process with a 15-minute TTL and an LRU
cap of 16 handles. They do not survive server restart. Apply fails
closed on missing, expired, or repo-mismatched handles, and on any
file whose sha256/mtime has drifted since the preview was taken.

## When to use `search.edit` vs `file.write`

MCP responses are human-first. Preview and apply results show concise visible summaries with bounded diff snippets, while `structuredContent` carries task data such as file entries, status, `etag`, error details, and a `planHandle` only when a preview has edits to apply. Internal precondition snapshots, rollback bookkeeping, timings, and packed/debug stats stay out of normal visible/model-facing output unless diagnostics are explicitly requested.

| Tool              | Use when                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `sdl.file.write`  | Single file, single mode (replaceLines, replacePattern, jsonPath, insertAt, append, overwrite). Immediate apply. |
| `sdl.symbol.edit` | One symbol-scoped edit with AST/range/file preconditions and parse-after validation. Not a batch primitive.      |
| `sdl.search.edit` | Many files, one consistent edit shape, or a multi-replacement `operations[]` batch with one shared plan/apply.   |
| `sdl.context`     | Reading-only context retrieval for explain/debug/review/implement.                                               |
| `sdl.workflow`    | Multi-step pipelines that aren't search+edit (runtime execution, data transforms, orchestration).                |

See [`sdl.symbol.edit`](./symbol-edit-tool.md) when the edit target is a single symbol rather than a search result set.

## Request shape — `mode: "preview"`

```json
{
  "repoId": "<repoId>",
  "mode": "preview",
  "targeting": "text",
  "query": {
    "literal": "oldName",
    "replacement": "newName",
    "global": true
  },
  "editMode": "replacePattern",
  "filters": {
    "include": ["src/**/*.ts"],
    "exclude": ["src/**/*.test.ts"],
    "extensions": [".ts"]
  },
  "previewContextLines": 2,
  "maxFiles": 50,
  "maxMatchesPerFile": 100,
  "maxTotalMatches": 500,
  "createBackup": true,
  "responseMode": "inline"
}
```

For multiple replacement operations, send `operations[]` instead of top-level
`targeting`, `query`, and `editMode`. SDL-MCP previews each operation, rejects
overlapping ranges in the same file, and merges all non-overlapping edits for a
file into one planned write:

```json
{
  "repoId": "<repoId>",
  "mode": "preview",
  "operations": [
    {
      "id": "rename-import",
      "targeting": "text",
      "query": {
        "literal": "oldName",
        "replacement": "newName",
        "global": true
      },
      "editMode": "replacePattern",
      "filters": { "include": ["src/**/*.ts"] }
    },
    {
      "id": "update-comment",
      "targeting": "text",
      "query": {
        "literal": "Old label",
        "replacement": "New label",
        "global": true
      },
      "editMode": "replacePattern",
      "filters": { "include": ["src/**/*.ts"] }
    }
  ],
  "previewContextLines": 2,
  "responseMode": "inline"
}
```

Each operation may set its own `filters`, `maxFiles`,
`maxMatchesPerFile`, and `maxTotalMatches`. The top-level limits still cap the
merged preview and apply plan.

### `targeting`

- `"text"` — enumerate repo files (respecting `filters`) and regex-match
  the `query.literal` / `query.regex` pattern. Binaries, notebooks,
  archives, and files inside `node_modules`, `dist`, `.git`, etc. are
  excluded automatically.
- `"symbol"` — resolve `query.symbolRef` (via `resolveSymbolRef`) or
  `query.symbolIds` to get the home file of each symbol. Only indexed
  source files are eligible.
- `"identifier"` — parse supported structural languages with tree-sitter and
  replace only exact AST identifier nodes whose text equals `query.literal`.
  This skips strings, comments, and other non-identifier text while still
  flowing through the normal preview/apply/rollback plan. Built-in support
  covers TypeScript/JavaScript, Python, Go, Java, C#, C/C++, PHP, Rust,
  Kotlin, shell files, and the lazy language packs for PowerShell, Ruby, Lua,
  Dart, Swift, Groovy, Perl, R, Elixir, F#, Fortran, and Haskell. Lazy packs
  reuse the same parser package registered for indexing; if that parser is not
  installed or cannot be loaded, AST-aware matching fails closed instead of
  falling back to regex text replacement. Plugins can opt in with a structural
  matcher descriptor.
- `"structural"` — run a bounded tree-sitter query over supported structural
  languages, select one capture (default: `@target`), and replace that
  captured range. `query.structural.requiredCaptures` can require exact
  capture text such as `{ "callee": "oldName" }`, and the replacement string
  may interpolate captures with `$name` or `${name}`. `requiredCaptures` is
  capped at 32 safe capture keys. Structural preview also uses an aggregate
  query time budget, checks that budget before parsing each candidate, and
  reports `structural-query-time-budget` when broad queries exhaust it before
  scanning every candidate. Use
  `query.structural.language` when a request spans more than one structural
  language, or split the request into `operations[]` with one language per
  operation.

Structural queries must compile for each candidate file's actual grammar
variant. For example, a JSX/TSX-only query should target `.tsx`/`.jsx`
candidates; including `.ts` files in the same operation fails validation
instead of silently treating those files as no-match candidates.

Both AST-aware target modes currently require `editMode: "replacePattern"`.
They do not use regular expressions for matching; the edit mode name is kept
so previews and applies can reuse the existing search-edit write machinery.
Unsupported file extensions are skipped before parsing. Lazy language-pack
extensions are eligible as soon as the pack's tree-sitter grammar is available
through the shared grammar loader.

AST-aware previews include a bounded `astMatches` sample in each affected
`fileEntries[]` item. Each sample carries the selected target capture plus
named captures with byte offsets and 1-based line ranges. Capture text is
truncated, and only the first few matches/captures are included to preserve
the normal token budget.

Identifier-aware rename example:

```json
{
  "repoId": "<repoId>",
  "mode": "preview",
  "targeting": "identifier",
  "query": {
    "literal": "oldName",
    "replacement": "newName",
    "global": true
  },
  "editMode": "replacePattern",
  "filters": { "include": ["src/**/*.{ts,tsx,js,jsx}"] },
  "responseMode": "auto"
}
```

Structural call-target example:

```json
{
  "repoId": "<repoId>",
  "mode": "preview",
  "targeting": "structural",
  "query": {
    "structural": {
      "treeSitterQuery": "(call_expression function: (identifier) @callee arguments: (arguments) @args) @target",
      "requiredCaptures": { "callee": "oldName" }
    },
    "replacement": "newName$args",
    "global": true
  },
  "editMode": "replacePattern",
  "filters": { "include": ["src/**/*.{ts,tsx,js,jsx}"] },
  "responseMode": "auto"
}
```

### `editMode`

Mirrors `file.write` modes, minus `jsonPath` (intentionally excluded
from v1):

- `replacePattern` — requires `query.literal`/`query.regex` and
  `query.replacement`
- `overwrite` — requires `query.content`
- `replaceLines` — requires `query.replaceLines`
- `insertAt` — requires `query.insertAt`
- `append` — requires `query.append`

## Preview response

Preview supports `responseMode: "inline" | "auto" | "handle"`. The default is
`"inline"`. Use `"auto"` for large previews or `"handle"` when you always want the
full preview stored behind `response.get`; this is useful when many `fileEntries` or
snippets would otherwise dominate the model context. When `requiresApply` is true,
apply uses the returned `planHandle`; `response.get({ handle, full: true })`
retrieves the original preview payload.

```json
{
  "mode": "preview",
  "planHandle": "se-mf0abc-<random>",
  "filesMatched": 3,
  "matchesFound": 7,
  "filesEligible": 42,
  "filesSkipped": [{ "path": "src/foo.ts", "reason": "no-change" }],
  "fileEntries": [
    {
      "file": "src/auth/token.ts",
      "matchCount": 2,
      "editMode": "replacePattern",
      "operationIds": ["rename-import", "update-comment"],
      "operations": [
        {
          "id": "rename-import",
          "matchCount": 1,
          "editMode": "replacePattern"
        },
        {
          "id": "update-comment",
          "matchCount": 1,
          "editMode": "replacePattern"
        }
      ],
      "snippets": {
        "before": " 41 | const oldName = ...\n>42 | oldName();",
        "after": " 41 | const newName = ...\n>42 | newName();",
        "beforeStartLine": 41,
        "beforeEndLine": 42,
        "afterStartLine": 41,
        "afterEndLine": 42
      },
      "indexedSource": true
    }
  ],
  "requiresApply": true,
  "expiresAt": "2026-04-20T03:30:00.000Z",
  "preconditionSnapshot": [
    { "file": "src/auth/token.ts", "sha256": "<hex>", "mtimeMs": 1776643997401 }
  ],
  "retrievalEvidence": {
    "sources": ["fts", "vector"],
    "topRanksPerSource": { "fts": [1, 3], "vector": [2] },
    "candidateCountPerSource": { "fts": 5, "vector": 3 },
    "fusionLatencyMs": 12
  }
}
```

When no edits are planned, preview returns `requiresApply: false` and omits
`planHandle` and `expiresAt`; there is nothing to apply.


Preview snippets are hunk snippets, not raw file reads. Each snippet is anchored to the first matched or changed line and includes 1-based line numbers; the changed anchor is prefixed with `>`. For indexed source files, callers that need more surrounding code should request a gated window tied to the returned plan handle:

```json
{
  "op": "previewWindow",
  "repoId": "<repoId>",
  "planHandle": "se-mf0abc-<random>",
  "filePath": "src/auth/token.ts",
  "symbolId": "<symbolId-from-symbol.search>",
  "reason": "Inspect the planned edit before applying it",
  "expectedLines": 40,
  "identifiersToFind": ["oldName"],
  "granularity": "fileWindow",
  "responseMode": "inline"
}
```

`previewWindow` and `sourceWindow` are aliases on `sdl.file`. Both validate that the plan handle contains the requested indexed file, validate that the symbol belongs to that file, then delegate source access to the normal `code.needWindow` policy. This keeps indexed source reads gated while preserving the edit preview provenance.

### `retrievalEvidence`

When `targeting: "text"` and the query literal is non-empty,
the planner runs hybrid FTS+vector retrieval to narrow candidate files
before the full enumeration fallback. The `retrievalEvidence` field
(optional, omitted for `targeting: "symbol"`) exposes the retrieval
metadata so callers can reason about narrowing quality:

| Field                     | Type                       | Description                                                    |
| ------------------------- | -------------------------- | -------------------------------------------------------------- |
| `sources`                 | `string[]`                 | Retrieval backends that contributed candidates (`"fts"`, etc.) |
| `topRanksPerSource`       | `Record<string, number[]>` | Top rank positions per source in the fused result set          |
| `candidateCountPerSource` | `Record<string, number>`   | Raw candidate count per source before fusion                   |
| `fusionLatencyMs`         | `number` (optional)        | Wall-clock ms for the fusion pipeline                          |
| `fallbackReason`          | `string` (optional)        | Why narrowing degraded (e.g. no FTS index, no vector model)    |

## Request shape — `mode: "apply"`

```json
{
  "repoId": "<repoId>",
  "mode": "apply",
  "planHandle": "se-mf0abc-<random>"
}
```

`createBackup` on apply must match the value used during preview (or be
omitted). To change the backup setting, re-run preview with the desired value.

## Apply response

```json
{
  "mode": "apply",
  "planHandle": "se-mf0abc-<random>",
  "filesAttempted": 3,
  "filesWritten": 3,
  "filesSkipped": 0,
  "filesFailed": 0,
  "results": [
    {
      "file": "src/auth/token.ts",
      "status": "written",
      "bytes": 4128,
      "indexUpdate": {
        "applied": true,
        "symbolsMatched": 12,
        "symbolsAdded": 0,
        "symbolsRemoved": 0,
        "edgesUpserted": 45
      }
    }
  ],
  "rollback": { "triggered": false, "restoredFiles": [] }
}
```

## Precondition failures

Apply re-hashes every target file before the first write. If any
sha256 differs from the preview snapshot, apply throws a
`ValidationError` listing the drifted files, writes nothing, and the
handle remains usable only after producing a fresh preview.

## Rollback semantics

- Sequential writes — serialized to respect the LadybugDB write pool
  (`writePoolSize = 1`) and the native-addon per-connection mutex.
- On write failure mid-batch: previously-written files are restored
  from their backups (where created), `rollback.triggered = true`,
  and the failing file is reported with `status: "failed"`.
- Live-index sync failures do **not** trigger rollback. They are
  surfaced as `indexUpdate.applied = false` with an error message,
  matching current `file.write` behavior. The configured file watcher
  provider plus periodic `index.refresh` eventually reconcile.
- Backups are cleaned up after a fully successful batch.

## Limits and deny-list

- Max single-file size: 512 KB (same as `file.write`).
- Denied extensions: `.ipynb`, archives, binaries, images, audio, video, `.pdf`, `.wasm`, `.so`, `.dll`, `.dylib`, `.class`, `.jar`, `.exe`.
- Walker skips `.git`, `node_modules`, `dist`, `build`, `out`, `.next`,
  `.turbo`, `.cache`, `coverage`, `.nyc_output`.
- Batch previews enforce the aggregate plan byte cap per final target file, so
  multiple operations against the same file do not double-count the same output
  buffer. Stored plans keep skipped-file details compact with totals and
  per-reason counts.

## Examples

### Rename an identifier across `src/`

```json
{
  "mode": "preview",
  "repoId": "myrepo",
  "targeting": "identifier",
  "query": { "literal": "legacyAuth", "replacement": "authV2", "global": true },
  "editMode": "replacePattern",
  "filters": { "include": ["src/**/*.ts"] }
}
```

If `requiresApply` is true, apply with the returned `planHandle`.

### Rewrite a symbol's home file

```json
{
  "mode": "preview",
  "repoId": "myrepo",
  "targeting": "symbol",
  "query": {
    "symbolRef": { "name": "handleAuth", "file": "src/server.ts" },
    "literal": "handleAuth",
    "replacement": "handleAuthV2",
    "global": true
  },
  "editMode": "replacePattern"
}
```

### Append a header to every config file

```json
{
  "mode": "preview",
  "repoId": "myrepo",
  "targeting": "text",
  "query": { "regex": "^#", "append": "\n# audited 2026-04-20" },
  "editMode": "append",
  "filters": { "extensions": [".yaml", ".yml"] }
}
```

## Error reference

| Error                                                           | Meaning                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `planHandle missing or expired`                                 | Apply called with an unknown or TTL-expired handle. Produce a fresh preview. |
| `planHandle was created for repoId ...`                         | Repo mismatch between preview and apply.                                     |
| `search.edit apply aborted: N file(s) drifted`                  | sha256 changed between preview and apply for one or more target files.       |
| `Pattern contains nested quantifiers ...`                       | ReDoS guard rejected the regex.                                              |
| `jsonPath editMode is not supported in search.edit v1`          | Use `file.write` for JSON-path edits.                                        |
| `replacePattern editMode requires query.literal or query.regex` | Missing query field for the selected edit mode.                              |

## See also

- [file-write-tool.md](./file-write-tool.md) — single-file write primitive
- [file-read-tool.md](./file-read-tool.md) — non-indexed file reader
