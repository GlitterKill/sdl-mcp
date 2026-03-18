import Parser from "tree-sitter";
import {
  hashContent,
  generateSymbolId as hashSymbolId,
} from "../util/hashing.js";
import { logger } from "../util/logger.js";

const fingerprintCollisionLog = new Map<string, { type: string; name: string; row: number; col: number }>();

/**
 * Generates a stable AST fingerprint for a function/class node.
 * Includes type, name, parameter count, modifiers, visibility, and subtree hash.
 *
 * @param node - Tree-sitter syntax node
 * @returns Hex string hash of the AST structure
 */
export function generateAstFingerprint(node: Parser.SyntaxNode): string {
  const parts: string[] = [];

  parts.push(`type:${node.type}`);

  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    parts.push(`name:${nameNode.text}`);
  }

  const params = node.children.filter(
    (child) =>
      child.type === "formal_parameters" || child.type === "parameters",
  );
  if (params.length > 0) {
    const paramCount = params[0].children.filter(
      (child) =>
        child.type === "required_parameter" ||
        child.type === "optional_parameter" ||
        child.type === "identifier" ||
        child.type === "pattern",
    ).length;
    parts.push(`params:${paramCount}`);
  }

  const asyncModifier = node.children.find((child) => child.type === "async");
  if (asyncModifier) {
    parts.push("async:true");
  }

  const staticModifier = node.children.find((child) => child.type === "static");
  if (staticModifier) {
    parts.push("static:true");
  }

  const visibilityModifiers = ["public", "private", "protected", "internal"];
  for (const vis of visibilityModifiers) {
    const visNode = node.children.find((child) => child.type === vis);
    if (visNode) {
      parts.push(`visibility:${vis}`);
      break;
    }
  }

  const returnType =
    node.childForFieldName("return_type") || node.childForFieldName("type");
  if (returnType) {
    parts.push("returnType:true");
  }

  const subtreeHash = computeSubtreeHash(node);
  parts.push(`subtree:${subtreeHash}`);

  const fingerprint = hashContent(parts.join("|"));

  const newName = nameNode?.text || "<unknown>";
  const newMeta = { type: node.type, name: newName, row: node.startPosition.row, col: node.startPosition.column };
  const existingMeta = fingerprintCollisionLog.get(fingerprint);
  if (existingMeta && (existingMeta.row !== newMeta.row || existingMeta.col !== newMeta.col)) {
    logger.debug("Fingerprint collision detected", { fingerprint, existing: `${existingMeta.type}:${existingMeta.name}@${existingMeta.row}:${existingMeta.col}`, new_entry: `${newMeta.type}:${newMeta.name}@${newMeta.row}:${newMeta.col}` });
  } else {
    if (fingerprintCollisionLog.size >= 10000) {
      fingerprintCollisionLog.clear();
    }
    fingerprintCollisionLog.set(fingerprint, newMeta);
  }

  return fingerprint;
}

function computeSubtreeHash(node: Parser.SyntaxNode): string {
  const parts: string[] = [];
  collectNormalizedParts(node, parts);
  return hashContent(parts.join(","));
}

function collectNormalizedParts(
  node: Parser.SyntaxNode,
  parts: string[],
): void {
  const isLiteral =
    node.type.includes("string") ||
    node.type.includes("number") ||
    node.type === "true" ||
    node.type === "false" ||
    node.type === "null" ||
    node.type === "undefined";

  if (!isLiteral) {
    parts.push(node.type);

    for (const child of node.children) {
      if (child.type !== "comment") {
        collectNormalizedParts(child, parts);
      }
    }
  }
}

/** Clear the collision log to free memory between indexing runs. */
export function clearFingerprintCollisionLog(): void {
  fingerprintCollisionLog.clear();
}

export { generateSymbolId as hashSymbolId };

/**
 * Generates a stable unique identifier for a symbol.
 * Combines repo, path, kind, name, and AST fingerprint.
 *
 * @param repoId - Repository identifier
 * @param relPath - Relative file path
 * @param kind - Symbol kind (e.g., "function", "class")
 * @param name - Symbol name
 * @param astFingerprint - AST fingerprint hash
 * @returns Hex string symbol identifier
 */
export function generateSymbolId(
  repoId: string,
  relPath: string,
  kind: string,
  name: string,
  astFingerprint: string,
): string {
  return hashSymbolId(repoId, relPath, kind, name, astFingerprint);
}
