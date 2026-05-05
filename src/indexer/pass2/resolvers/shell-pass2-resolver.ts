import { dirname, join } from "path";

import type { Tree } from "tree-sitter";

import { getLadybugConn, withWriteConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import type { SymbolRow } from "../../../db/ladybug-queries.js";
import type { SymbolKind } from "../../../domain/types.js";
import { readFileAsync } from "../../../util/asyncFs.js";
import { singleFlight } from "../../../util/concurrency.js";
import { logger } from "../../../util/logger.js";
import { normalizePath } from "../../../util/paths.js";
import { getAdapterForExtension } from "../../adapter/registry.js";
import { resolveImportTargets } from "../../edge-builder/import-resolution.js";
import { findEnclosingSymbolByRange } from "../../edge-builder/enclosing-symbol.js";
import type { FileMetadata } from "../../fileScanner.js";
import type { ExtractedImport } from "../../treesitter/extractImports.js";
import type {
  Pass2Resolver,
  Pass2ResolverContext,
  Pass2ResolverResult,
  Pass2Target,
} from "../types.js";
import { confidenceFor } from "../confidence.js";
import { collectCommandEvalCallSites } from "./shell-pass2-helpers.js";

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

type ShellResolvedCall = {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  resolution: string;
  targetName?: string;
  candidateCount?: number;
};

type ShellRepoIndex = {
  directoryByFilePath: Map<string, string>;
  symbolsByDirectory: Map<string, Array<SymbolRow & { relPath: string }>>;
};

const SHELL_PASS2_EXTENSIONS = new Set([".sh", ".bash"]);

/**
 * Extra confidence for a same-file call whose tree-sitter node id matches an
 * existing symbol exactly. Slightly above the generic `same-file-lexical`
 * legacy tier because the nodeId match is effectively unambiguous.
 */
const SHELL_SAME_FILE_EXACT_CONFIDENCE = 0.93;

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

async function buildShellRepoIndex(
  repoId: string,
  cache?: Map<string, unknown>,
): Promise<ShellRepoIndex> {
  return singleFlight(cache, `pass2-shell:repo-index:${repoId}`, async () => {
    const conn = await getLadybugConn();
    const repoFiles = await ladybugDb.getFilesByRepo(conn, repoId);
    const shellFiles = repoFiles.filter((file) => file.language === "shell");
    const shellFileIds = new Set(shellFiles.map((file) => file.fileId));
    const fileById = new Map(shellFiles.map((file) => [file.fileId, file]));

    const directoryByFilePath = new Map<string, string>();
    const symbolsByDirectory = new Map<
      string,
      Array<SymbolRow & { relPath: string }>
    >();

    for (const file of shellFiles) {
      directoryByFilePath.set(
        file.relPath,
        normalizePath(dirname(file.relPath)),
      );
    }

    const repoSymbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
    for (const symbol of repoSymbols) {
      if (!shellFileIds.has(symbol.fileId)) {
        continue;
      }
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

    return { directoryByFilePath, symbolsByDirectory };
  });
}

function buildSameDirectoryFunctionIndex(
  currentFilePath: string,
  sameDirectorySymbols: Array<SymbolRow & { relPath: string }>,
): Map<string, string[]> {
  const sameDirectoryNameToSymbolIds = new Map<string, string[]>();
  for (const symbol of sameDirectorySymbols) {
    if (symbol.relPath === currentFilePath) {
      continue;
    }
    if (symbol.kind !== "function") {
      continue;
    }
    const existing = sameDirectoryNameToSymbolIds.get(symbol.name) ?? [];
    existing.push(symbol.symbolId);
    sameDirectoryNameToSymbolIds.set(symbol.name, existing);
  }
  return sameDirectoryNameToSymbolIds;
}

function parseRelPathFromProvenance(provenance: string): string | null {
  if (!provenance || provenance.startsWith("cross-language:")) {
    return null;
  }
  const colonIndex = provenance.indexOf(":");
  if (colonIndex <= 0) {
    return null;
  }
  const relPath = provenance.slice(0, colonIndex).trim();
  if (!relPath || relPath.startsWith("unresolved:")) {
    return null;
  }
  return normalizePath(relPath);
}

async function buildSourceFunctionIndex(params: {
  conn: import("kuzu").Connection;
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  imports: ExtractedImport[];
  extensions: string[];
  content: string;
  cache?: Map<string, unknown>;
  importCache?: Pass2ResolverContext["importCache"];
}): Promise<Map<string, string[]>> {
  const {
    conn,
    repoId,
    repoRoot,
    fileMeta,
    imports,
    extensions,
    content,
    cache,
    importCache,
  } = params;
  const importResolution = await resolveImportTargets(
    repoId,
    repoRoot,
    fileMeta.path,
    imports,
    extensions,
    "shell",
    content,
    importCache,
  );

  const sourceFilePaths = new Set<string>();
  for (const target of importResolution.targets) {
    const relPath = parseRelPathFromProvenance(target.provenance);
    if (relPath) {
      sourceFilePaths.add(relPath);
    }
  }

  const sourceNameToSymbolIds = new Map<string, string[]>();
  for (const relPath of sourceFilePaths) {
    const sourceFunctions = await singleFlight(
      cache,
      `pass2-shell:source-fns:${repoId}:${relPath}`,
      async (): Promise<SymbolRow[]> => {
        const sourceFile = await ladybugDb.getFileByRepoPath(
          conn,
          repoId,
          relPath,
        );
        if (!sourceFile || sourceFile.language !== "shell") {
          return [];
        }
        return (
          await ladybugDb.getSymbolsByFile(conn, sourceFile.fileId)
        ).filter((symbol) => symbol.kind === "function");
      },
    );

    for (const symbol of sourceFunctions) {
      const existing = sourceNameToSymbolIds.get(symbol.name) ?? [];
      existing.push(symbol.symbolId);
      sourceNameToSymbolIds.set(symbol.name, existing);
    }
  }

  return sourceNameToSymbolIds;
}

function resolveShellPass2CallTarget(params: {
  call: ExtractedCall;
  nodeIdToSymbolId: Map<string, string>;
  sourceNameToSymbolIds: Map<string, string[]>;
  sameDirectoryNameToSymbolIds: Map<string, string[]>;
  globalNameToSymbolIds?: Map<string, string[]>;
}): ShellResolvedCall | null {
  const {
    call,
    nodeIdToSymbolId,
    sourceNameToSymbolIds,
    sameDirectoryNameToSymbolIds,
    globalNameToSymbolIds,
  } = params;

  if (call.calleeSymbolId && nodeIdToSymbolId.has(call.calleeSymbolId)) {
    return {
      symbolId: nodeIdToSymbolId.get(call.calleeSymbolId) ?? null,
      isResolved: true,
      confidence: SHELL_SAME_FILE_EXACT_CONFIDENCE,
      resolution: "same-file",
    };
  }

  const identifier = call.calleeIdentifier.trim();
  if (!identifier) {
    return null;
  }

  const sourceCandidates = sourceNameToSymbolIds.get(identifier);
  if (sourceCandidates && sourceCandidates.length === 1) {
    return {
      symbolId: sourceCandidates[0],
      isResolved: true,
      confidence: confidenceFor("import-direct"),
      resolution: "source-matched",
    };
  }

  const sameDirectoryCandidates = sameDirectoryNameToSymbolIds.get(identifier);
  if (sameDirectoryCandidates && sameDirectoryCandidates.length === 1) {
    return {
      symbolId: sameDirectoryCandidates[0],
      isResolved: true,
      confidence: confidenceFor("cross-file-name-unique"),
      resolution: "same-directory",
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
      (sourceCandidates?.length ?? 0) +
      (sameDirectoryCandidates?.length ?? 0) +
      (globalCandidates?.length ?? 0),
  };
}

async function resolveShellCallEdgesPass2(params: {
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
        `File disappeared before Shell pass2 resolution: ${fileMeta.path}`,
        {
          code,
        },
      );
      return 0;
    }
    throw readError;
  }

  const adapter = getAdapterForExtension(
    fileMeta.path.endsWith(".bash") ? ".bash" : ".sh",
  );
  if (!adapter || adapter.languageId !== "shell") {
    return 0;
  }

  const tree: Tree | null = adapter.parse(content, filePath);
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
    // Phase 2 Task 2.10.1 -- recognize `command foo` and `eval "foo"` as
    // indirect call sites that the default extractor treats as external.
    const indirectCalls = collectCommandEvalCallSites(tree.rootNode);
    if (indirectCalls.length > 0) {
      calls = calls.concat(indirectCalls);
    }
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
  clearLocalCallDedupKeys(symbolIdsToRefresh, createdCallEdges);

  const nodeIdToSymbolId = createNodeIdToSymbolId(filteredSymbolDetails);
  const sourceNameToSymbolIds = await buildSourceFunctionIndex({
    conn,
    repoId,
    repoRoot,
    fileMeta,
    imports,
    extensions: [...adapter.fileExtensions],
    content,
    cache,
    importCache,
  });

  const repoIndex = await buildShellRepoIndex(repoId, cache);
  const currentDirectory = repoIndex.directoryByFilePath.get(fileMeta.path);
  const sameDirectorySymbols = currentDirectory
    ? (repoIndex.symbolsByDirectory.get(currentDirectory) ?? [])
    : [];
  const sameDirectoryNameToSymbolIds = buildSameDirectoryFunctionIndex(
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

      const resolved = resolveShellPass2CallTarget({
        call,
        nodeIdToSymbolId,
        sourceNameToSymbolIds,
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
          resolverId: "pass2-shell",
          resolutionPhase: "pass2",
          provenance: `shell-call:${call.calleeIdentifier}`,
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
          resolverId: "pass2-shell",
          resolutionPhase: "pass2",
          provenance: `unresolved-shell-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
          createdAt: now,
        });
        createdCallEdges.add(edgeKey);
        createdEdges++;
      }
    }
  }

  if (submitEdgeWrite) {
    await submitEdgeWrite({
      symbolIdsToRefresh,
      edges: edgesToInsert,
    });
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
  return createdEdges;
}

export class ShellPass2Resolver implements Pass2Resolver {
  readonly id = "pass2-shell";

  supports(target: Pass2Target): boolean {
    return (
      target.language === "shell" &&
      SHELL_PASS2_EXTENSIONS.has(target.extension)
    );
  }

  async resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult> {
    if (!target.repoId) {
      throw new Error("ShellPass2Resolver requires target.repoId");
    }

    try {
      const edgesCreated = await resolveShellCallEdgesPass2({
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
      });
      return { edgesCreated };
    } catch (error) {
      logger.warn(
        `Shell pass2 resolution failed for ${target.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { edgesCreated: 0 };
    }
  }
}
