# Code Mode Response Continuation Review Remediation Design

**Date:** 2026-08-24
**Status:** Approved approach; pending written-spec review
**Parent plan:** `devdocs/superpowers/plans/2026-08-24-code-mode-response-continuation.md`

## Context

The direct `sdl.retrieve` `responseGet` implementation reuses the canonical
`response.get` handler and preserves artifact ownership and paging checks. A
production-readiness review found two adapter-boundary defects and one missing
success-path test group:

1. Non-exclusive Code Mode rewrites recovery references for unrelated
   `sdl.retrieve` operations.
2. Generated continuation calls place `detail` and `includeDiagnostics`
   inside nested operation arguments, while the server consumes those controls
   from the outer `sdl.retrieve` envelope.
3. MCP-boundary success tests do not execute structured pagination, raw replay,
   and full-detail continuation through the direct route.

## Goals

- Limit non-exclusive recovery rewriting to direct `responseGet` calls.
- Preserve explicit projection controls across every continuation page.
- Exercise structured pagination and raw replay through the public MCP boundary.
- Keep the seven-tool Code Mode surface and canonical artifact security checks
  unchanged.

## Non-goals

- Do not change canonical `response.get` paging or validation semantics.
- Do not teach every retrieve operation to accept nested projection controls.
- Do not change exclusive Code Mode recovery projection.
- Do not add tools, compatibility aliases, defaults, or diagnostic fields.

## Design

### Scope recovery projection at the server boundary

The server continues to project all recovery references when Code Mode is
exclusive. In non-exclusive mode, the extra direct-continuation projection runs
only when `toolName === "sdl.retrieve"` and `toolArgs.op === "responseGet"`.
Other retrieve operations retain their existing flat recovery references.

This gate restores non-exclusive compatibility without creating another
projection path.

### Preserve projection controls on the direct envelope

The outer direct call remains authoritative:

```json
{
  "repoId": "my-repo",
  "op": "responseGet",
  "detail": "full",
  "includeDiagnostics": true,
  "args": {
    "handle": "response-my-repo-...",
    "jsonPath": "evidence",
    "offset": 0,
    "limit": 10
  }
}
```

The retrieve adapter passes explicit outer projection controls into the
canonical handler when it builds recovery metadata. When canonical
`response.get` recovery is remapped to Code Mode, the mapper lifts
`detail` and `includeDiagnostics` onto the outer `sdl.retrieve` envelope.
Artifact controls such as `handle`, `jsonPath`, `offset`, `limit`,
`cursor`, `maxBytes`, and `raw` remain inside the nested `args` object.

The mapper emits only explicitly selected non-default controls. It does not add
volatile fields or change response key ordering.

### Tests

Tests follow RED/GREEN order:

1. A non-exclusive server-boundary test proves an unrelated retrieve operation
   keeps its flat recovery reference.
2. A live direct-response test retrieves a JSON array page with
   `detail: "full"`, follows the returned continuation, and verifies the
   projection controls and full response shape remain stable.
3. A live direct-response test exercises successful `raw: true` replay.
4. Existing artifact ownership, expiry, lifecycle, corruption, decompression,
   public-contract, determinism, documentation-sync, and Code Mode tests remain
   green.

## Error handling and security

The design continues to call the canonical artifact handler. Repository epoch,
repository ownership, session ownership, expiry, decompression limits, path
validation, and cursor validation remain unchanged. The adapter only translates
the public call shape and recovery metadata.

## Compatibility

Workflow `responseGet` remains available for existing multi-step pipelines.
Exclusive Code Mode continues to rewrite unavailable flat actions to callable
Code Mode gateways. Non-exclusive unrelated retrieval regains its previous
recovery behavior.

## Acceptance criteria

- Unrelated non-exclusive `sdl.retrieve` recovery is byte-compatible with the
  pre-feature behavior.
- Direct `responseGet` continuation retains explicit `detail` and
  `includeDiagnostics` on the outer envelope across pages.
- JSON-path array paging and raw replay succeed through the public MCP boundary.
- No new public tool or schema branch is introduced.
- Focused tests, build, typecheck, lint, public contracts, determinism, golden
  snapshots, and documentation synchronization pass.
