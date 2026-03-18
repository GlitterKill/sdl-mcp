import { dirname, join } from "path";

import { getLadybugConn, withWriteConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import type { SymbolRow } from "../../../db/ladybug-queries.js";
import type { SymbolKind } from "../../../db/schema.js";
import { readFileAsync } from "../../../util/asyncFs.js";
import { logger } from "../../../util/logger.js";
import { normalizePath } from "../../../util/paths.js";
import { getAdapterForExtension } from "../../adapter/registry.js";
import type { FileMetadata } from "../../fileScanner.js";
import { resolveImportTargets } from "../../edge-builder/import-resolution.js";
import { findEnclosingSymbolByRange } from "../../edge-builder/pass2.js";
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

type PythonResolvedCall = {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  resolution: string;
  targetName?: string;
  candidateCount?: number;
};

type PythonModuleIndex = {
  directoryByFilePath: Map<string, string>;
  symbolsByDirectory: Map<string, Array<SymbolRow & { relPath: string }>>;
  methodsByClassSymbolId: Map<string, Map<string, string[]>>;
};

const PYTHON_PASS2_EXTENSIONS = new Set([".py"]);

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

function isSymbolRowWithin(inner: SymbolRow, outer: SymbolRow): boolean {
  if (
    inner.rangeStartLine < outer.rangeStartLine ||
    inner.rangeEndLine > outer.rangeEndLine
  ) {
    return false;
  }
  if (
    inner.rangeStartLine === outer.rangeStartLine &&
    inner.rangeStartCol < outer.rangeStartCol
  ) {
    return false;
  }
  if (
    inner.rangeEndLine === outer.rangeEndLine &&
    inner.rangeEndCol > outer.rangeEndCol
  ) {
    return false;
  }
  return true;
}

function buildLocalClassMethodIndex(
  filteredSymbolDetails: FilteredSymbolDetail[],
): Map<string, string[]> {
  const classSymbols = filteredSymbolDetails.filter(
    (detail) => detail.extractedSymbol.kind === "class",
  );
  const methodNameToSymbolIds = new Map<string, string[]>();

  for (const detail of filteredSymbolDetails) {
    if (detail.extractedSymbol.kind !== "function" && detail.extractedSymbol.kind !== "method") {
      continue;
    }

    const isMethodInClass = classSymbols.some((classDetail) =>
      isRangeWithin(
        detail.extractedSymbol.range,
        classDetail.extractedSymbol.range,
      ),
    );
    if (!isMethodInClass) {
      continue;
    }

    // For methods with dotted names (e.g. "ClassName.methodName"),
    // use only the bare method name as the map key.
    const rawName = detail.extractedSymbol.name;
    const methodName = rawName.includes(".")
      ? rawName.slice(rawName.lastIndexOf(".") + 1)
      : rawName;
    const existing =
      methodNameToSymbolIds.get(methodName) ?? [];
    existing.push(detail.symbolId);
    methodNameToSymbolIds.set(methodName, existing);
  }

  return methodNameToSymbolIds;
}

function buildPythonClassMethodIndex(
  symbols: SymbolRow[],
): Map<string, Map<string, string[]>> {
  const methodsByClassSymbolId = new Map<string, Map<string, string[]>>();
  const classesByFileId = new Map<string, SymbolRow[]>();
  const functionsByFileId = new Map<string, SymbolRow[]>();

  for (const symbol of symbols) {
    if (symbol.kind === "class") {
      const existing = classesByFileId.get(symbol.fileId) ?? [];
      existing.push(symbol);
      classesByFileId.set(symbol.fileId, existing);
      continue;
    }
    if (symbol.kind === "function" || symbol.kind === "method") {
      const existing = functionsByFileId.get(symbol.fileId) ?? [];
      existing.push(symbol);
      functionsByFileId.set(symbol.fileId, existing);
    }
  }

  for (const [fileId, functions] of functionsByFileId) {
    const classes = classesByFileId.get(fileId) ?? [];
    if (classes.length === 0) {
      continue;
    }

    for (const fn of functions) {
      let ownerClass: SymbolRow | null = null;
      let ownerSize = Number.MAX_SAFE_INTEGER;

      for (const clazz of classes) {
        if (!isSymbolRowWithin(fn, clazz)) {
          continue;
        }
        const size =
          (clazz.rangeEndLine - clazz.rangeStartLine) * 10_000 +
          (clazz.rangeEndCol - clazz.rangeStartCol);
        if (size < ownerSize) {
          ownerClass = clazz;
          ownerSize = size;
        }
      }

      if (!ownerClass) {
        continue;
      }

      const methods =
        methodsByClassSymbolId.get(ownerClass.symbolId) ??
        new Map<string, string[]>();
      // For methods with dotted names (e.g. "ClassName.methodName"),
      // use only the bare method name as the map key so that
      // instance method resolution can look up by bare member name.
      const methodName = fn.name.includes(".")
        ? fn.name.slice(fn.name.lastIndexOf(".") + 1)
        : fn.name;
      const existing = methods.get(methodName) ?? [];
      existing.push(fn.symbolId);
      methods.set(methodName, existing);
      methodsByClassSymbolId.set(ownerClass.symbolId, methods);
    }
  }

  return methodsByClassSymbolId;
}

async function buildPythonModuleIndex(
  repoId: string,
  cache?: Map<string, unknown>,
): Promise<PythonModuleIndex> {
  const cacheKey = `pass2-python:module-index:${repoId}`;
  const cached = cache?.get(cacheKey);
  if (cached) {
    return cached as PythonModuleIndex;
  }

  const conn = await getLadybugConn();
  const repoFiles = await ladybugDb.getFilesByRepo(conn, repoId);
  const pythonFiles = repoFiles.filter((file) => file.language === "python");
  const pythonFileIds = new Set(pythonFiles.map((file) => file.fileId));
  const fileById = new Map(pythonFiles.map((file) => [file.fileId, file]));
  const directoryByFilePath = new Map<string, string>();
  const symbolsByDirectory = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();
  const repoSymbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  const pythonSymbols = repoSymbols.filter((symbol) =>
    pythonFileIds.has(symbol.fileId),
  );
  const methodsByClassSymbolId = buildPythonClassMethodIndex(pythonSymbols);

  for (const file of pythonFiles) {
    directoryByFilePath.set(file.relPath, normalizePath(dirname(file.relPath)));
  }

  for (const symbol of pythonSymbols) {
    const file = fileById.get(symbol.fileId);
    if (!file) {
      continue;
    }
    const directory = directoryByFilePath.get(file.relPath);
    if (!directory) {
      continue;
    }
    const bucket = symbolsByDirectory.get(directory) ?? [];
    bucket.push({
      ...symbol,
      relPath: file.relPath,
    });
    symbolsByDirectory.set(directory, bucket);
  }

  const moduleIndex = {
    directoryByFilePath,
    symbolsByDirectory,
    methodsByClassSymbolId,
  };
  cache?.set(cacheKey, moduleIndex);
  return moduleIndex;
}

function buildSameModuleFunctionIndex(
  currentFilePath: string,
  sameDirectorySymbols: Array<SymbolRow & { relPath: string }>,
): Map<string, string[]> {
  const sameModuleNameToSymbolIds = new Map<string, string[]>();
  for (const symbol of sameDirectorySymbols) {
    if (symbol.relPath === currentFilePath) {
      continue;
    }
    if (symbol.kind !== "function") {
      continue;
    }
    const existing = sameModuleNameToSymbolIds.get(symbol.name) ?? [];
    existing.push(symbol.symbolId);
    sameModuleNameToSymbolIds.set(symbol.name, existing);
  }
  return sameModuleNameToSymbolIds;
}

function getTextBeforeCallWithinCaller(params: {
  content: string;
  callerRange: ExtractedSymbol["range"];
  callRange: ExtractedCall["range"];
}): string {
  const { content, callerRange, callRange } = params;
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(callerRange.startLine - 1, 0);
  const endLine = Math.max(callRange.startLine - 1, 0);
  const segments = lines.slice(startLine, endLine);

  if (endLine < lines.length) {
    const currentLine = lines[endLine] ?? "";
    segments.push(currentLine.slice(0, Math.max(callRange.startCol, 0)));
  }

  return segments.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveImportedInstanceMethodCall(params: {
  identifier: string;
  callRange: ExtractedCall["range"];
  callerRange: ExtractedSymbol["range"];
  content: string;
  importedNameToSymbolIds: Map<string, string[]>;
  methodsByImportedClassSymbolId: Map<string, Map<string, string[]>>;
}): PythonResolvedCall | null {
  const {
    identifier,
    callRange,
    callerRange,
    content,
    importedNameToSymbolIds,
    methodsByImportedClassSymbolId,
  } = params;
  if (!identifier.includes(".")) {
    return null;
  }

  const parts = identifier.split(".");
  const receiver = parts[0];
  const member = parts[parts.length - 1];
  if (!receiver || !member) {
    return null;
  }

  const priorCallerText = getTextBeforeCallWithinCaller({
    content,
    callerRange,
    callRange,
  });
  const assignmentPattern = new RegExp(
    `(^|\\n)\\s*${escapeRegExp(receiver)}\\s*=\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`,
    "g",
  );

  let constructorName: string | null = null;
  for (const match of priorCallerText.matchAll(assignmentPattern)) {
    constructorName = match[2] ?? null;
  }
  if (!constructorName) {
    return null;
  }

  const classCandidates = importedNameToSymbolIds.get(constructorName);
  if (!classCandidates || classCandidates.length !== 1) {
    return null;
  }

  const methodCandidates = methodsByImportedClassSymbolId
    .get(classCandidates[0])
    ?.get(member);
  if (!methodCandidates || methodCandidates.length !== 1) {
    return null;
  }

  return {
    symbolId: methodCandidates[0],
    isResolved: true,
    confidence: 0.84,
    resolution: "receiver-imported-instance",
  };
}

async function resolvePythonImportMaps(params: {
  conn: import("kuzu").Connection;
  repoId: string;
  repoRoot: string;
  importerRelPath: string;
  imports: ExtractedImport[];
  extensions: string[];
}): Promise<{
  importedNameToSymbolIds: Map<string, string[]>;
  methodsByImportedClassSymbolId: Map<string, Map<string, string[]>>;
  namespaceImports: Map<string, Map<string, string>>;
}> {
  const { conn, repoId, repoRoot, importerRelPath, imports, extensions } =
    params;
  const importedNameToSymbolIds = new Map<string, string[]>();
  const methodsByImportedClassSymbolId = new Map<string, Map<string, string[]>>();
  const namespaceImports = new Map<string, Map<string, string>>();

  for (const imp of imports) {
    const resolvedPaths = await resolveImportCandidatePaths({
      language: "python",
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
    const importedClassMethods = buildPythonClassMethodIndex(targetSymbols);
    for (const [classSymbolId, methods] of importedClassMethods) {
      const existing =
        methodsByImportedClassSymbolId.get(classSymbolId) ??
        new Map<string, string[]>();
      for (const [methodName, symbolIds] of methods) {
        const merged = existing.get(methodName) ?? [];
        for (const symbolId of symbolIds) {
          if (!merged.includes(symbolId)) {
            merged.push(symbolId);
          }
        }
        existing.set(methodName, merged);
      }
      methodsByImportedClassSymbolId.set(classSymbolId, existing);
    }

    const importedNames = new Set<string>();
    if (imp.defaultImport) {
      importedNames.add(imp.defaultImport);
    }
    for (const name of imp.imports) {
      importedNames.add(name);
    }

    for (const name of importedNames) {
      if (name.startsWith("*")) {
        continue;
      }
      let match = targetSymbols.find((symbol) => symbol.name === name);
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
  }

  return {
    importedNameToSymbolIds,
    methodsByImportedClassSymbolId,
    namespaceImports,
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

function resolvePythonPass2CallTarget(params: {
  call: ExtractedCall;
  callerRange: ExtractedSymbol["range"];
  content: string;
  nodeIdToSymbolId: Map<string, string>;
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
  localClassMethodNameToSymbolIds: Map<string, string[]>;
  sameModuleNameToSymbolIds: Map<string, string[]>;
  methodsByImportedClassSymbolId: Map<string, Map<string, string[]>>;
  globalNameToSymbolIds?: Map<string, string[]>;
}): PythonResolvedCall | null {
  const {
    call,
    callerRange,
    content,
    nodeIdToSymbolId,
    importedNameToSymbolIds,
    namespaceImports,
    localClassMethodNameToSymbolIds,
    sameModuleNameToSymbolIds,
    methodsByImportedClassSymbolId,
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

    const namespace = namespaceImports.get(prefix);
    if (namespace?.has(member)) {
      return {
        symbolId: namespace.get(member) ?? null,
        isResolved: true,
        confidence: 0.9,
        resolution: "namespace-import",
      };
    }

    if (prefix === "self" || prefix === "cls") {
      const classMethodCandidates = localClassMethodNameToSymbolIds.get(member);
      if (classMethodCandidates && classMethodCandidates.length === 1) {
        return {
          symbolId: classMethodCandidates[0],
          isResolved: true,
          confidence: 0.85,
          resolution: "receiver-self",
        };
      }
    }

    const importedInstanceMethodCall = resolveImportedInstanceMethodCall({
      identifier,
      callRange: call.range,
      callerRange,
      content,
      importedNameToSymbolIds,
      methodsByImportedClassSymbolId,
    });
    if (importedInstanceMethodCall) {
      return importedInstanceMethodCall;
    }
  }

  const sameModuleCandidates = sameModuleNameToSymbolIds.get(identifier);
  if (sameModuleCandidates && sameModuleCandidates.length === 1) {
    return {
      symbolId: sameModuleCandidates[0],
      isResolved: true,
      confidence: 0.82,
      resolution: "same-module",
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
      (sameModuleCandidates?.length ?? 0) +
      (globalCandidates?.length ?? 0),
  };
}

async function resolvePythonCallEdgesPass2(params: {
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
        `File disappeared before Python pass2 resolution: ${fileMeta.path}`,
        { code },
      );
      return 0;
    }
    throw readError;
  }

  const adapter = getAdapterForExtension(".py");
  if (!adapter) {
    return 0;
  }

  const tree = adapter.parse(content, filePath);
  if (!tree) {
    return 0;
  }

  const extractedSymbols = adapter.extractSymbols(
    tree,
    content,
    filePath,
  ) as ExtractedSymbol[];
  const calls = adapter.extractCalls(
    tree,
    content,
    filePath,
    extractedSymbols as never,
  ) as ExtractedCall[];
  const imports = adapter.extractImports(tree, content, filePath);

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

  const nodeIdToSymbolId = createNodeIdToSymbolId(filteredSymbolDetails);
  const localClassMethodNameToSymbolIds = buildLocalClassMethodIndex(
    filteredSymbolDetails,
  );
  const importResolution = await resolveImportTargets(
    repoId,
    repoRoot,
    fileMeta.path,
    imports,
    [...adapter.fileExtensions],
    "python",
    content,
  );
  const pythonImportMaps = await resolvePythonImportMaps({
    conn,
    repoId,
    repoRoot,
    importerRelPath: fileMeta.path,
    imports,
    extensions: [...adapter.fileExtensions],
  });
  const importedNameToSymbolIds = mergeImportedNameMaps(
    importResolution.importedNameToSymbolIds,
    pythonImportMaps.importedNameToSymbolIds,
  );
  const namespaceImports = mergeNamespaceImports(
    importResolution.namespaceImports,
    pythonImportMaps.namespaceImports,
  );

  const moduleIndex = await buildPythonModuleIndex(repoId, cache);
  const currentDirectory = moduleIndex.directoryByFilePath.get(fileMeta.path);
  const sameDirectorySymbols = currentDirectory
    ? (moduleIndex.symbolsByDirectory.get(currentDirectory) ?? [])
    : [];
  const sameModuleNameToSymbolIds = buildSameModuleFunctionIndex(
    fileMeta.path,
    sameDirectorySymbols,
  );

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

      const resolved = resolvePythonPass2CallTarget({
        call,
        callerRange: detail.extractedSymbol.range,
        content,
        nodeIdToSymbolId,
        importedNameToSymbolIds,
        namespaceImports,
        localClassMethodNameToSymbolIds,
        sameModuleNameToSymbolIds,
        methodsByImportedClassSymbolId:
          pythonImportMaps.methodsByImportedClassSymbolId,
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
          resolverId: "pass2-python",
          resolutionPhase: "pass2",
          provenance: `python-call:${call.calleeIdentifier}`,
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
          resolverId: "pass2-python",
          resolutionPhase: "pass2",
          provenance: `unresolved-python-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
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

export class PythonPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-python";

  supports(target: Pass2Target): boolean {
    return (
      target.language === "python" &&
      PYTHON_PASS2_EXTENSIONS.has(target.extension)
    );
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    if (!target.repoId) {
      throw new Error("PythonPass2Resolver requires target.repoId");
    }

    try {
      const edgesCreated = await resolvePythonCallEdgesPass2({
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
        `Python pass2 resolution failed for ${target.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { edgesCreated: 0 };
    }
  }
}
