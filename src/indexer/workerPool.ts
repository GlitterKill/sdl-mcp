import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import * as os from "os";
import { findPackageRoot } from "../util/findPackageRoot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ParseTask {
  filePath: string;
  content: string;
  ext: string;
}

interface ParseResult {
  tree: any;
  symbols: Array<any>;
  imports: Array<any>;
  calls: Array<any>;
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
}

export class ParserWorkerPool {
  private workers: WorkerWithQueue[] = [];
  private queue: QueuedTask[] = [];
  private shuttingDown = false;

  constructor(private poolSize: number = Math.max(1, os.cpus().length - 1)) {
    for (let i = 0; i < poolSize; i++) {
      this.workers.push(this.createWorker(i));
    }
  }

  private createWorker(index: number): WorkerWithQueue {
    // Worker threads require compiled JS files
    // Resolve against the package root so this works from both src/ and dist/ builds.
    const packageRoot = findPackageRoot(__dirname);
    const workerPath = join(packageRoot, "dist", "indexer", "worker.js");
    const worker = new Worker(workerPath);

    worker.on("message", (msg) => {
      const workerWithQueue = this.workers.find((w) => w.worker === worker);
      if (!workerWithQueue || !workerWithQueue.currentTask) {
        return;
      }

      const item = workerWithQueue.currentTask;
      workerWithQueue.busy = false;
      workerWithQueue.currentTask = undefined;

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
      const workerWithQueue = this.workers.find((w) => w.worker === worker);
      if (workerWithQueue && workerWithQueue.currentTask) {
        workerWithQueue.currentTask.reject(error);
        workerWithQueue.busy = false;
        workerWithQueue.currentTask = undefined;
      }
      console.error(`Worker ${index} error:`, error);
      this.processQueue();
    });

    return { worker, busy: false };
  }

  async parse(
    filePath: string,
    content: string,
    ext: string,
  ): Promise<ParseResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        task: { filePath, content, ext },
        resolve,
        reject,
      });
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.shuttingDown) {
      return;
    }

    const availableWorker = this.workers.find((w) => !w.busy);
    if (!availableWorker || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item) {
      return;
    }

    availableWorker.busy = true;
    availableWorker.currentTask = item;
    availableWorker.worker.postMessage(item.task);

    this.processQueue();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
  }

  getPoolSize(): number {
    return this.poolSize;
  }
}
