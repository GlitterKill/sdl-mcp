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

type CResolvedCall = {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  resolution: string;
  targetName?: string;
  candidateCount?: number;
};

type CRepoIndex = {
  fileByRelPath: Map<
    string,
    { fileId: string; relPath: string; language: string }
  >;
  symbolsByFileId: Map<string, SymbolRow[]>;
  symbolsByRelPath: Map<string, SymbolRow[]>;
  cFileIds: Set<string>;
};

const C_PASS2_EXTENSIONS = new Set([".c", ".h"]);

function isCallableKind(kind: SymbolKind): boolean {
  return kind === "function" || kind === "method" || kind === "constructor";
}

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

function pushUniqueSymbolId(
  map: Map<string, string[]>,
  key: string,
  symbolId: string,
): void {
  const existing = map.get(key) ?? [];
  if (!existing.includes(symbolId)) {
    existing.push(symbolId);
  }
  map.set(key, existing);
}

function addCallableSymbolsByName(
  map: Map<string, string[]>,
  symbols: SymbolRow[],
): void {
  for (const symbol of symbols) {
    if (!isCallableKind(symbol.kind as SymbolKind)) {
      continue;
    }
    pushUniqueSymbolId(map, symbol.name, symbol.symbolId);
  }
}

async function buildCRepoIndex(
  repoId: string,
  cache?: Map<string, unknown>,
): Promise<CRepoIndex> {
  const cacheKey = `pass2-c:repo-index:${repoId}`;
  const cached = cache?.get(cacheKey);
  if (cached) {
    return cached as CRepoIndex;
  }

  const conn = await getLadybugConn();
  const repoFiles = await ladybugDb.getFilesByRepo(conn, repoId);
  const cFiles = repoFiles.filter((file) => file.language === "c");
  const cFileIds = new Set(cFiles.map((file) => file.fileId));

  const fileByRelPath = new Map<
    string,
    { fileId: string; relPath: string; language: string }
  >();
  for (const file of cFiles) {
    fileByRelPath.set(file.relPath, {
      fileId: file.fileId,
      relPath: file.relPath,
      language: file.language,
    });
  }

  const symbolsByFileId = new Map<string, SymbolRow[]>();
  const symbolsByRelPath = new Map<string, SymbolRow[]>();
  const repoSymbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  for (const symbol of repoSymbols) {
    if (!cFileIds.has(symbol.fileId)) {
      continue;
    }
    const byId = symbolsByFileId.get(symbol.fileId) ?? [];
    byId.push(symbol);
    symbolsByFileId.set(symbol.fileId, byId);
  }

  for (const file of cFiles) {
    symbolsByRelPath.set(file.relPath, symbolsByFileId.get(file.fileId) ?? []);
  }

  const index: CRepoIndex = {
    fileByRelPath,
    symbolsByFileId,
    symbolsByRelPath,
    cFileIds,
  };
  cache?.set(cacheKey, index);
  return index;
}

function inferFileExtension(relPath: string): ".c" | ".h" | "" {
  const normalized = relPath.toLowerCase();
  if (normalized.endsWith(".c")) {
    return ".c";
  }
  if (normalized.endsWith(".h")) {
    return ".h";
  }
  return "";
}

function toHeaderPath(relPath: string): string | null {
  if (!relPath.toLowerCase().endsWith(".c")) {
    return null;
  }
  return normalizePath(`${relPath.slice(0, -2)}.h`);
}

function toSourcePath(relPath: string): string | null {
  if (!relPath.toLowerCase().endsWith(".h")) {
    return null;
  }
  return normalizePath(`${relPath.slice(0, -2)}.c`);
}

function parseResolvedPathFromProvenance(provenance: string): string | null {
  if (!provenance || provenance.startsWith("cross-language:")) {
    return null;
  }

  const stripped = provenance.startsWith("unresolved:")
    ? provenance.slice("unresolved:".length)
    : provenance;
  const colonIndex = stripped.indexOf(":");
  if (colonIndex <= 0) {
    return null;
  }

  const candidate = normalizePath(stripped.slice(0, colonIndex));
  if (
    candidate.endsWith(".c") ||
    candidate.endsWith(".h") ||
    candidate.includes("/")
  ) {
    return candidate;
  }

  return null;
}

function toUniquePaths(paths: Iterable<string>): string[] {
  return Array.from(new Set(paths));
}

