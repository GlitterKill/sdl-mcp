import type { Connection } from "kuzu";
import {
  batchGetSemanticEdges,
  batchMergeSemanticEdges,
  batchReplaceSemanticEdgeTargets,
  getSemanticSymbolRangesByPath,
  mergeSemanticDiagnostics,
  mergeSemanticPrecisionMetric,
  mergeSemanticProviderRun,
  type SemanticEdgeWriteRow,
  type SemanticExistingEdge,
  type SemanticSymbolRangeRow,
} from "../db/ladybug-semantic.js";
import { withTransaction } from "../db/ladybug-core.js";
import type {
  SemanticEdge,
  SemanticIndex,
  SemanticPrecisionInputs,
  SemanticProviderRun,
} from "./types.js";
import { buildSemanticPrecisionMetric } from "./precision.js";
import { normalizeSemanticIndexPaths } from "./index-utils.js";

export interface SemanticWriteResult {
  run: SemanticProviderRun;
  edgesCreated: number;
  edgesUpgraded: number;
  edgesReplaced: number;
  edgesSkipped: number;
  unresolvedEdges: number;
}

export interface SemanticWriteOptions {
  dryRun?: boolean;
  precision?: Partial<SemanticPrecisionInputs>;
  extraEdgesSkipped?: number;
}

export type SemanticEdgeAction = "create" | "upgrade" | "replace" | "skip";

export function classifySemanticEdgeAction(
  existingEdge: SemanticExistingEdge | null,
  newEdge: SemanticEdge,
): SemanticEdgeAction {
  if (!existingEdge) return "create";

  const sameTarget = existingEdge.targetSymbolId === newEdge.targetSymbolId;
  const stronger =
    existingEdge.confidence < newEdge.confidence ||
    (existingEdge.confidence === newEdge.confidence &&
      existingEdge.resolution !== newEdge.resolution);

  if (sameTarget && stronger) return "upgrade";
  if (
    !sameTarget &&
    (existingEdge.resolution === "heuristic" ||
      existingEdge.resolution === "unresolved")
  ) {
    return "replace";
  }
  return "skip";
}

export async function writeSemanticIndex(
  conn: Connection,
  index: SemanticIndex,
  options: SemanticWriteOptions = {},
): Promise<SemanticWriteResult> {
  const normalizedIndex = normalizeSemanticIndexPaths(index);
  const startedAt = new Date().toISOString();
  const languages = [
    ...new Set(normalizedIndex.documents.map((doc) => doc.languageId)),
  ];
  const endpointResolution = await resolveSemanticEdgeEndpoints(
    conn,
    normalizedIndex,
  );
  const runnableEdges = endpointResolution.edges.filter(hasSdlEndpoints);
  const unresolvedEdges =
    endpointResolution.edges.length - runnableEdges.length;
  const existingEdges = await batchGetSemanticEdges(
    conn,
    [
      ...runnableEdges.map((edge) => ({
        sourceId: edge.sourceSymbolId,
        targetId: edge.targetSymbolId,
        edgeType: edge.edgeType,
      })),
      ...runnableEdges
        .filter((edge) => edge.replaceTargetSymbolId)
        .map((edge) => ({
          sourceId: edge.sourceSymbolId,
          targetId: edge.replaceTargetSymbolId!,
          edgeType: edge.edgeType,
        })),
    ],
  );
  const toMerge: SemanticEdgeWriteRow[] = [];
  const toReplace: (SemanticEdgeWriteRow & { oldTargetId: string })[] = [];
  let edgesCreated = 0;
  let edgesUpgraded = 0;
  let edgesReplaced = 0;
  let edgesSkipped = 0;

  for (const edge of runnableEdges) {
    const key = edgeKey(
      edge.sourceSymbolId,
      edge.targetSymbolId,
      edge.edgeType,
    );
    const replacementKey = edge.replaceTargetSymbolId
      ? edgeKey(edge.sourceSymbolId, edge.replaceTargetSymbolId, edge.edgeType)
      : null;
    const existing =
      existingEdges.get(key) ??
      (replacementKey ? existingEdges.get(replacementKey) : undefined) ??
      null;
    const action = classifySemanticEdgeAction(existing, edge);
    const row = toWriteRow(edge);
    if (action === "create") {
      edgesCreated++;
      toMerge.push(row);
    } else if (action === "upgrade") {
      edgesUpgraded++;
      toMerge.push(row);
    } else if (action === "replace" && existing) {
      edgesReplaced++;
      toReplace.push({ ...row, oldTargetId: existing.targetSymbolId });
    } else {
      edgesSkipped++;
    }
  }

  const precisionInputs = buildPrecisionInputs(normalizedIndex, {
    resolvedEdges: runnableEdges.length,
    totalEdges: endpointResolution.edges.length,
    symbolsMatched: endpointResolution.symbolsMatched,
    symbolsTotal: normalizedIndex.symbols.length,
    diagnosticsAvailable: normalizedIndex.diagnostics.length > 0,
    ...options.precision,
  });
  const precisionMetric = buildSemanticPrecisionMetric({
    id: `${normalizedIndex.runId}:${languages.join(",") || "unknown"}`,
    repoId: normalizedIndex.repoId,
    runId: normalizedIndex.runId,
    languageId: languages.join(",") || "unknown",
    providerType: normalizedIndex.providerType,
    providerId: normalizedIndex.providerId,
    inputs: precisionInputs,
  });

  const run: SemanticProviderRun = {
    runId: normalizedIndex.runId,
    repoId: normalizedIndex.repoId,
    providerType: normalizedIndex.providerType,
    providerId: normalizedIndex.providerId,
    providerVersion: normalizedIndex.providerVersion,
    languages,
    sourceIndexPath: normalizedIndex.sourceIndexPath,
    status: options.dryRun ? "planned" : "completed",
    startedAt,
    finishedAt: new Date().toISOString(),
    documentsProcessed: normalizedIndex.documents.length,
    symbolsMatched: precisionInputs.symbolsMatched,
    edgesCreated,
    edgesUpgraded,
    edgesReplaced,
    edgesSkipped: edgesSkipped + unresolvedEdges + (options.extraEdgesSkipped ?? 0),
    diagnosticsCount: normalizedIndex.diagnostics.length,
    precisionScore: precisionMetric.score,
  };

  if (!options.dryRun) {
    await withTransaction(conn, async (txConn) => {
      await batchMergeSemanticEdges(txConn, toMerge);
      await batchReplaceSemanticEdgeTargets(txConn, toReplace);
      await mergeSemanticDiagnostics(txConn, normalizedIndex.diagnostics);
      await mergeSemanticPrecisionMetric(txConn, precisionMetric);
      await mergeSemanticProviderRun(txConn, run);
    });
  }

  return {
    run,
    edgesCreated,
    edgesUpgraded,
    edgesReplaced,
    edgesSkipped,
    unresolvedEdges,
  };
}

