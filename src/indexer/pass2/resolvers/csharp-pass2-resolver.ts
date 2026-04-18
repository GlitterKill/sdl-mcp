import { dirname, join } from "path";

import type { SyntaxNode, Tree } from "tree-sitter";

import { getLadybugConn, withWriteConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import type { SymbolRow } from "../../../db/ladybug-queries.js";
import type { SymbolKind } from "../../../domain/types.js";
import { readFileAsync } from "../../../util/asyncFs.js";
import { logger } from "../../../util/logger.js";
import { normalizePath } from "../../../util/paths.js";
import { normalizeTypeName } from "../../../util/type-name.js";
import { getAdapterForExtension } from "../../adapter/registry.js";
import { resolveImportTargets } from "../../edge-builder/import-resolution.js";
import { findEnclosingSymbolByRange } from "../../edge-builder/enclosing-symbol.js";
import type { FileMetadata } from "../../fileScanner.js";
import { resolveImportCandidatePaths } from "../../import-resolution/registry.js";
import type { ExtractedImport } from "../../treesitter/extractImports.js";

import type {
  Pass2Resolver,
  Pass2ResolverContext,
  Pass2ResolverResult,
  Pass2Target,
} from "../types.js";
import { confidenceFor } from "../confidence.js";

/**
 * C# using-import literal (0.9). Differs from rubric import-direct value
 * (0.9 matches but kept as named const for clarity).
 */
const CSHARP_USING_IMPORT_CONFIDENCE = 0.9;

/**
 * C# same-namespace literal (0.92). Off-rubric value preserved byte-for-byte.
 */
const CSHARP_SAME_NAMESPACE_CONFIDENCE = 0.92;

/**
 * C# receiver-this literal (0.85). Differs from rubric receiver-this (0.92);
 * preserved byte-for-byte.
 */
const CSHARP_RECEIVER_THIS_CONFIDENCE = 0.85;

/**
 * C# static-using literal (0.8). Same as rubric global-fallback but kept named.
 */
const CSHARP_STATIC_USING_CONFIDENCE = 0.8;

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

type CSharpResolvedCall = {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  resolution: string;
  targetName?: string;
  candidateCount?: number;
};

type CSharpNamespaceIndex = {
  namespaceByFilePath: Map<string, string>;
  symbolsByNamespace: Map<string, Array<SymbolRow & { relPath: string }>>;
};

type CSharpCallScope = {
  callerClassNameByNodeId: Map<string, string>;
  localBaseByClassName: Map<string, string>;
};

const CSHARP_PASS2_EXTENSIONS = new Set([".cs"]);

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

function buildCSharpCallScope(
  tree: Tree,
  filteredSymbolDetails: FilteredSymbolDetail[],
): CSharpCallScope {
  const classSymbols = filteredSymbolDetails.filter((detail) => {
    const kind = detail.extractedSymbol.kind;
    return kind === "class" || kind === "interface";
  });

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

  const localBaseByClassName = new Map<string, string>();
  const visit = (node: SyntaxNode): void => {
    if (node.type === "class_declaration") {
      const classNameNode = node.children.find(
        (child) => child.type === "identifier",
      );
      const className = classNameNode?.text;
      if (className) {
        const header = node.text.split("{")[0] ?? "";
        const match = header.match(/:\s*([^\{]+)/);
        if (match?.[1]) {
          const firstBase =
            normalizeTypeName(
              match[1].split(",")[0]?.trim().split(".").pop() ?? "",
            ) ?? "";
          if (firstBase) {
            localBaseByClassName.set(className, firstBase);
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
    localBaseByClassName,
  };
}

function buildClassMethodIndex(
  symbols: Array<SymbolRow & { relPath: string }>,
): Map<string, Map<string, string[]>> {
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

      const classMethods = methodsByClassName.get(ownerClass.name) ?? new Map();
      const byName = classMethods.get(method.name) ?? [];
      byName.push(method.symbolId);
      classMethods.set(method.name, byName);
      methodsByClassName.set(ownerClass.name, classMethods);
    }
  }

  return methodsByClassName;
}

async function buildCSharpNamespaceIndex(
  repoId: string,
  cache?: Map<string, unknown>,
): Promise<CSharpNamespaceIndex> {
  const cacheKey = `pass2-csharp:namespace-index:${repoId}`;
  const cached = cache?.get(cacheKey);
  if (cached) {
    return cached as CSharpNamespaceIndex;
  }

  const conn = await getLadybugConn();
  const repoFiles = await ladybugDb.getFilesByRepo(conn, repoId);
  const csharpFiles = repoFiles.filter((file) => file.language === "csharp");
  const csharpFileIds = new Set(csharpFiles.map((file) => file.fileId));
  const fileById = new Map(csharpFiles.map((file) => [file.fileId, file]));

  const namespaceByFilePath = new Map<string, string>();
  const symbolsByNamespace = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();

  for (const file of csharpFiles) {
    namespaceByFilePath.set(file.relPath, normalizePath(dirname(file.relPath)));
  }

  const repoSymbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  for (const symbol of repoSymbols) {
    if (!csharpFileIds.has(symbol.fileId) || symbol.kind !== "module") {
      continue;
    }
    const file = fileById.get(symbol.fileId);
    if (!file) {
      continue;
    }
    namespaceByFilePath.set(file.relPath, symbol.name);
  }

  for (const symbol of repoSymbols) {
    if (!csharpFileIds.has(symbol.fileId)) {
      continue;
    }
    const file = fileById.get(symbol.fileId);
    if (!file) {
      continue;
    }
    const namespaceName = namespaceByFilePath.get(file.relPath);
    if (!namespaceName) {
      continue;
    }
    const bucket = symbolsByNamespace.get(namespaceName) ?? [];
    bucket.push({
      ...symbol,
      relPath: file.relPath,
    });
    symbolsByNamespace.set(namespaceName, bucket);
  }

  const index = { namespaceByFilePath, symbolsByNamespace };
  cache?.set(cacheKey, index);
  return index;
}

function buildSameNamespaceNameIndex(
  currentFilePath: string,
  sameNamespaceSymbols: Array<SymbolRow & { relPath: string }>,
): Map<string, string[]> {
  const sameNamespaceNameToSymbolIds = new Map<string, string[]>();
  for (const symbol of sameNamespaceSymbols) {
    if (symbol.relPath === currentFilePath) {
      continue;
    }
    if (
      symbol.kind !== "class" &&
      symbol.kind !== "interface" &&
      symbol.kind !== "type" &&
      symbol.kind !== "function" &&
      symbol.kind !== "method" &&
      symbol.kind !== "constructor"
    ) {
      continue;
    }
    const existing = sameNamespaceNameToSymbolIds.get(symbol.name) ?? [];
    existing.push(symbol.symbolId);
    sameNamespaceNameToSymbolIds.set(symbol.name, existing);
  }
  return sameNamespaceNameToSymbolIds;
}

function splitQualifiedSpecifier(specifier: string): {
  namespacePath: string;
  leafName: string;
} {
  const parts = specifier.split(".").filter(Boolean);
  if (parts.length === 0) {
    return { namespacePath: "", leafName: "" };
  }
  return {
    namespacePath: parts.slice(0, -1).join("."),
    leafName: parts[parts.length - 1] ?? "",
  };
}

function addMapValue(
  map: Map<string, string[]>,
  key: string,
  value: string,
): void {
  const existing = map.get(key) ?? [];
  if (!existing.includes(value)) {
    existing.push(value);
  }
  map.set(key, existing);
}

function findTypeSymbolsForSpecifier(
  specifier: string,
  namespaceIndex: CSharpNamespaceIndex,
): Array<SymbolRow & { relPath: string }> {
  const { namespacePath, leafName } = splitQualifiedSpecifier(specifier);
  if (!leafName) {
    return [];
  }

  const namespaceSymbols = namespacePath
    ? (namespaceIndex.symbolsByNamespace.get(namespacePath) ?? [])
    : [];
  const directMatches = namespaceSymbols.filter(
    (symbol) =>
      (symbol.kind === "class" ||
        symbol.kind === "interface" ||
        symbol.kind === "type") &&
      symbol.name === leafName,
  );
  if (directMatches.length > 0) {
    return directMatches;
  }

  const fallbackMatches: Array<SymbolRow & { relPath: string }> = [];
  for (const symbols of namespaceIndex.symbolsByNamespace.values()) {
    for (const symbol of symbols) {
      if (
        (symbol.kind === "class" ||
          symbol.kind === "interface" ||
          symbol.kind === "type") &&
        symbol.name === leafName
      ) {
        fallbackMatches.push(symbol);
      }
    }
  }
  return fallbackMatches;
}

function collectTypeMembers(
  typeSymbol: SymbolRow,
  symbols: Array<SymbolRow & { relPath: string }>,
): Map<string, string[]> {
  const methods = new Map<string, string[]>();
  for (const symbol of symbols) {
    if (symbol.fileId !== typeSymbol.fileId) {
      continue;
    }
    if (symbol.kind !== "method") {
      continue;
    }
    const withinStart =
      symbol.rangeStartLine > typeSymbol.rangeStartLine ||
      (symbol.rangeStartLine === typeSymbol.rangeStartLine &&
        symbol.rangeStartCol >= typeSymbol.rangeStartCol);
    const withinEnd =
      symbol.rangeEndLine < typeSymbol.rangeEndLine ||
      (symbol.rangeEndLine === typeSymbol.rangeEndLine &&
        symbol.rangeEndCol <= typeSymbol.rangeEndCol);
    if (!withinStart || !withinEnd) {
      continue;
    }
    addMapValue(methods, symbol.name, symbol.symbolId);
  }
  return methods;
}

async function resolveCSharpImportMaps(params: {
  conn: import("kuzu").Connection;
  repoId: string;
  repoRoot: string;
  importerRelPath: string;
  imports: ExtractedImport[];
  extensions: string[];
  namespaceIndex: CSharpNamespaceIndex;
}): Promise<{
  usingNameToSymbolIds: Map<string, string[]>;
  usingNamespaceImports: Map<string, Map<string, string>>;
  staticUsingNameToSymbolIds: Map<string, string[]>;
}> {
  const {
    conn,
    repoId,
    repoRoot,
    importerRelPath,
    imports,
    extensions,
    namespaceIndex,
  } = params;
  const usingNameToSymbolIds = new Map<string, string[]>();
  const usingNamespaceImports = new Map<string, Map<string, string>>();
  const staticUsingNameToSymbolIds = new Map<string, string[]>();

  for (const imp of imports) {
    const isStatic = imp.imports.some((name) => name === "*");
    const specifier = imp.specifier.trim();
    if (!specifier) {
      continue;
    }

    if (isStatic) {
      const typeSymbols = findTypeSymbolsForSpecifier(
        specifier,
        namespaceIndex,
      );
      for (const typeSymbol of typeSymbols) {
        const namespaceName = namespaceIndex.namespaceByFilePath.get(
          typeSymbol.relPath,
        );
        if (!namespaceName) {
          continue;
        }
        const symbols =
          namespaceIndex.symbolsByNamespace.get(namespaceName) ?? [];
        const members = collectTypeMembers(typeSymbol, symbols);
        for (const [name, symbolIds] of members) {
          for (const symbolId of symbolIds) {
            addMapValue(staticUsingNameToSymbolIds, name, symbolId);
          }
        }
      }

      const resolvedPaths = await resolveImportCandidatePaths({
        language: "csharp",
        repoRoot,
        importerRelPath,
        specifier,
        extensions,
      });
      const targetFiles: Exclude<
        Awaited<ReturnType<typeof ladybugDb.getFileByRepoPath>>,
        null
      >[] = [];
      for (const relPath of resolvedPaths) {
        const f = await ladybugDb.getFileByRepoPath(conn, repoId, relPath);
        if (f) targetFiles.push(f);
      }
      if (targetFiles.length > 0) {
        const targetSymbolsNested: Awaited<
          ReturnType<typeof ladybugDb.getSymbolsByFile>
        >[] = [];
        for (const targetFile of targetFiles) {
          targetSymbolsNested.push(
            await ladybugDb.getSymbolsByFile(conn, targetFile.fileId),
          );
        }
        const targetSymbols = targetSymbolsNested.flat();
        const typeSymbol = targetSymbols.find(
          (symbol) =>
            symbol.kind === "class" ||
            symbol.kind === "interface" ||
            symbol.kind === "type",
        );
        if (typeSymbol) {
          const members = collectTypeMembers(
            typeSymbol,
            targetSymbols.map((symbol) => ({
              ...symbol,
              relPath: targetFiles[0].relPath,
            })),
          );
          for (const [name, symbolIds] of members) {
            for (const symbolId of symbolIds) {
              addMapValue(staticUsingNameToSymbolIds, name, symbolId);
            }
          }
        }
      }
      continue;
    }

    const namespaceSymbols =
      namespaceIndex.symbolsByNamespace.get(specifier) ?? [];
    if (namespaceSymbols.length > 0) {
      for (const symbol of namespaceSymbols) {
        if (
          symbol.kind !== "class" &&
          symbol.kind !== "interface" &&
          symbol.kind !== "type" &&
          symbol.kind !== "function"
        ) {
          continue;
        }
        addMapValue(usingNameToSymbolIds, symbol.name, symbol.symbolId);
      }

      if (imp.defaultImport) {
        const namespaceMap =
          usingNamespaceImports.get(imp.defaultImport) ??
          new Map<string, string>();
        for (const symbol of namespaceSymbols) {
          namespaceMap.set(symbol.name, symbol.symbolId);
        }
        usingNamespaceImports.set(imp.defaultImport, namespaceMap);
      }

      continue;
    }

    const typeSymbols = findTypeSymbolsForSpecifier(specifier, namespaceIndex);
    for (const symbol of typeSymbols) {
      addMapValue(usingNameToSymbolIds, symbol.name, symbol.symbolId);
      if (imp.defaultImport) {
        addMapValue(usingNameToSymbolIds, imp.defaultImport, symbol.symbolId);
      }
    }
  }

  return {
    usingNameToSymbolIds,
    usingNamespaceImports,
    staticUsingNameToSymbolIds,
  };
}

function resolveCSharpPass2CallTarget(params: {
  call: ExtractedCall;
  nodeIdToSymbolId: Map<string, string>;
  usingNameToSymbolIds: Map<string, string[]>;
  usingNamespaceImports: Map<string, Map<string, string>>;
  sameNamespaceNameToSymbolIds: Map<string, string[]>;
  classMethodsByName: Map<string, Map<string, string[]>>;
  callerClassNameByNodeId: Map<string, string>;
  localBaseByClassName: Map<string, string>;
  staticUsingNameToSymbolIds: Map<string, string[]>;
  globalNameToSymbolIds?: Map<string, string[]>;
}): CSharpResolvedCall | null {
  const {
    call,
    nodeIdToSymbolId,
    usingNameToSymbolIds,
    usingNamespaceImports,
    sameNamespaceNameToSymbolIds,
    classMethodsByName,
    callerClassNameByNodeId,
    localBaseByClassName,
    staticUsingNameToSymbolIds,
    globalNameToSymbolIds,
  } = params;

  if (call.calleeSymbolId && nodeIdToSymbolId.has(call.calleeSymbolId)) {
    return {
      symbolId: nodeIdToSymbolId.get(call.calleeSymbolId) ?? null,
      isResolved: true,
      confidence: confidenceFor("package-qualified"),
      resolution: "same-file",
    };
  }

  const identifier = call.calleeIdentifier.replace(/^new\s+/, "").trim();
  if (!identifier) {
    return null;
  }

  const usingCandidates = usingNameToSymbolIds.get(identifier);
  if (usingCandidates && usingCandidates.length === 1) {
    return {
      symbolId: usingCandidates[0],
      isResolved: true,
      confidence: CSHARP_USING_IMPORT_CONFIDENCE,
      resolution: "using-import",
    };
  }

  if (identifier.includes(".")) {
    const parts = identifier.split(".");
    const prefix = parts[0];
    const member = parts[parts.length - 1];

    const namespace = usingNamespaceImports.get(prefix);
    if (namespace?.has(member)) {
      return {
        symbolId: namespace.get(member) ?? null,
        isResolved: true,
        confidence: CSHARP_USING_IMPORT_CONFIDENCE,
        resolution: "using-import",
      };
    }

    const sameNamespaceClassMethods = classMethodsByName.get(prefix);
    const sameNamespaceMethodCandidates =
      sameNamespaceClassMethods?.get(member);
    if (
      sameNamespaceMethodCandidates &&
      sameNamespaceMethodCandidates.length === 1
    ) {
      return {
        symbolId: sameNamespaceMethodCandidates[0],
        isResolved: true,
        confidence: CSHARP_SAME_NAMESPACE_CONFIDENCE,
        resolution: "same-namespace",
      };
    }

    if (prefix === "this" || prefix === "base") {
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
              confidence: CSHARP_RECEIVER_THIS_CONFIDENCE,
              resolution: "receiver-this",
            };
          }
          className = localBaseByClassName.get(className);
        }
      }
    }
  }

  const sameNamespaceCandidates = sameNamespaceNameToSymbolIds.get(identifier);
  if (sameNamespaceCandidates && sameNamespaceCandidates.length === 1) {
    return {
      symbolId: sameNamespaceCandidates[0],
      isResolved: true,
      confidence: CSHARP_SAME_NAMESPACE_CONFIDENCE,
      resolution: "same-namespace",
    };
  }

  const staticUsingCandidates = staticUsingNameToSymbolIds.get(identifier);
  if (staticUsingCandidates && staticUsingCandidates.length === 1) {
    return {
      symbolId: staticUsingCandidates[0],
      isResolved: true,
      confidence: CSHARP_STATIC_USING_CONFIDENCE,
      resolution: "static-using",
    };
  }

  const globalCandidates = globalNameToSymbolIds?.get(identifier);
  if (globalCandidates && globalCandidates.length === 1) {
    return {
      symbolId: globalCandidates[0],
      isResolved: true,
      confidence: confidenceFor("cross-file-name-ambiguous"),
      resolution: "global-fallback",
    };
  }

  return {
    symbolId: null,
    isResolved: false,
    confidence: confidenceFor("heuristic-only"),
    resolution: "unresolved",
    targetName: identifier,
    candidateCount:
      (usingCandidates?.length ?? 0) +
      (sameNamespaceCandidates?.length ?? 0) +
      (staticUsingCandidates?.length ?? 0) +
      (globalCandidates?.length ?? 0),
  };
}

