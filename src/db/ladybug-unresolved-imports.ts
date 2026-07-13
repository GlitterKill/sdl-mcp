import type { Connection } from "kuzu";

import { exec, withTransaction } from "./ladybug-core.js";

export interface ResolvedImportEdgeRewriteRow {
  repoId: string;
  fromSymbolId: string;
  oldTargetSymbolId: string;
  toSymbolId: string;
  provenance: string;
  createdAt: string;
}

/** Replace unresolved import edges with their resolved graph relationships. */
export async function rewriteResolvedImportEdges(
  conn: Connection,
  rows: readonly ResolvedImportEdgeRewriteRow[],
  onChunkComplete?: (current: number, total: number) => void,
): Promise<number> {
  if (rows.length === 0) return 0;

  return withTransaction(conn, async (txConn) => {
    const oldTargetIds = [...new Set(rows.map((row) => row.oldTargetSymbolId))];
    await exec(
      txConn,
      `MATCH (a:Symbol)-[old:DEPENDS_ON]->(b:Symbol)
       WHERE old.edgeType = 'import' AND b.symbolId IN $oldTargetIds
       DELETE old`,
      { oldTargetIds },
    );

    let written = 0;
    const chunkSize = 256;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      await exec(
        txConn,
        `UNWIND $rows AS row
         MERGE (b:Symbol {symbolId: row.toSymbolId})`,
        { rows: chunk },
      );
      await exec(
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
      await exec(
        txConn,
        `UNWIND $rows AS row
         MATCH (a:Symbol {symbolId: row.fromSymbolId})
         MATCH (b:Symbol {symbolId: row.toSymbolId})
         OPTIONAL MATCH (a)-[existing:DEPENDS_ON {edgeType: 'import'}]->(b)
         WITH a, b, row, existing
         WHERE existing IS NULL
         CREATE (a)-[:DEPENDS_ON {
           edgeType: 'import', weight: 0.6, confidence: 1.0,
           resolution: 're-resolved', resolverId: 'import-reresolution',
           resolutionPhase: 'pass2', provenance: row.provenance,
           createdAt: row.createdAt
         }]->(b)`,
        { rows: chunk },
      );
      await exec(
        txConn,
        `UNWIND $rows AS row
         MATCH (a:Symbol {symbolId: row.fromSymbolId})
         MATCH (b:Symbol {symbolId: row.toSymbolId})
         MATCH (a)-[d:DEPENDS_ON {edgeType: 'import'}]->(b)
         WHERE d.resolution <> 'exact' OR d.confidence < 1.0
         SET d.weight = 0.6, d.confidence = 1.0,
             d.resolution = 're-resolved',
             d.resolverId = 'import-reresolution',
             d.resolutionPhase = 'pass2', d.provenance = row.provenance`,
        { rows: chunk },
      );
      written += chunk.length;
      onChunkComplete?.(written, rows.length);
    }
    return written;
  });
}
