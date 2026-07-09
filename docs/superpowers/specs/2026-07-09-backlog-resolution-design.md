# SDL-MCP Backlog Resolution Design

## Summary

This design resolves the highest-value SDL-MCP backlog work without weakening response contracts, benchmark thresholds, or persisted-data safety. The work fixes two user-facing correctness defects, removes redundant model-facing response data, makes external benchmark evidence reproducible, proves and hardens the legacy embedding migration boundary, and documents the supported path for document-heavy planning.

The batch does not add a provider-first language or publish a release. Work that lacks enough evidence for safe implementation remains unchecked in the local `BACKLOG.md` with explicit prerequisites and completion criteria.

## Goals

- Emit valid Claude Code MCP setup instructions while preserving generated configuration-file compatibility.
- Support a bounded, documented subset of bracket character classes and ranges in ignore globs across scanning and watching.
- Remove named redundant model-facing response fields without changing raw internal policy results.
- Reconcile stale token-economy status documentation with current behavior.
- Make external-repository benchmark runs isolated, target-aware, and reproducible.
- Prove which legacy `SymbolEmbedding` rows can migrate safely and retain every row that cannot.
- Document a reliable SDL workflow for document-heavy planning.
- Preserve unfinished work as actionable backlog items for the next batch.

## Non-goals

- Do not add first-class Markdown or document-section indexing to `sdl.context`.
- Do not add a new provider-first language.
- Do not publish a release or choose a release version.
- Do not lower benchmark thresholds to obtain a passing run.
- Do not physically remove the `SymbolEmbedding` compatibility table in this batch.
- Do not remove canonical `SymbolCard` fields without profiling evidence that justifies the ETag, cache, and client-contract risk.
- Do not implement the full POSIX glob grammar or emit an inline `cmd.exe` JSON command.

## Work Tracks and Landing Order

The implementation uses six independently testable tracks:

1. Claude Code setup output.
2. Shared safe-glob bracket classes.
3. Model-facing response projection and token-economy documentation.
4. External benchmark isolation and evidence.
5. `SymbolEmbedding` migration proof and legacy API retirement.
6. Document-heavy planning guidance and backlog continuity.

Tracks 1, 2, 3, 4, and 5 may execute in parallel because they do not share implementation files, and each follows red-green TDD. Track 6 is a documentation acceptance track: it updates named documents and passes static documentation checks rather than manufacturing a failing code test. Shared verification runs after all tracks pass their focused gates.

## 1. Claude Code Setup Output

### Configuration shapes

Generated project configuration remains a full document:

```json
{
  "mcpServers": {
    "sdl-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sdl-mcp"],
      "env": {}
    }
  }
}
```

