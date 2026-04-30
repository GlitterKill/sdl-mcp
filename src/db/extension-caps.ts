/**
 * Extension capability state for LadybugDB (FTS / vector).
 *
 * Extracted from ladybug.ts so that both the DB pool init code and
 * the retrieval layer can read capabilities without a circular import.
 */

export interface ExtensionCapabilities {
  fts: boolean;
  vector: boolean;
  algo: boolean;
}

const extensionCapabilities: ExtensionCapabilities = {
  fts: false,
  vector: false,
  algo: false,
};

/**
 * Return which Kuzu extensions loaded successfully on the current connection pool.
 * Returns { fts: false, vector: false } if the pool has not been initialized
 * or if extensions are unavailable on this platform.
 */
export function getExtensionCapabilities(): ExtensionCapabilities {
  return { ...extensionCapabilities };
}

/**
 * Mark an extension as successfully loaded.
 * Called by the pool initialization code in ladybug.ts.
 */
export function markExtensionLoaded(ext: keyof ExtensionCapabilities): void {
  extensionCapabilities[ext] = true;
}

/**
 * Reset capabilities to { fts: false, vector: false }.
 * Called from closeLadybugDb() so state stays in sync when the pool is torn down.
 */
export function resetExtensionCapabilities(): void {
  extensionCapabilities.fts = false;
  extensionCapabilities.vector = false;
  extensionCapabilities.algo = false;
}
