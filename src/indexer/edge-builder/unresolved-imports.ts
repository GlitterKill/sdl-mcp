import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { rewriteResolvedImportEdges } from "../../db/ladybug-unresolved-imports.js";

interface ResolveUnresolvedImportEdgesOptions {
  includeTimings?: boolean;
  affectedPaths?: Iterable<string>;
  /**
   * Per-chunk progress callback. Fires after each batch flush so the CLI can
   * draw a real bar instead of a stuck "Import re-resolution..." line. The
   * counter walks `pendingUpdates.length` (resolvable edges), not
   * `unresolvedImports.length` (initial scan), since the post-DELETE write
   * pass is the dominant cost.
   */
  onChunkComplete?: (current: number, total: number) => void;
}

interface ResolveUnresolvedImportEdgesResult {
  resolved: number;
  total: number;
  timings?: Record<string, number>;
}

async function resolveUnresolvedImportEdges(
  repoId: string,
  options?: ResolveUnresolvedImportEdgesOptions,
): Promise<ResolveUnresolvedImportEdgesResult> {
  const timings: Record<string, number> | null = options?.includeTimings
    ? {}
    : null;
  // Keep sub-phase timing opt-in for normal indexing runs.
  const measure = async <T>(
    phaseName: string,
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    if (!timings) {
      return await fn();
    }
    const start = Date.now();
    try {
      return await fn();
    } finally {
      timings[phaseName] = Date.now() - start;
    }
  };

  const conn = await getLadybugConn();
  const affectedPaths = options?.affectedPaths
    ? Array.from(new Set(options.affectedPaths))
    : [];
  const unresolvedImports = await measure("fetchEdges", () =>
    ladybugDb.getUnresolvedImportEdgesByRepo(conn, repoId, {
      affectedPaths,
    }),
  );
  // Keep the diagnostics shape stable even though the DB query now pre-filters
  // unresolved import candidates for us.
  await measure("collectCandidates", () => unresolvedImports.length);

  if (unresolvedImports.length === 0) {
    return { resolved: 0, total: 0, timings: timings ?? undefined };
  }

  type ParsedEdge = {
    edge: (typeof unresolvedImports)[number];
    filePath: string;
    symbolName: string;
  };
  const parsed: ParsedEdge[] = [];
  for (const edge of unresolvedImports) {
    const raw = edge.toSymbolId;
    const withoutPrefix = raw.slice("unresolved:".length);
    const lastColon = withoutPrefix.lastIndexOf(":");
    if (lastColon === -1) continue;
    const filePath = withoutPrefix.substring(0, lastColon);
    const symbolName = withoutPrefix.substring(lastColon + 1);
    if (!filePath || !symbolName) continue;
    // Namespace imports cannot resolve to a single symbol target.
    if (symbolName.startsWith("* as ")) continue;
    parsed.push({ edge, filePath, symbolName });
  }

  if (parsed.length === 0) {
    return {
      resolved: 0,
      total: unresolvedImports.length,
      timings: timings ?? undefined,
    };
  }

  const pendingUpdates: Array<{
    edge: (typeof unresolvedImports)[number];
    targetSymbolId: string;
    provenance: string;
  }> = [];

  await measure("lookupTargets", async () => {
    // Resolve all target candidates in two batched read queries instead of
    // a sequential per-edge round-trip:
    //   1. relPath -> fileId for every distinct imported file.
    //   2. fileId -> { exportedName -> symbolId } for every resolved file.
    const uniqueRelPaths = Array.from(new Set(parsed.map((p) => p.filePath)));

    const fileIdByRelPath = await ladybugDb.getFileIdsByRepoPaths(
      conn,
      repoId,
      uniqueRelPaths,
    );
    if (fileIdByRelPath.size === 0) return;

    const fileIds = Array.from(new Set(fileIdByRelPath.values()));
    const symbolsByFile = await ladybugDb.getExportedSymbolsLiteByFileIds(
      conn,
      fileIds,
    );

    for (const entry of parsed) {
      const fileId = fileIdByRelPath.get(entry.filePath);
      if (!fileId) continue;
      const targetSymbolId = symbolsByFile
        .get(fileId)
        ?.find((symbol) => symbol.name === entry.symbolName)?.symbolId;
      if (!targetSymbolId) continue;
      pendingUpdates.push({
        edge: entry.edge,
        targetSymbolId,
        // Truthy fallback (not nullish): UNWIND-batched writes coerce nullable
        // STRING to '' to dodge the kuzu binder ANY-type bug, so '' must also
        // trigger the import-prefix synthesis.
        provenance: entry.edge.provenance || `import:${entry.symbolName}`,
      });
    }
  });

  let resolved = 0;
  await measure("rewriteEdges", async () => {
    if (pendingUpdates.length === 0) return;
    await withWriteConn(async (wConn) => {
      const createdAt = new Date().toISOString();
      resolved = await rewriteResolvedImportEdges(
        wConn,
        pendingUpdates.map((update) => ({
          repoId,
          fromSymbolId: update.edge.fromSymbolId,
          oldTargetSymbolId: update.edge.toSymbolId,
          toSymbolId: update.targetSymbolId,
          provenance: update.provenance,
          createdAt,
        })),
        options?.onChunkComplete,
      );
    });
  });

  return {
    resolved,
    total: unresolvedImports.length,
    timings: timings ?? undefined,
  };
}

export { resolveUnresolvedImportEdges };
