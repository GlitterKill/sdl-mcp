type SchedulerOptions<T> = {
  delayMs: number;
  run: (key: string, payload: T) => Promise<void> | void;
};

type PendingJob<T> = {
  timer: ReturnType<typeof setTimeout>;
  completion: Promise<void>;
  resolveCompletion: () => void;
  rejectCompletion: (err: any) => void;
  payload: T;
};

export function createDebouncedJobScheduler<T>(options: SchedulerOptions<T>) {
  const jobs = new Map<string, PendingJob<T>>();

  function schedule(key: string, payload: T): Promise<void> {
    const existing = jobs.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolveCompletion(); // Unblock old waiters
    }

    let resolveCompletion: () => void = () => undefined;
    let rejectCompletion: (err: any) => void = () => undefined;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const timer = setTimeout(() => {
      void (async () => {
        const current = jobs.get(key);
        if (!current) {
          return;
        }
        try {
          await options.run(key, current.payload);
          current.resolveCompletion();
        } catch (err) {
          current.rejectCompletion(err);
        } finally {
          jobs.delete(key);
        }
      })();
    }, options.delayMs);

    jobs.set(key, {
      timer,
      completion,
      resolveCompletion,
      rejectCompletion,
      payload,
    });

    return completion;
  }

  function cancel(key: string): void {
    const existing = jobs.get(key);
    if (!existing) {
      return;
    }
    clearTimeout(existing.timer);
    jobs.delete(key);
    existing.resolveCompletion();
  }

  function cancelAll(): void {
    for (const key of jobs.keys()) {
      cancel(key);
    }
  }

  async function waitForIdle(): Promise<void> {
    const activeJobs = Array.from(jobs.values());
    if (activeJobs.length === 0) return;
    
    // We use allSettled because some jobs might be cancelled/resolved early
    // or might fail, and we just want to wait until the queue is empty.
    await Promise.allSettled(activeJobs.map((job) => job.completion));
  }

  return {
    schedule,
    cancel,
    cancelAll,
    waitForIdle,
    size(): number {
      return jobs.size;
    },
  };
}
