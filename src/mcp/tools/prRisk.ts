import { computeDeltaWithTiers } from "../../delta/diff.js";
import type { Connection } from "kuzu";
import { computeBlastRadius } from "../../delta/blastRadius.js";
import {
  computeCentralityStats,
  computeCentralitySignal,
  compareScoresWithCentrality,
  type CentralityStats,
} from "../../graph/score.js";
import { getMetricsBySymbolIds } from "../../db/ladybug-metrics.js";
import { loadConfig } from "../../config/loadConfig.js";
import { PolicyEngine } from "../../policy/engine.js";
import { logger } from "../../util/logger.js";
import { PRRiskAnalysisRequestSchema } from "../tools.js";
import { recordToolTrace } from "../../graph/prefetch-model.js";
import { getLadybugConn } from "../../db/ladybug.js";
import { getSymbolsByIds } from "../../db/ladybug-symbols.js";
import { getFilesByIds } from "../../db/ladybug-repos.js";
import type { BlastRadiusItem } from "../types.js";
import { IndexError } from "../errors.js";

const DEFAULT_MAX_CHANGED_SYMBOLS = 15;
const DEFAULT_MAX_BLAST_RADIUS = 10;
const MAX_FINDINGS = 10;
const MAX_RECOMMENDED_TESTS = 10;
const MAX_EVIDENCE_ITEMS = 5;
const MAX_AFFECTED_SYMBOLS_PER_FINDING = 20;
/** Hard cap on serialized response size to prevent unbounded output. */
const MAX_RESPONSE_BYTES = 32_000;

type ComputedDeltaWithTiers = Awaited<ReturnType<typeof computeDeltaWithTiers>>;
type ChangedSymbol = ComputedDeltaWithTiers["changedSymbols"][number];

