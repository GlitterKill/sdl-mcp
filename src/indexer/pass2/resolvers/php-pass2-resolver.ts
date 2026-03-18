import { join } from "path";

import { getLadybugConn, withWriteConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import type { SymbolRow } from "../../../db/ladybug-queries.js";
import type { SymbolKind } from "../../../db/schema.js";
import { readFileAsync } from "../../../util/asyncFs.js";
import { logger } from "../../../util/logger.js";
import { normalizePath } from "../../../util/paths.js";
import { getAdapterForExtension } from "../../adapter/registry.js";
import type { FileMetadata } from "../../fileScanner.js";
import { findEnclosingSymbolByRange } from "../../edge-builder/pass2.js";
import { resolveImportTargets } from "../../edge-builder/import-resolution.js";
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

type PhpResolvedCall = {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  resolution: string;
  targetName?: string;
  candidateCount?: number;
};

type PhpRepoIndex = {
  namespaceByFilePath: Map<string, string>;
  symbolsByNamespace: Map<string, Array<SymbolRow & { relPath: string }>>;
  symbolsByRelPath: Map<string, Array<SymbolRow & { relPath: string }>>;
  classSymbolIdByFqn: Map<string, string>;
  methodsByClassFqn: Map<string, Map<string, string>>;
  classFqnByShortName: Map<string, string[]>;
};

const PHP_PASS2_EXTENSIONS = new Set([".php", ".phtml"]);

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

function extractShortName(name: string): string {
  const normalized = name.replace(/^\\+/, "");
  const parts = normalized.split("\\");
  return parts[parts.length - 1] ?? normalized;
}

function normalizePhpFqn(name: string): string {
  return name.replace(/^\\+/, "").trim();
}

function inferPhpNamespaceFromSymbols(symbols: SymbolRow[]): string {
  for (const symbol of symbols) {
    if (
      (symbol.kind === "class" ||
        symbol.kind === "interface" ||
        symbol.kind === "function") &&
      symbol.name.includes("\\")
    ) {
      const normalized = normalizePhpFqn(symbol.name);
      const separatorIndex = normalized.lastIndexOf("\\");
      if (separatorIndex > 0) {
        return normalized.slice(0, separatorIndex);
      }
    }
  }
  return "";
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

function createLocalNameIndex(
  filteredSymbolDetails: FilteredSymbolDetail[],
): Map<string, string[]> {
  const nameToSymbolIds = new Map<string, string[]>();
  for (const detail of filteredSymbolDetails) {
    const name = detail.extractedSymbol.name;
    const existing = nameToSymbolIds.get(name) ?? [];
    existing.push(detail.symbolId);
    nameToSymbolIds.set(name, existing);
  }
  return nameToSymbolIds;
}

function createLocalClassContext(
  filteredSymbolDetails: FilteredSymbolDetail[],
): {
  classByMemberSymbolId: Map<string, string>;
  localMethodsByClassFqn: Map<string, Map<string, string>>;
} {
  const classByMemberSymbolId = new Map<string, string>();
  const localMethodsByClassFqn = new Map<string, Map<string, string>>();

  const classSymbols = filteredSymbolDetails.filter(
    (detail) => detail.extractedSymbol.kind === "class",
  );

  for (const detail of filteredSymbolDetails) {
    if (
      detail.extractedSymbol.kind !== "function" &&
      detail.extractedSymbol.kind !== "method"
    ) {
      continue;
    }

    const enclosingClass = classSymbols.find((classDetail) =>
      isRangeWithin(
        detail.extractedSymbol.range,
        classDetail.extractedSymbol.range,
      ),
    );
    if (!enclosingClass) {
      continue;
    }

    const classFqn = normalizePhpFqn(enclosingClass.extractedSymbol.name);
    classByMemberSymbolId.set(detail.symbolId, classFqn);

    const methodMap =
      localMethodsByClassFqn.get(classFqn) ?? new Map<string, string>();
    methodMap.set(detail.extractedSymbol.name, detail.symbolId);
    localMethodsByClassFqn.set(classFqn, methodMap);
  }

  return { classByMemberSymbolId, localMethodsByClassFqn };
}

function createSameNamespaceNameIndex(
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
      symbol.kind !== "function" &&
      symbol.kind !== "interface"
    ) {
      continue;
    }

    const shortName = extractShortName(symbol.name);
    const existing = sameNamespaceNameToSymbolIds.get(shortName) ?? [];
    existing.push(symbol.symbolId);
    sameNamespaceNameToSymbolIds.set(shortName, existing);
  }
  return sameNamespaceNameToSymbolIds;
}

