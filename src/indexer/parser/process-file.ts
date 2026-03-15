import { join } from "path";

import type { RepoConfig } from "../../config/types.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { EdgeRow, SymbolRow } from "../../db/ladybug-queries.js";
import type { SymbolKind } from "../../db/schema.js";
import { prefetchFileExports } from "../../graph/prefetch.js";
import { readFileAsync } from "../../util/asyncFs.js";
import { hashContent } from "../../util/hashing.js";
import { logger } from "../../util/logger.js";
import { normalizePath } from "../../util/paths.js";
import type {
  PendingCallEdge,
  SymbolIndex,
  TsCallResolver,
} from "../edge-builder.js";
import {
  addToSymbolIndex,
  findEnclosingSymbolByRange,
  isTsCallResolutionFile,
  isBuiltinCall,
  resolveCallTarget,
  resolveImportTargets,
  resolveSymbolIdFromIndex,
} from "../edge-builder.js";
import { getAdapterForExtension } from "../adapter/registry.js";
import { extractConfigEdgesFromTree, type ConfigEdge } from "../configEdges.js";
import type { FileMetadata } from "../fileScanner.js";
import { generateAstFingerprint, generateSymbolId } from "../fingerprints.js";
import type { IndexProgress } from "../indexer.js";
import { resolveSymbolEnrichment } from "../symbol-enrichment.js";
import {
  extractInvariants,
  extractSideEffects,
  generateSummary,
} from "../summaries.js";
import type { ParserWorkerPool } from "../workerPool.js";
import type { SymbolWithNodeId } from "../worker.js";
import type { ExtractedCall } from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import {
  buildSymbolReferences,
  createEmptyProcessFileResult,
  isTestFile,
  persistSkippedFile,
} from "./helpers.js";

export interface ProcessFileParams {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  languages: string[];
  mode: "full" | "incremental";
  existingFile?: {
    fileId: string;
    contentHash: string;
    lastIndexedAt: string | null;
  };
  symbolIndex?: SymbolIndex;
  pendingCallEdges?: PendingCallEdge[];
  createdCallEdges?: Set<string>;
  tsResolver?: TsCallResolver | null;
  config?: RepoConfig;
  allSymbolsByName?: Map<string, ladybugDb.SymbolLiteRow[]>;
  onProgress?: (progress: IndexProgress) => void;
  workerPool?: ParserWorkerPool | null;
  skipCallResolution?: boolean;
  globalNameToSymbolIds?: Map<string, string[]>;
  supportsPass2FilePath?: (relPath: string) => boolean;
}

