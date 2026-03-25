/**
 * Shared tree-sitter parser instances for TypeScript and TSX.
 *
 * Parsers are lazily initialized on first access so that importing this
 * module does not trigger loading the native tree-sitter binaries until
 * they are actually needed (faster server startup for non-indexing paths).
 *
 * tree-sitter-typescript's type exports don't exactly match the
 * Parser.Language type expected by tree-sitter's setLanguage().
 * The cast is safe — the grammar objects ARE valid Language instances,
 * the types are just misaligned between the two packages.
 */
import { createRequire } from "node:module";
import type Parser from "tree-sitter";

const require = createRequire(import.meta.url);

let _tsParser: Parser | null = null;
let _tsxParser: Parser | null = null;

function ensureParsers(): void {
  if (_tsParser) return;

  // Dynamic require — defers native binary loading until first use
  const ParserCtor = require("tree-sitter") as typeof Parser;
  const TypeScript = require("tree-sitter-typescript") as {
    typescript: Parser.Language;
    tsx: Parser.Language;
  };

  _tsParser = new ParserCtor();
  _tsxParser = new ParserCtor();

  _tsParser.setLanguage(
    TypeScript.typescript as unknown as Parser.Language,
  );
  _tsxParser.setLanguage(TypeScript.tsx as unknown as Parser.Language);
}

/** Lazily-initialized TypeScript parser ('.ts' / '.js' files). */
export function getTsParser(): Parser {
  ensureParsers();
  return _tsParser!;
}

/** Lazily-initialized TSX parser ('.tsx' / '.jsx' files). */
export function getTsxParser(): Parser {
  ensureParsers();
  return _tsxParser!;
}
