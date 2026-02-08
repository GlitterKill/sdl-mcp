import type { Tree, SyntaxNode } from "tree-sitter";
import { BaseAdapter } from "./BaseAdapter.js";
import type {
  ExtractedSymbol,
  ExtractedCall,
} from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import { createClearCacheFunction } from "./BaseAdapter.js";

class JavaAdapter extends BaseAdapter {
  languageId = "java";
  fileExtensions = [".java"] as const;

  extractSymbols(
    tree: Tree,
    _content: string,
    filePath: string,
  ): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];

    function extractIdentifier(node: SyntaxNode): string | null {
      if (!node) return null;

      if (node.type === "identifier") {
        return node.text;
      }

      for (const child of node.children) {
        if (child.type === "identifier") {
          return child.text;
        }
      }

      return null;
    }

    function extractModifiers(
      node: SyntaxNode,
    ): "public" | "private" | "protected" | undefined {
      const modifiersNode = node.children.find(
        (c: SyntaxNode) => c.type === "modifiers",
      );
      if (!modifiersNode) return undefined;

      for (const child of modifiersNode.children) {
        if (child.type === "public") return "public";
        if (child.type === "private") return "private";
        if (child.type === "protected") return "protected";
      }

      return undefined;
    }

    function extractGenerics(node: SyntaxNode): string[] {
      const generics: string[] = [];

      const typeParams = node.children.find(
        (c: SyntaxNode) => c.type === "type_parameters",
      );
      if (typeParams) {
        for (const child of typeParams.children) {
          if (child.type === "type_identifier") {
            generics.push(child.text);
          }
        }
      }

      return generics;
    }

    function extractParameters(
      node: SyntaxNode,
    ): Array<{ name: string; type?: string }> {
      const params: Array<{ name: string; type?: string }> = [];

      const formalParams = node.children.find(
        (c: SyntaxNode) => c.type === "formal_parameters",
      );
      if (!formalParams) return params;

      for (const child of formalParams.children) {
        if (child.type === "formal_parameter") {
          const identifier = child.children.find(
            (c: SyntaxNode) => c.type === "identifier",
          );
          const typeNode = child.children.find(
            (c: SyntaxNode) => c.type === "type_identifier",
          );

          if (identifier) {
            params.push({
              name: identifier.text,
              type: typeNode ? typeNode.text : undefined,
            });
          }
        }
      }

      return params;
    }

    function extractReturnType(node: SyntaxNode): string | undefined {
      const typeNode = node.children.find(
        (c: SyntaxNode) => c.type === "type_identifier",
      );
      if (typeNode) return typeNode.text;

      const voidNode = node.children.find(
        (c: SyntaxNode) => c.type === "void_type",
      );
      if (voidNode) return "void";

      return undefined;
    }

    const traverseAST = (node: SyntaxNode): void => {
      switch (node.type) {
        case "package_declaration": {
          const packageNode = node.children.find(
            (c: SyntaxNode) => c.type === "scoped_identifier",
          );
          if (packageNode) {
            const name = packageNode.text;
            symbols.push({
              nodeId: `${filePath}:${name}:package`,
              kind: "module",
              name,
              exported: true,
              visibility: "public",
              range: this.extractRange(node),
            });
          }
          break;
        }

        case "class_declaration": {
          const name = extractIdentifier(node);
          if (name) {
            const generics = extractGenerics(node);
            const visibility = extractModifiers(node) || "public";

            symbols.push({
              nodeId: `${filePath}:${name}:class`,
              kind: "class",
              name,
              exported: visibility === "public",
              visibility,
              range: this.extractRange(node),
              signature: {
                params: [],
                generics: generics.length > 0 ? generics : undefined,
              },
            });
          }
          break;
        }

        case "interface_declaration": {
          const name = extractIdentifier(node);
          if (name) {
            const generics = extractGenerics(node);
            const visibility = extractModifiers(node) || "public";

            symbols.push({
              nodeId: `${filePath}:${name}:interface`,
              kind: "interface",
              name,
              exported: visibility === "public",
              visibility,
              range: this.extractRange(node),
              signature: {
                params: [],
                generics: generics.length > 0 ? generics : undefined,
              },
            });
          }
          break;
        }

        case "enum_declaration": {
          const name = extractIdentifier(node);
          if (name) {
            const visibility = extractModifiers(node) || "public";

            symbols.push({
              nodeId: `${filePath}:${name}:enum`,
              kind: "class",
              name,
              exported: visibility === "public",
              visibility,
              range: this.extractRange(node),
            });
          }
          break;
        }

        case "record_declaration": {
          const name = extractIdentifier(node);
          if (name) {
            const generics = extractGenerics(node);
            const visibility = extractModifiers(node) || "public";

            symbols.push({
              nodeId: `${filePath}:${name}:record`,
              kind: "class",
              name,
              exported: visibility === "public",
              visibility,
              range: this.extractRange(node),
              signature: {
                params: [],
                generics: generics.length > 0 ? generics : undefined,
              },
            });
          }
          break;
        }

        case "method_declaration": {
          const name = extractIdentifier(node);
          if (name) {
            const params = extractParameters(node);
            const returns = extractReturnType(node);
            const visibility = extractModifiers(node) || "public";

            symbols.push({
              nodeId: `${filePath}:${name}:method`,
              kind: "method",
              name,
              exported: visibility === "public",
              visibility,
              range: this.extractRange(node),
              signature: {
                params,
                returns,
              },
            });
          }
          break;
        }

        case "constructor_declaration": {
          const name = extractIdentifier(node);
          if (name) {
            const params = extractParameters(node);
            const visibility = extractModifiers(node) || "public";

            symbols.push({
              nodeId: `${filePath}:${name}:constructor`,
              kind: "constructor",
              name,
              exported: visibility === "public",
              visibility,
              range: this.extractRange(node),
              signature: {
                params,
                returns: name,
              },
            });
          }
          break;
        }

        case "field_declaration": {
          const declarators = node.children.filter(
            (c: SyntaxNode) => c.type === "variable_declarator",
          );
          for (const declarator of declarators) {
            const name = extractIdentifier(declarator);
            if (name) {
              const visibility = extractModifiers(node) || "private";
              symbols.push({
                nodeId: `${filePath}:${name}:field`,
                kind: "variable",
                name,
                exported: false,
                visibility,
                range: this.extractRange(declarator),
              });
            }
          }
          break;
        }
      }

      for (const child of node.children) {
        traverseAST(child);
      }
    };

    traverseAST(tree.rootNode);

    return symbols;
  }

  extractImports(
    tree: Tree,
    _content: string,
    _filePath: string,
  ): ExtractedImport[] {
    const imports: ExtractedImport[] = [];

    function traverseAST(node: SyntaxNode): void {
      if (node.type === "import_declaration") {
        const modifiers = node.children.find(
          (c: SyntaxNode) => c.type === "modifiers",
        );
        const isStatic = modifiers?.children.some(
          (c: SyntaxNode) => c.type === "static",
        );

        let specifier = "";
        let isWildcard = false;

        const scopedIdentifier = node.children.find(
          (c: SyntaxNode) =>
            c.type === "scoped_identifier" || c.type === "identifier",
        );

        if (scopedIdentifier) {
          specifier = scopedIdentifier.text;

          const asterisk = scopedIdentifier.children.find(
            (c: SyntaxNode) => c.type === "*",
          );
          isWildcard = !!asterisk;
        }

        const hasAsterisk = node.children.some(
          (c: SyntaxNode) => c.type === "*",
        );
        if (hasAsterisk) {
          isWildcard = true;
          const lastScoped = node.children.find(
            (c: SyntaxNode) => c.type === "scoped_identifier",
          );
          if (lastScoped) {
            specifier = lastScoped.text;
          }
        }

        const result: ExtractedImport = {
          specifier,
          isRelative: false,
          isExternal:
            !specifier.startsWith("java.") &&
            !specifier.startsWith("javax.") &&
            !specifier.startsWith("com."),
          imports: isWildcard ? ["*"] : [specifier.split(".").pop() || ""],
          isReExport: false,
        };

        if (isStatic) {
          result.imports = [`static ${specifier}`];
        }

        imports.push(result);
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
    _filePath: string,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[] {
    const calls: ExtractedCall[] = [];
    const seenCallNodes = new Set<number>();

    const symbolMap = new Map<string, ExtractedSymbol>();
    for (const symbol of extractedSymbols) {
      symbolMap.set(symbol.name, symbol);
    }

    const traverseAST = (node: SyntaxNode): void => {
      if (node.type === "method_invocation") {
        const nodeId = node.id;
        if (seenCallNodes.has(nodeId)) {
          for (const child of node.children) {
            traverseAST(child);
          }
          return;
        }
        seenCallNodes.add(nodeId);

        let calleeIdentifier = "";
        let callType: ExtractedCall["callType"] = "method";
        let isResolved = false;
        let calleeSymbolId: string | undefined;

        const objectNode = node.childForFieldName("object");
        const nameNode = node.childForFieldName("name");

        if (objectNode) {
          const objText = objectNode.text;

          if (nameNode) {
            calleeIdentifier = `${objText}.${nameNode.text}`;

            if (objText === "this" || objText === "super") {
              isResolved = symbolMap.has(nameNode.text);
              if (isResolved) {
                const resolvedSymbol = symbolMap.get(nameNode.text);
                if (resolvedSymbol) {
                  calleeSymbolId = resolvedSymbol.nodeId;
                }
              }
            } else {
              const symbol = symbolMap.get(objText);
              if (
                symbol &&
                (symbol.kind === "class" || symbol.kind === "interface")
              ) {
                isResolved = true;
                calleeSymbolId = `${objText}.${nameNode.text}`;
              }
            }
          }
        } else if (nameNode) {
          calleeIdentifier = nameNode.text;

          if (nameNode.text === "this" || nameNode.text === "super") {
            callType = "constructor";
            isResolved = true;
          } else {
            const symbol = symbolMap.get(nameNode.text);
            if (symbol) {
              isResolved = true;
              calleeSymbolId = symbol.nodeId;
            }
          }
        }

        const callerNodeId = this.findEnclosingSymbol(
          node,
          extractedSymbols,
        );

        calls.push({
          callerNodeId,
          calleeIdentifier,
          isResolved,
          callType,
          calleeSymbolId,
          range: this.extractRange(node),
        });
      }

      if (node.type === "object_creation_expression") {
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

        const callerNodeId = this.findEnclosingSymbol(
          node,
          extractedSymbols,
        );

        calls.push({
          callerNodeId,
          calleeIdentifier,
          isResolved,
          callType,
          calleeSymbolId,
          range: this.extractRange(node),
        });
      }

      for (const child of node.children) {
        traverseAST(child);
      }
    };

    traverseAST(tree.rootNode);

    return calls;
  }
}

const clearCache = createClearCacheFunction("java");

export { JavaAdapter, clearCache };
