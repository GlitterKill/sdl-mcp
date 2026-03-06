import { getKuzuConn } from "../../db/kuzu.js";
import * as kuzuDb from "../../db/kuzu-queries.js";

import { resolveSymbolIdFromIndex } from "./symbol-index.js";
import type { PendingCallEdge, SymbolIndex } from "./types.js";

export async function resolvePendingCallEdges(
  pending: PendingCallEdge[],
  index: SymbolIndex,
  created: Set<string>,
  repoId: string,
): Promise<void> {
  const conn = await getKuzuConn();
  const now = new Date().toISOString();
  const edgesToInsert: kuzuDb.EdgeRow[] = [];

  for (const edge of pending) {
    const toSymbolId = await resolveSymbolIdFromIndex(
      index,
      repoId,
      edge.toFile,
      edge.toName,
      edge.toKind,
      edge.callerLanguage,
    );
    if (!toSymbolId) {
      continue;
    }

    const edgeKey = `${edge.fromSymbolId}->${toSymbolId}`;
    if (created.has(edgeKey)) {
      continue;
    }

    edgesToInsert.push({
      repoId,
      fromSymbolId: edge.fromSymbolId,
      toSymbolId,
      edgeType: "call",
      weight: 1.0,
      confidence: edge.confidence ?? 1.0,
      resolution: edge.strategy ?? "heuristic",
      resolverId: "pass1-generic",
      resolutionPhase: "pass1",
      provenance: edge.provenance ?? null,
      createdAt: now,
    });
    created.add(edgeKey);
  }

  await kuzuDb.insertEdges(conn, edgesToInsert);
}
