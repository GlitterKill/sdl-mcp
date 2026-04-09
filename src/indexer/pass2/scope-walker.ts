/**
 * Shared lexical scope walker (Phase 2 Task 2.0.4).
 *
 * Several heuristic resolvers walk a tree-sitter Tree a second time to
 * answer "what local names are in scope at line N?". This module factors
 * that walk into a generic implementation parameterized by per-language
 * `ScopeRule`s.
 *
 * The walker does NOT depend on tree-sitter directly so it can be unit
 * tested with synthetic node trees. The minimal node interface is
 * declared inline as `ScopeNode`.
 */

/**
 * Minimal AST node interface. Real tree-sitter nodes already satisfy
 * this shape; tests can provide their own object literals.
 */
export interface ScopeNode {
  type: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: ScopeNode[];
  text: string;
  childForFieldName?(name: string): ScopeNode | null;
}

/**
 * A scope rule defines how a language's nodes interact with scope:
 *   - `nodeKind`: tree-sitter node kind to match (e.g. `function_definition`)
 *   - `defines`: function returning the names this node introduces into
 *     its enclosing scope (e.g. function name, parameter names)
 *   - `introducesScope`: when true, the node's children are evaluated
 *     in a fresh scope rather than the current one
 */
export interface ScopeRule {
  nodeKind: string;
  defines?: (node: ScopeNode) => Array<{ name: string; node: ScopeNode }>;
  introducesScope?: boolean;
}

export interface NameBinding {
  name: string;
  node: ScopeNode;
  scopeDepth: number;
}

export type ScopeMap = Map<string, NameBinding>;

interface ScopeEntry {
  node: ScopeNode;
  parent: ScopeEntry | null;
  bindings: NameBinding[];
}

/**
 * Builds a scope walker by walking the tree once. Returns a function
 * `(line, col) => ScopeMap`. Reuse the returned function across many
 * lookups in the same tree to amortize the walk cost.
 */
export function buildScopeWalker(
  root: ScopeNode,
  rules: readonly ScopeRule[],
): (line: number, col: number) => ScopeMap {
  const ruleByKind = new Map<string, ScopeRule>();
  for (const rule of rules) {
    ruleByKind.set(rule.nodeKind, rule);
  }

  const rootScope: ScopeEntry = { node: root, parent: null, bindings: [] };
  const scopeByNode = new Map<ScopeNode, ScopeEntry>();
  scopeByNode.set(root, rootScope);

  function walk(
    node: ScopeNode,
    currentScope: ScopeEntry,
    depth: number,
  ): void {
    const rule = ruleByKind.get(node.type);

    // Apply this node's defines() into its enclosing scope.
    if (rule?.defines) {
      for (const def of rule.defines(node)) {
        currentScope.bindings.push({
          name: def.name,
          node: def.node,
          scopeDepth: depth,
        });
      }
    }

    // If this node introduces its own scope, recurse into a child entry.
    let nextScope = currentScope;
    let nextDepth = depth;
    if (rule?.introducesScope) {
      nextScope = { node, parent: currentScope, bindings: [] };
      scopeByNode.set(node, nextScope);
      nextDepth = depth + 1;
    }

    for (const child of node.children) {
      walk(child, nextScope, nextDepth);
    }
  }

  for (const child of root.children) {
    walk(child, rootScope, 0);
  }

  function findInnermostEnclosingScope(line: number, col: number): ScopeEntry {
    let result: ScopeEntry = rootScope;
    function recurse(node: ScopeNode, scope: ScopeEntry): void {
      const ownScope = scopeByNode.get(node);
      const here = ownScope ?? scope;
      if (ownScope && isPositionInside(node, line, col)) {
        result = ownScope;
      }
      for (const child of node.children) {
        if (isPositionInside(child, line, col)) {
          recurse(child, here);
        }
      }
    }
    recurse(root, rootScope);
    return result;
  }

  return (line: number, col: number): ScopeMap => {
    const innermost = findInnermostEnclosingScope(line, col);
    const map: ScopeMap = new Map();
    // Walk parent chain root-down so inner bindings shadow outer ones
    // via simple Map.set overwrite.
    const chain: ScopeEntry[] = [];
    let cursor: ScopeEntry | null = innermost;
    while (cursor) {
      chain.push(cursor);
      cursor = cursor.parent;
    }
    chain.reverse();
    for (const scope of chain) {
      for (const b of scope.bindings) {
        map.set(b.name, b);
      }
    }
    return map;
  };
}

function isPositionInside(node: ScopeNode, line: number, col: number): boolean {
  const sl = node.startPosition.row;
  const sc = node.startPosition.column;
  const el = node.endPosition.row;
  const ec = node.endPosition.column;
  if (line < sl || line > el) return false;
  if (line === sl && col < sc) return false;
  if (line === el && col > ec) return false;
  return true;
}

/**
 * Convenience helper: returns the scope map for a single point. For
 * many lookups in the same tree, prefer `buildScopeWalker` directly.
 */
export function getScopeAt(
  root: ScopeNode,
  rules: readonly ScopeRule[],
  line: number,
  col: number,
): ScopeMap {
  return buildScopeWalker(root, rules)(line, col);
}

/**
 * Helper for the common case of "find the nearest enclosing node of
 * a given type". Used by Python (`find enclosing class`), Rust (`find
 * enclosing impl`), Kotlin (`find enclosing companion object`), etc.
 */
export function findEnclosingByType(
  root: ScopeNode,
  line: number,
  col: number,
  nodeType: string,
): ScopeNode | null {
  let best: ScopeNode | null = null;
  function recurse(node: ScopeNode): void {
    if (!isPositionInside(node, line, col)) return;
    if (node.type === nodeType) {
      best = node;
    }
    for (const child of node.children) {
      recurse(child);
    }
  }
  recurse(root);
  return best;
}
