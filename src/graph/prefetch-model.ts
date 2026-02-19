export interface ToolTraceEvent {
  repoId: string;
  taskType: string;
  tool: string;
  symbolId?: string;
  timestamp?: number;
}

export interface PrefetchModel {
  trainedAt: string;
  nextToolByPair: Record<string, string>;
  transitionCounts: Record<string, number>;
  minSamples: number;
}

export interface ModelGatingConfig {
  enabled: boolean;
  minSamplesForPrediction: number;
  confidenceThreshold: number;
  fallbackToDeterministic: boolean;
  retrainIntervalMs: number;
}

export interface StrategyMetrics {
  strategy: string;
  hitRate: number;
  wasteRate: number;
  avgLatencyReductionMs: number;
  samples: number;
  cacheHits: number;
  cacheMisses: number;
  wastedPrefetch: number;
}

const DEFAULT_GATING_CONFIG: ModelGatingConfig = {
  enabled: true,
  minSamplesForPrediction: 5,
  confidenceThreshold: 0.3,
  fallbackToDeterministic: true,
  retrainIntervalMs: 60_000,
};

let currentModel: PrefetchModel | null = null;
let gatingConfig: ModelGatingConfig = { ...DEFAULT_GATING_CONFIG };
const traceBuffer: ToolTraceEvent[] = [];
const strategyMetricsMap = new Map<string, StrategyMetrics>();
let lastTrainingTime = 0;
const recentToolCalls: string[] = [];

function pairKey(a: string, b: string): string {
  return `${a}=>${b}`;
}

export function configureGating(config: Partial<ModelGatingConfig>): void {
  gatingConfig = { ...gatingConfig, ...config };
}

export function getGatingConfig(): ModelGatingConfig {
  return { ...gatingConfig };
}

export function recordToolTrace(event: ToolTraceEvent): void {
  const enriched: ToolTraceEvent = {
    ...event,
    timestamp: event.timestamp ?? Date.now(),
  };
  traceBuffer.push(enriched);
  recentToolCalls.push(event.tool);
  if (recentToolCalls.length > 10) {
    recentToolCalls.shift();
  }
  if (traceBuffer.length > 1000) {
    const keep = traceBuffer.slice(-500);
    traceBuffer.length = 0;
    traceBuffer.push(...keep);
  }
  if (
    gatingConfig.enabled &&
    Date.now() - lastTrainingTime > gatingConfig.retrainIntervalMs
  ) {
    retrainModel();
  }
}

export function retrainModel(): PrefetchModel | null {
  if (traceBuffer.length < gatingConfig.minSamplesForPrediction) {
    return null;
  }
  currentModel = trainPrefetchModel(traceBuffer);
  lastTrainingTime = Date.now();
  return currentModel;
}

export function trainPrefetchModel(events: ToolTraceEvent[]): PrefetchModel {
  const transitions = new Map<string, Map<string, number>>();
  const transitionCounts: Record<string, number> = {};

  for (let i = 0; i < events.length - 2; i++) {
    const a = events[i];
    const b = events[i + 1];
    const c = events[i + 2];
    const key = pairKey(a.tool, b.tool);
    const bucket = transitions.get(key) ?? new Map<string, number>();
    bucket.set(c.tool, (bucket.get(c.tool) ?? 0) + 1);
    transitions.set(key, bucket);
  }

  const nextToolByPair: Record<string, string> = {};
  for (const [key, bucket] of transitions) {
    const entries = Array.from(bucket.entries()).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    transitionCounts[key] = total;
    if (entries[0] && total >= gatingConfig.minSamplesForPrediction) {
      const confidence = entries[0][1] / total;
      if (confidence >= gatingConfig.confidenceThreshold) {
        nextToolByPair[key] = entries[0][0];
      }
    }
  }

  return {
    trainedAt: new Date().toISOString(),
    nextToolByPair,
    transitionCounts,
    minSamples: gatingConfig.minSamplesForPrediction,
  };
}

export function getCurrentModel(): PrefetchModel | null {
  return currentModel;
}

export function predictNextTool(
  model: PrefetchModel,
  previousTool: string,
  currentTool: string,
): string | null {
  const key = pairKey(previousTool, currentTool);
  const predicted = model.nextToolByPair[key];
  if (!predicted) return null;
  const count = model.transitionCounts[key] ?? 0;
  if (count < model.minSamples) return null;
  return predicted;
}

