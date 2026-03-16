export const MANUAL_DESCRIPTION =
  "Returns the SDL-MCP API manual — a compact TypeScript reference listing all " +
  "available functions, their parameters, and return types. Call once per session " +
  "to learn the API before using sdl.chain.";

export const CHAIN_DESCRIPTION =
  "Execute a chain of SDL-MCP operations in a single round-trip. Each step calls " +
  "a function from the API manual. Use $N references (e.g., $0.symbols[0].symbolId) " +
  "to pass results between steps. Includes budget tracking, context-ladder validation, " +
  "and cross-step ETag caching.";
