import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";

interface ResolveUnresolvedImportEdgesOptions {
  includeTimings?: boolean;
  affectedPaths?: Iterable<string>;
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

  let resolved = 0;
  const fileCache = new Map<
    string,
    Awaited<ReturnType<typeof ladybugDb.getFileByRepoPath>>
  >();
  const symbolCache = new Map<
    string,
    Awaited<ReturnType<typeof ladybugDb.getSymbolsByFile>>
  >();
  const pendingUpdates: Array<{
    edge: (typeof unresolvedImports)[number];
    targetSymbolId: string;
    provenance: string;
  }> = [];

  await measure("lookupTargets", async () => {
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

      let file = fileCache.get(filePath);
      if (!fileCache.has(filePath)) {
        file = await ladybugDb.getFileByRepoPath(conn, repoId, filePath);
        fileCache.set(filePath, file);
      }
      if (!file) continue;

      let symbols = symbolCache.get(file.fileId);
      if (!symbols) {
        symbols = await ladybugDb.getSymbolsByFile(conn, file.fileId);
        symbolCache.set(file.fileId, symbols);
      }

      const target = symbols.find(
        (symbol) => symbol.name === symbolName && symbol.exported,
      );
      if (!target) {
        if (symbolName === "default" || symbolName === "*") continue;
        const anyMatch = symbols.find((symbol) => symbol.name === symbolName);
        if (!anyMatch) continue;
        continue;
      }

      pendingUpdates.push({
        edge,
        targetSymbolId: target.symbolId,
        provenance: edge.provenance ?? `import:${symbolName}`,
      });
    }
  });

  await measure("rewriteEdges", async () => {
    if (pendingUpdates.length === 0) return;
    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        for (const update of pendingUpdates) {
          await ladybugDb.deleteEdge(txConn, {
            fromSymbolId: update.edge.fromSymbolId,
            toSymbolId: update.edge.toSymbolId,
            edgeType: "import",
          });

          await ladybugDb.insertEdge(txConn, {
            repoId,
            fromSymbolId: update.edge.fromSymbolId,
            toSymbolId: update.targetSymbolId,
            edgeType: "import",
            weight: 0.6,
            confidence: 1.0,
            resolution: "re-resolved",
            resolverId: "import-reresolution",
            resolutionPhase: "pass2",
            provenance: update.provenance,
            createdAt: new Date().toISOString(),
          });

          resolved++;
        }
      });
    });
  });

  return {
    resolved,
    total: unresolvedImports.length,
    timings: timings ?? undefined,
  };
}

export { resolveUnresolvedImportEdges };
