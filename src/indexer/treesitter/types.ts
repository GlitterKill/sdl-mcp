import type { SyntaxNode, QueryCapture } from "tree-sitter";

export type { SyntaxNode, QueryCapture } from "tree-sitter";

export interface NodeTree {
  type: string;
  text: string;
  children: NodeTree[];
}

export type NamedNode = SyntaxNode & { type: string };

export interface QueryCaptureWithName extends QueryCapture {
  name: string;
  node: SyntaxNode;
}

export function isNodeWithChildren(node: SyntaxNode): node is SyntaxNode & {
  children: SyntaxNode[];
} {
  return "children" in node;
}

export function isCaptureWithName(
  capture: QueryCapture,
): capture is QueryCaptureWithName {
  return "name" in capture && typeof capture.name === "string";
}