async function buildIncludedSymbolIndex(params: {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  imports: Array<{
    specifier: string;
    imports: string[];
    isRelative: boolean;
    isExternal: boolean;
    isReExport: boolean;
    defaultImport?: string;
    namespaceImport?: string;
  }>;
  adapterExtensions: string[];
  content: string;
  repoIndex: CRepoIndex;
}): Promise<{
  includedNameToSymbolIds: Map<string, string[]>;
  includedHeaderRelPaths: Set<string>;
}> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    imports,
    adapterExtensions,
    content,
    repoIndex,
  } = params;

  const importResolution = await resolveImportTargets(
    repoId,
    repoRoot,
    fileMeta.path,
    imports,
    adapterExtensions,
    "c",
    content,
  );

  const includedRelPaths = new Set<string>();
  for (const target of importResolution.targets) {
    const relPath = parseResolvedPathFromProvenance(target.provenance);
    if (relPath) {
      includedRelPaths.add(relPath);
    }
  }

  const includedNameToSymbolIds = new Map<string, string[]>();
  const includedHeaderRelPaths = new Set<string>();
  for (const relPath of includedRelPaths) {
    const file = repoIndex.fileByRelPath.get(relPath);
    if (!file) {
      continue;
    }
    if (inferFileExtension(relPath) === ".h") {
      includedHeaderRelPaths.add(relPath);
    }
    const symbols = repoIndex.symbolsByFileId.get(file.fileId) ?? [];
    addCallableSymbolsByName(includedNameToSymbolIds, symbols);
  }

  return {
    includedNameToSymbolIds,
    includedHeaderRelPaths,
  };
}

function buildHeaderPairNameIndex(params: {
  currentFilePath: string;
  includedHeaderRelPaths: Set<string>;
  repoIndex: CRepoIndex;
}): Map<string, string[]> {
  const { currentFilePath, includedHeaderRelPaths, repoIndex } = params;
  const pairPaths = new Set<string>();

  const extension = inferFileExtension(currentFilePath);
  if (extension === ".c") {
    const pairHeaderPath = toHeaderPath(currentFilePath);
    if (pairHeaderPath) {
      pairPaths.add(pairHeaderPath);
    }
  } else if (extension === ".h") {
    const pairSourcePath = toSourcePath(currentFilePath);
    if (pairSourcePath) {
      pairPaths.add(pairSourcePath);
    }
  }

  for (const headerPath of includedHeaderRelPaths) {
    const pairSourcePath = toSourcePath(headerPath);
    if (pairSourcePath) {
      pairPaths.add(pairSourcePath);
    }
  }

  const headerPairNameToSymbolIds = new Map<string, string[]>();
  for (const pairPath of pairPaths) {
    const file = repoIndex.fileByRelPath.get(pairPath);
    if (!file) {
      continue;
    }
    const symbols = repoIndex.symbolsByFileId.get(file.fileId) ?? [];
    addCallableSymbolsByName(headerPairNameToSymbolIds, symbols);
  }

  return headerPairNameToSymbolIds;
}

function buildSameDirectoryNameIndex(params: {
  currentFilePath: string;
  repoIndex: CRepoIndex;
}): Map<string, string[]> {
  const { currentFilePath, repoIndex } = params;
  const currentDir = normalizePath(dirname(currentFilePath));

  const sameDirectoryNameToSymbolIds = new Map<string, string[]>();
  for (const [relPath, file] of repoIndex.fileByRelPath) {
    if (relPath === currentFilePath) {
      continue;
    }
    if (normalizePath(dirname(relPath)) !== currentDir) {
      continue;
    }

    const symbols = repoIndex.symbolsByFileId.get(file.fileId) ?? [];
    addCallableSymbolsByName(sameDirectoryNameToSymbolIds, symbols);
  }

  return sameDirectoryNameToSymbolIds;
}

function toUniqueCandidates(candidates: string[] | undefined): string[] {
  if (!candidates || candidates.length === 0) {
    return [];
  }
  return Array.from(new Set(candidates));
}

