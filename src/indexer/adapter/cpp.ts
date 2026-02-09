import Parser from "tree-sitter";
import type { Tree } from "tree-sitter";
import type { LanguageAdapter } from "./LanguageAdapter.js";
import {
  getParser,
  clearCache as clearGrammarCache,
} from "../treesitter/grammarLoader.js";
import type {
  ExtractedSymbol,
  ExtractedCall,
} from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";

class CppAdapter implements LanguageAdapter {
  languageId = "cpp";
  fileExtensions = [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"] as const;

  private parser: Parser | null = null;

  getParser(): Parser | null {
    if (!this.parser) {
      this.parser = getParser("cpp");
    }
    return this.parser;
  }

  parse(content: string, filePath: string): Tree | null {
    const parser = this.getParser();
    if (!parser) {
      return null;
    }

    try {
      // Use 1MB buffer to handle files >32KB (tree-sitter default limit)
      const tree = parser.parse(content, undefined, {
        bufferSize: 1024 * 1024,
      });

      if (!tree || tree.rootNode.hasError) {
        return null;
      }

      return tree;
    } catch (error) {
      process.stderr.write(
        `[sdl-mcp] Failed to parse C/C++ file ${filePath}: ${error instanceof Error ? error.message : String(error)}\n`
      );
      return null;
    }
  }

  extractSymbols(
    tree: Tree,
    _content: string,
    filePath: string,
  ): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];

    function extractRange(node: Parser.SyntaxNode) {
      const start = node.startPosition;
      const end = node.endPosition;

      return {
        startLine: start.row + 1,
        startCol: start.column,
        endLine: end.row + 1,
        endCol: end.column,
      };
    }

    function buildFQN(node: Parser.SyntaxNode, name: string): string {
      const parts: string[] = [];
      let current: Parser.SyntaxNode | null = node;

      while (current) {
        if (current.type === "namespace_definition") {
          const nameNode = current.childForFieldName("name");
          if (nameNode) {
            parts.unshift(nameNode.text);
          }
        }
        current = current.parent;
      }

      parts.push(name);
      return parts.join("::");
    }

    function extractVisibility(
      node: Parser.SyntaxNode,
    ): "public" | "private" | "protected" | undefined {
      let current: Parser.SyntaxNode | null = node.parent;

      while (current) {
        for (const child of current.children) {
          if (child.type === "access_specifier") {
            if (child.text.includes("public")) return "public";
            if (child.text.includes("private")) return "private";
            if (child.text.includes("protected")) return "protected";
          }
        }
        if (
          current.type === "class_specifier" ||
          current.type === "struct_specifier"
        ) {
          break;
        }
        current = current.parent;
      }

      return "private";
    }

    function extractTypeParameters(node: Parser.SyntaxNode): string[] {
      const params: string[] = [];
      const templateParam = node.previousSibling;

      if (templateParam && templateParam.type === "template_declaration") {
        const paramList = templateParam.childForFieldName("parameters");
        if (paramList) {
          for (const child of paramList.children) {
            if (child.type === "type_parameter_declaration") {
              const typeParam = child.childForFieldName("name");
              if (typeParam) {
                params.push(typeParam.text);
              }
            }
          }
        }
      }

      return params;
    }

    function extractParameters(
      node: Parser.SyntaxNode,
    ): Array<{ name: string; type?: string }> {
      const params: Array<{ name: string; type?: string }> = [];

      const paramList = node.childForFieldName("parameters");
      if (!paramList) return params;

      for (const child of paramList.children) {
        if (child.type === "parameter_declaration") {
          const declarator = child.childForFieldName("declarator");
          const typeNode = child.children.find(
            (c) => c.type !== "," && c !== declarator,
          );

          let paramName = "";
          if (declarator) {
            const identifier = declarator.childForFieldName("declarator");
            if (identifier) {
              paramName = identifier.text;
            }
          }

          if (paramName) {
            params.push({
              name: paramName,
              type: typeNode ? typeNode.text : undefined,
            });
          }
        }
      }

      return params;
    }

    function extractReturnType(node: Parser.SyntaxNode): string | undefined {
      let current: Parser.SyntaxNode | null = node;

      while (current && current.type !== "declaration") {
        current = current.parent;
      }

      if (!current) return undefined;

      for (const child of current.children) {
        if (
          child.type !== "declarator" &&
          child.type !== "virtual" &&
          child.type !== "static" &&
          child.type !== "inline" &&
          child.type !== "const" &&
          child.type !== "volatile"
        ) {
          return child.text;
        }
      }

      return undefined;
    }

