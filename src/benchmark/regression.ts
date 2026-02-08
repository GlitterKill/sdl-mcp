export interface RegressionReportData {
  timestamp: string;
  repoId: string;
  currentMetrics: Record<string, number>;
  baselineMetrics?: Record<string, number>;
  thresholds: Record<string, unknown>;
  evaluations: import("./threshold.js").ThresholdEvaluation[];
}

export interface RegressionDelta {
  metricName: string;
  category: string;
  currentValue: number;
  baselineValue?: number;
  delta?: number;
  deltaPercent?: number;
  trend: "improved" | "degraded" | "neutral" | "unknown";
  impact: "high" | "medium" | "low" | "none";
  description: string;
}

export interface RegressionReport {
  summary: {
    passed: boolean;
    totalMetrics: number;
    improved: number;
    degraded: number;
    neutral: number;
    unknown: number;
  };
  deltas: RegressionDelta[];
  failingThresholds: string[];
  recommendations: string[];
}

export class RegressionReportGenerator {
  generate(data: RegressionReportData): RegressionReport {
    const deltas: RegressionDelta[] = [];
    const failingThresholds: string[] = [];
    const recommendations: string[] = [];

    for (const evaluation of data.evaluations) {
      const delta = this.generateDelta(evaluation);
      deltas.push(delta);

      if (!evaluation.passed) {
        failingThresholds.push(
          `${evaluation.category}.${evaluation.metricName}`,
        );
      }
    }

    const improved = deltas.filter((d) => d.trend === "improved").length;
    const degraded = deltas.filter((d) => d.trend === "degraded").length;
    const neutral = deltas.filter((d) => d.trend === "neutral").length;
    const unknown = deltas.filter((d) => d.trend === "unknown").length;

    recommendations.push(
      ...this.generateRecommendations(deltas, data.evaluations),
    );

    return {
      summary: {
        passed: failingThresholds.length === 0,
        totalMetrics: deltas.length,
        improved,
        degraded,
        neutral,
        unknown,
      },
      deltas,
      failingThresholds,
      recommendations,
    };
  }

  private generateDelta(
    evaluation: import("./threshold.js").ThresholdEvaluation,
  ): RegressionDelta {
    const {
      metricName,
      category,
      currentValue,
      baselineValue,
      delta,
      deltaPercent,
      threshold,
      passed,
    } = evaluation;

    let trend: RegressionDelta["trend"] = "unknown";
    let impact: RegressionDelta["impact"] = "none";
    let description = "";

    if (
      baselineValue !== undefined &&
      deltaPercent !== undefined &&
      delta !== undefined
    ) {
      if (threshold.trend === "lower-is-better") {
        trend = delta < 0 ? "improved" : delta > 0 ? "degraded" : "neutral";
      } else {
        trend = delta > 0 ? "improved" : delta < 0 ? "degraded" : "neutral";
      }

      const absDeltaPercent = Math.abs(deltaPercent);
      if (absDeltaPercent > 20) {
        impact = "high";
      } else if (absDeltaPercent > 10) {
        impact = "medium";
      } else if (absDeltaPercent > 5) {
        impact = "low";
      }
    } else {
      description = "No baseline available for comparison";
    }

    if (!passed) {
      impact = impact === "none" ? "low" : impact;
      description = evaluation.message;
    } else if (impact !== "none" && trend !== "neutral") {
      const trendStr = trend === "improved" ? "improved" : "degraded";
      const direction = trend === "improved" ? "↓" : "↑";
      description = `${trendStr} by ${Math.abs(deltaPercent ?? 0).toFixed(1)}% ${direction}`;
    } else if (baselineValue !== undefined) {
      description = `${currentValue.toFixed(2)} (baseline: ${baselineValue.toFixed(2)})`;
    } else {
      description = `${currentValue.toFixed(2)} (no baseline)`;
    }

    return {
      metricName,
      category,
      currentValue,
      baselineValue,
      delta,
      deltaPercent,
      trend,
      impact,
      description,
    };
  }

