export interface ToolTraceEvent {
  repoId: string;
  taskType: string;
  tool: string;
  symbolId?: string;
}

export interface PrefetchModel {
  trainedAt: string;
  nextToolByPair: Record<string, string>;
}

function pairKey(a: string, b: string): string {
  return `${a}=>${b}`;
}

export function trainPrefetchModel(events: ToolTraceEvent[]): PrefetchModel {
  const transitions = new Map<string, Map<string, number>>();
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
    const best = Array.from(bucket.entries()).sort((a, b) => b[1] - a[1])[0];
    if (best) {
      nextToolByPair[key] = best[0];
    }
  }

  return {
    trainedAt: new Date().toISOString(),
    nextToolByPair,
  };
}

export function predictNextTool(
  model: PrefetchModel,
  previousTool: string,
  currentTool: string,
): string | null {
  return model.nextToolByPair[pairKey(previousTool, currentTool)] ?? null;
}
