import Parser from "tree-sitter";
import type { ExtractedSymbol } from "./extractCalls.js";

export function findEnclosingSymbol(
  node: Parser.SyntaxNode,
  symbols: ExtractedSymbol[],
): string {
  let bestNonVariable: ExtractedSymbol | null = null;
  let smallestNonVariableSize = Infinity;

  let bestVariable: ExtractedSymbol | null = null;
  let smallestVariableSize = Infinity;

  const nodeLine = node.startPosition.row + 1;
  const nodeCol = node.startPosition.column;

  for (const symbol of symbols) {
    if (
      nodeLine >= symbol.range.startLine &&
      nodeLine <= symbol.range.endLine
    ) {
      if (
        nodeLine === symbol.range.startLine &&
        nodeCol < symbol.range.startCol
      ) {
        continue;
      }
      if (nodeLine === symbol.range.endLine && nodeCol > symbol.range.endCol) {
        continue;
      }

      const size =
        (symbol.range.endLine - symbol.range.startLine) * 1000 +
        (symbol.range.endCol - symbol.range.startCol);

      if (symbol.kind === "variable") {
        if (size < smallestVariableSize) {
          smallestVariableSize = size;
          bestVariable = symbol;
        }
        continue;
      }

      if (size < smallestNonVariableSize) {
        smallestNonVariableSize = size;
        bestNonVariable = symbol;
      }
    }
  }

  return bestNonVariable?.nodeId || bestVariable?.nodeId || "global";
}