  private generateRecommendations(
    deltas: RegressionDelta[],
    evaluations: import("./threshold.js").ThresholdEvaluation[],
  ): string[] {
    const recommendations: string[] = [];

    const highImpactDegraded = deltas.filter(
      (d) => d.impact === "high" && d.trend === "degraded",
    );
    if (highImpactDegraded.length > 0) {
      recommendations.push(
        `CRITICAL: ${highImpactDegraded.length} metrics have high-impact degradation:`,
        ...highImpactDegraded.map(
          (d) => `  - ${d.metricName}: ${d.description}`,
        ),
      );
    }

    const mediumImpactDegraded = deltas.filter(
      (d) => d.impact === "medium" && d.trend === "degraded",
    );
    if (mediumImpactDegraded.length > 0) {
      recommendations.push(
        `WARNING: ${mediumImpactDegraded.length} metrics have medium-impact degradation:`,
        ...mediumImpactDegraded.map(
          (d) => `  - ${d.metricName}: ${d.description}`,
        ),
      );
    }

    const failingEvaluations = evaluations.filter((e) => !e.passed);
    if (failingEvaluations.length > 0) {
      const indexFailures = failingEvaluations.filter(
        (e) => e.category === "indexing",
      );
      if (indexFailures.length > 0) {
        recommendations.push(
          "Indexing performance issues detected. Consider:",
          "  - Increasing indexing concurrency",
          "  - Adding large generated files to ignore list",
          "  - Reducing maxFileBytes threshold",
          "  - Checking for tree-sitter query performance issues",
        );
      }

      const qualityFailures = failingEvaluations.filter(
        (e) => e.category === "quality",
      );
      if (qualityFailures.length > 0) {
        recommendations.push(
          "Quality metrics degraded. This may indicate:",
          "  - Changes in symbol extraction logic",
          "  - Modifications to tree-sitter queries",
          "  - Regression in edge detection algorithms",
        );
      }

      const performanceFailures = failingEvaluations.filter(
        (e) => e.category === "performance",
      );
      if (performanceFailures.length > 0) {
        recommendations.push(
          "Runtime performance degraded. Consider:",
          "  - Reviewing recent database query changes",
          "  - Checking for N+1 query patterns",
          "  - Optimizing graph traversal algorithms",
        );
      }

      const coverageFailures = failingEvaluations.filter(
        (e) => e.category === "coverage",
      );
      if (coverageFailures.length > 0) {
        recommendations.push(
          "Edge coverage degraded. Verify:",
          "  - Call edge extraction queries are working correctly",
          "  - Import resolution hasn't regressed",
          "  - New code patterns are properly supported",
        );
      }
    }

    const improvedMetrics = deltas.filter((d) => d.trend === "improved");
    if (improvedMetrics.length > 0 && recommendations.length === 0) {
      recommendations.push(
        `All metrics passed! ${improvedMetrics.length} metrics improved.`,
      );
    }

    return recommendations;
  }

  generateMarkdownReport(report: RegressionReport): string {
    const lines: string[] = [];

    lines.push("# Benchmark Regression Report");
    lines.push("");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");

    const statusEmoji = report.summary.passed ? "✅" : "❌";
    lines.push(`## Summary ${statusEmoji}`);
    lines.push("");
    lines.push(`- **Status**: ${report.summary.passed ? "PASSED" : "FAILED"}`);
    lines.push(`- **Total Metrics**: ${report.summary.totalMetrics}`);
    lines.push(`- **Improved**: ${report.summary.improved}`);
    lines.push(`- **Degraded**: ${report.summary.degraded}`);
    lines.push(`- **Neutral**: ${report.summary.neutral}`);
    lines.push(`- **Unknown**: ${report.summary.unknown}`);
    lines.push("");

    if (report.failingThresholds.length > 0) {
      lines.push("## Failed Thresholds");
      lines.push("");
      for (const threshold of report.failingThresholds) {
        lines.push(`- ❌ \`${threshold}\``);
      }
      lines.push("");
    }

    lines.push("## Metric Deltas");
    lines.push("");

    const categorized = new Map<string, RegressionDelta[]>();
    for (const delta of report.deltas) {
      if (!categorized.has(delta.category)) {
        categorized.set(delta.category, []);
      }
      categorized.get(delta.category)!.push(delta);
    }

    for (const [category, deltas] of categorized) {
      lines.push(`### ${category}`);
      lines.push("");

      for (const delta of deltas) {
        const impactEmoji = {
          high: "🔴",
          medium: "🟡",
          low: "🟢",
          none: "⚪",
        }[delta.impact];

        const trendEmoji = {
          improved: "✓",
          degraded: "✗",
          neutral: "−",
          unknown: "?",
        }[delta.trend];

        lines.push(`#### ${delta.metricName} ${impactEmoji} ${trendEmoji}`);
        lines.push("");
        lines.push(`- **Current**: ${delta.currentValue.toFixed(2)}`);
        if (delta.baselineValue !== undefined) {
          lines.push(`- **Baseline**: ${delta.baselineValue.toFixed(2)}`);
        }
        if (delta.deltaPercent !== undefined) {
          lines.push(`- **Change**: ${delta.deltaPercent.toFixed(2)}%`);
        }
        lines.push(`- **Impact**: ${delta.impact}`);
        lines.push(`- **Description**: ${delta.description}`);
        lines.push("");
      }
    }

    if (report.recommendations.length > 0) {
      lines.push("## Recommendations");
      lines.push("");
      for (const recommendation of report.recommendations) {
        lines.push(recommendation);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  generateJsonReport(report: RegressionReport): string {
    return JSON.stringify(report, null, 2);
  }
}
