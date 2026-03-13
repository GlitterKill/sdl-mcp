import { join } from "path";

import type { SyntaxNode, Tree } from "tree-sitter";

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

type RustResolvedCall = {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  resolution: string;
  targetName?: string;
  candidateCount?: number;
};

type RustModuleIndex = {
  modulePathByFilePath: Map<string, string>;
  symbolsByModulePath: Map<string, Array<SymbolRow & { relPath: string }>>;
};

const RUST_PASS2_EXTENSIONS = new Set([".rs"]);

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

function normalizeRustTypeName(typeName: string | undefined): string {
  if (!typeName) {
    return "";
  }
  return (
    typeName
      .trim()
      .replace(/^&(?:mut\s+)?/, "")
      .replace(/^crate::/, "")
      .split("::")
      .pop()
      ?.trim() ?? ""
  );
}

function inferRustModulePath(relPath: string): string {
  const normalized = normalizePath(relPath);
  const srcPrefix = "src/";
  const withinSrc = normalized.startsWith(srcPrefix)
    ? normalized.slice(srcPrefix.length)
    : normalized;

  if (withinSrc === "lib.rs" || withinSrc === "main.rs") {
    return "crate";
  }

  if (withinSrc.endsWith("/mod.rs")) {
    const moduleSegments = withinSrc
      .slice(0, -"/mod.rs".length)
      .split("/")
      .filter(Boolean);
    return moduleSegments.length > 0
      ? `crate::${moduleSegments.join("::")}`
      : "crate";
  }

  if (withinSrc.endsWith(".rs")) {
    const moduleSegments = withinSrc
      .slice(0, -".rs".length)
      .split("/")
      .filter(Boolean);
    return moduleSegments.length > 0
      ? `crate::${moduleSegments.join("::")}`
      : "crate";
  }

  return "crate";
}

async function buildRustModuleIndex(
  repoId: string,
  cache?: Map<string, unknown>,
): Promise<RustModuleIndex> {
  const cacheKey = `pass2-rust:module-index:${repoId}`;
  const cached = cache?.get(cacheKey);
  if (cached) {
    return cached as RustModuleIndex;
  }

  const conn = await getLadybugConn();
  const repoFiles = await ladybugDb.getFilesByRepo(conn, repoId);
  const rustFiles = repoFiles.filter((file) => file.language === "rust");
  const rustFileIds = new Set(rustFiles.map((file) => file.fileId));
  const fileById = new Map(rustFiles.map((file) => [file.fileId, file]));
  const modulePathByFilePath = new Map<string, string>();
  const symbolsByModulePath = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();

  for (const file of rustFiles) {
    modulePathByFilePath.set(file.relPath, inferRustModulePath(file.relPath));
  }

  const repoSymbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  for (const symbol of repoSymbols) {
    if (!rustFileIds.has(symbol.fileId)) {
      continue;
    }
    const file = fileById.get(symbol.fileId);
    if (!file) {
      continue;
    }
    const modulePath = modulePathByFilePath.get(file.relPath);
    if (!modulePath) {
      continue;
    }
    const bucket = symbolsByModulePath.get(modulePath) ?? [];
    bucket.push({
      ...symbol,
      relPath: file.relPath,
    });
    symbolsByModulePath.set(modulePath, bucket);
  }

  const moduleIndex = {
    modulePathByFilePath,
    symbolsByModulePath,
  };
  cache?.set(cacheKey, moduleIndex);
  return moduleIndex;
}