    function traverseAST(
      node: Parser.SyntaxNode,
      context: { className?: string },
    ): void {
      switch (node.type) {
        case "namespace_definition": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            const fqn = buildFQN(node.parent || node, name);
            symbols.push({
              nodeId: `${filePath}:${fqn}:namespace`,
              kind: "module",
              name: fqn,
              exported: true,
              visibility: "public",
              range: extractRange(node),
            });
          }
          break;
        }

        case "class_specifier":
        case "struct_specifier": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            const fqn = buildFQN(node, name);
            const generics = extractTypeParameters(node);

            symbols.push({
              nodeId: `${filePath}:${fqn}:class`,
              kind: "class",
              name: fqn,
              exported: true,
              visibility: "public",
              range: extractRange(node),
              signature: {
                params: [],
                generics: generics.length > 0 ? generics : undefined,
              },
            });
          }
          break;
        }

        case "function_definition":
        case "declaration": {
          const declarator = node.childForFieldName("declarator");
          if (!declarator || declarator.type !== "function_declarator") break;

          const declIdentifier = declarator.childForFieldName("declarator");
          if (!declIdentifier) break;

          const name = declIdentifier.text;
          const params = extractParameters(declarator);
          const returns = extractReturnType(node);
          const visibility = extractVisibility(node);

          const isDestructor =
            declIdentifier.type === "destructor_name" ||
            (context.className && name === `~${context.className}`);

          if (isDestructor) {
            const fqn = buildFQN(node, name);
            symbols.push({
              nodeId: `${filePath}:${fqn}:destructor`,
              kind: "constructor",
              name: fqn,
              exported: visibility === "public",
              visibility,
              range: extractRange(node),
              signature: {
                params,
                returns,
              },
            });
          } else if (context.className && name === context.className) {
            const fqn = buildFQN(node, name);
            symbols.push({
              nodeId: `${filePath}:${fqn}:constructor`,
              kind: "constructor",
              name: fqn,
              exported: visibility === "public",
              visibility,
              range: extractRange(node),
              signature: {
                params,
                returns,
              },
            });
          } else if (context.className) {
            const fqn = buildFQN(node, name);
            symbols.push({
              nodeId: `${filePath}:${fqn}:method`,
              kind: "method",
              name: fqn,
              exported: visibility === "public",
              visibility,
              range: extractRange(node),
              signature: {
                params,
                returns,
              },
            });
          } else {
            const fqn = buildFQN(node, name);
            symbols.push({
              nodeId: `${filePath}:${fqn}:function`,
              kind: "function",
              name: fqn,
              exported: true,
              visibility: "public",
              range: extractRange(node),
              signature: {
                params,
                returns,
              },
            });
          }
          break;
        }

        case "enum_specifier": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            const fqn = buildFQN(node, name);

            symbols.push({
              nodeId: `${filePath}:${fqn}:enum`,
              kind: "class",
              name: fqn,
              exported: true,
              visibility: "public",
              range: extractRange(node),
            });
          }
          break;
        }

        case "alias_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            const fqn = buildFQN(node, name);

            symbols.push({
              nodeId: `${filePath}:${fqn}:type`,
              kind: "type",
              name: fqn,
              exported: true,
              visibility: "public",
              range: extractRange(node),
            });
          }
          break;
        }
      }

      for (const child of node.children) {
        const newContext = { ...context };

        if (
          child.type === "class_specifier" ||
          child.type === "struct_specifier"
        ) {
          const nameNode = child.childForFieldName("name");
          if (nameNode) {
            newContext.className = nameNode.text;
          }
        }

        traverseAST(child, newContext);
      }
    }

    traverseAST(tree.rootNode, {});

    return symbols;
  }

  extractImports(
    tree: Tree,
    _content: string,
    _filePath: string,
  ): ExtractedImport[] {
    const imports: ExtractedImport[] = [];

    function traverseAST(node: Parser.SyntaxNode): void {
      if (node.type === "preproc_include") {
        const pathNode = node.childForFieldName("path");
        if (pathNode) {
          const path = pathNode.text;
          const isLocalInclude = path.startsWith('"') && path.endsWith('"');
          const isSystemInclude = path.startsWith("<") && path.endsWith(">");
          const isRelative =
            isLocalInclude && path.slice(1, -1).startsWith(".");

          if (isLocalInclude) {
            const cleanPath = path.slice(1, -1);
            imports.push({
              specifier: cleanPath,
              isRelative,
              isExternal: false,
              imports: [cleanPath],
              isReExport: false,
            });
          } else if (isSystemInclude) {
            const cleanPath = path.slice(1, -1);
            imports.push({
              specifier: cleanPath,
              isRelative: false,
              isExternal: true,
              imports: [cleanPath],
              isReExport: false,
            });
          }
        }
      }

      for (const child of node.children) {
        traverseAST(child);
      }
    }

    traverseAST(tree.rootNode);

    return imports;
  }

  extractCalls(
    tree: Tree,
    _content: string,
    filePath: string,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[] {
    const calls: ExtractedCall[] = [];
    const seenCallNodes = new Set<number>();

    const symbolMap = new Map<string, ExtractedSymbol>();
    for (const symbol of extractedSymbols) {
      const shortName = symbol.name.split("::").pop() || symbol.name;
      symbolMap.set(shortName, symbol);
      symbolMap.set(symbol.name, symbol);
    }

    function findEnclosingSymbol(node: Parser.SyntaxNode): string {
      let current: Parser.SyntaxNode | null = node;

      while (current) {
        const range = {
          startLine: current.startPosition.row + 1,
          startCol: current.startPosition.column,
          endLine: current.endPosition.row + 1,
          endCol: current.endPosition.column,
        };

        for (const symbol of extractedSymbols) {
          if (
            range.startLine >= symbol.range.startLine &&
            range.startCol >= symbol.range.startCol &&
            range.endLine <= symbol.range.endLine &&
            range.endCol <= symbol.range.endCol
          ) {
            return symbol.nodeId;
          }
        }

        current = current.parent;
      }

      return `${filePath}:root`;
    }

    function extractRange(node: Parser.SyntaxNode) {
      const start = node.startPosition;
      const end = node.endPosition;

      return {
        startLine: start.row + 1,
        startCol: start.column,
        endLine: end.row + 1,
        endCol: end.column,
      };
    }

    function traverseAST(node: Parser.SyntaxNode): void {
      if (node.type === "call_expression") {
        const nodeId = node.id;
        if (seenCallNodes.has(nodeId)) {
          for (const child of node.children) {
            traverseAST(child);
          }
          return;
        }
        seenCallNodes.add(nodeId);

        let calleeIdentifier = "";
        let callType: ExtractedCall["callType"] = "function";
        let isResolved = false;
        let calleeSymbolId: string | undefined;

        const funcNode = node.childForFieldName("function");
        if (funcNode) {
          if (funcNode.type === "identifier") {
            calleeIdentifier = funcNode.text;
            const symbol = symbolMap.get(funcNode.text);
            if (symbol) {
              isResolved = true;
              calleeSymbolId = symbol.nodeId;
            }
          } else if (funcNode.type === "field_expression") {
            const objectNode = funcNode.childForFieldName("argument");
            const fieldNode = funcNode.childForFieldName("field");
            if (objectNode && fieldNode) {
              calleeIdentifier = `${objectNode.text}.${fieldNode.text}`;
              callType = "method";

              if (objectNode.text === "this") {
                const symbol = symbolMap.get(fieldNode.text);
                if (symbol) {
                  isResolved = true;
                  calleeSymbolId = symbol.nodeId;
                }
              }
            }
          } else if (funcNode.type === "template_function") {
            const nameNode = funcNode.childForFieldName("name");
            if (nameNode) {
              calleeIdentifier = nameNode.text;
              const symbol = symbolMap.get(nameNode.text);
              if (symbol) {
                isResolved = true;
                calleeSymbolId = symbol.nodeId;
              }
            }
          }
        }

        const callerNodeId = findEnclosingSymbol(node);

        calls.push({
          callerNodeId,
          calleeIdentifier,
          isResolved,
          callType,
          calleeSymbolId,
          range: extractRange(node),
        });
      }

      if (node.type === "new_expression") {
        const nodeId = node.id;
        if (seenCallNodes.has(nodeId)) {
          for (const child of node.children) {
            traverseAST(child);
          }
          return;
        }
        seenCallNodes.add(nodeId);

        let calleeIdentifier = "";
        const callType: ExtractedCall["callType"] = "constructor";
        let isResolved = false;
        let calleeSymbolId: string | undefined;

        const typeNode = node.childForFieldName("type");
        if (typeNode) {
          calleeIdentifier = `new ${typeNode.text}`;
          isResolved = symbolMap.has(typeNode.text);
          if (isResolved) {
            const symbol = symbolMap.get(typeNode.text);
            if (symbol) {
              calleeSymbolId = symbol.nodeId;
            }
          }
        }

        const callerNodeId = findEnclosingSymbol(node);

        calls.push({
          callerNodeId,
          calleeIdentifier,
          isResolved,
          callType,
          calleeSymbolId,
          range: extractRange(node),
        });
      }

      for (const child of node.children) {
        traverseAST(child);
      }
    }

    traverseAST(tree.rootNode);

    return calls;
  }
}

function clearCache(): void {
  clearGrammarCache("cpp");
}

export { CppAdapter, clearCache };
