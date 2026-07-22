# Public Graph Retrieval Admission Design

## Goal

Fail public code-graph reads closed until the repository's latest Version has
an established graph-integrity manifest, while keeping current verified,
verifying, and failed manifests readable. Preserve every successful response
byte-for-byte and keep non-graph administration, status, file, and mutation
surfaces available.

## Public admission boundary

`MCPServer` applies one admission check after the canonical tool name and
validated arguments are known. For centrally gated calls, classification,
availability lookup, waste-ledger accounting, and the handler execute inside
one dispatch lease; admission runs immediately before the handler. A pure
declarative classifier marks each versioned code-graph read as central or
conditional:

- Registered flat and gateway actions: symbol search/single-card lookup, slice
  build/refresh/spillover, delta, PR risk, code window/skeleton/hot path, and
  repository overview.
- Code-mode tools: context and all six retrieve operations.
- Workflows containing any of those graph-backed actions.
- File gateway preview/source window operations.

The classifier explicitly marks each surface as centrally gated,
conditionally gated, or excluded. `slice.refresh` is the only conditional
operation: its stable public schema is handle-only, so the existing
slice-handle lookup resolves the repository before applying the same shared
availability assertion. Every other graph read is centrally gated from its
validated top-level `repoId`. The classifier excludes raw file reads, policy,
repository status, registration/index administration, writes/edits,
runtime/response/usage, buffer, feedback, semantic-enrichment status, and
memory records. It uses exact canonical names and exact validated action/op
values, never prefixes or substrings. A centrally classified call without a
repository ID fails closed with typed deterministic full-refresh guidance.

Existing symbol and centrally gated slice handler-local guards are removed
after real MCP dispatch tests prove the shared boundary. The conditional
`slice.refresh` guard remains at the handle-resolution boundary. This prevents
duplicate database queries and leaves internal handler composition unchanged.

## Full-index quiescence

`indexRepo` resolves the effective mode after its per-repository lock and idle
drain. A requested incremental run with no indexed files becomes effective
full mode at that point. The complete effective-full operation—pre-index
checkpoint, indexing implementation, and synchronous verification
completion—runs inside repository verifier quiescence. Explicit full and
incremental-upgraded-to-full therefore share one boundary. Ordinary
incremental indexing is not quiesced. Shadow activation may retain its nested
quiescence because admission uses reference counts.

The quiescence helper releases admission in `finally`, including index
failures.

## Public refresh dispatch admission

Public refresh envelopes are serialized by one process-wide FIFO admission
gate before they acquire the normal tool-dispatch lease. The exact admitted
surfaces are flat `sdl.index.refresh`, gateway `sdl.repo` with
`action: "index.refresh"`, and non-dry-run workflows containing
`fn: "indexRefresh"`. Global admission is required even for different
repositories because LadybugDB has one writer and each refresh waits for every
other graph-read dispatch lease to drain before destructive work.

Synchronous calls retain admission through handler completion. For
`async: true`, the operation response still returns immediately, while the
handler transfers admission ownership to the detached background refresh
promise until it settles. The transfer does not retain a normal dispatch slot.
Direct watcher and CLI `indexRepo` calls keep their existing synthetic
dispatch/indexing-gate path.

## Verification

- Exhaustive pure classifier tests enumerate registered public tools and every
  gateway/retrieve/workflow/file operation as gated or excluded.
- Real MCP dispatch tests cover denied and byte-identical verified symbol and
  slice reads through flat, gateway, and workflow projections before their
  handler-local guards are removed. File preview/source-window operations have
  equivalent denied and verified-success dispatch coverage.
- A classified envelope missing its repository identity returns one exact,
  typed deterministic error without invoking the handler or inferring another
  repository.
- Disposable real-DB MCP tests cover unknown/no-manifest rejection and
  byte-identical verified success for context, code tools, all retrieve ops,
  delta, PR risk, and repository overview.
- Repeated verified calls compare the full serialized MCP envelope, preserving
  key order and proving admission adds no response fields. The pre-existing
  `slice.build` exception is explicit: every build creates its handle with
  `crypto.randomBytes(16)`, and the full handle plus its eight-character
  display prefix are the only normalized occurrences for flat, retrieve,
  gateway, and workflow comparisons. The surrounding envelope remains
  byte-identical; handle generation behavior is unchanged.
- A blocked admission query proves the admission lookup and handler share one
  dispatch lease, so full-index quiescence cannot enter between them.
- Real concurrent MCP refreshes cover flat calls on different repositories,
  gateway calls on one repository, multi-step workflow refreshes, detached
  async ownership transfer, and the graph-read/reset exclusion boundary.
- A real blocked verifier lease proves legacy/direct full indexing cancels and
  closes the lease before destructive reset. Additional cases cover explicit
  full, incremental-to-full upgrade, failure release, and unchanged ordinary
  incremental admission.
- Existing determinism, golden, Task 7, and prior graph-integrity regression
  suites remain green.
