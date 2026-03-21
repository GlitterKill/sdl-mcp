import { basename, dirname, extname, join } from "path";

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
import { findEnclosingSymbolByRange } from "../../edge-builder/enclosing-symbol.js";
import type { FileMetadata } from "../../fileScanner.js";

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

type CppResolvedCall = {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  resolution: string;
  targetName?: string;
  candidateCount?: number;
};

type CppIncludeIndex = {
  includedSymbolsByFilePath: Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >;
  symbolsByFilePath: Map<string, Array<SymbolRow & { relPath: string }>>;
  filesByRelPath: Map<string, ladybugDb.FileRow>;
  symbolById: Map<string, SymbolRow>;
};

type CppNamespaceIndex = {
  namespaceByFilePath: Map<string, string[]>;
  symbolsByNamespace: Map<string, Array<SymbolRow & { relPath: string }>>;
};

const CPP_PASS2_EXTENSIONS = new Set([".cpp", ".hpp", ".cc", ".cxx", ".hxx"]);
const CPP_IMPORT_EXTENSIONS = [
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
];

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

function normalizeIdentifier(identifier: string): string {
  return identifier
    .replace(/^new\s+/, "")
    .replace(/\s+/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\(\)$/g, "")
    .trim();
}

function toUniqueCandidates(candidates: string[] | undefined): string[] {
  if (!candidates || candidates.length === 0) {
    return [];
  }
  return Array.from(new Set(candidates));
}

function splitNamespaceLeaf(identifier: string): {
  namespace: string;
  leaf: string;
} {
  const parts = identifier.split("::").filter(Boolean);
  if (parts.length < 2) {
    return { namespace: "", leaf: parts[0] ?? "" };
  }
  return {
    namespace: parts.slice(0, -1).join("::"),
    leaf: parts[parts.length - 1] ?? "",
  };
}

