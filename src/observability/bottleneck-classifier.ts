/**
 * Deterministic bottleneck classifier (Agent G surface, lives inside Agent A's
 * observability module).
 *
 * Given a snapshot of resource and queue signals, return a single dominant
 * `BottleneckClass` plus the top contributing signals. The function is pure —
 * given the same input, it always returns the same output. Heuristic only;
 * not a substitute for profiling, but useful for at-a-glance dashboards.
 */

import type { BottleneckClass, BottleneckSummary } from "./types.js";

export interface ClassifierInput {
  /** Average CPU percent (0-100). */
  cpuPctAvg: number;
  /** Maximum CPU percent observed (0-100). */
  cpuPctMax: number;
  /** Resident set size in MB. */
  rssMb: number;
  /** Heap used in MB. */
  heapUsedMb: number;
  /** Heap total in MB (for ratio). 0 means "unknown". */
  heapTotalMb: number;
  /** P95 event-loop lag in milliseconds. */
  eventLoopLagP95Ms: number;
  /** P95 DB query latency in milliseconds. */
  dbLatencyP95Ms: number;
  /** P95 indexer parse duration in milliseconds. */
  indexerParseP95Ms: number;
  /** I/O throughput in MB/s. */
  ioThroughputMbPerSec: number;
  /** Configurable saturation threshold for I/O throughput (MB/s). */
  ioThroughputSaturationMbPerSec: number;
  /** Average write-pool queued depth. */
  poolWriteQueuedAvg: number;
  /** Average drain queue depth. */
  drainQueueDepthAvg: number;
}

interface RuleScore {
  cls: BottleneckClass;
  score: number;
  signals: Array<{ name: string; value: number; unit: string; weight: number }>;
}

/**
 * Classify the dominant bottleneck.
 *
 * Heuristic rules (each rule produces a 0..1 score):
 *  - cpu_bound:       cpuPctAvg > 75 AND eventLoopLagP95Ms < 50
 *  - memory_pressure: rssMb > 1500 OR heapUsed/heapTotal > 0.85
 *  - db_latency:      dbLatencyP95Ms > 200 OR poolWriteQueuedAvg > 5
 *  - indexer_parse:   indexerParseP95Ms > 500
 *  - io_throughput:   ioThroughputMbPerSec / saturationThreshold >= 0.85
 *  - balanced:        always 0.1 (floor)
 *
 * Confidence = (top - runnerUp) / max(top, 1e-6), clamped to [0, 1].
 */
export function classifyBottleneck(input: ClassifierInput): BottleneckSummary {
  const rules: RuleScore[] = [
    scoreCpu(input),
    scoreMemory(input),
    scoreDb(input),
    scoreIndexer(input),
    scoreIo(input),
    scoreBalanced(),
  ];

  rules.sort((a, b) => b.score - a.score);
  const top = rules[0];
  const runnerUp = rules[1];

  const margin = top.score - (runnerUp?.score ?? 0);
  const confidence = clamp01(top.score === 0 ? 0 : margin / top.score);

  // Combine top-3 rule signals, sort by weight desc, keep top 3.
  const allSignals = rules
    .slice(0, 3)
    .flatMap((r) => r.signals)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);

  return {
    dominant: top.cls,
    confidence,
    topSignals: allSignals,
  };
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

function scoreCpu(input: ClassifierInput): RuleScore {
  const { cpuPctAvg, eventLoopLagP95Ms, cpuPctMax } = input;
  const cpuOver = Math.max(0, (cpuPctAvg - 75) / 25); // 0 at 75%, 1 at 100%
  const loopOk = eventLoopLagP95Ms < 50 ? 1 : 0;
  const score = clamp01(cpuOver * loopOk);
  return {
    cls: "cpu_bound",
    score,
    signals: [
      {
        name: "cpuPctAvg",
        value: round2(cpuPctAvg),
        unit: "%",
        weight: round2(cpuOver),
      },
      {
        name: "cpuPctMax",
        value: round2(cpuPctMax),
        unit: "%",
        weight: round2(cpuOver * 0.5),
      },
      {
        name: "eventLoopLagP95Ms",
        value: round2(eventLoopLagP95Ms),
        unit: "ms",
        weight: round2(loopOk * 0.3),
      },
    ],
  };
}

