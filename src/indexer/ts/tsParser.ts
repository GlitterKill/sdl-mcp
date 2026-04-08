/**
 * TypeScript compiler-backed call resolver (Pass-2 type-aware call resolution).
 *
 * `TsCallResolver` wraps a `ts.createProgram` cache keyed by the file set and
 * compiler options. Rebuilds only happen when the file set, compiler options,
 * or invalidated (dirty) files change — otherwise the cached program is reused.
 *
 * Lifecycle: the resolver is created LAZILY by the Rust Pass-1 engine path in
 * `src/indexer/indexer.ts` (`indexRepoImpl`, see the "Lazily create TS compiler
 * resolver for Pass 2" section). Pass-1 itself runs without a resolver.
 *
 * Hybrid Pass-1 (Task 1.1 Rust→TS fallback) does NOT invalidate this cache:
 * fallback files are processed by `processFile` with `tsResolver: null`, the
 * same code path as pure-Rust Pass-1 files. The shared Pass-2 program is then
 * built once over the full file set after Pass-1 completes.
 *
 * Consumers: `src/indexer/indexer.ts`, `src/indexer/indexer-pass1.ts`.
 */
import path from "path";
import { globSync } from "node:fs";
import ts from "typescript";
import type { SymbolKind } from "../../domain/types.js";
import { hashContent } from "../../util/hashing.js";
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

interface TsProgramCacheEntry {
  builderProgram: ts.SemanticDiagnosticsBuilderProgram;
  program: ts.Program;
  host: ts.CompilerHost;
  fileSetKey: string;
  compilerOptionsKey: string;
  buildId: number;
}

/** Cache of ts.Program keyed by repoRoot. */
const programCache = new Map<string, TsProgramCacheEntry>();

/** Cache of discovered `node_modules/@types` files keyed by repoRoot. */
const typeDefinitionFileCache = new Map<string, string[]>();

/** Files that need to be invalidated on next program build. */
const invalidationSet = new Map<string, Set<string>>();
let nextProgramBuildId = 1;

function buildProgram(
  fileNames: string[],
  compilerOptions: ts.CompilerOptions,
  oldEntry?: TsProgramCacheEntry,
): { builderProgram: ts.SemanticDiagnosticsBuilderProgram; program: ts.Program; host: ts.CompilerHost } {
  const host =
    oldEntry?.compilerOptionsKey === buildCompilerOptionsKey(compilerOptions)
      ? oldEntry.host
      : ts.createIncrementalCompilerHost(compilerOptions, ts.sys);
  const builderProgram = ts.createSemanticDiagnosticsBuilderProgram(
    fileNames,
    compilerOptions,
    host,
    oldEntry?.builderProgram,
  );
  return {
    builderProgram,
    program: builderProgram.getProgram(),
    host,
  };
}

function buildFileSetKey(fileNames: string[]): string {
  return hashContent(fileNames.join("\n"));
}

function buildCompilerOptionsKey(
  compilerOptions: ts.CompilerOptions,
): string {
  return hashContent(JSON.stringify(compilerOptions));
}

function markInvalidatedFiles(repoRoot: string, relPaths: string[]): void {
  if (relPaths.length === 0) return;

  if (!invalidationSet.has(repoRoot)) {
    invalidationSet.set(repoRoot, new Set());
  }
  const set = invalidationSet.get(repoRoot)!;
  for (const relPath of relPaths) {
    set.add(normalizePath(relPath));
  }
}

function upsertCachedProgram(params: {
  repoRoot: string;
  fileNames: string[];
  fileSetKey: string;
  compilerOptions: ts.CompilerOptions;
  compilerOptionsKey: string;
  timingsOut?: Record<string, number>;
}): TsProgramCacheEntry {
  const {
    repoRoot,
    fileNames,
    fileSetKey,
    compilerOptions,
    compilerOptionsKey,
    timingsOut,
  } = params;
  const oldEntry = programCache.get(repoRoot);
  const buildStart = timingsOut ? Date.now() : 0;
  const nextProgram = buildProgram(fileNames, compilerOptions, oldEntry);
  const entry: TsProgramCacheEntry = {
    builderProgram: nextProgram.builderProgram,
    program: nextProgram.program,
    host: nextProgram.host,
    fileSetKey,
    compilerOptionsKey,
    buildId: nextProgramBuildId++,
  };
  if (timingsOut) {
    timingsOut.programBuild = Date.now() - buildStart;
  }
  invalidationSet.delete(repoRoot);
  programCache.set(repoRoot, entry);
  return entry;
}

