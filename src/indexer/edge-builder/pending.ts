import { createEdgeTransaction } from "../../db/queries.js";

import { resolveSymbolIdFromIndex } from "./symbol-index.js";
import type { PendingCallEdge, SymbolIndex } from "./types.js";

export function resolvePendingCallEdges(
  pending: PendingCallEdge[],
  index: SymbolIndex,
  created: Set<string>,
  repoId: string,
): void {
  for (const edge of pending) {
    const toSymbolId = resolveSymbolIdFromIndex(
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

    createEdgeTransaction({
      repo_id: repoId,
      from_symbol_id: edge.fromSymbolId,
      to_symbol_id: toSymbolId,
      type: "call",
      weight: 1.0,
      confidence: edge.confidence ?? 1.0,
      resolution_strategy: edge.strategy ?? "heuristic",
      provenance: edge.provenance,
      created_at: new Date().toISOString(),
    });
    created.add(edgeKey);
  }
}

