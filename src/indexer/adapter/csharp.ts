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
import { findEnclosingSymbol as findEnclosingSymbolUtil } from "../treesitter/symbolUtils.js";

class CSharpAdapter implements LanguageAdapter {
  languageId = "csharp";
  fileExtensions = [".cs"] as const;

  private parser: Parser | null = null;

  getParser(): Parser | null {
    if (!this.parser) {
      this.parser = getParser("csharp");
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
        `[sdl-mcp] Failed to parse C# file ${filePath}: ${error instanceof Error ? error.message : String(error)}\n`,
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
    const normalizedPath = filePath.replace(/\\/g, "/");
    this.traverseASTForSymbols(tree.rootNode, symbols, normalizedPath);
    return symbols;
  }

  extractImports(
    tree: Tree,
    _content: string,
    _filePath: string,
  ): ExtractedImport[] {
    return this.extractImportsImpl(tree);
  }

  extractCalls(
    tree: Tree,
    _content: string,
    _filePath: string,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[] {
    return this.extractCallsImpl(tree, extractedSymbols);
  }

  private traverseASTForSymbols(
    node: Parser.SyntaxNode,
    symbols: ExtractedSymbol[],
    filePath: string,
  ): void {
    switch (node.type) {
      case "namespace_declaration":
        const namespaceSymbol = this.processNamespaceDeclaration(
          node,
          filePath,
        );
        if (namespaceSymbol) symbols.push(namespaceSymbol);
        break;

      case "class_declaration":
        const classSymbol = this.processClassDeclaration(node, filePath);
        if (classSymbol) symbols.push(classSymbol);
        break;

      case "interface_declaration":
        const interfaceSymbol = this.processInterfaceDeclaration(
          node,
          filePath,
        );
        if (interfaceSymbol) symbols.push(interfaceSymbol);
        break;

      case "struct_declaration":
        const structSymbol = this.processStructDeclaration(node, filePath);
        if (structSymbol) symbols.push(structSymbol);
        break;

      case "enum_declaration":
        const enumSymbol = this.processEnumDeclaration(node, filePath);
        if (enumSymbol) symbols.push(enumSymbol);
        break;

      case "record_declaration":
        const recordSymbol = this.processRecordDeclaration(node, filePath);
        if (recordSymbol) symbols.push(recordSymbol);
        break;

      case "method_declaration":
        const methodSymbol = this.processMethodDeclaration(node, filePath);
        if (methodSymbol) symbols.push(methodSymbol);
        break;

      case "constructor_declaration":
        const constructorSymbol = this.processConstructorDeclaration(
          node,
          filePath,
        );
        if (constructorSymbol) symbols.push(constructorSymbol);
        break;

      case "property_declaration":
        const propertySymbol = this.processPropertyDeclaration(node, filePath);
        if (propertySymbol) symbols.push(propertySymbol);
        break;

      case "field_declaration":
        const fieldSymbol = this.processFieldDeclaration(node, filePath);
        if (fieldSymbol) symbols.push(fieldSymbol);
        break;
    }

    for (const child of node.children) {
      this.traverseASTForSymbols(child, symbols, filePath);
    }
  }

  private extractIdentifier(node: Parser.SyntaxNode | null): string | null {
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

  private extractRange(node: Parser.SyntaxNode) {
    const start = node.startPosition;
    const end = node.endPosition;

    return {
      startLine: start.row + 1,
      startCol: start.column,
      endLine: end.row + 1,
      endCol: end.column,
    };
  }

  private extractVisibility(
    node: Parser.SyntaxNode,
  ): "public" | "private" | "protected" | "internal" | undefined {
    for (const child of node.children) {
      if (child.type === "modifiers") {
        for (const modifier of child.children) {
          if (modifier.type === "accessibility_modifier") {
            const modifierText = modifier.text;
            if (modifierText === "public") return "public";
            if (modifierText === "private") return "private";
            if (modifierText === "protected") return "protected";
            if (modifierText === "internal") return "internal";
          }
        }
      }
    }
    return undefined;
  }

  private extractModifiers(node: Parser.SyntaxNode): string[] {
    const modifiers: string[] = [];
    const modifiersNode = node.children.find((c) => c.type === "modifiers");
    if (modifiersNode) {
      for (const child of modifiersNode.children) {
        if (child.type === "accessibility_modifier") {
          modifiers.push(child.text);
        } else if (
          child.type === "static_modifier" ||
          child.type === "async_modifier" ||
          child.type === "readonly_modifier" ||
          child.type === "override_modifier" ||
          child.type === "virtual_modifier" ||
          child.type === "abstract_modifier" ||
          child.type === "sealed_modifier" ||
          child.type === "unsafe_modifier"
        ) {
          modifiers.push(child.text);
        }
      }
    }
    return modifiers;
  }

  private extractTypeParameters(node: Parser.SyntaxNode): string[] {
    const generics: string[] = [];
    const typeParams = node.children.find(
      (c) => c.type === "type_parameter_list",
    );
    if (typeParams) {
      for (const child of typeParams.children) {
        if (child.type === "type_parameter") {
          generics.push(child.text);
        }
      }
    }
    return generics;
  }

  private extractParameters(
    node: Parser.SyntaxNode,
  ): Array<{ name: string; type?: string }> {
    const params: Array<{ name: string; type?: string }> = [];
    const paramList = node.children.find((c) => c.type === "parameter_list");
    if (paramList) {
      for (const child of paramList.children) {
        if (child.type === "parameter") {
          const identifier = this.extractIdentifier(child);
          const typeAnnotation = child.children.find((c) => c.type === "type");
          if (identifier) {
            params.push({
              name: identifier,
              type: typeAnnotation ? typeAnnotation.text : undefined,
            });
          }
        }
      }
    }
    return params;
  }

  private extractReturnType(node: Parser.SyntaxNode): string | undefined {
    const typeNode = node.children.find((c) => c.type === "type");
    if (typeNode) {
      return typeNode.text;
    }
    return undefined;
  }

  private processNamespaceDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
  ): ExtractedSymbol | null {
    const name = node.childForFieldName("name");
    if (!name) return null;

    return {
      nodeId: `${filePath}:${name.text}:0`,
      kind: "module",
      name: name.text,
      exported: true,
      range: this.extractRange(node),
    };
  }

  private processClassDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
  ): ExtractedSymbol | null {
    const name = this.extractIdentifier(node);
    if (!name) return null;

    const visibility = this.extractVisibility(node);
    const generics = this.extractTypeParameters(node);

    return {
      nodeId: `${filePath}:${name}:${this.hashCode(node.id)}`,
      kind: "class",
      name,
      exported: visibility === "public",
      visibility,
      range: this.extractRange(node),
      signature: {
        params: [],
        generics: generics.length > 0 ? generics : undefined,
      },
    };
  }

  private processInterfaceDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
  ): ExtractedSymbol | null {
    const name = this.extractIdentifier(node);
    if (!name) return null;

    const visibility = this.extractVisibility(node);
    const generics = this.extractTypeParameters(node);

    return {
      nodeId: `${filePath}:${name}:${this.hashCode(node.id)}`,
      kind: "interface",
      name,
      exported: visibility === "public",
      visibility,
      range: this.extractRange(node),
      signature: {
        params: [],
        generics: generics.length > 0 ? generics : undefined,
      },
    };
  }