export function predictNextToolFromRecent(): string | null {
  if (!currentModel || recentToolCalls.length < 2) {
    return null;
  }
  const prev = recentToolCalls[recentToolCalls.length - 2];
  const curr = recentToolCalls[recentToolCalls.length - 1];
  return predictNextTool(currentModel, prev, curr);
}

export function getPredictionConfidence(
  model: PrefetchModel,
  previousTool: string,
  currentTool: string,
): number {
  const key = pairKey(previousTool, currentTool);
  const count = model.transitionCounts[key] ?? 0;
  if (count < model.minSamples) return 0;
  const predicted = model.nextToolByPair[key];
  if (!predicted) return 0;
  const transitions = new Map<string, number>();
  for (let i = 0; i < traceBuffer.length - 2; i++) {
    const a = traceBuffer[i];
    const b = traceBuffer[i + 1];
    const c = traceBuffer[i + 2];
    if (a.tool === previousTool && b.tool === currentTool) {
      transitions.set(c.tool, (transitions.get(c.tool) ?? 0) + 1);
    }
  }
  const total = Array.from(transitions.values()).reduce((s, v) => s + v, 0);
  const predictedCount = transitions.get(predicted) ?? 0;
  return total > 0 ? predictedCount / total : 0;
}

export function computePriorityBoost(
  taskType: string,
  predictedTool: string | null,
): number {
  if (!gatingConfig.enabled || !predictedTool) {
    return 0;
  }
  const predictedToPrefetchPriority: Record<string, Record<string, number>> = {
    card: {
      "slice-frontier": 20,
      "file-open": 10,
      "delta-blast": 15,
      "startup-warm": 5,
    },
    slice: {
      "slice-frontier": 25,
      "file-open": 5,
      "delta-blast": 20,
      "startup-warm": 10,
    },
    search: {
      "slice-frontier": 15,
      "file-open": 15,
      "delta-blast": 10,
      "startup-warm": 5,
    },
    skeleton: {
      "slice-frontier": 10,
      "file-open": 20,
      "delta-blast": 5,
      "startup-warm": 8,
    },
    hotPath: {
      "slice-frontier": 15,
      "file-open": 10,
      "delta-blast": 15,
      "startup-warm": 5,
    },
  };
  const mapping = predictedToPrefetchPriority[predictedTool];
  if (!mapping) return 0;
  return mapping[taskType] ?? 0;
}

export function recordStrategyMetrics(
  strategy: string,
  hit: boolean,
  latencyReductionMs: number,
): void {
  const existing = strategyMetricsMap.get(strategy) ?? {
    strategy,
    hitRate: 0,
    wasteRate: 0,
    avgLatencyReductionMs: 0,
    samples: 0,
    cacheHits: 0,
    cacheMisses: 0,
    wastedPrefetch: 0,
  };
  existing.samples += 1;
  if (hit) {
    existing.cacheHits += 1;
    existing.avgLatencyReductionMs =
      existing.avgLatencyReductionMs * 0.8 + latencyReductionMs * 0.2;
  } else {
    existing.cacheMisses += 1;
  }
  existing.hitRate = existing.cacheHits / existing.samples;
  existing.wasteRate = existing.wastedPrefetch / Math.max(1, existing.samples);
  strategyMetricsMap.set(strategy, existing);
}

export function recordWastedPrefetch(strategy: string): void {
  const existing = strategyMetricsMap.get(strategy) ?? {
    strategy,
    hitRate: 0,
    wasteRate: 0,
    avgLatencyReductionMs: 0,
    samples: 0,
    cacheHits: 0,
    cacheMisses: 0,
    wastedPrefetch: 0,
  };
  existing.wastedPrefetch += 1;
  existing.wasteRate = existing.wastedPrefetch / Math.max(1, existing.samples);
  strategyMetricsMap.set(strategy, existing);
}

export function getStrategyMetrics(strategy: string): StrategyMetrics | null {
  return strategyMetricsMap.get(strategy) ?? null;
}

export function getAllStrategyMetrics(): StrategyMetrics[] {
  return Array.from(strategyMetricsMap.values());
}

export function getTraceBuffer(): ToolTraceEvent[] {
  return [...traceBuffer];
}

export function clearTraceBuffer(): void {
  traceBuffer.length = 0;
}

export function resetModel(): void {
  currentModel = null;
  lastTrainingTime = 0;
  recentToolCalls.length = 0;
  strategyMetricsMap.clear();
}
