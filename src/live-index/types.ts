export const BUFFER_EVENT_TYPES = [
  "open",
  "change",
  "save",
  "close",
  "checkpoint",
] as const;

export type BufferEventType = (typeof BUFFER_EVENT_TYPES)[number];

export interface BufferSelection {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface BufferCursor {
  line: number;
  col: number;
}

export interface BufferUpdateInput {
  repoId: string;
  eventType: BufferEventType;
  filePath: string;
  content: string;
  language?: string;
  version: number;
  dirty: boolean;
  timestamp: string;
  cursor?: BufferCursor;
  selections?: BufferSelection[];
}

export interface BufferUpdateResult {
  accepted: boolean;
  repoId: string;
  overlayVersion: number;
  parseScheduled: boolean;
  checkpointScheduled: boolean;
  warnings: string[];
}

export interface CheckpointRequest {
  repoId: string;
  reason?: string;
}

export interface CheckpointResult {
  repoId: string;
  requested: boolean;
  checkpointId: string;
  pendingBuffers: number;
  checkpointedFiles: number;
  failedFiles: number;
  lastCheckpointAt: string | null;
}

export interface LiveStatus {
  repoId: string;
  enabled: boolean;
  pendingBuffers: number;
  dirtyBuffers: number;
  parseQueueDepth: number;
  checkpointPending: boolean;
  lastBufferEventAt: string | null;
  lastCheckpointAt: string | null;
  lastCheckpointAttemptAt?: string | null;
  lastCheckpointResult?: "success" | "partial" | "failed" | null;
  lastCheckpointError?: string | null;
  lastCheckpointReason?: string | null;
  reconcileQueueDepth?: number;
  oldestReconcileAt?: string | null;
  lastReconciledAt?: string | null;
  reconcileInflight?: boolean;
  reconcileLastError?: string | null;
}

export interface LiveIndexCoordinator {
  pushBufferUpdate(input: BufferUpdateInput): Promise<BufferUpdateResult>;
  checkpointRepo(input: CheckpointRequest): Promise<CheckpointResult>;
  getLiveStatus(repoId: string): Promise<LiveStatus>;
}
