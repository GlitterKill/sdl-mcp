import path from "path";
import fg from "fast-glob";
import ts from "typescript";
import type { SymbolKind } from "../../db/schema.js";
import { normalizePath } from "../../util/paths.js";
import type { FileMetadata } from "../fileScanner.js";

export interface ResolvedCall {
  caller: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
  callee: {
    filePath: string;
    name: string;
    kind: SymbolKind;
  };
  confidence?: number;
}

export interface TsCallResolver {
  getResolvedCalls: (relPath: string) => ResolvedCall[];
}

export function createTsCallResolver(
  repoRoot: string,
  files: FileMetadata[],
  options?: {
    includeNodeModulesTypes?: boolean;
  },
): TsCallResolver | null {
  const sourceFileNames = files
    .map((file) => path.resolve(repoRoot, file.path))
    .filter(
      (file) =>
        file.endsWith(".ts") ||
        file.endsWith(".tsx") ||
        file.endsWith(".js") ||
        file.endsWith(".jsx"),
    );

  const includeNodeModulesTypes =
    options?.includeNodeModulesTypes !== undefined
      ? options.includeNodeModulesTypes
      : true;
  const typeDefinitionFiles = includeNodeModulesTypes
    ? fg.sync(
        [
          "node_modules/@types/**/*.d.ts",
          "!node_modules/@types/node/**",
          "!node_modules/@types/node.d.ts",
        ],
        {
          cwd: repoRoot,
          absolute: true,
          onlyFiles: true,
          unique: true,
          suppressErrors: true,
        },
      )
    : [];

  const fileNames = Array.from(new Set([...sourceFileNames, ...typeDefinitionFiles]));

  if (fileNames.length === 0) {
    return null;
  }

  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    noEmit: true,
  };

  const host = ts.createCompilerHost(compilerOptions, true);
  const program = ts.createProgram(fileNames, compilerOptions, host);
  const checker = program.getTypeChecker();

  return {
    getResolvedCalls: (relPath: string) => {
      const absPath = path.resolve(repoRoot, relPath);
      const sourceFile = program.getSourceFile(absPath);
      if (!sourceFile) {
        return [];
      }

      const resolved: ResolvedCall[] = [];

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          let confidence = 1.0;
          const symbol = checker.getSymbolAtLocation(node.expression);
          let declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];

          if (!declaration && ts.isPropertyAccessExpression(node.expression)) {
            const memberName = node.expression.name.text;
            const receiverType = checker.getTypeAtLocation(
              node.expression.expression,
            );
            const member = receiverType.getProperty(memberName);
            declaration = member?.valueDeclaration ?? member?.declarations?.[0];
            if (declaration) {
              confidence = 0.6;
            }
          }

          if (declaration) {
            const mapped = mapDeclaration(declaration, repoRoot);
            if (mapped) {
              const start = sourceFile.getLineAndCharacterOfPosition(
                node.getStart(sourceFile),
              );
              const end = sourceFile.getLineAndCharacterOfPosition(
                node.getEnd(),
              );

              resolved.push({
                caller: {
                  startLine: start.line + 1,
                  startCol: start.character,
                  endLine: end.line + 1,
                  endCol: end.character,
                },
                callee: mapped,
                confidence,
              });
            }
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
      return resolved;
    },
  };
}

function mapDeclaration(
  declaration: ts.Declaration,
  repoRoot: string,
): { filePath: string; name: string; kind: SymbolKind } | null {
  const sourceFile = declaration.getSourceFile();
  if (!sourceFile?.fileName) {
    return null;
  }

  const name = getDeclarationName(declaration);
  if (!name) {
    return null;
  }

  const kind = mapKind(declaration);
  if (!kind) {
    return null;
  }

  return {
    filePath: normalizePath(path.relative(repoRoot, sourceFile.fileName)),
    name,
    kind,
  };
}

function getDeclarationName(declaration: ts.Declaration): string | null {
  const namedDeclaration = declaration as ts.NamedDeclaration;
  const nameNode = namedDeclaration.name;
  if (nameNode && ts.isIdentifier(nameNode)) {
    return nameNode.text;
  }
  if (nameNode && ts.isStringLiteral(nameNode)) {
    return nameNode.text;
  }
  return null;
}

function mapKind(declaration: ts.Declaration): SymbolKind | null {
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration)
  ) {
    return "function";
  }
  if (
    ts.isMethodDeclaration(declaration) ||
    ts.isMethodSignature(declaration)
  ) {
    return "method";
  }
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
    return "class";
  }
  if (ts.isInterfaceDeclaration(declaration)) {
    return "interface";
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    return "type";
  }
  if (ts.isVariableDeclaration(declaration)) {
    return "variable";
  }
  return null;
}