function buildSameModuleFunctionIndex(
  currentFilePath: string,
  sameModuleSymbols: Array<SymbolRow & { relPath: string }>,
): Map<string, string[]> {
  const sameModuleNameToSymbolIds = new Map<string, string[]>();
  for (const symbol of sameModuleSymbols) {
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

function buildCratePathFunctionIndex(
  symbolsByModulePath: RustModuleIndex["symbolsByModulePath"],
): Map<string, string[]> {
  const byCratePath = new Map<string, string[]>();

  for (const [modulePath, symbols] of symbolsByModulePath) {
    for (const symbol of symbols) {
      if (symbol.kind !== "function") {
        continue;
      }
      const key = `${modulePath}::${symbol.name}`;
      const existing = byCratePath.get(key) ?? [];
      existing.push(symbol.symbolId);
      byCratePath.set(key, existing);
    }
  }

  return byCratePath;
}

function parseOwnerTypeFromNodeId(nodeId: string): string | null {
  if (!nodeId.includes("::")) {
    return null;
  }
  const parts = nodeId.split("::");
  if (parts.length < 2) {
    return null;
  }
  return normalizeRustTypeName(parts[0]) || null;
}

function buildLocalImplMethodNamespaces(
  filteredSymbolDetails: FilteredSymbolDetail[],
): Map<string, Map<string, string>> {
  const methodsByType = new Map<string, Map<string, string>>();

  for (const detail of filteredSymbolDetails) {
    if (detail.extractedSymbol.kind !== "method") {
      continue;
    }
    const ownerType = parseOwnerTypeFromNodeId(detail.extractedSymbol.nodeId);
    if (!ownerType) {
      continue;
    }

    const methodBucket =
      methodsByType.get(ownerType) ?? new Map<string, string>();
    methodBucket.set(detail.extractedSymbol.name, detail.symbolId);
    methodsByType.set(ownerType, methodBucket);
  }

  return methodsByType;
}

function inferRustReceiverTypes(tree: Tree): Map<string, string> {
  const receiverTypes = new Map<string, string>();

  const visit = (node: SyntaxNode): void => {
    if (node.type === "let_declaration") {
      const text = node.text;

      const explicitType = text.match(
        /^let\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_:]*)/,
      );
      if (explicitType?.[1] && explicitType?.[2]) {
        receiverTypes.set(
          explicitType[1],
          normalizeRustTypeName(explicitType[2]),
        );
      }

      const constructorType = text.match(
        /^let\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_:]*)::[A-Za-z_][A-Za-z0-9_]*\s*\(/,
      );
      if (constructorType?.[1] && constructorType?.[2]) {
        receiverTypes.set(
          constructorType[1],
          normalizeRustTypeName(constructorType[2]),
        );
      }

      const structLiteralType = text.match(
        /^let\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_:]*)\s*\{/,
      );
      if (structLiteralType?.[1] && structLiteralType?.[2]) {
        receiverTypes.set(
          structLiteralType[1],
          normalizeRustTypeName(structLiteralType[2]),
        );
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  };

  visit(tree.rootNode);
  return receiverTypes;
}

function buildReceiverNamespaces(
  receiverTypes: Map<string, string>,
  methodsByType: Map<string, Map<string, string>>,
): Map<string, Map<string, string>> {
  const receiverNamespaces = new Map<string, Map<string, string>>();

  for (const [variable, receiverType] of receiverTypes) {
    const methods = methodsByType.get(normalizeRustTypeName(receiverType));
    if (methods) {
      receiverNamespaces.set(variable, methods);
    }
  }

  return receiverNamespaces;
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
    for (const id of ids) {
      if (!existing.includes(id)) {
        existing.push(id);
      }
    }
    merged.set(name, existing);
  }
  return merged;
}

function toUniqueCandidates(candidates: string[] | undefined): string[] {
  if (!candidates || candidates.length === 0) {
    return [];
  }
  return Array.from(new Set(candidates));
}

function buildCratePathCandidates(identifier: string): string[] {
  if (!identifier.startsWith("crate::")) {
    return [];
  }

  const compact = identifier.trim().replace(/\s+/g, "");
  const parts = compact.split("::").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "crate") {
    return [];
  }

  const targetName = parts[parts.length - 1];
  const modulePath = parts.slice(0, -1).join("::");
  if (!targetName || !modulePath) {
    return [];
  }

  return [`${modulePath}::${targetName}`];
}

function collectExplicitImportedNames(
  imports: Array<{ imports: string[] }>,
): Set<string> {
  const names = new Set<string>();
  for (const imp of imports) {
    for (const importedName of imp.imports) {
      if (importedName && importedName !== "*") {
        names.add(importedName);
      }
    }
  }
  return names;
}

