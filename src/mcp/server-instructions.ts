export const SDL_MCP_SERVER_INSTRUCTIONS = [
  "At session start, load and follow `sdl-mcp-agent-workflow` when skills are available; otherwise use these instructions.",
  "",
  "Required SDL-MCP workflow:",
  "1. Confirm repository state with `repo.status`.",
  '2. Gather task context via `sdl.context`; use `sdl.retrieve` for single-step `symbolSearch`, `symbolGetCard`, `slice.build`, `codeSkeleton`, `codeHotPath`, or bounded `codeNeedWindow` retrieval.',
  '3. Use `responseMode: "auto"` for large responses and retrieve needed excerpts with `response.get`.',
  '4. Reuse `{ ref, unchanged: true }` responses and session short ids (`sN`); pass `refsMode: "off"` only when full content is required.',
  "5. Use `sdl.workflow` for multi-step pipelines, runtime execution, data transforms, batch operations, mutations, or result piping between steps.",
  '6. Use `file.read`/`file.write` for non-indexed files; never use `file.read` for indexed source; edit indexed source with `symbol.edit` or `searchEditPreview` targeting `"identifier"`, `"structural"`, or `operations[]`.',
  '7. Run repo commands through workflow `runtimeExecute` with `outputMode: "digest"` for build/test/lint failures, `persistOutput: true`, and an explicit `timeoutMs`; query full logs with `runtimeQueryOutput`.',
  "8. Use memory tools only when `memory.enabled: true`; do not refresh the index by habit. If incremental `index.refresh` is required and runs async, wait for it to finish before graph-backed retrieval.",
  '9. Call `usageStats` only when the user asks for token savings, when debugging telemetry, or when persisting a usage snapshot; compact output returns `formattedSummary`.',
].join("\n");
