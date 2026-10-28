# MCP tools detailed reference

The canonical reference for SDL-MCP tools is the [MCP Tools Reference](./mcp-tools-reference.md).

It documents the current flat, gateway, and Code Mode surfaces, request and response behavior, and recommended workflows. The [Generated Tool Inventory](./generated/tool-inventory.md) remains the source of truth for registered tool names and mode counts.

This page remains at its original URL so existing links continue to work.

## Repository removal

Use `repo.unregister` only for runtime registrations. It requires `confirmRepoId` to exactly match `repoId`, rejects configured repositories until their entry is removed from `SDL_CONFIG`, and rejects dirty live buffers unless `discardDrafts: true` is explicit. Successful removal returns only `{ ok: true, repoId, removed: true }` and deletes repository-owned graph data while preserving unrelated repositories and global content-addressed nodes.

## Repository graph integrity status

`sdl.repo.status` reports graph integrity under `derivedState`. The `graphIntegrityRevision` field identifies the current persisted graph revision, while `graphIntegrityVerifiedRevision` identifies the last revision that an independent verification snapshot published successfully. Equal values with `graphIntegrityState: "verified"` prove the current revision.

`structuralStale` covers clusters, processes, and graph algorithms; `semanticStale` covers summaries and embeddings. The legacy `stale` field is their aggregate. Semantic-only staleness does not block structural or code retrieval: continue with available retrieval lanes and do not run incremental indexing solely because `summariesDirty` or `embeddingsDirty` is set.

The `verifying` and `failed` states can remain graph-readable when the current Version has a valid manifest and revision metadata. They do not claim that the latest revision is verified. Continue normal graph reads during `verifying`; SDL-MCP recovers lost verifier wakeups without an agent-triggered refresh. After a permanent failure, `nextBestAction` stops refresh retry loops and directs the operator to a stopped `index --force --safe-rebuild` recovery.

Graph-backed retrieval remains fail-closed when it is unavailable, including when an `indexRefresh` step appeared earlier in the same `sdl.workflow`. A recovery action is not authorization: request explicit user approval in the current turn before running a refresh in a separate workflow, then wait only when the task depends on the resulting graph state.

## Symbol search misses

`sdl.symbol.search` searches symbol names; it does not add file-path matches to symbol ranking. When a search has no useful result and its query is clearly path-like (a slash or backslash, a known source extension, or an exact indexed repository-relative path), the response includes one structured `nextBestAction`. Call `sdl.context` with the supplied flat `focusPaths: [query]`. Ordinary symbol-name misses do not receive this path-specific hint.

## Context retrieval profiles

`sdl.context` uses the flat strict request defined by its tool schema. The
required `budget.maxTokens` bounds the complete canonical payload. Optional
`focusSymbols`, `chatMentions`, and exact-file `focusPaths` prioritize resolved
symbols; exact-file focus matches that file path and contributes to the bounded
Tier-0 allocation without excluding other files. Directory `focusPaths` matches
descendants beneath the `focus/` path-segment prefix. Candidate search
stable-partitions the already-fused, bounded pool in this order: Tier-0 pins,
in-directory rows, then outside rows, preserving fused order within each group.
It does not widen lanes, oversample, rerun retrieval, or change scores or
provenance. Final selection retains explicit Tier-0 pins and excludes unpinned
outside evidence when an in-directory bundle fits the remaining budget. If no
usable in-directory bundle fits, outside candidates remain a fallback.

If an exact indexed `focusPaths` entry has no usable symbols, `sdl.context`
returns `CONTEXT_FOCUS_PATH_UNAVAILABLE` instead of unrelated context. Its
recovery may propose an incremental refresh followed by the canonical
`sdl.context` retry. Treat that proposal as a candidate action, not approval;
use a non-refresh fallback or request explicit current-turn user approval.

The `taskType` selects a deterministic retrieval profile. SDL-MCP chooses the
available lexical, vector, graph, overlay, feedback, and memory lanes, then
returns `evidence`, selected-symbol `edges`, bounded `omitted` details, and
logical `nextActions`. See [Context Profiles](./feature-deep-dives/context-modes.md)
for the selection and budget contracts.

The Code Mode `sdl.context` schema rejects unknown root keys and unknown
`budget` keys. The `sdl.retrieve` schema publishes operation-specific `args`
variants with their own validation boundaries.

## Response artifact retrieval

`sdl.response.get` requires an explicit mode for JSON artifacts. Use `full: true` to return the parsed JSON value, `jsonPath` to return one complete structural value (with `offset` and `limit` for extracted arrays), or `raw: true` to request a bounded byte excerpt. Raw JSON excerpts may be syntactically incomplete. `offsetBytes` applies only to raw JSON or text excerpts and cannot be combined with `full: true` or `jsonPath`.

Text artifacts retain bounded excerpt retrieval by default. Use `full: true` only when the complete text fits the configured artifact limit.

Missing, malformed, expired, and stale response handles return a typed `NOT_FOUND` error with `retryable: false`. Rerun the original handle-producing call. When valid manifest metadata identifies the producer, `fallbackTools` names that tool; otherwise SDL-MCP omits the fallback instead of recommending an unrelated action.

## Find the right guide

- [MCP Tools Reference](./mcp-tools-reference.md): tool parameters, responses, and usage guidance.
- [Code Mode](./feature-deep-dives/code-mode.md): compact discovery, retrieval, file, and workflow wrappers.
- [CLI Tool Access](./feature-deep-dives/cli-tool-access.md): direct CLI action aliases and output formats.
- [File Read](./file-read-tool.md), [File Write](./file-write-tool.md), [Search Edit](./search-edit-tool.md), and [Symbol Edit](./symbol-edit-tool.md): focused file and edit guidance.
- [Tool Gateway](./feature-deep-dives/tool-gateway.md): namespace routing and registration modes.

[Back to Documentation Hub](./README.md)
