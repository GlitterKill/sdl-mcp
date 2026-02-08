import Parser from "tree-sitter";
import { createQuery } from "./grammarLoader.js";

export interface ExtractedImport {
  specifier: string;
  isRelative: boolean;
  isExternal: boolean;
  imports: string[];
  defaultImport?: string;
  namespaceImport?: string;
  isReExport: boolean;
}

const BUILTIN_MODULES = new Set([
  "fs",
  "path",
  "os",
  "http",
  "https",
  "url",
  "querystring",
  "stream",
  "util",
  "events",
  "buffer",
  "crypto",
  "timers",
  "cluster",
  "child_process",
  "net",
  "dgram",
  "dns",
  "readline",
  "repl",
  "vm",
  "zlib",
  "assert",
  "tty",
  "module",
  "process",
  "console",
]);

export function extractImports(tree: Parser.Tree): ExtractedImport[] {
  const imports: ExtractedImport[] = [];

  const importQuery = createQuery(
    "typescript",
    `
    (import_statement 
      source: (string (string_fragment) @specifier))

    (export_statement
      source: (string (string_fragment) @specifier))
  `,
  );

  if (!importQuery) {
    return [];
  }

  const matches = importQuery.matches(tree.rootNode);

  for (const match of matches) {
    for (const capture of match.captures) {
      if (capture.name === "specifier") {
        let specifier = capture.node.text;
        if (specifier.length >= 2) {
          const firstChar = specifier[0];
          const lastChar = specifier[specifier.length - 1];
          if (
            (firstChar === '"' || firstChar === "'") &&
            firstChar === lastChar
          ) {
            specifier = specifier.slice(1, -1);
          }
        }
        const parentNode = capture.node.parent?.parent;

        if (!parentNode) continue;

        const extracted = parseImportNode(parentNode, specifier);
        imports.push(extracted);
      }
    }
  }

  return imports;
}

/**
 * Find a child node by type (not by field name).
 * tree-sitter's childForFieldName() looks for named fields, but
 * the TypeScript grammar uses node types for import structure.
 */
function findChildByType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | null {
  for (const child of node.children) {
    if (child.type === type) {
      return child;
    }
  }
  return null;
}

/**
 * Find all children by type.
 */
function findChildrenByType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode[] {
  return node.children.filter((child) => child.type === type);
}

function parseImportNode(
  node: Parser.SyntaxNode,
  specifier: string,
): ExtractedImport {
  const isReExport = node.type === "export_statement";
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const isExternal = !isRelative && !BUILTIN_MODULES.has(specifier);

  const result: ExtractedImport = {
    specifier,
    isRelative,
    isExternal,
    imports: [],
    isReExport,
  };

  for (const child of node.children) {
    switch (child.type) {
      case "import_clause": {
        // Look for default import - it's an identifier directly under import_clause
        const defaultImport = findChildByType(child, "identifier");
        if (defaultImport) {
          result.defaultImport = defaultImport.text;
        }

        // Look for named imports - it's a child node of type "named_imports"
        const namedImports = findChildByType(child, "named_imports");
        if (namedImports) {
          const imports = extractNamedImports(namedImports);
          result.imports.push(...imports);
        }

        // Look for namespace import - it's a child node of type "namespace_import"
        const namespace = findChildByType(child, "namespace_import");
        if (namespace) {
          // The name in namespace import is an identifier child
          const name = findChildByType(namespace, "identifier");
          if (name) {
            result.namespaceImport = name.text;
          }
        }
        break;
      }

      case "named_imports": {
        const imports = extractNamedImports(child);
        result.imports.push(...imports);
        break;
      }

      case "export_clause": {
        const exports = extractNamedImports(child);
        result.imports.push(...exports);
        break;
      }

      case "namespace_import": {
        const name = findChildByType(child, "identifier");
        if (name) {
          result.namespaceImport = name.text;
        }
        break;
      }

      case "identifier": {
        if (node.type === "export_statement" && !result.defaultImport) {
          const previousChild = node.children[node.children.indexOf(child) - 1];
          if (
            previousChild?.type !== "named_imports" &&
            previousChild?.type !== "export_clause" &&
            previousChild?.type !== "from"
          ) {
            result.defaultImport = child.text;
          }
        }
        break;
      }
    }
  }

  if (node.type === "import_statement") {
    const hasSource = node.children.some(
      (c) => c.type === "from" || c.type === "source",
    );
    if (!hasSource) {
      const identifier = node.children.find((c) => c.type === "identifier");
      if (identifier && !result.imports.length && !result.namespaceImport) {
        result.defaultImport = identifier.text;
      }
    }
  }

  return result;
}

function extractNamedImports(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];

  for (const child of node.children) {
    if (
      child.type === "import_specifier" ||
      child.type === "export_specifier"
    ) {
      // In tree-sitter TypeScript, import_specifier has structure:
      // - identifier (the imported name)
      // - optionally "as" keyword + identifier (alias)
      // We want the local name (alias if present, otherwise imported name)
      const identifiers = findChildrenByType(child, "identifier");

      if (identifiers.length === 2) {
        // Has alias: import { foo as bar } - use the alias (second identifier)
        names.push(identifiers[1].text);
      } else if (identifiers.length === 1) {
        // No alias: import { foo } - use the name directly
        names.push(identifiers[0].text);
      }
    }
  }

  return names;
}