async function resolveCSharpCallEdgesPass2(params: {
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
        `File disappeared before C# pass2 resolution: ${fileMeta.path}`,
        {
          code,
        },
      );
      return 0;
    }
    throw readError;
  }

  const adapter = getAdapterForExtension(".cs");
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
  // Store tree reference for later use by buildCSharpCallScope
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

  // Tree is still needed by buildCSharpCallScope; free in finally below
  let fileRecord: Awaited<ReturnType<typeof ladybugDb.getFileByRepoPath>>;
  let existingSymbols: Awaited<ReturnType<typeof ladybugDb.getSymbolsByFile>>;
  let filteredSymbolDetails: ReturnType<typeof mapExtractedSymbolsToExisting>;
  let nodeIdToSymbolId: ReturnType<typeof createNodeIdToSymbolId>;
  let callScope: ReturnType<typeof buildCSharpCallScope>;
  try {
    fileRecord = await ladybugDb.getFileByRepoPath(conn, repoId, fileMeta.path);
    if (!fileRecord) {
      return 0;
    }

    existingSymbols = await ladybugDb.getSymbolsByFile(conn, fileRecord.fileId);
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
    callScope = buildCSharpCallScope(treeRef, filteredSymbolDetails);
  } finally {
    (treeRef as unknown as { delete?: () => void }).delete?.();
  }
  const importResolution = await resolveImportTargets(
    repoId,
    repoRoot,
    fileMeta.path,
    imports,
    [...adapter.fileExtensions],
    "csharp",
    content,
  );

  const namespaceIndex = await buildCSharpNamespaceIndex(repoId, cache);
  const csharpImportMaps = await resolveCSharpImportMaps({
    conn,
    repoId,
    repoRoot,
    importerRelPath: fileMeta.path,
    imports,
    extensions: [...adapter.fileExtensions],
    namespaceIndex,
  });

  const usingNameToSymbolIds = new Map<string, string[]>();
  for (const [name, symbolIds] of importResolution.importedNameToSymbolIds) {
    usingNameToSymbolIds.set(name, [...symbolIds]);
  }
  for (const [name, symbolIds] of csharpImportMaps.usingNameToSymbolIds) {
    const existing = usingNameToSymbolIds.get(name) ?? [];
    for (const symbolId of symbolIds) {
      if (!existing.includes(symbolId)) {
        existing.push(symbolId);
      }
    }
    usingNameToSymbolIds.set(name, existing);
  }

  const usingNamespaceImports = new Map<string, Map<string, string>>();
  for (const [name, symbols] of importResolution.namespaceImports) {
    usingNamespaceImports.set(name, new Map(symbols));
  }
  for (const [name, symbols] of csharpImportMaps.usingNamespaceImports) {
    const existing =
      usingNamespaceImports.get(name) ?? new Map<string, string>();
    for (const [symbolName, symbolId] of symbols) {
      existing.set(symbolName, symbolId);
    }
    usingNamespaceImports.set(name, existing);
  }

  const currentNamespace = namespaceIndex.namespaceByFilePath.get(
    fileMeta.path,
  );
  const sameNamespaceSymbols = currentNamespace
    ? (namespaceIndex.symbolsByNamespace.get(currentNamespace) ?? [])
    : [];
  const sameNamespaceNameToSymbolIds = buildSameNamespaceNameIndex(
    fileMeta.path,
    sameNamespaceSymbols,
  );
  const classMethodsByName = buildClassMethodIndex(sameNamespaceSymbols);

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

      const resolved = resolveCSharpPass2CallTarget({
        call,
        nodeIdToSymbolId,
        usingNameToSymbolIds,
        usingNamespaceImports,
        sameNamespaceNameToSymbolIds,
        classMethodsByName,
        callerClassNameByNodeId: callScope.callerClassNameByNodeId,
        localBaseByClassName: callScope.localBaseByClassName,
        staticUsingNameToSymbolIds: csharpImportMaps.staticUsingNameToSymbolIds,
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
          resolverId: "pass2-csharp",
          resolutionPhase: "pass2",
          provenance: `csharp-call:${call.calleeIdentifier}`,
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
          resolverId: "pass2-csharp",
          resolutionPhase: "pass2",
          provenance: `unresolved-csharp-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
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

export class CSharpPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-csharp";

  supports(target: Pass2Target): boolean {
    return (
      target.language === "csharp" &&
      CSHARP_PASS2_EXTENSIONS.has(target.extension)
    );
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    if (!target.repoId) {
      throw new Error("CSharpPass2Resolver requires target.repoId");
    }

    try {
      const edgesCreated = await resolveCSharpCallEdgesPass2({
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
        `C# pass2 resolution failed for ${target.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { edgesCreated: 0 };
    }
  }
}