function scoreMemory(input: ClassifierInput): RuleScore {
  const { rssMb, heapUsedMb, heapTotalMb } = input;
  const rssRatio = clamp01((rssMb - 1500) / 1500); // 0 at 1500MB, 1 at 3000MB
  const heapRatio = heapTotalMb > 0 ? heapUsedMb / heapTotalMb : 0;
  const heapPressure = clamp01((heapRatio - 0.85) / 0.15); // 0 at 0.85, 1 at 1.0
  const score = clamp01(Math.max(rssRatio, heapPressure));
  return {
    cls: "memory_pressure",
    score,
    signals: [
      {
        name: "rssMb",
        value: round2(rssMb),
        unit: "MB",
        weight: round2(rssRatio),
      },
      {
        name: "heapUsedMb",
        value: round2(heapUsedMb),
        unit: "MB",
        weight: round2(heapPressure * 0.7),
      },
      {
        name: "heapRatio",
        value: round2(heapRatio),
        unit: "ratio",
        weight: round2(heapPressure),
      },
    ],
  };
}

function scoreDb(input: ClassifierInput): RuleScore {
  const { dbLatencyP95Ms, poolWriteQueuedAvg, drainQueueDepthAvg } = input;
  const latencyScore = clamp01((dbLatencyP95Ms - 200) / 800); // 0 at 200ms, 1 at 1000ms
  const poolScore = clamp01((poolWriteQueuedAvg - 5) / 20); // 0 at 5, 1 at 25
  const drainScore = clamp01(drainQueueDepthAvg / 100); // 0 at 0, 1 at 100
  const score = clamp01(Math.max(latencyScore, poolScore, drainScore));
  return {
    cls: "db_latency",
    score,
    signals: [
      {
        name: "dbLatencyP95Ms",
        value: round2(dbLatencyP95Ms),
        unit: "ms",
        weight: round2(latencyScore),
      },
      {
        name: "poolWriteQueuedAvg",
        value: round2(poolWriteQueuedAvg),
        unit: "items",
        weight: round2(poolScore),
      },
      {
        name: "drainQueueDepthAvg",
        value: round2(drainQueueDepthAvg),
        unit: "items",
        weight: round2(drainScore),
      },
    ],
  };
}

function scoreIndexer(input: ClassifierInput): RuleScore {
  const { indexerParseP95Ms } = input;
  const score = clamp01((indexerParseP95Ms - 500) / 1500); // 0 at 500ms, 1 at 2000ms
  return {
    cls: "indexer_parse",
    score,
    signals: [
      {
        name: "indexerParseP95Ms",
        value: round2(indexerParseP95Ms),
        unit: "ms",
        weight: round2(score),
      },
    ],
  };
}

function scoreIo(input: ClassifierInput): RuleScore {
  const { ioThroughputMbPerSec, ioThroughputSaturationMbPerSec } = input;
  const sat =
    ioThroughputSaturationMbPerSec > 0 ? ioThroughputSaturationMbPerSec : 1;
  const utilization = ioThroughputMbPerSec / sat;
  const score = clamp01((utilization - 0.85) / 0.15); // 0 at 85%, 1 at 100%
  return {
    cls: "io_throughput",
    score,
    signals: [
      {
        name: "ioThroughputMbPerSec",
        value: round2(ioThroughputMbPerSec),
        unit: "MB/s",
        weight: round2(score),
      },
      {
        name: "ioUtilization",
        value: round2(utilization),
        unit: "ratio",
        weight: round2(score * 0.5),
      },
    ],
  };
}

function scoreBalanced(): RuleScore {
  // Floor — wins only when no other rule scores meaningfully.
  return {
    cls: "balanced",
    score: 0.1,
    signals: [{ name: "noPressure", value: 1, unit: "flag", weight: 0.1 }],
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round2(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}