export async function processFile(params: ProcessFileParams): Promise<{
  symbolsIndexed: number;
  edgesCreated: number;
  changed: boolean;
  configEdges: ConfigEdge[];
  pass2HintPaths: string[];
}> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    languages,
    mode,
    existingFile,
    symbolIndex,
    pendingCallEdges,
    createdCallEdges,
    tsResolver,
    config,
    allSymbolsByName,
    workerPool,
    skipCallResolution,
    globalNameToSymbolIds,
    supportsPass2FilePath = isTsCallResolutionFile,
  } = params;
  try {
    if (mode === "incremental" && existingFile?.lastIndexedAt) {
      const lastIndexedMs = new Date(existingFile.lastIndexedAt).getTime();
      if (fileMeta.mtime <= lastIndexedMs) {
        logger.debug("Skipping file (mtime not newer than lastIndexedAt)", {
          file: fileMeta.path,
          fileMtime: fileMeta.mtime,
          lastIndexedMs,
        });
        return createEmptyProcessFileResult(false);
      }
    }

    const filePath = join(repoRoot, fileMeta.path);
    let content: string;
    try {
      content = await readFileAsync(filePath, "utf-8");
    } catch (readError: unknown) {
      const code = (readError as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EPERM") {
        logger.warn(`File disappeared before indexing: ${fileMeta.path}`, {
          code,
        });
        return createEmptyProcessFileResult(false);
      }
      throw readError;
    }
    const contentHash = hashContent(content);
    const ext = fileMeta.path.split(".").pop() || "";
    const extWithDot = `.${ext}`;
    const relPath = normalizePath(fileMeta.path);
    const fileId = existingFile?.fileId ?? `${repoId}:${relPath}`;

    if (
      mode === "incremental" &&
      existingFile &&
      existingFile.contentHash === contentHash
    ) {
      logger.debug("Skipping file (content hash unchanged)", {
        file: fileMeta.path,
        contentHash,
      });
      return createEmptyProcessFileResult(false);
    }

    const conn = await getLadybugConn();

    if (!languages.includes(ext)) {
      logger.debug(
        `Language ${ext} not in enabled languages, skipping ${fileMeta.path}`,
      );
      await withWriteConn(async (wConn) => {
        await persistSkippedFile({
          conn: wConn,
          existingFileId: existingFile?.fileId,
          fileId,
          repoId,
          relPath,
          contentHash,
          language: ext,
          byteSize: fileMeta.size,
        });
      });
      return createEmptyProcessFileResult(true);
    }

    const adapter = getAdapterForExtension(extWithDot);

    if (!adapter) {
      logger.debug(
        `No adapter found for ${extWithDot}, skipping ${fileMeta.path}`,
      );
      await withWriteConn(async (wConn) => {
        await persistSkippedFile({
          conn: wConn,
          existingFileId: existingFile?.fileId,
          fileId,
          repoId,
          relPath,
          contentHash,
          language: ext,
          byteSize: fileMeta.size,
        });
      });
      return createEmptyProcessFileResult(true);
    }

    let symbolsWithNodeIds: Array<SymbolWithNodeId> = [];
    let imports: ExtractedImport[] = [];
    let calls: ExtractedCall[] = [];
    let parseError: Error | null = null;
    let tree: ReturnType<typeof adapter.parse> = null;

    try {
      // eslint-disable-line no-useless-catch -- tree.delete() in outer finally
      if (workerPool) {
        try {
          const result = await workerPool.parse(filePath, content, extWithDot);
          symbolsWithNodeIds = result.symbols;
          imports = result.imports;
          calls = result.calls;
          // tree remains null when using worker pool - fingerprinting will use empty string
        } catch (workerError) {
          parseError =
            workerError instanceof Error
              ? workerError
              : new Error(String(workerError));
          logger.warn(
            `Worker pool parse failed for ${fileMeta.path}, falling back to sync: ${parseError.message}`,
          );
        }
      }

      if (parseError || !workerPool) {
        tree = adapter.parse(content, filePath);
        if (!tree) {
          await withWriteConn(async (wConn) => {
            await persistSkippedFile({
              conn: wConn,
              existingFileId: existingFile?.fileId,
              fileId,
              repoId,
              relPath,
              contentHash,
              language: adapter.languageId,
              byteSize: fileMeta.size,
            });
          });
          return createEmptyProcessFileResult(true);
        }

        let extractedSymbols: ReturnType<typeof adapter.extractSymbols>;
        try {
          extractedSymbols = adapter.extractSymbols(tree, content, filePath);
        } catch (error) {
          logger.warn(
            `Partial parse error for ${fileMeta.path}: ${error}, extracting available symbols`,
          );
          extractedSymbols = [];
        }
        imports = adapter.extractImports(tree, content, filePath);
        symbolsWithNodeIds = extractedSymbols.map((symbol) => ({
          nodeId: symbol.nodeId,
          kind: symbol.kind,
          name: symbol.name,
          exported: symbol.exported,
          range: symbol.range,
          signature: symbol.signature,
          visibility: symbol.visibility,
          astFingerprint: "",
        }));
        calls = adapter.extractCalls(
          tree,
          content,
          filePath,
          symbolsWithNodeIds,
        );
      }
    } catch (error) {
      logger.error(`Fatal parse error for ${fileMeta.path}: ${error}`);
      return createEmptyProcessFileResult(false);
    } finally {
      if (
        tree &&
        typeof (tree as unknown as { delete?: () => void }).delete ===
          "function"
      ) {
        (tree as unknown as { delete: () => void }).delete();
      }
    }

    const symbolsIndexed = symbolsWithNodeIds.length;
    let edgesCreated = 0;

    let pass2HintPaths: string[] = [];

    let existingSymbols: SymbolRow[] = [];
    const existingSymbolsById = new Map<string, SymbolRow>();
    if (existingFile) {
      existingSymbols = await ladybugDb.getSymbolsByFile(
        conn,
        existingFile.fileId,
      );
      for (const symbol of existingSymbols) {
        existingSymbolsById.set(symbol.symbolId, symbol);
      }
    }

    if (
      mode === "incremental" &&
      skipCallResolution &&
      existingFile &&
      existingSymbols.length > 0
    ) {
      try {
        const incomingByToSymbol = await ladybugDb.getEdgesToSymbols(
          conn,
          existingSymbols.map((s) => s.symbolId),
        );

        const importerSymbolIds = new Set<string>();
        for (const edges of incomingByToSymbol.values()) {
          for (const edge of edges) {
            if (edge.edgeType !== "import" && edge.edgeType !== "call")
              continue;
            importerSymbolIds.add(edge.fromSymbolId);
          }
        }

        if (importerSymbolIds.size > 0) {
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

          const hinted = new Set<string>();
          for (const symbol of importerSymbols.values()) {
            const file = importerFiles.get(symbol.fileId);
            if (!file) continue;
            if (!supportsPass2FilePath(file.relPath)) continue;
            hinted.add(file.relPath);
          }
          pass2HintPaths = Array.from(hinted).sort();
        }
      } catch (error) {
        logger.warn(
          "Failed to compute pass2 hint paths for incremental call resolution",
          {
            repoId,
            file: fileMeta.path,
            error: String(error),
          },
        );
      }
    }

    const exportSymbols = symbolsWithNodeIds.filter(
      (symbol) => symbol.exported,
    );
    const edgeSourceSymbols =
      exportSymbols.length > 0 ? exportSymbols : symbolsWithNodeIds;

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
    const importTargets = importResolution.targets;

    const symbolDetails = symbolsWithNodeIds.map((extractedSymbol) => {
      let astFingerprint = extractedSymbol.astFingerprint ?? "";

      if (tree) {
        const astNode = tree.rootNode
          .descendantsOfType(
            extractedSymbol.kind === "function"
              ? "function_declaration"
              : extractedSymbol.kind === "class"
                ? "class_declaration"
                : extractedSymbol.kind === "interface"
                  ? "interface_declaration"
                  : extractedSymbol.kind === "type"
                    ? "type_alias_declaration"
                    : extractedSymbol.kind === "method"
                      ? "method_definition"
                      : extractedSymbol.kind === "variable"
                        ? "variable_declaration"
                        : "ambient_statement",
          )
          .find((node) => {
            const nameNode = node.childForFieldName("name");
            return nameNode?.text === extractedSymbol.name;
          });

        astFingerprint = astNode
          ? generateAstFingerprint(astNode)
          : astFingerprint;
      }

      const symbolId = generateSymbolId(
        repoId,
        fileMeta.path,
        extractedSymbol.kind,
        extractedSymbol.name,
        astFingerprint,
      );

      return {
        extractedSymbol,
        astFingerprint,
        symbolId,
      };
    });

    const nodeIdToSymbolId = new Map<string, string>();
    const nameToSymbolIds = new Map<string, string[]>();

    for (const detail of symbolDetails) {
      nodeIdToSymbolId.set(detail.extractedSymbol.nodeId, detail.symbolId);
      const existing = nameToSymbolIds.get(detail.extractedSymbol.name) ?? [];
      existing.push(detail.symbolId);
      nameToSymbolIds.set(detail.extractedSymbol.name, existing);
    }

    const edgesToInsert: EdgeRow[] = [];
    const fileSymbols: SymbolRow[] = [];
    const symbolsToUpsert: SymbolRow[] = [];
    const symbolReferences = isTestFile(relPath, languages)
      ? buildSymbolReferences(content, repoId, fileId)
      : [];
    // Group calls by callerNodeId for O(1) lookup instead of O(n*m) scan
    const callsByCallerNodeId = new Map<string | null, typeof calls>();
    for (const call of calls) {
      const arr = callsByCallerNodeId.get(call.callerNodeId);
      if (arr) arr.push(call);
      else callsByCallerNodeId.set(call.callerNodeId, [call]);
    }
    const now = new Date().toISOString();

    for (const detail of symbolDetails) {
      const extractedSymbol = detail.extractedSymbol;
      const symbolId = detail.symbolId;

      const existingSymbol = existingSymbolsById.get(symbolId);

      let summary = existingSymbol?.summary ?? null;
      if (summary === null) {
        summary = generateSummary(extractedSymbol, content);
      }

      let invariantsJson = existingSymbol?.invariantsJson ?? null;
      if (invariantsJson === null) {
        const invariants = extractInvariants(extractedSymbol, content);
        invariantsJson =
          invariants.length > 0 ? JSON.stringify(invariants) : null;
      }

      let sideEffectsJson = existingSymbol?.sideEffectsJson ?? null;
      if (sideEffectsJson === null) {
        const sideEffects = extractSideEffects(extractedSymbol, content);
        sideEffectsJson =
          sideEffects.length > 0 ? JSON.stringify(sideEffects) : null;
      }

      const { roleTagsJson, searchText } = resolveSymbolEnrichment({
        kind: extractedSymbol.kind,
        name: extractedSymbol.name,
        relPath,
        summary,
        signature: extractedSymbol.signature,
      });

      const symbol: SymbolRow = {
        symbolId,
        repoId,
        fileId,
        kind: extractedSymbol.kind,
        name: extractedSymbol.name,
        exported: extractedSymbol.exported,
        visibility: extractedSymbol.visibility || null,
        language: adapter.languageId,
        rangeStartLine: extractedSymbol.range.startLine,
        rangeStartCol: extractedSymbol.range.startCol,
        rangeEndLine: extractedSymbol.range.endLine,
        rangeEndCol: extractedSymbol.range.endCol,
        astFingerprint: detail.astFingerprint,
        signatureJson: extractedSymbol.signature
          ? JSON.stringify(extractedSymbol.signature)
          : null,
        summary,
        invariantsJson,
        sideEffectsJson: sideEffectsJson,
        roleTagsJson,
        searchText,
        updatedAt: new Date().toISOString(),
      };

      symbolsToUpsert.push(symbol);
      fileSymbols.push(symbol);
      if (symbolIndex) {
        addToSymbolIndex(
          symbolIndex,
          fileMeta.path,
          symbol.symbolId,
          symbol.name,
          symbol.kind as SymbolKind,
        );
      }

      if (edgeSourceSymbols.some((s) => s.nodeId === extractedSymbol.nodeId)) {
        for (const target of importTargets) {
          const edge: EdgeRow = {
            repoId,
            fromSymbolId: symbolId,
            toSymbolId: target.symbolId,
            edgeType: "import",
            weight: 0.6,
            confidence: 1.0,
            resolution: "exact",
            provenance: `import:${target.provenance}`,
            createdAt: now,
          };
          edgesToInsert.push(edge);
          edgesCreated++;
        }
      }

      if (!skipCallResolution) {
        const matchingCalls =
          callsByCallerNodeId.get(extractedSymbol.nodeId) ?? [];
        for (const call of matchingCalls) {
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
            continue;
          }

          if (resolved.isResolved && resolved.symbolId) {
            const edgeKey = `${symbolId}->${resolved.symbolId}`;
            if (createdCallEdges && createdCallEdges.has(edgeKey)) {
              continue;
            }

            const edge: EdgeRow = {
              repoId,
              fromSymbolId: symbolId,
              toSymbolId: resolved.symbolId,
              edgeType: "call",
              weight: 1.0,
              confidence: resolved.confidence,
              resolution: resolved.strategy,
              resolverId: "pass1-generic",
              resolutionPhase: "pass1",
              provenance: `call:${call.calleeIdentifier}`,
              createdAt: now,
            };
            edgesToInsert.push(edge);
            createdCallEdges?.add(edgeKey);
            edgesCreated++;
          } else if (resolved.targetName) {
            if (isBuiltinCall(resolved.targetName)) {
              continue;
            }
            const unresolvedTargetId = `unresolved:call:${resolved.targetName}`;
            const edgeKey = `${symbolId}->${unresolvedTargetId}`;
            if (createdCallEdges && createdCallEdges.has(edgeKey)) {
              continue;
            }

            const edge: EdgeRow = {
              repoId,
              fromSymbolId: symbolId,
              toSymbolId: unresolvedTargetId,
              edgeType: "call",
              weight: 0.5, // Lower weight for unresolved edges
              confidence: resolved.confidence,
              resolution: "unresolved",
              resolverId: "pass1-generic",
              resolutionPhase: "pass1",
              provenance: `unresolved-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
              createdAt: now,
            };
            edgesToInsert.push(edge);
            createdCallEdges?.add(edgeKey);
            edgesCreated++;
          }
        }
      }
    }

    if (
      !skipCallResolution &&
      tsResolver &&
      symbolIndex &&
      pendingCallEdges &&
      createdCallEdges
    ) {
      const tsCalls = tsResolver.getResolvedCalls(fileMeta.path);
      for (const tsCall of tsCalls) {
        const callerNodeId = findEnclosingSymbolByRange(
          tsCall.caller,
          symbolDetails,
        );
        if (!callerNodeId) continue;

        const fromSymbolId = nodeIdToSymbolId.get(callerNodeId);
        if (!fromSymbolId) continue;

        const toSymbolId = await resolveSymbolIdFromIndex(
          symbolIndex,
          repoId,
          tsCall.callee.filePath,
          tsCall.callee.name,
          tsCall.callee.kind,
          adapter.languageId,
        );

        if (toSymbolId) {
          const edgeKey = `${fromSymbolId}->${toSymbolId}`;
          if (createdCallEdges.has(edgeKey)) continue;

          edgesToInsert.push({
            repoId,
            fromSymbolId,
            toSymbolId,
            edgeType: "call",
            weight: 1.0,
            confidence: tsCall.confidence ?? 1.0,
            resolution: "exact",
            resolverId: "pass1-generic",
            resolutionPhase: "pass1",
            provenance: `ts-call:${tsCall.callee.name}`,
            createdAt: new Date().toISOString(),
          });
          createdCallEdges.add(edgeKey);
          edgesCreated++;
        } else {
          pendingCallEdges.push({
            fromSymbolId,
            toFile: tsCall.callee.filePath,
            toName: tsCall.callee.name,
            toKind: tsCall.callee.kind,
            confidence: tsCall.confidence ?? 1.0,
            strategy: "exact",
            provenance: `ts-call:${tsCall.callee.name}`,
            callerLanguage: adapter.languageId,
          });
        }
      }
    }

    let configEdges: ConfigEdge[] = [];
    // Config edges require the AST tree - skip when using worker pool (tree is null)
    if (config && allSymbolsByName && tree) {
      configEdges = extractConfigEdgesFromTree({
        repoId,
        repoRoot,
        relPath,
        config,
        tree,
        fileSymbols,
        allSymbolsByName,
      });
    }

    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        await ladybugDb.upsertFile(txConn, {
          fileId,
          repoId,
          relPath,
          contentHash,
          language: adapter?.languageId ?? ext,
          byteSize: fileMeta.size,
          lastIndexedAt: new Date().toISOString(),
        });

        if (existingFile) {
          await ladybugDb.deleteSymbolsByFileId(txConn, existingFile.fileId);
          await ladybugDb.deleteSymbolReferencesByFileId(
            txConn,
            existingFile.fileId,
          );
        }

        await ladybugDb.insertSymbolReferences(txConn, symbolReferences);

        for (const symbol of symbolsToUpsert) {
          await ladybugDb.upsertSymbol(txConn, symbol);
        }

        await ladybugDb.insertEdges(txConn, edgesToInsert);
      });
    });

    prefetchFileExports(repoId, fileMeta.path);

    return {
      symbolsIndexed,
      edgesCreated,
      changed: true,
      configEdges,
      pass2HintPaths,
    };
  } catch (error) {
    logger.error(`Error processing file ${fileMeta.path}:`, { error });
    return createEmptyProcessFileResult(false);
  }
}
