import Parser from "tree-sitter";
import type { Tree } from "tree-sitter";
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

class KotlinAdapter implements LanguageAdapter {
  languageId = "kotlin";
  fileExtensions = [".kt", ".kts"] as const;

  private parser: Parser | null = null;

  getParser(): Parser | null {
    if (!this.parser) {
      this.parser = getParser("kotlin");
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
          "Syntax errors detected in Kotlin file - attempting partial extraction",
          { filePath: _filePath },
        );
      }

      return tree;
    } catch (error) {
      logger.error("Failed to parse Kotlin file", {
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
      case "package_header": {
        const name = extractPackageName(node);
        if (name) {
          symbols.push({
            name,
            kind: "module",
            exported: true,
            range: extractRange(node),
            visibility: "public",
          });
        }
        break;
      }

      case "class_declaration": {
        const info = extractClassInfo(node);
        if (info) {
          symbols.push({
            name: info.name,
            kind: info.kind,
            exported: info.exported,
            range: extractRange(node),
            signature: {
              params: info.params,
              generics: info.generics,
            },
            visibility: info.visibility,
          });
        }
        break;
      }

      case "object_declaration": {
        const name = extractObjectName(node);
        if (name) {
          const { exported, visibility } = extractModifiers(node);
          symbols.push({
            name,
            kind: "class",
            exported,
            range: extractRange(node),
            signature: { params: [] },
            visibility,
          });
        }
        break;
      }

      case "function_declaration": {
        const info = extractFunctionInfo(node);
        if (info) {
          symbols.push({
            name: info.name,
            kind: "function",
            exported: info.exported,
            range: extractRange(node),
            signature: {
              params: info.params,
              returns: info.returns,
              generics: info.generics,
            },
            visibility: info.visibility,
          });
        }
        break;
      }

      case "secondary_constructor": {
        const info = extractConstructorInfo(node);
        if (info) {
          symbols.push({
            name: "<init>",
            kind: "constructor",
            exported: info.exported,
            range: extractRange(node),
            signature: {
              params: info.params,
            },
            visibility: info.visibility,
          });
        }
        break;
      }

      case "property_declaration": {
        const info = extractPropertyInfo(node);
        if (info) {
          symbols.push({
            name: info.name,
            kind: "variable",
            exported: info.exported,
            range: extractRange(node),
            signature: {
              params: [],
              returns: info.type,
            },
            visibility: info.visibility,
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

function extractPackageName(node: Parser.SyntaxNode): string | null {
  const identifier = node.children.find((c) => c.type === "identifier");
  return identifier?.text || null;
}

function extractClassInfo(node: Parser.SyntaxNode): {
  name: string;
  kind: ExtractedSymbol["kind"];
  exported: boolean;
  params: Array<{ name: string; type?: string }>;
  generics?: string[];
  visibility: ExtractedSymbol["visibility"];
} | null {
  const typeIdentifier = node.children.find(
    (c) => c.type === "type_identifier",
  );
  if (!typeIdentifier) return null;

  const name = typeIdentifier.text;
  const { exported, visibility } = extractModifiers(node);

  const generics = extractTypeParameters(node);
  const params = extractClassParameters(node);

  let kind: ExtractedSymbol["kind"] = "class";

  const classKeyword = node.children.find(
    (c) => c.type === "class" || c.type === "interface",
  );
  if (classKeyword?.text === "interface") {
    kind = "interface";
  } else if (node.children.some((c) => c.type === "enum_class_body")) {
    kind = "class";
  } else if (node.children.some((c) => c.text === "data")) {
    kind = "class";
  }

  return { name, kind, exported, params, generics, visibility };
}

function extractObjectName(node: Parser.SyntaxNode): string | null {
  const typeIdentifier = node.children.find(
    (c) => c.type === "type_identifier",
  );
  return typeIdentifier?.text || null;
}

function extractFunctionInfo(node: Parser.SyntaxNode): {
  name: string;
  exported: boolean;
  params: Array<{ name: string; type?: string }>;
  returns?: string;
  generics?: string[];
  visibility: ExtractedSymbol["visibility"];
} | null {
  const identifier = node.children.find((c) => c.type === "simple_identifier");
  if (!identifier) return null;

  const name = identifier.text;
  const { exported, visibility } = extractModifiers(node);

  const generics = extractTypeParameters(node);
  const params = extractFunctionParameters(node);
  const returns = extractFunctionReturnType(node);

  return { name, exported, params, returns, generics, visibility };
}

function extractConstructorInfo(node: Parser.SyntaxNode): {
  exported: boolean;
  params: Array<{ name: string; type?: string }>;
  visibility: ExtractedSymbol["visibility"];
} {
  const { exported, visibility } = extractModifiers(node);
  const params = extractConstructorParameters(node);
  return { exported, params, visibility };
}

function extractPropertyInfo(node: Parser.SyntaxNode): {
  name: string;
  exported: boolean;
  type?: string;
  visibility: ExtractedSymbol["visibility"];
} | null {
  const varDecl = node.children.find((c) => c.type === "variable_declaration");
  if (!varDecl) return null;

  const identifier = varDecl.children.find(
    (c) => c.type === "simple_identifier",
  );
  if (!identifier) return null;

  const name = identifier.text;
  const { exported, visibility } = extractModifiers(node);
  const type = extractPropertyType(varDecl);

  return { name, exported, type, visibility };
}

function extractModifiers(node: Parser.SyntaxNode): {
  exported: boolean;
  visibility: ExtractedSymbol["visibility"];
} {
  const modifiersNode = node.children.find((c) => c.type === "modifiers");

  let visibility: ExtractedSymbol["visibility"] = "public";
  let exported = true;

  if (modifiersNode) {
    for (const child of modifiersNode.children) {
      if (child.type === "visibility_modifier") {
        const text = child.text;
        if (text === "private" || text === "protected" || text === "internal") {
          visibility = text as ExtractedSymbol["visibility"];
          exported = text !== "private";
        }
      }
    }
  }

  return { exported, visibility };
}

function extractTypeParameters(node: Parser.SyntaxNode): string[] | undefined {
  const typeParams = node.children.find((c) => c.type === "type_parameters");
  if (!typeParams) return undefined;

  const params: string[] = [];
  for (const child of typeParams.children) {
    if (child.type === "type_parameter") {
      const typeIdentifier = child.children.find(
        (c) => c.type === "type_identifier",
      );
      if (typeIdentifier) {
        params.push(typeIdentifier.text);
      }
    }
  }

  return params.length > 0 ? params : undefined;
}

function extractClassParameters(
  node: Parser.SyntaxNode,
): Array<{ name: string; type?: string }> {
  const params: Array<{ name: string; type?: string }> = [];

  const primaryConstructor = node.children.find(
    (c) => c.type === "primary_constructor",
  );
  if (!primaryConstructor) return params;

  const classParams = primaryConstructor.children.find(
    (c) => c.type === "_class_parameters",
  );
  if (!classParams) return params;

  for (const child of classParams.children) {
    if (child.type === "class_parameter") {
      const identifier = child.children.find(
        (c) => c.type === "simple_identifier",
      );
      const type = extractType(child);

      if (identifier) {
        params.push({
          name: identifier.text,
          type: type || undefined,
        });
      }
    }
  }

  return params;
}

function extractFunctionParameters(
  node: Parser.SyntaxNode,
): Array<{ name: string; type?: string }> {
  const params: Array<{ name: string; type?: string }> = [];

  const valueParams = node.children.find(
    (c) => c.type === "function_value_parameters",
  );
  if (!valueParams) return params;

  for (const child of valueParams.children) {
    let param: Parser.SyntaxNode | undefined;

    if (child.type === "parameter") {
      param = child;
    } else if (child.type === "_function_value_parameter") {
      param = child.children.find((c) => c.type === "parameter");
    }

    if (!param) continue;

    const identifier = param.children.find(
      (c) => c.type === "simple_identifier",
    );
    const type = extractType(param);

    if (identifier) {
      params.push({
        name: identifier.text,
        type: type || undefined,
      });
    }
  }

  return params;
}

function extractConstructorParameters(
  node: Parser.SyntaxNode,
): Array<{ name: string; type?: string }> {
  const params: Array<{ name: string; type?: string }> = [];

  const valueParams = node.children.find(
    (c) => c.type === "function_value_parameters",
  );
  if (!valueParams) return params;

  for (const child of valueParams.children) {
    let param: Parser.SyntaxNode | undefined;

    if (child.type === "parameter") {
      param = child;
    } else if (child.type === "_function_value_parameter") {
      param = child.children.find((c) => c.type === "parameter");
    }

    if (!param) continue;

    const identifier = param.children.find(
      (c) => c.type === "simple_identifier",
    );
    const type = extractType(param);

    if (identifier) {
      params.push({
        name: identifier.text,
        type: type || undefined,
      });
    }
  }

  return params;
}

function extractFunctionReturnType(
  node: Parser.SyntaxNode,
): string | undefined {
  const colonIndex = node.children.findIndex((c) => c.text === ":");
  if (colonIndex === -1) return undefined;

  for (let i = colonIndex + 1; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === "_type") {
      return child.text;
    }
    if (
      [
        "user_type",
        "nullable_type",
        "parenthesized_type",
        "function_type",
        "not_nullable_type",
      ].includes(child.type)
    ) {
      return child.text;
    }
  }

  return undefined;
}

function extractPropertyType(node: Parser.SyntaxNode): string | undefined {
  const colonIndex = node.children.findIndex((c) => c.text === ":");
  if (colonIndex === -1) return undefined;

  for (let i = colonIndex + 1; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === "_type") {
      return child.text;
    }
    if (
      [
        "user_type",
        "nullable_type",
        "parenthesized_type",
        "function_type",
        "not_nullable_type",
      ].includes(child.type)
    ) {
      return child.text;
    }
  }

  return undefined;
}

function extractType(node: Parser.SyntaxNode): string | null {
  const typeNode = node.children.find((c) => c.type === "_type");
  if (typeNode) {
    return typeNode.text;
  }

  const directType = node.children.find((c) =>
    [
      "user_type",
      "nullable_type",
      "parenthesized_type",
      "function_type",
      "not_nullable_type",
    ].includes(c.type),
  );
  return directType?.text || null;
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

  const importHeaderNodes = tree.rootNode.descendantsOfType("import_header");

  for (const importNode of importHeaderNodes) {
    const identifier = importNode.children.find((c) => c.type === "identifier");
    const wildcard = importNode.children.find(
      (c) => c.type === "wildcard_import",
    );
    const importAlias = importNode.children.find(
      (c) => c.type === "import_alias",
    );

    if (!identifier) continue;

    const specifier = identifier.text;
    const isRelative = specifier.startsWith(".");
    const isExternal = !isRelative;

    const result: ExtractedImport = {
      specifier,
      isRelative,
      isExternal,
      imports: [],
      isReExport: false,
    };

    if (wildcard) {
      result.imports.push("*");
    } else if (importAlias) {
      const aliasIdentifier = importAlias.children.find(
        (c) => c.type === "type_identifier",
      );
      if (aliasIdentifier) {
        result.imports.push(aliasIdentifier.text);
      } else {
        const parts = specifier.split(".");
        result.imports.push(parts[parts.length - 1]);
      }
    } else {
      const parts = specifier.split(".");
      result.imports.push(parts[parts.length - 1]);
    }

    imports.push(result);
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
  }

  const callQuery = createQuery(
    "kotlin",
    `
    (call_expression
      (simple_identifier) @callee)

    (call_expression
      (navigation_expression
        (simple_identifier) @recv
        (navigation_suffix
          (simple_identifier) @attr)))

    (call_expression
      (navigation_expression
        (this_expression) @recv
        (navigation_suffix
          (simple_identifier) @attr)))

    (call_expression
      (navigation_expression
        (navigation_expression
          (simple_identifier) @recv
          (navigation_suffix
            (simple_identifier) @attr1))
        (navigation_suffix
          (simple_identifier) @attr2)))
  `,
  );

  if (!callQuery) {
    return [];
  }

  const matches = callQuery.matches(tree.rootNode);

  for (const match of matches) {
    let callNode = match.captures.find(
      (c) =>
        c.name === "callee" ||
        c.name === "attr" ||
        c.name === "attr1" ||
        c.name === "attr2",
    )?.node.parent;

    // For method calls, the attr node's parent is navigation_suffix,
    // whose parent is navigation_expression, whose parent is call_expression
    if (
      callNode &&
      (callNode.type === "navigation_suffix" ||
        callNode.type === "navigation_expression")
    ) {
      callNode = callNode.parent;
      if (
        callNode &&
        (callNode.type === "navigation_suffix" ||
          callNode.type === "navigation_expression")
      ) {
        callNode = callNode.parent;
      }
    }

    if (!callNode || callNode.type !== "call_expression") {
      continue;
    }

    const nodeId = callNode.id;
    if (seenCallNodes.has(nodeId)) continue;
    seenCallNodes.add(nodeId);

    const calleeCapture = match.captures.find((c) => c.name === "callee");
    const attr1Capture = match.captures.find((c) => c.name === "attr1");
    const attr2Capture = match.captures.find((c) => c.name === "attr2");
    const attrCapture = match.captures.find((c) => c.name === "attr");
    const recvCapture = match.captures.find((c) => c.name === "recv");

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

      if (symbol && symbol.kind === "class") {
        callType = "constructor";
      }
    } else if (attr2Capture && attr1Capture && recvCapture) {
      calleeIdentifier = `${recvCapture.node.text}.${attr1Capture.node.text}.${attr2Capture.node.text}`;
      callType = "method";
    } else if (attrCapture && recvCapture) {
      calleeIdentifier = `${recvCapture.node.text}.${attrCapture.node.text}`;
      callType = "method";

      if (
        recvCapture.node.text === "this" ||
        recvCapture.node.type === "this_expression"
      ) {
        const symbol = symbolMap.get(attrCapture.node.text);
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

    if (recvCapture && recvCapture.node.type === "call_expression") {
      extractChainedCall(
        recvCapture.node,
        callerNodeId,
        symbolMap,
        calls,
        seenCallNodes,
      );
    }
  }

  return calls;
}

function extractChainedCall(
  callNode: Parser.SyntaxNode,
  callerNodeId: string,
  symbolMap: Map<string, ExtractedSymbol>,
  calls: ExtractedCall[],
  seenCallNodes: Set<number>,
): void {
  if (!callNode || seenCallNodes.has(callNode.id)) return;

  seenCallNodes.add(callNode.id);

  const firstChild = callNode.children[0];
  if (!firstChild) return;

  let calleeIdentifier = "";
  let callType: ExtractedCall["callType"] = "function";
  let isResolved = false;
  let calleeSymbolId: string | undefined;

  if (firstChild.type === "simple_identifier") {
    calleeIdentifier = firstChild.text;
    const symbol = symbolMap.get(calleeIdentifier);
    if (symbol) {
      isResolved = true;
      calleeSymbolId = symbol.nodeId;
    }
  } else if (firstChild.type === "navigation_expression") {
    const receiver =
      firstChild.children.find((c) => c.type === "simple_identifier") ||
      firstChild.children.find((c) => c.type === "this_expression");
    const navSuffix = firstChild.children.find(
      (c) => c.type === "navigation_suffix",
    );
    const attribute = navSuffix?.children.find(
      (c) => c.type === "simple_identifier",
    );

    if (receiver && attribute) {
      calleeIdentifier = `${receiver.text}.${attribute.text}`;
      callType = "method";

      if (receiver.text === "this" || receiver.type === "this_expression") {
        const symbol = symbolMap.get(attribute.text);
        if (symbol) {
          isResolved = true;
          calleeSymbolId = symbol.nodeId;
        }
      }
    }
  }

  if (calleeIdentifier) {
    calls.push({
      callerNodeId,
      calleeIdentifier,
      isResolved,
      callType,
      calleeSymbolId,
      range: extractRange(callNode),
    });
  }
}

function clearCache(): void {
  clearGrammarCache("kotlin");
}

export { KotlinAdapter, clearCache };
