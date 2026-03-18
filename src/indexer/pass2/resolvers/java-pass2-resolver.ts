import { dirname, join } from "path";

import type { SyntaxNode, Tree } from "tree-sitter";

import { getLadybugConn, withWriteConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import type { SymbolRow } from "../../../db/ladybug-queries.js";
import type { SymbolKind } from "../../../db/schema.js";
import { readFileAsync } from "../../../util/asyncFs.js";
import { logger } from "../../../util/logger.js";
import { normalizePath } from "../../../util/paths.js";
import { getAdapterForExtension } from "../../adapter/registry.js";
import { resolveImportTargets } from "../../edge-builder/import-resolution.js";
import { findEnclosingSymbolByRange } from "../../edge-builder/pass2.js";
import type { FileMetadata } from "../../fileScanner.js";
import { resolveImportCandidatePaths } from "../../import-resolution/registry.js";
import type { ExtractedImport } from "../../treesitter/extractImports.js";

import type {
  Pass2Resolver,
  Pass2ResolverContext,
  Pass2ResolverResult,
  Pass2Target,
} from "../types.js";

type ExtractedSymbol = {
  nodeId: string;
  kind: SymbolKind;
  name: string;
  exported: boolean;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
};

type ExtractedCall = {
  callerNodeId?: string;
  calleeIdentifier: string;
  isResolved: boolean;
  callType: "function" | "method" | "constructor" | "dynamic";
  calleeSymbolId?: string;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
};

type FilteredSymbolDetail = {
  extractedSymbol: ExtractedSymbol;
  symbolId: string;
};

type JavaResolvedCall = {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  resolution: string;
  targetName?: string;
  candidateCount?: number;
};

type JavaPackageIndex = {
  packageByFilePath: Map<string, string>;
  symbolsByPackage: Map<string, Array<SymbolRow & { relPath: string }>>;
};

type JavaClassMap = {
  methodsByClassName: Map<string, Map<string, string[]>>;
  classNamesByMethodSymbolId: Map<string, string>;
};

type JavaCallScope = {
  callerClassNameByNodeId: Map<string, string>;
  localExtendsByClassName: Map<string, string>;
};

const JAVA_PASS2_EXTENSIONS = new Set([".java"]);

function toFullKey(
  kind: SymbolKind,
  name: string,
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
): string {
  return `${kind}:${name}:${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;
}

function toStartKey(
  kind: SymbolKind,
  name: string,
  range: { startLine: number; startCol: number },
): string {
  return `${kind}:${name}:${range.startLine}:${range.startCol}`;
}

function toStartLineKey(
  kind: SymbolKind,
  name: string,
  range: { startLine: number },
): string {
  return `${kind}:${name}:${range.startLine}`;
}

function toNameKindKey(kind: SymbolKind, name: string): string {
  return `${kind}:${name}`;
}

function pushSymbol(
  map: Map<string, SymbolRow[]>,
  key: string,
  symbol: SymbolRow,
): void {
  const existing = map.get(key) ?? [];
  existing.push(symbol);
  map.set(key, existing);
}

function mapExtractedSymbolsToExisting(
  filePath: string,
  extractedSymbols: ExtractedSymbol[],
  existingSymbols: SymbolRow[],
  telemetry?: Pass2ResolverContext["telemetry"],
): FilteredSymbolDetail[] {
  const symbolIdByFullKey = new Map<string, string>();
  const symbolsByStartKey = new Map<string, SymbolRow[]>();
  const symbolsByStartLineKey = new Map<string, SymbolRow[]>();
  const symbolsByNameKindKey = new Map<string, SymbolRow[]>();

  for (const symbol of existingSymbols) {
    const range = {
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
      endLine: symbol.rangeEndLine,
      endCol: symbol.rangeEndCol,
    };
    symbolIdByFullKey.set(
      toFullKey(symbol.kind as SymbolKind, symbol.name, range),
      symbol.symbolId,
    );
    pushSymbol(
      symbolsByStartKey,
      toStartKey(symbol.kind as SymbolKind, symbol.name, range),
      symbol,
    );
    pushSymbol(
      symbolsByStartLineKey,
      toStartLineKey(symbol.kind as SymbolKind, symbol.name, range),
      symbol,
    );
    pushSymbol(
      symbolsByNameKindKey,
      toNameKindKey(symbol.kind as SymbolKind, symbol.name),
      symbol,
    );
  }

  const filteredSymbolDetails = extractedSymbols
    .map((extractedSymbol) => {
      const fullMatch = symbolIdByFullKey.get(
        toFullKey(
          extractedSymbol.kind,
          extractedSymbol.name,
          extractedSymbol.range,
        ),
      );
      if (fullMatch) {
        return { extractedSymbol, symbolId: fullMatch };
      }

      const startCandidates = symbolsByStartKey.get(
        toStartKey(
          extractedSymbol.kind,
          extractedSymbol.name,
          extractedSymbol.range,
        ),
      );
      if (startCandidates && startCandidates.length === 1) {
        return { extractedSymbol, symbolId: startCandidates[0].symbolId };
      }

      const startLineCandidates = symbolsByStartLineKey.get(
        toStartLineKey(
          extractedSymbol.kind,
          extractedSymbol.name,
          extractedSymbol.range,
        ),
      );
      if (startLineCandidates && startLineCandidates.length === 1) {
        return { extractedSymbol, symbolId: startLineCandidates[0].symbolId };
      }

      const nameKindCandidates = symbolsByNameKindKey.get(
        toNameKindKey(extractedSymbol.kind, extractedSymbol.name),
      );
      if (nameKindCandidates && nameKindCandidates.length === 1) {
        return { extractedSymbol, symbolId: nameKindCandidates[0].symbolId };
      }

      return null;
    })
    .filter((detail): detail is FilteredSymbolDetail => Boolean(detail));

  if (telemetry && filteredSymbolDetails.length === 0) {
    telemetry.pass2FilesNoMappedSymbols++;
    telemetry.samples.noMappedSymbols.push(filePath);
  }

  return filteredSymbolDetails;
}

async function clearOutgoingCallEdges(
  conn: import("kuzu").Connection,
  symbolIds: string[],
  createdCallEdges: Set<string>,
): Promise<void> {
  if (symbolIds.length === 0) {
    return;
  }

  await ladybugDb.deleteOutgoingEdgesByTypeForSymbols(conn, symbolIds, "call");
  for (const symbolId of symbolIds) {
    for (const edgeKey of Array.from(createdCallEdges)) {
      if (edgeKey.startsWith(`${symbolId}->`)) {
        createdCallEdges.delete(edgeKey);
      }
    }
  }
}

function createNodeIdToSymbolId(
  filteredSymbolDetails: FilteredSymbolDetail[],
): Map<string, string> {
  const nodeIdToSymbolId = new Map<string, string>();
  for (const detail of filteredSymbolDetails) {
    nodeIdToSymbolId.set(detail.extractedSymbol.nodeId, detail.symbolId);
  }
  return nodeIdToSymbolId;
}

function isRangeWithin(
  inner: ExtractedSymbol["range"],
  outer: ExtractedSymbol["range"],
): boolean {
  if (inner.startLine < outer.startLine || inner.endLine > outer.endLine) {
    return false;
  }
  if (inner.startLine === outer.startLine && inner.startCol < outer.startCol) {
    return false;
  }
  if (inner.endLine === outer.endLine && inner.endCol > outer.endCol) {
    return false;
  }
  return true;
}

function buildJavaCallScope(
  tree: Tree,
  filteredSymbolDetails: FilteredSymbolDetail[],
): JavaCallScope {
  const classSymbols = filteredSymbolDetails.filter(
    (detail) =>
      detail.extractedSymbol.kind === "class" ||
      detail.extractedSymbol.kind === "interface",
  );

  const callerClassNameByNodeId = new Map<string, string>();
  for (const detail of filteredSymbolDetails) {
    if (
      detail.extractedSymbol.kind !== "method" &&
      detail.extractedSymbol.kind !== "constructor" &&
      detail.extractedSymbol.kind !== "function"
    ) {
      continue;
    }

    let bestClass: FilteredSymbolDetail | null = null;
    let bestSize = Number.POSITIVE_INFINITY;
    for (const classDetail of classSymbols) {
      if (
        !isRangeWithin(
          detail.extractedSymbol.range,
          classDetail.extractedSymbol.range,
        )
      ) {
        continue;
      }

      const classRange = classDetail.extractedSymbol.range;
      const size =
        classRange.endLine -
        classRange.startLine +
        (classRange.endCol - classRange.startCol);
      if (size < bestSize) {
        bestSize = size;
        bestClass = classDetail;
      }
    }

    if (bestClass) {
      callerClassNameByNodeId.set(
        detail.extractedSymbol.nodeId,
        bestClass.extractedSymbol.name,
      );
    }
  }

  const localExtendsByClassName = new Map<string, string>();
  const visit = (node: SyntaxNode): void => {
    if (node.type === "class_declaration") {
      const classNameNode = node.children.find(
        (child) => child.type === "identifier",
      );
      const className = classNameNode?.text;
      if (className) {
        const headerText = node.text.split("{")[0] ?? "";
        const extendsMatch = headerText.match(
          /\bextends\s+([A-Za-z_][A-Za-z0-9_\.]*)/,
        );
        if (extendsMatch?.[1]) {
          const superName = extendsMatch[1].split(".").pop()?.trim();
          if (superName) {
            localExtendsByClassName.set(className, superName);
          }
        }
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  };

  visit(tree.rootNode);

  return {
    callerClassNameByNodeId,
    localExtendsByClassName,
  };
}

function buildClassMethodIndex(
  symbols: Array<SymbolRow & { relPath: string }>,
): JavaClassMap {
  const classesByFile = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();
  const methodsByFile = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();

  for (const symbol of symbols) {
    if (symbol.kind === "class" || symbol.kind === "interface") {
      const classes = classesByFile.get(symbol.relPath) ?? [];
      classes.push(symbol);
      classesByFile.set(symbol.relPath, classes);
      continue;
    }
    if (symbol.kind === "method" || symbol.kind === "constructor") {
      const methods = methodsByFile.get(symbol.relPath) ?? [];
      methods.push(symbol);
      methodsByFile.set(symbol.relPath, methods);
    }
  }

  const methodsByClassName = new Map<string, Map<string, string[]>>();
  const classNamesByMethodSymbolId = new Map<string, string>();

  for (const [relPath, methods] of methodsByFile) {
    const classes = classesByFile.get(relPath) ?? [];
    if (classes.length === 0) {
      continue;
    }

    for (const method of methods) {
      let ownerClass: SymbolRow | null = null;
      let ownerSize = Number.POSITIVE_INFINITY;
      for (const clazz of classes) {
        const withinStart =
          method.rangeStartLine > clazz.rangeStartLine ||
          (method.rangeStartLine === clazz.rangeStartLine &&
            method.rangeStartCol >= clazz.rangeStartCol);
        const withinEnd =
          method.rangeEndLine < clazz.rangeEndLine ||
          (method.rangeEndLine === clazz.rangeEndLine &&
            method.rangeEndCol <= clazz.rangeEndCol);
        if (!withinStart || !withinEnd) {
          continue;
        }

        const size =
          clazz.rangeEndLine -
          clazz.rangeStartLine +
          (clazz.rangeEndCol - clazz.rangeStartCol);
        if (size < ownerSize) {
          ownerSize = size;
          ownerClass = clazz;
        }
      }

      if (!ownerClass) {
        continue;
      }

      classNamesByMethodSymbolId.set(method.symbolId, ownerClass.name);
      const classMethods = methodsByClassName.get(ownerClass.name) ?? new Map();
      const byName = classMethods.get(method.name) ?? [];
      byName.push(method.symbolId);
      classMethods.set(method.name, byName);
      methodsByClassName.set(ownerClass.name, classMethods);
    }
  }

  return {
    methodsByClassName,
    classNamesByMethodSymbolId,
  };
}

async function buildJavaPackageIndex(
  repoId: string,
  cache?: Map<string, unknown>,
): Promise<JavaPackageIndex> {
  const cacheKey = `pass2-java:package-index:${repoId}`;
  const cached = cache?.get(cacheKey);
  if (cached) {
    return cached as JavaPackageIndex;
  }

  const conn = await getLadybugConn();
  const repoFiles = await ladybugDb.getFilesByRepo(conn, repoId);
  const javaFiles = repoFiles.filter((file) => file.language === "java");
  const javaFileIds = new Set(javaFiles.map((file) => file.fileId));
  const fileById = new Map(javaFiles.map((file) => [file.fileId, file]));
  const packageByFilePath = new Map<string, string>();
  const symbolsByPackage = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();

  for (const file of javaFiles) {
    packageByFilePath.set(file.relPath, normalizePath(dirname(file.relPath)));
  }

  const repoSymbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  for (const symbol of repoSymbols) {
    if (!javaFileIds.has(symbol.fileId) || symbol.kind !== "module") {
      continue;
    }
    const file = fileById.get(symbol.fileId);
    if (!file) {
      continue;
    }
    packageByFilePath.set(file.relPath, symbol.name);
  }

  for (const symbol of repoSymbols) {
    if (!javaFileIds.has(symbol.fileId)) {
      continue;
    }
    const file = fileById.get(symbol.fileId);
    if (!file) {
      continue;
    }
    const packageName = packageByFilePath.get(file.relPath);
    if (!packageName) {
      continue;
    }
    const bucket = symbolsByPackage.get(packageName) ?? [];
    bucket.push({
      ...symbol,
      relPath: file.relPath,
    });
    symbolsByPackage.set(packageName, bucket);
  }

  const index = { packageByFilePath, symbolsByPackage };
  cache?.set(cacheKey, index);
  return index;
}

function buildSamePackageNameIndex(
  currentFilePath: string,
  samePackageSymbols: Array<SymbolRow & { relPath: string }>,
): Map<string, string[]> {
  const samePackageNameToSymbolIds = new Map<string, string[]>();
  for (const symbol of samePackageSymbols) {
    if (symbol.relPath === currentFilePath) {
      continue;
    }
    if (
      symbol.kind !== "class" &&
      symbol.kind !== "interface" &&
      symbol.kind !== "function" &&
      symbol.kind !== "method" &&
      symbol.kind !== "constructor"
    ) {
      continue;
    }
    const existing = samePackageNameToSymbolIds.get(symbol.name) ?? [];
    existing.push(symbol.symbolId);
    samePackageNameToSymbolIds.set(symbol.name, existing);
  }
  return samePackageNameToSymbolIds;
}

async function resolveJavaImportMaps(params: {
  conn: import("kuzu").Connection;
  repoId: string;
  repoRoot: string;
  importerRelPath: string;
  imports: ExtractedImport[];
  extensions: string[];
}): Promise<{
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
  wildcardNameToSymbolIds: Map<string, string[]>;
}> {
  const { conn, repoId, repoRoot, importerRelPath, imports, extensions } =
    params;
  const importedNameToSymbolIds = new Map<string, string[]>();
  const namespaceImports = new Map<string, Map<string, string>>();
  const wildcardNameToSymbolIds = new Map<string, string[]>();

  for (const imp of imports) {
    const resolvedPaths = await resolveImportCandidatePaths({
      language: "java",
      repoRoot,
      importerRelPath,
      specifier: imp.specifier,
      extensions,
    });
    if (resolvedPaths.length === 0) {
      continue;
    }

    const targetFiles = (
      await Promise.all(
        resolvedPaths.map((relPath) =>
          ladybugDb.getFileByRepoPath(conn, repoId, relPath),
        ),
      )
    ).flatMap((targetFile) => (targetFile ? [targetFile] : []));
    if (targetFiles.length === 0) {
      continue;
    }

    const targetSymbols = (
      await Promise.all(
        targetFiles.map((targetFile) =>
          ladybugDb.getSymbolsByFile(conn, targetFile.fileId),
        ),
      )
    )
      .flat()
      .filter((symbol) => symbol.exported);

    const explicitNames = new Set<string>();
    if (imp.defaultImport) {
      explicitNames.add(imp.defaultImport);
    }
    for (const name of imp.imports) {
      if (!name.startsWith("*")) {
        explicitNames.add(name);
      }
    }

    for (const name of explicitNames) {
      let match = targetSymbols.find((symbol) => symbol.name === name);
      if (!match) {
        const specifierLeaf = imp.specifier.split(".").pop();
        if (specifierLeaf === name) {
          match = targetSymbols.find((symbol) => symbol.name === specifierLeaf);
        }
      }
      if (!match && imp.defaultImport === name && targetSymbols.length === 1) {
        match = targetSymbols[0];
      }
      if (!match) {
        continue;
      }
      const existing = importedNameToSymbolIds.get(name) ?? [];
      if (!existing.includes(match.symbolId)) {
        existing.push(match.symbolId);
      }
      importedNameToSymbolIds.set(name, existing);
    }

    if (imp.namespaceImport) {
      const namespaceMap =
        namespaceImports.get(imp.namespaceImport) ?? new Map<string, string>();
      for (const symbol of targetSymbols) {
        namespaceMap.set(symbol.name, symbol.symbolId);
      }
      namespaceImports.set(imp.namespaceImport, namespaceMap);
    }

    const isWildcard = imp.imports.some((name) => name.startsWith("*"));
    if (isWildcard) {
      for (const symbol of targetSymbols) {
        const existing = wildcardNameToSymbolIds.get(symbol.name) ?? [];
        if (!existing.includes(symbol.symbolId)) {
          existing.push(symbol.symbolId);
        }
        wildcardNameToSymbolIds.set(symbol.name, existing);
      }
    }
  }

  return {
    importedNameToSymbolIds,
    namespaceImports,
    wildcardNameToSymbolIds,
  };
}

function mergeImportedNameMaps(
  primary: Map<string, string[]>,
  secondary: Map<string, string[]>,
): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const [name, ids] of primary) {
    merged.set(name, [...ids]);
  }
  for (const [name, ids] of secondary) {
    const existing = merged.get(name) ?? [];
    for (const symbolId of ids) {
      if (!existing.includes(symbolId)) {
        existing.push(symbolId);
      }
    }
    merged.set(name, existing);
  }
  return merged;
}

function mergeNamespaceImports(
  primary: Map<string, Map<string, string>>,
  secondary: Map<string, Map<string, string>>,
): Map<string, Map<string, string>> {
  const merged = new Map<string, Map<string, string>>();
  for (const [namespace, symbols] of primary) {
    merged.set(namespace, new Map(symbols));
  }
  for (const [namespace, symbols] of secondary) {
    const existing = merged.get(namespace) ?? new Map<string, string>();
    for (const [name, symbolId] of symbols) {
      existing.set(name, symbolId);
    }
    merged.set(namespace, existing);
  }
  return merged;
}

function resolveJavaPass2CallTarget(params: {
  call: ExtractedCall;
  nodeIdToSymbolId: Map<string, string>;
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
  wildcardNameToSymbolIds: Map<string, string[]>;
  samePackageNameToSymbolIds: Map<string, string[]>;
  classMethodsByName: Map<string, Map<string, string[]>>;
  callerClassNameByNodeId: Map<string, string>;
  localExtendsByClassName: Map<string, string>;
  globalNameToSymbolIds?: Map<string, string[]>;
}): JavaResolvedCall | null {
  const {
    call,
    nodeIdToSymbolId,
    importedNameToSymbolIds,
    namespaceImports,
    wildcardNameToSymbolIds,
    samePackageNameToSymbolIds,
    classMethodsByName,
    callerClassNameByNodeId,
    localExtendsByClassName,
    globalNameToSymbolIds,
  } = params;

  if (call.calleeSymbolId && nodeIdToSymbolId.has(call.calleeSymbolId)) {
    return {
      symbolId: nodeIdToSymbolId.get(call.calleeSymbolId) ?? null,
      isResolved: true,
      confidence: 0.93,
      resolution: "same-file",
    };
  }

  const identifier = call.calleeIdentifier.replace(/^new\s+/, "").trim();
  if (!identifier) {
    return null;
  }

  const importedCandidates = importedNameToSymbolIds.get(identifier);
  if (importedCandidates && importedCandidates.length === 1) {
    return {
      symbolId: importedCandidates[0],
      isResolved: true,
      confidence: 0.9,
      resolution: "import-matched",
    };
  }

  if (identifier.includes(".")) {
    const parts = identifier.split(".");
    const prefix = parts[0];
    const member = parts[parts.length - 1];

    const importedTypeCandidates = importedNameToSymbolIds.get(prefix);
    if (importedTypeCandidates && importedTypeCandidates.length === 1) {
      const importedClassMethods = classMethodsByName.get(prefix);
      const importedMethodCandidates = importedClassMethods?.get(member);
      if (importedMethodCandidates && importedMethodCandidates.length === 1) {
        return {
          symbolId: importedMethodCandidates[0],
          isResolved: true,
          confidence: 0.9,
          resolution: "import-matched",
        };
      }
    }

    const namespace = namespaceImports.get(prefix);
    if (namespace?.has(member)) {
      return {
        symbolId: namespace.get(member) ?? null,
        isResolved: true,
        confidence: 0.9,
        resolution: "import-matched",
      };
    }

    if (prefix === "this") {
      const callerClassName =
        (call.callerNodeId && callerClassNameByNodeId.get(call.callerNodeId)) ??
        undefined;
      if (callerClassName) {
        let className: string | undefined = callerClassName;
        const visited = new Set<string>();
        while (className && !visited.has(className)) {
          visited.add(className);
          const methods = classMethodsByName.get(className);
          const candidates = methods?.get(member);
          if (candidates && candidates.length === 1) {
            return {
              symbolId: candidates[0],
              isResolved: true,
              confidence: 0.85,
              resolution: "receiver-this",
            };
          }
          className = localExtendsByClassName.get(className);
        }
      }
    }

    const samePackageClassMethods = classMethodsByName.get(prefix);
    const samePackageMethodCandidates = samePackageClassMethods?.get(member);
    if (samePackageMethodCandidates && samePackageMethodCandidates.length === 1) {
      return {
        symbolId: samePackageMethodCandidates[0],
        isResolved: true,
        confidence: 0.92,
        resolution: "same-package",
      };
    }
  }

  const samePackageCandidates = samePackageNameToSymbolIds.get(identifier);
  if (samePackageCandidates && samePackageCandidates.length === 1) {
    return {
      symbolId: samePackageCandidates[0],
      isResolved: true,
      confidence: 0.92,
      resolution: "same-package",
    };
  }

  const wildcardCandidates = wildcardNameToSymbolIds.get(identifier);
  if (wildcardCandidates && wildcardCandidates.length === 1) {
    return {
      symbolId: wildcardCandidates[0],
      isResolved: true,
      confidence: 0.8,
      resolution: "wildcard-import",
    };
  }

  const globalCandidates = globalNameToSymbolIds?.get(identifier);
  if (globalCandidates && globalCandidates.length === 1) {
    return {
      symbolId: globalCandidates[0],
      isResolved: true,
      confidence: 0.45,
      resolution: "global-fallback",
    };
  }

  return {
    symbolId: null,
    isResolved: false,
    confidence: 0.35,
    resolution: "unresolved",
    targetName: identifier,
    candidateCount:
      (importedCandidates?.length ?? 0) +
      (samePackageCandidates?.length ?? 0) +
      (wildcardCandidates?.length ?? 0) +
      (globalCandidates?.length ?? 0),
  };
}

async function resolveJavaCallEdgesPass2(params: {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  createdCallEdges: Set<string>;
  globalNameToSymbolIds?: Map<string, string[]>;
  telemetry?: Pass2ResolverContext["telemetry"];
  cache?: Map<string, unknown>;
}): Promise<number> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    createdCallEdges,
    globalNameToSymbolIds,
    telemetry,
    cache,
  } = params;

  const conn = await getLadybugConn();
  const filePath = join(repoRoot, fileMeta.path);
  let content: string;
  try {
    content = await readFileAsync(filePath, "utf-8");
  } catch (readError: unknown) {
    const code = (readError as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EPERM") {
      logger.warn(
        `File disappeared before Java pass2 resolution: ${fileMeta.path}`,
        {
          code,
        },
      );
      return 0;
    }
    throw readError;
  }

  const adapter = getAdapterForExtension(".java");
  if (!adapter) {
    return 0;
  }

  const tree = adapter.parse(content, filePath);
  if (!tree) {
    return 0;
  }

  let extractedSymbols: ExtractedSymbol[];
  let calls: ExtractedCall[];
  let imports: ReturnType<typeof adapter.extractImports>;
  // Store the tree reference for later use by buildJavaCallScope
  const treeRef = tree;
  try {
    extractedSymbols = adapter.extractSymbols(
      tree,
      content,
      filePath,
    ) as ExtractedSymbol[];
    calls = adapter.extractCalls(
      tree,
      content,
      filePath,
      extractedSymbols as never,
    ) as ExtractedCall[];
    imports = adapter.extractImports(tree, content, filePath);
  } catch (e) {
    (tree as unknown as { delete?: () => void }).delete?.();
    throw e;
  }

  // Tree is still needed by buildJavaCallScope; free in finally below
  let fileRecord: Awaited<ReturnType<typeof ladybugDb.getFileByRepoPath>>;
  let existingSymbols: Awaited<ReturnType<typeof ladybugDb.getSymbolsByFile>>;
  let filteredSymbolDetails: ReturnType<typeof mapExtractedSymbolsToExisting>;
  let nodeIdToSymbolId: ReturnType<typeof createNodeIdToSymbolId>;
  let callScope: ReturnType<typeof buildJavaCallScope>;
  try {
    fileRecord = await ladybugDb.getFileByRepoPath(
      conn,
      repoId,
      fileMeta.path,
    );
    if (!fileRecord) {
      return 0;
    }

    existingSymbols = await ladybugDb.getSymbolsByFile(
      conn,
      fileRecord.fileId,
    );
    if (existingSymbols.length === 0) {
      return 0;
    }

    filteredSymbolDetails = mapExtractedSymbolsToExisting(
      fileMeta.path,
      extractedSymbols,
      existingSymbols,
      telemetry,
    );
    if (filteredSymbolDetails.length === 0) {
      return 0;
    }

    const symbolIdsToRefresh = filteredSymbolDetails.map(
      (detail) => detail.symbolId,
    );
    await withWriteConn(async (wConn) => {
      await clearOutgoingCallEdges(wConn, symbolIdsToRefresh, createdCallEdges);
    });

    nodeIdToSymbolId = createNodeIdToSymbolId(filteredSymbolDetails);
    callScope = buildJavaCallScope(treeRef, filteredSymbolDetails);
  } finally {
    (treeRef as unknown as { delete?: () => void }).delete?.();
  }
  const importResolution = await resolveImportTargets(
    repoId,
    repoRoot,
    fileMeta.path,
    imports,
    [...adapter.fileExtensions],
    "java",
    content,
  );
  const javaImportMaps = await resolveJavaImportMaps({
    conn,
    repoId,
    repoRoot,
    importerRelPath: fileMeta.path,
    imports,
    extensions: [...adapter.fileExtensions],
  });
  const importedNameToSymbolIds = mergeImportedNameMaps(
    importResolution.importedNameToSymbolIds,
    javaImportMaps.importedNameToSymbolIds,
  );
  const namespaceImports = mergeNamespaceImports(
    importResolution.namespaceImports,
    javaImportMaps.namespaceImports,
  );

  const packageIndex = await buildJavaPackageIndex(repoId, cache);
  const currentPackage = packageIndex.packageByFilePath.get(fileMeta.path);
  const samePackageSymbols = currentPackage
    ? (packageIndex.symbolsByPackage.get(currentPackage) ?? [])
    : [];
  const samePackageNameToSymbolIds = buildSamePackageNameIndex(
    fileMeta.path,
    samePackageSymbols,
  );
  const classMap = buildClassMethodIndex(samePackageSymbols);

  const now = new Date().toISOString();
  const edgesToInsert: ladybugDb.EdgeRow[] = [];
  let createdEdges = 0;

  for (const detail of filteredSymbolDetails) {
    for (const call of calls) {
      const callerNodeId =
        call.callerNodeId ??
        findEnclosingSymbolByRange(call.range, filteredSymbolDetails);
      if (callerNodeId !== detail.extractedSymbol.nodeId) {
        continue;
      }

      const resolved = resolveJavaPass2CallTarget({
        call,
        nodeIdToSymbolId,
        importedNameToSymbolIds,
        namespaceImports,
        wildcardNameToSymbolIds: javaImportMaps.wildcardNameToSymbolIds,
        samePackageNameToSymbolIds,
        classMethodsByName: classMap.methodsByClassName,
        callerClassNameByNodeId: callScope.callerClassNameByNodeId,
        localExtendsByClassName: callScope.localExtendsByClassName,
        globalNameToSymbolIds,
      });
      if (!resolved) {
        continue;
      }

      if (resolved.isResolved && resolved.symbolId) {
        const edgeKey = `${detail.symbolId}->${resolved.symbolId}`;
        if (createdCallEdges.has(edgeKey)) {
          continue;
        }
        edgesToInsert.push({
          repoId,
          fromSymbolId: detail.symbolId,
          toSymbolId: resolved.symbolId,
          edgeType: "call",
          weight: 1.0,
          confidence: resolved.confidence,
          resolution: resolved.resolution,
          resolverId: "pass2-java",
          resolutionPhase: "pass2",
          provenance: `java-call:${call.calleeIdentifier}`,
          createdAt: now,
        });
        createdCallEdges.add(edgeKey);
        createdEdges++;
      } else if (resolved.targetName) {
        const unresolvedTargetId = `unresolved:call:${resolved.targetName}`;
        const edgeKey = `${detail.symbolId}->${unresolvedTargetId}`;
        if (createdCallEdges.has(edgeKey)) {
          continue;
        }
        edgesToInsert.push({
          repoId,
          fromSymbolId: detail.symbolId,
          toSymbolId: unresolvedTargetId,
          edgeType: "call",
          weight: 0.5,
          confidence: resolved.confidence,
          resolution: "unresolved",
          resolverId: "pass2-java",
          resolutionPhase: "pass2",
          provenance: `unresolved-java-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
          createdAt: now,
        });
        createdCallEdges.add(edgeKey);
        createdEdges++;
      }
    }
  }

  await withWriteConn(async (wConn) => {
    await ladybugDb.insertEdges(wConn, edgesToInsert);
  });
  return createdEdges;
}

export class JavaPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-java";

  supports(target: Pass2Target): boolean {
    return (
      target.language === "java" && JAVA_PASS2_EXTENSIONS.has(target.extension)
    );
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    if (!target.repoId) {
      throw new Error("JavaPass2Resolver requires target.repoId");
    }

    try {
      const edgesCreated = await resolveJavaCallEdgesPass2({
        repoId: target.repoId,
        repoRoot: context.repoRoot,
        fileMeta: {
          path: target.filePath,
          size: 0,
          mtime: 0,
        },
        createdCallEdges: context.createdCallEdges,
        globalNameToSymbolIds: context.globalNameToSymbolIds,
        telemetry: context.telemetry,
        cache: context.cache,
      });
      return { edgesCreated };
    } catch (error) {
      logger.warn(
        `Java pass2 resolution failed for ${target.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { edgesCreated: 0 };
    }
  }
}
