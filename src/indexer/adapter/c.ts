import Parser from "tree-sitter";
import type { Tree } from "tree-sitter";
import type { LanguageAdapter } from "./LanguageAdapter.js";
import type {
  ExtractedSymbol,
  ExtractedCall,
} from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import {
  getParser,
  clearCache as clearGrammarCache,
  createQuery,
} from "../treesitter/grammarLoader.js";
import { logger } from "../../util/logger.js";
import { findEnclosingSymbol as findEnclosingSymbolUtil } from "../treesitter/symbolUtils.js";

class CAdapter implements LanguageAdapter {
  languageId = "c";
  fileExtensions = [".c", ".h"] as const;

  private parser: Parser | null = null;

  getParser(): Parser | null {
    if (!this.parser) {
      this.parser = getParser("c");
    }
    return this.parser;
  }

  parse(content: string, _filePath: string): Tree | null {
    const parser = this.getParser();
    if (!parser) {
      return null;
    }

    try {
      // Use 1MB buffer to handle files >32KB (tree-sitter default limit)
      const tree = parser.parse(content, undefined, {
        bufferSize: 1024 * 1024,
      });

      if (!tree) {
        return null;
      }

      if (tree.rootNode.hasError) {
        logger.warn(
          "Syntax errors detected in C file - attempting partial extraction",
          { filePath: _filePath },
        );
      }

      return tree;
    } catch (error) {
      logger.error("Failed to parse C file", {
        filePath: _filePath,
        error,
      });
      return null;
    }
  }

