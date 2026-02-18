import type { Tree, SyntaxNode, QueryCapture } from "tree-sitter";
import { BaseAdapter } from "./BaseAdapter.js";
import type {
  AdapterResolvedCall,
  CallResolutionContext,
} from "./LanguageAdapter.js";
import type {
  ExtractedSymbol,
  ExtractedCall,
} from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import { createQuery } from "../treesitter/grammarLoader.js";
import { createClearCacheFunction } from "./BaseAdapter.js";
import { findEnclosingSymbol as findEnclosingSymbolUtil } from "../treesitter/symbolUtils.js";

const PYTHON_STDLIB_MODULES = new Set([
  "os",
  "sys",
  "json",
  "re",
  "datetime",
  "math",
  "collections",
  "itertools",
  "functools",
  "pathlib",
  "typing",
  "types",
  "io",
  "string",
  "numbers",
  "random",
  "statistics",
  "decimal",
  "fractions",
  "heapq",
  "bisect",
  "array",
  "weakref",
]);

function isStdLibModule(moduleName: string): boolean {
  const firstPart = moduleName.split(".")[0];
  return PYTHON_STDLIB_MODULES.has(firstPart);
}

class PythonAdapter extends BaseAdapter {
  languageId = "python";
  fileExtensions = [".py"] as const;

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

  resolveCall(context: CallResolutionContext): AdapterResolvedCall | null {
    const identifier = context.call.calleeIdentifier.replace(/^new\s+/, "").trim();
    if (!identifier) {
      return null;
    }

    const lastPart = identifier.includes(".")
      ? identifier.split(".").pop() ?? identifier
      : identifier;

    const imported = context.importedNameToSymbolIds.get(lastPart);
    if (imported && imported.length === 1) {
      return {
        symbolId: imported[0],
        isResolved: true,
        strategy: "exact",
        confidence: 0.9,
      };
    }

    if (identifier.includes(".")) {
      const parts = identifier.split(".");
      const prefix = parts[0];
      const member = parts[parts.length - 1];
      const namespace = context.namespaceImports.get(prefix);
      if (namespace && namespace.has(member)) {
        return {
          symbolId: namespace.get(member) ?? null,
          isResolved: true,
          strategy: "exact",
          confidence: 0.92,
        };
      }

      if (prefix === "self" || prefix === "cls") {
        const localCandidates = context.nameToSymbolIds.get(member);
        if (localCandidates && localCandidates.length === 1) {
          return {
            symbolId: localCandidates[0],
            isResolved: true,
            strategy: "heuristic",
            confidence: 0.78,
          };
        }
      }
    }

    return null;
  }
}

