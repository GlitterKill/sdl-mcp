import Parser from "tree-sitter";

export interface ExtractedSymbol {
  name: string;
  kind:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "module"
    | "method"
    | "constructor"
    | "variable";
  exported: boolean;
  visibility?: "public" | "private" | "protected" | "internal";
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
  signature?: {
    params: Array<{ name: string; type?: string }>;
    returns?: string;
    generics?: string[];
  };
  decorators?: string[];
}

function extractIdentifier(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;

  if (node.type === "identifier") {
    return node.text;
  }

  if (node.type === "property_identifier") {
    return node.text;
  }

  if (node.type === "type_identifier") {
    return node.text;
  }

  for (const child of node.children) {
    if (
      child.type === "identifier" ||
      child.type === "property_identifier" ||
      child.type === "type_identifier"
    ) {
      return child.text;
    }
  }

  return null;
}

function extractGenerics(node: Parser.SyntaxNode): string[] {
  const generics: string[] = [];

  const typeParams = node.children.find((c) => c.type === "type_parameters");
  if (typeParams) {
    for (const child of typeParams.children) {
      if (child.type === "type_identifier" || child.type === "type_parameter") {
        generics.push(child.text);
      }
    }
  }

  return generics;
}

function extractParameters(
  node: Parser.SyntaxNode,
): Array<{ name: string; type?: string }> {
  const params: Array<{ name: string; type?: string }> = [];

  const paramList = node.children.find(
    (c) =>
      c.type === "formal_parameters" ||
      c.type === "required_parameters" ||
      c.type === "optional_parameters",
  );

  if (paramList) {
    for (const child of paramList.children) {
      if (
        child.type === "required_parameter" ||
        child.type === "optional_parameter"
      ) {
        const identifier = child.children.find((c) => c.type === "identifier");
        const typeAnnotation = child.children.find(
          (c) => c.type === "type_annotation",
        );

        if (identifier) {
          params.push({
            name: identifier.text,
            type: typeAnnotation ? typeAnnotation.text : undefined,
          });
        }
      } else if (child.type === "identifier") {
        params.push({
          name: child.text,
        });
      } else if (child.type === "rest_parameter") {
        const identifier = child.children.find((c) => c.type === "identifier");
        const typeAnnotation = child.children.find(
          (c) => c.type === "type_annotation",
        );

        if (identifier) {
          params.push({
            name: "..." + identifier.text,
            type: typeAnnotation ? typeAnnotation.text : undefined,
          });
        }
      }
    }
  }

  return params;
}

function extractReturnType(node: Parser.SyntaxNode): string | undefined {
  const returnAnnotation = node.children.find((c) => c.type === "return_type");
  if (returnAnnotation) {
    return returnAnnotation.text;
  }
  return undefined;
}

function extractDecorators(node: Parser.SyntaxNode): string[] {
  const decorators: string[] = [];

  for (const child of node.children) {
    if (child.type === "decorator") {
      decorators.push(child.text);
    }
  }

  return decorators;
}

function isExported(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node;

  while (current) {
    if (current.type === "export_statement") {
      return true;
    }

    for (const child of current.children) {
      if (child.type === "export_clause" || child.type === "export_specifier") {
        return true;
      }
    }

    current = current.parent;
  }

  return false;
}