  extractSymbols(
    tree: Tree,
    _content: string,
    filePath: string,
  ): ExtractedSymbol[] {
    const richSymbols = extractSymbols(tree);

    const symbols: ExtractedSymbol[] = richSymbols.map((symbol, idx) => ({
      nodeId: `${filePath}:${symbol.name}:${idx}`,
      kind: symbol.kind,
      name: symbol.name,
      exported: symbol.exported,
      range: symbol.range,
      signature: symbol.signature,
      visibility: symbol.visibility,
    }));

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
    _filePath: string,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[] {
    const calls: ExtractedCall[] = [];
    const seenCallNodes = new Set<number>();

    const symbolMap = new Map<string, ExtractedSymbol>();
    for (const symbol of extractedSymbols) {
      symbolMap.set(symbol.name, symbol);
    }

    const callQuery = createQuery(
      "c",
      `
      (call_expression
        function: (identifier) @callee)

      (call_expression
        function: (field_expression
          argument: (_) @obj
          field: (field_identifier) @field))
    `,
    );

    if (!callQuery) {
      return [];
    }

    const matches = callQuery.matches(tree.rootNode);

    for (const match of matches) {
      const calleeCapture = match.captures.find((c) => c.name === "callee");
      const objCapture = match.captures.find((c) => c.name === "obj");
      const fieldCapture = match.captures.find((c) => c.name === "field");

      let callNode: Parser.SyntaxNode | null = null;

      if (calleeCapture) {
        callNode = calleeCapture.node.parent;
      } else if (fieldCapture) {
        callNode = fieldCapture.node.parent?.parent || null;
      }

      if (!callNode || callNode.type !== "call_expression") continue;

      const nodeId = callNode.id;
      if (seenCallNodes.has(nodeId)) continue;
      seenCallNodes.add(nodeId);

      const funcNode = callNode.childForFieldName("function");
      if (!funcNode) continue;

      let calleeIdentifier = "";
      let callType: ExtractedCall["callType"] = "function";
      let isResolved = false;
      let calleeSymbolId: string | undefined;

      if (calleeCapture) {
        calleeIdentifier = calleeCapture.node.text;
        const symbol = symbolMap.get(calleeIdentifier);
        if (symbol) {
          isResolved = true;
          calleeSymbolId = symbol.nodeId;
        }
      } else if (fieldCapture && objCapture) {
        calleeIdentifier = `${objCapture.node.text}.${fieldCapture.node.text}`;
        callType = "method";

        if (objCapture.node.text === "this") {
          const symbol = symbolMap.get(fieldCapture.node.text);
          if (symbol) {
            isResolved = true;
            calleeSymbolId = symbol.nodeId;
          }
        }
      }

      const callerNodeId = findEnclosingSymbolUtil(callNode, extractedSymbols);

      calls.push({
        callerNodeId,
        calleeIdentifier,
        isResolved,
        callType,
        calleeSymbolId,
        range: extractRange(callNode),
      });

      if (
        objCapture &&
        objCapture.node.type === "call_expression" &&
        !seenCallNodes.has(objCapture.node.id)
      ) {
        extractNestedCall(
          objCapture.node,
          callerNodeId,
          symbolMap,
          calls,
          seenCallNodes,
          extractedSymbols,
        );
      }
    }

    return calls;
  }
}

function extractSymbols(tree: Parser.Tree): Array<{
  name: string;
  kind: ExtractedSymbol["kind"];
  exported: boolean;
  range: ExtractedSymbol["range"];
  signature?: ExtractedSymbol["signature"];
  visibility?: ExtractedSymbol["visibility"];
}> {
  const symbols: Array<{
    name: string;
    kind: ExtractedSymbol["kind"];
    exported: boolean;
    range: ExtractedSymbol["range"];
    signature?: ExtractedSymbol["signature"];
    visibility?: ExtractedSymbol["visibility"];
  }> = [];

  function traverse(node: Parser.SyntaxNode): void {
    switch (node.type) {
      case "function_definition": {
        const name = extractFunctionName(node);
        if (name) {
          const params = extractParameters(node);
          const returnType = extractReturnType(node);

          symbols.push({
            name,
            kind: "function",
            exported: true,
            range: extractRange(node),
            signature: {
              params,
              returns: returnType,
            },
            visibility: "public",
          });
        }
        break;
      }

      case "struct_specifier": {
        const name = extractStructName(node);
        if (name) {
          const members = extractStructMembers(node);

          symbols.push({
            name,
            kind: "class",
            exported: true,
            range: extractRange(node),
            signature: {
              params: members,
            },
            visibility: "public",
          });
        }
        break;
      }

      case "enum_specifier": {
        const name = extractEnumName(node);
        const values = extractEnumValues(node);

        if (name) {
          symbols.push({
            name,
            kind: "class",
            exported: true,
            range: extractRange(node),
            signature: {
              params: values.map((v) => ({ name: v })),
            },
            visibility: "public",
          });
        }
        break;
      }

      case "type_definition": {
        const name = extractTypedefName(node);
        if (name) {
          symbols.push({
            name,
            kind: "type",
            exported: true,
            range: extractRange(node),
            visibility: "public",
          });
        }
        break;
      }
    }

    for (const child of node.children) {
      traverse(child);
    }
  }

  traverse(tree.rootNode);
  return symbols;
}

function extractFunctionName(node: Parser.SyntaxNode): string | null {
  const declarator = node.childForFieldName("declarator");
  if (!declarator) return null;

  const identifier = findIdentifier(declarator);
  return identifier?.text || null;
}

function extractStructName(node: Parser.SyntaxNode): string | null {
  const name = node.childForFieldName("name");
  return name?.text || null;
}

function extractEnumName(node: Parser.SyntaxNode): string | null {
  const name = node.childForFieldName("name");
  return name?.text || null;
}

function extractTypedefName(node: Parser.SyntaxNode): string | null {
  for (const child of node.children) {
    if (child.type === "type_identifier") {
      return child.text;
    }

    if (child.type === "function_declarator") {
      const identifier = findIdentifierInDeclarator(child);
      if (identifier) {
        return identifier.text;
      }
    }
  }

  return null;
}

function findIdentifierInDeclarator(
  node: Parser.SyntaxNode,
): Parser.SyntaxNode | null {
  if (node.type === "identifier" || node.type === "type_identifier") {
    return node;
  }

  for (const child of node.children) {
    if (child.type === "parameter_list") {
      continue;
    }

    const result = findIdentifierInDeclarator(child);
    if (result) return result;
  }

  return null;
}

function findIdentifier(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === "identifier") {
    return node;
  }

