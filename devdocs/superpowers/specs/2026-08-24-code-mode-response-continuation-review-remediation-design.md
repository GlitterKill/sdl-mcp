# Code Mode Response Continuation Review Remediation Design

**Date:** 2026-08-24
**Status:** User pre-approved; five review iterations incorporated
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
- Do not teach every retrieve operation to consume nested projection controls.
- Do not remove exclusive Code Mode recovery from typed errors.
- Do not add tools, compatibility aliases, defaults, or diagnostic fields.

## Design

### Make late responseGet projection the final authority

Registration keeps the existing
`withExclusiveCodeModeRecoveryProjection(config.exclusive, ...)` wrapper. The
wrapper changes only its success path:

- In exclusive mode, successful operations other than `responseGet` retain
  registration-time recovery projection.
- A successful `responseGet` result remains canonical until the late server
  envelope projects it.
- The wrapper's catch path remains unchanged. Exclusive typed errors still
  project raw `response.get` recovery before `errorToMcpResponse` validates
  and materializes recovery fallbacks.

The late server-envelope projection receives normalized outer tool arguments
for both success and error envelopes. Its exact predicate is:

```text
toolName === "sdl.retrieve" && toolArgs.op === "responseGet"
```

The late pass is the final authority for direct responseGet recovery in both
exclusive and non-exclusive modes and for both success and error envelopes. In
exclusive typed-error flow, the early catch preserves callable recovery before
error materialization and the late pass revisits an already projected envelope
idempotently. In non-exclusive typed-error flow, the late pass converts
canonical `response.get` recovery to direct `sdl.retrieve` recovery.

The late pass does not touch unrelated non-exclusive retrieval. Exclusive
unrelated recovery remains projected by the registration wrapper.

Boundary tests cover all five cases:

1. Exclusive mode plus an unrelated successful retrieve remains remapped.
2. Non-exclusive mode plus an unrelated successful retrieve remains unchanged.
3. Exclusive and non-exclusive successful responseGet calls produce direct
   continuation at the final MCP boundary.
4. Exclusive typed responseGet errors retain exactly one callable direct
   recovery action after both projection boundaries.
5. Non-exclusive typed responseGet errors produce the same direct recovery
   shape at the final MCP boundary.

### Preserve normalized outer projection controls

The outer direct call remains authoritative:

```json
{
  "repoId": "my-repo",
  "op": "responseGet",
  "args": {
    "handle": "response-my-repo-...",
    "jsonPath": "evidence",
    "offset": 0,
    "limit": 10
  },
  "detail": "full",
  "includeDiagnostics": true
}
```

The MCP server already resolves standard projection controls from normalized
outer tool arguments before it builds the response envelope. The late
responseGet projection takes an explicit snapshot from that resolved boundary:
`detail` only when it is `"standard"` or `"full"`, and
`includeDiagnostics` only when it is `true`. Invalid outer values fail the
common production `tools/call` validation before recovery rematerialization.

The late projector passes this snapshot explicitly to response-recovery
rematerialization. Nested `args.detail` and `args.includeDiagnostics` never
supply or override the snapshot. Artifact controls such as `handle`,
`jsonPath`, `offset`, `limit`, `cursor`, `maxBytes`, and `raw`
remain inside nested `args`.

Calls without non-default controls remain byte-identical. The responseGet
continuation envelope preserves the canonicalized existing key order—`args`,
`op`, `repoId`, optional `responseMode`—then appends optional `detail`
and optional `includeDiagnostics`.

### Keep nested responseGet arguments projection-free

`ResponseGetContinuationRequestSchema` becomes the strict projection-free
schema for responseGet artifact arguments. Canonical `response.get` and
workflow `responseGet` continue to use `ResponseGetRequestSchema`, so their
projection controls remain unchanged.

`RetrieveResponseGetNextActionSchema` keeps its existing union branch and adds
optional outer `detail` and `includeDiagnostics` fields to that branch's
strict envelope. It uses the projection-free continuation schema for nested
`args`.

`buildRetrieveWireSchema()` uses the projection-free continuation schema only
for the `responseGet` nested variant instead of the authoritative action
schema. The standard MCP projection augmentation continues to advertise
`detail` and `includeDiagnostics` on the outer `sdl.retrieve` envelope.

At runtime, the `handleRetrieve` responseGet branch parses nested `args` with
`ResponseGetContinuationRequestSchema` before it adds the trusted envelope
`repoId` and dispatches to canonical `response.get`. This parse makes nested
projection controls invalid in production instead of merely omitting them from
advertised and returned schemas. Canonical `response.get` performs its existing
full request validation after the adapter injects `repoId`.

No new public tool, operation, or union branch is added.

### Public-boundary RED/GREEN tests

Tests call the production-registered `sdl.retrieve` through real MCP
`tools/call`; they do not call only the handler or mapper.

1. The compatibility test uses a deterministic unrelated non-exclusive
   `codeNeedWindow` response whose recovery metadata contains the flat
   `sdl.code.getSkeleton` reference rewritten by the defect. It compares exact
   serialized `structuredContent`, including key order, with the pre-feature
   expectation.
2. Boundary tests confirm exclusive unrelated success still remaps and
   compare exact exclusive and non-exclusive typed responseGet error envelopes.
   Each error exposes exactly one direct callable recovery action.
3. A `tools/list` contract test proves projection controls are present on the
   outer retrieve schema and absent from the nested responseGet variant.
4. Production `tools/call` rejects invalid outer control types and rejects
   nested `args.detail` or `args.includeDiagnostics`.
5. The structured replay test creates a JSON artifact, requests an array path
   with `offset` and `limit`, and replays every returned
   `nextAction.action` and `nextAction.args` unchanged until paging
   completes.
6. Every replayed page validates against the advertised production output
   schema and retains outer `detail: "full"` and
   `includeDiagnostics: true`.
7. A separate public `tools/call` executes `raw: true` successfully through
   the direct responseGet route.

The tests first fail for the verified compatibility, schema, and continuation
defects. Production changes begin only after the RED states are observed.

## Error handling and security

The design continues to call the canonical artifact handler. Repository epoch,
repository ownership, session ownership, expiry, decompression limits, path
validation, and cursor validation remain unchanged. The adapter only translates
the public call shape and recovery metadata. The early exclusive catch path
continues to protect thrown typed errors.

## Compatibility

Workflow `responseGet` remains available for existing multi-step pipelines.
Exclusive Code Mode continues to rewrite unavailable flat actions to callable
Code Mode gateways. Non-exclusive unrelated retrieval regains its previous
recovery behavior. Handler-only success tests no longer treat early responseGet
projection as the public contract; final MCP envelopes are authoritative.

## Acceptance criteria

- Exact serialized `structuredContent` for a recovery-bearing unrelated
  non-exclusive retrieve call matches the pre-feature expectation.
- Exclusive unrelated retrieval remains projected, and exact exclusive and
  non-exclusive typed responseGet error envelopes contain one direct callable
  recovery action.
- Successful direct responseGet continuation is projected at the final MCP
  boundary in exclusive and non-exclusive modes.
- Direct responseGet continuation retains explicit outer `detail` and
  `includeDiagnostics` across every page.
- Each returned continuation is replayable unchanged through production
  `tools/call` and validates against the advertised output schema.
- `tools/list` advertises projection controls outer-only for responseGet.
- Invalid outer projection types and nested projection controls are rejected.
- JSON-path array paging reaches completion and raw replay succeeds.
- No new public tool, operation, or schema branch is introduced.
- Focused tests, build, typecheck, lint, public contracts, determinism, golden
  snapshots, and documentation synchronization pass.
