type SchedulerOptions<T> = {
  delayMs: number;
  run: (key: string, payload: T) => Promise<void> | void;
};

type PendingJob<T> = {
  timer: ReturnType<typeof setTimeout>;
  completion: Promise<void>;
  resolveCompletion: () => void;
  rejectCompletion: (err: unknown) => void;
  payload: T;
  alreadyRun: boolean;
};

export function createDebouncedJobScheduler<T>(options: SchedulerOptions<T>) {
  const jobs = new Map<string, PendingJob<T>>();

  function schedule(key: string, payload: T): Promise<void> {
    const existing = jobs.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      if (!existing.alreadyRun) {
        existing.alreadyRun = true;
        existing.resolveCompletion(); // Unblock old waiters
      }
    }

    let resolveCompletion: () => void = () => undefined;
    let rejectCompletion: (err: unknown) => void = () => undefined;
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
          if (!current.alreadyRun) {
            current.alreadyRun = true;
            current.resolveCompletion();
          }
        } catch (err) {
          if (!current.alreadyRun) {
            current.alreadyRun = true;
            current.rejectCompletion(err);
          }
        } finally {
          // Double check it's still our job before deleting
          if (jobs.get(key) === current) {
            jobs.delete(key);
          }
        }
      })();
    }, options.delayMs);
    timer.unref();

    jobs.set(key, {
      timer,
      completion,
      resolveCompletion,
      rejectCompletion,
      payload,
      alreadyRun: false,
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
    if (!existing.alreadyRun) {
      existing.alreadyRun = true;
      existing.resolveCompletion();
    }
  }

  function cancelAll(): void {
    for (const key of jobs.keys()) {
      cancel(key);
    }
  }

  async function waitForIdle(): Promise<void> {
    const activeJobs = Array.from(jobs.values());
    if (activeJobs.length === 0) return;

    // Ref timers so the process stays alive while explicitly waiting
    for (const job of activeJobs) {
      job.timer.ref();
    }
    
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
