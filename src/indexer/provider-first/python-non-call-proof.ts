import type { SyntaxNode } from "tree-sitter";
import type { ScipDocument, ScipOccurrence } from "../../scip/types.js";
import { parseScipSymbol } from "../../scip/kind-mapping.js";
import { sourceTextCandidatesForScipSymbol } from "./scip-normalizer.js";
import { pythonOccurrenceKey } from "./python-lexical-bindings.js";

/** Worker-only syntax evidence for exact declaration and multiline non-call occurrences. */
export function provePythonNonCalls(
  document: ScipDocument,
  root: SyntaxNode,
): Set<string> {
  const proof = new Set<string>();
  if (root.hasError || !/^python$/i.test(document.language)) return proof;
  const ranges = new Map<string, ScipOccurrence[]>();
  const rangeKey = (a: number, b: number, c: number, d: number): string =>
    JSON.stringify([a, b, c, d]);
  for (const occurrence of document.occurrences) {
    const r = occurrence.range;
    const key = rangeKey(r.startLine, r.startCol, r.endLine, r.endCol);
    ranges.set(key, [...(ranges.get(key) ?? []), occurrence]);
  }
  for (const node of root.descendantsOfType([
    "function_definition",
    "aliased_import",
    "parenthesized_expression",
  ])) {
    const declarationName =
      node.type === "function_definition"
        ? node.childForFieldName("name")
        : undefined;
    const span = declarationName ?? node;
    if (declarationName) {
      if (
        declarationName.type !== "identifier" ||
        span.startPosition.row !== span.endPosition.row
      )
        continue;
    } else if (span.startPosition.row === span.endPosition.row) continue;
    const key = rangeKey(
      span.startPosition.row,
      span.startPosition.column,
      span.endPosition.row,
      span.endPosition.column,
    );
    const occurrences = ranges.get(key);
    // Never let evidence for one target neutralize a conflicting occurrence.
    if (occurrences?.length !== 1) continue;
    const occurrence = occurrences[0];
    if (occurrence.symbolRoles & 1) continue;
    const parsed = parseScipSymbol(occurrence.symbol);
    if (parsed.scheme !== "scip-python") continue;
    if (declarationName) {
      // A declaration name is never a call, even when SCIP targets its class.
      proof.add(pythonOccurrenceKey(occurrence));
      continue;
    }
    let name: string | undefined;
    if (
      node.type === "aliased_import" &&
      node.parent?.type === "import_from_statement"
    ) {
      name = node.childForFieldName("name")?.text;
    } else if (
      node.parent?.type === "assignment" &&
      node.parent.childForFieldName("right")?.id === node.id
    ) {
      // Only a bare name wrapped as an assignment value. Calls, arguments,
      // decorators and conditional expressions require their own proof.
      let value = node;
      while (value.type === "parenthesized_expression") {
        const children = value.namedChildren.filter(
          (child) => child.type !== "comment",
        );
        if (children.length !== 1) break;
        value = children[0];
      }
      if (value.type === "identifier") name = value.text;
    }
    if (
      name &&
      sourceTextCandidatesForScipSymbol(occurrence.symbol, "").includes(name)
    )
      proof.add(pythonOccurrenceKey(occurrence));
  }
  return proof;
}
