/**
 * Concurrency limiter utility for controlling parallel operations.
 *
 * Provides a simple semaphore-based mechanism to limit the number of
 * concurrent operations, preventing resource exhaustion and improving
 * performance under load.
 *
 * @example
 * ```typescript
 * const limiter = new ConcurrencyLimiter(4); // Limit to 4 concurrent operations
 * await limiter.run(() => readFileAsync(path));
 * ```
 */

export interface ConcurrencyLimiterOptions {
  /**
   * Maximum number of concurrent operations allowed.
   */
  maxConcurrency: number;

  /**
   * Optional timeout for queued operations in milliseconds.
   * If not provided, operations wait indefinitely.
   */
  queueTimeoutMs?: number;
}

export class ConcurrencyLimiter {
  private maxConcurrency: number;
  private queueTimeoutMs: number | undefined;
  private activeCount: number;
  private queue: Array<{
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    task: () => Promise<unknown>;
    taskTimeoutMs?: number;
  }>;
  private drainResolvers: Array<() => void> = [];

  constructor(options: ConcurrencyLimiterOptions) {
    if (options.maxConcurrency < 1) {
      throw new Error("maxConcurrency must be at least 1");
    }

    this.maxConcurrency = options.maxConcurrency;
    this.queueTimeoutMs = options.queueTimeoutMs;
    this.activeCount = 0;
    this.queue = [];
  }

  /**
   * Executes a task within the concurrency limit.
   *
   * @param task - Async function to execute
   * @param timeoutMs - Optional timeout override for this specific task
   * @returns Promise that resolves with the task's result
   */
  async run<T>(task: () => Promise<T>, timeoutMs?: number): Promise<T> {
    if (this.activeCount < this.maxConcurrency) {
      return this.executeTask(task, timeoutMs);
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = timeoutMs ?? this.queueTimeoutMs ?? undefined;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const item = {
        resolve: resolve as (value: unknown) => void,
        reject,
        task: () => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          return task();
        },
        // Preserve the execution timeout for when the task is dequeued (H8)
        taskTimeoutMs: timeoutMs,
      };

      if (timeout) {
        timeoutHandle = setTimeout(() => {
          const index = this.queue.indexOf(item);
          if (index !== -1) {
            this.queue.splice(index, 1);
          }
          reject(
            new Error(`ConcurrencyLimiter queue timeout after ${timeout}ms`),
          );
        }, timeout);
        timeoutHandle.unref();
      }

      this.queue.push(item);
    });
  }

  private async executeTask<T>(
    task: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    this.activeCount++;

    // releaseSlot is called exactly once, after the underlying task
    // settles OR if no task was started. This keeps the slot occupied
    // until the real work finishes, even if a timeout fires first.
    const releaseSlot = (): void => {
      this.activeCount--;
      this.processQueue();
      this.notifyDrainIfIdle();
    };

    if (timeoutMs) {
      const taskPromise = task();
      let timeoutHandle: NodeJS.Timeout | undefined;
      let timedOut = false;

      try {
        const result = await Promise.race([
          taskPromise,
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              timedOut = true;
              reject(new Error(`Task timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            timeoutHandle.unref();
          }),
        ]);

        // Task won the race — clear timeout, release slot immediately
        if (timeoutHandle) clearTimeout(timeoutHandle);
        releaseSlot();
        return result;
      } catch (err) {
        if (timedOut) {
          // Timeout won the race. The underlying task is still running.
          // Keep the slot occupied until it settles, then release.
          taskPromise.catch(() => {}).finally(releaseSlot);
        } else {
          // Task itself threw — release slot now
          if (timeoutHandle) clearTimeout(timeoutHandle);
          releaseSlot();
        }
        throw err;
      }
    }

    // No timeout — simple path
    try {
      return await task();
    } finally {
      releaseSlot();
    }
  }

  private processQueue(): void {
    while (this.queue.length > 0 && this.activeCount < this.maxConcurrency) {
      const item = this.queue.shift();
      if (item) {
        // Pass the preserved execution timeout through to executeTask (H8)
        this.executeTask(item.task, item.taskTimeoutMs)
          .then((result) => item.resolve(result))
          .catch((error) => item.reject(error));
      }
    }
  }

  /**
   * Gets current statistics about the limiter.
   *
   * @returns Object with active count and queue length
   */
  getStats(): { active: number; queued: number } {
    return {
      active: this.activeCount,
      queued: this.queue.length,
    };
  }

  /**
   * Clears all pending tasks from the queue.
   *
   * @param error - Optional error to reject all queued tasks with
   */
  clearQueue(error?: Error): void {
    const errorToUse = error ?? new Error("ConcurrencyLimiter queue cleared");

    for (const item of this.queue) {
      item.reject(errorToUse);
    }

    this.queue.length = 0;
    // Defensively notify drain waiters in case queue was the only
    // thing keeping the limiter "busy" (M9).
    this.notifyDrainIfIdle();
  }

  private notifyDrainIfIdle(): void {
    if (this.activeCount === 0 && this.queue.length === 0) {
      const resolvers = this.drainResolvers;
      this.drainResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  /**
   * Waits for all active tasks to complete.
   *
   * @returns Promise that resolves when no tasks are active
   */
  async drain(): Promise<void> {
    if (this.activeCount === 0 && this.queue.length === 0) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }
}

/**
 * Creates a limiter for file system operations.
 *
 * @param concurrency - Maximum concurrent file operations
 * @returns Configured ConcurrencyLimiter
 */
export function createFileIOLimiter(concurrency: number): ConcurrencyLimiter {
  return new ConcurrencyLimiter({
    maxConcurrency: concurrency,
  });
}

/**
 * Creates a limiter for database operations.
 *
 * @param concurrency - Maximum concurrent database queries
 * @returns Configured ConcurrencyLimiter
 */
export function createDbIOLimiter(concurrency: number): ConcurrencyLimiter {
  return new ConcurrencyLimiter({
    maxConcurrency: concurrency,
  });
}