function getTypeDefinitionFiles(
  repoRoot: string,
  includeNodeModulesTypes: boolean,
  timingsOut?: Record<string, number>,
): string[] {
  if (!includeNodeModulesTypes) {
    return [];
  }

  const startMs = timingsOut ? Date.now() : 0;
  const cached = typeDefinitionFileCache.get(repoRoot);
  if (cached) {
    if (timingsOut) {
      timingsOut.typeDefinitions = Date.now() - startMs;
    }
    return cached;
  }

  const discovered = [...globSync("node_modules/@types/**/*.d.ts", {
    cwd: repoRoot,
    exclude: ["node_modules/@types/node/**", "node_modules/@types/node.d.ts"],
  })].map((file) => path.resolve(repoRoot, file));

  typeDefinitionFileCache.set(repoRoot, discovered);
  if (timingsOut) {
    timingsOut.typeDefinitions = Date.now() - startMs;
  }
  return discovered;
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

/**
 * Release cached TS programs and invalidation sets.
 * When `repoRoot` is omitted, clears all resolver cache state.
 */
export function clearTsCallResolverCache(repoRoot?: string): void {
  if (repoRoot) {
    programCache.delete(repoRoot);
    typeDefinitionFileCache.delete(repoRoot);
    invalidationSet.delete(repoRoot);
    return;
  }

  programCache.clear();
  typeDefinitionFileCache.clear();
  invalidationSet.clear();
  nextProgramBuildId = 1;
}

export function getTsCallResolverCacheBuildId(repoRoot: string): number | null {
  return programCache.get(repoRoot)?.buildId ?? null;
}

export function createTsCallResolver(
  repoRoot: string,
  files: FileMetadata[],
  options?: {
    includeNodeModulesTypes?: boolean;
    dirtyRelPaths?: string[];
    timingsOut?: Record<string, number>;
  },
): TsCallResolver | null {
  const timingsOut = options?.timingsOut;
  const sourceFileStart = timingsOut ? Date.now() : 0;
  const sourceFileNames = files
    .map((file) => path.resolve(repoRoot, file.path))
    .filter(
      (file) =>
        file.endsWith(".ts") ||
        file.endsWith(".tsx") ||
        file.endsWith(".js") ||
        file.endsWith(".jsx"),
    );
  if (timingsOut) {
    timingsOut.sourceFiles = Date.now() - sourceFileStart;
  }

  const includeNodeModulesTypes =
    options?.includeNodeModulesTypes !== undefined
      ? options.includeNodeModulesTypes
      : true;
  const typeDefinitionFiles = getTypeDefinitionFiles(
    repoRoot,
    includeNodeModulesTypes,
    timingsOut,
  );

  const fileSetStart = timingsOut ? Date.now() : 0;
  const fileNames = Array.from(
    new Set([...sourceFileNames, ...typeDefinitionFiles]),
  ).sort();
  if (timingsOut) {
    timingsOut.fileSet = Date.now() - fileSetStart;
  }

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
  const fileSetKey = buildFileSetKey(fileNames);
  const compilerOptionsKey = buildCompilerOptionsKey(compilerOptions);

  if (options?.dirtyRelPaths && options.dirtyRelPaths.length > 0) {
    markInvalidatedFiles(repoRoot, options.dirtyRelPaths);
  }

  // Ensure program is built (or rebuilt after invalidation).
  let cachedEntry = programCache.get(repoRoot);
  let needsRebuild = !cachedEntry;
  if (!needsRebuild) {
    needsRebuild =
      cachedEntry!.fileSetKey !== fileSetKey ||
      cachedEntry!.compilerOptionsKey !== compilerOptionsKey;
  }
  if (!needsRebuild) {
    const pending = invalidationSet.get(repoRoot);
    if (pending && pending.size > 0) {
      needsRebuild = true;
    }
  }

  if (needsRebuild) {
    cachedEntry = upsertCachedProgram({
      repoRoot,
      fileNames,
      fileSetKey,
      compilerOptions,
      compilerOptionsKey,
      timingsOut,
    });
  } else if (timingsOut) {
    timingsOut.programBuild = 0;
  }

   
  let program = cachedEntry!.program;
  let checker = program.getTypeChecker();

  return {
    invalidateFiles: (relPaths: string[]): void => {
      markInvalidatedFiles(repoRoot, relPaths);
    },

    getResolvedCalls: (relPath: string) => {
      // Rebuild program if invalidated since last call.
      const pending = invalidationSet.get(repoRoot);
      if (pending && pending.size > 0) {
        const refreshedEntry = upsertCachedProgram({
          repoRoot,
          fileNames,
          fileSetKey,
          compilerOptions,
          compilerOptionsKey,
        });
        program = refreshedEntry.program;
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
            calleeExpr = (node).tag;
          } else {
            calleeExpr = (node).expression;
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
              const sig = checker.getResolvedSignature(node);
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
