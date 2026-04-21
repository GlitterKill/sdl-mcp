# `sdl.search.edit` — Cross-File Search and Edit

`sdl.search.edit` is a two-phase tool that replaces the hand-composed
`symbol.search` → `file.read` → `file.write` pattern with a single,
atomic cross-file mutation primitive.

The tool runs in two modes:

- **`preview`** — returns a `planHandle` plus a summary of every file
  it would touch, the proposed edits, and the precondition snapshot
  (sha256 + mtime per file). Nothing is written.
- **`apply`** — re-checks preconditions against current disk state,
  then writes the files sequentially in deterministic order. A
  mid-batch failure triggers rollback from backups.

Plan handles are stored in-process with a 15-minute TTL and an LRU
cap of 16 handles. They do not survive server restart. Apply fails
closed on missing, expired, or repo-mismatched handles, and on any
file whose sha256/mtime has drifted since the preview was taken.

## When to use `search.edit` vs `file.write`

| Tool              | Use when                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `sdl.file.write`  | Single file, single mode (replaceLines, replacePattern, jsonPath, insertAt, append, overwrite). Immediate apply. |
| `sdl.search.edit` | Many files, one consistent edit shape, and you want atomic precondition checks + rollback across the batch.      |
| `sdl.context`     | Reading-only context retrieval for explain/debug/review/implement.                                               |
| `sdl.workflow`    | Multi-step pipelines that aren't search+edit (runtime execution, data transforms, orchestration).                |

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
  "createBackup": true
}
```

### `targeting`

- `"text"` — enumerate repo files (respecting `filters`) and regex-match
  the `query.literal` / `query.regex` pattern. Binaries, notebooks,
  archives, and files inside `node_modules`, `dist`, `.git`, etc. are
  excluded automatically.
- `"symbol"` — resolve `query.symbolRef` (via `resolveSymbolRef`) or
  `query.symbolIds` to get the home file of each symbol. Only indexed
  source files are eligible.

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
      "snippets": { "before": "...", "after": "..." },
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
  matching current `file.write` behavior. Chokidar + periodic
  `index.refresh` eventually reconcile.
- Backups are cleaned up after a fully successful batch.

## Limits and deny-list

- Max single-file size: 512 KB (same as `file.write`).
- Denied extensions: `.ipynb`, archives, binaries, images, audio, video, `.pdf`, `.wasm`, `.so`, `.dll`, `.dylib`, `.class`, `.jar`, `.exe`.
- Walker skips `.git`, `node_modules`, `dist`, `build`, `out`, `.next`,
  `.turbo`, `.cache`, `coverage`, `.nyc_output`.

## Examples

### Rename an identifier across `src/`

```json
{
  "mode": "preview",
  "repoId": "myrepo",
  "targeting": "text",
  "query": { "literal": "legacyAuth", "replacement": "authV2", "global": true },
  "editMode": "replacePattern",
  "filters": { "include": ["src/**/*.ts"] }
}
```

Apply with the returned `planHandle`.

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
