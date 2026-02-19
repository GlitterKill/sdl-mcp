import { computeDeltaWithTiers } from "../../delta/diff.js";
import { computeBlastRadius } from "../../delta/blastRadius.js";
import {
  loadGraphForRepo,
  loadNeighborhood,
  logGraphTelemetry,
  getLastLoadStats,
  LAZY_GRAPH_LOADING_DEFAULT_HOPS,
  LAZY_GRAPH_LOADING_MAX_SYMBOLS,
} from "../../graph/buildGraph.js";
import { loadConfig } from "../../config/loadConfig.js";
import { PolicyEngine } from "../../policy/engine.js";
import { logger } from "../../util/logger.js";
import { PRRiskAnalysisRequestSchema } from "../tools.js";

export async function handlePRRiskAnalysis(args: unknown) {
  const validated = PRRiskAnalysisRequestSchema.parse(args);

  logger.info("PR Risk Analysis requested", {
    repoId: validated.repoId,
    fromVersion: validated.fromVersion,
    toVersion: validated.toVersion,
  });

  const config = loadConfig();

  let delta;
  try {
    delta = computeDeltaWithTiers(
      validated.repoId,
      validated.fromVersion,
      validated.toVersion,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to compute delta pack.";
    throw new Error(`Delta pack error: ${message}`);
  }

  const changedSymbolIds = delta.changedSymbols.map((c) => c.symbolId);

  let graph;
  if (changedSymbolIds.length > 0 && changedSymbolIds.length < 500) {
    graph = loadNeighborhood(validated.repoId, changedSymbolIds, {
      maxHops: LAZY_GRAPH_LOADING_DEFAULT_HOPS,
      direction: "both",
      maxSymbols: LAZY_GRAPH_LOADING_MAX_SYMBOLS,
    });
  } else {
    graph = loadGraphForRepo(validated.repoId);
  }

  const loadStats = getLastLoadStats();
  if (loadStats) {
    logGraphTelemetry({
      repoId: validated.repoId,
      ...loadStats,
    });
  }

  const blastRadiusItems = computeBlastRadius(changedSymbolIds, graph, {
    maxHops: 3,
    maxResults: 50,
  });

  const policyEngine = new PolicyEngine(config.policy ?? {});

  const findings = generateFindings(delta, blastRadiusItems);

  const riskScore = computeOverallRiskScore(delta, blastRadiusItems);

  const impactedSymbols = blastRadiusItems.map((item) => item.symbolId);

  const evidence = collectEvidence(delta, blastRadiusItems);

  const recommendedTests = generateRecommendedTests(delta, blastRadiusItems);

  const escalationRequired =
    riskScore >= (validated.riskThreshold ?? 70) &&
    findings.some((f) => f.severity === "high");

  let policyDecision;
  if (escalationRequired) {
    policyDecision = policyEngine.evaluate({
      requestType: "codeWindow",
      repoId: validated.repoId,
      identifiersToFind: [],
      reason: `PR risk score ${riskScore} exceeds threshold`,
    });
  }

  const response = {
    analysis: {
      repoId: delta.repoId,
      fromVersion: delta.fromVersion,
      toVersion: delta.toVersion,
      riskScore,
      riskLevel: getRiskLevel(riskScore),
      findings,
      impactedSymbols,
      evidence,
      recommendedTests,
      changedSymbolsCount: delta.changedSymbols.length,
      blastRadiusCount: blastRadiusItems.length,
    },
    escalationRequired,
    policyDecision,
  };

  logger.info("PR Risk Analysis completed", {
    repoId: validated.repoId,
    riskScore,
    riskLevel: response.analysis.riskLevel,
    findingsCount: findings.length,
  });

  return response;
}

function generateFindings(
  delta: any,
  blastRadiusItems: any[],
): Array<{
  type: string;
  severity: "low" | "medium" | "high";
  message: string;
  affectedSymbols: string[];
  metadata?: Record<string, unknown>;
}> {
  const findings = [];

  const highRiskChanges = delta.changedSymbols.filter(
    (c: any) => c.tiers?.riskScore >= 70,
  );
  if (highRiskChanges.length > 0) {
    findings.push({
      type: "high-risk-changes",
      severity: "high" as const,
      message: `${highRiskChanges.length} changed symbol(s) with high risk score (≥70)`,
      affectedSymbols: highRiskChanges.map((c: any) => c.symbolId),
      metadata: {
        highRiskCount: highRiskChanges.length,
      },
    });
  }

  const interfaceBreakingChanges = delta.changedSymbols.filter(
    (c: any) => !c.tiers?.interfaceStable && c.changeType === "modified",
  );
  if (interfaceBreakingChanges.length > 0) {
    findings.push({
      type: "interface-breaking-changes",
      severity: "high" as const,
      message: `${interfaceBreakingChanges.length} symbol(s) with interface-breaking changes`,
      affectedSymbols: interfaceBreakingChanges.map((c: any) => c.symbolId),
      metadata: {
        breakingChangeCount: interfaceBreakingChanges.length,
      },
    });
  }

  const sideEffectChanges = delta.changedSymbols.filter(
    (c: any) => !c.tiers?.sideEffectsStable && c.changeType === "modified",
  );
  if (sideEffectChanges.length > 0) {
    findings.push({
      type: "side-effect-changes",
      severity: "medium" as const,
      message: `${sideEffectChanges.length} symbol(s) with side effect changes`,
      affectedSymbols: sideEffectChanges.map((c: any) => c.symbolId),
    });
  }

  const removedSymbols = delta.changedSymbols.filter(
    (c: any) => c.changeType === "removed",
  );
  if (removedSymbols.length > 0) {
    findings.push({
      type: "removed-symbols",
      severity: "medium" as const,
      message: `${removedSymbols.length} symbol(s) removed`,
      affectedSymbols: removedSymbols.map((c: any) => c.symbolId),
    });
  }

  const largeBlastRadius = blastRadiusItems.filter(
    (item) => item.distance === 0,
  );
  if (largeBlastRadius.length > 10) {
    findings.push({
      type: "large-impact-radius",
      severity: "medium" as const,
      message: `${largeBlastRadius.length} direct dependents may be affected`,
      affectedSymbols: largeBlastRadius
        .slice(0, 10)
        .map((item) => item.symbolId),
      metadata: {
        directDependentCount: largeBlastRadius.length,
      },
    });
  }

  const addedSymbols = delta.changedSymbols.filter(
    (c: any) => c.changeType === "added",
  );
  if (addedSymbols.length > 0) {
    findings.push({
      type: "new-symbols",
      severity: "low" as const,
      message: `${addedSymbols.length} new symbol(s) added`,
      affectedSymbols: addedSymbols.map((c: any) => c.symbolId),
    });
  }

  return findings.sort((a, b) => {
    const severityOrder = { high: 0, medium: 1, low: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
}

function computeOverallRiskScore(delta: any, blastRadiusItems: any[]): number {
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
      delta.changedSymbols.reduce((sum: number, c: any) => {
        const risk = c.tiers?.riskScore ?? 100;
        return sum + risk;
      }, 0) / delta.changedSymbols.length;
    totalRisk += avgChangeRisk * riskWeights.changedSymbols;
    weightSum += riskWeights.changedSymbols;
  }

  if (blastRadiusItems.length > 0) {
    const avgBlastRadiusScore =
      blastRadiusItems.reduce((sum: number, item: any) => {
        return sum + item.rank * 100;
      }, 0) / blastRadiusItems.length;
    totalRisk += avgBlastRadiusScore * riskWeights.blastRadius;
    weightSum += riskWeights.blastRadius;
  }

  const interfaceUnstable = delta.changedSymbols.filter(
    (c: any) => !c.tiers?.interfaceStable,
  ).length;
  if (delta.changedSymbols.length > 0) {
    const interfaceRisk =
      (interfaceUnstable / delta.changedSymbols.length) * 100;
    totalRisk += interfaceRisk * riskWeights.interfaceStability;
    weightSum += riskWeights.interfaceStability;
  }

  const sideEffectUnstable = delta.changedSymbols.filter(
    (c: any) => !c.tiers?.sideEffectsStable,
  ).length;
  if (delta.changedSymbols.length > 0) {
    const sideEffectRisk =
      (sideEffectUnstable / delta.changedSymbols.length) * 100;
    totalRisk += sideEffectRisk * riskWeights.sideEffects;
    weightSum += riskWeights.sideEffects;
  }

  return weightSum > 0 ? Math.round(totalRisk / weightSum) : 0;
}

function getRiskLevel(riskScore: number): "low" | "medium" | "high" {
  if (riskScore < 40) return "low";
  if (riskScore < 70) return "medium";
  return "high";
}

function collectEvidence(
  delta: any,
  blastRadiusItems: any[],
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
      added: delta.changedSymbols.filter((c: any) => c.changeType === "added")
        .length,
      removed: delta.changedSymbols.filter(
        (c: any) => c.changeType === "removed",
      ).length,
      modified: delta.changedSymbols.filter(
        (c: any) => c.changeType === "modified",
      ).length,
    },
  });

  const highRiskChanges = delta.changedSymbols.filter(
    (c: any) => (c.tiers?.riskScore ?? 0) >= 70,
  );
  if (highRiskChanges.length > 0) {
    evidence.push({
      type: "high-risk-changes",
      description: "Changes with high risk scores",
      data: {
        count: highRiskChanges.length,
        symbols: highRiskChanges.map((c: any) => ({
          symbolId: c.symbolId,
          riskScore: c.tiers?.riskScore,
          changeType: c.changeType,
        })),
      },
    });
  }

  const interfaceBreaks = delta.changedSymbols.filter(
    (c: any) => !c.tiers?.interfaceStable && c.changeType === "modified",
  );
  if (interfaceBreaks.length > 0) {
    evidence.push({
      type: "interface-breaks",
      description: "Interface-breaking changes detected",
      data: {
        count: interfaceBreaks.length,
        symbols: interfaceBreaks.map((c: any) => ({
          symbolId: c.symbolId,
          signatureDiff: c.signatureDiff,
        })),
      },
    });
  }

  evidence.push({
    type: "blast-radius",
    description: "Impact radius analysis",
    data: {
      totalImpacted: blastRadiusItems.length,
      directDependents: blastRadiusItems.filter((i: any) => i.distance === 0)
        .length,
      transitiveDependents: blastRadiusItems.filter((i: any) => i.distance > 0)
        .length,
      topImpacted: blastRadiusItems.slice(0, 10).map((item: any) => ({
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
  delta: any,
  blastRadiusItems: any[],
): Array<{
  type: string;
  description: string;
  targetSymbols: string[];
  priority: "high" | "medium" | "low";
}> {
  const tests = [];

  const modifiedSymbols = delta.changedSymbols.filter(
    (c: any) => c.changeType === "modified",
  );
  if (modifiedSymbols.length > 0) {
    tests.push({
      type: "unit-tests",
      description: "Run unit tests for modified symbols",
      targetSymbols: modifiedSymbols.slice(0, 20).map((c: any) => c.symbolId),
      priority: "high" as const,
    });
  }

  const interfaceBreakingSymbols = delta.changedSymbols.filter(
    (c: any) => !c.tiers?.interfaceStable && c.changeType === "modified",
  );
  if (interfaceBreakingSymbols.length > 0) {
    tests.push({
      type: "integration-tests",
      description: "Run integration tests for symbols with interface changes",
      targetSymbols: interfaceBreakingSymbols.map((c: any) => c.symbolId),
      priority: "high" as const,
    });
  }

  const directDependents = blastRadiusItems.filter(
    (item) => item.distance === 0,
  );
  if (directDependents.length > 0) {
    tests.push({
      type: "regression-tests",
      description: "Run regression tests on direct dependents",
      targetSymbols: directDependents
        .slice(0, 20)
        .map((item: any) => item.symbolId),
      priority: "medium" as const,
    });
  }

  const removedSymbols = delta.changedSymbols.filter(
    (c: any) => c.changeType === "removed",
  );
  if (removedSymbols.length > 0) {
    tests.push({
      type: "api-breakage-tests",
      description: "Verify no references to removed symbols",
      targetSymbols: removedSymbols.map((c: any) => c.symbolId),
      priority: "high" as const,
    });
  }

  const addedSymbols = delta.changedSymbols.filter(
    (c: any) => c.changeType === "added",
  );
  if (addedSymbols.length > 0) {
    tests.push({
      type: "new-coverage-tests",
      description: "Add test coverage for new symbols",
      targetSymbols: addedSymbols.map((c: any) => c.symbolId),
      priority: "low" as const,
    });
  }

  return tests.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
}