function extractSymbols(tree: any): Array<{
  name: string;
  kind: ExtractedSymbol["kind"];
  exported: boolean;
  range: ExtractedSymbol["range"];
  signature?: ExtractedSymbol["signature"];
  visibility?: ExtractedSymbol["visibility"];
  decorators?: string[];
}> {
  const symbols: Array<{
    name: string;
    kind: ExtractedSymbol["kind"];
    exported: boolean;
    range: ExtractedSymbol["range"];
    signature?: ExtractedSymbol["signature"];
    visibility?: ExtractedSymbol["visibility"];
    decorators?: string[];
  }> = [];

  function traverse(node: SyntaxNode): void {
    switch (node.type) {
      case "function_definition": {
        const name = extractFunctionName(node);
        if (name) {
          const params = extractParameters(node);
          const returns = extractReturnType(node);
          const decorators = extractDecorators(node);
          const visibility = name.startsWith("_") ? "private" : "public";

          symbols.push({
            name,
            kind: "function",
            exported: !name.startsWith("_"),
            range: extractRange(node),
            signature: {
              params,
              returns,
            },
            visibility,
            decorators: decorators.length > 0 ? decorators : undefined,
          });
        }
        break;
      }

      case "class_definition": {
        const name = extractClassName(node);
        if (name) {
          const decorators = extractDecorators(node);
          const visibility = name.startsWith("_") ? "private" : "public";

          symbols.push({
            name,
            kind: "class",
            exported: !name.startsWith("_"),
            range: extractRange(node),
            signature: {
              params: [],
            },
            visibility,
            decorators: decorators.length > 0 ? decorators : undefined,
          });
        }
        break;
      }

      case "assignment": {
        const name = extractVariableName(node);
        if (name) {
          const visibility = name.startsWith("_") ? "private" : "public";
          symbols.push({
            name,
            kind: "variable",
            exported: !name.startsWith("_"),
            range: extractRange(node),
            visibility,
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

function extractFunctionName(node: SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text || null;
}

function extractClassName(node: SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text || null;
}

function extractVariableName(node: SyntaxNode): string | null {
  const left = node.childForFieldName("left");
  if (!left) return null;

  if (left.type === "identifier") {
    return left.text;
  }

  if (left.type === "pattern_list") {
    const identifier = left.childForFieldName("identifier");
    return identifier?.text || null;
  }

  return null;
}

function extractParameters(
  node: SyntaxNode,
): Array<{ name: string; type?: string }> {
  const params: Array<{ name: string; type?: string }> = [];
  const parametersNode = node.childForFieldName("parameters");

  if (!parametersNode) return params;

  for (const child of parametersNode.children) {
    if (child.type === "identifier") {
      params.push({ name: child.text });
    } else if (child.type === "list_splat_pattern") {
      const identifier = child.children.find(
        (c: SyntaxNode) => c.type === "identifier",
      );
      if (identifier) {
        params.push({ name: "*" + identifier.text });
      }
    } else if (child.type === "dictionary_splat_pattern") {
      const identifier = child.children.find(
        (c: SyntaxNode) => c.type === "identifier",
      );
      if (identifier) {
        params.push({ name: "**" + identifier.text });
      }
    } else {
      const identifier = child.children.find(
        (c: SyntaxNode) => c.type === "identifier",
      );
      const type = child.children.find((c: SyntaxNode) => c.type === "type");

      if (identifier) {
        params.push({
          name: identifier.text,
          type: type?.text || undefined,
        });
      }
    }
  }

  return params;
}

function extractReturnType(node: SyntaxNode): string | undefined {
  const returnTypeNode = node.childForFieldName("return_type");
  if (returnTypeNode) {
    return returnTypeNode.text;
  }
  return undefined;
}

function extractDecorators(node: SyntaxNode): string[] {
  const decorators: string[] = [];
  const decoratorsNode = node.childForFieldName("decorators");

  if (!decoratorsNode) return decorators;

  for (const child of decoratorsNode.children) {
    if (child.type === "decorator") {
      decorators.push(child.text);
    }
  }

  return decorators;
}

function extractRange(node: SyntaxNode): ExtractedSymbol["range"] {
  const start = node.startPosition;
  const end = node.endPosition;

  return {
    startLine: start.row + 1,
    startCol: start.column,
    endLine: end.row + 1,
    endCol: end.column,
  };
}

function extractImports(tree: Tree): ExtractedImport[] {
  const imports: ExtractedImport[] = [];

  const importQuery = createQuery(
    "python",
    `
    (import_statement
      name: (dotted_name) @import_name)

    (import_statement
      name: (aliased_import
        name: (dotted_name) @import_name))

    (import_from_statement
      module_name: (dotted_name) @module_name)

    (import_from_statement
      module_name: (relative_import) @relative_import)

    (import_from_statement
      module_name: (relative_import
        (dotted_name) @module_name))
  `,
  );

  if (!importQuery) {
    return [];
  }

  const matches = importQuery.matches(tree.rootNode);

  for (const match of matches) {
    const importNameCapture = match.captures.find(
      (c: QueryCapture) => c.name === "import_name",
    );
    const moduleNameCapture = match.captures.find(
      (c: QueryCapture) => c.name === "module_name",
    );
    const relativeImportCapture = match.captures.find(
      (c: QueryCapture) => c.name === "relative_import",
    );

    if (!importNameCapture && !moduleNameCapture && !relativeImportCapture)
      continue;

    const node = (
      importNameCapture ||
      moduleNameCapture ||
      relativeImportCapture
    )?.node;
    if (!node) continue;

    let statement = node.parent;
    while (
      statement &&
      statement.type !== "import_statement" &&
      statement.type !== "import_from_statement"
    ) {
      statement = statement.parent;
    }
    if (!statement) continue;

    let specifier = "";
    if (importNameCapture || moduleNameCapture) {
      specifier = node.text || "";
    } else if (relativeImportCapture) {
      specifier = relativeImportCapture.node.text || "";
    }

    if (statement.type === "import_statement") {
      const isRelative =
        specifier.startsWith(".") || hasAncestorOfType(node, "relative_import");
      const isExternal = !isRelative && !isStdLibModule(specifier);

      const result: ExtractedImport = {
        specifier,
        isRelative,
        isExternal,
        imports: [],
        isReExport: false,
      };

      for (const child of statement.children) {
        if (child.type === "aliased_import") {
          const name = child.childForFieldName("name");
          const alias = child.childForFieldName("alias");
          result.imports.push(alias?.text || name?.text || "");
        }
      }

      if (result.imports.length === 0) {
        const parts = node.text.split(".");
        result.imports.push(parts[parts.length - 1]);
      }

      imports.push(result);
    } else if (statement.type === "import_from_statement") {
      const isRelative =
        specifier.startsWith(".") || hasAncestorOfType(node, "relative_import");
      const isExternal = !isRelative && !isStdLibModule(specifier);

      const result: ExtractedImport = {
        specifier,
        isRelative,
        isExternal,
        imports: [],
        isReExport: false,
      };

      const hasWildcardImport = statement.children.some(
        (c: SyntaxNode) => c.type === "wildcard_import",
      );
      if (hasWildcardImport) {
        result.imports.push("*");
        imports.push(result);
        continue;
      }

      let foundImportKeyword = false;
      for (const child of statement.children) {
        if (child.type === "import") {
          foundImportKeyword = true;
          continue;
        }
        if (!foundImportKeyword) continue;

        if (child.type === "dotted_name") {
          result.imports.push(child.text);
        } else if (child.type === "aliased_import") {
          const name = child.childForFieldName("name");
          const alias = child.childForFieldName("alias");
          result.imports.push(alias?.text || name?.text || "");
        }
      }

      if (result.imports.length === 0) {
        result.imports.push("*");
      }

      imports.push(result);
    }
  }

  return imports;
}

function extractCalls(
  tree: Tree,
  extractedSymbols: ExtractedSymbol[],
): ExtractedCall[] {
  const calls: ExtractedCall[] = [];
  const seenCallNodes = new Set<number>();

  const symbolMap = new Map<string, ExtractedSymbol>();
  for (const symbol of extractedSymbols) {
    symbolMap.set(symbol.name, symbol);
  }

  const callQuery = createQuery(
    "python",
    `(call
      function: (identifier) @callee)

    (call
      function: (attribute
        object: (_) @recv
        attribute: (identifier) @attr))
  `,
  );

  if (!callQuery) {
    return [];
  }

  const matches = callQuery.matches(tree.rootNode);

  for (const match of matches) {
    const calleeCapture = match.captures.find(
      (c: QueryCapture) => c.name === "callee",
    );
    const attrCapture = match.captures.find(
      (c: QueryCapture) => c.name === "attr",
    );
    const recvCapture = match.captures.find(
      (c: QueryCapture) => c.name === "recv",
    );

    const captureNode = (calleeCapture || attrCapture)?.node;
    if (!captureNode) continue;

    let callNode: SyntaxNode | null = captureNode.parent;
    if (attrCapture && callNode?.type === "attribute") {
      callNode = callNode.parent;
    }
    if (!callNode || callNode.type !== "call") continue;

    const nodeId = callNode.id;
    if (seenCallNodes.has(nodeId)) continue;

    if (hasAncestorOfType(callNode, "decorator")) continue;
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
      if (symbol && symbol.kind === "function") {
        isResolved = true;
        calleeSymbolId = symbol.nodeId;
      }
    } else if (attrCapture && recvCapture) {
      calleeIdentifier = `${recvCapture.node.text}.${attrCapture.node.text}`;
      callType = "method";

      if (recvCapture.node.text === "self") {
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

    if (recvCapture && recvCapture.node.type === "call") {
      extractNestedCall(
        recvCapture.node,
        callerNodeId,
        symbolMap,
        calls,
        seenCallNodes,
        extractedSymbols,
      );
    }
  }

  extractDecoratorCalls(
    tree,
    extractedSymbols,
    symbolMap,
    calls,
    seenCallNodes,
  );

  return calls;
}

function extractDecoratorCalls(
  tree: Tree,
  _extractedSymbols: ExtractedSymbol[],
  symbolMap: Map<string, ExtractedSymbol>,
  calls: ExtractedCall[],
  seenCallNodes: Set<number>,
): void {
  const decoratorQuery = createQuery(
    "python",
    `
    (decorator
      (call
        function: (identifier) @callee))

    (decorator
      (call
        function: (attribute
          object: (_) @recv
          attribute: (identifier) @attr)))
    `,
  );

  if (!decoratorQuery) return;

  const matches = decoratorQuery.matches(tree.rootNode);

  for (const match of matches) {
    const calleeCapture = match.captures.find(
      (c: QueryCapture) => c.name === "callee",
    );
    const attrCapture = match.captures.find(
      (c: QueryCapture) => c.name === "attr",
    );

    const captureNode = (calleeCapture || attrCapture)?.node;
    if (!captureNode) continue;

    let callNode: SyntaxNode | null = captureNode.parent;
    if (attrCapture && callNode?.type === "attribute") {
      callNode = callNode.parent;
    }
    if (!callNode || callNode.type !== "call") continue;

    const nodeId = callNode.id;
    if (seenCallNodes.has(nodeId)) {
      continue;
    }
    seenCallNodes.add(nodeId);

    const funcNode = callNode.childForFieldName("function");
    if (!funcNode) continue;

    const recvCapture = match.captures.find(
      (c: QueryCapture) => c.name === "recv",
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
    } else if (attrCapture && recvCapture) {
      calleeIdentifier = `${recvCapture.node.text}.${attrCapture.node.text}`;
      callType = "method";
    }

    calls.push({
      callerNodeId: "decorator",
      calleeIdentifier,
      isResolved,
      callType,
      calleeSymbolId,
      range: extractRange(callNode),
    });
  }
}

function extractNestedCall(
  callNode: SyntaxNode,
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
    if (symbol && symbol.kind === "function") {
      isResolved = true;
      calleeSymbolId = symbol.nodeId;
    }
  } else if (funcNode.type === "attribute") {
    const obj = funcNode.childForFieldName("object");
    const attr = funcNode.childForFieldName("attribute");
    if (obj && attr) {
      calleeIdentifier = `${obj.text}.${attr.text}`;
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

function hasAncestorOfType(node: SyntaxNode, type: string): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === type) return true;
    current = current.parent;
  }
  return false;
}

const clearCache = createClearCacheFunction("python");

export { PythonAdapter, clearCache };
