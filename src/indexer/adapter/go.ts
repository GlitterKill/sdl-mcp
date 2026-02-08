import type { Tree, SyntaxNode, QueryCapture } from "tree-sitter";
import { BaseAdapter } from "./BaseAdapter.js";
import type {
  ExtractedSymbol,
  ExtractedCall,
} from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import { createQuery } from "../treesitter/grammarLoader.js";
import { createClearCacheFunction } from "./BaseAdapter.js";

class GoAdapter extends BaseAdapter {
  languageId = "go";
  fileExtensions = [".go"] as const;

  extractSymbols(
    tree: Tree,
    _content: string,
    filePath: string,
  ): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];

    traverseAST(tree.rootNode, symbols, filePath);

    return symbols;
  }

  extractImports(
    tree: Tree,
    _content: string,
    _filePath: string,
  ): ExtractedImport[] {
    const imports: ExtractedImport[] = [];

    const importQuery = createQuery(
      "go",
      `
      (import_spec path: (interpreted_string_literal) @path)
      (import_declaration
        (import_spec_list
          (import_spec path: (interpreted_string_literal) @path)))
    `,
    );

    if (!importQuery) {
      return [];
    }

    const matches = importQuery.matches(tree.rootNode);

    const seenSpecifiers = new Set<string>();

    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name === "path") {
          const path = capture.node.text.replace(/^"|"$/g, "");
          const parent = capture.node.parent;

          if (parent && !seenSpecifiers.has(path)) {
            seenSpecifiers.add(path);

            const nameNode = parent.childForFieldName("name");
            const alias = nameNode ? nameNode.text : undefined;

            imports.push({
              specifier: path,
              isRelative: path.startsWith("./") || path.startsWith("../"),
              isExternal: !path.startsWith(".") && !path.startsWith("./"),
              imports: alias ? [alias] : [],
              namespaceImport: undefined,
              isReExport: false,
            });
          }
        }
      }
    }

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
      "go",
      "(call_expression function: (identifier) @callee arguments: (argument_list) @args) @call",
    );

    const selectorQuery = createQuery(
      "go",
      "(call_expression function: (selector_expression operand: (_) @obj field: (field_identifier) @prop) arguments: (argument_list) @args) @call",
    );

    const goIdentifierQuery = createQuery(
      "go",
      "(go_statement (call_expression function: (identifier) @callee arguments: (argument_list) @args)) @call",
    );

    const goSelectorQuery = createQuery(
      "go",
      "(go_statement (call_expression function: (selector_expression operand: (_) @obj field: (field_identifier) @prop) arguments: (argument_list) @args)) @call",
    );

    const deferIdentifierQuery = createQuery(
      "go",
      "(defer_statement (call_expression function: (identifier) @callee arguments: (argument_list) @args)) @call",
    );

    const deferSelectorQuery = createQuery(
      "go",
      "(defer_statement (call_expression function: (selector_expression operand: (_) @obj field: (field_identifier) @prop) arguments: (argument_list) @args)) @call",
    );

    if (
      !callQuery ||
      !selectorQuery ||
      !goIdentifierQuery ||
      !goSelectorQuery ||
      !deferIdentifierQuery ||
      !deferSelectorQuery
    ) {
      return [];
    }

    const matches = [
      ...callQuery.matches(tree.rootNode),
      ...selectorQuery.matches(tree.rootNode),
      ...goIdentifierQuery.matches(tree.rootNode),
      ...goSelectorQuery.matches(tree.rootNode),
      ...deferIdentifierQuery.matches(tree.rootNode),
      ...deferSelectorQuery.matches(tree.rootNode),
    ];

    for (const match of matches) {
      const callNode = match.captures.find(
        (c: QueryCapture) => c.name === "call",
      );
      if (!callNode) continue;

      const nodeId = callNode.node.id;
      if (seenCallNodes.has(nodeId)) continue;
      seenCallNodes.add(nodeId);

      const calleeCapture = match.captures.find(
        (c: QueryCapture) => c.name === "callee" || c.name === "prop",
      );
      const objCapture = match.captures.find(
        (c: QueryCapture) => c.name === "obj",
      );

      let calleeIdentifier = "";
      let callType: ExtractedCall["callType"] = "function";
      let isResolved = false;
      let calleeSymbolId: string | undefined;

      if (calleeCapture) {
        if (objCapture) {
          callType = "method";
          const objText = objCapture.node.text;
          const methodName = calleeCapture.node.text;

          calleeIdentifier = `${objText}.${methodName}`;

          if (objText === "this" || objText === "self") {
            const symbol = symbolMap.get(methodName);
            if (symbol) {
              isResolved = true;
              calleeSymbolId = symbol.nodeId;
            }
          } else {
            const symbol = symbolMap.get(objText);
            if (symbol && (symbol.kind === "type" || symbol.kind === "class")) {
              isResolved = true;
              calleeSymbolId = `${objText}.${methodName}`;
            }
          }
        } else {
          calleeIdentifier = calleeCapture.node.text;
          const symbol = symbolMap.get(calleeIdentifier);
          if (symbol) {
            isResolved = true;
            calleeSymbolId = symbol.nodeId;
          }
        }
      }

      const range = {
        startLine: callNode.node.startPosition.row,
        startCol: callNode.node.startPosition.column,
        endLine: callNode.node.endPosition.row,
        endCol: callNode.node.endPosition.column,
      };

      const callerNodeId = this.findEnclosingSymbol(
        callNode.node,
        extractedSymbols,
      );

      calls.push({
        callerNodeId,
        calleeIdentifier,
        isResolved,
        callType,
        calleeSymbolId,
        range,
      });
    }

    return calls;
  }
}

