import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";

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

        // UNWIND-batched W3/W4 rewrite (replaces per-row MERGE-rel loop —
        // missed by the 2026-05-02 sweep because the function name doesn't
        // match the *Batch audit pattern). Three passes per chunk:
        //   Pass A: ensure target Symbol node exists (defensive — the lookup
        //           pulled the symbolId from existing exports so it should
        //           already exist, but MERGE is cheap idempotent and matches
        //           the original behaviour).
        //   Pass B: ensure SYMBOL_IN_REPO via OPTIONAL-MATCH+CREATE — plain
        //           MERGE-rel inside UNWIND throws the "invalid
        //           unordered_map<K,T> key" runtime error in LadybugDB
        //           0.15.x–0.16.0 (kuzu#5685 family).
        //   Pass C: create DEPENDS_ON if missing.
        //   Pass D: update existing rel props, with a guard preserving any
        //           SCIP-written `resolution: "exact"` edges (SCIP and this
        //           phase write disjoint sets today, but the guard also
        //           dovetails with the same protection in `insertEdges`).
        const createdAt = new Date().toISOString();
        const allRows = pendingUpdates.map((u) => ({
          repoId,
          fromSymbolId: u.edge.fromSymbolId,
          toSymbolId: u.targetSymbolId,
          provenance: u.provenance,
          createdAt,
        }));
        const CHUNK = 256;
        for (let i = 0; i < allRows.length; i += CHUNK) {
          const chunk = allRows.slice(i, i + CHUNK);

          await ladybugDb.exec(
            txConn,
            `UNWIND $rows AS row
             MERGE (b:Symbol {symbolId: row.toSymbolId})`,
            { rows: chunk },
          );
          await ladybugDb.exec(
            txConn,
            `UNWIND $rows AS row
             MATCH (r:Repo {repoId: row.repoId})
             MATCH (b:Symbol {symbolId: row.toSymbolId})
             OPTIONAL MATCH (b)-[existing:SYMBOL_IN_REPO]->(r)
             WITH b, r, existing
             WHERE existing IS NULL
             CREATE (b)-[:SYMBOL_IN_REPO]->(r)`,
            { rows: chunk },
          );
          await ladybugDb.exec(
            txConn,
            `UNWIND $rows AS row
             MATCH (a:Symbol {symbolId: row.fromSymbolId})
             MATCH (b:Symbol {symbolId: row.toSymbolId})
             OPTIONAL MATCH (a)-[existing:DEPENDS_ON {edgeType: 'import'}]->(b)
             WITH a, b, row, existing
             WHERE existing IS NULL
             CREATE (a)-[:DEPENDS_ON {
               edgeType: 'import',
               weight: 0.6,
               confidence: 1.0,
               resolution: 're-resolved',
               resolverId: 'import-reresolution',
               resolutionPhase: 'pass2',
               provenance: row.provenance,
               createdAt: row.createdAt
             }]->(b)`,
            { rows: chunk },
          );
          await ladybugDb.exec(
            txConn,
            `UNWIND $rows AS row
             MATCH (a:Symbol {symbolId: row.fromSymbolId})
             MATCH (b:Symbol {symbolId: row.toSymbolId})
             MATCH (a)-[d:DEPENDS_ON {edgeType: 'import'}]->(b)
             WHERE d.resolution <> 'exact' OR d.confidence < 1.0
             SET d.weight = 0.6,
                 d.confidence = 1.0,
                 d.resolution = 're-resolved',
                 d.resolverId = 'import-reresolution',
                 d.resolutionPhase = 'pass2',
                 d.provenance = row.provenance`,
            { rows: chunk },
          );

          resolved += chunk.length;
          options?.onChunkComplete?.(resolved, allRows.length);
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
