import Parser from "tree-sitter";
import type { Tree, QueryCapture } from "tree-sitter";
import type { LanguageAdapter } from "./LanguageAdapter.js";
import {
  getParser,
  clearCache as clearGrammarCache,
  createQuery,
} from "../treesitter/grammarLoader.js";
import type {
  ExtractedSymbol,
  ExtractedCall,
} from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import { logger } from "../../util/logger.js";
import { findEnclosingSymbol as findEnclosingSymbolUtil } from "../treesitter/symbolUtils.js";

class RustAdapter implements LanguageAdapter {
  languageId = "rust";
  fileExtensions = [".rs"] as const;

  private parser: Parser | null = null;

  getParser(): Parser | null {
    if (!this.parser) {
      this.parser = getParser("rust");
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
          "Syntax errors detected in Rust file - attempting partial extraction",
          { filePath: _filePath },
        );
      }

      return tree;
    } catch (error) {
      logger.error("Failed to parse Rust file", {
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
    return extractImports(tree);
  }

  extractCalls(
    tree: Tree,
    _content: string,
    _filePath: string,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[] {
    return extractCalls(tree, extractedSymbols);
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
      case "function_item": {
        const name = extractFunctionName(node);
        if (name) {
          const params = extractFunctionParameters(node);
          const returnType = extractFunctionReturnType(node);
          const generics = extractGenerics(node);
          const visibility = extractVisibility(node);

          symbols.push({
            name,
            kind: "function",
            exported: visibility === "public",
            range: extractRange(node),
            signature: {
              params,
              returns: returnType,
              generics,
            },
            visibility,
          });
        }
        break;
      }

      case "struct_item": {
        const name = extractStructName(node);
        if (name) {
          const fields = extractStructFields(node);
          const generics = extractGenerics(node);
          const visibility = extractVisibility(node);

          symbols.push({
            name,
            kind: "class",
            exported: visibility === "public",
            range: extractRange(node),
            signature: {
              params: fields,
              generics,
            },
            visibility,
          });
        }
        break;
      }

      case "enum_item": {
        const name = extractEnumName(node);
        if (name) {
          const variants = extractEnumVariants(node);
          const generics = extractGenerics(node);
          const visibility = extractVisibility(node);

          symbols.push({
            name,
            kind: "type",
            exported: visibility === "public",
            range: extractRange(node),
            signature: {
              params: variants,
              generics,
            },
            visibility,
          });
        }
        break;
      }

      case "trait_item": {
        const name = extractTraitName(node);
        if (name) {
          const generics = extractGenerics(node);
          const visibility = extractVisibility(node);

          symbols.push({
            name,
            kind: "interface",
            exported: visibility === "public",
            range: extractRange(node),
            signature: {
              params: [],
              returns: undefined,
              generics,
            },
            visibility,
          });
        }
        break;
      }

      case "impl_item": {
        const implInfo = extractImplInfo(node);
        if (implInfo) {
          const methods = extractImplMethods(node, implInfo.typeName);
          for (const method of methods) {
            symbols.push(method);
          }
        }
        return;
      }

      case "mod_item": {
        const name = extractModName(node);
        if (name) {
          const visibility = extractVisibility(node);

          symbols.push({
            name,
            kind: "module",
            exported: visibility === "public",
            range: extractRange(node),
            visibility,
          });
        }
        break;
      }

      case "type_item": {
        if (node.children.some((c) => c.type === "type")) {
          const name = extractTypeName(node);
          if (name) {
            const generics = extractGenerics(node);
            const visibility = extractVisibility(node);

            symbols.push({
              name,
              kind: "type",
              exported: visibility === "public",
              range: extractRange(node),
              signature: {
                params: [],
                returns: undefined,
                generics,
              },
              visibility,
            });
          }
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
  const nameNode = node.childForFieldName("name");
  return nameNode?.text || null;
}

function extractFunctionParameters(
  node: Parser.SyntaxNode,
): Array<{ name: string; type?: string }> {
  const params: Array<{ name: string; type?: string }> = [];
  const parametersNode = node.childForFieldName("parameters");

  if (!parametersNode) return params;

  for (const child of parametersNode.children) {
    if (child.type === "parameter") {
      const pattern = child.childForFieldName("pattern");
      const type = child.childForFieldName("type");

      if (pattern) {
        const paramName = pattern.text;
        params.push({
          name: paramName,
          type: type?.text || undefined,
        });
      }
    }
  }

  return params;
}

function extractFunctionReturnType(
  node: Parser.SyntaxNode,
): string | undefined {
  const returnTypeNode = node.childForFieldName("return_type");
  if (returnTypeNode) {
    return returnTypeNode.text.trim();
  }
  return undefined;
}

function extractStructName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text || null;
}

function extractStructFields(
  node: Parser.SyntaxNode,
): Array<{ name: string; type?: string }> {
  const fields: Array<{ name: string; type?: string }> = [];
  const bodyNode = node.childForFieldName("body");

  if (!bodyNode) return fields;

  for (const child of bodyNode.children) {
    if (child.type === "field_declaration") {
      const nameNode = child.childForFieldName("name");
      const typeNode = child.childForFieldName("type");

      if (nameNode) {
        fields.push({
          name: nameNode.text,
          type: typeNode?.text || undefined,
        });
      }
    }
  }

  return fields;
}

function extractEnumName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text || null;
}

function extractEnumVariants(
  node: Parser.SyntaxNode,
): Array<{ name: string; type?: string }> {
  const variants: Array<{ name: string; type?: string }> = [];
  const bodyNode = node.childForFieldName("body");

  if (!bodyNode) return variants;

  for (const child of bodyNode.children) {
    if (child.type === "enum_variant") {
      const nameNode = child.childForFieldName("name");
      const typeNode = child.childForFieldName("type");

      if (nameNode) {
        variants.push({
          name: nameNode.text,
          type: typeNode?.text || undefined,
        });
      }
    }
  }

  return variants;
}

function extractTraitName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text || null;
}

function extractImplInfo(node: Parser.SyntaxNode): { typeName: string } | null {
  const typeNode = node.childForFieldName("type");

  if (!typeNode) return null;

  let typeName = typeNode.text;

  if (typeNode.type === "type_identifier") {
    typeName = typeNode.text;
  } else if (typeNode.type === "generic_type") {
    const typeIdentifier = typeNode.childForFieldName("type");
    if (typeIdentifier) {
      typeName = typeIdentifier.text;
    }
  }

  if (!typeName) return null;

  return { typeName };
}

function extractImplMethods(
  node: Parser.SyntaxNode,
  typeName: string,
): ExtractedSymbol[] {
  const methods: ExtractedSymbol[] = [];

  const bodyNode = node.childForFieldName("body");
  if (!bodyNode) {
    return methods;
  }

  for (const child of bodyNode.children) {
    if (child.type === "function_item") {
      const name = extractFunctionName(child);
      if (name) {
        const params = extractFunctionParameters(child);
        const returnType = extractFunctionReturnType(child);
        const generics = extractGenerics(child);
        const visibility = extractVisibility(child);

        methods.push({
          nodeId: `${typeName}::${name}`,
          kind: "method",
          name,
          exported: visibility === "public",
          range: extractRange(child),
          signature: {
            params,
            returns: returnType,
            generics,
          },
          visibility,
        });
      }
    }
  }

  return methods;
}

function extractModName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text || null;
}

function extractTypeName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text || null;
}

