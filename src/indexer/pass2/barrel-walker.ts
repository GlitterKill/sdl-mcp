/**
 * Shared barrel / re-export walker (Phase 2 Task 2.0.2).
 *
 * Several pass-2 resolvers reimplement variants of: "follow `import x
 * from './foo'` then if `./foo` re-exports `x` from `./bar`, follow to
 * `./bar`". This module factors that walk into a generic chain follower
 * with per-language hooks supplied by the import-resolution adapters.
 *
 * Languages currently expected to plug into this:
 *   - Python (`__init__.py` re-exports)
 *   - Java/Kotlin (rare, but `re-export via wildcard`)
 *   - C# (`global using`)
 *   - PHP (group `use` statements)
 *   - Rust (`pub use`)
 *
 * Cycle detection is bounded by `MAX_BARREL_DEPTH` to prevent infinite
 * loops on intentionally circular module graphs (every language allows
 * those at least syntactically).
 */

/**
 * Maximum number of re-export hops the walker will follow before giving
 * up. 8 is enough for any sane project structure and short enough that
 * a malformed graph cannot stall indexing.
 */
export const MAX_BARREL_DEPTH = 8;

/**
 * A single re-export edge: "the symbol named `exportedName` is exported
 * by `fromFile` but its real definition lives in `targetFile` under the
 * name `targetName` (often equal to `exportedName`)".
 */
export interface ReExport {
  exportedName: string;
  targetFile: string;
  targetName: string;
}

/**
 * Per-language hooks supplied by the import-resolution adapter. The
 * walker is generic over how a file's re-exports are read; languages
 * with no re-export concept should plug in a hook that always returns
 * an empty array.
 */
export interface BarrelHooks {
  /** Returns the re-export edges declared by `file`. */
  getReExports(file: string): ReExport[];
}

/**
 * Result of following a barrel chain. `depth` is the number of hops
 * actually followed; `null` is returned when the symbol cannot be
 * resolved either because no re-export matched or because the chain
 * exceeded `MAX_BARREL_DEPTH`.
 */
export interface BarrelResolution {
  resolvedFile: string;
  resolvedName: string;
  depth: number;
  visited: readonly string[];
}

/**
 * Follows a barrel chain starting at `startFile`, looking for the
 * symbol named `symbolName`. At each hop the walker asks the language
 * hook for the re-exports of the current file and follows the matching
 * one. Stops when no more re-exports match (the chain has terminated
 * at a real definition file) or when `MAX_BARREL_DEPTH` is reached.
 */
export function followBarrelChain(
  symbolName: string,
  startFile: string,
  hooks: BarrelHooks,
): BarrelResolution | null {
  const visited = new Set<string>();
  const trail: string[] = [];

  let currentFile = startFile;
  let currentName = symbolName;

  for (let depth = 0; depth <= MAX_BARREL_DEPTH; depth++) {
    if (visited.has(currentFile)) {
      // Cycle detected; return what we have so far so the caller can
      // still record an edge to the last good hop.
      if (depth === 0) {
        return null;
      }
      return {
        resolvedFile: currentFile,
        resolvedName: currentName,
        depth,
        visited: trail,
      };
    }
    visited.add(currentFile);
    trail.push(currentFile);

    const reExports = hooks.getReExports(currentFile);
    const match = reExports.find((re) => re.exportedName === currentName);
    if (!match) {
      if (depth === 0) {
        // The starting file has no re-export matching `symbolName`,
        // which means there is nothing to follow. Caller should fall
        // back to its normal resolution path.
        return null;
      }
      return {
        resolvedFile: currentFile,
        resolvedName: currentName,
        depth,
        visited: trail,
      };
    }

    currentFile = match.targetFile;
    currentName = match.targetName;
  }

  // Hit the depth limit. Push the final hop into the trail so the
  // returned `visited` always includes `resolvedFile` (consistent with
  // the normal-termination paths above), then return the last good hop
  // so the caller can record an attributed (if low-confidence) edge.
  if (!visited.has(currentFile)) {
    visited.add(currentFile);
    trail.push(currentFile);
  }
  return {
    resolvedFile: currentFile,
    resolvedName: currentName,
    depth: MAX_BARREL_DEPTH,
    visited: trail,
  };
}

/**
 * Builds barrel hooks from a flat re-export map keyed by file path.
 * Convenience for adapters that already produce a per-file map of
 * re-exports during Pass-1 (e.g. Python `__init__.py` parsing).
 */
export function hooksFromMap(
  reExportsByFile: ReadonlyMap<string, readonly ReExport[]>,
): BarrelHooks {
  return {
    getReExports(file: string): ReExport[] {
      const list = reExportsByFile.get(file);
      return list ? [...list] : [];
    },
  };
}

/**
 * Convenience for testing: builds barrel hooks from an inline object
 * literal. Not intended for production callers.
 */
export function hooksFromObjectForTesting(
  reExports: Record<string, ReExport[]>,
): BarrelHooks {
  return {
    getReExports(file: string): ReExport[] {
      return reExports[file] ?? [];
    },
  };
}
