import { getKuzuConn } from "../../db/kuzu.js";
import * as kuzuDb from "../../db/kuzu-queries.js";

import { isBuiltinCall } from "./builtins.js";

export async function cleanupUnresolvedEdges(repoId: string): Promise<void> {
  const conn = await getKuzuConn();
  const edges = await kuzuDb.getEdgesByRepo(conn, repoId);

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

    await kuzuDb.deleteEdge(conn, {
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      edgeType: "call",
    });
  }
}

