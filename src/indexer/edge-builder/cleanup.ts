import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";

import { isBuiltinCall } from "./builtins.js";

export async function cleanupUnresolvedEdges(repoId: string): Promise<void> {
  const conn = await getLadybugConn();
  const edges = await ladybugDb.getEdgesByRepo(conn, repoId);

  const candidates = edges.filter(
    (edge) =>
      edge.edgeType === "call" &&
      edge.toSymbolId.startsWith("unresolved:call:"),
  );

  for (const edge of candidates) {
    const rawTarget = edge.toSymbolId.slice("unresolved:call:".length);
    const lastIdentifier = rawTarget.split(".").pop() ?? rawTarget;
    if (!isBuiltinCall(lastIdentifier)) {
      continue;
    }

    await ladybugDb.deleteEdge(conn, {
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      edgeType: "call",
    });
  }
}