export async function handlePRRiskAnalysis(args: unknown) {
  const validated = PRRiskAnalysisRequestSchema.parse(args);

  // --- Budget: allow caller to cap response size ---
  const MAX_CHANGED_SYMBOLS_CAP = 200;
  const maxChangedSymbols = Math.min(
    validated.budget?.maxChangedSymbols ?? DEFAULT_MAX_CHANGED_SYMBOLS,
    MAX_CHANGED_SYMBOLS_CAP,
  );
  const MAX_BLAST_RADIUS_CAP = 200;
  const maxBlastRadius = Math.min(
    validated.budget?.maxBlastRadius ?? DEFAULT_MAX_BLAST_RADIUS,
    MAX_BLAST_RADIUS_CAP,
  );

  recordToolTrace({
    repoId: validated.repoId,
    taskType: "pr-risk",
    tool: "pr.risk.analyze",
  });

  logger.info("PR Risk Analysis requested", {
    repoId: validated.repoId,
    fromVersion: validated.fromVersion,
    toVersion: validated.toVersion,
  });

  const config = loadConfig();

  let delta: ComputedDeltaWithTiers;
  try {
    delta = await computeDeltaWithTiers(
      validated.repoId,
      validated.fromVersion,
      validated.toVersion,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to compute delta pack.";
    throw new IndexError(`Delta pack error: ${message}`);
  }

  const changedSymbolIds = delta.changedSymbols.map(
    (c: ChangedSymbol) => c.symbolId,
  );

  const conn = await getLadybugConn();
  const blastRadiusItems = await computeBlastRadius(conn, changedSymbolIds, {
    maxHops: 3,
    maxResults: 50,
    repoId: validated.repoId,
  });

  const policyEngine = new PolicyEngine(config.policy ?? {});

  const findings = generateFindings(delta, blastRadiusItems);

  const { centralityByItem: _centralityByItem } =
    await buildCentralityMapForItems(conn, blastRadiusItems);
  // Task 6: centrality-aware rerank (public shape unchanged).
  const rerankedBlastRadiusItems = rerankItemsWithCentrality(
    blastRadiusItems,
    _centralityByItem,
  );
  blastRadiusItems.length = 0;
  for (const it of rerankedBlastRadiusItems) blastRadiusItems.push(it);
  // V1 baseline: compute with no centrality contribution (multiplier = 1).
  // This avoids duplicating ~80 lines of scoring logic between two functions.
  const riskScore = computeRiskScoreV2(delta, blastRadiusItems, new Map());
  try {
    const riskScoreV2 = computeRiskScoreV2(
      delta,
      blastRadiusItems,
      _centralityByItem,
    );
    logger.info("prRisk: shadow riskScoreV2 telemetry", {
      repoId: validated.repoId,
      riskScore,
      riskScoreV2,
      delta: riskScoreV2 - riskScore,
    });
  } catch (err) {
    logger.debug("prRisk: riskScoreV2 computation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const evidence = collectEvidence(delta, blastRadiusItems);

  const recommendedTests = generateRecommendedTests(delta, blastRadiusItems);

  const escalationRequired =
    riskScore >= (validated.riskThreshold ?? 70) &&
    findings.some((f) => f.severity === "high");

  let policyDecision:
    | { decision: string; deniedReasons: string[]; auditHash?: string }
    | undefined;
  if (escalationRequired) {
    // Use delta requestType since this is PR/diff analysis, not code window access
    const rawDecision = policyEngine.evaluate({
      requestType: "delta",
      repoId: validated.repoId,
      identifiersToFind: ["pr-risk-escalation"],
      reason: `PR risk score ${riskScore} exceeds threshold`,
    });
    policyDecision = {
      decision: rawDecision.decision,
      deniedReasons: rawDecision.deniedReasons ?? [],
      auditHash: rawDecision.auditHash,
    };
  }

  // --- Enrich symbols with name/kind/file metadata ---
  const allSymbolIds = [
    ...changedSymbolIds,
    ...blastRadiusItems.map((item: BlastRadiusItem) => item.symbolId),
  ];
  const uniqueSymbolIds = [...new Set(allSymbolIds)];
  const symbolMap = await getSymbolsByIds(conn, uniqueSymbolIds);

  // Collect fileIds from the symbol map so we can resolve relPaths
  const fileIdSet = new Set<string>();
  for (const row of symbolMap.values()) {
    if (row.fileId) fileIdSet.add(row.fileId);
  }
  const fileMap =
    fileIdSet.size > 0
      ? await getFilesByIds(conn, [...fileIdSet])
      : new Map<string, { relPath: string }>();

  // Helper to enrich a symbolId with name, kind, file
  const enrichSymbol = (symbolId: string) => {
    const sym = symbolMap.get(symbolId);
    if (!sym) return { symbolId };
    const file = sym.fileId ? fileMap.get(sym.fileId) : undefined;
    return {
      symbolId,
      name: sym.name,
      kind: sym.kind,
      file: file?.relPath ?? undefined,
    };
  };

  // --- Filter by riskThreshold when set ---
  const riskThreshold = validated.riskThreshold;
  const filteredChangedSymbols =
    riskThreshold !== undefined
      ? delta.changedSymbols.filter(
          (c: ChangedSymbol) => (c.tiers?.riskScore ?? 0) >= riskThreshold,
        )
      : delta.changedSymbols;

  // --- Enrich and truncate changedSymbols ---
  const totalChangedSymbols = filteredChangedSymbols.length;
  const unfilteredTotal = delta.changedSymbols.length;
  const truncatedChangedSymbols = filteredChangedSymbols
    .slice(0, maxChangedSymbols)
    .map((c: ChangedSymbol) => ({
      ...enrichSymbol(c.symbolId),
      changeType: c.changeType,
      tiers: c.tiers,
    }));

  // --- Enrich and truncate blastRadius ---
  const totalBlastRadius = blastRadiusItems.length;
  const truncatedBlastRadius = blastRadiusItems
    .slice(0, maxBlastRadius)
    .map((item: BlastRadiusItem) => ({
      ...enrichSymbol(item.symbolId),
      reason: item.reason,
      distance: item.distance,
      rank: item.rank,
      signal: item.signal,
      fanInTrend: item.fanInTrend,
    }));

  // --- Truncate findings ---
  const totalFindings = findings.length;
  const truncatedFindings = findings.slice(0, MAX_FINDINGS);

  // --- Truncate recommendedTests ---
  const totalRecommendedTests = recommendedTests.length;
  const truncatedRecommendedTests = recommendedTests.slice(
    0,
    MAX_RECOMMENDED_TESTS,
  );

  // --- Truncate evidence ---
  const totalEvidence = evidence.length;
  const truncatedEvidence = evidence.slice(0, MAX_EVIDENCE_ITEMS);

  // --- Top-level summary for quick triage ---
  const topRiskItemName =
    truncatedChangedSymbols.length > 0
      ? (truncatedChangedSymbols[0].name ?? truncatedChangedSymbols[0].symbolId)
      : undefined;

  const response = {
    summary: {
      riskScore,
      riskLevel: getRiskLevel(riskScore),
      changedCount: unfilteredTotal,
      filteredCount: totalChangedSymbols,
      blastRadiusCount: totalBlastRadius,
      topRiskItem: topRiskItemName,
    },
    analysis: {
      repoId: delta.repoId,
      fromVersion: delta.fromVersion,
      toVersion: delta.toVersion,
      riskScore,
      riskLevel: getRiskLevel(riskScore),
      changedSymbols: {
        items: truncatedChangedSymbols,
        totalCount: totalChangedSymbols,
        unfilteredTotal,
        truncated: totalChangedSymbols > maxChangedSymbols,
        filteredByRiskThreshold: riskThreshold !== undefined,
      },
      blastRadius: {
        items: truncatedBlastRadius,
        totalCount: totalBlastRadius,
        truncated: totalBlastRadius > maxBlastRadius,
      },
      findings: {
        items: truncatedFindings,
        totalCount: totalFindings,
        truncated: totalFindings > MAX_FINDINGS,
      },
      evidence: {
        items: truncatedEvidence,
        totalCount: totalEvidence,
        truncated: totalEvidence > MAX_EVIDENCE_ITEMS,
      },
      recommendedTests: {
        items: truncatedRecommendedTests,
        totalCount: totalRecommendedTests,
        truncated: totalRecommendedTests > MAX_RECOMMENDED_TESTS,
      },
      changedSymbolsCount: totalChangedSymbols,
      blastRadiusCount: totalBlastRadius,
    },
    escalationRequired,
    policyDecision,
  };

  // Guardrail: cap serialized response size to prevent unbounded output.
  // The first pass trims the obvious large arrays; if the trimmed response
  // is still over the cap (e.g. because individual items have pathologically
  // long signatureDiff strings) we progressively shrink until it fits or we
  // hit the minimum viable envelope.
  let serialized = JSON.stringify(response);
  if (serialized.length > MAX_RESPONSE_BYTES) {
    const originalBytes = serialized.length;
    (response as Record<string, unknown>).truncationWarning =
      "Response truncated: " +
      originalBytes +
      " bytes exceeds " +
      MAX_RESPONSE_BYTES +
      " byte cap. Use budget.maxChangedSymbols to narrow scope.";

    const trimSteps: Array<() => void> = [
      // Pass 1: initial aggressive trim.
      () => {
        if (response.analysis.changedSymbols.items.length > 10) {
          response.analysis.changedSymbols.items =
            response.analysis.changedSymbols.items.slice(0, 10);
          response.analysis.changedSymbols.truncated = true;
        }
        if (response.analysis.blastRadius.items.length > 10) {
          response.analysis.blastRadius.items =
            response.analysis.blastRadius.items.slice(0, 10);
          response.analysis.blastRadius.truncated = true;
        }
        if (response.analysis.findings.items.length > 5) {
          response.analysis.findings.items =
            response.analysis.findings.items.slice(0, 5);
          response.analysis.findings.truncated = true;
        }
      },
      // Pass 2: halve what we kept.
      () => {
        response.analysis.changedSymbols.items =
          response.analysis.changedSymbols.items.slice(0, 5);
        response.analysis.blastRadius.items =
          response.analysis.blastRadius.items.slice(0, 5);
        response.analysis.findings.items =
          response.analysis.findings.items.slice(0, 3);
        response.analysis.evidence.items =
          response.analysis.evidence.items.slice(0, 3);
        response.analysis.recommendedTests.items =
          response.analysis.recommendedTests.items.slice(0, 3);
        response.analysis.changedSymbols.truncated = true;
        response.analysis.blastRadius.truncated = true;
        response.analysis.findings.truncated = true;
        response.analysis.evidence.truncated = true;
        response.analysis.recommendedTests.truncated = true;
      },
      // Pass 3: empty all arrays — envelope only.
      () => {
        response.analysis.changedSymbols.items = [];
        response.analysis.blastRadius.items = [];
        response.analysis.findings.items = [];
        response.analysis.evidence.items = [];
        response.analysis.recommendedTests.items = [];
        response.analysis.changedSymbols.truncated = true;
        response.analysis.blastRadius.truncated = true;
        response.analysis.findings.truncated = true;
        response.analysis.evidence.truncated = true;
        response.analysis.recommendedTests.truncated = true;
      },
    ];

    for (const step of trimSteps) {
      step();
      serialized = JSON.stringify(response);
      if (serialized.length <= MAX_RESPONSE_BYTES) break;
    }
  }

  logger.info("PR Risk Analysis completed", {
    repoId: validated.repoId,
    riskScore,
    riskLevel: response.analysis.riskLevel,
    findingsCount: totalFindings,
  });

  return response;
}

function generateFindings(
  delta: ComputedDeltaWithTiers,
  blastRadiusItems: BlastRadiusItem[],
): Array<{
  type: string;
  severity: "low" | "medium" | "high";
  message: string;
  affectedSymbols: string[];
  metadata?: Record<string, unknown>;
}> {
  const findings = [];

  const highRiskChanges = delta.changedSymbols.filter(
    (c: ChangedSymbol) => (c.tiers?.riskScore ?? 0) >= 70,
  );
  if (highRiskChanges.length > 0) {
    findings.push({
      type: "high-risk-changes",
      severity: "high" as const,
      message: `${highRiskChanges.length} changed symbol(s) with high risk score (≥70)`,
      affectedSymbols: highRiskChanges
        .slice(0, MAX_AFFECTED_SYMBOLS_PER_FINDING)
        .map((c: ChangedSymbol) => c.symbolId),
      metadata: {
        highRiskCount: highRiskChanges.length,
      },
    });
  }

  const interfaceBreakingChanges = delta.changedSymbols.filter(
    (c: ChangedSymbol) =>
      !c.tiers?.interfaceStable && c.changeType === "modified",
  );
  if (interfaceBreakingChanges.length > 0) {
    findings.push({
      type: "interface-breaking-changes",
      severity: "high" as const,
      message: `${interfaceBreakingChanges.length} symbol(s) with interface-breaking changes`,
      affectedSymbols: interfaceBreakingChanges
        .slice(0, MAX_AFFECTED_SYMBOLS_PER_FINDING)
        .map((c: ChangedSymbol) => c.symbolId),
      metadata: {
        breakingChangeCount: interfaceBreakingChanges.length,
      },
    });
  }

  const sideEffectChanges = delta.changedSymbols.filter(
    (c: ChangedSymbol) =>
      !c.tiers?.sideEffectsStable && c.changeType === "modified",
  );
  if (sideEffectChanges.length > 0) {
    findings.push({
      type: "side-effect-changes",
      severity: "medium" as const,
      message: `${sideEffectChanges.length} symbol(s) with side effect changes`,
      affectedSymbols: sideEffectChanges
        .slice(0, MAX_AFFECTED_SYMBOLS_PER_FINDING)
        .map((c: ChangedSymbol) => c.symbolId),
    });
  }

  const removedSymbols = delta.changedSymbols.filter(
    (c: ChangedSymbol) => c.changeType === "removed",
  );
  if (removedSymbols.length > 0) {
    findings.push({
      type: "removed-symbols",
      severity: "medium" as const,
      message: `${removedSymbols.length} symbol(s) removed`,
      affectedSymbols: removedSymbols
        .slice(0, MAX_AFFECTED_SYMBOLS_PER_FINDING)
        .map((c: ChangedSymbol) => c.symbolId),
    });
  }

  const largeBlastRadius = blastRadiusItems.filter(
    (item: BlastRadiusItem) => item.signal === "directDependent",
  );
  if (largeBlastRadius.length > 10) {
    findings.push({
      type: "large-impact-radius",
      severity: "medium" as const,
      message: `${largeBlastRadius.length} direct dependents may be affected`,
      affectedSymbols: largeBlastRadius
        .slice(0, MAX_AFFECTED_SYMBOLS_PER_FINDING)
        .map((item: BlastRadiusItem) => item.symbolId),
      metadata: {
        directDependentCount: largeBlastRadius.length,
      },
    });
  }

  const addedSymbols = delta.changedSymbols.filter(
    (c: ChangedSymbol) => c.changeType === "added",
  );
  if (addedSymbols.length > 0) {
    findings.push({
      type: "new-symbols",
      severity: "low" as const,
      message: `${addedSymbols.length} new symbol(s) added`,
      affectedSymbols: addedSymbols
        .slice(0, MAX_AFFECTED_SYMBOLS_PER_FINDING)
        .map((c: ChangedSymbol) => c.symbolId),
    });
  }

  return findings.sort((a, b) => {
    const severityOrder = { high: 0, medium: 1, low: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
}

/**
 * Task 6: shadow riskScoreV2 formula — evaluated internally and logged
 * via structured telemetry, never returned in the MCP response shape.
 * Uses centrality-weighted blast-radius contribution rather than plain
 * rank average so that high-centrality impacted symbols carry more
 * weight. Kept bounded to [0, 100].
 */
function computeRiskScoreV2(
  delta: ComputedDeltaWithTiers,
  blastRadiusItems: BlastRadiusItem[],
  centralityByItem: Map<string, number>,
): number {
  let totalRisk = 0;
  let weightSum = 0;

  const riskWeights = {
    changedSymbols: 0.4,
    blastRadius: 0.3,
    interfaceStability: 0.2,
    sideEffects: 0.1,
  };

  if (delta.changedSymbols.length > 0) {
    const avgChangeRisk =
      delta.changedSymbols.reduce((sum: number, c: ChangedSymbol) => {
        const risk = Math.min(100, c.tiers?.riskScore ?? 50);
        return sum + risk;
      }, 0) / delta.changedSymbols.length;
    totalRisk += avgChangeRisk * riskWeights.changedSymbols;
    weightSum += riskWeights.changedSymbols;
  }

  if (blastRadiusItems.length > 0) {
    // Centrality-weighted blast-radius contribution: items linked to
    // highly-central impacted symbols get amplified up to 1.25x.
    let accum = 0;
    for (const item of blastRadiusItems) {
      const baseContribution = Math.min(1, item.rank ?? 0) * 100;
      const centralitySignal = centralityByItem.get(item.symbolId) ?? 0;
      const multiplier = 1 + 0.25 * Math.min(1, centralitySignal);
      accum += baseContribution * multiplier;
    }
    const avgBlastRadiusScore = accum / blastRadiusItems.length;
    totalRisk += Math.min(100, avgBlastRadiusScore) * riskWeights.blastRadius;
    weightSum += riskWeights.blastRadius;
  }

  const interfaceUnstable = delta.changedSymbols.filter(
    (c: ChangedSymbol) => !c.tiers?.interfaceStable,
  ).length;
  if (delta.changedSymbols.length > 0) {
    const interfaceRisk =
      (interfaceUnstable / delta.changedSymbols.length) * 100;
    totalRisk += interfaceRisk * riskWeights.interfaceStability;
    weightSum += riskWeights.interfaceStability;
  }

  const sideEffectUnstable = delta.changedSymbols.filter(
    (c: ChangedSymbol) => !c.tiers?.sideEffectsStable,
  ).length;
  if (delta.changedSymbols.length > 0) {
    const sideEffectRisk =
      (sideEffectUnstable / delta.changedSymbols.length) * 100;
    totalRisk += sideEffectRisk * riskWeights.sideEffects;
    weightSum += riskWeights.sideEffects;
  }

  return weightSum > 0 ? Math.min(100, Math.round(totalRisk / weightSum)) : 0;
}

/**
 * Task 6: deterministic re-ranker for blast-radius evidence that uses
 * centrality as a bounded tie-breaker. Primary key is `rank` (desc);
 * secondary is centrality signal (desc); tertiary is symbolId (asc)
 * for stable ordering.
 */
function rerankItemsWithCentrality(
  items: BlastRadiusItem[],
  centralityByItem: Map<string, number>,
): BlastRadiusItem[] {
  return items.slice().sort((a, b) => {
    const cmp = compareScoresWithCentrality(
      {
        score: a.rank ?? 0,
        centralitySignal: centralityByItem.get(a.symbolId) ?? 0,
      },
      {
        score: b.rank ?? 0,
        centralitySignal: centralityByItem.get(b.symbolId) ?? 0,
      },
    );
    if (cmp !== 0) return cmp;
    return a.symbolId.localeCompare(b.symbolId);
  });
}

/**
 * Task 6: build a per-item centrality signal map from blast-radius
 * items by reading the Metrics rows (pageRank/kCore) for all impacted
 * symbol IDs. Absent metrics are treated as zero centrality so that
 * v1-era repos (no algorithm stage) see identical ordering.
 */
async function buildCentralityMapForItems(
  conn: Connection,
  items: BlastRadiusItem[],
): Promise<{
  centralityByItem: Map<string, number>;
  stats: CentralityStats;
}> {
  const centralityByItem = new Map<string, number>();
  if (items.length === 0) {
    return { centralityByItem, stats: { maxPageRank: 0, maxKCore: 0 } };
  }
  try {
    const symbolIds = items.map((i) => i.symbolId);
    const metrics = await getMetricsBySymbolIds(conn, symbolIds);
    const stats = computeCentralityStats(metrics.values());
    for (const [symbolId, row] of metrics.entries()) {
      const signal = computeCentralitySignal(
        row.pageRank ?? 0,
        row.kCore ?? 0,
        stats,
      );
      centralityByItem.set(symbolId, signal);
    }
    return { centralityByItem, stats };
  } catch (err) {
    logger.debug(
      "prRisk: centrality lookup failed, falling back to zero signals",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return { centralityByItem, stats: { maxPageRank: 0, maxKCore: 0 } };
  }
}
// computeOverallRiskScore removed: computeRiskScoreV2 with an empty
// centrality map produces identical output and avoids ~80 lines of
// duplicated logic. See call-site in handlePRRiskAnalysis.

function getRiskLevel(riskScore: number): "low" | "medium" | "high" {
  if (riskScore < 40) return "low";
  if (riskScore < 70) return "medium";
  return "high";
}

function formatDependencyChain(path: string[] | undefined): string | undefined {
  if (!path || path.length === 0) return undefined;
  return path.join(" -> ");
}

function compareItemsByExplanationPath(
  a: BlastRadiusItem,
  b: BlastRadiusItem,
): number {
  const aHasPath = a.explanationPath && a.explanationPath.length > 1 ? 1 : 0;
  const bHasPath = b.explanationPath && b.explanationPath.length > 1 ? 1 : 0;
  if (aHasPath !== bHasPath) {
    return bHasPath - aHasPath;
  }

  const aPathLength = a.explanationPath?.length ?? Number.POSITIVE_INFINITY;
  const bPathLength = b.explanationPath?.length ?? Number.POSITIVE_INFINITY;
  if (aPathLength !== bPathLength) {
    return aPathLength - bPathLength;
  }

  if (a.rank !== b.rank) {
    return b.rank - a.rank;
  }

  return a.symbolId.localeCompare(b.symbolId);
}

function collectEvidence(
  delta: ComputedDeltaWithTiers,
  blastRadiusItems: BlastRadiusItem[],
): Array<{
  type: string;
  description: string;
  symbolId?: string;
  data?: Record<string, unknown>;
}> {
  const evidence = [];

  evidence.push({
    type: "summary",
    description: "Delta analysis summary",
    data: {
      totalChanges: delta.changedSymbols.length,
      added: delta.changedSymbols.filter(
        (c: ChangedSymbol) => c.changeType === "added",
      ).length,
      removed: delta.changedSymbols.filter(
        (c: ChangedSymbol) => c.changeType === "removed",
      ).length,
      modified: delta.changedSymbols.filter(
        (c: ChangedSymbol) => c.changeType === "modified",
      ).length,
    },
  });

  const highRiskChanges = delta.changedSymbols.filter(
    (c: ChangedSymbol) => (c.tiers?.riskScore ?? 0) >= 70,
  );
  if (highRiskChanges.length > 0) {
    evidence.push({
      type: "high-risk-changes",
      description: "Changes with high risk scores",
      data: {
        count: highRiskChanges.length,
        symbols: highRiskChanges.map((c: ChangedSymbol) => ({
          symbolId: c.symbolId,
          riskScore: c.tiers?.riskScore,
          changeType: c.changeType,
        })),
      },
    });
  }

  const interfaceBreaks = delta.changedSymbols.filter(
    (c: ChangedSymbol) =>
      !c.tiers?.interfaceStable && c.changeType === "modified",
  );
  if (interfaceBreaks.length > 0) {
    evidence.push({
      type: "interface-breaks",
      description: "Interface-breaking changes detected",
      data: {
        count: interfaceBreaks.length,
        symbols: interfaceBreaks.map((c: ChangedSymbol) => ({
          symbolId: c.symbolId,
          signatureDiff:
            c.changeType === "modified" ? c.signatureDiff : undefined,
        })),
      },
    });
  }

  evidence.push({
    type: "blast-radius",
    description: "Impact radius analysis",
    data: {
      totalImpacted: blastRadiusItems.length,
      directDependents: blastRadiusItems.filter(
        (i: BlastRadiusItem) => i.signal === "directDependent",
      ).length,
      transitiveDependents: blastRadiusItems.filter(
        (i: BlastRadiusItem) => i.signal !== "directDependent",
      ).length,
      topImpacted: blastRadiusItems
        .slice(0, 10)
        .map((item: BlastRadiusItem) => ({
          symbolId: item.symbolId,
          distance: item.distance,
          rank: item.rank,
          reason: item.reason,
          explanationPath: item.explanationPath,
          dependencyChain: formatDependencyChain(item.explanationPath),
        })),
    },
  });

  return evidence;
}

function generateRecommendedTests(
  delta: ComputedDeltaWithTiers,
  blastRadiusItems: BlastRadiusItem[],
): Array<{
  type: string;
  description: string;
  targetSymbols: string[];
  priority: "high" | "medium" | "low";
}> {
  const tests = [];

  const modifiedSymbols = delta.changedSymbols.filter(
    (c: ChangedSymbol) => c.changeType === "modified",
  );
  if (modifiedSymbols.length > 0) {
    tests.push({
      type: "unit-tests",
      description: "Run unit tests for modified symbols",
      targetSymbols: modifiedSymbols
        .slice(0, 20)
        .map((c: ChangedSymbol) => c.symbolId),
      priority: "high" as const,
    });
  }

  const interfaceBreakingSymbols = delta.changedSymbols.filter(
    (c: ChangedSymbol) =>
      !c.tiers?.interfaceStable && c.changeType === "modified",
  );
  if (interfaceBreakingSymbols.length > 0) {
    tests.push({
      type: "integration-tests",
      description: "Run integration tests for symbols with interface changes",
      targetSymbols: interfaceBreakingSymbols
        .slice(0, 20)
        .map((c: ChangedSymbol) => c.symbolId),
      priority: "high" as const,
    });
  }

  const directDependents = blastRadiusItems.filter(
    (item: BlastRadiusItem) => item.signal === "directDependent",
  );
  if (directDependents.length > 0) {
    const prioritizedDirectDependents = directDependents
      .slice()
      .sort(compareItemsByExplanationPath);
    const exemplarChain = formatDependencyChain(
      prioritizedDirectDependents.find((item) => item.explanationPath)
        ?.explanationPath,
    );
    tests.push({
      type: "regression-tests",
      description: exemplarChain
        ? `Run regression tests on direct dependents (shortest chain: ${exemplarChain})`
        : "Run regression tests on direct dependents",
      targetSymbols: prioritizedDirectDependents
        .slice(0, 20)
        .map((item: BlastRadiusItem) => item.symbolId),
      priority: "medium" as const,
    });
  }

  const removedSymbols = delta.changedSymbols.filter(
    (c: ChangedSymbol) => c.changeType === "removed",
  );
  if (removedSymbols.length > 0) {
    tests.push({
      type: "api-breakage-tests",
      description: "Verify no references to removed symbols",
      targetSymbols: removedSymbols.map((c: ChangedSymbol) => c.symbolId),
      priority: "high" as const,
    });
  }

  const addedSymbols = delta.changedSymbols.filter(
    (c: ChangedSymbol) => c.changeType === "added",
  );
  if (addedSymbols.length > 0) {
    tests.push({
      type: "new-coverage-tests",
      description: "Add test coverage for new symbols",
      targetSymbols: addedSymbols.map((c: ChangedSymbol) => c.symbolId),
      priority: "low" as const,
    });
  }

  return tests.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
}
