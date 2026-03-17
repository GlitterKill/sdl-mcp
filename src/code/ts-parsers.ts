/**
 * Shared tree-sitter parser instances for TypeScript and TSX.
 *
 * tree-sitter-typescript's type exports don't exactly match the
 * Parser.Language type expected by tree-sitter's setLanguage().
 * The cast is safe — the grammar objects ARE valid Language instances,
 * the types are just misaligned between the two packages.
 */
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";

export const tsParser = new Parser();
export const tsxParser = new Parser();

tsParser.setLanguage(TypeScript.typescript as unknown as Parser.Language);
tsxParser.setLanguage(TypeScript.tsx as unknown as Parser.Language);
