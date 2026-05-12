export interface ToolTimingDiagnostics {
  timings: {
    totalMs: number;
    phases: Record<string, number>;
  };
}

type DiagnosticCarrier = {
  diagnostics?: ToolTimingDiagnostics;
};

function roundMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

export class ToolPhaseTimer {
  private readonly startedAt = performance.now();
  private readonly phases = new Map<string, number>();

  start(): number {
    return performance.now();
  }

  record(phase: string, startedAt: number): void {
    this.add(phase, performance.now() - startedAt);
  }

  add(phase: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.phases.set(phase, (this.phases.get(phase) ?? 0) + durationMs);
  }

  async time<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = this.start();
    try {
      return await fn();
    } finally {
      this.record(phase, startedAt);
    }
  }

  timeSync<T>(phase: string, fn: () => T): T {
    const startedAt = this.start();
    try {
      return fn();
    } finally {
      this.record(phase, startedAt);
    }
  }

  snapshot(): ToolTimingDiagnostics {
    const phases: Record<string, number> = {};
    for (const [phase, durationMs] of this.phases.entries()) {
      phases[phase] = roundMs(durationMs);
    }
    return {
      timings: {
        totalMs: roundMs(performance.now() - this.startedAt),
        phases,
      },
    };
  }
}

export function hasTimingDiagnostics(value: unknown): value is ToolTimingDiagnostics {
  if (!value || typeof value !== "object") return false;
  const timings = (value as { timings?: unknown }).timings;
  if (!timings || typeof timings !== "object") return false;
  return (
    typeof (timings as { totalMs?: unknown }).totalMs === "number" &&
    typeof (timings as { phases?: unknown }).phases === "object" &&
    (timings as { phases?: unknown }).phases !== null
  );
}

export function mergeTimingDiagnostics(
  existing: unknown,
  next: ToolTimingDiagnostics,
): ToolTimingDiagnostics {
  if (!hasTimingDiagnostics(existing)) return next;
  return {
    timings: {
      totalMs: Math.max(existing.timings.totalMs, next.timings.totalMs),
      phases: {
        ...existing.timings.phases,
        ...next.timings.phases,
      },
    },
  };
}

export function attachTimingDiagnostics<T>(
  payload: T,
  diagnostics: ToolTimingDiagnostics,
): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const carrier = payload as DiagnosticCarrier;
  carrier.diagnostics = mergeTimingDiagnostics(carrier.diagnostics, diagnostics);
  return payload;
}
