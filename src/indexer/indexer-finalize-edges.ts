import type { PendingCallEdge, SymbolIndex } from "./edge-builder.js";
import { cleanupUnresolvedEdges, resolvePendingCallEdges } from "./edge-builder.js";
import type { ConfigEdge } from "./configEdges.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { withWriteConn } from "../db/ladybug.js";

type FinalizeEdgesPhaseMeasurer = <T>(
  phaseName: string,
  fn: () => Promise<T> | T,
) => Promise<T>;

/** Resolve pending call edges, clean up dangling edges, and persist config edges. */
export async function finalizeEdges(params: {
  repoId: string;
  pendingCallEdges: PendingCallEdge[];
  symbolIndex: SymbolIndex;
  createdCallEdges: Set<string>;
  allConfigEdges: ConfigEdge[];
  configEdgeWeight: number;
  measurePhase?: FinalizeEdgesPhaseMeasurer;
  onPlannedCallTargetCleanup?: (symbolIds: readonly string[]) => void;
}): Promise<{ configEdgesCreated: number }> {
  const {
    repoId,
    pendingCallEdges,
    symbolIndex,
    createdCallEdges,
    allConfigEdges,
    configEdgeWeight,
    measurePhase,
    onPlannedCallTargetCleanup,
  } = params;
  const measure =
    measurePhase ??
    (async <T>(_phaseName: string, fn: () => Promise<T> | T): Promise<T> =>
      await fn());

  await measure(
    "resolvePendingCalls",
    async () =>
      await resolvePendingCallEdges(
        pendingCallEdges,
        symbolIndex,
        createdCallEdges,
        repoId,
      ),
  );
  await measure(
    "cleanupUnresolvedBuiltins",
    async () =>
      await cleanupUnresolvedEdges(repoId, {
        onPlannedTargetCleanup: onPlannedCallTargetCleanup,
      }),
  );

  const now = new Date().toISOString();
  const configEdgesToInsert: ladybugDb.EdgeRow[] = allConfigEdges.map(
    (edge) => ({
      repoId,
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      edgeType: "config",
      weight: edge.weight ?? configEdgeWeight,
      confidence: 1.0,
      resolution: "exact",
      provenance: edge.provenance ?? "config",
      createdAt: now,
    }),
  );
  await measure(
    "insertConfigEdges",
    async () =>
      await withWriteConn(async (wConn) => {
        await ladybugDb.insertEdges(wConn, configEdgesToInsert);
      }),
  );
  return { configEdgesCreated: configEdgesToInsert.length };
}
