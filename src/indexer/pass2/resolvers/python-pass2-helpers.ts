import type { SymbolKind } from "../../../domain/types.js";

// Phase 2 Python Pass-2 pure helpers (Tasks 2.1.1-2.1.3). This module must
// NOT import any database or filesystem modules so unit tests can load it
// under --experimental-strip-types without pulling in the full resolver
// transitive dependency chain. Small type/function duplication with
// ../barrel-walker.ts and ../scope-walker.ts is intentional.

/** Re-export edge, structurally compatible with barrel-walker#ReExport. */
export interface ReExport {
  exportedName: string;
  targetFile: string;
  targetName: string;
}

/** Minimal AST node shape, structurally compatible with scope-walker#ScopeNode. */
export interface ScopeNode {
  type: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: ScopeNode[];
  text: string;
  childForFieldName?(name: string): ScopeNode | null;
}

/** Local structural echo of ExtractedSymbol for these helpers. */
export interface PythonExtractedSymbolShape {
  nodeId: string;
  kind: SymbolKind;
  name: string;
  exported: boolean;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
  decorators?: string[];
}

export interface PythonFilteredSymbolDetailShape {
  extractedSymbol: PythonExtractedSymbolShape;
  symbolId: string;
}

// Phase 2 Task 2.1.1: extract the bare decorator name from raw text
// captured by tree-sitter (e.g. "@my_decorator", "@pkg.wrapper(arg)",
// "@staticmethod"). Returns the last dotted segment stripped of args.
export function extractDecoratorName(raw: string): string | null {
  let text = raw.trim();
  if (text.startsWith("@")) text = text.slice(1);
  const parenIdx = text.indexOf("(");
  if (parenIdx >= 0) text = text.slice(0, parenIdx);
  text = text.trim();
  if (!text) return null;
  if (text.includes(".")) text = text.slice(text.lastIndexOf(".") + 1);
  return text || null;
}

export const PYTHON_BUILTIN_DECORATORS = new Set<string>([
  "staticmethod",
  "classmethod",
  "property",
  "abstractmethod",
  "override",
  "final",
]);

// Phase 2 Task 2.1.1: resolve a function symbol's decorators to call
// edge targets. Each decorator name is looked up same-file first, then
// via imported names. Skips Python built-in decorators that do not
// correspond to user symbols.
export function resolveDecoratorTargets(params: {
  decorators: readonly string[];
  localFunctionNameIndex: Map<string, string[]>;
  importedNameToSymbolIds: Map<string, string[]>;
  /**
   * Optional notifier fired once per decorator that the helper had to skip
   * because the candidate set was ambiguous (>1 local OR >1 imported match).
   * Wired by the resolver call site to record `recordPass2ResolverUnresolved`
   * without forcing this pure helper to value-import the telemetry module.
   */
  onAmbiguous?: () => void;
}): string[] {
  const {
    decorators,
    localFunctionNameIndex,
    importedNameToSymbolIds,
    onAmbiguous,
  } = params;
  const resolved: string[] = [];
  for (const raw of decorators) {
    const name = extractDecoratorName(raw);
    if (!name) continue;
    if (PYTHON_BUILTIN_DECORATORS.has(name)) continue;
    const local = localFunctionNameIndex.get(name);
    if (local && local.length === 1) {
      if (!resolved.includes(local[0])) resolved.push(local[0]);
      continue;
    }
    if (local && local.length > 1) {
      onAmbiguous?.();
      continue;
    }
    const imported = importedNameToSymbolIds.get(name);
    if (imported && imported.length === 1) {
      if (!resolved.includes(imported[0])) resolved.push(imported[0]);
      continue;
    }
    if (imported && imported.length > 1) {
      onAmbiguous?.();
      continue;
    }
  }
  return resolved;
}