function edgeKey(sourceId: string, targetId: string, edgeType: string): string {
  return `${sourceId}\0${targetId}\0${edgeType}`;
}

async function resolveSemanticEdgeEndpoints(
  conn: Connection,
  index: SemanticIndex,
): Promise<{ edges: SemanticEdge[]; symbolsMatched: number }> {
  const providerToSdl = new Map<string, string>();
  for (const symbol of index.symbols) {
    if (symbol.sdlSymbolId) {
      providerToSdl.set(symbol.providerSymbolId, symbol.sdlSymbolId);
    }
  }

  const paths = [
    ...new Set(
      index.symbols
        .map((symbol) => symbol.sourcePath)
        .filter((path): path is string => Boolean(path)),
    ),
  ];
  const sdlSymbolsByPath = await getSdlSymbolsByPath(conn, index.repoId, paths);

  for (const symbol of index.symbols) {
    if (
      !symbol.sourcePath ||
      !symbol.range ||
      providerToSdl.has(symbol.providerSymbolId)
    ) {
      continue;
    }
    const matched = findContainingSdlSymbol(
      symbol.range.startLine + 1,
      sdlSymbolsByPath.get(symbol.sourcePath) ?? [],
    );
    if (matched) {
      providerToSdl.set(symbol.providerSymbolId, matched.symbolId);
    }
  }

  const edges = index.edges.map((edge) => ({
    ...edge,
    sourceSymbolId:
      edge.sourceSymbolId ??
      (edge.sourceProviderSymbolId
        ? providerToSdl.get(edge.sourceProviderSymbolId)
        : undefined),
    targetSymbolId:
      edge.targetSymbolId ??
      (edge.targetProviderSymbolId
        ? providerToSdl.get(edge.targetProviderSymbolId)
        : undefined),
  }));

  return { edges, symbolsMatched: providerToSdl.size };
}

async function getSdlSymbolsByPath(
  conn: Connection,
  repoId: string,
  relPaths: readonly string[],
): Promise<Map<string, SemanticSymbolRangeRow[]>> {
  if (relPaths.length === 0) return new Map();
  const rows = await getSemanticSymbolRangesByPath(conn, repoId, relPaths);

  const byPath = new Map<string, SemanticSymbolRangeRow[]>();
  for (const row of rows) {
    const bucket = byPath.get(row.relPath) ?? [];
    bucket.push(row);
    byPath.set(row.relPath, bucket);
  }
  return byPath;
}

function findContainingSdlSymbol(
  oneBasedLine: number,
  symbols: readonly SemanticSymbolRangeRow[],
): SemanticSymbolRangeRow | null {
  let best: SemanticSymbolRangeRow | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const symbol of symbols) {
    if (
      oneBasedLine >= symbol.rangeStartLine &&
      oneBasedLine <= symbol.rangeEndLine
    ) {
      const span = symbol.rangeEndLine - symbol.rangeStartLine;
      if (span < bestSpan) {
        best = symbol;
        bestSpan = span;
      }
    }
  }
  return best;
}

function hasSdlEndpoints(
  edge: SemanticEdge,
): edge is SemanticEdge & { sourceSymbolId: string; targetSymbolId: string } {
  return Boolean(edge.sourceSymbolId && edge.targetSymbolId);
}

function toWriteRow(
  edge: SemanticEdge & { sourceSymbolId: string; targetSymbolId: string },
): SemanticEdgeWriteRow {
  return {
    sourceSymbolId: edge.sourceSymbolId,
    targetSymbolId: edge.targetSymbolId,
    edgeType: edge.edgeType,
    confidence: edge.confidence,
    resolution: edge.resolution,
    resolverId: edge.resolverId,
    resolutionPhase: edge.resolutionPhase,
    provenance: JSON.stringify(edge.provenance),
  };
}

function buildPrecisionInputs(
  index: SemanticIndex,
  overrides: Partial<SemanticPrecisionInputs>,
): SemanticPrecisionInputs {
  return {
    filesCovered: index.documents.length,
    filesEligible: index.documents.length,
    symbolsMatched: 0,
    symbolsTotal: index.symbols.length,
    resolvedEdges: 0,
    totalEdges: index.edges.length,
    diagnosticsAvailable: index.diagnostics.length > 0,
    providerType: index.providerType,
    pass2SkippedFiles: 0,
    pass2EligibleFiles: index.documents.length,
    ...overrides,
  };
}
