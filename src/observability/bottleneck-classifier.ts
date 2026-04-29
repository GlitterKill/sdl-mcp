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
  /** Heap total in MB (V8 currently committed heap). 0 means "unknown".
   *  Note: this is the *committed* heap, not the limit. Between GC cycles V8
   *  fills it close to capacity even when idle, so prefer `heapLimitMb` for
   *  pressure ratios. */
  heapTotalMb: number;
  /** Heap size limit (V8 `heap_size_limit`, i.e. --max-old-space-size) in MB.
   *  0 / undefined means "unknown". When > 0, this takes precedence over
   *  `heapTotalMb` for the heap-pressure ratio. */
  heapLimitMb?: number;
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
 *  - memory_pressure: rssMb > 1500 OR heapUsed/(heapLimit ∥ heapTotal) > 0.85
 *                     (heapLimit = V8 heap_size_limit; heapTotal is fallback)
 *  - db_latency:      dbLatencyP95Ms > 200 OR poolWriteQueuedAvg > 5
 *  - indexer_parse:   indexerParseP95Ms > 500
 *  - io_throughput:   ioThroughputMbPerSec / saturationThreshold >= 0.85
 *  - balanced:        no separate rule — returned by the MIN_DOMINANT_SCORE
 *                     short-circuit when top.score < 0.15.
 *
 * Confidence:
 *   - Dominant branch: (top - runnerUp) / max(top, 1e-6), clamped to [0, 1].
 *   - Floor branch:    1 - top.score / MIN_DOMINANT_SCORE, clamped to [0, 1].
 */
/**
 * Minimum score required for a non-balanced rule to be considered the dominant
 * bottleneck. Below this, the classifier returns "balanced" regardless of
 * which rule technically scored highest. Prevents trivial signals (e.g. V8
 * heap-fill cycles on an idle process) from being labelled as bottlenecks.
 */
const MIN_DOMINANT_SCORE = 0.15;

export function classifyBottleneck(input: ClassifierInput): BottleneckSummary {
  const rules: RuleScore[] = [
    scoreCpu(input),
    scoreMemory(input),
    scoreDb(input),
    scoreIndexer(input),
    scoreIo(input),
    // Note: no `scoreBalanced` here — the MIN_DOMINANT_SCORE floor below
    // owns the "nothing's wrong" verdict and short-circuits before the sort.
  ];

  rules.sort((a, b) => b.score - a.score);
  const top = rules[0];
  const runnerUp = rules[1];

  // Absolute floor — below this, no rule has flagged a meaningful bottleneck.
  // Surface "balanced" rather than the strongest noise (e.g. heap-fill noise
  // from V8 idle GC behaviour).
  //
  // Confidence semantics on this branch differ from the dominant branch:
  //   - dominant branch: margin-based, "how much does top beat runner-up?"
  //   - floor branch:    distance-from-floor, "how confident are we that
  //                       NO rule is meaningfully active?"
  // At top.score = 0 → confidence 1.0 (definitely idle).
  // At top.score ≈ MIN_DOMINANT_SCORE → confidence ≈ 0 (about to flip into a
  // real bottleneck classification). Both branches still answer the same
  // question to the dashboard: "how confident are we in `dominant`?".
  if (top.score < MIN_DOMINANT_SCORE) {
    return {
      dominant: "balanced",
      confidence: clamp01(1 - top.score / MIN_DOMINANT_SCORE),
      topSignals: [],
    };
  }

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
  const { rssMb, heapUsedMb, heapTotalMb, heapLimitMb } = input;
  const rssRatio = clamp01((rssMb - 1500) / 1500); // 0 at 1500MB, 1 at 3000MB
  // Prefer heapLimitMb (V8 heap_size_limit) — actual ceiling. Fall back to
  // heapTotalMb only when the limit is unknown; heapTotalMb is V8's currently
  // committed heap which inflates ratio toward 1.0 between GCs even on idle.
  const heapDenom =
    heapLimitMb !== undefined && heapLimitMb > 0 ? heapLimitMb : heapTotalMb;
  const heapRatio = heapDenom > 0 ? heapUsedMb / heapDenom : 0;
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