// Phase 2 Task 2.1.2: parse a Python `__init__.py` file for the minimal
// `from .submodule import Foo [as Alias]` statements needed to walk a
// barrel chain. Lightweight regex-based parser covering the common
// re-export shape used by package __init__.py files.
export function parsePythonReExports(
  initFileRelPath: string,
  content: string,
): ReExport[] {
  const reExports: ReExport[] = [];
  const lastSlash = initFileRelPath.lastIndexOf("/");
  const pkgDir = lastSlash >= 0 ? initFileRelPath.slice(0, lastSlash) : "";
  const re = /^\s*from\s+\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s+import\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const submodule = m[1];
    const namesPart = m[2].replace(/[()]/g, "").trim();
    if (!submodule || !namesPart || namesPart === "*") continue;
    const submodulePath = submodule.replace(/\./g, "/");
    const targetFile = (pkgDir ? `${pkgDir}/` : "") + submodulePath;
    for (const nameSpec of namesPart.split(",")) {
      const spec = nameSpec.trim();
      if (!spec) continue;
      const asMatch = spec.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/);
      if (asMatch) {
        reExports.push({
          exportedName: asMatch[2],
          targetFile,
          targetName: asMatch[1],
        });
      } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec)) {
        reExports.push({
          exportedName: spec,
          targetFile,
          targetName: spec,
        });
      }
    }
  }
  return reExports;
}

// Position-inside helper duplicated from scope-walker.ts to keep this
// helpers module dependency-free for unit tests.
function isPositionInside(
  node: ScopeNode,
  line: number,
  col: number,
): boolean {
  const sl = node.startPosition.row;
  const sc = node.startPosition.column;
  const el = node.endPosition.row;
  const ec = node.endPosition.column;
  if (line < sl || line > el) return false;
  if (line === sl && col < sc) return false;
  if (line === el && col > ec) return false;
  return true;
}

// Phase 2 Task 2.0.4 / 2.1.3: find the nearest enclosing node of a given
// type around (line, col). Duplicated from `../scope-walker.ts` to keep
// this helpers module dependency-free for unit tests.
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

// Phase 2 Task 2.1.3: resolve `self.method()` or `cls.method()` to the
// enclosing class's method by walking the tree-sitter tree via the
// shared scope walker. Returns null when the caller is not inside a
// class, when no matching class is found, or when the method name is
// not bound in the resolved class.
export function resolveSelfMethodWithScope(params: {
  methodName: string;
  callerRange: { startLine: number; startCol: number };
  treeRoot: ScopeNode | null;
  classes: PythonFilteredSymbolDetailShape[];
  methodsByClass: Map<string, Map<string, string[]>>;
}): string | null {
  const { methodName, callerRange, treeRoot, classes, methodsByClass } = params;
  if (!treeRoot) return null;
  const classNode = findEnclosingByType(
    treeRoot,
    callerRange.startLine,
    callerRange.startCol,
    "class_definition",
  );
  if (!classNode) return null;
  const nodeStartLine = classNode.startPosition.row;
  const nodeStartCol = classNode.startPosition.column;
  let match: PythonFilteredSymbolDetailShape | null = null;
  for (const clazz of classes) {
    const cr = clazz.extractedSymbol.range;
    if (cr.startLine === nodeStartLine && cr.startCol === nodeStartCol) {
      match = clazz;
      break;
    }
  }
  if (!match) {
    let ownerSize = Number.MAX_SAFE_INTEGER;
    for (const clazz of classes) {
      const cr = clazz.extractedSymbol.range;
      if (cr.startLine > nodeStartLine || cr.endLine < nodeStartLine) continue;
      const size = (cr.endLine - cr.startLine) * 10_000 + (cr.endCol - cr.startCol);
      if (size < ownerSize) {
        match = clazz;
        ownerSize = size;
      }
    }
  }
  if (!match) return null;
  const methodMap = methodsByClass.get(match.symbolId);
  if (!methodMap) return null;
  const candidates = methodMap.get(methodName);
  if (!candidates || candidates.length !== 1) return null;
  return candidates[0];
}
