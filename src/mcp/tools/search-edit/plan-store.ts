/**
 * In-memory plan handle store for `sdl.search.edit`.
 *
 * - TTL: entries expire after `PLAN_TTL_MS` (15 minutes by default)
 * - LRU: capped at `PLAN_CAPACITY` handles per process; oldest-touched
 *   evicted first
 * - Fail-closed: apply rejects missing, expired, or repo-mismatched
 *   handles, and the batch executor rejects handles whose per-file
 *   sha256/mtime preconditions have drifted.
 *
 * Handles die on server restart.
 */

import { randomBytes } from "crypto";

import type { FileWriteResponse } from "../../tools.js";

export const PLAN_TTL_MS = 15 * 60 * 1000;
export const PLAN_CAPACITY = 16;
export const MAX_AGGREGATE_PLAN_BYTES = 64 * 1024 * 1024; // 64 MB

/** Per-file precondition snapshot taken at preview time. */
export interface PlanPrecondition {
  relPath: string;
  absPath: string;
  /** null = file did not exist at preview time. */
  sha256: string | null;
  /** null = file did not exist at preview time. */
  mtimeMs: number | null;
}

/**
 * Deterministic edit instruction for a single file. The planner emits
 * one of these per file; the batch executor consumes them verbatim
 * and does not re-query the planner.
 */
export interface PlannedFileEdit {
  relPath: string;
  absPath: string;
  /** Exact new bytes for the file, already computed at preview time. */
  newContent: string;
  /** Whether to create a `.bak` backup before writing. */
  createBackup: boolean;
  fileExists: boolean;
  indexedSource: boolean;
  matchCount: number;
  editMode: FileWriteResponse["mode"];
}

export interface StoredPlan {
  planHandle: string;
  repoId: string;
  createdAt: number;
  expiresAt: number;
  /**
   * Default createBackup value used when preview was computed. Apply
   * rejects an `overrideCreateBackup` that differs from this, per plan
   * spec: "optional createBackup override (must match preview
   * assumptions or apply is rejected)".
   */
  defaultCreateBackup: boolean;
  /** Set true when apply begins; prevents concurrent double-apply. */
  consumed: boolean;
  edits: PlannedFileEdit[];
  preconditions: PlanPrecondition[];
  /** Preview summary snapshot returned to the caller. */
  summary: Record<string, unknown>;
}

export interface PlanStoreOptions {
  ttlMs?: number;
  capacity?: number;
  clock?: () => number;
}

export class PlanStore {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly clock: () => number;
  private aggregateBytes = 0;

  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PlanStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? PLAN_TTL_MS;
    this.capacity = options.capacity ?? PLAN_CAPACITY;
    this.clock = options.clock ?? Date.now;
    // Periodic sweeper to avoid leaked buffers on quiet servers
    this.sweepTimer = setInterval(() => this.purgeExpired(), this.ttlMs);
    this.sweepTimer.unref();
  }

  create(
    repoId: string,
    edits: PlannedFileEdit[],
    preconditions: PlanPrecondition[],
    summary: Record<string, unknown>,
    defaultCreateBackup: boolean,
  ): StoredPlan {
    const now = this.clock();
    const planHandle = `se-${now.toString(36)}-${randomBytes(8).toString("hex")}`;
    const plan: StoredPlan = {
      planHandle,
      repoId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      defaultCreateBackup,
      consumed: false,
      edits,
      preconditions,
      summary,
    };
    const planBytes = edits.reduce(
      (sum, e) => sum + Buffer.byteLength(e.newContent, "utf-8"),
      0,
    );
    if (planBytes > MAX_AGGREGATE_PLAN_BYTES) {
      throw new Error(
        `Plan exceeds aggregate byte limit (${planBytes} > ${MAX_AGGREGATE_PLAN_BYTES})`,
      );
    }
    this.evictIfNeeded(planBytes);
    if (this.aggregateBytes + planBytes > MAX_AGGREGATE_PLAN_BYTES) {
      throw new Error(
        `Plan store aggregate byte limit exceeded (${this.aggregateBytes + planBytes} > ${MAX_AGGREGATE_PLAN_BYTES})`,
      );
    }
    this.aggregateBytes += planBytes;
    this.plans.set(planHandle, plan);
    return plan;
  }

  /** Returns the plan if present, unexpired, and not consumed; otherwise null. */
  get(planHandle: string): StoredPlan | null {
    this.purgeExpired();
    const plan = this.plans.get(planHandle);
    if (!plan) return null;
    if (this.clock() >= plan.expiresAt) {
      this.aggregateBytes -= plan.edits.reduce(
        (sum, e) => sum + Buffer.byteLength(e.newContent, "utf-8"),
        0,
      );
      this.plans.delete(planHandle);
      return null;
    }
    if (plan.consumed) return null;
    // LRU touch: move to end of insertion order.
    this.plans.delete(planHandle);
    this.plans.set(planHandle, plan);
    return plan;
  }

  /** Removes a handle regardless of state. */
  remove(planHandle: string): boolean {
    const plan = this.plans.get(planHandle);
    if (plan) {
      this.aggregateBytes -= plan.edits.reduce(
        (sum, e) => sum + Buffer.byteLength(e.newContent, "utf-8"),
        0,
      );
    }
    return this.plans.delete(planHandle);
  }

  /**
   * Atomically mark a plan as consumed (apply in progress).
   * Returns false if the plan is missing or already consumed —
   * callers rely on this to reject concurrent double-apply.
   */
  markConsumed(planHandle: string): boolean {
    const plan = this.plans.get(planHandle);
    if (!plan) return false;
    if (plan.consumed) return false;
    plan.consumed = true;
    return true;
  }

  /** Unmark consumed (allow retry after transient failure with no writes). */
  unmarkConsumed(planHandle: string): boolean {
    const plan = this.plans.get(planHandle);
    if (!plan) return false;
    plan.consumed = false;
    return true;
  }

  size(): number {
    this.purgeExpired();
    return this.plans.size;
  }

  clear(): void {
    this.plans.clear();
    this.aggregateBytes = 0;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private purgeExpired(): void {
    const now = this.clock();
    for (const [handle, plan] of this.plans) {
      if (now >= plan.expiresAt) {
        this.aggregateBytes -= plan.edits.reduce(
          (sum, e) => sum + Buffer.byteLength(e.newContent, "utf-8"),
          0,
        );
        this.plans.delete(handle);
      }
    }
  }

  private evictIfNeeded(incomingBytes = 0): void {
    this.purgeExpired();
    while (
      this.plans.size >= this.capacity ||
      this.aggregateBytes + incomingBytes > MAX_AGGREGATE_PLAN_BYTES
    ) {
      let oldestKey: string | undefined;
      for (const [key, plan] of this.plans) {
        if (!plan.consumed) { oldestKey = key; break; }
      }
      if (oldestKey === undefined) break;
      const evicted = this.plans.get(oldestKey);
      if (evicted) {
        this.aggregateBytes -= evicted.edits.reduce(
          (sum, e) => sum + Buffer.byteLength(e.newContent, "utf-8"),
          0,
        );
      }
      this.plans.delete(oldestKey);
    }
  }
}

let sharedStore: PlanStore | null = null;

export function getSearchEditPlanStore(): PlanStore {
  if (!sharedStore) {
    sharedStore = new PlanStore();
  }
  return sharedStore;
}

/** For tests: reset the process-wide store. */
export function resetSearchEditPlanStore(options?: PlanStoreOptions): void {
  if (sharedStore) {
    sharedStore.clear();
  }
  sharedStore = new PlanStore(options);
}