function buildClassMethodMapForFile(
  symbols: SymbolRow[],
  classSymbolIdByFqn: Map<string, string>,
  methodsByClassFqn: Map<string, Map<string, string>>,
): void {
  const classSymbols = symbols.filter((symbol) => symbol.kind === "class");
  const methodSymbols = symbols.filter(
    (symbol) => symbol.kind === "method" || symbol.kind === "function",
  );

  for (const classSymbol of classSymbols) {
    const classFqn = normalizePhpFqn(classSymbol.name);
    classSymbolIdByFqn.set(classFqn, classSymbol.symbolId);
  }

  for (const methodSymbol of methodSymbols) {
    const enclosingClass = classSymbols.find(
      (classSymbol) =>
        methodSymbol.rangeStartLine >= classSymbol.rangeStartLine &&
        methodSymbol.rangeEndLine <= classSymbol.rangeEndLine,
    );
    if (!enclosingClass) {
      continue;
    }

    const classFqn = normalizePhpFqn(enclosingClass.name);
    const methodMap =
      methodsByClassFqn.get(classFqn) ?? new Map<string, string>();
    methodMap.set(methodSymbol.name, methodSymbol.symbolId);
    methodsByClassFqn.set(classFqn, methodMap);
  }
}

async function buildPhpRepoIndex(
  repoId: string,
  cache?: Map<string, unknown>,
): Promise<PhpRepoIndex> {
  const cacheKey = `pass2-php:repo-index:${repoId}`;
  const cached = cache?.get(cacheKey);
  if (cached) {
    return cached as PhpRepoIndex;
  }

  const conn = await getLadybugConn();
  const repoFiles = await ladybugDb.getFilesByRepo(conn, repoId);
  const phpFiles = repoFiles.filter((file) => file.language === "php");
  const phpFileIds = new Set(phpFiles.map((file) => file.fileId));
  const fileById = new Map(phpFiles.map((file) => [file.fileId, file]));

  const namespaceByFilePath = new Map<string, string>();
  const symbolsByNamespace = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();
  const symbolsByRelPath = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();
  const classSymbolIdByFqn = new Map<string, string>();
  const methodsByClassFqn = new Map<string, Map<string, string>>();
  const classFqnByShortName = new Map<string, string[]>();

  const repoSymbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  const fileSymbols = new Map<string, SymbolRow[]>();
  for (const symbol of repoSymbols) {
    if (!phpFileIds.has(symbol.fileId)) {
      continue;
    }
    const existing = fileSymbols.get(symbol.fileId) ?? [];
    existing.push(symbol);
    fileSymbols.set(symbol.fileId, existing);
  }

  for (const [fileId, symbols] of fileSymbols) {
    const file = fileById.get(fileId);
    if (!file) {
      continue;
    }

    const namespace = inferPhpNamespaceFromSymbols(symbols);
    namespaceByFilePath.set(file.relPath, namespace);
    const bucket = symbolsByNamespace.get(namespace) ?? [];
    const relPathBucket = symbolsByRelPath.get(file.relPath) ?? [];
    for (const symbol of symbols) {
      const withPath = { ...symbol, relPath: file.relPath };
      bucket.push(withPath);
      relPathBucket.push(withPath);
    }
    symbolsByNamespace.set(namespace, bucket);
    symbolsByRelPath.set(file.relPath, relPathBucket);

    buildClassMethodMapForFile(symbols, classSymbolIdByFqn, methodsByClassFqn);
  }

  for (const classFqn of classSymbolIdByFqn.keys()) {
    const shortName = extractShortName(classFqn);
    const existing = classFqnByShortName.get(shortName) ?? [];
    if (!existing.includes(classFqn)) {
      existing.push(classFqn);
    }
    classFqnByShortName.set(shortName, existing);
  }

  const index: PhpRepoIndex = {
    namespaceByFilePath,
    symbolsByNamespace,
    symbolsByRelPath,
    classSymbolIdByFqn,
    methodsByClassFqn,
    classFqnByShortName,
  };
  cache?.set(cacheKey, index);
  return index;
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

async function resolvePhpUseImportMaps(params: {
  repoId: string;
  repoRoot: string;
  importerRelPath: string;
  imports: ExtractedImport[];
  extensions: string[];
  index: PhpRepoIndex;
}): Promise<{
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
  aliasToClassFqn: Map<string, string>;
}> {
  const { repoId, repoRoot, importerRelPath, imports, extensions, index } =
    params;
  const conn = await getLadybugConn();
  const importedNameToSymbolIds = new Map<string, string[]>();
  const namespaceImports = new Map<string, Map<string, string>>();
  const aliasToClassFqn = new Map<string, string>();

  for (const imp of imports) {
    if (!imp.specifier.includes("\\")) {
      continue;
    }

    const normalizedSpecifier = normalizePhpFqn(imp.specifier);
    const importedAliases =
      imp.imports.length > 0
        ? imp.imports
        : [extractShortName(normalizedSpecifier)];

    const resolvedPaths = await resolveImportCandidatePaths({
      language: "php",
      repoRoot,
      importerRelPath,
      specifier: imp.specifier,
      extensions,
    });

    const existingResolvedPaths = (
      await Promise.all(
        resolvedPaths.map((relPath) =>
          ladybugDb.getFileByRepoPath(conn, repoId, relPath),
        ),
      )
    ).flatMap((file) => (file ? [file.relPath] : []));

    const candidateClassFqns = new Set<string>();
    candidateClassFqns.add(normalizedSpecifier);
    for (const relPath of existingResolvedPaths) {
      const symbols = index.symbolsByRelPath.get(relPath) ?? [];
      for (const symbol of symbols) {
        if (symbol.kind === "class" || symbol.kind === "interface") {
          candidateClassFqns.add(normalizePhpFqn(symbol.name));
        }
      }
    }

    let selectedClassFqn: string | null = null;
    for (const classFqn of candidateClassFqns) {
      if (index.classSymbolIdByFqn.has(classFqn)) {
        selectedClassFqn = classFqn;
        break;
      }
    }

    if (!selectedClassFqn) {
      continue;
    }

    const classSymbolId = index.classSymbolIdByFqn.get(selectedClassFqn);
    if (!classSymbolId) {
      continue;
    }

    const classMethodMap =
      index.methodsByClassFqn.get(selectedClassFqn) ??
      new Map<string, string>();
    for (const alias of importedAliases) {
      aliasToClassFqn.set(alias, selectedClassFqn);
      const existing = importedNameToSymbolIds.get(alias) ?? [];
      if (!existing.includes(classSymbolId)) {
        existing.push(classSymbolId);
      }
      importedNameToSymbolIds.set(alias, existing);
      namespaceImports.set(alias, new Map(classMethodMap));
    }
  }

  return { importedNameToSymbolIds, namespaceImports, aliasToClassFqn };
}

function escapePhpReceiverRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slicePhpSourceText(
  content: string,
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
): string {
  const lines = content.split(/\r?\n/);
  const startIndex = Math.max(range.startLine - 1, 0);
  const endIndex = Math.min(range.endLine - 1, lines.length - 1);
  if (startIndex > endIndex || !lines[startIndex]) {
    return "";
  }

  const selected = lines.slice(startIndex, endIndex + 1);
  selected[0] = selected[0].slice(Math.max(range.startCol, 0));
  selected[selected.length - 1] = selected[selected.length - 1].slice(
    0,
    Math.max(range.endCol, 0),
  );
  return selected.join("\n");
}

function matchPhpImportedInstanceMethodCall(params: {
  identifier: string;
  callerSourceText?: string;
  aliasToClassFqn: Map<string, string>;
  index: PhpRepoIndex;
  localMethodsByClassFqn: Map<string, Map<string, string>>;
}): PhpResolvedCall | null {
  const {
    identifier,
    callerSourceText,
    aliasToClassFqn,
    index,
    localMethodsByClassFqn,
  } = params;
  if (!callerSourceText || !identifier.includes(".")) {
    return null;
  }

  const [receiverRaw, memberRaw] = identifier.split(".");
  const receiver = receiverRaw?.trim();
  const member = memberRaw?.trim();
  if (!receiver || !member || receiver === "$this") {
    return null;
  }

  const assignmentPattern = new RegExp(
    `${escapePhpReceiverRegExp(receiver)}\\s*=\\s*new\\s+([\\\\A-Za-z_][\\\\A-Za-z0-9_]*)\\s*\\(`,
    "g",
  );

  let lastConstructorName: string | null = null;
  for (const match of callerSourceText.matchAll(assignmentPattern)) {
    lastConstructorName = match[1] ?? null;
  }

  if (!lastConstructorName) {
    return null;
  }

  const normalizedConstructor = normalizePhpFqn(lastConstructorName);
  const importedAlias =
    normalizedConstructor.split("\\").at(-1)?.trim() ?? normalizedConstructor;
  const importedClassFqn =
    aliasToClassFqn.get(importedAlias) ??
    aliasToClassFqn.get(normalizedConstructor) ??
    normalizedConstructor;
  const importedMethodSymbol = tryResolveMethodOnClass(
    importedClassFqn,
    member,
    index,
    localMethodsByClassFqn,
  );
  if (!importedMethodSymbol) {
    return null;
  }

  return {
    symbolId: importedMethodSymbol,
    isResolved: true,
    confidence: 0.84,
    resolution: "receiver-imported-instance",
  };
}

function tryResolveMethodOnClass(
  classFqn: string,
  methodName: string,
  index: PhpRepoIndex,
  localMethodsByClassFqn: Map<string, Map<string, string>>,
): string | null {
  const localClassMethods = localMethodsByClassFqn.get(classFqn);
  if (localClassMethods?.has(methodName)) {
    return localClassMethods.get(methodName) ?? null;
  }

  const repoClassMethods = index.methodsByClassFqn.get(classFqn);
  if (repoClassMethods?.has(methodName)) {
    return repoClassMethods.get(methodName) ?? null;
  }

  return null;
}

async function tryResolvePsr4AutoloadCall(params: {
  repoRoot: string;
  importerRelPath: string;
  extensions: string[];
  classToken: string;
  methodName: string;
  currentNamespace: string;
  index: PhpRepoIndex;
  localMethodsByClassFqn: Map<string, Map<string, string>>;
  cache?: Map<string, unknown>;
}): Promise<string | null> {
  const {
    repoRoot,
    importerRelPath,
    extensions,
    classToken,
    methodName,
    currentNamespace,
    index,
    localMethodsByClassFqn,
    cache,
  } = params;

  const classCandidates: string[] = [];
  const normalizedClassToken = normalizePhpFqn(classToken);
  if (normalizedClassToken.includes("\\")) {
    classCandidates.push(normalizedClassToken);
  } else {
    if (currentNamespace) {
      classCandidates.push(`${currentNamespace}\\${normalizedClassToken}`);
    }
    classCandidates.push(normalizedClassToken);
  }

  for (const classCandidate of classCandidates) {
    const directSymbol = tryResolveMethodOnClass(
      classCandidate,
      methodName,
      index,
      localMethodsByClassFqn,
    );
    if (directSymbol) {
      return directSymbol;
    }

    const cacheKey = `pass2-php:psr4-candidate:${importerRelPath}:${classCandidate}`;
    let resolvedPaths = cache?.get(cacheKey) as string[] | undefined;
    if (!resolvedPaths) {
      resolvedPaths = await resolveImportCandidatePaths({
        language: "php",
        repoRoot,
        importerRelPath,
        specifier: classCandidate,
        extensions,
      });
      cache?.set(cacheKey, resolvedPaths);
    }

    for (const relPath of resolvedPaths) {
      const normalizedPath = normalizePath(relPath);
      const targetSymbols = index.symbolsByRelPath.get(normalizedPath) ?? [];
      const classSymbols = targetSymbols.filter(
        (symbol) => symbol.kind === "class" || symbol.kind === "interface",
      );
      if (classSymbols.length === 0) {
        continue;
      }

      let classFqn = normalizePhpFqn(classSymbols[0].name);
      if (classSymbols.length > 1) {
        const exact = classSymbols.find(
          (symbol) => normalizePhpFqn(symbol.name) === classCandidate,
        );
        if (exact) {
          classFqn = normalizePhpFqn(exact.name);
        }
      }

      const symbolId = tryResolveMethodOnClass(
        classFqn,
        methodName,
        index,
        localMethodsByClassFqn,
      );
      if (symbolId) {
        return symbolId;
      }
    }
  }

  return null;
}

async function resolvePhpPass2CallTarget(params: {
  call: ExtractedCall;
  callerSymbolId: string;
  currentNamespace: string;
  nodeIdToSymbolId: Map<string, string>;
  localNameToSymbolIds: Map<string, string[]>;
  sameNamespaceNameToSymbolIds: Map<string, string[]>;
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
  aliasToClassFqn: Map<string, string>;
  callerClassBySymbolId: Map<string, string>;
  localMethodsByClassFqn: Map<string, Map<string, string>>;
  index: PhpRepoIndex;
  repoRoot: string;
  importerRelPath: string;
  extensions: string[];
  cache?: Map<string, unknown>;
  callerSourceText?: string;
  globalNameToSymbolIds?: Map<string, string[]>;
}): Promise<PhpResolvedCall | null> {
  const {
    call,
    callerSymbolId,
    currentNamespace,
    nodeIdToSymbolId,
    localNameToSymbolIds,
    sameNamespaceNameToSymbolIds,
    importedNameToSymbolIds,
    namespaceImports,
    aliasToClassFqn,
    callerClassBySymbolId,
    localMethodsByClassFqn,
    index,
    repoRoot,
    importerRelPath,
    extensions,
    cache,
    callerSourceText,
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

  if (identifier.includes("::")) {
    const [classTokenRaw, methodNameRaw] = identifier.split("::");
    const classToken = classTokenRaw.trim();
    const methodName = methodNameRaw.trim();

    if (classToken && methodName) {
      const importedClassFqn = aliasToClassFqn.get(classToken);
      if (importedClassFqn) {
        const importedMethodSymbol = tryResolveMethodOnClass(
          importedClassFqn,
          methodName,
          index,
          localMethodsByClassFqn,
        );
        if (importedMethodSymbol) {
          return {
            symbolId: importedMethodSymbol,
            isResolved: true,
            confidence: 0.9,
            resolution: "use-import",
          };
        }
      }

      const namespaceImport = namespaceImports.get(classToken);
      if (namespaceImport?.has(methodName)) {
        return {
          symbolId: namespaceImport.get(methodName) ?? null,
          isResolved: true,
          confidence: 0.9,
          resolution: "use-import",
        };
      }

      const psr4MethodSymbol = await tryResolvePsr4AutoloadCall({
        repoRoot,
        importerRelPath,
        extensions,
        classToken,
        methodName,
        currentNamespace,
        index,
        localMethodsByClassFqn,
        cache,
      });
      if (psr4MethodSymbol) {
        return {
          symbolId: psr4MethodSymbol,
          isResolved: true,
          confidence: 0.88,
          resolution: "psr4-autoload",
        };
      }

      if (
        classToken === "self" ||
        classToken === "static" ||
        classToken === "parent"
      ) {
        const callerClass = callerClassBySymbolId.get(callerSymbolId);
        if (callerClass) {
          const localStaticMethod = tryResolveMethodOnClass(
            callerClass,
            methodName,
            index,
            localMethodsByClassFqn,
          );
          if (localStaticMethod) {
            return {
              symbolId: localStaticMethod,
              isResolved: true,
              confidence: 0.85,
              resolution: "static-call",
            };
          }
        }
      }

      const directClassFqn = normalizePhpFqn(classToken);
      const directStaticMethod = tryResolveMethodOnClass(
        directClassFqn,
        methodName,
        index,
        localMethodsByClassFqn,
      );
      if (directStaticMethod) {
        return {
          symbolId: directStaticMethod,
          isResolved: true,
          confidence: 0.85,
          resolution: "static-call",
        };
      }

      const shortNameCandidates =
        index.classFqnByShortName.get(classToken) ?? [];
      if (shortNameCandidates.length === 1) {
        const shortStaticMethod = tryResolveMethodOnClass(
          shortNameCandidates[0],
          methodName,
          index,
          localMethodsByClassFqn,
        );
        if (shortStaticMethod) {
          return {
            symbolId: shortStaticMethod,
            isResolved: true,
            confidence: 0.85,
            resolution: "static-call",
          };
        }
      }
    }
  }

  if (identifier.includes(".")) {
    const [receiverRaw, memberRaw] = identifier.split(".");
    const receiver = receiverRaw.trim();
    const member = memberRaw.trim();

    if (receiver === "$this") {
      const callerClass = callerClassBySymbolId.get(callerSymbolId);
      if (callerClass) {
        const localMethod = tryResolveMethodOnClass(
          callerClass,
          member,
          index,
          localMethodsByClassFqn,
        );
        if (localMethod) {
          return {
            symbolId: localMethod,
            isResolved: true,
            confidence: 0.85,
            resolution: "receiver-this",
          };
        }
      }
    }

    const importedInstanceMethodCall = matchPhpImportedInstanceMethodCall({
      identifier,
      callerSourceText,
      aliasToClassFqn,
      index,
      localMethodsByClassFqn,
    });
    if (importedInstanceMethodCall) {
      return importedInstanceMethodCall;
    }

    const namespaceImport = namespaceImports.get(receiver);
    if (namespaceImport?.has(member)) {
      return {
        symbolId: namespaceImport.get(member) ?? null,
        isResolved: true,
        confidence: 0.9,
        resolution: "use-import",
      };
    }
  }

  const importedCandidates = importedNameToSymbolIds.get(identifier);
  if (importedCandidates && importedCandidates.length === 1) {
    return {
      symbolId: importedCandidates[0],
      isResolved: true,
      confidence: 0.9,
      resolution: "use-import",
    };
  }

  const localCandidates = localNameToSymbolIds.get(identifier);
  if (localCandidates && localCandidates.length === 1) {
    return {
      symbolId: localCandidates[0],
      isResolved: true,
      confidence: 0.93,
      resolution: "same-file",
    };
  }

  const sameNamespaceCandidates = sameNamespaceNameToSymbolIds.get(identifier);
  if (sameNamespaceCandidates && sameNamespaceCandidates.length === 1) {
    return {
      symbolId: sameNamespaceCandidates[0],
      isResolved: true,
      confidence: 0.82,
      resolution: "same-namespace",
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
      (localCandidates?.length ?? 0) +
      (sameNamespaceCandidates?.length ?? 0) +
      (globalCandidates?.length ?? 0),
  };
}

async function resolvePhpCallEdgesPass2(params: {
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
        `File disappeared before PHP pass2 resolution: ${fileMeta.path}`,
        { code },
      );
      return 0;
    }
    throw readError;
  }

  const adapter = getAdapterForExtension(".php");
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
  } finally {
    (tree as unknown as { delete?: () => void }).delete?.();
  }

  const fileRecord = await ladybugDb.getFileByRepoPath(
    conn,
    repoId,
    fileMeta.path,
  );
  if (!fileRecord) {
    return 0;
  }

  const existingSymbols = await ladybugDb.getSymbolsByFile(
    conn,
    fileRecord.fileId,
  );
  if (existingSymbols.length === 0) {
    return 0;
  }

  const filteredSymbolDetails = mapExtractedSymbolsToExisting(
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

  const index = await buildPhpRepoIndex(repoId, cache);
  const { classByMemberSymbolId, localMethodsByClassFqn } =
    createLocalClassContext(filteredSymbolDetails);

  const nodeIdToSymbolId = createNodeIdToSymbolId(filteredSymbolDetails);
  const localNameToSymbolIds = createLocalNameIndex(filteredSymbolDetails);
  const currentNamespace =
    index.namespaceByFilePath.get(fileMeta.path) ||
    inferPhpNamespaceFromSymbols(existingSymbols);
  const sameNamespaceSymbols =
    index.symbolsByNamespace.get(currentNamespace) ?? [];
  const sameNamespaceNameToSymbolIds = createSameNamespaceNameIndex(
    fileMeta.path,
    sameNamespaceSymbols,
  );

  const importResolution = await resolveImportTargets(
    repoId,
    repoRoot,
    fileMeta.path,
    imports,
    [...adapter.fileExtensions],
    "php",
    content,
  );
  const phpImportMaps = await resolvePhpUseImportMaps({
    repoId,
    repoRoot,
    importerRelPath: fileMeta.path,
    imports,
    extensions: [...adapter.fileExtensions],
    index,
  });
  const importedNameToSymbolIds = mergeImportedNameMaps(
    importResolution.importedNameToSymbolIds,
    phpImportMaps.importedNameToSymbolIds,
  );
  const namespaceImports = mergeNamespaceImports(
    importResolution.namespaceImports,
    phpImportMaps.namespaceImports,
  );

  const now = new Date().toISOString();
  const edgesToInsert: ladybugDb.EdgeRow[] = [];
  let createdEdges = 0;

  for (const detail of filteredSymbolDetails) {
    const callerSourceText = slicePhpSourceText(content, detail.extractedSymbol.range);
    for (const call of calls) {
      const callerNodeId =
        call.callerNodeId ??
        findEnclosingSymbolByRange(call.range, filteredSymbolDetails);
      if (callerNodeId !== detail.extractedSymbol.nodeId) {
        continue;
      }

      const resolved = await resolvePhpPass2CallTarget({
        call,
        callerSymbolId: detail.symbolId,
        currentNamespace,
        nodeIdToSymbolId,
        localNameToSymbolIds,
        sameNamespaceNameToSymbolIds,
        importedNameToSymbolIds,
        namespaceImports,
        aliasToClassFqn: phpImportMaps.aliasToClassFqn,
        callerClassBySymbolId: classByMemberSymbolId,
        localMethodsByClassFqn,
        index,
        repoRoot,
        importerRelPath: fileMeta.path,
        extensions: [...adapter.fileExtensions],
        cache,
        callerSourceText,
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
          resolverId: "pass2-php",
          resolutionPhase: "pass2",
          provenance: `php-call:${call.calleeIdentifier}`,
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
          resolverId: "pass2-php",
          resolutionPhase: "pass2",
          provenance: `unresolved-php-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
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

export class PhpPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-php";

  supports(target: Pass2Target): boolean {
    return (
      target.language === "php" && PHP_PASS2_EXTENSIONS.has(target.extension)
    );
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    if (!target.repoId) {
      throw new Error("PhpPass2Resolver requires target.repoId");
    }

    try {
      const edgesCreated = await resolvePhpCallEdgesPass2({
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
        `PHP pass2 resolution failed for ${target.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { edgesCreated: 0 };
    }
  }
}
