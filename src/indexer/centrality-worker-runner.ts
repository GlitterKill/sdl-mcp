import { Worker } from "node:worker_threads";

import type {
  KCoreResult,
  PageRankResult,
} from "./centrality-algorithms.js";
import type { CentralityWorkerData } from "./centrality-worker-thread.js";

export class CentralityWorkerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`centrality worker timed out after ${timeoutMs}ms`);
    this.name = "CentralityWorkerTimeoutError";
  }
}

export interface CentralityWorkerResult {
  pageRank: PageRankResult[];
  kCore: KCoreResult[];
}

export async function runCentralityWorker(
  input: CentralityWorkerData,
  timeoutMs: number,
): Promise<CentralityWorkerResult> {
  return new Promise((resolve, reject) => {
    const workerModule = import.meta.url.endsWith(".ts")
      ? "./centrality-worker-thread.ts"
      : "./centrality-worker-thread.js";
    const worker = new Worker(new URL(workerModule, import.meta.url), {
      workerData: input,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new CentralityWorkerTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref();

    worker.once("message", (message: CentralityWorkerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(message);
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled || code === 0) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`centrality worker exited with code ${code}`));
    });
  });
}