The `claude mcp add-json` payload is only the inner server object:

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "sdl-mcp"],
  "env": {}
}
```

The client-specific rendering seam belongs in `src/cli/commands/init.ts`, near `emitClientConfigBlocks`. The generic template loader and file generator remain format-agnostic. `templates/claude-code.json` documents the two supported destinations without claiming that one JSON shape can be copied unchanged to both.

### Commands and scopes

The implementation follows the current [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp):

- Project scope uses the full wrapper in the repository-root `.mcp.json`.
- Local scope uses `claude mcp add-json --scope local sdl-mcp <server-json>`. Local is the default, but the generated instruction includes the flag explicitly.
- User scope uses `claude mcp add-json --scope user sdl-mcp <server-json>`.

Windows output labels its executable snippet as PowerShell. It assigns the compact JSON to a single-quoted variable, doubles any embedded apostrophe, and passes the variable as one argument:

```powershell
$sdlMcpConfig = '{"type":"stdio","command":"npx","args":["-y","sdl-mcp"],"env":{}}'
claude mcp add-json --scope local sdl-mcp $sdlMcpConfig
```

POSIX output assigns the compact JSON to a single-quoted variable, escapes embedded apostrophes with the standard close-quote, escaped-apostrophe, reopen-quote sequence, and passes the variable in double quotes:

```sh
sdl_mcp_config='{"type":"stdio","command":"npx","args":["-y","sdl-mcp"],"env":{}}'
claude mcp add-json --scope local sdl-mcp "$sdl_mcp_config"
```

The renderer does not emit an inline `cmd.exe` command because arbitrary JSON quoting is not reliably portable through that shell. Windows instructions direct `cmd.exe` users to the project `.mcp.json` form or the labeled PowerShell snippet.

A missing or malformed `mcpServers.sdl-mcp` entry produces a typed configuration error before any command is printed. The renderer never emits a plausible but invalid setup block.

## 2. Shared Safe-glob Bracket Classes

`globToSafeRegex` in `src/util/safeRegex.ts` owns the grammar. `src/indexer/fileWalker.ts` and `src/indexer/watcher.ts` continue to call that one compiler.

### Accepted grammar

- A class candidate begins with `[` and is recognized only when a later unescaped `]` exists.
- Escapes take precedence while searching for the closing bracket. An escaped `]` is a member and never closes the class.
- A recognized class contains one or more literal members, escaped members, or ranges.
- `\]`, `\-`, and `\\` represent literal closing bracket, hyphen, and backslash inside a recognized class.
- An unescaped hyphen is literal in the first or last position.
- An interior unescaped hyphen forms a range.
- Ranges accept ascending ASCII letters within the same case or ascending ASCII digits: `a-z`, `A-Z`, and `0-9`, including smaller subranges.
- A class may contain multiple literals and ranges, such as `[A-Za-z0-9_]`.
- Non-ASCII characters may appear as literals but not as range endpoints.

### Rejected grammar

The compiler throws the existing typed pattern/configuration error for a recognized class containing:

- no members, as in `[]`;
- a leading negation marker, as in `[!a]` or `[^a]`;
- a reversed range, as in `[z-a]`;
- a cross-category or cross-case range, as in `[A-z]` or `[0-a]`;
- a nested unescaped `[`;
- any escape other than `\]`, `\-`, or `\\`.

If no unescaped closing bracket exists, no class is recognized. The opening `[` remains literal and scanning continues with the following characters under the ordinary glob rules. Therefore `[a\]` is an unmatched literal candidate, while `[a\]]` is a valid class containing `a` and a literal `]`. A `]` outside a recognized class remains literal.

The implementation escapes regular-expression metacharacters and retains the existing pattern-length and regular-expression safety limits. Scanner and watcher tests use the same table of patterns and paths to prove parity on Windows-normalized and repository-relative inputs.

## 3. Response Projection and Token-economy Documentation

### Exact field contract

Raw handler results remain unchanged. Only the model-facing projected objects change.

| Tool result | Raw field | Model-facing result |
| --- | --- | --- |
| `sdl.usage.stats` | `formattedSummary` | Omit because the identical summary is display text |
| `sdl.code.needWindow` approved or downgraded shape | `whyApproved` | Omit |
| `sdl.code.needWindow` approved or downgraded shape | `estimatedTokens` | Omit |

Every other field remains unless an existing generic projection rule already removes it. The implementation explicitly preserves `matchedIdentifiers`, `matchedLineNumbers`, `downgradedTo`, `reason`, `nextBestAction`, continuation guidance, and session/content references.

Before:

```json
{
  "approved": true,
  "whyApproved": "policy evidence",
  "estimatedTokens": 240,
  "matchedIdentifiers": ["resolveTarget"],
  "matchedLineNumbers": [120]
}
```

After model projection:

```json
{
  "approved": true,
  "matchedIdentifiers": ["resolveTarget"],
  "matchedLineNumbers": [120]
}
```

The implementation belongs in `src/mcp/context-response-projection.ts` and, only where text formatting duplicates the same fields, the existing formatter boundary. It does not change `CodeNeedWindowResponse`, `CodeWindowResponseApproved`, policy-decision construction, workflow results, telemetry, or raw tool results.

Projected key ordering remains deterministic. `tests/integration/determinism.fixtures.json` and golden snapshots change only when their current fixture actually exercises one of the three named omissions.

### Token-economy status

`devdocs/plans/notes/2026-07-05-token-economy-status.md` records current facts:

- FTS query identifier splitting is shipped through the identifier-aware FTS query builder.
- Live-overlay camel-case and Pascal-case subword matching is shipped.
- The historical full-suite failure is resolved by the updated tool-output visibility expectation.
- The three projection omissions above and benchmark outcome reflect this batch's fresh evidence.
- Canonical card construction remains an unchecked profiling task because projection already removes its wire-token cost.

The note retains historical runtime artifact references but does not leave obsolete unchecked entries that send future work back to completed code.

## 4. External Benchmark Isolation and Evidence

The benchmark work extends the existing locked external-repository setup and provider-first benchmark entry points. It produces a canonical input manifest, separate run results, and stable relative artifact names.

### Canonical input manifest

`run-manifest.json` uses this schema and serialization order:

```json
{
  "schemaVersion": 1,
  "target": {
    "repoId": "scip-io",
    "sourceRef": "<locked ref>",
    "sourceCommit": "<resolved commit>",
    "sourceDirty": false,
    "sourceTreeSha256": "<hash>",
    "scipArtifactSha256": "<hash or null>"
  },
  "runner": {
    "sdlMcpVersion": "<version>",
    "sdlMcpCommit": "<resolved commit>",
    "sdlMcpSourceDirty": false,
    "sdlMcpBuildTreeSha256": "<hash>",
    "nodeVersion": "<version>",
    "platform": "<platform>",
    "architecture": "<architecture>",
    "cacheMode": "cold",
    "repeats": 1
  },
  "inputs": {
    "configPath": "inputs/sdlmcp.config.json",
    "configSha256": "<hash>",
    "baselinePath": "inputs/baseline.json",
    "baselineSha256": "<hash>",
    "baselineFormatVersion": "<version>",
    "baselineTargetRepoId": "scip-io",
    "warmSnapshot": null
  },
  "repeats": [
    {
      "repeat": 1,
      "graphDbPath": "db/repeat-001.lbug",
      "stdoutPath": "logs/repeat-001.stdout.log",
      "stderrPath": "logs/repeat-001.stderr.log",
      "initialDbFiles": [],
      "command": ["node", "dist/cli/index.js", "benchmark:ci"]
    }
  ]
}
```

For `cacheMode: "cold"`, `inputs.warmSnapshot` is `null` and every repeat has an empty `initialDbFiles` array.

For `cacheMode: "warm"`, `inputs.warmSnapshot` has this conditional shape:

```json
{
  "warmSnapshot": {
    "files": [
      { "path": "inputs/warm-db/repository.lbug", "sha256": "<hash>" },
      { "path": "inputs/warm-db/repository.lbug.wal", "sha256": "<hash>" }
    ]
  }
}
```

The `files` array contains the primary database and every present LadybugDB WAL or sidecar, sorted by artifact-relative path. Each warm repeat lists `initialDbFiles` entries with `sourcePath`, `destinationPath`, and `sha256`; source paths remain under `inputs/warm-db/`, destination paths remain under that repeat's `db/` prefix, and destination paths must be absent before copying. The runner hashes each copied file before execution and requires equality with the declared source hash.

The canonical manifest contains no timestamps, durations, session IDs, random names, or machine-specific absolute paths. Paths use forward slashes and are relative to the artifact root. Stable JSON key ordering and array ordering make identical inputs byte-identical. Platform, architecture, source state, and hashes vary only when a reproducibility input varies. `sdlMcpCommit` records repository ancestry, `sdlMcpSourceDirty` records local divergence, and `sdlMcpBuildTreeSha256` hashes the stable JSON array of `{ path, sha256 }` entries for all `dist/` files sorted by artifact-relative path, so the exact executable build is identifiable even for a dirty worktree.

### Results and summaries

`results.json` contains run-specific exit status, measured durations, quality metrics, threshold evaluations, and a SHA-256 reference to `run-manifest.json`. Threshold entries sort by metric name. Logs use the manifest's stable relative names.

The runner refuses to start when:

- `SDL_CONFIG` does not resolve to the generated run config;
- `SDL_GRAPH_DB_PATH` is absent, points outside the artifact root, or is reused by another repeat;
- the baseline format is unsupported;
- `baselineTargetRepoId` does not equal the selected target;
- the locked target ref or resolved commit does not match the manifest inputs;
- the current SDL-MCP commit, dirty state, or normalized `dist/` tree hash does not match the manifest runner inputs;
- `cacheMode` is `cold` and the repeat's database path or any LadybugDB WAL/sidecar path already exists;
- `cacheMode` is `warm` and the declared input snapshot, snapshot SHA-256, or fresh per-repeat copy is missing.

A cold run refuses existing database state instead of deleting it. A warm run copies the hashed input snapshot from `inputs/` to a previously absent per-repeat database path and records that source hash; repeats never share or mutate the input snapshot.

The runner never substitutes the default project database. A bounded `scip-io` smoke validates wiring and artifact persistence. Threshold failures remain failures in `results.json`; no threshold changes belong to this track.

## 5. `SymbolEmbedding` Forward Remediation and API Retirement

Migration 7 has already shipped, so changing its code cannot repair databases whose `SchemaVersion` is already 7 or later. This batch still hardens migration 7 for databases that have not executed it, and adds `m021-remediate-symbol-embeddings.ts`, version 21 after the current version-20 registry, for already-upgraded databases with residual compatibility rows. Both migrations call the same tested classification/copy/delete helper. That helper lives in an unnumbered migration-support module so neither numbered migration imports the other.

| Starting schema version | Supported path |
| ---: | --- |
| Below 7 | The hardened migration 7 processes legacy rows safely, then later migrations run through 21 |
| 7 through 19 | Every migration after the recorded version runs in order through 20, then migration 21 safely processes residual rows |
| 20 | Migration 21 safely processes residual rows |
| Fresh database | `createBaseSchema()` creates the latest columns and compatibility table directly and records schema version 21; numbered migrations are not invoked |
| Above 21 | The initializer logs the existing future-version warning, runs no pending migrations, and continues in best-effort compatibility mode |

Migration 21 cannot recover rows that an older migration 7 already deleted; recovery of historically lost rows requires a database backup. The forward remediation prevents further unsafe deletion and safely processes rows that still exist. This batch preserves the initializer's existing best-effort behavior for future schema versions instead of introducing a separate compatibility-policy change.

### Physical identity and model lanes

`SymbolEmbedding` has one physical row per `symbolId`: `upsertSymbolEmbedding` uses `MERGE (e:SymbolEmbedding {symbolId: $symbolId})` and then sets `model`. Two model rows for one symbol and duplicate `(symbolId, model)` rows are therefore not representable through the production write path.

The remediation recognizes exactly two legacy models:

| Source model | Required dimension | Destination vector | Destination hash | Destination timestamp |
| --- | ---: | --- | --- | --- |
| `all-MiniLM-L6-v2` | 384 | `Symbol.embeddingMiniLM` | `Symbol.embeddingMiniLMCardHash` | `Symbol.embeddingMiniLMUpdatedAt` |
| `nomic-embed-text-v1.5` | 768 | `Symbol.embeddingNomic` | `Symbol.embeddingNomicCardHash` | `Symbol.embeddingNomicUpdatedAt` |

Source fields map directly: `embeddingVector` supplies the legacy STRING vector, `cardHash` supplies the hash, `updatedAt` supplies the timestamp, `symbolId` selects the destination, and `model` selects the lane. The copy preserves the original valid vector string instead of reserializing it.

### Shared vector validation and equality

A pure DB-layer helper named `decodeStoredEmbeddingVector` becomes the production validator for legacy STRING vectors and is used by the remediation and focused DB read/round-trip tests. It parses JSON and returns a numeric array only when:

- the parsed value is an array;
- its length equals the model's required dimension;
- every element has type `number`; and
- every element passes `Number.isFinite`.

A source row with an invalid vector remains in `SymbolEmbedding`. Destination vector equality means both strings decode successfully for the same model and every element compares equal with `Object.is` at the same index. Hash and timestamp equality is null-safe: `(left ?? null) === (right ?? null)`. A null hash or timestamp is valid; a null or invalid vector is not.

### Classification policy

| Source condition | Destination condition | Action | Eligible for deletion |
| --- | --- | --- | --- |
| Recognized model, valid row | Destination lane empty | Copy the original STRING vector and metadata | After verified copy |
| Recognized model, valid row | Destination lane is semantically and metadata-equal | Do not rewrite | Yes |
| Recognized model, valid row | Destination lane differs or is malformed | Log a conflict and retain both values | No |
| Recognized model | Referenced `Symbol` absent | Log an orphan and retain the row | No |
| Recognized model | Empty `symbolId` or invalid vector | Log malformed data and retain the row | No |
| `mock-fallback` | Any | Retain for compatibility | No |
| Unknown model | Any | Warn and retain | No |
| Table absent or empty | Any | Idempotent no-op | Not applicable |

A real LadybugDB test proves the one-row-per-`symbolId` identity. The design removes impossible duplicate database fixtures. A pure classifier may still reject duplicate in-memory query results defensively, but no migration behavior depends on storing duplicates.

### Transactions, race safety, and batching

Each migration performs source reads, destination reads, classification, and eligible copy writes inside one `withTransaction` block. Within that transaction, `queryAll` reads source rows in deterministic `symbolId` order, batch-reads current destination lanes, and classifies the current fingerprints. Parameterized `UNWIND` copy queries in chunks sized by the existing LadybugDB batching helper revalidate the complete source and destination fingerprints before every `SET`; a row that no longer matches remains untouched and never enters the deletion set. No classification result produced outside the transaction can authorize a write.

Single-writer serialization prevents a queued writer from changing either side during the copy transaction. A copy failure rolls back all copy writes and prevents deletion. After the copy commits, deletion runs in a second `withTransaction` block. A queued writer may run between the two transactions, so deletion independently revalidates both sides.

Each deletion candidate carries the complete source fingerprint (`symbolId`, `model`, raw vector, version, card hash, created timestamp, and updated timestamp) and the destination fingerprint observed after copy (raw destination vector, hash, and timestamp). Inside the deletion transaction, a batched `queryAll` selects only candidates whose source and destination fingerprints still match with explicit null-safe predicates. A parameterized batched delete removes only that verified set. The code reports deletion from the verified query result; it never infers a successful `MATCH` from a completed `exec`.

If either side changes between phases, the row remains. If deletion fails, `up()` throws, the migration runner does not advance `SchemaVersion`, and a rerun classifies copied destinations as exact matches before retrying deletion. DDL added by migration 7 remains autocommit and idempotent; regression tests cover partially applied column additions followed by failure and rerun.

### Legacy API gate

`upsertSymbolEmbedding` is a candidate for retirement because new production writes target `Symbol` properties. Before any export changes, indexed inbound-caller search, barrel-export inspection, focused compatibility tests, and typecheck must all pass. If the function is part of a supported external surface, this batch marks it deprecated and leaves removal in `BACKLOG.md`; it does not create an unannounced breaking change. Other legacy read/delete APIs remain unless they independently satisfy the same gate.

## 6. Document-heavy Planning and Backlog Continuity

Track 6 updates `docs/feature-deep-dives/agent-context.md`, `SDL.md`, and the synchronized `templates/SDL.md` workflow template. The documents define `sdl.context` as a code-understanding surface and add a named document-heavy planning path: locate the relevant README, ADR, specification, or plan, then use targeted `sdl.file.read` calls with `search`, bounded ranges, or structured extraction.

The guidance includes a concrete targeted-read example and a failure rule: when broad context returns irrelevant symbol evidence for a documentation task, switch retrieval surfaces instead of widening symbol budgets. First-class document entities, Markdown indexing, ranking, citations, and planning benchmarks remain a separate product backlog item.

Track 6 passes documentation acceptance when `npm run docs:workflows:check` and `npm run docs:tools:check` succeed and the synchronized template contains the same retrieval rule. It does not require a fabricated failing code test.

The ignored `BACKLOG.md` cannot be validated by committed CI. The local completion gate reads it through SDL, verifies that deferred entries remain unchecked with concrete next actions, and runs `git check-ignore -q BACKLOG.md`.

The local ignored `BACKLOG.md` remains the authoritative follow-up queue. Completed items receive fresh verification evidence. Unfinished items remain unchecked with these next actions:

- profile canonical card construction and quantify CPU/allocation cost before removing fields;
- validate persisted databases across a release boundary before dropping `SymbolEmbedding`;
- design and benchmark document entities before extending `sdl.context`;
- collect user demand and confirm parser/LSP viability before choosing a language;
- choose and authorize a release only after the current Unreleased scope passes release gates.

No deferred item is marked complete merely because this batch chose not to implement it.

## Error Handling and Compatibility

All new failures use existing typed error and logging conventions. Code does not swallow malformed Claude templates, unsafe glob syntax, benchmark input mismatches, migration conflicts, malformed rows, or orphan rows.

The implementation preserves these compatibility boundaries:

- generated client files retain their full document shape;
- PowerShell and POSIX commands pass the inner JSON as one argument;
- scanner and watcher use one glob compiler;
- raw MCP handler results retain internal evidence;
- projected key ordering remains deterministic;
- unresolved embedding data remains persisted;
- benchmark thresholds remain unchanged;
- no release or language-support surface changes.

## Test Strategy

Each behavior starts with a focused failing test that demonstrates the missing contract.

### Claude Code

- Generated files keep the outer `mcpServers` wrapper.
- Local and user CLI instructions use only the inner server object and the canonical scope placement.
- PowerShell and POSIX renderers preserve apostrophes and pass one JSON argument.
- Windows output is labeled PowerShell and does not claim `cmd.exe` compatibility.
- The emitted object includes `type: "stdio"`, command, arguments, and environment.
- Malformed templates fail before output.

### Ignore globs

A table-driven suite covers every accepted and rejected grammar rule. It includes `[Bb]in/`, nested `**/[Bb]in/**`, `[a-c]ache/**`, `[A-Za-z0-9_]`, escaped `]` and `-`, first/last literal hyphens, empty and negated classes, reversed and cross-category ranges, unmatched opening brackets, stray closing brackets, and dangling escapes.

The same cases run through file scanning and the Chokidar ignored predicate with normalized Windows separators and repository-relative paths.

### Response projection

- Model-facing `usage.stats` omits only `formattedSummary`.
- Raw usage results retain `formattedSummary`.
- Model-facing `code.needWindow` omits only `whyApproved` and `estimatedTokens`.
- Raw `code.needWindow` results retain both fields.
- Actionable evidence and continuation/session fields remain.
- Golden and determinism fixtures capture only intentional response changes.

### Benchmarks

- Unsafe or missing `SDL_CONFIG` and `SDL_GRAPH_DB_PATH` fail before child execution.
- A mismatched target or baseline format fails before child execution.
- A cold repeat rejects an existing database, WAL, or sidecar path.
- A warm repeat verifies the input snapshot hash and copies it to a distinct absent path.
- Per-repeat database paths are distinct and artifact-relative.
- Identical inputs serialize to byte-identical manifests.
- The runner commit, dirty state, and normalized `dist/` tree hash match the executing build; changing a built file changes the fingerprint.
- Results reference the manifest hash and sort thresholds.
- A bounded external smoke persists all declared artifacts without modifying thresholds.

### Migration

- A database below version 7 executes the hardened migration 7 without deleting an orphan, malformed row, conflict, mock row, or unknown model.
- A database already at version 7 or 20 with residual legacy rows advances through remediation migration 21.
- A fresh database creates the latest schema directly at version 21, includes the final embedding columns and an empty compatibility table, and does not invoke numbered migrations.
- A database above version 21 logs the existing warning, runs no pending migrations, and continues in best-effort compatibility mode.
- Migration-7 DDL remains idempotent after partially applied column additions and a failed rerun.
- A queued conflicting writer cannot interleave between classification and copy because both occur in one transaction; a mutation after copy is caught by deletion revalidation.
- MiniLM vectors require 384 finite numbers; Nomic vectors require 768 finite numbers.
- STRING vector serialization round-trips through the shared decoder and LadybugDB.
- Empty lanes, semantic exact matches, null metadata, destination conflicts, orphans, malformed vectors, mock rows, and unknown models follow the decision table.
- The real schema proves one `SymbolEmbedding` row per `symbolId`; no impossible duplicate DB fixture is used.
- An injected copy failure rolls back all destination writes and deletes no source.
- An injected deletion failure leaves source and destination, does not advance the schema version, and succeeds safely on rerun.
- A failure while recording the final schema version after successful remediation reruns as an idempotent no-op and then advances safely.
- A source or destination mutation between phases prevents deletion unless the complete fingerprints still match.
- Multi-batch runs preserve deterministic ordering and bounded query counts.
- No deletion matches only broad `symbolId`; model and full source/destination fingerprints are required.

Indexed inbound-caller search, barrel-export inspection, focused compatibility tests, and typecheck gate any legacy export change.

### Documentation acceptance

- `docs/feature-deep-dives/agent-context.md`, `SDL.md`, and `templates/SDL.md` contain the same document-heavy retrieval rule and targeted-read example.
- `npm run docs:workflows:check` and `npm run docs:tools:check` pass.
- Local SDL readback confirms deferred backlog entries remain unchecked with prerequisites.
- `git check-ignore -q BACKLOG.md` succeeds.

## Integration and Completion Gates

Tracks 1 through 5 must pass their focused tests, and Track 6 must pass its documentation acceptance checks, before integration. The final verification sequence is:

1. Build and typecheck.
2. Focused unit and integration tests for Tracks 1 through 5.
3. Lint with zero errors.
4. Track 6 documentation, workflow-template, and generated-inventory checks.
5. Prompt-cache determinism checks and golden validation.
6. Full `npm test`.
7. Bounded external benchmark smoke with persisted artifacts.
8. Targeted cleanup of temporary databases, fixtures, and edit backups.
9. Final `BACKLOG.md` reconciliation from fresh evidence.

A failing gate keeps its related backlog item unchecked and records the artifact handle, failure boundary, and next action. The batch does not claim completion from partial or stale results.
