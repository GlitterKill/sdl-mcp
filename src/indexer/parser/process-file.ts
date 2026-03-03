import { join } from "path";

import type { RepoConfig } from "../../config/types.js";
import {
  createEdgeTransaction,
  deleteSymbolsByFileWithEdges,
  deleteSymbolReferencesByFileId,
  getFileByRepoPath,
  getSymbolsByFile,
  upsertFile,
  upsertSymbolTransaction,
} from "../../db/queries.js";
import { SymbolKind, type EdgeRow, type SymbolRow } from "../../db/schema.js";
import { prefetchFileExports } from "../../graph/prefetch.js";
import { readFileAsync } from "../../util/asyncFs.js";
import { hashContent } from "../../util/hashing.js";
import { logger } from "../../util/logger.js";
import type {
  PendingCallEdge,
  SymbolIndex,
  TsCallResolver,
} from "../edge-builder.js";
import {
  addToSymbolIndex,
  findEnclosingSymbolByRange,
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
import { extractInvariants, extractSideEffects, generateSummary } from "../summaries.js";
import type { ParserWorkerPool } from "../workerPool.js";
import type { ExtractedCall } from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import { extractSymbolReferences, isTestFile } from "./helpers.js";

export interface ProcessFileParams {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  languages: string[];
  mode: "full" | "incremental";
  existingFile?: {
    file_id: number;
    content_hash: string;
    last_indexed_at: string | null;
  };
  symbolIndex?: SymbolIndex;
  pendingCallEdges?: PendingCallEdge[];
  createdCallEdges?: Set<string>;
  tsResolver?: TsCallResolver | null;
  config?: RepoConfig;
  allSymbolsByName?: Map<string, SymbolRow[]>;
  onProgress?: (progress: IndexProgress) => void;
  workerPool?: ParserWorkerPool | null;
  skipCallResolution?: boolean;
  globalNameToSymbolIds?: Map<string, string[]>;
}

export async function processFile(params: ProcessFileParams): Promise<{
  symbolsIndexed: number;
  edgesCreated: number;
  changed: boolean;
  configEdges: ConfigEdge[];
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
  } = params;
  try {
    if (mode === "incremental" && existingFile?.last_indexed_at) {
      const lastIndexedMs = new Date(existingFile.last_indexed_at).getTime();
      if (fileMeta.mtime <= lastIndexedMs) {
        return {
          symbolsIndexed: 0,
          edgesCreated: 0,
          changed: false,
          configEdges: [],
        };
      }
    }

    const filePath = join(repoRoot, fileMeta.path);
    const content = await readFileAsync(filePath, "utf-8");
    const contentHash = hashContent(content);
    const ext = fileMeta.path.split(".").pop() || "";
    const extWithDot = `.${ext}`;

    if (
      mode === "incremental" &&
      existingFile &&
      existingFile.content_hash === contentHash
    ) {
      return {
        symbolsIndexed: 0,
        edgesCreated: 0,
        changed: false,
        configEdges: [],
      };
    }

    if (!languages.includes(ext)) {
      logger.debug(
        `Language ${ext} not in enabled languages, skipping ${fileMeta.path}`,
      );
      if (existingFile) {
        deleteSymbolsByFileWithEdges(existingFile.file_id);
      }
      upsertFile({
        repo_id: repoId,
        rel_path: fileMeta.path,
        content_hash: contentHash,
        language: ext,
        byte_size: fileMeta.size,
        last_indexed_at: new Date().toISOString(),
      });
      return {
        symbolsIndexed: 0,
        edgesCreated: 0,
        changed: true,
        configEdges: [],
      };
    }

    const adapter = getAdapterForExtension(extWithDot);

    if (!adapter) {
      logger.debug(
        `No adapter found for ${extWithDot}, skipping ${fileMeta.path}`,
      );
      if (existingFile) {
        deleteSymbolsByFileWithEdges(existingFile.file_id);
      }
      upsertFile({
        repo_id: repoId,
        rel_path: fileMeta.path,
        content_hash: contentHash,
        language: ext,
        byte_size: fileMeta.size,
        last_indexed_at: new Date().toISOString(),
      });
      return {
        symbolsIndexed: 0,
        edgesCreated: 0,
        changed: true,
        configEdges: [],
      };
    }

    let symbolsWithNodeIds: Array<{
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
      signature: any;
      visibility: any;
    }> = [];
    let imports: ExtractedImport[] = [];
    let calls: ExtractedCall[] = [];
    let parseError: Error | null = null;
    let tree: ReturnType<typeof adapter.parse> = null;

    try {
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
          if (existingFile) {
            deleteSymbolsByFileWithEdges(existingFile.file_id);
          }
          upsertFile({
            repo_id: repoId,
            rel_path: fileMeta.path,
            content_hash: contentHash,
            language: adapter.languageId,
            byte_size: fileMeta.size,
            last_indexed_at: new Date().toISOString(),
          });
          return {
            symbolsIndexed: 0,
            edgesCreated: 0,
            changed: true,
            configEdges: [],
          };
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
        }));
        calls = adapter.extractCalls(
          tree,
          content,
          filePath,
          symbolsWithNodeIds as any,
        );
      }
    } catch (error) {
      logger.error(`Fatal parse error for ${fileMeta.path}: ${error}`);
      return {
        symbolsIndexed: 0,
        edgesCreated: 0,
        changed: false,
        configEdges: [],
      };
    }

    const symbolsIndexed = symbolsWithNodeIds.length;
    let edgesCreated = 0;

    const existingSymbolsById = new Map<string, SymbolRow>();
    if (existingFile) {
      const existingSymbols = getSymbolsByFile(existingFile.file_id);
      for (const symbol of existingSymbols) {
        existingSymbolsById.set(symbol.symbol_id, symbol);
      }
    }

    const fileRecord = {
      repo_id: repoId,
      rel_path: fileMeta.path,
      content_hash: contentHash,
      language: ext,
      byte_size: fileMeta.size,
      last_indexed_at: new Date().toISOString(),
    };

    upsertFile(fileRecord);

    const file = getFileByRepoPath(repoId, fileMeta.path);
    if (!file) {
      return { symbolsIndexed, edgesCreated, changed: true, configEdges: [] };
    }

    if (existingFile) {
      deleteSymbolsByFileWithEdges(existingFile.file_id);
      deleteSymbolReferencesByFileId(existingFile.file_id);
    }

    if (isTestFile(fileMeta.path, languages)) {
      extractSymbolReferences(content, repoId, file.file_id);
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
      // When using worker pool, tree is null - use empty fingerprint
      // The fingerprint is still useful for change detection but not critical
      let astFingerprint = "";

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

        astFingerprint = astNode ? generateAstFingerprint(astNode) : "";
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

    for (const detail of symbolDetails) {
      const extractedSymbol = detail.extractedSymbol;
      const symbolId = detail.symbolId;

      const existingSymbol = existingSymbolsById.get(symbolId);

      let summary = existingSymbol?.summary ?? null;
      if (summary === null) {
        summary = generateSummary(extractedSymbol, content);
      }

      let invariantsJson = existingSymbol?.invariants_json ?? null;
      if (invariantsJson === null) {
        const invariants = extractInvariants(extractedSymbol, content);
        invariantsJson =
          invariants.length > 0 ? JSON.stringify(invariants) : null;
      }

      let sideEffectsJson = existingSymbol?.side_effects_json ?? null;
      if (sideEffectsJson === null) {
        const sideEffects = extractSideEffects(extractedSymbol, content);
        sideEffectsJson =
          sideEffects.length > 0 ? JSON.stringify(sideEffects) : null;
      }

      const symbol: SymbolRow = {
        symbol_id: symbolId,
        repo_id: repoId,
        file_id: file.file_id,
        kind: extractedSymbol.kind,
        name: extractedSymbol.name,
        exported: extractedSymbol.exported ? 1 : 0,
        visibility: extractedSymbol.visibility || null,
        language: adapter.languageId,
        range_start_line: extractedSymbol.range.startLine,
        range_start_col: extractedSymbol.range.startCol,
        range_end_line: extractedSymbol.range.endLine,
        range_end_col: extractedSymbol.range.endCol,
        ast_fingerprint: detail.astFingerprint,
        signature_json: extractedSymbol.signature
          ? JSON.stringify(extractedSymbol.signature)
          : null,
        summary,
        invariants_json: invariantsJson,
        side_effects_json: sideEffectsJson,
        updated_at: new Date().toISOString(),
      };

      upsertSymbolTransaction(symbol);
      if (symbolIndex) {
        addToSymbolIndex(
          symbolIndex,
          fileMeta.path,
          symbol.symbol_id,
          symbol.name,
          symbol.kind,
        );
      }

      if (edgeSourceSymbols.some((s) => s.nodeId === extractedSymbol.nodeId)) {
        for (const target of importTargets) {
          const edge: EdgeRow = {
            repo_id: repoId,
            from_symbol_id: symbolId,
            to_symbol_id: target.symbolId,
            type: "import",
            weight: 0.6,
            provenance: `import:${target.provenance}`,
            created_at: new Date().toISOString(),
          };
          createEdgeTransaction(edge);
          edgesCreated++;
        }
      }

      if (!skipCallResolution) {
        for (const call of calls) {
          if (call.callerNodeId !== extractedSymbol.nodeId) {
            continue;
          }

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

          // 36-1.3: Handle both resolved and unresolved edges
          if (resolved.isResolved && resolved.symbolId) {
            // Fully resolved edge
            const edgeKey = `${symbolId}->${resolved.symbolId}`;
            if (createdCallEdges && createdCallEdges.has(edgeKey)) {
              continue;
            }

            const edge: EdgeRow = {
              repo_id: repoId,
              from_symbol_id: symbolId,
              to_symbol_id: resolved.symbolId,
              type: "call",
              weight: 1.0,
              confidence: resolved.confidence,
              resolution_strategy: resolved.strategy,
              provenance: `call:${call.calleeIdentifier}`,
              created_at: new Date().toISOString(),
            };
            createEdgeTransaction(edge);
            createdCallEdges?.add(edgeKey);
            edgesCreated++;
          } else if (resolved.targetName) {
            // Skip built-in method/constructor calls that can never resolve
            if (isBuiltinCall(resolved.targetName)) {
              continue;
            }
            // 36-1.3: Unresolved edge - still useful for graph traversal
            // Use a placeholder symbol ID that encodes the unresolved target
            const unresolvedTargetId = `unresolved:call:${resolved.targetName}`;
            const edgeKey = `${symbolId}->${unresolvedTargetId}`;
            if (createdCallEdges && createdCallEdges.has(edgeKey)) {
              continue;
            }

            const edge: EdgeRow = {
              repo_id: repoId,
              from_symbol_id: symbolId,
              to_symbol_id: unresolvedTargetId,
              type: "call",
              weight: 0.5, // Lower weight for unresolved edges
              confidence: resolved.confidence,
              resolution_strategy: "unresolved",
              provenance: `unresolved-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
              created_at: new Date().toISOString(),
            };
            createEdgeTransaction(edge);
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

        const toSymbolId = resolveSymbolIdFromIndex(
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

          createEdgeTransaction({
            repo_id: repoId,
            from_symbol_id: fromSymbolId,
            to_symbol_id: toSymbolId,
            type: "call",
            weight: 1.0,
            confidence: tsCall.confidence ?? 1.0,
            resolution_strategy: "exact",
            provenance: `ts-call:${tsCall.callee.name}`,
            created_at: new Date().toISOString(),
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
      const fileSymbols = getSymbolsByFile(file.file_id);
      configEdges = extractConfigEdgesFromTree({
        repoId,
        repoRoot,
        config,
        tree,
        fileSymbols,
        allSymbolsByName,
      });
    }

    prefetchFileExports(repoId, fileMeta.path);

    return { symbolsIndexed, edgesCreated, changed: true, configEdges };
  } catch (error) {
    console.error(`Error processing file ${fileMeta.path}:`, error);
    return {
      symbolsIndexed: 0,
      edgesCreated: 0,
      changed: false,
      configEdges: [],
    };
  }
}
