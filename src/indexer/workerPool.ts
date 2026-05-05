import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import * as os from "os";
import { findPackageRoot } from "../util/findPackageRoot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import type { ExtractedCall } from "./treesitter/extractCalls.js";
import type { ExtractedImport } from "./treesitter/extractImports.js";
import type { SymbolWithNodeId } from "./worker.js";
import { logger } from "../util/logger.js";

interface ParseTask {
  filePath: string;
  content: string;
  ext: string;
}

interface ParseResult {
  tree?: null;
  symbols: Array<SymbolWithNodeId>;
  imports: Array<ExtractedImport>;
  calls: Array<ExtractedCall>;
}

interface QueuedTask {
  task: ParseTask;
  resolve: (result: ParseResult) => void;
  reject: (error: Error) => void;
}

interface WorkerWithQueue {
  worker: Worker;
  busy: boolean;
  currentTask?: QueuedTask;
  /**
   * Set once a crash handler (error/exit/messageerror) has begun replacing
   * this worker. Subsequent crash events for the same Worker instance are
   * no-ops, preventing the double-splice bug where both `error` and `exit`
   * fire and remove a healthy replacement worker.
   */
  replaced?: boolean;
}

/**
 * Default cap on the parse() backlog. When the queue is full, parse() rejects
 * immediately rather than letting unbounded backpressure accumulate.
 */
export const DEFAULT_MAX_QUEUE_SIZE = 10_000;

export interface ParserWorkerPoolOptions {
  poolSize?: number;
  maxQueueSize?: number;
}

export class ParserWorkerPool {
  private workers: WorkerWithQueue[] = [];
  private queue: QueuedTask[] = [];
  private shuttingDown = false;
  private readonly poolSize: number;
  private readonly maxQueueSize: number;

  constructor(
    poolSizeOrOptions: number | ParserWorkerPoolOptions = Math.max(
      1,
      os.cpus().length - 1,
    ),
  ) {
    const opts: ParserWorkerPoolOptions =
      typeof poolSizeOrOptions === "number"
        ? { poolSize: poolSizeOrOptions }
        : poolSizeOrOptions;
    this.poolSize = Math.max(1, opts.poolSize ?? Math.max(1, os.cpus().length - 1));
    this.maxQueueSize = Math.max(1, opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
  }

  /**
   * Centralised crash handler. Invoked from `error`, `exit`, and
   * `messageerror` handlers. The first call replaces the worker; subsequent
   * calls for the same worker instance are no-ops.
   */
  private handleWorkerCrash(
    workerWithQueue: WorkerWithQueue,
    error: Error,
    originalIndex: number,
  ): void {
    if (workerWithQueue.replaced) {
      return;
    }
    workerWithQueue.replaced = true;

    const workerIdx = this.workers.findIndex((w) => w === workerWithQueue);
    if (workerIdx === -1) {
      return;
    }

    if (workerWithQueue.currentTask) {
      try {
        workerWithQueue.currentTask.reject(error);
      } catch {
        // Best-effort reject; downstream consumer may have detached.
      }
      workerWithQueue.currentTask = undefined;
      workerWithQueue.busy = false;
    }

    this.workers.splice(workerIdx, 1);
    if (!this.shuttingDown) {
      this.workers.push(this.createWorker(this.workers.length));
    }
    logger.warn("Worker crashed and was replaced", {
      originalIndex,
      error: error.message,
    });
    this.processQueue();
  }

  private createWorker(index: number): WorkerWithQueue {
    // Worker threads require compiled JS files
    // Resolve against the package root so this works from both src/ and dist/ builds.
    const packageRoot = findPackageRoot(__dirname);
    const workerPath = join(packageRoot, "dist", "indexer", "worker.js");
    const worker = new Worker(workerPath);
    const wq: WorkerWithQueue = { worker, busy: false };

    worker.on("message", (msg) => {
      if (wq.replaced || !wq.currentTask) {
        return;
      }

      const item = wq.currentTask;
      wq.busy = false;
      wq.currentTask = undefined;

      if (msg.error) {
        item.reject(new Error(msg.error));
      } else {
        item.resolve({
          tree: msg.tree,
          symbols: msg.symbols,
          imports: msg.imports,
          calls: msg.calls,
        });
      }
      this.processQueue();
    });

    worker.on("error", (error) => {
      this.handleWorkerCrash(
        wq,
        error instanceof Error ? error : new Error(String(error)),
        index,
      );
    });

    worker.on("exit", (code) => {
      // Clean exits during shutdown are expected.
      if (this.shuttingDown && code === 0) {
        return;
      }
      this.handleWorkerCrash(
        wq,
        new Error(`Worker ${index} exited with code ${code}`),
        index,
      );
    });

    // `messageerror` fires when a posted message fails to deserialise.
    // Without this handler the in-flight task hangs forever.
    worker.on("messageerror", (error) => {
      this.handleWorkerCrash(
        wq,
        error instanceof Error
          ? error
          : new Error(`Worker ${index} messageerror: ${String(error)}`),
        index,
      );
    });

    return wq;
  }

  async parse(
    filePath: string,
    content: string,
    ext: string,
  ): Promise<ParseResult> {
    if (this.shuttingDown) {
      throw new Error("Worker pool shut down");
    }
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error(
        `Worker pool queue full (max=${this.maxQueueSize}, depth=${this.queue.length})`,
      );
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        task: { filePath, content, ext },
        resolve,
        reject,
      });
      this.processQueue();
    });
  }

  /**
   * Drain the queue, dispatching tasks to free workers. Uses a `while` loop
   * (not recursion) so the depth does not scale with queue length.
   */
  private processQueue(): void {
    if (this.shuttingDown) {
      return;
    }

    while (this.queue.length > 0) {
      let availableWorker = this.workers.find((w) => !w.busy && !w.replaced);
      if (!availableWorker && this.workers.length < this.poolSize) {
        availableWorker = this.createWorker(this.workers.length);
        this.workers.push(availableWorker);
      }
      if (!availableWorker) {
        return;
      }
      const item = this.queue.shift();
      if (!item) {
        return;
      }
      availableWorker.busy = true;
      availableWorker.currentTask = item;
      availableWorker.worker.postMessage(item.task);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // Reject all pending queue items so callers don't hang
    for (const item of this.queue) {
      item.reject(new Error("Worker pool shut down"));
    }
    this.queue.length = 0;
    // Reject in-flight tasks so callers don't hang
    for (const w of this.workers) {
      if (w.currentTask) {
        w.currentTask.reject(new Error("Worker pool shut down"));
        w.currentTask = undefined;
        w.busy = false;
      }
    }
    // Use allSettled so a single terminate() rejection doesn't leak the rest.
    const results = await Promise.allSettled(
      this.workers.map((w) => w.worker.terminate()),
    );
    for (const r of results) {
      if (r.status === "rejected") {
        logger.warn("Worker terminate failed during shutdown", {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
  }

  getPoolSize(): number {
    return this.poolSize;
  }

  /** Test/diagnostic accessor — current queue depth. */
  getQueueDepth(): number {
    return this.queue.length;
  }

  /** Test/diagnostic accessor — configured queue cap. */
  getMaxQueueSize(): number {
    return this.maxQueueSize;
  }
}