  private processStructDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
  ): ExtractedSymbol | null {
    const name = this.extractIdentifier(node);
    if (!name) return null;

    const visibility = this.extractVisibility(node);
    const generics = this.extractTypeParameters(node);

    return {
      nodeId: `${filePath}:${name}:${this.hashCode(node.id)}`,
      kind: "class",
      name,
      exported: visibility === "public",
      visibility,
      range: this.extractRange(node),
      signature: {
        params: [],
        generics: generics.length > 0 ? generics : undefined,
      },
    };
  }

  private processEnumDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
  ): ExtractedSymbol | null {
    const name = this.extractIdentifier(node);
    if (!name) return null;

    const visibility = this.extractVisibility(node);

    return {
      nodeId: `${filePath}:${name}:${this.hashCode(node.id)}`,
      kind: "type",
      name,
      exported: visibility === "public",
      visibility,
      range: this.extractRange(node),
    };
  }

  private processRecordDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
  ): ExtractedSymbol | null {
    const name = this.extractIdentifier(node);
    if (!name) return null;

    const visibility = this.extractVisibility(node);
    const generics = this.extractTypeParameters(node);

    return {
      nodeId: `${filePath}:${name}:${this.hashCode(node.id)}`,
      kind: "class",
      name,
      exported: visibility === "public",
      visibility,
      range: this.extractRange(node),
      signature: {
        params: [],
        generics: generics.length > 0 ? generics : undefined,
      },
    };
  }

  private processMethodDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
  ): ExtractedSymbol | null {
    const name = this.extractIdentifier(node);
    if (!name) return null;

    const visibility = this.extractVisibility(node);
    const modifiers = this.extractModifiers(node);
    const params = this.extractParameters(node);
    const returns = this.extractReturnType(node);

    const isAsync = modifiers.includes("async");

    return {
      nodeId: `${filePath}:${name}:${this.hashCode(node.id)}`,
      kind: "method",
      name,
      exported: visibility === "public",
      visibility,
      range: this.extractRange(node),
      signature: {
        params,
        returns: returns || (isAsync ? "Task" : "void"),
      },
    };
  }

  private processConstructorDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
  ): ExtractedSymbol | null {
    const name = this.extractIdentifier(node);
    if (!name) return null;

    const visibility = this.extractVisibility(node);
    const params = this.extractParameters(node);

    return {
      nodeId: `${filePath}:${name}:${this.hashCode(node.id)}`,
      kind: "constructor",
      name: "constructor",
      exported: visibility === "public",
      visibility,
      range: this.extractRange(node),
      signature: {
        params,
      },
    };
  }

  private processPropertyDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
  ): ExtractedSymbol | null {
    const name = this.extractIdentifier(node);
    if (!name) return null;

    const visibility = this.extractVisibility(node);

    return {
      nodeId: `${filePath}:${name}:${this.hashCode(node.id)}`,
      kind: "variable",
      name,
      exported: visibility === "public",
      visibility,
      range: this.extractRange(node),
    };
  }

  private processFieldDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
  ): ExtractedSymbol | null {
    const name = this.extractIdentifier(node);
    if (!name) return null;

    const visibility = this.extractVisibility(node);

    return {
      nodeId: `${filePath}:${name}:${this.hashCode(node.id)}`,
      kind: "variable",
      name,
      exported: visibility === "public",
      visibility,
      range: this.extractRange(node),
    };
  }

  private hashCode(id: number): number {
    return Math.abs(id);
  }

  private extractImportsImpl(tree: Tree): ExtractedImport[] {
    const imports: ExtractedImport[] = [];
    this.traverseForImports(tree.rootNode, imports);
    return imports;
  }

  private traverseForImports(
    node: Parser.SyntaxNode,
    imports: ExtractedImport[],
  ): void {
    if (node.type === "using_directive") {
      this.processUsingDirective(node, imports, false);
    } else if (node.type === "global_using_directive") {
      this.processUsingDirective(node, imports, true);
    }

    for (const child of node.children) {
      this.traverseForImports(child, imports);
    }
  }

  private processUsingDirective(
    node: Parser.SyntaxNode,
    imports: ExtractedImport[],
    _isGlobal: boolean,
  ): void {
    let isStatic = false;
    let alias: string | undefined;
    let namespace = "";
    let aliasIdentifier = "";

    for (const child of node.children) {
      if (child.type === "static_modifier") {
        isStatic = true;
      } else if (child.type === "identifier") {
        if (!aliasIdentifier) {
          aliasIdentifier = child.text;
        } else {
          namespace = child.text;
        }
      } else if (child.type === "type" || child.type === "qualified_name") {
        const name = this.extractQualifiedName(child);
        if (name) {
          if (!namespace) {
            namespace = name;
          } else {
            namespace = name;
          }
        }
      } else if (child.type === "name_equals") {
        const identifier = child.children.find((c) => c.type === "identifier");
        if (identifier) {
          alias = identifier.text;
        }
      }
    }

    if (!namespace && aliasIdentifier) {
      namespace = aliasIdentifier;
    }

    if (namespace) {
      const isRelative = false;
      const isExternal =
        !namespace.startsWith("System") && !namespace.startsWith("global::");

      const importData: ExtractedImport = {
        specifier: namespace,
        isRelative,
        isExternal,
        imports: isStatic ? ["*"] : [],
        isReExport: false,
      };

      if (alias) {
        importData.defaultImport = alias;
      }

      imports.push(importData);
    }
  }

  private extractQualifiedName(node: Parser.SyntaxNode): string | null {
    if (node.type === "identifier") {
      return node.text;
    }

    if (node.type === "qualified_name") {
      const parts: string[] = [];
      for (const child of node.children) {
        if (child.type === "identifier" || child.type === "qualified_name") {
          const name = this.extractQualifiedName(child);
          if (name) parts.push(name);
        }
      }
      return parts.length > 0 ? parts.join(".") : null;
    }

    return null;
  }

  private extractCallsImpl(
    tree: Tree,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[] {
    const calls: ExtractedCall[] = [];
    const seenCallNodes = new Set<number>();

    const symbolMap = new Map<string, ExtractedSymbol>();
    for (const symbol of extractedSymbols) {
      symbolMap.set(symbol.name, symbol);
    }

    this.traverseForCalls(
      tree.rootNode,
      calls,
      seenCallNodes,
      symbolMap,
      extractedSymbols,
    );

    return calls;
  }

  private traverseForCalls(
    node: Parser.SyntaxNode,
    calls: ExtractedCall[],
    seenCallNodes: Set<number>,
    symbolMap: Map<string, ExtractedSymbol>,
    extractedSymbols: ExtractedSymbol[],
  ): void {
    if (node.type === "invocation_expression") {
      this.processInvocation(
        node,
        calls,
        seenCallNodes,
        symbolMap,
        extractedSymbols,
      );
    } else if (node.type === "object_creation_expression") {
      this.processObjectCreation(
        node,
        calls,
        seenCallNodes,
        symbolMap,
        extractedSymbols,
      );
    } else if (node.type === "await_expression") {
      this.processAwaitExpression(
        node,
        calls,
        seenCallNodes,
        symbolMap,
        extractedSymbols,
      );
    }

    for (const child of node.children) {
      this.traverseForCalls(
        child,
        calls,
        seenCallNodes,
        symbolMap,
        extractedSymbols,
      );
    }
  }

  private processInvocation(
    node: Parser.SyntaxNode,
    calls: ExtractedCall[],
    seenCallNodes: Set<number>,
    symbolMap: Map<string, ExtractedSymbol>,
    extractedSymbols: ExtractedSymbol[],
  ): void {
    const nodeId = node.id;
    if (seenCallNodes.has(nodeId)) return;
    seenCallNodes.add(nodeId);

    const funcNode = node.childForFieldName("function");
    if (!funcNode) return;

    let calleeIdentifier = "";
    let callType: ExtractedCall["callType"] = "function";
    let isResolved = false;
    let calleeSymbolId: string | undefined;

    if (funcNode.type === "identifier") {
      calleeIdentifier = funcNode.text;
      const symbol = symbolMap.get(calleeIdentifier);
      if (symbol) {
        isResolved = true;
        calleeSymbolId = symbol.nodeId;
      }
    } else if (funcNode.type === "member_access_expression") {
      callType = "method";
      const obj =
        funcNode.childForFieldName("expression") ||
        funcNode.children.find((c) => c.type === "identifier");
      const prop =
        funcNode.childForFieldName("name") ||
        funcNode.children.find((c) => c.type === "identifier" && c !== obj);
      if (obj && prop && obj !== prop) {
        calleeIdentifier = `${obj.text}.${prop.text}`;
        if (obj.text === "this" || obj.text === "base") {
          isResolved = symbolMap.has(prop.text);
          if (isResolved) {
            const resolvedSymbol = symbolMap.get(prop.text);
            if (resolvedSymbol) {
              calleeSymbolId = resolvedSymbol.nodeId;
            }
          }
        }
      }
    } else if (funcNode.type === "generic_name") {
      const identifier = funcNode.childForFieldName("name");
      if (identifier) {
        calleeIdentifier = identifier.text;
        const symbol = symbolMap.get(calleeIdentifier);
        if (symbol) {
          isResolved = true;
          calleeSymbolId = symbol.nodeId;
        }
      }
    }

    const range = {
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column,
    };

    const callerNodeId = this.findEnclosingSymbol(node, extractedSymbols);

    calls.push({
      callerNodeId,
      calleeIdentifier,
      isResolved,
      callType,
      calleeSymbolId,
      range,
    });

    this.extractChainedCalls(
      funcNode,
      callerNodeId,
      calls,
      seenCallNodes,
      symbolMap,
      extractedSymbols,
    );
  }

  private processObjectCreation(
    node: Parser.SyntaxNode,
    calls: ExtractedCall[],
    seenCallNodes: Set<number>,
    symbolMap: Map<string, ExtractedSymbol>,
    extractedSymbols: ExtractedSymbol[],
  ): void {
    const nodeId = node.id;
    if (seenCallNodes.has(nodeId)) return;
    seenCallNodes.add(nodeId);

    const typeNode = node.childForFieldName("type");
    if (!typeNode) return;

    let calleeIdentifier = "";
    let isResolved = false;
    let calleeSymbolId: string | undefined;

    if (typeNode.type === "identifier") {
      calleeIdentifier = `new ${typeNode.text}`;
      const symbol = symbolMap.get(typeNode.text);
      if (symbol) {
        isResolved = true;
        calleeSymbolId = symbol.nodeId;
      }
    } else if (typeNode.type === "generic_name") {
      const identifier = typeNode.childForFieldName("name");
      if (identifier) {
        calleeIdentifier = `new ${identifier.text}`;
        const symbol = symbolMap.get(identifier.text);
        if (symbol) {
          isResolved = true;
          calleeSymbolId = symbol.nodeId;
        }
      }
    }

    const range = {
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column,
    };

    const callerNodeId = this.findEnclosingSymbol(node, extractedSymbols);

    calls.push({
      callerNodeId,
      calleeIdentifier,
      isResolved,
      callType: "constructor",
      calleeSymbolId,
      range,
    });
  }

  private processAwaitExpression(
    node: Parser.SyntaxNode,
    calls: ExtractedCall[],
    seenCallNodes: Set<number>,
    symbolMap: Map<string, ExtractedSymbol>,
    extractedSymbols: ExtractedSymbol[],
  ): void {
    const expression = node.firstChild;
    if (!expression) return;

    if (expression.type === "invocation_expression") {
      this.processInvocation(
        expression,
        calls,
        seenCallNodes,
        symbolMap,
        extractedSymbols,
      );
    } else if (expression.type === "object_creation_expression") {
      this.processObjectCreation(
        expression,
        calls,
        seenCallNodes,
        symbolMap,
        extractedSymbols,
      );
    }
  }

  private extractChainedCalls(
    node: Parser.SyntaxNode,
    callerNodeId: string,
    calls: ExtractedCall[],
    seenCallNodes: Set<number>,
    symbolMap: Map<string, ExtractedSymbol>,
    extractedSymbols: ExtractedSymbol[],
  ): void {
    if (!node) return;

    if (node.type === "member_access_expression") {
      const obj =
        node.childForFieldName("expression") ||
        node.children.find((c) => c.type === "identifier");
      if (obj?.type === "invocation_expression") {
        const callNode = obj;
        if (!seenCallNodes.has(callNode.id)) {
          this.processInvocation(
            callNode,
            calls,
            seenCallNodes,
            symbolMap,
            extractedSymbols,
          );
        }
      }
    }

    for (const child of node.children) {
      this.extractChainedCalls(
        child,
        callerNodeId,
        calls,
        seenCallNodes,
        symbolMap,
        extractedSymbols,
      );
    }
  }

  private findEnclosingSymbol(
    node: Parser.SyntaxNode,
    symbols: ExtractedSymbol[],
  ): string {
    return findEnclosingSymbolUtil(node, symbols);
  }
}

function clearCache(): void {
  clearGrammarCache("csharp");
}

export { CSharpAdapter, clearCache };