function lastSegment(name: string): string {
  const normalized = name.replace(/->/g, "::");
  const parts = normalized.split("::").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function addToNameIndex(
  index: Map<string, string[]>,
  key: string,
  symbolId: string,
): void {
  if (!key) {
    return;
  }
  const existing = index.get(key) ?? [];
  if (!existing.includes(symbolId)) {
    existing.push(symbolId);
  }
  index.set(key, existing);
}

function createNameIndexFromSymbols(
  symbols: Array<SymbolRow & { relPath: string }>,
): Map<string, string[]> {
  const nameToSymbolIds = new Map<string, string[]>();
  for (const symbol of symbols) {
    if (symbol.kind === "module") {
      continue;
    }
    const full = normalizeIdentifier(symbol.name);
    addToNameIndex(nameToSymbolIds, full, symbol.symbolId);
    addToNameIndex(nameToSymbolIds, lastSegment(full), symbol.symbolId);

    const parts = full.split("::").filter(Boolean);
    if (parts.length >= 2) {
      addToNameIndex(
        nameToSymbolIds,
        `${parts[parts.length - 2]}::${parts[parts.length - 1]}`,
        symbol.symbolId,
      );
    }
  }
  return nameToSymbolIds;
}

function addCandidatesFromIndex(
  index: Map<string, string[]>,
  identifier: string,
): string[] {
  const normalized = normalizeIdentifier(identifier);
  const candidates = new Set<string>();

  for (const key of [
    normalized,
    lastSegment(normalized),
    normalized.replace(/\./g, "::"),
    lastSegment(normalized.replace(/\./g, "::")),
  ]) {
    for (const symbolId of index.get(key) ?? []) {
      candidates.add(symbolId);
    }
  }

  return Array.from(candidates);
}

function extractUsingNamespaces(tree: Tree): Set<string> {
  const namespaces = new Set<string>();

  const visit = (node: SyntaxNode): void => {
    if (node.type === "using_declaration") {
      const text = node.text.replace(/\s+/g, " ").trim();
      const match = text.match(/^using namespace\s+([A-Za-z_][A-Za-z0-9_:]*)/);
      if (match?.[1]) {
        namespaces.add(normalizeIdentifier(match[1]));
      }
    }
    for (const child of node.children) {
      visit(child);
    }
  };

  visit(tree.rootNode);
  return namespaces;
}

function extractPathFromUnresolvedSymbolId(symbolId: string): string | null {
  const match = symbolId.match(/^unresolved:(.+):[^:]+$/);
  if (!match?.[1]) {
    return null;
  }
  return normalizePath(match[1]);
}

function buildRepoSymbolIndexes(params: {
  files: ladybugDb.FileRow[];
  symbols: SymbolRow[];
}): {
  filesByRelPath: Map<string, ladybugDb.FileRow>;
  filePathByFileId: Map<string, string>;
  symbolsByFilePath: Map<string, Array<SymbolRow & { relPath: string }>>;
  symbolById: Map<string, SymbolRow>;
} {
  const filesByRelPath = new Map<string, ladybugDb.FileRow>();
  const filePathByFileId = new Map<string, string>();
  const symbolsByFilePath = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();
  const symbolById = new Map<string, SymbolRow>();

  for (const file of params.files) {
    filesByRelPath.set(file.relPath, file);
    filePathByFileId.set(file.fileId, file.relPath);
  }

  for (const symbol of params.symbols) {
    symbolById.set(symbol.symbolId, symbol);
    const relPath = filePathByFileId.get(symbol.fileId);
    if (!relPath) {
      continue;
    }
    const bucket = symbolsByFilePath.get(relPath) ?? [];
    bucket.push({ ...symbol, relPath });
    symbolsByFilePath.set(relPath, bucket);
  }

  return {
    filesByRelPath,
    filePathByFileId,
    symbolsByFilePath,
    symbolById,
  };
}

async function buildCppIncludeIndex(params: {
  repoId: string;
  repoRoot: string;
  cache?: Map<string, unknown>;
}): Promise<CppIncludeIndex> {
  const cacheKey = `pass2-cpp:include-index:${params.repoId}`;
  const cached = params.cache?.get(cacheKey);
  if (cached) {
    return cached as CppIncludeIndex;
  }

  const conn = await getLadybugConn();
  const files = await ladybugDb.getFilesByRepo(conn, params.repoId);
  const symbols = await ladybugDb.getSymbolsByRepo(conn, params.repoId);
  const { filesByRelPath, filePathByFileId, symbolsByFilePath, symbolById } =
    buildRepoSymbolIndexes({ files, symbols });

  const adapter = getAdapterForExtension(".cpp");
  const includedSymbolsByFilePath = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();
  if (!adapter) {
    const index = {
      includedSymbolsByFilePath,
      symbolsByFilePath,
      filesByRelPath,
      symbolById,
    };
    params.cache?.set(cacheKey, index);
    return index;
  }

  const extensionCandidates = new Set<string>(CPP_IMPORT_EXTENSIONS);
  for (const file of files) {
    const extension = extname(file.relPath).toLowerCase();
    if (extension) {
      extensionCandidates.add(extension);
    }
  }

  const cppFiles = files.filter((file) => file.language === "cpp");
  for (const file of cppFiles) {
    const absolutePath = join(params.repoRoot, file.relPath);
    let content = "";
    try {
      content = await readFileAsync(absolutePath, "utf-8");
    } catch {
      includedSymbolsByFilePath.set(file.relPath, []);
      continue;
    }

    const tree = adapter.parse(content, absolutePath);
    if (!tree) {
      includedSymbolsByFilePath.set(file.relPath, []);
      continue;
    }

    let imports;
    try {
      imports = adapter.extractImports(tree, content, absolutePath);
    } finally {
      (tree as unknown as { delete?: () => void }).delete?.();
    }
    const importResolution = await resolveImportTargets(
      params.repoId,
      params.repoRoot,
      file.relPath,
      imports,
      Array.from(extensionCandidates),
      "cpp",
      content,
    );

    const includedPaths = new Set<string>();
    for (const target of importResolution.targets) {
      if (target.symbolId.startsWith("unresolved:")) {
        const unresolvedPath = extractPathFromUnresolvedSymbolId(
          target.symbolId,
        );
        if (unresolvedPath) {
          includedPaths.add(unresolvedPath);
        }
        continue;
      }

      const symbol = symbolById.get(target.symbolId);
      const relPath = symbol ? filePathByFileId.get(symbol.fileId) : null;
      if (relPath) {
        includedPaths.add(relPath);
      }
    }

    for (const symbolIds of importResolution.importedNameToSymbolIds.values()) {
      for (const symbolId of symbolIds) {
        const symbol = symbolById.get(symbolId);
        const relPath = symbol ? filePathByFileId.get(symbol.fileId) : null;
        if (relPath) {
          includedPaths.add(relPath);
        }
      }
    }

    for (const namespaceMap of importResolution.namespaceImports.values()) {
      for (const symbolId of namespaceMap.values()) {
        const symbol = symbolById.get(symbolId);
        const relPath = symbol ? filePathByFileId.get(symbol.fileId) : null;
        if (relPath) {
          includedPaths.add(relPath);
        }
      }
    }

    const includedSymbols: Array<SymbolRow & { relPath: string }> = [];
    for (const relPath of includedPaths) {
      const symbolsFromFile = symbolsByFilePath.get(relPath) ?? [];
      for (const symbol of symbolsFromFile) {
        includedSymbols.push(symbol);
      }
    }

    includedSymbolsByFilePath.set(file.relPath, includedSymbols);
  }

  const includeIndex = {
    includedSymbolsByFilePath,
    symbolsByFilePath,
    filesByRelPath,
    symbolById,
  };
  params.cache?.set(cacheKey, includeIndex);
  return includeIndex;
}

async function buildCppNamespaceIndex(
  repoId: string,
  cache?: Map<string, unknown>,
): Promise<CppNamespaceIndex> {
  const cacheKey = `pass2-cpp:namespace-index:${repoId}`;
  const cached = cache?.get(cacheKey);
  if (cached) {
    return cached as CppNamespaceIndex;
  }

  const conn = await getLadybugConn();
  const files = await ladybugDb.getFilesByRepo(conn, repoId);
  const cppFiles = files.filter((file) => file.language === "cpp");
  const cppFileIds = new Set(cppFiles.map((file) => file.fileId));
  const fileById = new Map(cppFiles.map((file) => [file.fileId, file]));
  const symbols = await ladybugDb.getSymbolsByRepo(conn, repoId);

  const namespaceByFilePath = new Map<string, string[]>();
  const symbolsByNamespace = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();
  const namespaceNames = new Set<string>();

  for (const symbol of symbols) {
    if (!cppFileIds.has(symbol.fileId) || symbol.kind !== "module") {
      continue;
    }
    const file = fileById.get(symbol.fileId);
    if (!file) {
      continue;
    }
    namespaceNames.add(symbol.name);
    const existing = namespaceByFilePath.get(file.relPath) ?? [];
    if (!existing.includes(symbol.name)) {
      existing.push(symbol.name);
    }
    namespaceByFilePath.set(file.relPath, existing);
  }

  for (const namespaceName of namespaceNames) {
    const bucket: Array<SymbolRow & { relPath: string }> = [];
    for (const symbol of symbols) {
      if (!cppFileIds.has(symbol.fileId)) {
        continue;
      }
      if (
        symbol.name !== namespaceName &&
        !symbol.name.startsWith(`${namespaceName}::`)
      ) {
        continue;
      }
      const file = fileById.get(symbol.fileId);
      if (!file) {
        continue;
      }
      bucket.push({
        ...symbol,
        relPath: file.relPath,
      });
    }
    symbolsByNamespace.set(namespaceName, bucket);
  }

  const namespaceIndex = {
    namespaceByFilePath,
    symbolsByNamespace,
  };
  cache?.set(cacheKey, namespaceIndex);
  return namespaceIndex;
}

function buildNamespaceMemberIndex(
  namespaceIndex: CppNamespaceIndex,
): Map<string, Map<string, string[]>> {
  const namespaceMembers = new Map<string, Map<string, string[]>>();

  for (const [namespaceName, symbols] of namespaceIndex.symbolsByNamespace) {
    const memberIndex = new Map<string, string[]>();
    for (const symbol of symbols) {
      if (symbol.kind === "module") {
        continue;
      }
      addToNameIndex(
        memberIndex,
        normalizeIdentifier(symbol.name),
        symbol.symbolId,
      );
      addToNameIndex(memberIndex, lastSegment(symbol.name), symbol.symbolId);

      if (symbol.name.startsWith(`${namespaceName}::`)) {
        const memberName = symbol.name.slice(`${namespaceName}::`.length);
        addToNameIndex(
          memberIndex,
          normalizeIdentifier(memberName),
          symbol.symbolId,
        );
      }
    }
    namespaceMembers.set(namespaceName, memberIndex);
  }

  return namespaceMembers;
}

function buildSameDirectoryNameIndex(params: {
  currentFilePath: string;
  symbolsByFilePath: Map<string, Array<SymbolRow & { relPath: string }>>;
}): Map<string, string[]> {
  const sameDirectoryNameToSymbolIds = new Map<string, string[]>();
  const currentDir = normalizePath(dirname(params.currentFilePath));

  for (const [relPath, symbols] of params.symbolsByFilePath) {
    if (normalizePath(dirname(relPath)) !== currentDir) {
      continue;
    }
    if (relPath === params.currentFilePath) {
      continue;
    }
    for (const symbol of symbols) {
      if (symbol.kind === "module") {
        continue;
      }
      addToNameIndex(
        sameDirectoryNameToSymbolIds,
        normalizeIdentifier(symbol.name),
        symbol.symbolId,
      );
      addToNameIndex(
        sameDirectoryNameToSymbolIds,
        lastSegment(symbol.name),
        symbol.symbolId,
      );
    }
  }

  return sameDirectoryNameToSymbolIds;
}

function buildHeaderPairCandidatePaths(relPath: string): string[] {
  const normalized = normalizePath(relPath);
  const extension = extname(normalized).toLowerCase();
  const directory = normalizePath(dirname(normalized));
  const parent = normalizePath(dirname(directory));
  const stem = basename(normalized, extension);

  const paths = new Set<string>();
  const addInDir = (dir: string, ext: string): void => {
    const candidate =
      dir && dir !== "."
        ? normalizePath(join(dir, `${stem}${ext}`))
        : `${stem}${ext}`;
    paths.add(candidate);
  };

  if (extension === ".cpp" || extension === ".cc" || extension === ".cxx") {
    for (const headerExtension of [".h", ".hh", ".hpp", ".hxx"]) {
      addInDir(directory, headerExtension);
      addInDir("include", headerExtension);
      if (parent && parent !== ".") {
        addInDir(normalizePath(join(parent, "include")), headerExtension);
      }
    }
  } else {
    for (const sourceExtension of [".cpp", ".cc", ".cxx"]) {
      addInDir(directory, sourceExtension);
      addInDir("src", sourceExtension);
    }
  }

  paths.delete(normalized);
  return Array.from(paths);
}

function buildHeaderPairNameIndex(params: {
  currentFilePath: string;
  filesByRelPath: Map<string, ladybugDb.FileRow>;
  symbolsByFilePath: Map<string, Array<SymbolRow & { relPath: string }>>;
}): Map<string, string[]> {
  const nameToSymbolIds = new Map<string, string[]>();
  const candidates = buildHeaderPairCandidatePaths(params.currentFilePath);

  for (const candidate of candidates) {
    if (!params.filesByRelPath.has(candidate)) {
      continue;
    }
    for (const symbol of params.symbolsByFilePath.get(candidate) ?? []) {
      if (symbol.kind === "module") {
        continue;
      }
      addToNameIndex(
        nameToSymbolIds,
        normalizeIdentifier(symbol.name),
        symbol.symbolId,
      );
      addToNameIndex(
        nameToSymbolIds,
        lastSegment(symbol.name),
        symbol.symbolId,
      );
    }
  }

  return nameToSymbolIds;
}

function resolveCppPass2CallTarget(params: {
  call: ExtractedCall;
  nodeIdToSymbolId: Map<string, string>;
  includeNameToSymbolIds: Map<string, string[]>;
  namespaceMembersByNamespace: Map<string, Map<string, string[]>>;
  usingNamespaces: Set<string>;
  headerPairNameToSymbolIds: Map<string, string[]>;
  sameDirectoryNameToSymbolIds: Map<string, string[]>;
  globalNameToSymbolIds?: Map<string, string[]>;
}): CppResolvedCall | null {
  const {
    call,
    nodeIdToSymbolId,
    includeNameToSymbolIds,
    namespaceMembersByNamespace,
    usingNamespaces,
    headerPairNameToSymbolIds,
    sameDirectoryNameToSymbolIds,
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

  const identifier = normalizeIdentifier(call.calleeIdentifier);
  if (!identifier) {
    return null;
  }

  const includeCandidates = toUniqueCandidates(
    addCandidatesFromIndex(includeNameToSymbolIds, identifier),
  );
  if (includeCandidates.length === 1) {
    return {
      symbolId: includeCandidates[0],
      isResolved: true,
      confidence: 0.9,
      resolution: "include-matched",
    };
  }

  if (identifier.includes("::")) {
    const { namespace, leaf } = splitNamespaceLeaf(identifier);
    const namespaceMembers = namespaceMembersByNamespace.get(namespace);
    if (namespaceMembers) {
      const namespaceQualifiedCandidates = toUniqueCandidates([
        ...(namespaceMembers.get(identifier) ?? []),
        ...(namespaceMembers.get(leaf) ?? []),
      ]);
      if (namespaceQualifiedCandidates.length === 1) {
        return {
          symbolId: namespaceQualifiedCandidates[0],
          isResolved: true,
          confidence: 0.9,
          resolution: "namespace-qualified",
        };
      }
    }
  }

  const headerPairCandidates = toUniqueCandidates(
    addCandidatesFromIndex(headerPairNameToSymbolIds, identifier),
  );
  if (headerPairCandidates.length === 1) {
    return {
      symbolId: headerPairCandidates[0],
      isResolved: true,
      confidence: 0.88,
      resolution: "header-pair",
    };
  }

  if (!identifier.includes("::")) {
    const usingNamespaceCandidates = new Set<string>();
    for (const namespaceName of usingNamespaces) {
      const namespaceMembers = namespaceMembersByNamespace.get(namespaceName);
      if (!namespaceMembers) {
        continue;
      }
      for (const symbolId of namespaceMembers.get(identifier) ?? []) {
        usingNamespaceCandidates.add(symbolId);
      }
      for (const symbolId of namespaceMembers.get(lastSegment(identifier)) ??
        []) {
        usingNamespaceCandidates.add(symbolId);
      }
    }

    if (usingNamespaceCandidates.size === 1) {
      return {
        symbolId: Array.from(usingNamespaceCandidates)[0],
        isResolved: true,
        confidence: 0.82,
        resolution: "using-namespace",
      };
    }
  }

  const sameDirectoryCandidates = toUniqueCandidates(
    addCandidatesFromIndex(sameDirectoryNameToSymbolIds, identifier),
  );
  if (sameDirectoryCandidates.length === 1) {
    return {
      symbolId: sameDirectoryCandidates[0],
      isResolved: true,
      confidence: 0.78,
      resolution: "same-directory",
    };
  }

  const globalCandidates = toUniqueCandidates(
    globalNameToSymbolIds?.get(identifier) ??
      globalNameToSymbolIds?.get(lastSegment(identifier)),
  );
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
      includeCandidates.length +
      headerPairCandidates.length +
      sameDirectoryCandidates.length +
      globalCandidates.length,
  };
}

async function resolveCppCallEdgesPass2(params: {
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
        `File disappeared before C++ pass2 resolution: ${fileMeta.path}`,
        {
          code,
        },
      );
      return 0;
    }
    throw readError;
  }

  const extension = extname(fileMeta.path).toLowerCase();
  const adapter =
    getAdapterForExtension(extension) ?? getAdapterForExtension(".cpp");
  if (!adapter) {
    return 0;
  }

  const tree = adapter.parse(content, filePath);
  if (!tree) {
    return 0;
  }

  let extractedSymbols: ExtractedSymbol[];
  let calls: ExtractedCall[];
  let usingNamespaces: Set<string>;
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
    usingNamespaces = extractUsingNamespaces(tree);
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

  const nodeIdToSymbolId = createNodeIdToSymbolId(filteredSymbolDetails);

  const includeIndex = await buildCppIncludeIndex({
    repoId,
    repoRoot,
    cache,
  });
  const namespaceIndex = await buildCppNamespaceIndex(repoId, cache);
  const namespaceMembersByNamespace = buildNamespaceMemberIndex(namespaceIndex);

  for (const namespaceName of namespaceIndex.namespaceByFilePath.get(
    fileMeta.path,
  ) ?? []) {
    if (namespaceName) {
      usingNamespaces.add(namespaceName);
    }
  }

  const includeNameToSymbolIds = createNameIndexFromSymbols(
    includeIndex.includedSymbolsByFilePath.get(fileMeta.path) ?? [],
  );
  const headerPairNameToSymbolIds = buildHeaderPairNameIndex({
    currentFilePath: fileMeta.path,
    filesByRelPath: includeIndex.filesByRelPath,
    symbolsByFilePath: includeIndex.symbolsByFilePath,
  });
  const sameDirectoryNameToSymbolIds = buildSameDirectoryNameIndex({
    currentFilePath: fileMeta.path,
    symbolsByFilePath: includeIndex.symbolsByFilePath,
  });

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

      const resolved = resolveCppPass2CallTarget({
        call,
        nodeIdToSymbolId,
        includeNameToSymbolIds,
        namespaceMembersByNamespace,
        usingNamespaces,
        headerPairNameToSymbolIds,
        sameDirectoryNameToSymbolIds,
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
          resolverId: "pass2-cpp",
          resolutionPhase: "pass2",
          provenance: `cpp-call:${call.calleeIdentifier}`,
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
          resolverId: "pass2-cpp",
          resolutionPhase: "pass2",
          provenance: `unresolved-cpp-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
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

export class CppPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-cpp";

  supports(target: Pass2Target): boolean {
    return (
      target.language === "cpp" && CPP_PASS2_EXTENSIONS.has(target.extension)
    );
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    if (!target.repoId) {
      throw new Error("CppPass2Resolver requires target.repoId");
    }

    try {
      const edgesCreated = await resolveCppCallEdgesPass2({
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
        `C++ pass2 resolution failed for ${target.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { edgesCreated: 0 };
    }
  }
}

export {
  buildCppIncludeIndex,
  buildCppNamespaceIndex,
  buildHeaderPairCandidatePaths,
  extractUsingNamespaces,
  normalizeIdentifier,
  resolveCppPass2CallTarget,
};
