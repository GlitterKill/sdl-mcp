import { computeDeltaWithTiers } from "../../delta/diff.js";
import { computeBlastRadius } from "../../delta/blastRadius.js";
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

const MAX_CHANGED_SYMBOLS_IN_RESPONSE = 100;
const MAX_BLAST_RADIUS_IN_RESPONSE = 50;
const MAX_FINDINGS = 20;
const MAX_RECOMMENDED_TESTS = 20;
const MAX_EVIDENCE_ITEMS = 20;

type ComputedDeltaWithTiers = Awaited<ReturnType<typeof computeDeltaWithTiers>>;
type ChangedSymbol = ComputedDeltaWithTiers["changedSymbols"][number];

export async function handlePRRiskAnalysis(args: unknown) {
  const validated = PRRiskAnalysisRequestSchema.parse(args);

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

  const riskScore = computeOverallRiskScore(delta, blastRadiusItems);

  const impactedSymbols = blastRadiusItems.map(
    (item: BlastRadiusItem) => item.symbolId,
  );

  const evidence = collectEvidence(delta, blastRadiusItems);

  const recommendedTests = generateRecommendedTests(delta, blastRadiusItems);

  const escalationRequired =
    riskScore >= (validated.riskThreshold ?? 70) &&
    findings.some((f) => f.severity === "high");

  let policyDecision: { decision: string; deniedReasons: string[]; auditHash?: string } | undefined;
  if (escalationRequired) {
    const rawDecision = policyEngine.evaluate({
      requestType: "codeWindow",
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
  const fileMap = fileIdSet.size > 0
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

  // --- Enrich and truncate changedSymbols ---
  const totalChangedSymbols = delta.changedSymbols.length;
  const truncatedChangedSymbols = delta.changedSymbols
    .slice(0, MAX_CHANGED_SYMBOLS_IN_RESPONSE)
    .map((c: ChangedSymbol) => ({
      ...enrichSymbol(c.symbolId),
      changeType: c.changeType,
      tiers: c.tiers,
    }));

  // --- Enrich and truncate blastRadius ---
  const totalBlastRadius = blastRadiusItems.length;
  const truncatedBlastRadius = blastRadiusItems
    .slice(0, MAX_BLAST_RADIUS_IN_RESPONSE)
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
  const truncatedRecommendedTests = recommendedTests.slice(0, MAX_RECOMMENDED_TESTS);

  // --- Truncate evidence ---
  const totalEvidence = evidence.length;
  const truncatedEvidence = evidence.slice(0, MAX_EVIDENCE_ITEMS);

  const response = {
    analysis: {
      repoId: delta.repoId,
      fromVersion: delta.fromVersion,
      toVersion: delta.toVersion,
      riskScore,
      riskLevel: getRiskLevel(riskScore),
      changedSymbols: {
        items: truncatedChangedSymbols,
        totalCount: totalChangedSymbols,
        truncated: totalChangedSymbols > MAX_CHANGED_SYMBOLS_IN_RESPONSE,
      },
      blastRadius: {
        items: truncatedBlastRadius,
        totalCount: totalBlastRadius,
        truncated: totalBlastRadius > MAX_BLAST_RADIUS_IN_RESPONSE,
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
      impactedSymbols,
      changedSymbolsCount: totalChangedSymbols,
      blastRadiusCount: totalBlastRadius,
    },
    escalationRequired,
    policyDecision,
  };

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
      affectedSymbols: highRiskChanges.map((c: ChangedSymbol) => c.symbolId),
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
      affectedSymbols: interfaceBreakingChanges.map(
        (c: ChangedSymbol) => c.symbolId,
      ),
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
      affectedSymbols: sideEffectChanges.map((c: ChangedSymbol) => c.symbolId),
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
      affectedSymbols: removedSymbols.map((c: ChangedSymbol) => c.symbolId),
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
        .slice(0, 10)
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
      affectedSymbols: addedSymbols.map((c: ChangedSymbol) => c.symbolId),
    });
  }

  return findings.sort((a, b) => {
    const severityOrder = { high: 0, medium: 1, low: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
}

function computeOverallRiskScore(
  delta: ComputedDeltaWithTiers,
  blastRadiusItems: BlastRadiusItem[],
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
    const avgBlastRadiusScore =
      blastRadiusItems.reduce((sum: number, item: BlastRadiusItem) => {
        return sum + Math.min(1, item.rank ?? 0) * 100;
      }, 0) / blastRadiusItems.length;
    totalRisk += avgBlastRadiusScore * riskWeights.blastRadius;
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

function getRiskLevel(riskScore: number): "low" | "medium" | "high" {
  if (riskScore < 40) return "low";
  if (riskScore < 70) return "medium";
  return "high";
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
      targetSymbols: interfaceBreakingSymbols.map(
        (c: ChangedSymbol) => c.symbolId,
      ),
      priority: "high" as const,
    });
  }

  const directDependents = blastRadiusItems.filter(
    (item: BlastRadiusItem) => item.signal === "directDependent",
  );
  if (directDependents.length > 0) {
    tests.push({
      type: "regression-tests",
      description: "Run regression tests on direct dependents",
      targetSymbols: directDependents
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
