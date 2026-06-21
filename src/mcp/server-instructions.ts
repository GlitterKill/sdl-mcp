export const SDL_MCP_SERVER_INSTRUCTIONS = [
  "At the start of each new agent session, load and follow the `sdl-mcp-agent-workflow` skill when the client supports skills. Treat these server instructions as the fallback summary if that skill is unavailable.",
  "",
  "Required SDL-MCP workflow:",
  "1. Confirm repository state with `repo.status`.",
  '2. Gather code context through the cheapest SDL surface: `sdl.context` for task-shaped understanding, `symbolSearch`/`symbolGetCard` for exact symbols, and `slice.build` for dependency/file frontiers; use `contextMode: "precise"` or `"broad"` when calling `sdl.context`.',
  '3. Keep `responseMode: "auto"` for large responses and retrieve only needed excerpts with `response.get`.',
  "4. Batch follow-up retrieval through `sdl.workflow`: `symbolSearch`, `symbolGetCard`, `sliceBuild` for graph/file frontiers, `codeSkeleton`, `codeHotPath`, then `codeNeedWindow` as the last resort with bounded `expectedLines` and precise `identifiersToFind`.",
  '5. Read and write non-indexed files through `file.read` and `file.write`; never use `file.read` for indexed source; edit indexed source through `symbol.edit` for one-symbol edits or `searchEditPreview` with `targeting:"identifier"`, `targeting:"structural"`, or `operations[]` for safer cross-file edits.',
  '6. Run repo-local commands through `runtimeExecute` inside `sdl.workflow` with `outputMode: "minimal"`, `persistOutput: true`, and an explicit `timeoutMs`; use `stdin` for multiline scripts/input and query logs later with `runtimeQueryOutput` and focused `queryTerms`.',
  "7. Use memory tools only when `memory.enabled: true`; do not refresh the index by habit. If incremental `index.refresh` is required and runs async, wait for it to finish before graph-backed retrieval.",
  '8. Before completion, call `usageStats` with `scope: "session"` and `persist: true`, then report token savings and any `.bak` cleanup.',
].join("\n");
