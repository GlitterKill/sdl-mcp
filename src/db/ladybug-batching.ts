export const LADYBUG_WRITE_CHUNK_SIZE_LIMIT = 4096;

export const LADYBUG_WRITE_CHUNK_SIZES = {
  edges: 4096,
  symbolReferences: 4096,
  files: 4096,
  symbolVersions: 4096,
  // Symbol rows carry the largest JSON/searchText payloads, so keep the
  // previous conservative chunk size until profiling shows it is the hotspot.
  symbols: 256,
} as const;

export type LadybugWriteBatchKind = keyof typeof LADYBUG_WRITE_CHUNK_SIZES;

export interface LadybugWriteChunkOptions {
  chunkSize?: number;
}

export function resolveLadybugWriteChunkSize(
  kind: LadybugWriteBatchKind,
  chunkSize?: number,
): number {
  const fallback = LADYBUG_WRITE_CHUNK_SIZES[kind];
  if (chunkSize === undefined) {
    return fallback;
  }
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > LADYBUG_WRITE_CHUNK_SIZE_LIMIT
  ) {
    throw new RangeError(
      `${kind} chunkSize must be an integer between 1 and ${LADYBUG_WRITE_CHUNK_SIZE_LIMIT}`,
    );
  }
  return chunkSize;
}
