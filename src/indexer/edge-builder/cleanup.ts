import { withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";

import { isBuiltinCall } from "./builtins.js";

export async function cleanupUnresolvedEdges(repoId: string): Promise<void> {
  await withWriteConn(async (wConn) => {
    const candidates = await ladybugDb.getUnresolvedCallEdgesByRepo(wConn, repoId);
    const edgesToDelete = candidates.filter((edge) => {
      const rawTarget = edge.toSymbolId.slice("unresolved:call:".length);
      const lastIdentifier = rawTarget.split(".").pop() ?? rawTarget;
      return isBuiltinCall(lastIdentifier);
    });

    if (edgesToDelete.length === 0) {
      return;
    }

    await ladybugDb.withTransaction(wConn, async (txConn) => {
      await ladybugDb.deleteEdges(
        txConn,
        edgesToDelete.map((edge) => ({
          fromSymbolId: edge.fromSymbolId,
          toSymbolId: edge.toSymbolId,
          edgeType: "call",
        })),
      );
    });
  });
}

