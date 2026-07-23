# Single Session Workflow Instruction Injection

Status: Approved  
Date: 2026-07-22

## Problem

SDL-MCP supplies `SDL_MCP_SERVER_INSTRUCTIONS` through the MCP initialization response. The active Codex MCP adapter prepends those server instructions to every imported tool description, so one canonical workflow appears six times in a Code Mode tool catalog.

The server must preserve fallback guidance for clients that do not load the `sdl-mcp-agent-workflow` skill. The fix must also preserve deterministic tool ordering, response key ordering, and byte-stable `tools/list` results.

## Decision

SDL-MCP will stop setting MCP initialization `instructions`. Instead, the `tools/list` handler will prepend `SDL_MCP_SERVER_INSTRUCTIONS` to the description of the first advertised tool only.

The handler already builds the complete ordered tool snapshot from `this.tools.values()`. Applying the prefix at that boundary covers every configured tool surface, including surfaces that do not expose `sdl.action.search`.

The instruction text remains defined once in `src/mcp/server-instructions.ts`.

## Response Shape

For each `tools/list` response:

1. Preserve the current tool order.
2. Build each versioned description exactly as today.
3. Prefix the workflow block and one blank line only when the tool index is zero.
4. Return every remaining description unchanged.

A response with no tools contains no workflow block.

## Determinism

The result depends only on the registered tool order, which is already part of the static prompt-cache contract. Repeated `tools/list` calls against the same server configuration return the same bytes.

SDL-MCP will not track whether a client has previously fetched the catalog. Session-aware suppression would make identical requests return different results and break deterministic caching. Clients must replace an old tool-catalog snapshot when they refresh it rather than append duplicate snapshots.

## Verification

A focused regression will request the advertised tool list and assert:

- The MCP initialization response omits the `instructions` key.
- The first description equals `SDL_MCP_SERVER_INSTRUCTIONS + "\n\n" + versionedDescription`.
- The complete workflow block appears exactly once across all tool descriptions.
- Every later tool description remains byte-identical to its existing value.
- Tool ordering and response/tool object key ordering remain unchanged.
- Two repeated `tools/list` JSON serializations are byte-identical and preserve current version suffix behavior.

The implementation will update `tests/integration/determinism.fixtures.json` because tool descriptions are contract surface.

## Documentation

Update the prompt-cache hygiene documentation and the Unreleased changelog entry to describe the single-copy tool-catalog behavior.

## Non-goals

- Changing the Codex MCP adapter.
- Adding per-session mutable server state.
- Adding a new initialization tool, prompt, or resource.
- Recovering the currently failed local LadybugDB graph-integrity state.
