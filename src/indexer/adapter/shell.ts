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

class ShellAdapter implements LanguageAdapter {
  languageId = "shell";
  fileExtensions = [".sh", ".bash"] as const;

  private parser: Parser | null = null;

  getParser(): Parser | null {
    if (!this.parser) {
      this.parser = getParser("bash");
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
          "Syntax errors detected in Shell file - attempting partial extraction",
          { filePath: _filePath },
        );
      }

      return tree;
    } catch (error) {
      logger.error("Failed to parse Shell file", {
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
    const richSymbols = extractSymbols(tree, filePath);

    const symbols: ExtractedSymbol[] = richSymbols.map((symbol) => ({
      nodeId: symbol.nodeId,
      kind: symbol.kind,
      name: symbol.name,
      exported: symbol.exported,
      range: symbol.range,
      ...(symbol.signature !== undefined && { signature: symbol.signature }),
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

function extractImports(tree: Parser.Tree): ExtractedImport[] {
  const imports: ExtractedImport[] = [];

  const sourceQuery = createQuery(
    "bash",
    `
    (command
      name: (command_name) @source_keyword
      argument: (word) @source_file)

    (command
      name: (command_name) @source_keyword
      argument: (string) @source_file)
  `,
  );

  if (!sourceQuery) {
    return [];
  }

  const matches = sourceQuery.matches(tree.rootNode);

  for (const match of matches) {
    let sourceKeyword: Parser.SyntaxNode | undefined;
    let sourceFile: Parser.SyntaxNode | undefined;

    for (const capture of match.captures) {
      if (capture.name === "source_keyword") {
        sourceKeyword = capture.node;
      } else if (capture.name === "source_file") {
        sourceFile = capture.node;
      }
    }

    if (!sourceKeyword || !sourceFile) {
      continue;
    }

    const keyword = sourceKeyword.text;
    if (keyword !== "source" && keyword !== ".") {
      continue;
    }

    let specifier = sourceFile.text;

    if (specifier.startsWith('"') || specifier.startsWith("'")) {
      specifier = specifier.slice(1, -1);
    }

    const isRelative =
      specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      !specifier.startsWith("/");

    const extracted: ExtractedImport = {
      specifier,
      isRelative,
      isExternal: false,
      imports: [],
      isReExport: false,
    };

    imports.push(extracted);
  }

  return imports;
}

function extractSymbols(
  tree: Parser.Tree,
  filePath: string,
): Array<{
  nodeId: string;
  name: string;
  kind: ExtractedSymbol["kind"];
  exported: boolean;
  range: ExtractedSymbol["range"];
  signature?: ExtractedSymbol["signature"];
  visibility?: ExtractedSymbol["visibility"];
}> {
  const symbols: Array<{
    nodeId: string;
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
          const visibility = "public"; // Shell functions are always public

          symbols.push({
            nodeId: `${filePath}:${name}`,
            name,
            kind: "function",
            exported: true,
            range: extractRange(node),
            signature: {
              params,
            },
            visibility,
          });
        }
        break;
      }

      case "variable_assignment": {
        const varInfo = extractVariableName(node);
        if (varInfo) {
          const { name, isExported } = varInfo;
          const visibility = "public"; // Shell variables are always public

          symbols.push({
            nodeId: `${filePath}:${name}`,
            name,
            kind: "variable",
            exported: isExported,
            range: extractRange(node),
            visibility,
          });
        }
        break;
      }

      case "command": {
        // Check if this is an alias command
        const aliasName = extractAliasFromCommand(node);
        if (aliasName) {
          const visibility = "public";

          symbols.push({
            nodeId: `${filePath}:${aliasName}:alias`,
            name: aliasName,
            kind: "variable",
            exported: true,
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

function extractCalls(
  tree: Parser.Tree,
  extractedSymbols: ExtractedSymbol[],
): ExtractedCall[] {
  const calls: ExtractedCall[] = [];
  const seenCallNodes = new Set<number>();

  // Build symbol lookup map
  const symbolMap = new Map<string, ExtractedSymbol>();
  for (const symbol of extractedSymbols) {
    symbolMap.set(symbol.name, symbol);
  }

  // Build alias lookup map (symbol names ending with :alias)
  const aliasMap = new Set<string>();
  for (const symbol of extractedSymbols) {
    if (symbol.nodeId.endsWith(":alias")) {
      aliasMap.add(symbol.name);
    }
  }

  // Query for command nodes
  const callQuery = createQuery(
    "bash",
    `
    (command
      name: (command_name) @command_name)
  `,
  );

  if (!callQuery) {
    return [];
  }

  const matches = callQuery.matches(tree.rootNode);

  for (const match of matches) {
    const commandNode = match.captures.find((c) => c.name === "command_name")
      ?.node.parent;

    if (!commandNode || commandNode.type !== "command") continue;

    const nodeId = commandNode.id;
    if (seenCallNodes.has(nodeId)) continue;
    seenCallNodes.add(nodeId);

    const commandNameCapture = match.captures.find(
      (c) => c.name === "command_name",
    );

    if (!commandNameCapture) continue;

    const commandName = commandNameCapture.node.text;

    // Skip 'source' commands - these are imports, not calls
    if (commandName === "source" || commandName === ".") {
      continue;
    }

    // Skip 'alias' definitions - these are declarations, not calls
    if (commandName === "alias") {
      continue;
    }

    const callerNodeId = findEnclosingSymbolUtil(commandNode, extractedSymbols);

    let callType: ExtractedCall["callType"] = "function";
    let isResolved = false;
    let calleeSymbolId: string | undefined;

    // Check if this is a known function call
    const symbol = symbolMap.get(commandName);
    if (symbol && symbol.kind === "function") {
      isResolved = true;
      calleeSymbolId = symbol.nodeId;
      callType = "function";
    }
    // Check if this is an alias invocation
    else if (aliasMap.has(commandName)) {
      isResolved = false;
      callType = "dynamic"; // Aliases are dynamic - we can't track their expansion
    }
    // External command
    else {
      isResolved = false;
      callType = "dynamic";
    }

    calls.push({
      callerNodeId,
      calleeIdentifier: commandName,
      isResolved,
      callType,
      ...(calleeSymbolId !== undefined && { calleeSymbolId }),
      range: extractRange(commandNode),
    });
  }

  return calls;
}

function extractFunctionName(node: Parser.SyntaxNode): string | null {
  // For style: name() {}
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    return nameNode.text;
  }

  // For style: function name {}
  // Check children for the word token after 'function' keyword
  for (const child of node.children) {
    if (child.type === "word") {
      return child.text;
    }
  }

  return null;
}

function extractVariableName(
  node: Parser.SyntaxNode,
): { name: string; isExported: boolean } | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const name = nameNode.text;

  // Check if this is an export assignment
  // Look at parent to see if it's a declaration_command
  const parent = node.parent;
  let isExported = false;

  if (parent && parent.type === "declaration_command") {
    // Check for 'export' keyword among children
    for (const child of parent.children) {
      if (child.type === "export") {
        isExported = true;
        break;
      }
    }
  }

  return { name, isExported };
}

function extractAliasFromCommand(node: Parser.SyntaxNode): string | null {
  // Alias syntax: alias name='command' or alias name="command" or alias name=command
  // This is represented as a command with command_name: alias followed by a concatenation

  // Check if first child is a command_name node with "alias" text
  const firstChild = node.children[0];
  if (!firstChild || firstChild.type !== "command_name") {
    return null;
  }

  // Check if this command_name contains "alias"
  if (!firstChild.text.startsWith("alias")) {
    return null;
  }

  // Find the concatenation or word child that contains the alias name
  // Pattern: alias ll='ls -la' -> we want "ll"
  for (let i = 1; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === "concatenation") {
      // The alias name is typically in the first part of concatenation
      // e.g., "ll=" -> extract "ll"
      const text = child.text;
      const equalIndex = text.indexOf("=");
      if (equalIndex > 0) {
        return text.substring(0, equalIndex);
      }
    } else if (child.type === "word" && !child.text.includes("=")) {
      // Some aliases might be: alias ll ls -la (without quotes and equals)
      // In this case, the alias name is the first word after "alias"
      return child.text;
    }
  }

  return null;
}

function extractParameters(
  node: Parser.SyntaxNode,
): Array<{ name: string; type?: string }> {
  const params: Array<{ name: string; type?: string }> = [];
  const bodyNode = node.childForFieldName("body");

  if (!bodyNode) return params;

  // Shell function parameters are accessed as $1, $2, etc. or via positional parameters
  // We can't extract them from the function definition itself in most cases
  // But we can check for common parameter naming patterns in the body

  // This is a best-effort extraction - shell doesn't have formal parameter lists
  // We'll return empty for now, but could potentially scan the body for $1, $2 references
  return params;
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

function clearCache(): void {
  clearGrammarCache("bash");
}

export { ShellAdapter, clearCache };
