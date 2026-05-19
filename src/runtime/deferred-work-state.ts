export type DeferredWorkKind = "derived-refresh";

export interface DeferredWorkProgress {
  phase?: string;
  current?: number;
  total?: number;
  percent?: number;
  message?: string;
}

export interface DeferredWorkStatus extends DeferredWorkProgress {
  key: string;
  kind: DeferredWorkKind;
  repoId: string;
  targetVersionId?: string;
  startedAt: number;
  updatedAt: number;
}

const activeDeferredWork = new Map<string, DeferredWorkStatus>();

function statusKey(kind: DeferredWorkKind, repoId: string): string {
  return `${kind}:${repoId}`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function derivePercent(progress: DeferredWorkProgress): number | undefined {
  if (typeof progress.percent === "number") {
    return clampPercent(progress.percent);
  }
  if (
    typeof progress.current === "number" &&
    typeof progress.total === "number" &&
    progress.total > 0
  ) {
    return clampPercent((progress.current / progress.total) * 100);
  }
  return undefined;
}

export function setDeferredWorkStatus(params: {
  kind: DeferredWorkKind;
  repoId: string;
  targetVersionId?: string;
  progress?: DeferredWorkProgress;
}): DeferredWorkStatus {
  const key = statusKey(params.kind, params.repoId);
  const now = Date.now();
  const existing = activeDeferredWork.get(key);
  const progress = params.progress ?? {};
  const next: DeferredWorkStatus = {
    key,
    kind: params.kind,
    repoId: params.repoId,
    targetVersionId: params.targetVersionId ?? existing?.targetVersionId,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
    ...(progress.phase !== undefined ? { phase: progress.phase } : {}),
    ...(progress.current !== undefined ? { current: progress.current } : {}),
    ...(progress.total !== undefined ? { total: progress.total } : {}),
    ...(progress.message !== undefined ? { message: progress.message } : {}),
  };
  const percent = derivePercent(progress);
  if (percent !== undefined) {
    next.percent = percent;
  } else if (existing?.percent !== undefined) {
    next.percent = existing.percent;
  }
  activeDeferredWork.set(key, next);
  return next;
}

export function clearDeferredWorkStatus(
  kind: DeferredWorkKind,
  repoId: string,
): void {
  activeDeferredWork.delete(statusKey(kind, repoId));
}

export function getDeferredWorkStatuses(): DeferredWorkStatus[] {
  return [...activeDeferredWork.values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
}

export function getActiveDeferredWorkStatus(): DeferredWorkStatus | undefined {
  return getDeferredWorkStatuses()[0];
}

export function formatDeferredWorkStatus(status: DeferredWorkStatus): string {
  const parts = [`${status.kind} for repo ${status.repoId}`];
  if (status.phase) parts.push(status.phase);
  if (typeof status.percent === "number") parts.push(`${status.percent}%`);
  if (status.message) parts.push(status.message);
  return `Deferred work is running (${parts.join(", ")}); foreground tool calls will wait for it to finish.`;
}

export function _resetDeferredWorkStateForTesting(): void {
  activeDeferredWork.clear();
}
