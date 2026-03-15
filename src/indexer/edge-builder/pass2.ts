import { join } from "path";

import type { SymbolKind } from "../../db/schema.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { readFileAsync } from "../../util/asyncFs.js";
import { logger } from "../../util/logger.js";
import { getAdapterForExtension } from "../adapter/registry.js";
import type { FileMetadata } from "../fileScanner.js";

import { isBuiltinCall } from "./builtins.js";
import { resolveCallTarget } from "./call-resolution.js";
import { resolveImportTargets } from "./import-resolution.js";
import { resolveSymbolIdFromIndex } from "./symbol-index.js";
import {
  incRecord,
  isTsCallResolutionFile,
  pushTelemetrySample,
} from "./telemetry.js";
import type { CallResolutionTelemetry } from "./telemetry.js";
import type { SymbolIndex, TsCallResolver } from "./types.js";

async function resolvePass2Targets(params: {
  repoId: string;
  mode: "full" | "incremental";
  pass2Files: FileMetadata[];
  changedPass2FilePaths: Set<string>;
  supportsPass2FilePath?: (relPath: string) => boolean;
}): Promise<FileMetadata[]> {
  const {
    repoId,
    mode,
    pass2Files,
    changedPass2FilePaths,
    supportsPass2FilePath = isTsCallResolutionFile,
  } = params;
  if (mode === "full") {
    return pass2Files;
  }
  if (changedPass2FilePaths.size === 0) {
    return [];
  }

  const conn = await getLadybugConn();

  const pass2FilesByPath = new Map(pass2Files.map((file) => [file.path, file]));
  const targetPaths = new Set<string>(changedPass2FilePaths);
  const changedSymbolIds = new Set<string>();

  for (const changedPath of changedPass2FilePaths) {
    const file = await ladybugDb.getFileByRepoPath(conn, repoId, changedPath);
    if (!file) continue;
    const symbolIds = await ladybugDb.getSymbolIdsByFile(conn, file.fileId);
    for (const symbolId of symbolIds) {
      changedSymbolIds.add(symbolId);
    }
  }

  if (changedSymbolIds.size === 0) {
    return Array.from(targetPaths)
      .map((path) => pass2FilesByPath.get(path))
      .filter((file): file is FileMetadata => Boolean(file));
  }

  const incomingByToSymbol = await ladybugDb.getEdgesToSymbols(
    conn,
    Array.from(changedSymbolIds),
  );

  const importerSymbolIds = new Set<string>();
  for (const edges of incomingByToSymbol.values()) {
    for (const edge of edges) {
      if (edge.edgeType !== "import") continue;
      importerSymbolIds.add(edge.fromSymbolId);
    }
  }

  if (importerSymbolIds.size === 0) {
    return Array.from(targetPaths)
      .map((path) => pass2FilesByPath.get(path))
      .filter((file): file is FileMetadata => Boolean(file));
  }

  const importerSymbols = await ladybugDb.getSymbolsByIds(
    conn,
    Array.from(importerSymbolIds),
  );
  const fileIds = new Set<string>();
  for (const symbol of importerSymbols.values()) {
    fileIds.add(symbol.fileId);
  }

  const importerFiles = await ladybugDb.getFilesByIds(
    conn,
    Array.from(fileIds),
  );
  for (const symbol of importerSymbols.values()) {
    const file = importerFiles.get(symbol.fileId);
    if (!file) continue;
    if (!supportsPass2FilePath(file.relPath)) continue;
    targetPaths.add(file.relPath);
  }

  return Array.from(targetPaths)
    .map((path) => pass2FilesByPath.get(path))
    .filter((file): file is FileMetadata => Boolean(file));
}