function traverseAST(
  node: SyntaxNode,
  symbols: ExtractedSymbol[],
  filePath: string,
): void {
  switch (node.type) {
    case "source_file":
      for (const child of node.children) {
        if (child.type === "package_clause") {
          const name = child.children.find(
            (c: SyntaxNode) => c.type === "package_identifier",
          );
          if (name) {
            symbols.push({
              nodeId: `${filePath}:${name.text}:package`,
              kind: "module",
              name: name.text,
              exported: true,
              range: extractRange(node),
            });
          }
        }
      }
      break;

    case "function_declaration":
      const funcSymbol = processFunctionDeclaration(node, filePath);
      if (funcSymbol) symbols.push(funcSymbol);
      break;

    case "method_declaration":
      const methodSymbol = processMethodDeclaration(node, filePath);
      if (methodSymbol) symbols.push(methodSymbol);
      break;

    case "type_declaration":
      const typeSymbol = processTypeDeclaration(node, filePath);
      if (typeSymbol) symbols.push(typeSymbol);
      break;

    case "const_declaration":
      for (const child of node.children) {
        if (child.type === "const_spec") {
          const constSymbols = processConstSpec(child, filePath);
          symbols.push(...constSymbols);
        }
      }
      break;

    case "var_declaration":
      for (const child of node.children) {
        if (child.type === "var_spec") {
          const varSymbols = processVarSpec(child, filePath);
          symbols.push(...varSymbols);
        }
      }
      break;
  }

  for (const child of node.children) {
    traverseAST(child, symbols, filePath);
  }
}

function processFunctionDeclaration(
  node: SyntaxNode,
  filePath: string,
): ExtractedSymbol | null {
  const name = node.children.find((c: SyntaxNode) => c.type === "identifier");
  if (!name) return null;

  const params = extractParameters(node);
  const results = extractResults(node);
  const exported = isExported(name.text);

  return {
    nodeId: `${filePath}:${name.text}:function`,
    kind: "function",
    name: name.text,
    exported,
    range: extractRange(node),
    signature: {
      params,
      returns: results.length > 0 ? results.join(", ") : undefined,
    },
  };
}

function processMethodDeclaration(
  node: SyntaxNode,
  filePath: string,
): ExtractedSymbol | null {
  const receiverParamList = node.children.find(
    (c: SyntaxNode) => c.type === "parameter_list",
  );
  const name = node.children.find(
    (c: SyntaxNode) => c.type === "field_identifier",
  );
  if (!name) return null;

  const params = extractParameters(node);
  const results = extractResults(node);
  const exported = isExported(name.text);

  let receiverType = "";
  if (receiverParamList) {
    const paramDecl = receiverParamList.children.find(
      (c: SyntaxNode) => c.type === "parameter_declaration",
    );
    if (paramDecl) {
      const typeNode = paramDecl.children.find(
        (c: SyntaxNode) => c.type !== "identifier",
      );
      receiverType = typeNode ? typeNode.text : "";
    }
  }

  return {
    nodeId: `${filePath}:${name.text}:method`,
    kind: "method",
    name: name.text,
    exported,
    range: extractRange(node),
    signature: {
      params: [
        { name: receiverType || "receiver", type: receiverType },
        ...params,
      ],
      returns: results.length > 0 ? results.join(", ") : undefined,
    },
  };
}

