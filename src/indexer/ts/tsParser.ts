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
  invalidateFiles: (relPaths: string[]) => void;
}

/** Cache of ts.Program keyed by repoRoot. */
const programCache = new Map<string, ts.Program>();

/** Files that need to be invalidated on next program build. */
const invalidationSet = new Map<string, Set<string>>();

function buildProgram(
  fileNames: string[],
  compilerOptions: ts.CompilerOptions,
): ts.Program {
  const host = ts.createCompilerHost(compilerOptions, true);
  return ts.createProgram(fileNames, compilerOptions, host);
}

/**
 * Follow aliased symbols up to `maxDepth` times to resolve through barrel
 * re-exports and destructured imports.
 */
function resolveAliasedSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  maxDepth: number = 5,
): ts.Symbol {
  let current = symbol;
  let depth = 0;
  while (
    depth < maxDepth &&
    (current.flags & ts.SymbolFlags.Alias) !== 0
  ) {
    const next = checker.getAliasedSymbol(current);
    if (next === current) break;
    current = next;
    depth++;
  }
  return current;
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

  // Ensure program is built (or rebuilt after invalidation).
  let needsRebuild = !programCache.has(repoRoot);
  if (!needsRebuild) {
    const pending = invalidationSet.get(repoRoot);
    if (pending && pending.size > 0) {
      needsRebuild = true;
    }
  }

  if (needsRebuild) {
    invalidationSet.delete(repoRoot);
    programCache.set(repoRoot, buildProgram(fileNames, compilerOptions));
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  let program = programCache.get(repoRoot)!;
  let checker = program.getTypeChecker();

  return {
    invalidateFiles: (relPaths: string[]): void => {
      if (!invalidationSet.has(repoRoot)) {
        invalidationSet.set(repoRoot, new Set());
      }
      const set = invalidationSet.get(repoRoot)!;
      for (const rp of relPaths) {
        set.add(rp);
      }
    },

    getResolvedCalls: (relPath: string) => {
      // Rebuild program if invalidated since last call.
      const pending = invalidationSet.get(repoRoot);
      if (pending && pending.size > 0) {
        invalidationSet.delete(repoRoot);
        program = buildProgram(fileNames, compilerOptions);
        programCache.set(repoRoot, program);
        checker = program.getTypeChecker();
      }

      const absPath = path.resolve(repoRoot, relPath);
      const sourceFile = program.getSourceFile(absPath);
      if (!sourceFile) {
        return [];
      }

      const resolved: ResolvedCall[] = [];

      const visit = (node: ts.Node): void => {
        const isCall = ts.isCallExpression(node) || ts.isNewExpression(node);
        const isTaggedTemplate = ts.isTaggedTemplateExpression(node);

        if (isCall || isTaggedTemplate) {
          let confidence = 1.0;

          // Determine the callee expression.
          let calleeExpr: ts.Expression;
          if (isTaggedTemplate) {
            calleeExpr = (node as ts.TaggedTemplateExpression).tag;
          } else {
            calleeExpr = (node as ts.CallExpression | ts.NewExpression).expression;
          }

          let symbol = checker.getSymbolAtLocation(calleeExpr);
          let declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];

          // Follow import alias chains (destructured imports, barrel re-exports).
          if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
            const originalSymbol = resolveAliasedSymbol(symbol, checker);
            const origDeclaration =
              originalSymbol?.valueDeclaration ?? originalSymbol?.declarations?.[0];

            if (origDeclaration) {
              declaration = origDeclaration;
              symbol = originalSymbol;
              // Confidence stays at 1.0 – the import is statically resolved
              // regardless of how many barrel hops were traversed.
            }
          }

          // Fallback: property access type inference (obj.method()).
          if (!declaration && !isTaggedTemplate && ts.isPropertyAccessExpression(calleeExpr)) {
            const memberName = calleeExpr.name.text;

            // Try resolved signature first for concrete method resolution.
            if (ts.isCallExpression(node)) {
              const sig = checker.getResolvedSignature(node as ts.CallExpression);
              if (sig) {
                const sigDecl = sig.declaration;
                if (sigDecl && !ts.isJSDocSignature(sigDecl)) {
                  declaration = sigDecl as ts.Declaration;
                  // Determine whether the resolved declaration is in a
                  // different file (cross-module type inference → 0.4).
                  const normCallSite = normalizePath(absPath);
                  const normDeclFile = normalizePath(
                    declaration.getSourceFile()?.fileName ?? "",
                  );
                  confidence = normDeclFile !== normCallSite ? 0.4 : 0.6;
                }
              }
            }

            // Fallback to receiver type property lookup.
            if (!declaration) {
              const receiverType = checker.getTypeAtLocation(
                calleeExpr.expression,
              );
              const member = receiverType.getProperty(memberName);
              declaration = member?.valueDeclaration ?? member?.declarations?.[0];
              if (declaration) {
                // Cross-module type-inferred property access → 0.4.
                const normCallSite = normalizePath(absPath);
                const normDeclFile = normalizePath(
                  declaration.getSourceFile()?.fileName ?? "",
                );
                confidence = normDeclFile !== normCallSite ? 0.4 : 0.6;
              }
            }
          }

          if (declaration) {
            // For arrow functions stored as variable declarations, verify
            // the declaration file is within the repo root before emitting.
            if (ts.isVariableDeclaration(declaration)) {
              const declFile = declaration.getSourceFile()?.fileName ?? "";
              const normalizedDeclFile = normalizePath(declFile);
              const normalizedRepoRoot = normalizePath(repoRoot);
              const repoRootPrefix = normalizedRepoRoot.endsWith("/")
                ? normalizedRepoRoot
                : `${normalizedRepoRoot}/`;
              // Only emit if within repo root and not node_modules.
              const withinRepo =
                normalizedDeclFile.startsWith(repoRootPrefix) &&
                !normalizedDeclFile.includes("/node_modules/");
              if (!withinRepo) {
                ts.forEachChild(node, visit);
                return;
              }
            }

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
