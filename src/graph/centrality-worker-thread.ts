import { parentPort, workerData } from "node:worker_threads";

import type { CentralityInput } from "./centrality-algorithms.js";

export interface CentralityWorkerData extends CentralityInput {
  pageRankEnabled: boolean;
  kCoreEnabled: boolean;
}

const input = workerData as CentralityWorkerData;
const algorithmsModule = await import(
  import.meta.url.endsWith(".ts")
    ? "./centrality-algorithms.ts"
    : "./centrality-algorithms.js"
);

parentPort?.postMessage({
  pageRank: input.pageRankEnabled
    ? algorithmsModule.computePageRank(input)
    : [],
  kCore: input.kCoreEnabled ? algorithmsModule.computeKCore(input) : [],
});