function processTypeDeclaration(
  node: SyntaxNode,
  filePath: string,
): ExtractedSymbol | null {
  const spec = node.children.find((c: SyntaxNode) => c.type === "type_spec");
  if (!spec) return null;

  const name = spec.children.find(
    (c: SyntaxNode) => c.type === "type_identifier",
  );
  if (!name) return null;

  const exported = isExported(name.text);

  return {
    nodeId: `${filePath}:${name.text}:type`,
    kind: "type",
    name: name.text,
    exported,
    range: extractRange(node),
  };
}

function processConstSpec(
  node: SyntaxNode,
  filePath: string,
): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  const name = node.children.find((c: SyntaxNode) => c.type === "identifier");
  if (name) {
    symbols.push({
      nodeId: `${filePath}:${name.text}:const`,
      kind: "variable",
      name: name.text,
      exported: isExported(name.text),
      range: extractRange(node),
    });
  }

  const nameList = node.children.find(
    (c: SyntaxNode) => c.type === "identifier_list",
  );
  if (nameList) {
    for (const child of nameList.children) {
      if (child.type === "identifier") {
        symbols.push({
          nodeId: `${filePath}:${child.text}:const`,
          kind: "variable",
          name: child.text,
          exported: isExported(child.text),
          range: extractRange(node),
        });
      }
    }
  }

  return symbols;
}

function processVarSpec(node: SyntaxNode, filePath: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  const name = node.children.find((c: SyntaxNode) => c.type === "identifier");
  if (name) {
    symbols.push({
      nodeId: `${filePath}:${name.text}:var`,
      kind: "variable",
      name: name.text,
      exported: isExported(name.text),
      range: extractRange(node),
    });
  }

  const nameList = node.children.find(
    (c: SyntaxNode) => c.type === "identifier_list",
  );
  if (nameList) {
    for (const child of nameList.children) {
      if (child.type === "identifier") {
        symbols.push({
          nodeId: `${filePath}:${child.text}:var`,
          kind: "variable",
          name: child.text,
          exported: isExported(child.text),
          range: extractRange(node),
        });
      }
    }
  }

  return symbols;
}

function extractParameters(
  node: SyntaxNode,
): Array<{ name: string; type?: string }> {
  const params: Array<{ name: string; type?: string }> = [];

  const hasReceiver = node.children[1]?.type === "parameter_list";

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];

    if (child.type === "parameter_list") {
      const prevChild = node.children[i - 1];
      const isReturnParams = prevChild?.type === "parameter_list";
      const isReceiver = i === 1 && !hasReceiver;
      const isParams = !isReceiver && !isReturnParams;

      if (isParams || isReceiver) {
        for (const paramChild of child.children) {
          if (paramChild.type === "parameter_declaration") {
            const nameNode = paramChild.children.find(
              (c: SyntaxNode) => c.type === "identifier",
            );
            const typeNode = paramChild.children.find(
              (c: SyntaxNode) => c.type !== "identifier",
            );

            if (nameNode) {
              params.push({
                name: nameNode.text,
                type: typeNode ? typeNode.text : undefined,
              });
            }
          } else if (paramChild.type === "variadic_parameter_declaration") {
            const nameNode = paramChild.children.find(
              (c: SyntaxNode) => c.type === "identifier",
            );
            const typeNode = paramChild.children.find(
              (c: SyntaxNode) => c.type === "slice_type",
            );

            if (nameNode) {
              params.push({
                name: "..." + nameNode.text,
                type: typeNode ? typeNode.text : undefined,
              });
            }
          }
        }
      }
    }
  }

  return params;
}

function extractResults(node: SyntaxNode): string[] {
  const results: string[] = [];

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];

    if (child.type === "type_identifier") {
      const nextChild = node.children[i + 1];

      const isReturnType = nextChild?.type === "block";

      if (isReturnType) {
        results.push(child.text);
      }
    } else if (child.type === "parameter_list") {
      const prevChild = node.children[i - 1];
      const isReturnParams = prevChild?.type === "parameter_list";

      if (isReturnParams) {
        for (const paramChild of child.children) {
          if (paramChild.type === "parameter_declaration") {
            const typeNode = paramChild.children.find(
              (c: any) => c.type !== "identifier",
            );
            if (typeNode) {
              results.push(typeNode.text);
            }
          }
        }
      }
    }
  }

  return results;
}

function isExported(name: string): boolean {
  if (!name || name.length === 0) return false;
  const firstChar = name.charAt(0);
  return firstChar === firstChar.toUpperCase();
}

function extractRange(node: SyntaxNode) {
  const start = node.startPosition;
  const end = node.endPosition;

  return {
    startLine: start.row + 1,
    startCol: start.column,
    endLine: end.row + 1,
    endCol: end.column,
  };
}

const clearCache = createClearCacheFunction("go");

export { GoAdapter, clearCache };
