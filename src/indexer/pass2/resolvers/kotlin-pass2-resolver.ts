import { dirname, extname, join } from "path";

import type { SymbolKind } from "../../../db/schema.js";
import { getLadybugConn, withWriteConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import type { SymbolRow } from "../../../db/ladybug-queries.js";
import { readFileAsync } from "../../../util/asyncFs.js";
import { logger } from "../../../util/logger.js";
import { normalizePath } from "../../../util/paths.js";
import { getAdapterForExtension } from "../../adapter/registry.js";
import type { FileMetadata } from "../../fileScanner.js";
import { resolveImportTargets } from "../../edge-builder/import-resolution.js";
import { findEnclosingSymbolByRange } from "../../edge-builder/pass2.js";

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

type KotlinResolvedCall = {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  resolution: string;
  targetName?: string;
  candidateCount?: number;
};

type KotlinPackageIndex = {
  packageByFilePath: Map<string, string>;
  symbolsByPackage: Map<string, Array<SymbolRow & { relPath: string }>>;
  directoryByFilePath: Map<string, string>;
  symbolsByDirectory: Map<string, Array<SymbolRow & { relPath: string }>>;
  classNameToSymbolIds: Map<string, string[]>;
  methodsByClassSymbolId: Map<string, Map<string, string[]>>;
};

const KOTLIN_PASS2_EXTENSIONS = new Set([".kt", ".kts"]);

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
  inner: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
  outer: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
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

function buildLocalClassMethodIndex(
  filteredSymbolDetails: FilteredSymbolDetail[],
): Map<string, string[]> {
  const classSymbols = filteredSymbolDetails.filter(
    (detail) => detail.extractedSymbol.kind === "class",
  );
  const methodNameToSymbolIds = new Map<string, string[]>();

  for (const detail of filteredSymbolDetails) {
    if (detail.extractedSymbol.kind !== "function") {
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

    const existing =
      methodNameToSymbolIds.get(detail.extractedSymbol.name) ?? [];
    existing.push(detail.symbolId);
    methodNameToSymbolIds.set(detail.extractedSymbol.name, existing);
  }

  return methodNameToSymbolIds;
}

async function buildKotlinPackageIndex(
  repoId: string,
  cache?: Map<string, unknown>,
): Promise<KotlinPackageIndex> {
  const cacheKey = `pass2-kotlin:package-index:${repoId}`;
  const cached = cache?.get(cacheKey);
  if (cached) {
    return cached as KotlinPackageIndex;
  }

  const conn = await getLadybugConn();
  const repoFiles = await ladybugDb.getFilesByRepo(conn, repoId);
  const kotlinFiles = repoFiles.filter((file) =>
    KOTLIN_PASS2_EXTENSIONS.has(extname(file.relPath)),
  );
  const kotlinFileIds = new Set(kotlinFiles.map((file) => file.fileId));
  const fileById = new Map(kotlinFiles.map((file) => [file.fileId, file]));
  const packageByFilePath = new Map<string, string>();
  const directoryByFilePath = new Map<string, string>();
  const symbolsByPackage = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();
  const symbolsByDirectory = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();
  const classNameToSymbolIds = new Map<string, string[]>();
  const symbolsByRelPath = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();

  for (const file of kotlinFiles) {
    packageByFilePath.set(file.relPath, normalizePath(dirname(file.relPath)));
    directoryByFilePath.set(file.relPath, normalizePath(dirname(file.relPath)));
  }

  const repoSymbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  for (const symbol of repoSymbols) {
    if (!kotlinFileIds.has(symbol.fileId)) {
      continue;
    }
    const file = fileById.get(symbol.fileId);
    if (!file) {
      continue;
    }
    if (symbol.kind === "module") {
      packageByFilePath.set(file.relPath, symbol.name);
    }
  }

  for (const symbol of repoSymbols) {
    if (!kotlinFileIds.has(symbol.fileId)) {
      continue;
    }
    const file = fileById.get(symbol.fileId);
    if (!file) {
      continue;
    }
    if (symbol.kind === "class") {
      const existing = classNameToSymbolIds.get(symbol.name) ?? [];
      existing.push(symbol.symbolId);
      classNameToSymbolIds.set(symbol.name, existing);
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

    const relPathBucket = symbolsByRelPath.get(file.relPath) ?? [];
    relPathBucket.push({
      ...symbol,
      relPath: file.relPath,
    });
    symbolsByRelPath.set(file.relPath, relPathBucket);

    const directory = directoryByFilePath.get(file.relPath);
    if (directory) {
      const directoryBucket = symbolsByDirectory.get(directory) ?? [];
      directoryBucket.push({
        ...symbol,
        relPath: file.relPath,
      });
      symbolsByDirectory.set(directory, directoryBucket);
    }
  }

  const methodsByClassSymbolId = new Map<string, Map<string, string[]>>();
  for (const symbolsInFile of symbolsByRelPath.values()) {
    const classSymbols = symbolsInFile.filter((symbol) => symbol.kind === "class");
    if (classSymbols.length === 0) {
      continue;
    }

    for (const fn of symbolsInFile) {
      if (fn.kind !== "method" && fn.kind !== "function") {
        continue;
      }

      const ownerClass = classSymbols.find((klass) => {
        const startsInside =
          fn.rangeStartLine > klass.rangeStartLine ||
          (fn.rangeStartLine === klass.rangeStartLine &&
            fn.rangeStartCol >= klass.rangeStartCol);
        const endsInside =
          fn.rangeEndLine < klass.rangeEndLine ||
          (fn.rangeEndLine === klass.rangeEndLine &&
            fn.rangeEndCol <= klass.rangeEndCol);
        return startsInside && endsInside;
      });
      if (!ownerClass) {
        continue;
      }

      const methodMap =
        methodsByClassSymbolId.get(ownerClass.symbolId) ??
        new Map<string, string[]>();
      const existing = methodMap.get(fn.name) ?? [];
      existing.push(fn.symbolId);
      methodMap.set(fn.name, existing);
      methodsByClassSymbolId.set(ownerClass.symbolId, methodMap);
    }
  }

  const packageIndex = {
    packageByFilePath,
    symbolsByPackage,
    directoryByFilePath,
    symbolsByDirectory,
    classNameToSymbolIds,
    methodsByClassSymbolId,
  };
  cache?.set(cacheKey, packageIndex);
  return packageIndex;
}

function buildSamePackageCallableIndex(
  currentFilePath: string,
  samePackageSymbols: Array<SymbolRow & { relPath: string }>,
): Map<string, string[]> {
  const samePackageNameToSymbolIds = new Map<string, string[]>();

  for (const symbol of samePackageSymbols) {
    if (symbol.relPath === currentFilePath) {
      continue;
    }
    if (
      symbol.kind !== "function" &&
      symbol.kind !== "class" &&
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

function buildCompanionObjectMethodIndexes(
  samePackageSymbols: Array<SymbolRow & { relPath: string }>,
): {
  classQualifiedMethodNameToSymbolIds: Map<string, string[]>;
  companionMemberNameToSymbolIds: Map<string, string[]>;
} {
  const classQualifiedMethodNameToSymbolIds = new Map<string, string[]>();
  const companionMemberNameToSymbolIds = new Map<string, string[]>();

  const symbolsByRelPath = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();
  for (const symbol of samePackageSymbols) {
    const bucket = symbolsByRelPath.get(symbol.relPath) ?? [];
    bucket.push(symbol);
    symbolsByRelPath.set(symbol.relPath, bucket);
  }

  for (const symbolsInFile of symbolsByRelPath.values()) {
    const classes = symbolsInFile.filter((symbol) => symbol.kind === "class");
    const functions = symbolsInFile.filter(
      (symbol) => symbol.kind === "function",
    );

    for (const fn of functions) {
      const ownerClass = classes.find((klass) =>
        isRangeWithin(
          {
            startLine: fn.rangeStartLine,
            startCol: fn.rangeStartCol,
            endLine: fn.rangeEndLine,
            endCol: fn.rangeEndCol,
          },
          {
            startLine: klass.rangeStartLine,
            startCol: klass.rangeStartCol,
            endLine: klass.rangeEndLine,
            endCol: klass.rangeEndCol,
          },
        ),
      );

      if (!ownerClass) {
        continue;
      }

      const classQualifiedName = `${ownerClass.name}.${fn.name}`;
      const classQualifiedExisting =
        classQualifiedMethodNameToSymbolIds.get(classQualifiedName) ?? [];
      classQualifiedExisting.push(fn.symbolId);
      classQualifiedMethodNameToSymbolIds.set(
        classQualifiedName,
        classQualifiedExisting,
      );

      const companionExisting =
        companionMemberNameToSymbolIds.get(fn.name) ?? [];
      companionExisting.push(fn.symbolId);
      companionMemberNameToSymbolIds.set(fn.name, companionExisting);
    }
  }

  return {
    classQualifiedMethodNameToSymbolIds,
    companionMemberNameToSymbolIds,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sliceSourceText(
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

function matchKotlinImportedInstanceMethodCall(params: {
  identifier: string;
  callerSourceText?: string;
  importedNameToSymbolIds: Map<string, string[]>;
  classNameToSymbolIds: Map<string, string[]>;
  globalNameToSymbolIds?: Map<string, string[]>;
  methodsByClassSymbolId: Map<string, Map<string, string[]>>;
}): KotlinResolvedCall | null {
  const {
    identifier,
    callerSourceText,
    importedNameToSymbolIds,
    classNameToSymbolIds,
    globalNameToSymbolIds,
    methodsByClassSymbolId,
  } = params;
  if (!callerSourceText || !identifier.includes(".")) {
    return null;
  }

  const parts = identifier.split(".");
  const receiver = parts[0]?.trim();
  const member = parts[parts.length - 1]?.trim();
  if (!receiver || !member || receiver === "this" || receiver === "Companion") {
    return null;
  }

  const assignmentPattern = new RegExp(
    String.raw`(?:\b(?:val|var)\s+)?${escapeRegExp(receiver)}(?:\s*:\s*[^=]+)?\s*=\s*([A-Z_][\w.]*)\s*\(`,
    "g",
  );

  let lastConstructorName: string | null = null;
  for (const match of callerSourceText.matchAll(assignmentPattern)) {
    lastConstructorName = match[1] ?? null;
  }

  if (!lastConstructorName) {
    return null;
  }

  const importedClassName =
    lastConstructorName.split(".").at(-1)?.trim() ?? lastConstructorName;
  const importedClassCandidates =
    importedNameToSymbolIds.get(importedClassName) ?? [];
  const repoClassCandidates = classNameToSymbolIds.get(importedClassName) ?? [];
  const globalClassCandidates =
    globalNameToSymbolIds?.get(importedClassName) ?? [];
  const candidateLists = [
    importedClassCandidates,
    repoClassCandidates,
    globalClassCandidates,
  ];
  for (const classCandidates of candidateLists) {
    if (classCandidates.length === 0) {
      continue;
    }

    const methodCandidates = classCandidates.flatMap(
      (classSymbolId) =>
        methodsByClassSymbolId.get(classSymbolId)?.get(member) ?? [],
    );
    if (methodCandidates.length !== 1) {
      continue;
    }

    return {
      symbolId: methodCandidates[0],
      isResolved: true,
      confidence: 0.84,
      resolution: "receiver-imported-instance",
    };
  }
  return null;
}

function resolveKotlinPass2CallTarget(params: {
  call: ExtractedCall;
  nodeIdToSymbolId: Map<string, string>;
  importedNameToSymbolIds: Map<string, string[]>;
  samePackageNameToSymbolIds: Map<string, string[]>;
  localClassMethodNameToSymbolIds: Map<string, string[]>;
  classQualifiedMethodNameToSymbolIds: Map<string, string[]>;
  companionMemberNameToSymbolIds: Map<string, string[]>;
  callerSourceText?: string;
  classNameToSymbolIds: Map<string, string[]>;
  methodsByClassSymbolId: Map<string, Map<string, string[]>>;
  globalNameToSymbolIds?: Map<string, string[]>;
}): KotlinResolvedCall | null {
  const {
    call,
    nodeIdToSymbolId,
    importedNameToSymbolIds,
    samePackageNameToSymbolIds,
    localClassMethodNameToSymbolIds,
    classQualifiedMethodNameToSymbolIds,
    companionMemberNameToSymbolIds,
    callerSourceText,
    classNameToSymbolIds,
    methodsByClassSymbolId,
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

  const samePackageCandidates = samePackageNameToSymbolIds.get(identifier);
  if (samePackageCandidates && samePackageCandidates.length > 0) {
    return {
      symbolId: samePackageCandidates[0],
      isResolved: true,
      confidence: 0.92,
      resolution: "same-package",
    };
  }

  if (identifier.includes(".")) {
    const parts = identifier.split(".");
    const prefix = parts[0];
    const member = parts[parts.length - 1];

    const classQualifiedCandidates = classQualifiedMethodNameToSymbolIds.get(
      `${prefix}.${member}`,
    );
    if (classQualifiedCandidates && classQualifiedCandidates.length === 1) {
      return {
        symbolId: classQualifiedCandidates[0],
        isResolved: true,
        confidence: 0.88,
        resolution: "companion-object",
      };
    }

    if (prefix === "Companion") {
      const companionCandidates = companionMemberNameToSymbolIds.get(member);
      if (companionCandidates && companionCandidates.length === 1) {
        return {
          symbolId: companionCandidates[0],
          isResolved: true,
          confidence: 0.88,
          resolution: "companion-object",
        };
      }
    }

    if (prefix === "this") {
      const localClassCandidates = localClassMethodNameToSymbolIds.get(member);
      if (localClassCandidates && localClassCandidates.length === 1) {
        return {
          symbolId: localClassCandidates[0],
          isResolved: true,
          confidence: 0.85,
          resolution: "receiver-this",
        };
      }
    }

    const importedInstanceMethodCall = matchKotlinImportedInstanceMethodCall({
      identifier,
      callerSourceText,
      importedNameToSymbolIds,
      classNameToSymbolIds,
      globalNameToSymbolIds,
      methodsByClassSymbolId,
    });
    if (importedInstanceMethodCall) {
      return importedInstanceMethodCall;
    }
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
      (globalCandidates?.length ?? 0),
  };
}

async function resolveKotlinCallEdgesPass2(params: {
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
        `File disappeared before Kotlin pass2 resolution: ${fileMeta.path}`,
        { code },
      );
      return 0;
    }
    throw readError;
  }

  const adapter = getAdapterForExtension(
    fileMeta.path.endsWith(".kts") ? ".kts" : ".kt",
  );
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
    "kotlin",
    content,
  );

  const packageIndex = await buildKotlinPackageIndex(repoId, cache);
  const packageName =
    extractedSymbols.find((symbol) => symbol.kind === "module")?.name ??
    packageIndex.packageByFilePath.get(fileMeta.path);
  const samePackageSymbolsFromPackage = packageName
    ? (packageIndex.symbolsByPackage.get(packageName) ?? [])
    : [];
  const currentDirectory = packageIndex.directoryByFilePath.get(fileMeta.path);
  const sameDirectorySymbols = currentDirectory
    ? (packageIndex.symbolsByDirectory.get(currentDirectory) ?? [])
    : [];
  const samePackageSymbols =
    samePackageSymbolsFromPackage.length > 0
      ? samePackageSymbolsFromPackage
      : sameDirectorySymbols;
  const samePackageNameToSymbolIds = buildSamePackageCallableIndex(
    fileMeta.path,
    samePackageSymbols,
  );
  const {
    classQualifiedMethodNameToSymbolIds,
    companionMemberNameToSymbolIds,
  } = buildCompanionObjectMethodIndexes(samePackageSymbols);

  const now = new Date().toISOString();
  const edgesToInsert: ladybugDb.EdgeRow[] = [];
  let createdEdges = 0;

  for (const detail of filteredSymbolDetails) {
    const callerSourceText = sliceSourceText(content, detail.extractedSymbol.range);
    for (const call of calls) {
      const callerNodeId =
        call.callerNodeId ??
        findEnclosingSymbolByRange(call.range, filteredSymbolDetails);
      if (callerNodeId !== detail.extractedSymbol.nodeId) {
        continue;
      }

      const resolved = resolveKotlinPass2CallTarget({
        call,
        nodeIdToSymbolId,
        importedNameToSymbolIds: importResolution.importedNameToSymbolIds,
        samePackageNameToSymbolIds,
        localClassMethodNameToSymbolIds,
        classQualifiedMethodNameToSymbolIds,
        companionMemberNameToSymbolIds,
        callerSourceText,
        classNameToSymbolIds: packageIndex.classNameToSymbolIds,
        methodsByClassSymbolId: packageIndex.methodsByClassSymbolId,
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
          resolverId: "pass2-kotlin",
          resolutionPhase: "pass2",
          provenance: `kotlin-call:${call.calleeIdentifier}`,
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
          resolverId: "pass2-kotlin",
          resolutionPhase: "pass2",
          provenance: `unresolved-kotlin-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
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

export class KotlinPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-kotlin";

  supports(target: Pass2Target): boolean {
    return (
      target.language === "kotlin" &&
      KOTLIN_PASS2_EXTENSIONS.has(target.extension)
    );
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    if (!target.repoId) {
      throw new Error("KotlinPass2Resolver requires target.repoId");
    }

    try {
      const edgesCreated = await resolveKotlinCallEdgesPass2({
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
        `Kotlin pass2 resolution failed for ${target.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { edgesCreated: 0 };
    }
  }
}