  for (const child of node.children) {
    const result = findIdentifier(child);
    if (result) return result;
  }

  return null;
}

function extractParameters(
  node: Parser.SyntaxNode,
): Array<{ name: string; type?: string }> {
  const params: Array<{ name: string; type?: string }> = [];
  const declarator = node.childForFieldName("declarator");
  if (!declarator) return params;

  const parameters = declarator.childForFieldName("parameters");
  if (!parameters) return params;

  for (const child of parameters.children) {
    if (child.type === "parameter_declaration") {
      const paramInfo = extractParameterInfo(child);
      if (paramInfo) {
        params.push(paramInfo);
      }
    }
  }

  return params;
}

function extractParameterInfo(
  node: Parser.SyntaxNode,
): { name: string; type?: string } | null {
  const declarator = node.childForFieldName("declarator");
  if (!declarator) return null;

  const identifier = findIdentifier(declarator);
  if (!identifier) return null;

  const typeNode = node.children.find((c) => c.type !== "declarator");
  const typeText = typeNode?.text.trim();

  return {
    name: identifier.text,
    type: typeText,
  };
}

function extractReturnType(node: Parser.SyntaxNode): string | undefined {
  const typeNode = node.children.find((c) => c.type !== "declarator");
  return typeNode?.text.trim();
}

function extractStructMembers(
  node: Parser.SyntaxNode,
): Array<{ name: string; type?: string }> {
  const members: Array<{ name: string; type?: string }> = [];
  const body = node.childForFieldName("body");
  if (!body) return members;

  for (const child of body.children) {
    if (child.type === "field_declaration_list") {
      for (const fieldChild of child.children) {
        if (fieldChild.type === "field_declaration") {
          const fieldInfo = extractFieldInfo(fieldChild);
          if (fieldInfo) {
            members.push(fieldInfo);
          }
        }
      }
    }
  }

  return members;
}

function extractFieldInfo(
  node: Parser.SyntaxNode,
): { name: string; type?: string } | null {
  const declarator = node.childForFieldName("declarator");
  if (!declarator) return null;

  const identifier = findIdentifier(declarator);
  if (!identifier) return null;

  const typeNode = node.children.find((c) => c.type !== "declarator");
  const typeText = typeNode?.text.trim();

  return {
    name: identifier.text,
    type: typeText,
  };
}

function extractEnumValues(node: Parser.SyntaxNode): string[] {
  const values: string[] = [];
  const body = node.childForFieldName("body");
  if (!body) return values;

  for (const child of body.children) {
    if (child.type === "enumerator_list") {
      for (const enumChild of child.children) {
        if (enumChild.type === "enumerator") {
          const name = enumChild.childForFieldName("name");
          if (name) {
            values.push(name.text);
          }
        }
      }
    }
  }

  return values;
}

function extractRange(node: Parser.SyntaxNode): ExtractedSymbol["range"] {
  const start = node.startPosition;
  const end = node.endPosition;

  return {
    startLine: start.row + 1,
    startCol: start.column,
    endLine: end.row + 1,
    endCol: end.column,
  };
}

function extractNestedCall(
  callNode: Parser.SyntaxNode,
  callerNodeId: string,
  symbolMap: Map<string, ExtractedSymbol>,
  calls: ExtractedCall[],
  seenCallNodes: Set<number>,
  _extractedSymbols: ExtractedSymbol[],
): void {
  if (!callNode || seenCallNodes.has(callNode.id)) return;

  seenCallNodes.add(callNode.id);

  const funcNode = callNode.childForFieldName("function");
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
  } else if (funcNode.type === "field_expression") {
    const obj = funcNode.childForFieldName("argument");
    const field = funcNode.childForFieldName("field");
    if (obj && field) {
      calleeIdentifier = `${obj.text}.${field.text}`;
      callType = "method";
    }
  }

  calls.push({
    callerNodeId,
    calleeIdentifier,
    isResolved,
    callType,
    calleeSymbolId,
    range: extractRange(callNode),
  });
}

function clearCache(): void {
  clearGrammarCache("c");
}

export { CAdapter, clearCache };
