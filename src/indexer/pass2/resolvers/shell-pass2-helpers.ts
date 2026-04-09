import type { SyntaxNode } from "tree-sitter";

/**
 * Phase 2 Task 2.10.1 helpers for the shell pass2 resolver.
 *
 * This file is intentionally DB-free so that tests can import it directly
 * under --experimental-strip-types without pulling in the whole LadybugDB
 * stack.
 */

/** Minimal shape of an extracted call. Matches the resolver's expectations. */
export type ExtractedCallLike = {
  callerNodeId?: string;
  calleeIdentifier: string;
  isResolved: boolean;
  callType: "function" | "method" | "constructor" | "dynamic";
  calleeSymbolId?: string;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
};

/**
 * Walk the parsed tree for `command foo` and `eval "foo"` style indirect
 * invocations. The default call extractor emits `command`/`eval` as the
 * call identifier and loses the real target. Here we recognize these
 * patterns and synthesize an `ExtractedCall` pointing at the literal
 * first argument so the downstream resolver can match it against known
 * shell functions.
 */
export function collectCommandEvalCallSites(
  rootNode: SyntaxNode,
): ExtractedCallLike[] {
  const results: ExtractedCallLike[] = [];
  const stack: SyntaxNode[] = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
    if (node.type !== "command") continue;

    const nameNode = node.namedChild(0);
    if (!nameNode || nameNode.type !== "command_name") continue;
    const nameText = nameNode.text;
    if (nameText !== "command" && nameText !== "eval") continue;

    let targetName: string | null = null;
    for (let i = 1; i < node.namedChildCount; i++) {
      const arg = node.namedChild(i);
      if (!arg) continue;
      if (arg.type === "word") {
        targetName = arg.text;
        break;
      }
      if (arg.type === "string" || arg.type === "raw_string") {
        const raw = arg.text;
        const unquoted =
          raw.length >= 2 &&
          (raw[0] === '"' || raw[0] === "'") &&
          raw[raw.length - 1] === raw[0]
            ? raw.slice(1, -1)
            : raw;
        const trimmed = unquoted.trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
          targetName = trimmed;
        }
        break;
      }
      break;
    }
    if (!targetName) continue;

    const start = node.startPosition;
    const end = node.endPosition;
    results.push({
      calleeIdentifier: targetName,
      isResolved: false,
      callType: "function",
      range: {
        startLine: start.row + 1,
        startCol: start.column,
        endLine: end.row + 1,
        endCol: end.column,
      },
    });
  }
  return results;
}
