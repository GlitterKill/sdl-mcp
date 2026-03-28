export const MANUAL_DESCRIPTION =
  "Returns the SDL-MCP API manual — a compact TypeScript reference listing all " +
  "available functions, their parameters, and return types. Call once per session " +
  "to learn the API before using sdl.chain.";

export const CHAIN_DESCRIPTION =
  "Execute a chain of SDL-MCP operations in a single round-trip. Best for multi-step operations (runtime execution, data transforms, batch mutations) — for code context retrieval, prefer sdl.agent.orchestrate. Each step calls " +
  "a function from the API manual or an internal transform (dataPick, dataMap, " +
  "dataFilter, dataSort, dataTemplate). Use $N references (e.g., $0.symbols[0].symbolId) " +
  "to pass results between steps. Includes budget tracking, context-ladder validation, " +
  "cross-step ETag caching, and opt-in execution tracing.";

export const ACTION_SEARCH_DESCRIPTION =
  "Search for SDL-MCP actions by keyword. Returns ranked matches with optional " +
  "schema summaries and examples. Use this as the first discovery step before " +
  "loading the full manual or building chains.";
