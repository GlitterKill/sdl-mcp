import type { RepoConfig } from "../config/types.js";
import type {
  SymbolRow as KuzuSymbolRow,
  SymbolLiteRow,
} from "../db/kuzu-queries.js";
import { normalizePath } from "../util/paths.js";
import type Parser from "tree-sitter";

export interface ConfigEdge {
  fromSymbolId: string;
  toSymbolId: string;
  weight?: number;
  provenance?: string;
}

export interface PerTreeConfigEdgeContext {
  repoId: string;
  repoRoot: string;
  config: RepoConfig;
  tree: Parser.Tree;
  fileSymbols: KuzuSymbolRow[];
  allSymbolsByName: Map<string, SymbolLiteRow[]>;
}

export function extractConfigEdgesFromTree(
  context: PerTreeConfigEdgeContext,
): ConfigEdge[] {
  try {
    return extractExpressEdgesFromTree(context);
  } catch (error) {
    console.warn("Config edge extractor failed: express-routes", error);
    return [];
  }
}

function extractExpressEdgesFromTree(context: PerTreeConfigEdgeContext): ConfigEdge[] {
  const { tree, fileSymbols, allSymbolsByName } = context;
  const edges: ConfigEdge[] = [];
  const routeMethods = new Set([
    "get",
    "post",
    "put",
    "delete",
    "patch",
    "options",
    "head",
    "use",
  ]);

  const root = tree.rootNode;
  const queue: Parser.SyntaxNode[] = [root];

  while (queue.length > 0) {
    const node = queue.pop();
    if (!node) continue;

    if (node.type === "call_expression") {
      const fnNode = node.childForFieldName("function");
      if (fnNode?.type === "member_expression") {
        const objectNode = fnNode.childForFieldName("object");
        const propertyNode = fnNode.childForFieldName("property");
        const objectName = objectNode?.text;
        const methodName = propertyNode?.text;

        if (
          objectName &&
          (objectName === "app" || objectName === "router") &&
          methodName &&
          routeMethods.has(methodName)
        ) {
          const argsNode = node.childForFieldName("arguments");
          const args = argsNode?.namedChildren ?? [];
          const handlerNode = args[args.length - 1];
          const handlerName = extractHandlerName(handlerNode);
          if (!handlerName) {
            continue;
          }

          const handlerSymbol = resolveHandlerSymbol(
            handlerName,
            fileSymbols,
            allSymbolsByName,
          );
          if (!handlerSymbol) {
            continue;
          }

          const position = {
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
          };
          const container =
            resolveHandlerSymbol(objectName, fileSymbols, allSymbolsByName) ??
            findEnclosingSymbol(fileSymbols, position);
          if (!container || container.symbolId === handlerSymbol.symbolId) {
            continue;
          }

          edges.push({
            fromSymbolId: container.symbolId,
            toSymbolId: handlerSymbol.symbolId,
            provenance: `express:${methodName}`,
          });
        }
      }
    }

    queue.push(...node.namedChildren);
  }

  return edges;
}

function extractHandlerName(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier") {
    return node.text;
  }
  if (node.type === "member_expression") {
    const property = node.childForFieldName("property");
    if (property?.text) {
      return property.text;
    }
  }
  return null;
}

function resolveHandlerSymbol(
  handlerName: string,
  fileSymbols: KuzuSymbolRow[],
  nameToSymbols: Map<string, SymbolLiteRow[]>,
): { symbolId: string; name: string; exported: boolean } | null {
  const localMatches = fileSymbols.filter(
    (symbol) => symbol.name === handlerName,
  );
  if (localMatches.length === 1) {
    return localMatches[0];
  }

  const globalMatches = nameToSymbols.get(handlerName) ?? [];
  if (globalMatches.length === 1) {
    return globalMatches[0];
  }

  return null;
}

function findEnclosingSymbol(
  symbols: KuzuSymbolRow[],
  position: { line: number; col: number },
): KuzuSymbolRow | null {
  let best: { symbol: KuzuSymbolRow; size: number } | null = null;
  for (const symbol of symbols) {
    if (position.line < symbol.rangeStartLine) continue;
    if (position.line > symbol.rangeEndLine) continue;
    if (position.line === symbol.rangeStartLine && position.col < symbol.rangeStartCol) {
      continue;
    }
    if (position.line === symbol.rangeEndLine && position.col > symbol.rangeEndCol) {
      continue;
    }

    const size =
      symbol.rangeEndLine -
      symbol.rangeStartLine +
      (symbol.rangeEndCol - symbol.rangeStartCol);
    if (!best || size < best.size) {
      best = { symbol, size };
    }
  }

  return best?.symbol ?? null;
}

export function normalizeConfigEdgeRelPath(relPath: string): string {
  return normalizePath(relPath);
}

