import { parentPort } from "worker_threads";
import type { SyntaxNode } from "tree-sitter";
import { getAdapterForExtension } from "./adapter/registry.js";
import { logger } from "../util/logger.js";
import { generateAstFingerprint, generateMetadataFingerprint } from "./fingerprints.js";

import type {
  ExtractedSymbol,
  ExtractedCall,
} from "./treesitter/extractCalls.js";
import type { ExtractedImport } from "./treesitter/extractImports.js";

interface WorkerMessage {
  filePath: string;
  content: string;
  ext: string;
}

export type SymbolWithNodeId = ExtractedSymbol & { astFingerprint: string };

interface WorkerResult {
  tree?: null;
  symbols: Array<SymbolWithNodeId>;
  imports: Array<ExtractedImport>;
  calls: Array<ExtractedCall>;
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
      logger.warn("Symbol extraction failed", {
        file: msg.filePath,
        error: String(error),
      });
      extractedSymbols = [];
    }

    const imports = adapter.extractImports(tree, msg.content, msg.filePath);

    const nodesByType = new Map<string, SyntaxNode[]>();
    const getNodeTypeForKind = (kind: string): string =>
      kind === "function"
        ? "function_declaration"
        : kind === "class"
          ? "class_declaration"
          : kind === "interface"
            ? "interface_declaration"
            : kind === "type"
              ? "type_alias_declaration"
              : kind === "method"
                ? "method_definition"
                : kind === "variable"
                  ? "variable_declaration"
                  : "ambient_statement";

    const symbolsWithNodeIds = extractedSymbols.map((symbol) => {
      let astFingerprint = "";
      try {
        const nodeType = getNodeTypeForKind(symbol.kind);
        const candidates =
          nodesByType.get(nodeType) ??
          tree.rootNode.descendantsOfType(nodeType);
        if (!nodesByType.has(nodeType)) {
          nodesByType.set(nodeType, candidates);
        }

        const astNode = candidates.find((node: SyntaxNode) => {
          const nameNode = node.childForFieldName("name");
          return nameNode?.text === symbol.name;
        });

        astFingerprint = astNode
          ? generateAstFingerprint(astNode)
          : generateMetadataFingerprint({
              kind: symbol.kind,
              name: symbol.name,
              range: symbol.range,
              signature: symbol.signature,
            });
      } catch (err) {
        logger.debug("AST fingerprint generation failed", {
          symbol: symbol.name,
          filePath: msg.filePath,
          error: err instanceof Error ? err.message : String(err),
        });
        astFingerprint = generateMetadataFingerprint({
          kind: symbol.kind,
          name: symbol.name,
          range: symbol.range,
          signature: symbol.signature,
        });
      }

      return {
        nodeId: symbol.nodeId,
        kind: symbol.kind,
        name: symbol.name,
        exported: symbol.exported,
        range: symbol.range,
        signature: symbol.signature,
        visibility: symbol.visibility,
        astFingerprint,
      };
    });

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
