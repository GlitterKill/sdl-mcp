# Code Mode Response Continuation Design

**Status:** Approved by independent spec review; awaiting user approval  
**Date:** 2026-08-24

## Problem

Exclusive Code Mode exposes sdl.retrieve, but stored-response retrieval is currently available only as the responseGet workflow function. After a large response returns a handle, its nextAction therefore asks the model to construct a one-step sdl.workflow call. That is valid but feels like a new workflow instead of continuing the original retrieval.

## Decision

Add responseGet as an operation on the existing sdl.retrieve tool:

    sdl.retrieve({
      repoId: "sdl-mcp",
      op: "responseGet",
      args: {
        handle: "response-handle",
        cursor: { offsetBytes: 8192 },
        maxBytes: 8192,
      },
    });

This is a thin Code Mode adapter over the existing response.get action. It adds no MCP tool, response store, or paging implementation.

## Goals

1. Make large-response paging directly executable from the returned nextAction.
2. Preserve the seven-tool exclusive Code Mode surface.
3. Reuse response.get validation, ownership checks, paging, and artifact delivery.
4. Keep current workflow callers compatible.

## Non-goals

- Move response storage or paging logic into sdl.retrieve.
- Add an eighth sdl.response tool.
- Change the flat or namespace-gateway response APIs.
- Remove the gateway adapter or shared Dispatch Spine in this change.
- Add repository status operations to sdl.info or sdl.retrieve.

## Request Contract

The current retrieve input is an operation enum plus generic args; buildRetrieveWireSchema derives the per-operation nested wire schemas from authoritative Action Definitions. Therefore implementation must:

1. Append responseGet to RetrieveOpSchema without reordering the existing six operations.
2. Add responseGet: "response.get" to RETRIEVE_ACTION_BY_OP.
3. Derive the responseGet nested wire schema from the existing response.get Action Definition, not reconstruct a second request schema.

The nested responseGet args include the existing handle, byte cursor, page bounds, jsonPath, and full/raw controls, but must exclude repoId. repoId belongs only to the sdl.retrieve envelope.

At dispatch, the trusted envelope must win even if unexpected nested data reaches the handler:

    { ...request.args, repoId: request.repoId }

The adapter must never use the reverse order. This prevents nested args from overriding repository ownership before handle validation.

## Continuation Contract

When another page exists, the continuation is:

    {
      action: "sdl.retrieve",
      args: {
        repoId: "sdl-mcp",
        op: "responseGet",
        args: {
          handle: "response-handle",
          cursor: { offsetBytes: 16384 },
          maxBytes: 8192,
        },
      },
    }

The continuation preserves the existing response.get cursor and bound semantics. It does not invent a second cursor format.

Exclusive Code Mode currently materializes an unadvertised response.get recovery action through sdl.workflow. Map the logical action to:

    { tool: "sdl.retrieve", op: "responseGet" }

That mapping alone is insufficient. The common validated recovery path must rematerialize the validated logical child arguments into the exact nested envelope shown above, remove any child repoId, order the fields deterministically, and parse the completed call through the retrieve schema before returning it. Repeated pages must remain direct sdl.retrieve actions until completion rather than oscillating to sdl.workflow.

## Dispatch and Delivery Flow

    sdl.retrieve
      -> RetrieveRequestSchema / generated wire schema
      -> RETRIEVE_ACTION_BY_OP["responseGet"] = "response.get"
      -> dispatchAction with envelope-owned repoId
      -> shared Dispatch Spine
      -> handleResponseGet
      -> existing response artifact store

handleRetrieve remains a thin adapter. The response.get Action Definition and handler stay authoritative for handle lookup, repository and session ownership, server epoch, expiry, metadata, decompression bounds, paging, and error construction.

Generic top-level response projection must not store a retrieved page as a new artifact. Because this rule applies only to responseGet, do not make every sdl.retrieve operation page-native. Instead, add an op-aware delivery bypass for responseGet before generic artifact storage. The outer sdl.retrieve responseMode remains accepted for the stable common envelope but is ignored for responseGet; response.get page bounds and raw/full controls remain authoritative. Tests must cover outer responseMode values auto and handle to prove neither re-artifactizes the page.

## Output and Error Contract

RetrieveOutputSchema must include the exact strict projected response.get success, recoverable-error, and continuation variants from the authoritative response action contract. Do not replace them with a broad object schema or duplicate their field definitions. Preserve variant order and serialized key order.

All existing security and lifecycle checks remain in handleResponseGet:

- repository and MCP-session ownership
- active server epoch
- handle expiry and metadata validation
- bounded decompression and page-size enforcement

Errors retain their current classification, retryability, fallback information, and projection. The Code Mode adapter does not catch or rewrite them outside the existing common projection.

## Compatibility and Prompt-Cache Hygiene

The existing responseGet workflow function remains registered. Existing callers and non-exclusive surfaces continue unchanged. The direct retrieve operation becomes the preferred continuation only when sdl.retrieve is advertised.

The exclusive tool list remains exactly seven tools in its existing order. The operation is appended to the static schema, default output remains deterministic and diagnostics-free, and intentional schema/output changes update required determinism fixtures.

## Expected Implementation Scope

The minimum implementation touches only the retrieve schema and adapter, exclusive action-reference/recovery projection, focused tests, generated inventory or determinism fixtures required by contract checks, and Code Mode documentation. No new service, store, or abstraction is needed.

## Verification

1. Schema tests accept valid responseGet calls, reject mismatched variants and nested repoId, and prove an override attempt cannot change the envelope repoId.
2. Handler-backed tests retrieve and page a real stored artifact to completion with exact direct-action nesting and stable ordering.
3. Wrong-repository, wrong-session, expired-handle, active-epoch invalidation, invalid-metadata, and bounded-decompression errors remain unchanged.
4. Outer responseMode auto and handle do not re-artifactize a retrieved page; repeated continuations remain sdl.retrieve calls.
5. Registration, strict output-schema checks, golden/determinism fixtures, generated inventory, typecheck, lint, and affected Code Mode/response tests confirm the seven-tool surface.

## Alternatives Rejected

- **Keep the workflow continuation:** no implementation cost, but retains the interaction break.
- **Add sdl.response:** clear ownership, but adds an eighth tool for one operation.
- **Put continuation on every originating tool:** natural locally, but duplicates one cross-cutting contract.
- **Move response retrieval to sdl.info:** mixes server diagnostics with repository/session-scoped artifact access.
