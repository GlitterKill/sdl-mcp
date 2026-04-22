export const MANUAL_DESCRIPTION =
  "Returns the SDL-MCP API manual - a compact TypeScript reference listing all "
  + "available functions, their parameters, and return types. Call once per "
  + "session to learn the API before using sdl.context or sdl.workflow.";

export const WORKFLOW_DESCRIPTION =
  "Execute a workflow of SDL-MCP operations in a single round-trip. Best for "
  + "multi-step operations (runtime execution, data transforms, batch mutations) "
  + "- for code context retrieval, prefer sdl.context. Each "
  + "step calls a function from the API manual or an internal transform "
  + "(dataPick, dataMap, dataFilter, dataSort, dataTemplate). Use $N references "
  + "(e.g., $0.results[0].symbolId) to pass results "
  + "between steps. Includes budget tracking, context-ladder validation, "
  + "cross-step ETag caching, and opt-in execution tracing.";

export const CONTEXT_DESCRIPTION =
  "Retrieve task-shaped code context for explain, debug, review, or implement "
  + "work. This is the Code Mode equivalent of sdl.context and should be "
  + "preferred over sdl.workflow for context retrieval.";

export const ACTION_SEARCH_DESCRIPTION =
  "Search for SDL-MCP actions by keyword. Returns ranked matches with optional "
  + "schema summaries and examples. Use this as the first discovery step before "
  + "loading the full manual or choosing between sdl.context and sdl.workflow.";

export const FILE_GATEWAY_DESCRIPTION =
  "Unified file I/O gateway. op:\"read\" reads non-indexed files (configs, docs, "
  + "templates). op:\"write\" writes a single file with targeted modes (line replace, "
  + "pattern replace, JSON path, insert, append). op:\"searchEditPreview\" returns a "
  + "planHandle summarizing proposed cross-file edits; op:\"searchEditApply\" executes "
  + "the plan with sha256/mtime preconditions and rollback on mid-batch failure.";
