/**
 * Finds the smallest enclosing symbol for a given AST range.
 * Used by all pass2 resolvers to map call sites to their containing function.
 */
function findEnclosingSymbolByRange(
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
  symbols: Array<{
    extractedSymbol: {
      nodeId: string;
      kind: string;
      range: {
        startLine: number;
        startCol: number;
        endLine: number;
        endCol: number;
      };
    };
  }>,
): string | null {
  let bestNonVariable: { nodeId: string; size: number } | null = null;
  let bestVariable: { nodeId: string; size: number } | null = null;

  for (const detail of symbols) {
    const symRange = detail.extractedSymbol.range;
    const nodeLine = range.startLine;
    const nodeCol = range.startCol;

    if (nodeLine < symRange.startLine || nodeLine > symRange.endLine) {
      continue;
    }
    if (nodeLine === symRange.startLine && nodeCol < symRange.startCol) {
      continue;
    }
    if (nodeLine === symRange.endLine && nodeCol > symRange.endCol) {
      continue;
    }

    const size =
      symRange.endLine -
      symRange.startLine +
      (symRange.endCol - symRange.startCol);

    if (detail.extractedSymbol.kind === "variable") {
      if (!bestVariable || size < bestVariable.size) {
        bestVariable = { nodeId: detail.extractedSymbol.nodeId, size };
      }
      continue;
    }

    if (!bestNonVariable || size < bestNonVariable.size) {
      bestNonVariable = { nodeId: detail.extractedSymbol.nodeId, size };
    }
  }

  return bestNonVariable?.nodeId ?? bestVariable?.nodeId ?? null;
}

export { findEnclosingSymbolByRange };
