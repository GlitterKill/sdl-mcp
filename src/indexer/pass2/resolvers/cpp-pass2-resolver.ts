import { basename, dirname, extname, join } from "path";

import type { Tree } from "tree-sitter";

import { getLadybugConn, withWriteConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import type { SymbolRow } from "../../../db/ladybug-queries.js";
import {
  unresolvedCallDependencyTarget,
  unresolvedCallSymbolId,
} from "../../../db/symbol-placeholders.js";
import type { SymbolKind } from "../../../domain/types.js";
import { readFileAsyncWithTiming } from "../../../util/asyncFs.js";
import { singleFlight } from "../../../util/concurrency.js";
import { logger } from "../../../util/logger.js";
import { normalizePath } from "../../../util/paths.js";
import { normalizeTypeName } from "../../../util/type-name.js";
import { getAdapterForExtension } from "../../adapter/registry.js";
import { resolveImportTargets } from "../../edge-builder/import-target-resolver.js";
import { findEnclosingSymbolByRange } from "../../edge-builder/enclosing-symbol.js";
import type { FileMetadata } from "../../fileScanner.js";

import type {
  Pass2Resolver,
  Pass2ResolverContext,
  Pass2ResolverResult,
  Pass2Target,
} from "../types.js";

import { confidenceFor } from "../confidence.js";
/**
 * C++ resolver's header-pair confidence (0.88) differs from the
 * rubric value (0.82). Preserved byte-for-byte; revisit in follow-up.
 */
const CPP_HEADER_PAIR_CONFIDENCE = 0.88;

/**
 * C++ namespace-qualified confidence (0.9) differs from the centralized
 * rubric value (0.88). Preserved byte-for-byte; revisit in follow-up.
 */
const CPP_NAMESPACE_QUALIFIED_CONFIDENCE = 0.9;

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

export type CppIncludeIndex = {
  includedSymbolsByFilePath: Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >;
  symbolsByFilePath: Map<string, Array<SymbolRow & { relPath: string }>>;
  filesByRelPath: Map<string, ladybugDb.FileRow>;
  symbolById: Map<string, SymbolRow>;
  namespaceByFilePath: Map<string, string[]>;
  namespaceMembersByNamespace: Map<string, Map<string, string[]>>;
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

/**
 * In-memory cleanup of stale dedup keys for the symbols this file is about to
 * re-resolve. The matching SQL DELETE is deferred to `submitEdgeWrite` so the
 * dispatcher can combine deletes + inserts across an entire concurrency batch
 * into a single `withWriteConn`.
 */
function clearLocalCallDedupKeys(
  symbolIds: string[],
  createdCallEdges: Set<string>,
): void {
  if (symbolIds.length === 0) return;
  const symbolIdSet = new Set(symbolIds);
  for (const edgeKey of createdCallEdges) {
    const separatorIndex = edgeKey.indexOf("->");
    if (separatorIndex < 0) {
      continue;
    }
    if (symbolIdSet.has(edgeKey.slice(0, separatorIndex))) {
      createdCallEdges.delete(edgeKey);
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

/**
 * Assign calls to their owning symbol once per file. The old nested
 * symbol-by-call walk repeated the enclosing-symbol search for every symbol,
 * which made C++ pass-2 grow with `symbols * calls` on large translation units.
 */
function groupCallsByCallerSymbol(
  calls: readonly ExtractedCall[],
  filteredSymbolDetails: FilteredSymbolDetail[],
): Map<string, ExtractedCall[]> {
  const callsByCallerNodeId = new Map<string, ExtractedCall[]>();
  for (const call of calls) {
    const callerNodeId =
      call.callerNodeId ??
      findEnclosingSymbolByRange(call.range, filteredSymbolDetails);
    if (!callerNodeId) {
      continue;
    }
    const existing = callsByCallerNodeId.get(callerNodeId) ?? [];
    existing.push(call);
    callsByCallerNodeId.set(callerNodeId, existing);
  }
  return callsByCallerNodeId;
}

function normalizeIdentifier(identifier: string): string {
  return normalizeTypeName(
    identifier
      .replace(/^new\s+/, "")
      .replace(/\s+/g, "")
      .replace(/\(\)$/g, ""),
  ).trim();
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

  for (const node of tree.rootNode.descendantsOfType("using_declaration")) {
    if (node.type === "using_declaration") {
      const text = node.text.replace(/\s+/g, " ").trim();
      const match = text.match(/^using namespace\s+([A-Za-z_][A-Za-z0-9_:]*)/);
      if (match?.[1]) {
        namespaces.add(normalizeIdentifier(match[1]));
      }
    }
  }
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
  importCache?: Pass2ResolverContext["importCache"];
  targetPaths?: ReadonlySet<string>;
  recordMetric?: Pass2ResolverContext["recordMetric"];
  recordPhase?: Pass2ResolverContext["recordPhase"];
  pass1Extractions?: Pass2ResolverContext["pass1Extractions"];
}): Promise<CppIncludeIndex> {
  const cacheKey = `pass2-cpp:include-index:${params.repoId}`;
  const valueCacheKey = `${cacheKey}:value`;
  if (params.cache?.has(cacheKey)) {
    params.recordMetric?.("includeIndex.cacheHits", 1);
  } else {
    params.recordMetric?.("includeIndex.cacheMisses", 1);
  }
  const includeIndex = await singleFlight(
    params.cache,
    cacheKey,
    async () => {
      const buildStartedAt = Date.now();
      let namespaceIndexStartedAt = 0;
      let includeReadMs = 0;
      let includeParseMs = 0;
      let includeResolveMs = 0;
      let includeSymbolCollectMs = 0;
      const conn = await getLadybugConn();
      const filesStartedAt = Date.now();
      const files = await ladybugDb.getFilesByRepo(conn, params.repoId);
      params.recordPhase?.("includeIndex.dbFiles", Date.now() - filesStartedAt);
      const symbolsStartedAt = Date.now();
      const symbols = await ladybugDb.getSymbolsByRepo(conn, params.repoId);
      params.recordPhase?.(
        "includeIndex.dbSymbols",
        Date.now() - symbolsStartedAt,
      );
      params.recordMetric?.("repo.files", files.length);
      params.recordMetric?.("repo.symbols", symbols.length);
      if (params.targetPaths) {
        params.recordMetric?.("includeIndex.targetPaths", params.targetPaths.size);
      }
      const repoIndexStartedAt = Date.now();
      const {
        filesByRelPath,
        filePathByFileId,
        symbolsByFilePath,
        symbolById,
      } = buildRepoSymbolIndexes({ files, symbols });
      params.recordPhase?.(
        "includeIndex.repoSymbolIndexes",
        Date.now() - repoIndexStartedAt,
      );

      const adapter = getAdapterForExtension(".cpp");
      const includedSymbolsByFilePath = new Map<
        string,
        Array<SymbolRow & { relPath: string }>
      >();
      if (!adapter) {
        namespaceIndexStartedAt = Date.now();
        const namespaceIndex = buildCppNamespaceIndexFromRows({
          files,
          symbols,
        });
        params.recordPhase?.(
          "includeIndex.namespaceIndex",
          Date.now() - namespaceIndexStartedAt,
        );
        params.recordPhase?.(
          "includeIndex.build",
          Date.now() - buildStartedAt,
        );
        return {
          includedSymbolsByFilePath,
          symbolsByFilePath,
          filesByRelPath,
          symbolById,
          namespaceByFilePath: namespaceIndex.namespaceByFilePath,
          namespaceMembersByNamespace:
            buildNamespaceMemberIndex(namespaceIndex),
        };
      }

      const cppFilesAll = files.filter((file) => file.language === "cpp");
      const extensionCandidates = new Set<string>(CPP_IMPORT_EXTENSIONS);
      for (const file of files) {
        const extension = extname(file.relPath).toLowerCase();
        if (extension) {
          extensionCandidates.add(extension);
        }
      }

      const cppFiles = cppFilesAll.filter(
        (file) =>
          (!params.targetPaths || params.targetPaths.has(file.relPath)),
      );
      params.recordMetric?.("includeIndex.cppFiles", cppFilesAll.length);
      params.recordMetric?.("includeIndex.filesSelected", cppFiles.length);
      let includeFilesRead = 0;
      let includeBytesRead = 0;
      let includeReadActiveMs = 0;
      let includeReadQueueMs = 0;
      let includeReadMisses = 0;
      let includeFilesParsed = 0;
      let includeParseMisses = 0;
      let includeImports = 0;
      let includePass1CacheHits = 0;
      let includePass1CacheMisses = 0;
      let includePass1CacheBytes = 0;
      for (const file of cppFiles) {
        const absolutePath = join(params.repoRoot, file.relPath);
        let imports: ReturnType<typeof adapter.extractImports>;
        let content = "";

        const cachedExtraction = params.pass1Extractions?.get(file.relPath);
        if (cachedExtraction) {
          imports = cachedExtraction.imports;
          content = cachedExtraction.content;
          includePass1CacheHits++;
          includePass1CacheBytes += Buffer.byteLength(content, "utf8");
        } else {
          if (params.pass1Extractions) {
            includePass1CacheMisses++;
          }
          try {
            const readStartedAt = Date.now();
            const readResult = await readFileAsyncWithTiming(
              absolutePath,
              "utf-8",
            );
            content = readResult.content;
            includeReadMs += Date.now() - readStartedAt;
            includeReadQueueMs += readResult.queuedMs;
            includeReadActiveMs += readResult.activeMs;
            includeFilesRead++;
            includeBytesRead += Buffer.byteLength(content, "utf8");
          } catch {
            includeReadMisses++;
            includedSymbolsByFilePath.set(file.relPath, []);
            continue;
          }

          const parseStartedAt = Date.now();
          const tree = adapter.parse(content, absolutePath);
          if (!tree) {
            includeParseMs += Date.now() - parseStartedAt;
            includeParseMisses++;
            includedSymbolsByFilePath.set(file.relPath, []);
            continue;
          }

          try {
            imports = adapter.extractImports(tree, content, absolutePath);
            includeParseMs += Date.now() - parseStartedAt;
            includeFilesParsed++;
          } finally {
            (tree as unknown as { delete?: () => void }).delete?.();
          }
        }
        includeImports += imports.length;
        const resolveStartedAt = Date.now();
        const importResolution = await resolveImportTargets(
          params.repoId,
          params.repoRoot,
          file.relPath,
          imports,
          Array.from(extensionCandidates),
          "cpp",
          content,
          params.importCache,
        );
        includeResolveMs += Date.now() - resolveStartedAt;

        const collectStartedAt = Date.now();
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
        includeSymbolCollectMs += Date.now() - collectStartedAt;
      }
      params.recordMetric?.("includeIndex.filesRead", includeFilesRead);
      params.recordMetric?.("includeIndex.bytesRead", includeBytesRead);
      params.recordMetric?.("includeIndex.readMisses", includeReadMisses);
      params.recordMetric?.("includeIndex.filesParsed", includeFilesParsed);
      params.recordMetric?.("includeIndex.parseMisses", includeParseMisses);
      params.recordMetric?.("includeIndex.imports", includeImports);
      params.recordMetric?.("includeIndex.pass1CacheHits", includePass1CacheHits);
      params.recordMetric?.(
        "includeIndex.pass1CacheMisses",
        includePass1CacheMisses,
      );
      params.recordMetric?.("includeIndex.pass1CacheBytes", includePass1CacheBytes);
      params.recordPhase?.("includeIndex.readFiles", includeReadMs);
      params.recordPhase?.("includeIndex.readFiles.active", includeReadActiveMs);
      params.recordPhase?.("includeIndex.readFiles.queue", includeReadQueueMs);
      params.recordPhase?.("includeIndex.parseExtract", includeParseMs);
      params.recordPhase?.("includeIndex.resolveImports", includeResolveMs);
      params.recordPhase?.(
        "includeIndex.collectSymbols",
        includeSymbolCollectMs,
      );

      namespaceIndexStartedAt = Date.now();
      const namespaceIndex = buildCppNamespaceIndexFromRows({
        files,
        symbols,
      });
      params.recordPhase?.(
        "includeIndex.namespaceIndex",
        Date.now() - namespaceIndexStartedAt,
      );
      params.recordPhase?.("includeIndex.build", Date.now() - buildStartedAt);
      return {
        includedSymbolsByFilePath,
        symbolsByFilePath,
        filesByRelPath,
        symbolById,
        namespaceByFilePath: namespaceIndex.namespaceByFilePath,
        namespaceMembersByNamespace: buildNamespaceMemberIndex(namespaceIndex),
      };
    },
  );
  params.cache?.set(valueCacheKey, includeIndex);
  return includeIndex;
}

function getCachedCppIncludeIndex(
  cache: Map<string, unknown> | undefined,
  repoId: string,
): CppIncludeIndex | undefined {
  return cache?.get(
    `pass2-cpp:include-index:${repoId}:value`,
  ) as CppIncludeIndex | undefined;
}

function buildCppNamespaceIndexFromRows(params: {
  files: ladybugDb.FileRow[];
  symbols: SymbolRow[];
}): CppNamespaceIndex {
  const cppFiles = params.files.filter((file) => file.language === "cpp");
  const cppFileIds = new Set(cppFiles.map((file) => file.fileId));
  const fileById = new Map(cppFiles.map((file) => [file.fileId, file]));
  const cppSymbols: Array<SymbolRow & { relPath: string }> = [];

  const namespaceByFilePath = new Map<string, string[]>();
  const symbolsByNamespace = new Map<
    string,
    Array<SymbolRow & { relPath: string }>
  >();
  const namespaceNames = new Set<string>();

  for (const symbol of params.symbols) {
    if (!cppFileIds.has(symbol.fileId)) {
      continue;
    }
    const file = fileById.get(symbol.fileId);
    if (!file) {
      continue;
    }
    const row = {
      ...symbol,
      relPath: file.relPath,
    };
    cppSymbols.push(row);
    if (symbol.kind !== "module") {
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
    symbolsByNamespace.set(namespaceName, []);
  }

  for (const symbol of cppSymbols) {
    for (const namespaceName of namespacePrefixesForSymbol(symbol.name)) {
      const bucket = symbolsByNamespace.get(namespaceName);
      if (bucket) {
        bucket.push(symbol);
      }
    }
  }

  return {
    namespaceByFilePath,
    symbolsByNamespace,
  };
}

function namespacePrefixesForSymbol(symbolName: string): string[] {
  const prefixes: string[] = [];
  let searchFrom = 0;
  while (true) {
    const separatorIndex = symbolName.indexOf("::", searchFrom);
    if (separatorIndex < 0) break;
    if (separatorIndex > 0) {
      prefixes.push(symbolName.slice(0, separatorIndex));
    }
    searchFrom = separatorIndex + 2;
  }
  prefixes.push(symbolName);
  return prefixes;
}

async function buildCppNamespaceIndex(
  repoId: string,
  cache?: Map<string, unknown>,
): Promise<CppNamespaceIndex> {
  return singleFlight(
    cache,
    `pass2-cpp:namespace-index:${repoId}`,
    async () => {
      const conn = await getLadybugConn();
      const files = await ladybugDb.getFilesByRepo(conn, repoId);
      const symbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
      return buildCppNamespaceIndexFromRows({ files, symbols });
    },
  );
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
      confidence: confidenceFor("package-qualified"),
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
      confidence: confidenceFor("import-direct"),
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
          confidence: CPP_NAMESPACE_QUALIFIED_CONFIDENCE,
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
      confidence: CPP_HEADER_PAIR_CONFIDENCE,
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
        confidence: confidenceFor("header-pair"),
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
      confidence: confidenceFor("cross-file-name-unique"),
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
  mode?: "full" | "incremental";
  submitEdgeWrite?: Pass2ResolverContext["submitEdgeWrite"];
  importCache?: Pass2ResolverContext["importCache"];
  recordPhase?: Pass2ResolverContext["recordPhase"];
  recordMetric?: Pass2ResolverContext["recordMetric"];
  recordFilePhase?: Pass2ResolverContext["recordFilePhase"];
  pass2TargetPaths?: Pass2ResolverContext["pass2TargetPaths"];
  pass1Extractions?: Pass2ResolverContext["pass1Extractions"];
}): Promise<number> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    createdCallEdges,
    globalNameToSymbolIds,
    telemetry,
    cache,
    mode,
    submitEdgeWrite,
    importCache,
    recordPhase,
    recordMetric,
    recordFilePhase,
    pass2TargetPaths,
    pass1Extractions,
  } = params;

  const filePath = join(repoRoot, fileMeta.path);
  const extension = extname(fileMeta.path).toLowerCase();
  const adapter =
    getAdapterForExtension(extension) ?? getAdapterForExtension(".cpp");
  if (!adapter) {
    return 0;
  }

  let content: string;
  const cachedExtraction = pass1Extractions?.get(fileMeta.path);
  let pass1CacheMiss = false;
  if (cachedExtraction) {
    content = cachedExtraction.content;
    recordMetric?.("readFile.pass1CacheHits", 1);
    recordMetric?.(
      "readFile.pass1CacheBytes",
      Buffer.byteLength(content, "utf8"),
    );
  } else {
    if (pass1Extractions) {
      recordMetric?.("readFile.pass1CacheMisses", 1);
      pass1CacheMiss = true;
    }
    const readStartedAt = Date.now();
    let readElapsedMs = 0;
    try {
      const readResult = await readFileAsyncWithTiming(filePath, "utf-8");
      content = readResult.content;
      if (pass1CacheMiss) {
        recordMetric?.(
          "readFile.pass1CacheMissBytes",
          Buffer.byteLength(content, "utf8"),
        );
      }
      recordPhase?.("readFile.active", readResult.activeMs);
      recordPhase?.("readFile.queue", readResult.queuedMs);
      recordFilePhase?.(
        "readFile.active",
        fileMeta.path,
        readResult.activeMs,
        Buffer.byteLength(content, "utf8"),
      );
      recordFilePhase?.(
        "readFile.queue",
        fileMeta.path,
        readResult.queuedMs,
        Buffer.byteLength(content, "utf8"),
      );
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
    } finally {
      readElapsedMs = Date.now() - readStartedAt;
      recordPhase?.("readFile", readElapsedMs);
    }
    recordFilePhase?.(
      "readFile",
      fileMeta.path,
      readElapsedMs,
      Buffer.byteLength(content, "utf8"),
    );
  }
  const contentBytes = Buffer.byteLength(content, "utf8");
  recordMetric?.("readFile.bytes", contentBytes);

  let phaseStartedAt = Date.now();
  const tree = adapter.parse(content, filePath);
  const parseElapsedMs = Date.now() - phaseStartedAt;
  recordPhase?.("parse", parseElapsedMs);
  recordFilePhase?.("parse", fileMeta.path, parseElapsedMs, contentBytes);
  if (!tree) {
    return 0;
  }

  let extractedSymbols: ExtractedSymbol[];
  let calls: ExtractedCall[];
  let usingNamespaces: Set<string>;
  phaseStartedAt = Date.now();
  try {
    let extractStepStartedAt = Date.now();
    extractedSymbols = adapter.extractSymbols(
      tree,
      content,
      filePath,
    ) as ExtractedSymbol[];
    const extractSymbolsElapsedMs = Date.now() - extractStepStartedAt;
    recordPhase?.("extract.symbols", extractSymbolsElapsedMs);
    recordFilePhase?.(
      "extract.symbols",
      fileMeta.path,
      extractSymbolsElapsedMs,
      contentBytes,
    );

    extractStepStartedAt = Date.now();
    calls = adapter.extractCalls(
      tree,
      content,
      filePath,
      extractedSymbols as never,
    ) as ExtractedCall[];
    const extractCallsElapsedMs = Date.now() - extractStepStartedAt;
    recordPhase?.("extract.calls", extractCallsElapsedMs);
    recordFilePhase?.(
      "extract.calls",
      fileMeta.path,
      extractCallsElapsedMs,
      contentBytes,
    );

    extractStepStartedAt = Date.now();
    usingNamespaces = extractUsingNamespaces(tree);
    const extractUsingNamespacesElapsedMs = Date.now() - extractStepStartedAt;
    recordPhase?.(
      "extract.usingNamespaces",
      extractUsingNamespacesElapsedMs,
    );
    recordFilePhase?.(
      "extract.usingNamespaces",
      fileMeta.path,
      extractUsingNamespacesElapsedMs,
      contentBytes,
    );
    recordMetric?.("symbols.extracted", extractedSymbols.length);
    recordMetric?.("calls.extracted", calls.length);
    recordMetric?.("namespaces.using", usingNamespaces.size);
  } finally {
    (tree as unknown as { delete?: () => void }).delete?.();
    const extractElapsedMs = Date.now() - phaseStartedAt;
    recordPhase?.("extract", extractElapsedMs);
    recordFilePhase?.("extract", fileMeta.path, extractElapsedMs, contentBytes);
  }

  phaseStartedAt = Date.now();
  let includeIndex = getCachedCppIncludeIndex(cache, repoId);
  if (includeIndex) {
    recordMetric?.("includeIndex.valueCacheHits", 1);
  } else {
    includeIndex = await buildCppIncludeIndex({
      repoId,
      repoRoot,
      cache,
      importCache,
      targetPaths: pass2TargetPaths,
      recordMetric,
      recordPhase,
      pass1Extractions,
    });
  }
  recordPhase?.("includeIndex", Date.now() - phaseStartedAt);
  const existingSymbols =
    includeIndex.symbolsByFilePath.get(fileMeta.path) ?? [];
  if (existingSymbols.length === 0) {
    return 0;
  }

  phaseStartedAt = Date.now();
  const filteredSymbolDetails = mapExtractedSymbolsToExisting(
    fileMeta.path,
    extractedSymbols,
    existingSymbols,
    telemetry,
  );
  recordPhase?.("mapSymbols", Date.now() - phaseStartedAt);
  recordMetric?.("symbols.mapped", filteredSymbolDetails.length);
  if (filteredSymbolDetails.length === 0) {
    return 0;
  }

  const symbolIdsToRefresh = filteredSymbolDetails.map(
    (detail) => detail.symbolId,
  );
  clearLocalCallDedupKeys(symbolIdsToRefresh, createdCallEdges);

  const nodeIdToSymbolId = createNodeIdToSymbolId(filteredSymbolDetails);

  for (const namespaceName of includeIndex.namespaceByFilePath.get(
    fileMeta.path,
  ) ?? []) {
    if (namespaceName) {
      usingNamespaces.add(namespaceName);
    }
  }

  phaseStartedAt = Date.now();
  const includeNameToSymbolIds = createNameIndexFromSymbols(
    includeIndex.includedSymbolsByFilePath.get(fileMeta.path) ?? [],
  );
  recordPhase?.("includeNameIndex", Date.now() - phaseStartedAt);
  phaseStartedAt = Date.now();
  const headerPairNameToSymbolIds = buildHeaderPairNameIndex({
    currentFilePath: fileMeta.path,
    filesByRelPath: includeIndex.filesByRelPath,
    symbolsByFilePath: includeIndex.symbolsByFilePath,
  });
  recordPhase?.("headerPairIndex", Date.now() - phaseStartedAt);
  phaseStartedAt = Date.now();
  const sameDirectoryNameToSymbolIds = buildSameDirectoryNameIndex({
    currentFilePath: fileMeta.path,
    symbolsByFilePath: includeIndex.symbolsByFilePath,
  });
  recordPhase?.("sameDirectoryIndex", Date.now() - phaseStartedAt);

  const now = new Date().toISOString();
  const edgesToInsert: ladybugDb.EdgeRow[] = [];
  let createdEdges = 0;
  phaseStartedAt = Date.now();
  const callsByCallerNodeId = groupCallsByCallerSymbol(
    calls,
    filteredSymbolDetails,
  );
  recordPhase?.("groupCalls", Date.now() - phaseStartedAt);

  phaseStartedAt = Date.now();
  for (const detail of filteredSymbolDetails) {
    for (const call of
      callsByCallerNodeId.get(detail.extractedSymbol.nodeId) ?? []) {
      const resolved = resolveCppPass2CallTarget({
        call,
        nodeIdToSymbolId,
        includeNameToSymbolIds,
        namespaceMembersByNamespace: includeIndex.namespaceMembersByNamespace,
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
        const unresolvedTargetId = unresolvedCallSymbolId(resolved.targetName);
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
          targetMeta: unresolvedCallDependencyTarget(resolved.targetName),
        });
        createdCallEdges.add(edgeKey);
        createdEdges++;
      }
    }
  }
  recordPhase?.("resolveCalls", Date.now() - phaseStartedAt);
  recordMetric?.("edges.buffered", edgesToInsert.length);

  phaseStartedAt = Date.now();
  if (submitEdgeWrite) {
    const submitted = submitEdgeWrite({
      symbolIdsToRefresh,
      edges: edgesToInsert,
    });
    if (submitted) {
      await submitted;
    }
  } else {
    await withWriteConn(async (wConn) => {
      if (mode !== "full" && symbolIdsToRefresh.length > 0) {
        await ladybugDb.deleteOutgoingEdgesByTypeForSymbols(
          wConn,
          symbolIdsToRefresh,
          "call",
        );
      }
      await ladybugDb.insertEdges(wConn, edgesToInsert);
    });
  }
  recordPhase?.("writeSubmit", Date.now() - phaseStartedAt);
  return createdEdges;
}

export class CppPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-cpp";

  supports(target: Pass2Target): boolean {
    return (
      target.language === "cpp" && CPP_PASS2_EXTENSIONS.has(target.extension)
    );
  }

  async warmup(
    targets: readonly Pass2Target[],
    context: Pass2ResolverContext,
  ): Promise<void> {
    const repoId = targets.find((target) => target.repoId)?.repoId;
    if (!repoId) {
      return;
    }
    await buildCppIncludeIndex({
      repoId,
      repoRoot: context.repoRoot,
      cache: context.cache,
      importCache: context.importCache,
      targetPaths: context.pass2TargetPaths,
      recordMetric: context.recordMetric,
      recordPhase: context.recordPhase,
      pass1Extractions: context.pass1Extractions,
    });
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
        mode: context.mode,
        submitEdgeWrite: context.submitEdgeWrite,
        importCache: context.importCache,
        recordPhase: context.recordPhase,
        recordMetric: context.recordMetric,
        recordFilePhase: context.recordFilePhase,
        pass2TargetPaths: context.pass2TargetPaths,
        pass1Extractions: context.pass1Extractions,
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
  buildCppNamespaceIndexFromRows,
  buildHeaderPairCandidatePaths,
  extractUsingNamespaces,
  getCachedCppIncludeIndex,
  groupCallsByCallerSymbol,
  normalizeIdentifier,
  resolveCppPass2CallTarget,
};
