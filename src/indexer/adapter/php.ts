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

class PhpAdapter implements LanguageAdapter {
  languageId = "php";
  fileExtensions = [".php", ".phtml"] as const;

  private parser: Parser | null = null;

  getParser(): Parser | null {
    if (!this.parser) {
      this.parser = getParser("php");
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
          "Syntax errors detected in PHP file - attempting partial extraction",
          { filePath: _filePath },
        );
      }

      return tree;
    } catch (error) {
      logger.error("Failed to parse PHP file", {
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

  let currentNamespace: string | null = null;

  function traverse(node: Parser.SyntaxNode): void {
    switch (node.type) {
      case "namespace_definition": {
        const namespaceNode = node.childForFieldName("name");
        if (namespaceNode) {
          currentNamespace = namespaceNode.text;
        }
        break;
      }

      case "class_declaration": {
        const name = extractClassName(node);
        if (name) {
          const fqName = currentNamespace
            ? `${currentNamespace}\\${name}`
            : name;
          const visibility = name.startsWith("_") ? "private" : "public";
          symbols.push({
            name: fqName,
            kind: "class",
            exported: true,
            range: extractRange(node),
            signature: {
              params: [],
            },
            visibility,
          });
        }
        break;
      }

      case "interface_declaration": {
        const name = extractInterfaceName(node);
        if (name) {
          const fqName = currentNamespace
            ? `${currentNamespace}\\${name}`
            : name;
          const visibility = name.startsWith("_") ? "private" : "public";
          symbols.push({
            name: fqName,
            kind: "interface",
            exported: true,
            range: extractRange(node),
            signature: {
              params: [],
            },
            visibility,
          });
        }
        break;
      }

      case "trait_declaration": {
        const name = extractTraitName(node);
        if (name) {
          const fqName = currentNamespace
            ? `${currentNamespace}\\${name}`
            : name;
          const visibility = name.startsWith("_") ? "private" : "public";
          symbols.push({
            name: fqName,
            kind: "class",
            exported: true,
            range: extractRange(node),
            signature: {
              params: [],
            },
            visibility,
          });
        }
        break;
      }

      case "method_declaration": {
        const name = extractMethodName(node);
        if (name) {
          const params = extractMethodParameters(node);
          const returnType = extractMethodReturnType(node);
          const visibility = extractMethodVisibility(node) || "public";

          symbols.push({
            name,
            kind: "method",
            exported: visibility !== "private",
            range: extractRange(node),
            signature: {
              params,
              returns: returnType,
            },
            visibility,
          });
        }
        break;
      }

      case "function_definition": {
        const name = extractFunctionName(node);
        if (name) {
          const fqName = currentNamespace
            ? `${currentNamespace}\\${name}`
            : name;
          const params = extractFunctionParameters(node);
          const returnType = extractFunctionReturnType(node);
          const visibility = name.startsWith("_") ? "private" : "public";

          symbols.push({
            name: fqName,
            kind: "function",
            exported: !name.startsWith("_"),
            range: extractRange(node),
            signature: {
              params,
              returns: returnType,
            },
            visibility,
          });
        }
        break;
      }

      case "property_declaration": {
        const properties = extractPropertyNames(node);
        const visibility = extractPropertyVisibility(node);

        for (const prop of properties) {
          const propVisibility = prop.startsWith("_")
            ? "private"
            : visibility || "public";
          symbols.push({
            name: prop,
            kind: "variable",
            exported: propVisibility !== "private",
            range: extractRange(node),
            visibility: propVisibility,
          });
        }
        break;
      }

      case "const_declaration": {
        const constants = extractConstantNames(node);
        const visibility = extractConstantVisibility(node);

        for (const constant of constants) {
          const constVisibility = visibility || "public";
          symbols.push({
            name: constant,
            kind: "variable",
            exported: constVisibility !== "private",
            range: extractRange(node),
            visibility: constVisibility,
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

function extractClassName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text || null;
}

function extractInterfaceName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text || null;
}

function extractTraitName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text || null;
}

function extractMethodName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text || null;
}

function extractFunctionName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text || null;
}

function extractMethodParameters(
  node: Parser.SyntaxNode,
): Array<{ name: string; type?: string }> {
  const params: Array<{ name: string; type?: string }> = [];
  const parametersNode = node.childForFieldName("formal_parameters");

  if (!parametersNode) return params;

  for (const child of parametersNode.children) {
    if (child.type === "simple_parameter") {
      const paramName = extractVariableName(child);
      const paramType = extractParameterType(child);

      if (paramName) {
        params.push({
          name: paramName,
          type: paramType,
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
  const parametersNode = node.childForFieldName("formal_parameters");

  if (!parametersNode) return params;

  for (const child of parametersNode.children) {
    if (child.type === "simple_parameter") {
      const paramName = extractVariableName(child);
      const paramType = extractParameterType(child);

      if (paramName) {
        params.push({
          name: paramName,
          type: paramType,
        });
      }
    }
  }

  return params;
}

function extractVariableName(node: Parser.SyntaxNode): string | null {
  const varNode = node.childForFieldName("name");
  if (!varNode || varNode.type !== "variable_name") {
    return null;
  }

  const nameNode = varNode.children.find((c) => c.type === "name");
  return nameNode?.text || null;
}

function extractParameterType(node: Parser.SyntaxNode): string | undefined {
  const typeNode = node.childForFieldName("type");

  if (typeNode) {
    return typeNode.text;
  }

  const child = node.children.find(
    (c) =>
      c.type === "primitive_type" ||
      c.type === "named_type" ||
      c.type === "union_type" ||
      c.type === "optional_type",
  );

  return child?.text || undefined;
}

function extractMethodReturnType(node: Parser.SyntaxNode): string | undefined {
  const returnTypeNode = node.childForFieldName("return_type");
  if (returnTypeNode) {
    return returnTypeNode.text;
  }
  return undefined;
}

function extractFunctionReturnType(
  node: Parser.SyntaxNode,
): string | undefined {
  const returnTypeNode = node.childForFieldName("return_type");
  if (returnTypeNode) {
    return returnTypeNode.text;
  }
  return undefined;
}

function extractMethodVisibility(
  node: Parser.SyntaxNode,
): ExtractedSymbol["visibility"] | null {
  const visibilityNode = node.children.find(
    (c) => c.type === "visibility_modifier",
  );

  if (!visibilityNode) return null;

  const visibility = visibilityNode.text;

  if (
    visibility === "private" ||
    visibility === "protected" ||
    visibility === "public"
  ) {
    return visibility;
  }

  return "public";
}

function extractPropertyVisibility(
  node: Parser.SyntaxNode,
): ExtractedSymbol["visibility"] | null {
  const visibilityNode = node.children.find(
    (c) => c.type === "visibility_modifier",
  );

  if (!visibilityNode) return null;

  const visibility = visibilityNode.text;

  if (
    visibility === "private" ||
    visibility === "protected" ||
    visibility === "public"
  ) {
    return visibility;
  }

  return "public";
}

function extractConstantVisibility(
  node: Parser.SyntaxNode,
): ExtractedSymbol["visibility"] | null {
  const visibilityNode = node.children.find(
    (c) => c.type === "visibility_modifier",
  );

  if (!visibilityNode) return null;

  const visibility = visibilityNode.text;

  if (
    visibility === "private" ||
    visibility === "protected" ||
    visibility === "public"
  ) {
    return visibility;
  }

  return "public";
}

function extractPropertyNames(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];

  for (const child of node.children) {
    if (child.type === "property_element") {
      const varNode = child.children.find((c) => c.type === "variable_name");
      if (varNode && varNode.children.length >= 2) {
        const nameNode = varNode.children.find((c) => c.type === "name");
        if (nameNode) {
          names.push(nameNode.text);
        }
      }
    }
  }

  return names;
}

function extractConstantNames(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];

  for (const child of node.children) {
    if (child.type === "const_element") {
      const nameNode = child.children.find((c) => c.type === "name");
      if (nameNode) {
        names.push(nameNode.text);
      }
    }
  }

  return names;
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

  const importQuery = createQuery(
    "php",
    `
    (namespace_use_declaration
      (namespace_use_clause
        (qualified_name) @import_name))

    (namespace_use_declaration
      (namespace_use_clause
        (name) @import_name))

    (include_expression
      (string) @include_path)

    (include_once_expression
      (string) @include_path)

    (require_expression
      (string) @include_path)

    (require_once_expression
      (string) @include_path)
  `,
  );

  if (!importQuery) {
    return [];
  }

  const matches = importQuery.matches(tree.rootNode);

  for (const match of matches) {
    for (const capture of match.captures) {
      if (capture.name === "import_name") {
        const node = capture.node;
        const useClause = node.parent;

        if (!useClause || useClause.type !== "namespace_use_clause") {
          continue;
        }

        const statement = useClause.parent;
        if (!statement || statement.type !== "namespace_use_declaration") {
          continue;
        }

        const specifier = node.text;
        const isRelative = specifier.startsWith("\\");
        const isExternal = true;

        const result: ExtractedImport = {
          specifier,
          isRelative,
          isExternal,
          imports: [],
          isReExport: false,
        };

        const aliasingClause = useClause.children.find(
          (c) => c.type === "namespace_aliasing_clause",
        );

        if (aliasingClause) {
          const aliasNameNode = aliasingClause.children.find(
            (c) => c.type === "name",
          );
          if (aliasNameNode) {
            result.imports.push(aliasNameNode.text);
          }
        } else {
          const parts = specifier.split("\\");
          result.imports.push(parts[parts.length - 1]);
        }

        imports.push(result);
      } else if (capture.name === "include_path") {
        const node = capture.node;
        const statement = node.parent;

        if (!statement) {
          continue;
        }

        const specifier = node.text.replace(/^["']|["']$/g, "");
        const isRelative =
          specifier.startsWith("./") || specifier.startsWith("../");
        const isExternal = !isRelative;

        const result: ExtractedImport = {
          specifier,
          isRelative,
          isExternal,
          imports: [],
          isReExport: false,
        };

        imports.push(result);
      }
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
  }

  const callQuery = createQuery(
    "php",
    `(function_call_expression
      (name) @callee)

    (function_call_expression
      (variable_name) @var_callee)

    (member_call_expression
      (name) @attr
      (variable_name) @recv)

    (member_call_expression
      (name) @var_attr
      (variable_name) @recv)

    (scoped_call_expression
      (name) @scope
      (name) @static_callee)

    (scoped_call_expression
      (qualified_name) @qualified_scope
      (name) @static_callee)
  `,
  );

  if (!callQuery) {
    return [];
  }

  const matches = callQuery.matches(tree.rootNode);

  for (const match of matches) {
    const callNode = match.captures[0].node.parent;

    if (!callNode) continue;

    const nodeId = callNode.id;
    if (seenCallNodes.has(nodeId)) continue;
    seenCallNodes.add(nodeId);

    const calleeCapture = match.captures.find((c) => c.name === "callee");
    const varCalleeCapture = match.captures.find(
      (c) => c.name === "var_callee",
    );
    const attrCapture = match.captures.find((c) => c.name === "attr");
    const varAttrCapture = match.captures.find((c) => c.name === "var_attr");
    const recvCapture = match.captures.find((c) => c.name === "recv");
    const scopeCapture = match.captures.find((c) => c.name === "scope");
    const qualifiedScopeCapture = match.captures.find(
      (c) => c.name === "qualified_scope",
    );
    const staticCalleeCapture = match.captures.find(
      (c) => c.name === "static_callee",
    );

    let calleeIdentifier = "";
    let callType: ExtractedCall["callType"] = "function";
    let isResolved = false;
    let calleeSymbolId: string | undefined;

    if (calleeCapture) {
      calleeIdentifier = calleeCapture.node.text;
      const symbol = symbolMap.get(calleeIdentifier);
      if (symbol && (symbol.kind === "function" || symbol.kind === "method")) {
        isResolved = true;
        calleeSymbolId = symbol.nodeId;
      }
    } else if (varCalleeCapture) {
      calleeIdentifier = varCalleeCapture.node.text;
      callType = "dynamic";
      isResolved = false;
    } else if (attrCapture && recvCapture) {
      calleeIdentifier = `${recvCapture.node.text}.${attrCapture.node.text}`;
      callType = "method";

      if (recvCapture.node.text === "$this") {
        const symbol = symbolMap.get(attrCapture.node.text);
        if (symbol && symbol.kind === "method") {
          isResolved = true;
          calleeSymbolId = symbol.nodeId;
        }
      }
    } else if (varAttrCapture && recvCapture) {
      calleeIdentifier = `${recvCapture.node.text}.${varAttrCapture.node.text}`;
      callType = "dynamic";
      isResolved = false;
    } else if ((scopeCapture || qualifiedScopeCapture) && staticCalleeCapture) {
      const scopeText = scopeCapture
        ? scopeCapture.node.text
        : qualifiedScopeCapture!.node.text;
      calleeIdentifier = `${scopeText}::${staticCalleeCapture.node.text}`;
      callType = "function";

      const fullMethodName = `${scopeText}::${staticCalleeCapture.node.text}`;
      const symbol = symbolMap.get(fullMethodName);
      if (symbol && symbol.kind === "method") {
        isResolved = true;
        calleeSymbolId = symbol.nodeId;
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
  }

  return calls;
}

function clearCache(): void {
  clearGrammarCache("php");
}

export { PhpAdapter, clearCache };