function resolveCPass2CallTarget(params: {
  call: ExtractedCall;
  nodeIdToSymbolId: Map<string, string>;
  includedNameToSymbolIds: Map<string, string[]>;
  headerPairNameToSymbolIds: Map<string, string[]>;
  sameDirectoryNameToSymbolIds: Map<string, string[]>;
  globalNameToSymbolIds?: Map<string, string[]>;
}): CResolvedCall | null {
  const {
    call,
    nodeIdToSymbolId,
    includedNameToSymbolIds,
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

  const identifier = call.calleeIdentifier.replace(/^new\s+/, "").trim();
  if (!identifier || identifier.includes(".")) {
    return null;
  }

  const includeCandidates = toUniqueCandidates(
    includedNameToSymbolIds.get(identifier),
  );
  if (includeCandidates.length === 1) {
    return {
      symbolId: includeCandidates[0],
      isResolved: true,
      confidence: 0.9,
      resolution: "include-matched",
    };
  }

  const headerPairCandidates = toUniqueCandidates(
    headerPairNameToSymbolIds.get(identifier),
  );
  if (headerPairCandidates.length === 1) {
    return {
      symbolId: headerPairCandidates[0],
      isResolved: true,
      confidence: 0.88,
      resolution: "header-pair",
    };
  }

  const sameDirectoryCandidates = toUniqueCandidates(
    sameDirectoryNameToSymbolIds.get(identifier),
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
    globalNameToSymbolIds?.get(identifier),
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

function createImportLanguageExtensions(languages: string[]): string[] {
  const normalized = languages
    .map((language) => language.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((language) =>
      language.startsWith(".") ? [language] : [`.${language}`],
    );

  return toUniquePaths([...normalized, ".c", ".h"]);
}

function walkNodes(
  node: SyntaxNode,
  predicate: (candidate: SyntaxNode) => void,
): void {
  predicate(node);
  for (const child of node.children) {
    walkNodes(child, predicate);
  }
}

function collectIncludeImportFallbacks(tree: Tree): Array<{
  specifier: string;
  imports: string[];
  isRelative: boolean;
  isExternal: boolean;
  isReExport: boolean;
}> {
  const imports: Array<{
    specifier: string;
    imports: string[];
    isRelative: boolean;
    isExternal: boolean;
    isReExport: boolean;
  }> = [];

  walkNodes(tree.rootNode, (node) => {
    if (node.type !== "preproc_include") {
      return;
    }
    const pathNode = node.childForFieldName("path");
    const rawPath = pathNode?.text ?? "";
    if (!rawPath) {
      return;
    }
    const isLocalInclude = rawPath.startsWith('"') && rawPath.endsWith('"');
    const isSystemInclude = rawPath.startsWith("<") && rawPath.endsWith(">");
    if (!isLocalInclude && !isSystemInclude) {
      return;
    }
    const specifier = rawPath.slice(1, -1).trim();
    if (!specifier) {
      return;
    }

    imports.push({
      specifier,
      imports: [specifier],
      isRelative: isLocalInclude && specifier.startsWith("."),
      isExternal: isSystemInclude,
      isReExport: false,
    });
  });

  return imports;
}

async function resolveCCallEdgesPass2(params: {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  languages: string[];
  createdCallEdges: Set<string>;
  globalNameToSymbolIds?: Map<string, string[]>;
  telemetry?: Pass2ResolverContext["telemetry"];
  cache?: Map<string, unknown>;
}): Promise<number> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    languages,
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
        `File disappeared before C pass2 resolution: ${fileMeta.path}`,
        {
          code,
        },
      );
      return 0;
    }
    throw readError;
  }

  const inferredExtension = inferFileExtension(fileMeta.path);
  if (!inferredExtension) {
    return 0;
  }

  const adapter = getAdapterForExtension(inferredExtension);
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
  const repoIndex = await buildCRepoIndex(repoId, cache);

  const importsForResolution =
    imports.length > 0 ? imports : collectIncludeImportFallbacks(tree);
  const includeIndex = await buildIncludedSymbolIndex({
    repoId,
    repoRoot,
    fileMeta,
    imports: importsForResolution,
    adapterExtensions: createImportLanguageExtensions(languages),
    content,
    repoIndex,
  });
  const headerPairNameToSymbolIds = buildHeaderPairNameIndex({
    currentFilePath: fileMeta.path,
    includedHeaderRelPaths: includeIndex.includedHeaderRelPaths,
    repoIndex,
  });
  const sameDirectoryNameToSymbolIds = buildSameDirectoryNameIndex({
    currentFilePath: fileMeta.path,
    repoIndex,
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

      const resolved = resolveCPass2CallTarget({
        call,
        nodeIdToSymbolId,
        includedNameToSymbolIds: includeIndex.includedNameToSymbolIds,
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
          resolverId: "pass2-c",
          resolutionPhase: "pass2",
          provenance: `c-call:${call.calleeIdentifier}`,
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
          resolverId: "pass2-c",
          resolutionPhase: "pass2",
          provenance: `unresolved-c-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
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

export class CPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-c";

  supports(target: Pass2Target): boolean {
    return target.language === "c" && C_PASS2_EXTENSIONS.has(target.extension);
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    if (!target.repoId) {
      throw new Error("CPass2Resolver requires target.repoId");
    }

    try {
      const edgesCreated = await resolveCCallEdgesPass2({
        repoId: target.repoId,
        repoRoot: context.repoRoot,
        fileMeta: {
          path: target.filePath,
          size: 0,
          mtime: 0,
        },
        languages: context.languages,
        createdCallEdges: context.createdCallEdges,
        globalNameToSymbolIds: context.globalNameToSymbolIds,
        telemetry: context.telemetry,
        cache: context.cache,
      });
      return { edgesCreated };
    } catch (error) {
      logger.warn(
        `C pass2 resolution failed for ${target.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { edgesCreated: 0 };
    }
  }
}