function extractGenerics(node: Parser.SyntaxNode): string[] | undefined {
  const generics: string[] = [];
  const typeParametersNode = node.childForFieldName("type_parameters");

  if (!typeParametersNode) return undefined;

  for (const child of typeParametersNode.children) {
    if (child.type === "type_identifier") {
      generics.push(child.text);
    }
  }

  return generics.length > 0 ? generics : undefined;
}

function extractVisibility(
  node: Parser.SyntaxNode,
): "public" | "private" | "internal" {
  const visibilityNode = node.children.find(
    (child) => child.type === "visibility_modifier",
  );

  if (!visibilityNode) {
    return "private";
  }

  const text = visibilityNode.text;

  if (text === "pub") {
    return "public";
  }

  if (text.includes("pub(crate)")) {
    return "internal";
  }

  if (text.startsWith("pub(")) {
    return "public";
  }

  return "private";
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

function extractImports(tree: Parser.Tree): ExtractedImport[] {
  const imports: ExtractedImport[] = [];

  const modItems = tree.rootNode.descendantsOfType("mod_item");
  for (const modItem of modItems) {
    const nameNode = modItem.childForFieldName("name");
    if (!nameNode) continue;

    const moduleName = nameNode.text;
    const result: ExtractedImport = {
      specifier: moduleName,
      isRelative: true,
      isExternal: false,
      imports: [moduleName],
      isReExport: false,
    };

    imports.push(result);
  }

  const useDeclarations = tree.rootNode.descendantsOfType("use_declaration");
  for (const useDecl of useDeclarations) {
    const argNode = useDecl.childForFieldName("argument");
    if (!argNode) continue;

    let specifier = "";
    let isRelative = false;
    let isExternal = false;
    const extractedNames: string[] = [];

    if (argNode.type === "use_wildcard") {
      const scopedId = argNode.children.find(
        (c) => c.type === "scoped_identifier" || c.type === "identifier",
      );
      if (scopedId) {
        specifier = scopedId.text;
        isRelative =
          specifier.startsWith("self::") ||
          specifier.startsWith("super::") ||
          specifier.startsWith("crate::");
        isExternal =
          !isRelative && (specifier.includes("::") || specifier === "std");
        extractedNames.push("*");
      }
    } else if (argNode.type === "use_as_clause") {
      const aliasNode = argNode.childForFieldName("alias");
      const pathNode = argNode.childForFieldName("path");
      if (aliasNode && pathNode) {
        specifier = pathNode.text;
        isRelative =
          specifier.startsWith("self::") ||
          specifier.startsWith("super::") ||
          specifier.startsWith("crate::");
        isExternal =
          !isRelative &&
          (specifier.includes("::") || /^[a-z][a-z0-9_]*$/.test(specifier));
        extractedNames.push(aliasNode.text);
      }
    } else if (argNode.type === "scoped_use_list") {
      const pathNode = argNode.childForFieldName("path");
      const listNode = argNode.childForFieldName("list");
      if (pathNode) {
        specifier = pathNode.text;
        isRelative =
          specifier.startsWith("self::") ||
          specifier.startsWith("super::") ||
          specifier.startsWith("crate::");
        isExternal =
          !isRelative &&
          (specifier.includes("::") || /^[a-z][a-z0-9_]*$/.test(specifier));

        if (listNode) {
          for (const child of listNode.children) {
            if (child.type === "use_as_clause") {
              const aliasNode = child.childForFieldName("alias");
              const nameNode = child.childForFieldName("name");
              extractedNames.push(aliasNode?.text || nameNode?.text || "");
            } else if (child.type === "use_wildcard") {
              extractedNames.push("*");
            } else if (child.type === "scoped_identifier") {
              const parts = child.text.split("::");
              extractedNames.push(parts[parts.length - 1]);
            } else if (child.type === "identifier") {
              extractedNames.push(child.text);
            }
          }
        } else {
          const parts = specifier.split("::");
          extractedNames.push(parts[parts.length - 1]);
        }
      }
    } else if (
      argNode.type === "scoped_identifier" ||
      argNode.type === "identifier"
    ) {
      specifier = argNode.text;
      isRelative =
        specifier.startsWith("self::") ||
        specifier.startsWith("super::") ||
        specifier.startsWith("crate::");
      isExternal =
        !isRelative &&
        (specifier.includes("::") || /^[a-z][a-z0-9_]*$/.test(specifier));
      const parts = specifier.split("::");
      extractedNames.push(parts[parts.length - 1]);
    }

    if (specifier && extractedNames.length > 0) {
      const result: ExtractedImport = {
        specifier,
        isRelative,
        isExternal,
        imports: extractedNames,
        isReExport: false,
      };
      imports.push(result);
    }
  }

  return imports;
}

function extractCalls(
  tree: Parser.Tree,
  extractedSymbols: ExtractedSymbol[],
): ExtractedCall[] {
  const calls: ExtractedCall[] = [];
  const seenCallNodes = new Set<number>();

  const symbolMap = new Map<string, ExtractedSymbol>();
  for (const symbol of extractedSymbols) {
    symbolMap.set(symbol.name, symbol);
    symbolMap.set(symbol.nodeId, symbol);
  }

  const callQuery = createQuery(
    "rust",
    `

(call_expression
  function: (identifier) @callee) @call

(call_expression
  function: (scoped_identifier
    path: (identifier) @type
    name: (identifier) @name)) @call

(call_expression
  function: (field_expression
    value: (_) @recv
    field: (field_identifier) @field)) @call

(macro_invocation
  macro: (identifier) @macro) @macro_call

`,
  );

  if (!callQuery) {
    return [];
  }

  const matches = callQuery.matches(tree.rootNode);

  for (const match of matches) {
    const callCapture = match.captures.find(
      (c: QueryCapture) => c.name === "call",
    );
    const macroCallCapture = match.captures.find(
      (c: QueryCapture) => c.name === "macro_call",
    );

    if (macroCallCapture) {
      const macroCapture = match.captures.find(
        (c: QueryCapture) => c.name === "macro",
      );
      if (!macroCapture) continue;

      const nodeId = macroCallCapture.node.id;
      if (seenCallNodes.has(nodeId)) continue;
      seenCallNodes.add(nodeId);

      const macroName = macroCapture.node.text;

      const range = {
        startLine: macroCallCapture.node.startPosition.row,
        startCol: macroCallCapture.node.startPosition.column,
        endLine: macroCallCapture.node.endPosition.row,
        endCol: macroCallCapture.node.endPosition.column,
      };

      const callerNodeId = findEnclosingSymbolUtil(
        macroCallCapture.node,
        extractedSymbols,
      );

      calls.push({
        callerNodeId,
        calleeIdentifier: `${macroName}!`,
        isResolved: false,
        callType: "dynamic",
        range,
      });

      continue;
    }

    if (!callCapture) continue;

    const callNode = callCapture.node;
    const nodeId = callNode.id;
    if (seenCallNodes.has(nodeId)) continue;
    seenCallNodes.add(nodeId);

    const calleeCapture = match.captures.find(
      (c: QueryCapture) => c.name === "callee",
    );
    const typeCapture = match.captures.find(
      (c: QueryCapture) => c.name === "type",
    );
    const nameCapture = match.captures.find(
      (c: QueryCapture) => c.name === "name",
    );
    const recvCapture = match.captures.find(
      (c: QueryCapture) => c.name === "recv",
    );
    const fieldCapture = match.captures.find(
      (c: QueryCapture) => c.name === "field",
    );

    let calleeIdentifier = "";
    let callType: ExtractedCall["callType"] = "function";
    let isResolved = false;
    let calleeSymbolId: string | undefined;

    if (calleeCapture) {
      calleeIdentifier = calleeCapture.node.text;

      const symbol = symbolMap.get(calleeIdentifier);
      if (symbol && symbol.kind === "function") {
        isResolved = true;
        calleeSymbolId = symbol.nodeId;
      }
    } else if (typeCapture && nameCapture) {
      const typeName = typeCapture.node.text;
      const methodName = nameCapture.node.text;
      calleeIdentifier = `${typeName}::${methodName}`;
      callType = "function";

      const methodNodeId = `${typeName}::${methodName}`;
      const methodSymbol = symbolMap.get(methodNodeId);
      if (methodSymbol) {
        isResolved = true;
        calleeSymbolId = methodNodeId;
      }
    } else if (recvCapture && fieldCapture) {
      const recvText = recvCapture.node.text;
      const fieldName = fieldCapture.node.text;
      calleeIdentifier = `${recvText}.${fieldName}`;
      callType = "method";

      if (recvText === "self") {
        const methodSymbol = symbolMap.get(fieldName);
        if (methodSymbol) {
          isResolved = true;
          calleeSymbolId = methodSymbol.nodeId;
        }
      } else {
        const typeSymbol = symbolMap.get(recvText);
        if (typeSymbol) {
          const methodNodeId = `${recvText}::${fieldName}`;
          const methodSymbol = symbolMap.get(methodNodeId);
          if (methodSymbol) {
            isResolved = true;
            calleeSymbolId = methodNodeId;
          }
        }
      }
    }

    const range = {
      startLine: callNode.startPosition.row,
      startCol: callNode.startPosition.column,
      endLine: callNode.endPosition.row,
      endCol: callNode.endPosition.column,
    };

    const callerNodeId = findEnclosingSymbolUtil(callNode, extractedSymbols);

    calls.push({
      callerNodeId,
      calleeIdentifier,
      isResolved,
      callType,
      calleeSymbolId,
      range,
    });

    const funcNode = callNode.childForFieldName("function");
    if (funcNode) {
      extractChainedCalls(
        funcNode,
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

function extractChainedCalls(
  node: Parser.SyntaxNode,
  callerNodeId: string,
  symbolMap: Map<string, ExtractedSymbol>,
  calls: ExtractedCall[],
  seenCallNodes: Set<number>,
  extractedSymbols: ExtractedSymbol[],
): void {
  if (!node) return;

  if (node.type === "call_expression" && !seenCallNodes.has(node.id)) {
    seenCallNodes.add(node.id);

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
    } else if (funcNode.type === "field_expression") {
      const valueNode = funcNode.childForFieldName("value");
      const fieldNode = funcNode.childForFieldName("field");
      if (valueNode && fieldNode) {
        calleeIdentifier = `${valueNode.text}.${fieldNode.text}`;
        callType = "method";
      }
    } else if (funcNode.type === "scoped_identifier") {
      calleeIdentifier = funcNode.text;
      const pathNode = funcNode.childForFieldName("path");
      const nameNode = funcNode.childForFieldName("name");
      if (pathNode && nameNode) {
        const methodNodeId = `${pathNode.text}::${nameNode.text}`;
        const methodSymbol = symbolMap.get(methodNodeId);
        if (methodSymbol) {
          isResolved = true;
          calleeSymbolId = methodNodeId;
        }
      }
    }

    calls.push({
      callerNodeId,
      calleeIdentifier,
      isResolved,
      callType,
      calleeSymbolId,
      range: {
        startLine: node.startPosition.row,
        startCol: node.startPosition.column,
        endLine: node.endPosition.row,
        endCol: node.endPosition.column,
      },
    });

    extractChainedCalls(
      funcNode,
      callerNodeId,
      symbolMap,
      calls,
      seenCallNodes,
      extractedSymbols,
    );
  }

  if (node.type === "field_expression") {
    const valueNode = node.childForFieldName("value");
    if (valueNode) {
      extractChainedCalls(
        valueNode,
        callerNodeId,
        symbolMap,
        calls,
        seenCallNodes,
        extractedSymbols,
      );
    }
  }

  if (node.type === "scoped_identifier") {
    const pathNode = node.childForFieldName("path");
    if (pathNode) {
      extractChainedCalls(
        pathNode,
        callerNodeId,
        symbolMap,
        calls,
        seenCallNodes,
        extractedSymbols,
      );
    }
  }
}

function clearCache(): void {
  clearGrammarCache("rust");
}

export { RustAdapter, clearCache };
