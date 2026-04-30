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

    const fileRows = await ladybugDb.queryAll<{
      relPath: string;
      fileId: string;
    }>(
      conn,
      `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
       WHERE f.relPath IN $relPaths
       RETURN f.relPath AS relPath, f.fileId AS fileId`,
      { repoId, relPaths: uniqueRelPaths },
    );
    const fileIdByRelPath = new Map<string, string>();
    for (const row of fileRows) {
      fileIdByRelPath.set(row.relPath, row.fileId);
    }
    if (fileIdByRelPath.size === 0) return;

    const fileIds = Array.from(new Set(fileIdByRelPath.values()));
    const symbolRows = await ladybugDb.queryAll<{
      fileId: string;
      name: string;
      symbolId: string;
    }>(
      conn,
      `MATCH (f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)
       WHERE f.fileId IN $fileIds AND s.exported = true
       RETURN f.fileId AS fileId, s.name AS name, s.symbolId AS symbolId`,
      { fileIds },
    );
    const exportedByFile = new Map<string, Map<string, string>>();
    for (const row of symbolRows) {
      let inner = exportedByFile.get(row.fileId);
      if (!inner) {
        inner = new Map<string, string>();
        exportedByFile.set(row.fileId, inner);
      }
      // First exported match wins (mirrors the prior Array.find semantics).
      if (!inner.has(row.name)) {
        inner.set(row.name, row.symbolId);
      }
    }

    for (const entry of parsed) {
      const fileId = fileIdByRelPath.get(entry.filePath);
      if (!fileId) continue;
      const symbolMap = exportedByFile.get(fileId);
      if (!symbolMap) continue;
      const targetSymbolId = symbolMap.get(entry.symbolName);
      if (!targetSymbolId) continue;
      pendingUpdates.push({
        edge: entry.edge,
        targetSymbolId,
        provenance: entry.edge.provenance ?? `import:${entry.symbolName}`,
      });
    }
  });

  let resolved = 0;
  await measure("rewriteEdges", async () => {
    if (pendingUpdates.length === 0) return;
    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        // Batched DELETE: every "unresolved:" Symbol exists solely as an
        // import placeholder, so dropping every import edge whose target is
        // in our resolved old-target set is equivalent to per-(from,to)
        // deletes. Any source that was not in pendingUpdates would still
        // share the same lookup outcome (lookup is by oldTo only), so it is
        // already represented in pendingUpdates and gets re-inserted below.
        const oldTargetIds = Array.from(
          new Set(pendingUpdates.map((u) => u.edge.toSymbolId)),
        );
        await ladybugDb.exec(
          txConn,
          `MATCH (a:Symbol)-[old:DEPENDS_ON]->(b:Symbol)
           WHERE old.edgeType = 'import' AND b.symbolId IN $oldTargetIds
           DELETE old`,
          { oldTargetIds },
        );

        // Re-insert in a loop: LadybugDB does not support UNWIND for
        // parameterized batch MERGE on relationships. The transaction
        // amortizes commit overhead across all writes.
        const createdAt = new Date().toISOString();
        for (const update of pendingUpdates) {
          await ladybugDb.exec(
            txConn,
            `MATCH (r:Repo {repoId: $repoId})
             MATCH (a:Symbol {symbolId: $fromSymbolId})
             MERGE (b:Symbol {symbolId: $toSymbolId})
             MERGE (b)-[:SYMBOL_IN_REPO]->(r)
             MERGE (a)-[d:DEPENDS_ON {edgeType: 'import'}]->(b)
             SET d.weight = 0.6,
                 d.confidence = 1.0,
                 d.resolution = 're-resolved',
                 d.resolverId = 'import-reresolution',
                 d.resolutionPhase = 'pass2',
                 d.provenance = $provenance,
                 d.createdAt = CASE WHEN d.createdAt IS NOT NULL THEN d.createdAt ELSE $createdAt END`,
            {
              repoId,
              fromSymbolId: update.edge.fromSymbolId,
              toSymbolId: update.targetSymbolId,
              provenance: update.provenance,
              createdAt,
            },
          );
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
