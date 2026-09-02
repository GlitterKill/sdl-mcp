# Automatic Louvain Manual-Only Design

## Problem

Automatic derived-state recovery can run LadybugDB Louvain for minutes. Live
verification showed that neither `Connection.setQueryTimeout(10)` nor
`CALL TIMEOUT=10` interrupted a deliberately long query on the current
Windows LadybugDB 0.19 runtime. A JavaScript timeout would only abandon the
caller while the native query kept blocking database writers.

## Decision

Automatic cluster/process orchestration must not execute Louvain.

- Normalize automatic algorithm-refresh input so Louvain is disabled even when
  legacy configuration requests `louvain.enabled: true`.
- Report automatic Louvain diagnostics as `disabled` with reason
  `manual-only`.
- Clear existing Louvain shadow clusters so stale enrichment is not presented
  as current.
- Keep PageRank, k-core, canonical clusters, process tracing, retrieval, and the
  Galaxy viewer's canonical graph data unchanged.
- Keep the exported low-level `runLouvain` function intact for a future
  explicit trigger.

The existing Louvain configuration shape remains accepted for compatibility,
but its `enabled` value no longer enables automatic execution. The public
schema and example advertise `false` and identify the field as manual-only.

## Failed Timeout Attempt

Remove the unverified timeout plumbing added during investigation:

- `LouvainOptions.queryTimeoutMs`
- the local LadybugDB `setQueryTimeout` declaration
- the automatic 15-second option
- the dedicated refresh connection introduced only to isolate that option
- tests that claimed the native timeout was effective

These must not remain as false liveness protection.

## Future Trigger Boundary

The future trigger is out of scope. It must be explicit, observable, and run
behind a genuinely cancellable execution boundary before it may call
`runLouvain`. Automatic indexing and startup recovery must remain
manual-only until that mechanism is implemented and live-verified.

## Verification

1. A focused test enables Louvain in legacy config and proves the automatic
   runner is not called.
2. The same test proves centrality still writes and diagnostics return
   `disabled/manual-only`.
3. Focused algorithm, orchestrator, and derived-refresh tests pass after the
   failed timeout plumbing is removed.
4. Build, typecheck, lint, and diff checks pass.
5. After restart, startup recovery emits no Louvain execution and does not
   recreate the prior writer/audit backlog. No reindex is required.