async function resolveTsCallEdgesPass2(params: {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  symbolIndex: SymbolIndex;
  tsResolver: TsCallResolver | null;
  languages: string[];
  createdCallEdges: Set<string>;
  globalNameToSymbolIds?: Map<string, string[]>;
  telemetry?: CallResolutionTelemetry;
}): Promise<number> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    symbolIndex,
    tsResolver,
    languages,
    createdCallEdges,
    globalNameToSymbolIds,
    telemetry,
  } = params;
  if (!isTsCallResolutionFile(fileMeta.path)) {
    return 0;
  }

  try {
    const conn = await getLadybugConn();
    const filePath = join(repoRoot, fileMeta.path);
    let content: string;
    try {
      content = await readFileAsync(filePath, "utf-8");
    } catch (readError: unknown) {
      const code = (readError as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EPERM") {
        logger.warn(
          `File disappeared before pass2 resolution: ${fileMeta.path}`,
          { code },
        );
        return 0;
      }
      throw readError;
    }
    const ext = fileMeta.path.split(".").pop() || "";
    const extWithDot = `.${ext}`;
    const adapter = getAdapterForExtension(extWithDot);
    if (!adapter) {
      return 0;
    }

    const tree = adapter.parse(content, filePath);
    if (!tree) {
      return 0;
    }

    const extractedSymbols = adapter.extractSymbols(tree, content, filePath);
    if (telemetry) {
      telemetry.pass2SymbolMapping.extractedSymbols += extractedSymbols.length;
    }
    const symbolsWithNodeIds = extractedSymbols.map((symbol) => ({
      nodeId: symbol.nodeId,
      kind: symbol.kind,
      name: symbol.name,
      exported: symbol.exported,
      range: symbol.range,
      signature: symbol.signature,
      visibility: symbol.visibility,
    }));
    const imports = adapter.extractImports(tree, content, filePath);
    const calls = adapter.extractCalls(
      tree,
      content,
      filePath,
      symbolsWithNodeIds,
    );

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
    if (telemetry) {
      telemetry.pass2SymbolMapping.existingSymbols += existingSymbols.length;
    }

    if (existingSymbols.length === 0) {
      if (telemetry) telemetry.pass2FilesNoExistingSymbols++;
      if (telemetry) {
        pushTelemetrySample(telemetry.samples.noMappedSymbols, fileMeta.path);
      }
      return 0;
    }

    const toFullKey = (
      kind: SymbolKind,
      name: string,
      range: {
        startLine: number;
        startCol: number;
        endLine: number;
        endCol: number;
      },
    ): string =>
      `${kind}:${name}:${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;

    const toStartKey = (
      kind: SymbolKind,
      name: string,
      range: {
        startLine: number;
        startCol: number;
      },
    ): string => `${kind}:${name}:${range.startLine}:${range.startCol}`;

    const toStartLineKey = (
      kind: SymbolKind,
      name: string,
      range: {
        startLine: number;
      },
    ): string => `${kind}:${name}:${range.startLine}`;

    const toNameKindKey = (kind: SymbolKind, name: string): string =>
      `${kind}:${name}`;

    const symbolIdByFullKey = new Map<string, string>();
    const symbolsByStartKey = new Map<string, ladybugDb.SymbolRow[]>();
    const symbolsByStartLineKey = new Map<string, ladybugDb.SymbolRow[]>();
    const symbolsByNameKindKey = new Map<string, ladybugDb.SymbolRow[]>();

    const pushSymbol = (
      map: Map<string, ladybugDb.SymbolRow[]>,
      key: string,
      symbol: ladybugDb.SymbolRow,
    ): void => {
      const existing = map.get(key) ?? [];
      existing.push(symbol);
      map.set(key, existing);
    };

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

    const mapExtractedSymbolId = (
      extractedSymbol: (typeof symbolsWithNodeIds)[number],
    ): { symbolId: string; strategy: string } | null => {
      const fullMatch = symbolIdByFullKey.get(
        toFullKey(
          extractedSymbol.kind,
          extractedSymbol.name,
          extractedSymbol.range,
        ),
      );
      if (fullMatch) {
        return { symbolId: fullMatch, strategy: "full_range" };
      }

      const startCandidates = symbolsByStartKey.get(
        toStartKey(
          extractedSymbol.kind,
          extractedSymbol.name,
          extractedSymbol.range,
        ),
      );
      if (startCandidates && startCandidates.length === 1) {
        return {
          symbolId: startCandidates[0].symbolId,
          strategy: "start_only",
        };
      }

      const startLineCandidates = symbolsByStartLineKey.get(
        toStartLineKey(
          extractedSymbol.kind,
          extractedSymbol.name,
          extractedSymbol.range,
        ),
      );
      if (startLineCandidates && startLineCandidates.length === 1) {
        return {
          symbolId: startLineCandidates[0].symbolId,
          strategy: "start_line",
        };
      }

      const nameKindCandidates = symbolsByNameKindKey.get(
        toNameKindKey(extractedSymbol.kind, extractedSymbol.name),
      );
      if (nameKindCandidates && nameKindCandidates.length === 1) {
        return {
          symbolId: nameKindCandidates[0].symbolId,
          strategy: "name_kind_unique",
        };
      }

      return null;
    };

    const filteredSymbolDetails = symbolsWithNodeIds
      .map((extractedSymbol) => {
        const mapped = mapExtractedSymbolId(extractedSymbol);
        if (!mapped) {
          if (telemetry) telemetry.pass2SymbolMapping.unmappedSymbols++;
          if (telemetry) {
            pushTelemetrySample(telemetry.samples.mappingFailures, {
              file: fileMeta.path,
              kind: extractedSymbol.kind,
              name: extractedSymbol.name,
              startLine: extractedSymbol.range.startLine,
              startCol: extractedSymbol.range.startCol,
            });
          }
          return null;
        }

        if (telemetry) telemetry.pass2SymbolMapping.mappedSymbols++;
        if (telemetry) {
          incRecord(
            telemetry.pass2SymbolMapping.strategyCounts,
            mapped.strategy,
          );
        }

        return {
          extractedSymbol,
          symbolId: mapped.symbolId,
        };
      })
      .filter(
        (
          detail,
        ): detail is {
          extractedSymbol: (typeof symbolsWithNodeIds)[number];
          symbolId: string;
        } => Boolean(detail),
      );

    if (filteredSymbolDetails.length === 0) {
      if (telemetry) telemetry.pass2FilesNoMappedSymbols++;
      if (telemetry) {
        pushTelemetrySample(telemetry.samples.noMappedSymbols, fileMeta.path);
      }
      return 0;
    }

    const symbolIdsToRefresh = filteredSymbolDetails.map(
      (detail) => detail.symbolId,
    );
    for (const symbolId of symbolIdsToRefresh) {
      for (const edgeKey of Array.from(createdCallEdges)) {
        if (edgeKey.startsWith(`${symbolId}->`)) {
          createdCallEdges.delete(edgeKey);
        }
      }
    }

    const nodeIdToSymbolId = new Map<string, string>();
    const nameToSymbolIds = new Map<string, string[]>();
    for (const detail of filteredSymbolDetails) {
      nodeIdToSymbolId.set(detail.extractedSymbol.nodeId, detail.symbolId);
      const existing = nameToSymbolIds.get(detail.extractedSymbol.name) ?? [];
      existing.push(detail.symbolId);
      nameToSymbolIds.set(detail.extractedSymbol.name, existing);
    }

    const extensions = languages.map((lang) => `.${lang}`);
    const importResolution = await resolveImportTargets(
      repoId,
      repoRoot,
      fileMeta.path,
      imports,
      extensions,
      adapter.languageId,
      content,
    );

    const edgesToInsert: ladybugDb.EdgeRow[] = [];
    const now = new Date().toISOString();

    // Group calls by callerNodeId for O(1) lookup instead of O(n*m) scan
    const callsByCallerNodeId = new Map<string | null, typeof calls>();
    for (const call of calls) {
      const existing = callsByCallerNodeId.get(call.callerNodeId) ?? [];
      existing.push(call);
      callsByCallerNodeId.set(call.callerNodeId, existing);
    }

    let createdEdges = 0;
    for (const detail of filteredSymbolDetails) {
      const matchingCalls = callsByCallerNodeId.get(detail.extractedSymbol.nodeId) ?? [];
      for (const call of matchingCalls) {
        if (telemetry) telemetry.adapterCalls.total++;
        const resolved = resolveCallTarget(
          call,
          nodeIdToSymbolId,
          nameToSymbolIds,
          importResolution.importedNameToSymbolIds,
          importResolution.namespaceImports,
          adapter,
          globalNameToSymbolIds,
        );
        if (!resolved) {
          if (telemetry) telemetry.adapterCalls.returnedNull++;
          continue;
        }

        if (resolved.isResolved && resolved.symbolId) {
          const edgeKey = `${detail.symbolId}->${resolved.symbolId}`;
          if (createdCallEdges.has(edgeKey)) {
            if (telemetry) telemetry.adapterCalls.duplicates++;
            continue;
          }
          edgesToInsert.push({
            repoId,
            fromSymbolId: detail.symbolId,
            toSymbolId: resolved.symbolId,
            edgeType: "call",
            weight: 1.0,
            confidence: resolved.confidence,
            resolution: resolved.strategy,
            resolverId: "pass2-ts",
            resolutionPhase: "pass2",
            provenance: `call:${call.calleeIdentifier}`,
            createdAt: now,
          });
          createdCallEdges.add(edgeKey);
          createdEdges++;
          if (telemetry) telemetry.adapterCalls.resolved++;
          if (telemetry) {
            incRecord(
              telemetry.adapterCalls.resolvedByStrategy,
              resolved.strategy ?? "unknown",
            );
          }
        } else if (resolved.targetName) {
          // Skip built-in method/constructor calls that can never resolve
          if (isBuiltinCall(resolved.targetName)) {
            if (telemetry) telemetry.adapterCalls.skippedBuiltin++;
            continue;
          }
          const unresolvedTargetId = `unresolved:call:${resolved.targetName}`;
          const edgeKey = `${detail.symbolId}->${unresolvedTargetId}`;
          if (createdCallEdges.has(edgeKey)) {
            if (telemetry) telemetry.adapterCalls.duplicates++;
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
            resolverId: "pass2-ts",
            resolutionPhase: "pass2",
            provenance: `unresolved-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
            createdAt: now,
          });
          createdCallEdges.add(edgeKey);
          createdEdges++;
          if (telemetry) telemetry.adapterCalls.unresolved++;
        }
      }
    }

    if (tsResolver) {
      const tsCalls = tsResolver.getResolvedCalls(fileMeta.path);
      if (telemetry) telemetry.tsResolverCalls.total += tsCalls.length;
      for (const tsCall of tsCalls) {
        const callerNodeId = findEnclosingSymbolByRange(
          tsCall.caller,
          filteredSymbolDetails,
        );
        if (!callerNodeId) {
          if (telemetry) telemetry.tsResolverCalls.skippedNoCaller++;
          continue;
        }
        const fromSymbolId = nodeIdToSymbolId.get(callerNodeId);
        if (!fromSymbolId) {
          if (telemetry) telemetry.tsResolverCalls.skippedNoFromSymbol++;
          continue;
        }
        const toSymbolId = await resolveSymbolIdFromIndex(
          symbolIndex,
          repoId,
          tsCall.callee.filePath,
          tsCall.callee.name,
          tsCall.callee.kind,
          adapter.languageId,
        );
        if (!toSymbolId) {
          if (telemetry) telemetry.tsResolverCalls.skippedNoToSymbol++;
          if (telemetry) {
            pushTelemetrySample(telemetry.samples.tsNoToSymbol, {
              file: fileMeta.path,
              calleeFile: tsCall.callee.filePath,
              calleeName: tsCall.callee.name,
              calleeKind: tsCall.callee.kind,
            });
          }
          continue;
        }
        const edgeKey = `${fromSymbolId}->${toSymbolId}`;
        if (createdCallEdges.has(edgeKey)) {
          if (telemetry) telemetry.tsResolverCalls.skippedDuplicate++;
          continue;
        }
        edgesToInsert.push({
          repoId,
          fromSymbolId,
          toSymbolId,
          edgeType: "call",
          weight: 1.0,
          confidence: tsCall.confidence ?? 1.0,
          resolution: "exact",
          resolverId: "pass2-ts",
          resolutionPhase: "pass2",
          provenance: `ts-call:${tsCall.callee.name}`,
          createdAt: now,
        });
        createdCallEdges.add(edgeKey);
        createdEdges++;
        if (telemetry) telemetry.tsResolverCalls.edgesCreated++;
      }
    }

    await withWriteConn(async (wConn) => {
      await ladybugDb.deleteOutgoingEdgesByTypeForSymbols(
        wConn,
        symbolIdsToRefresh,
        "call",
      );
      await ladybugDb.insertEdges(wConn, edgesToInsert);
    });
    return createdEdges;
  } catch (error) {
    logger.warn(
      `Pass 2 call resolution failed for ${fileMeta.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 0;
  }
}

function findEnclosingSymbolByRange(
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
  symbols: Array<{
    extractedSymbol: {
      nodeId: string;
      kind: string;
      range: {
        startLine: number;
        startCol: number;
        endLine: number;
        endCol: number;
      };
    };
  }>,
): string | null {
  let bestNonVariable: { nodeId: string; size: number } | null = null;
  let bestVariable: { nodeId: string; size: number } | null = null;

  for (const detail of symbols) {
    const symRange = detail.extractedSymbol.range;
    const nodeLine = range.startLine;
    const nodeCol = range.startCol;

    if (nodeLine < symRange.startLine || nodeLine > symRange.endLine) {
      continue;
    }
    if (nodeLine === symRange.startLine && nodeCol < symRange.startCol) {
      continue;
    }
    if (nodeLine === symRange.endLine && nodeCol > symRange.endCol) {
      continue;
    }

    const size =
      symRange.endLine -
      symRange.startLine +
      (symRange.endCol - symRange.startCol);

    if (detail.extractedSymbol.kind === "variable") {
      if (!bestVariable || size < bestVariable.size) {
        bestVariable = { nodeId: detail.extractedSymbol.nodeId, size };
      }
      continue;
    }

    if (!bestNonVariable || size < bestNonVariable.size) {
      bestNonVariable = { nodeId: detail.extractedSymbol.nodeId, size };
    }
  }

  return bestNonVariable?.nodeId ?? bestVariable?.nodeId ?? null;
}

export {
  findEnclosingSymbolByRange,
  resolvePass2Targets,
  resolveTsCallEdgesPass2,
};
