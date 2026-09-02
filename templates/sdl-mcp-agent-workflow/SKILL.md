---
name: sdl-mcp-agent-workflow
description: Use when working in an SDL-MCP-enabled repository, including repository exploration, task context, code inspection, runtime execution, edits, or SDL-MCP tool calls.
---

# SDL-MCP Agent Workflow

Use SDL-MCP as the repository boundary.

When a client bridge returns the raw MCP result, prefer `structuredContent`; use
text `content` only as a fallback for older servers. Do not emit both or return
the whole MCP response envelope to the agent.

1. Start with `repo.status`.
2. Use `sdl.context` for task-shaped explain, debug, review, and implement work.
   Its request is flat and requires `budget.maxTokens`; never send `options`,
   `contextMode`, or `answerFirst`.
3. Use `sdl.retrieve` for one card, slice, skeleton, hot path, or justified code
   window. When structured retrieval is unavailable, use a targeted, bounded `sdl.file { op: "read" }` fallback.
4. Use `sdl.workflow` for runtime execution, transforms, dependent calls, and
   batch mutations. Persist command output and query only needed failure lines.
   runtimeExecute executes repository tooling. Permitted uses include build,
   test, lint, compiler, named scripts, and targeted edit scripts. Do not use it
   to inspect, search, or print repository files. Use sdl.context or sdl.retrieve
   for indexed source and sdl.file with op="read" for other files. Do not guess
   `runtimeQueryOutput` arguments; replay a returned action unchanged or call
   focused `sdl.manual` for `runtime.queryOutput` first.
5. Read non-indexed files through `sdl.file`; use the same targeted, bounded read only when structured retrieval is unavailable for indexed source. Its targeted write operation can
   update one indexed file with live reconciliation; prefer symbol or
   search-edit preview/apply operations when they can anchor the change.
6. Keep `responseMode: "auto"` for potentially large results. When a result
   returns a canonical `response.get` continuation (`nextAction` or `action`) for
   `sdl.retrieve` with `op: "responseGet"`, replay its returned action and
   arguments unchanged; do not reconstruct it.
   Outer `repoId` owns trusted dispatch, and `detail`/`includeDiagnostics` stay
   outer `sdl.retrieve` controls. Nested `args` contains only artifact view and
   paging fields; nested `repoId` is invalid. Use workflow `responseGet` only
   when direct `sdl.retrieve` is unavailable or an existing multi-step workflow
   needs it.
7. Reuse refs and ETags. Set `refsMode: "off"` only for complete or byte-stable
   output.
8. Never call `index.refresh`, directly, through `sdl.workflow`, or via
   `sdl-mcp index`, without explicit user approval in the current turn. Dirty
   semantic flags, graph verification, parser-state/provenance warnings, and
   refresh recommendations are diagnostics, not approval. Do not wait for
   semantic freshness or verification unless the task requires latest-revision
   graph proof. Use an SDL file-based edit fallback after provenance failures.
9. Call usage statistics only when the user asks for token savings or telemetry.

Use [tool recipes](./references/tool-recipes.md) for exact v2 request shapes.