function resolveRustPass2CallTarget(params: {
  call: ExtractedCall;
  callerSymbol: ExtractedSymbol;
  nodeIdToSymbolId: Map<string, string>;
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
  localImplMethodsByType: Map<string, Map<string, string>>;
  receiverNamespaces: Map<string, Map<string, string>>;
  explicitImportedNames: Set<string>;
  sameModuleNameToSymbolIds: Map<string, string[]>;
  cratePathToSymbolIds: Map<string, string[]>;
  globalNameToSymbolIds?: Map<string, string[]>;
}): RustResolvedCall | null {
  const {
    call,
    callerSymbol,
    nodeIdToSymbolId,
    importedNameToSymbolIds,
    namespaceImports,
    localImplMethodsByType,
    receiverNamespaces,
    explicitImportedNames,
    sameModuleNameToSymbolIds,
    cratePathToSymbolIds,
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

  const identifier = call.calleeIdentifier
    .replace(/^new\s+/, "")
    .replace(/!$/, "")
    .trim();
  if (!identifier) {
    return null;
  }

  const globalCandidates = toUniqueCandidates(
    globalNameToSymbolIds?.get(identifier),
  );

  const directImportedCandidates = toUniqueCandidates(
    importedNameToSymbolIds.get(identifier),
  );
  if (directImportedCandidates.length === 1) {
    return {
      symbolId: directImportedCandidates[0],
      isResolved: true,
      confidence: 0.9,
      resolution: "use-import",
    };
  }

  if (identifier.includes("::")) {
    const parts = identifier.split("::");
    const prefix = parts[0];
    const member = parts[parts.length - 1];
    const lastNameImportedCandidates = toUniqueCandidates(
      importedNameToSymbolIds.get(member),
    );

    const namespace = namespaceImports.get(prefix);
    if (namespace?.has(member)) {
      return {
        symbolId: namespace.get(member) ?? null,
        isResolved: true,
        confidence: 0.9,
        resolution: "use-import",
      };
    }

    if (
      prefix !== "crate" &&
      prefix !== "self" &&
      prefix !== "super" &&
      lastNameImportedCandidates.length === 1
    ) {
      return {
        symbolId: lastNameImportedCandidates[0],
        isResolved: true,
        confidence: 0.9,
        resolution: "use-import",
      };
    }
  }

  if (explicitImportedNames.has(identifier) && globalCandidates.length === 1) {
    return {
      symbolId: globalCandidates[0],
      isResolved: true,
      confidence: 0.9,
      resolution: "use-import",
    };
  }

  if (identifier.includes("::")) {
    const parts = identifier.split("::").filter(Boolean);
    if (parts.length >= 2) {
      const ownerType = normalizeRustTypeName(parts[parts.length - 2]);
      const methodName = parts[parts.length - 1];
      const methodBucket = localImplMethodsByType.get(ownerType);
      if (methodBucket?.has(methodName)) {
        return {
          symbolId: methodBucket.get(methodName) ?? null,
          isResolved: true,
          confidence: 0.9,
          resolution: "impl-method",
        };
      }
    }
  }

  if (identifier.includes(".")) {
    const parts = identifier.split(".");
    const receiver = parts[0];
    const methodName = parts[parts.length - 1];

    if (receiver === "self") {
      const ownerType = parseOwnerTypeFromNodeId(callerSymbol.nodeId);
      if (ownerType) {
        const methodBucket = localImplMethodsByType.get(ownerType);
        if (methodBucket?.has(methodName)) {
          return {
            symbolId: methodBucket.get(methodName) ?? null,
            isResolved: true,
            confidence: 0.9,
            resolution: "impl-method",
          };
        }
      }
    }

    const receiverNamespace = receiverNamespaces.get(receiver);
    if (receiverNamespace?.has(methodName)) {
      return {
        symbolId: receiverNamespace.get(methodName) ?? null,
        isResolved: true,
        confidence: 0.9,
        resolution: "impl-method",
      };
    }
  }

  if (identifier.startsWith("crate::")) {
    const candidates = buildCratePathCandidates(identifier).flatMap(
      (candidate) => cratePathToSymbolIds.get(candidate) ?? [],
    );
    if (candidates.length === 1) {
      return {
        symbolId: candidates[0],
        isResolved: true,
        confidence: 0.88,
        resolution: "crate-path",
      };
    }
  }

  const sameModuleCandidates = toUniqueCandidates(
    sameModuleNameToSymbolIds.get(identifier),
  );
  if (sameModuleCandidates.length === 1) {
    return {
      symbolId: sameModuleCandidates[0],
      isResolved: true,
      confidence: 0.82,
      resolution: "same-module",
    };
  }

  if (globalCandidates.length === 1) {
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
      directImportedCandidates.length +
      sameModuleCandidates.length +
      globalCandidates.length,
  };
}

async function resolveRustCallEdgesPass2(params: {
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
        `File disappeared before Rust pass2 resolution: ${fileMeta.path}`,
        { code },
      );
      return 0;
    }
    throw readError;
  }

  const adapter = getAdapterForExtension(".rs");
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
  const localImplMethodsByType = buildLocalImplMethodNamespaces(
    filteredSymbolDetails,
  );
  const receiverTypes = inferRustReceiverTypes(tree);
  const receiverNamespaces = buildReceiverNamespaces(
    receiverTypes,
    localImplMethodsByType,
  );

  const importResolution = await resolveImportTargets(
    repoId,
    repoRoot,
    fileMeta.path,
    imports,
    [...adapter.fileExtensions],
    "rust",
    content,
  );
  const importedNameToSymbolIds = mergeImportedNameMaps(
    importResolution.importedNameToSymbolIds,
    new Map(),
  );
  const explicitImportedNames = collectExplicitImportedNames(imports);

  const moduleIndex = await buildRustModuleIndex(repoId, cache);
  const currentModulePath = moduleIndex.modulePathByFilePath.get(fileMeta.path);
  const sameModuleSymbols = currentModulePath
    ? (moduleIndex.symbolsByModulePath.get(currentModulePath) ?? [])
    : [];
  const sameModuleNameToSymbolIds = buildSameModuleFunctionIndex(
    fileMeta.path,
    sameModuleSymbols,
  );
  const cratePathToSymbolIds = buildCratePathFunctionIndex(
    moduleIndex.symbolsByModulePath,
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

      const resolved = resolveRustPass2CallTarget({
        call,
        callerSymbol: detail.extractedSymbol,
        nodeIdToSymbolId,
        importedNameToSymbolIds,
        namespaceImports: importResolution.namespaceImports,
        localImplMethodsByType,
        receiverNamespaces,
        explicitImportedNames,
        sameModuleNameToSymbolIds,
        cratePathToSymbolIds,
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
          resolverId: "pass2-rust",
          resolutionPhase: "pass2",
          provenance: `rust-call:${call.calleeIdentifier}`,
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
          resolverId: "pass2-rust",
          resolutionPhase: "pass2",
          provenance: `unresolved-rust-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
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

export class RustPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-rust";

  supports(target: Pass2Target): boolean {
    return (
      target.language === "rust" && RUST_PASS2_EXTENSIONS.has(target.extension)
    );
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    if (!target.repoId) {
      throw new Error("RustPass2Resolver requires target.repoId");
    }

    try {
      const edgesCreated = await resolveRustCallEdgesPass2({
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
        `Rust pass2 resolution failed for ${target.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { edgesCreated: 0 };
    }
  }
}

export {
  buildCratePathCandidates,
  buildCratePathFunctionIndex,
  buildLocalImplMethodNamespaces,
  buildRustModuleIndex,
  buildSameModuleFunctionIndex,
  inferRustModulePath,
  inferRustReceiverTypes,
  normalizeRustTypeName,
  parseOwnerTypeFromNodeId,
  resolveRustPass2CallTarget,
};