function extractVisibility(
  node: Parser.SyntaxNode,
): "public" | "private" | "protected" | "internal" | undefined {
  for (const child of node.children) {
    if (child.type === "accessibility_modifier") {
      const modifier = child.text;
      if (modifier === "public") return "public";
      if (modifier === "private") return "private";
      if (modifier === "protected") return "protected";
    }
  }
  return undefined;
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

function processFunctionDeclaration(
  node: Parser.SyntaxNode,
): ExtractedSymbol | null {
  const name = extractIdentifier(node);
  if (!name) return null;

  const signatureNode = node.children.find(
    (c) => c.type === "function_signature",
  );
  const generics = signatureNode ? extractGenerics(signatureNode) : [];
  const params = signatureNode
    ? extractParameters(signatureNode)
    : extractParameters(node);
  const returns = signatureNode
    ? extractReturnType(signatureNode)
    : extractReturnType(node);

  return {
    name,
    kind: "function",
    exported: isExported(node),
    visibility: undefined,
    range: extractRange(node),
    signature: {
      params,
      returns,
      generics: generics.length > 0 ? generics : undefined,
    },
    decorators: extractDecorators(node),
  };
}

function processMethodDefinition(
  node: Parser.SyntaxNode,
): ExtractedSymbol | null {
  const name = extractIdentifier(node);
  if (!name) return null;

  const params = extractParameters(node);
  const returns = extractReturnType(node);
  const visibility = extractVisibility(node);
  const decorators = extractDecorators(node);

  const bodyNode = node.children.find((c) => c.type === "statement_block");
  const generics = bodyNode ? extractGenerics(node) : [];

  return {
    name,
    kind: name === "constructor" ? "constructor" : "method",
    exported: isExported(node),
    visibility,
    range: extractRange(node),
    signature: {
      params,
      returns,
      generics: generics.length > 0 ? generics : undefined,
    },
    decorators: decorators.length > 0 ? decorators : undefined,
  };
}

function processClassDeclaration(
  node: Parser.SyntaxNode,
): ExtractedSymbol | null {
  const name = extractIdentifier(node);
  if (!name) return null;

  const generics = extractGenerics(node);
  const decorators = extractDecorators(node);

  return {
    name,
    kind: "class",
    exported: isExported(node),
    visibility: undefined,
    range: extractRange(node),
    signature: {
      params: [],
      generics: generics.length > 0 ? generics : undefined,
    },
    decorators: decorators.length > 0 ? decorators : undefined,
  };
}

function processInterfaceDeclaration(
  node: Parser.SyntaxNode,
): ExtractedSymbol | null {
  const name = extractIdentifier(node);
  if (!name) return null;

  const generics = extractGenerics(node);

  return {
    name,
    kind: "interface",
    exported: isExported(node),
    visibility: undefined,
    range: extractRange(node),
    signature: {
      params: [],
      generics: generics.length > 0 ? generics : undefined,
    },
  };
}

function processTypeAliasDeclaration(
  node: Parser.SyntaxNode,
): ExtractedSymbol | null {
  const name = extractIdentifier(node);
  if (!name) return null;

  const generics = extractGenerics(node);

  return {
    name,
    kind: "type",
    exported: isExported(node),
    visibility: undefined,
    range: extractRange(node),
    signature: {
      params: [],
      generics: generics.length > 0 ? generics : undefined,
    },
  };
}

function processVariableDeclaration(
  node: Parser.SyntaxNode,
): ExtractedSymbol | null {
  const name = extractIdentifier(node);
  if (!name) {
    const left = node.childForFieldName("name");
    if (
      left &&
      (left.type === "object_pattern" || left.type === "array_pattern")
    ) {
      const patterns: ExtractedSymbol[] = [];
      for (const child of left.children) {
        if (
          child.type === "object_pattern" ||
          child.type === "array_pattern" ||
          child.type === "pair" ||
          child.type === "identifier"
        ) {
          const patternName = extractIdentifier(child);
          if (patternName) {
            patterns.push({
              name: patternName,
              kind: "variable",
              exported: isExported(node),
              visibility: undefined,
              range: extractRange(child),
            });
          }
        }
        const identifier = child.childForFieldName("name");
        if (identifier) {
          const patternName = extractIdentifier(identifier);
          if (patternName) {
            patterns.push({
              name: patternName,
              kind: "variable",
              exported: isExported(node),
              visibility: undefined,
              range: extractRange(identifier),
            });
          }
        }
      }
      return patterns.length > 0 ? patterns[0] : null;
    }
    return null;
  }

  return {
    name,
    kind: "variable",
    exported: isExported(node),
    visibility: undefined,
    range: extractRange(node),
  };
}

function processModule(node: Parser.SyntaxNode): ExtractedSymbol | null {
  const name = extractIdentifier(node);
  if (!name) return null;

  return {
    name,
    kind: "module",
    exported: isExported(node),
    visibility: undefined,
    range: extractRange(node),
  };
}

function processArrowFunction(node: Parser.SyntaxNode): ExtractedSymbol | null {
  const name = extractIdentifier(node);
  if (!name) return null;

  const params = extractParameters(node);
  const returns = extractReturnType(node);

  return {
    name,
    kind: "function",
    exported: isExported(node),
    visibility: undefined,
    range: extractRange(node),
    signature: {
      params,
      returns,
    },
  };
}

function traverseAST(
  node: Parser.SyntaxNode,
  symbols: ExtractedSymbol[],
): void {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
      const funcSymbol = processFunctionDeclaration(node);
      if (funcSymbol) symbols.push(funcSymbol);
      break;

    case "method_definition":
      const methodSymbol = processMethodDefinition(node);
      if (methodSymbol) symbols.push(methodSymbol);
      break;

    case "class_declaration":
      const classSymbol = processClassDeclaration(node);
      if (classSymbol) symbols.push(classSymbol);
      break;

    case "interface_declaration":
      const interfaceSymbol = processInterfaceDeclaration(node);
      if (interfaceSymbol) symbols.push(interfaceSymbol);
      break;

    case "type_alias_declaration":
      const typeSymbol = processTypeAliasDeclaration(node);
      if (typeSymbol) symbols.push(typeSymbol);
      break;

    case "lexical_declaration":
    case "variable_declaration":
      for (const child of node.children) {
        if (child.type === "variable_declarator") {
          const varSymbol = processVariableDeclaration(child);
          if (varSymbol) symbols.push(varSymbol);
        }
      }
      break;

    case "ambient_statement":
      for (const child of node.children) {
        if (child.type === "module") {
          const moduleSymbol = processModule(child);
          if (moduleSymbol) symbols.push(moduleSymbol);
        }
      }
      break;

    case "module":
      const moduleSymbol = processModule(node);
      if (moduleSymbol) symbols.push(moduleSymbol);
      break;

    case "assignment_expression":
      if (node.children[1]?.text === "=") {
        const left = node.children[0];
        if (left.type === "identifier") {
          const arrowFunc = node.children[2];
          if (
            arrowFunc &&
            (arrowFunc.type === "arrow_function" ||
              arrowFunc.type === "function_expression")
          ) {
            const arrowSymbol = processArrowFunction(arrowFunc);
            if (arrowSymbol) {
              symbols.push({
                ...arrowSymbol,
                name: left.text,
              });
            }
          }
        }
      }
      break;
  }

  for (const child of node.children) {
    traverseAST(child, symbols);
  }
}

export function extractSymbols(tree: Parser.Tree): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  traverseAST(tree.rootNode, symbols);

  return symbols;
}
