import { parentPort } from "worker_threads";
import { getAdapterForExtension } from "./adapter/registry.js";

interface WorkerMessage {
  filePath: string;
  content: string;
  ext: string;
}

interface WorkerResult {
  tree?: any;
  symbols: Array<any>;
  imports: Array<any>;
  calls: Array<any>;
  error?: string;
}

parentPort?.on("message", (msg: WorkerMessage) => {
  try {
    const adapter = getAdapterForExtension(msg.ext);
    if (!adapter) {
      parentPort?.postMessage({
        symbols: [],
        imports: [],
        calls: [],
        error: "No adapter for extension: " + msg.ext,
      } as WorkerResult);
      return;
    }

    const tree = adapter.parse(msg.content, msg.filePath);
    if (!tree) {
      parentPort?.postMessage({
        symbols: [],
        imports: [],
        calls: [],
      } as WorkerResult);
      return;
    }

    let extractedSymbols: ReturnType<typeof adapter.extractSymbols>;
    try {
      extractedSymbols = adapter.extractSymbols(
        tree,
        msg.content,
        msg.filePath,
      );
    } catch (error) {
      extractedSymbols = [];
    }

    const imports = adapter.extractImports(tree, msg.content, msg.filePath);
    const symbolsWithNodeIds = extractedSymbols.map((symbol) => ({
      nodeId: symbol.nodeId,
      kind: symbol.kind,
      name: symbol.name,
      exported: symbol.exported,
      range: symbol.range,
      signature: symbol.signature,
      visibility: symbol.visibility,
    }));

    const calls = adapter.extractCalls(
      tree,
      msg.content,
      msg.filePath,
      symbolsWithNodeIds,
    );

    const result: WorkerResult = {
      tree: null,
      symbols: symbolsWithNodeIds,
      imports,
      calls,
    };

    parentPort?.postMessage(result);
  } catch (error) {
    parentPort?.postMessage({
      symbols: [],
      imports: [],
      calls: [],
      error: error instanceof Error ? error.message : String(error),
    } as WorkerResult);
  }
});
