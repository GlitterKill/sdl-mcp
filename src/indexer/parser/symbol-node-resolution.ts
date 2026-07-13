import type Parser from "tree-sitter";

const NODE_TYPES_BY_SYMBOL_KIND = new Map<string, readonly string[]>([
  ["function", ["function_declaration", "function_definition"]],
  ["class", ["class_declaration", "class_definition"]],
  ["interface", ["interface_declaration"]],
  ["type", ["type_alias_declaration"]],
  ["method", ["method_definition"]],
  ["variable", ["variable_declaration"]],
]);

export interface SymbolNodeFingerprintTarget {
  kind: string;
  name: string;
  startLine?: number;
  startCol?: number;
}

/**
 * Resolve the declaration node used to assemble a symbol's AST fingerprint.
 * Source position breaks ties for duplicate names while preserving the
 * indexer's historical first-name-match fallback when no position is known.
 */
export function resolveSymbolNodeForFingerprint(
  tree: Parser.Tree,
  target: SymbolNodeFingerprintTarget,
): Parser.SyntaxNode | undefined {
  const nodeTypes = NODE_TYPES_BY_SYMBOL_KIND.get(target.kind) ?? ["ambient_statement"];
  const candidates = nodeTypes
    .flatMap((nodeType) => tree.rootNode.descendantsOfType(nodeType))
    .filter((node) => node.childForFieldName("name")?.text === target.name);

  if (candidates.length <= 1 || target.startLine === undefined) {
    return candidates[0];
  }

  const targetRow = Math.max(0, target.startLine - 1);
  const targetCol = target.startCol ?? 0;
  return candidates.reduce((best, candidate) => {
    const bestDistance =
      Math.abs(best.startPosition.row - targetRow) * 10000 +
      Math.abs(best.startPosition.column - targetCol);
    const candidateDistance =
      Math.abs(candidate.startPosition.row - targetRow) * 10000 +
      Math.abs(candidate.startPosition.column - targetCol);
    return candidateDistance < bestDistance ? candidate : best;
  });
}
