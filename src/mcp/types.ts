/**
 * Barrel re-export from domain layer.
 *
 * All domain types now live in src/domain/types.ts.
 * This file re-exports everything for backward compatibility.
 *
 * CRITICAL: Uses 'export *' (NOT 'export type *') because domain/types.ts
 * contains 6 runtime values (4 functions, 2 consts) that are imported
 * as runtime dependencies by src/graph/slice.ts and
 * src/graph/slice/slice-serializer.ts.
 */
export * from "../domain/types.js";
