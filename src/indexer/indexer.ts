import { watch } from "fs";
import { createRequire } from "module";
import { dirname, join, relative, resolve } from "path";
import { platform } from "process";
import os from "os";
import {
  getRepo,
  upsertFile,
  deleteSymbolsByFileWithEdges,
  deleteFileTransaction,
  upsertSymbolTransaction,
  createEdgeTransaction,
  createSnapshotTransaction,
  getFilesByRepo,
  getFileByRepoPath,
  getSymbolsByFile,
  getSymbolsByFileLite,
  getSymbolsByRepoForSnapshot,
  getEdgesByRepo,
  getSymbolsByRepo,
  getLatestVersion,
  getSymbol,
  getFile,
  deleteOutgoingCallEdgesBySymbol,
  deleteSymbolReferencesByFileId,
  insertSymbolReference,
} from "../db/queries.js";
import { getDb } from "../db/db.js";
import { SymbolRow, EdgeRow, SymbolKind, FileRow } from "../db/schema.js";
import { RepoConfig } from "../config/types.js";
import { scanRepository, FileMetadata } from "./fileScanner.js";
import { generateAstFingerprint, generateSymbolId } from "./fingerprints.js";
import {
  WATCH_DEBOUNCE_MS,
  WATCH_STABILITY_THRESHOLD_MS,
  WATCH_POLL_INTERVAL_MS,
  WATCHER_ERROR_MAX_COUNT,
  WATCHER_STALE_THRESHOLD_MS,
  WATCHER_REINDEX_RETRY_BASE_MS,
  WATCHER_REINDEX_RETRY_MAX_MS,
  WATCHER_REINDEX_MAX_ATTEMPTS,
  WATCHER_DEFAULT_MAX_WATCHED_FILES,
} from "../config/constants.js";
import { hashContent } from "../util/hashing.js";
import { normalizePath } from "../util/paths.js";
import {
  generateSummary,
  extractInvariants,
  extractSideEffects,
} from "./summaries.js";
import { updateMetricsForRepo } from "../graph/metrics.js";
import { extractConfigEdgesFromTree, type ConfigEdge } from "./configEdges.js";
import { loadConfig } from "../config/loadConfig.js";
import { createTsCallResolver, ResolvedCall } from "./ts/tsParser.js";
import { getAdapterForExtension } from "./adapter/registry.js";
import type {
  AdapterResolvedCall,
  LanguageAdapter,
} from "./adapter/LanguageAdapter.js";
import { ParserWorkerPool } from "./workerPool.js";
import { logger } from "../util/logger.js";
import { readFileAsync, existsAsync } from "../util/asyncFs.js";
import type { ExtractedCall } from "./treesitter/extractCalls.js";
import type { ExtractedImport } from "./treesitter/extractImports.js";
import { calibrateResolutionConfidence } from "./edge-confidence.js";
import { refreshSymbolEmbeddings } from "./embeddings.js";
import { prefetchFileExports } from "../graph/prefetch.js";
import {
  parseFilesRust,
  isRustEngineAvailable,
  type RustParseResult,
} from "./rustIndexer.js";

const require = createRequire(import.meta.url);
const TS_CALL_RESOLUTION_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx"]);

function isTsCallResolutionFile(relPath: string): boolean {
  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
  return TS_CALL_RESOLUTION_EXTENSIONS.has(ext);
}

export interface IndexProgress {
  stage: "scanning" | "parsing" | "pass1" | "pass2" | "finalizing";
  current: number;
  total: number;
  currentFile?: string;
}

export interface IndexResult {
  versionId: string;
  filesProcessed: number;
  changedFiles: number;
  removedFiles: number;
  symbolsIndexed: number;
  edgesCreated: number;
  durationMs: number;
}

export interface IndexWatchHandle {
  close: () => Promise<void>;
}

export interface WatcherHealth {
  enabled: boolean;
  running: boolean;
  filesWatched: number;
  eventsReceived: number;
  eventsProcessed: number;
  errors: number;
  queueDepth: number;
  restartCount: number;
  stale: boolean;
  lastEventAt: string | null;
  lastSuccessfulReindexAt: string | null;
}

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
}

async function processFile(params: ProcessFileParams): Promise<{
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
    onProgress: _onProgress,
    workerPool,
    skipCallResolution,
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

/**
 * Process a file using pre-parsed results from the Rust native engine.
 *
 * Handles DB writes, import edge resolution, and call edge resolution
 * using extraction data already computed by the Rust engine (symbols,
 * imports, calls, fingerprints, summaries, invariants, side effects).
 */
async function processFileFromRustResult(params: {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  rustResult: RustParseResult;
  languages: string[];
  mode: "full" | "incremental";
  existingFile?: {
    file_id: number;
    content_hash: string;
    last_indexed_at: string | null;
  };
  symbolIndex: SymbolIndex;
  pendingCallEdges: PendingCallEdge[];
  createdCallEdges: Set<string>;
  tsResolver: TsCallResolver | null;
  config: RepoConfig;
  allSymbolsByName: Map<string, SymbolRow[]>;
  skipCallResolution: boolean;
}): Promise<{
  symbolsIndexed: number;
  edgesCreated: number;
  changed: boolean;
  configEdges: ConfigEdge[];
}> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    rustResult,
    languages,
    mode,
    existingFile,
    symbolIndex,
    pendingCallEdges: _pendingCallEdges,
    createdCallEdges,
    tsResolver: _tsResolver,
    config: _config,
    allSymbolsByName: _allSymbolsByName,
    skipCallResolution,
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

    const ext = fileMeta.path.split(".").pop() || "";
    const contentHash = rustResult.contentHash;

    if (rustResult.parseError) {
      logger.warn(
        `Rust parse error for ${fileMeta.path}: ${rustResult.parseError}`,
      );
    }

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

    const extWithDot = `.${ext}`;
    const adapter = getAdapterForExtension(extWithDot);
    const filePath = join(repoRoot, fileMeta.path);
    const content = await readFileAsync(filePath, "utf-8");

    // Preserve previous symbol metadata before deleting rows for this file.
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
      return {
        symbolsIndexed: rustResult.symbols.length,
        edgesCreated: 0,
        changed: true,
        configEdges: [],
      };
    }

    if (existingFile) {
      deleteSymbolsByFileWithEdges(existingFile.file_id);
      deleteSymbolReferencesByFileId(existingFile.file_id);
    }

    // Rebuild test symbol reference index from the current file content.
    if (isTestFile(fileMeta.path, languages)) {
      try {
        extractSymbolReferences(content, repoId, file.file_id);
      } catch {
        // Non-critical: skip reference extraction on read failure
      }
    }

    const symbolsWithIds = rustResult.symbols;
    const imports = rustResult.imports;
    const calls = rustResult.calls;
    const symbolsIndexed = symbolsWithIds.length;
    let edgesCreated = 0;

    // Build symbol details directly from native Rust identity/metadata fields.
    const symbolDetails = symbolsWithIds.map((extracted) => {
      const symbolId = extracted.symbolId;
      const astFingerprint = extracted.astFingerprint;

      return {
        extractedSymbol: {
          nodeId: extracted.nodeId,
          kind: extracted.kind as SymbolKind,
          name: extracted.name,
          exported: extracted.exported,
          range: extracted.range,
          signature: extracted.signature,
          visibility: extracted.visibility,
        },
        astFingerprint,
        symbolId,
        nativeSummary: extracted.summary,
        nativeInvariantsJson: extracted.invariantsJson,
        nativeSideEffectsJson: extracted.sideEffectsJson,
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

    // Resolve imports
    const extensions = languages.map((lang) => `.${lang}`);
    const importResolution = await resolveImportTargets(
      repoId,
      repoRoot,
      fileMeta.path,
      imports,
      extensions,
      adapter?.languageId ?? ext,
      content,
    );
    const importTargets = importResolution.targets;

    const exportSymbols = symbolDetails.filter(
      (d) => d.extractedSymbol.exported,
    );
    const edgeSourceDetails =
      exportSymbols.length > 0 ? exportSymbols : symbolDetails;

    for (const detail of symbolDetails) {
      const extracted = detail.extractedSymbol;
      const symbolId = detail.symbolId;

      const existingSymbol = existingSymbolsById.get(symbolId);
      const nativeSummary = detail.nativeSummary.trim();
      const nativeInvariantsJson = detail.nativeInvariantsJson.trim();
      const nativeSideEffectsJson = detail.nativeSideEffectsJson.trim();

      // Prefer existing values for stable IDs, then Rust-native metadata, then TS fallback.
      let summary =
        existingSymbol?.summary ?? (nativeSummary.length > 0 ? nativeSummary : null);
      if (summary === null) {
        summary = generateSummary(extracted as any, content);
      }

      let invariantsJson =
        existingSymbol?.invariants_json ??
        (nativeInvariantsJson.length > 0 && nativeInvariantsJson !== "[]"
          ? nativeInvariantsJson
          : null);
      if (invariantsJson === null) {
        const invariants = extractInvariants(extracted as any, content);
        invariantsJson =
          invariants.length > 0 ? JSON.stringify(invariants) : null;
      }

      let sideEffectsJson =
        existingSymbol?.side_effects_json ??
        (nativeSideEffectsJson.length > 0 && nativeSideEffectsJson !== "[]"
          ? nativeSideEffectsJson
          : null);
      if (sideEffectsJson === null) {
        const sideEffects = extractSideEffects(extracted as any, content);
        sideEffectsJson =
          sideEffects.length > 0 ? JSON.stringify(sideEffects) : null;
      }

      const symbol: SymbolRow = {
        symbol_id: symbolId,
        repo_id: repoId,
        file_id: file.file_id,
        kind: extracted.kind,
        name: extracted.name,
        exported: extracted.exported ? 1 : 0,
        visibility: extracted.visibility || null,
        language: adapter?.languageId ?? ext,
        range_start_line: extracted.range.startLine,
        range_start_col: extracted.range.startCol,
        range_end_line: extracted.range.endLine,
        range_end_col: extracted.range.endCol,
        ast_fingerprint: detail.astFingerprint,
        signature_json: extracted.signature
          ? JSON.stringify(extracted.signature)
          : null,
        summary,
        invariants_json: invariantsJson,
        side_effects_json: sideEffectsJson,
        updated_at: new Date().toISOString(),
      };

      upsertSymbolTransaction(symbol);
      addToSymbolIndex(
        symbolIndex,
        fileMeta.path,
        symbol.symbol_id,
        symbol.name,
        symbol.kind,
      );

      if (
        edgeSourceDetails.some(
          (s) => s.extractedSymbol.nodeId === extracted.nodeId,
        )
      ) {
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
          if (call.callerNodeId !== extracted.nodeId) {
            continue;
          }

          const resolved = resolveCallTarget(
            call,
            nodeIdToSymbolId,
            nameToSymbolIds,
            importResolution.importedNameToSymbolIds,
            importResolution.namespaceImports,
            adapter,
          );

          if (!resolved) continue;

          if (resolved.isResolved && resolved.symbolId) {
            const edgeKey = `${symbolId}->${resolved.symbolId}`;
            if (createdCallEdges.has(edgeKey)) continue;

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
            createdCallEdges.add(edgeKey);
            edgesCreated++;
          } else if (resolved.targetName) {
            const unresolvedTargetId = `unresolved:call:${resolved.targetName}`;
            const edgeKey = `${symbolId}->${unresolvedTargetId}`;
            if (createdCallEdges.has(edgeKey)) continue;

            const edge: EdgeRow = {
              repo_id: repoId,
              from_symbol_id: symbolId,
              to_symbol_id: unresolvedTargetId,
              type: "call",
              weight: 0.5,
              confidence: resolved.confidence,
              resolution_strategy: "unresolved",
              provenance: `unresolved-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
              created_at: new Date().toISOString(),
            };
            createEdgeTransaction(edge);
            createdCallEdges.add(edgeKey);
            edgesCreated++;
          }
        }
      }
    }

    prefetchFileExports(repoId, fileMeta.path);

    return { symbolsIndexed, edgesCreated, changed: true, configEdges: [] };
  } catch (error) {
    logger.error(`Error processing Rust result for ${fileMeta.path}: ${error}`);
    return {
      symbolsIndexed: 0,
      edgesCreated: 0,
      changed: false,
      configEdges: [],
    };
  }
}

function isTestFile(relPath: string, languages: string[]): boolean {
  const ext = relPath.split(".").pop() || "";
  if (!languages.includes(ext)) return false;

  const fileName = relPath.split("/").pop() || relPath.split("\\").pop() || "";
  const hasTestSuffix =
    fileName.includes(".test.") || fileName.includes(".spec.");
  const isInTestDir =
    relPath.includes("/tests/") ||
    relPath.includes("\\tests\\") ||
    relPath.includes("/__tests__/") ||
    relPath.includes("\\__tests__\\");

  return hasTestSuffix || isInTestDir;
}

function extractSymbolReferences(
  content: string,
  repoId: string,
  fileId: number,
): void {
  const tokens = content.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (!tokens) return;

  const uniqueTokens = new Set(tokens);
  const createdAt = new Date().toISOString();

  for (const token of uniqueTokens) {
    insertSymbolReference({
      repo_id: repoId,
      symbol_name: token,
      file_id: fileId,
      line_number: null,
      created_at: createdAt,
    });
  }
}

async function resolveImportTargets(
  repoId: string,
  repoRoot: string,
  importerRelPath: string,
  imports: ExtractedImport[],
  extensions: string[],
  importerLanguage: string,
  sourceContent?: string,
): Promise<{
  targets: Array<{ symbolId: string; provenance: string }>;
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
}> {
  const targets: Array<{ symbolId: string; provenance: string }> = [];
  const importedNameToSymbolIds = new Map<string, string[]>();
  const namespaceImports = new Map<string, Map<string, string>>();
  const allImports = sourceContent
    ? [...imports, ...extractCommonJsRequireImports(sourceContent)]
    : imports;

  for (const imp of allImports) {
    const resolvedPath = await resolveImportToPath(
      repoRoot,
      importerRelPath,
      imp.specifier,
      extensions,
    );

    const importedNames = new Set<string>();
    if (imp.defaultImport) importedNames.add(imp.defaultImport);
    for (const name of imp.imports) importedNames.add(name);

    if (importedNames.size === 0) {
      importedNames.add("*");
    }

    if (!resolvedPath) {
      for (const name of importedNames) {
        targets.push({
          symbolId: `unresolved:${imp.specifier}:${name}`,
          provenance: `${imp.specifier}:${name}`,
        });
      }
      if (imp.namespaceImport) {
        targets.push({
          symbolId: `unresolved:${imp.specifier}:* as ${imp.namespaceImport}`,
          provenance: `${imp.specifier}:* as ${imp.namespaceImport}`,
        });
      }
      continue;
    }

    const targetFile = getFileByRepoPath(repoId, resolvedPath);
    if (!targetFile) {
      for (const name of importedNames) {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:${name}`,
          provenance: `${resolvedPath}:${name}`,
        });
      }
      if (imp.namespaceImport) {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:* as ${imp.namespaceImport}`,
          provenance: `${resolvedPath}:* as ${imp.namespaceImport}`,
        });
      }
      continue;
    }

    // ML-D.1: Language-aware import resolution
    // Cross-language imports are resolved when possible
    if (targetFile.language !== importerLanguage) {
      for (const name of importedNames) {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:${name}`,
          provenance: `cross-language:${targetFile.language}->${importerLanguage}:${name}`,
        });
      }
      if (imp.namespaceImport) {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:* as ${imp.namespaceImport}`,
          provenance: `cross-language:${targetFile.language}->${importerLanguage}:* as ${imp.namespaceImport}`,
        });
      }
    }

    const targetSymbols = getSymbolsByFileLite(targetFile.file_id).filter(
      (symbol) => symbol.exported === 1,
    );

    for (const name of importedNames) {
      if (name.startsWith("*")) {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:${name}`,
          provenance: `${resolvedPath}:${name}`,
        });
        continue;
      }

      let match = targetSymbols.find((symbol) => symbol.name === name);
      if (!match && imp.defaultImport === name && targetSymbols.length === 1) {
        match = targetSymbols[0];
      }

      if (match) {
        targets.push({
          symbolId: match.symbol_id,
          provenance: `${resolvedPath}:${name}`,
        });
        const existing = importedNameToSymbolIds.get(name) ?? [];
        existing.push(match.symbol_id);
        importedNameToSymbolIds.set(name, existing);
      } else {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:${name}`,
          provenance: `${resolvedPath}:${name}`,
        });
      }
    }

    if (imp.namespaceImport) {
      const namespaceMap = new Map<string, string>();
      for (const symbol of targetSymbols) {
        namespaceMap.set(symbol.name, symbol.symbol_id);
        targets.push({
          symbolId: symbol.symbol_id,
          provenance: `${resolvedPath}:*`,
        });
      }
      if (namespaceMap.size > 0) {
        namespaceImports.set(imp.namespaceImport, namespaceMap);
      } else {
        targets.push({
          symbolId: `unresolved:${resolvedPath}:* as ${imp.namespaceImport}`,
          provenance: `${resolvedPath}:* as ${imp.namespaceImport}`,
        });
      }
    }
  }

  return { targets, importedNameToSymbolIds, namespaceImports };
}

function extractCommonJsRequireImports(content: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const seen = new Set<string>();

  const requireNamespaceRe =
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;
  const requireDestructureRe =
    /\b(?:const|let|var)\s*\{\s*([^}]+)\s*\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of content.matchAll(requireNamespaceRe)) {
    const alias = match[1];
    const specifier = match[2];
    if (!alias || !specifier) continue;
    const key = `ns:${alias}:${specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    imports.push({
      specifier,
      isRelative,
      isExternal: !isRelative,
      imports: [],
      namespaceImport: alias,
      isReExport: false,
    });
  }

  for (const match of content.matchAll(requireDestructureRe)) {
    const namesRaw = match[1];
    const specifier = match[2];
    if (!namesRaw || !specifier) continue;
    const names = namesRaw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const colonIdx = part.indexOf(":");
        if (colonIdx === -1) return part;
        return part.slice(colonIdx + 1).trim();
      });
    if (names.length === 0) continue;
    const key = `destruct:${names.join(",")}:${specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    imports.push({
      specifier,
      isRelative,
      isExternal: !isRelative,
      imports: names,
      isReExport: false,
    });
  }

  return imports;
}

async function resolveImportToPath(
  repoRoot: string,
  importerRelPath: string,
  specifier: string,
  extensions: string[],
): Promise<string | null> {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return null;
  }

  const importerDir = dirname(importerRelPath);
  const baseRelPath = normalizePath(join(importerDir, specifier));
  const baseAbsPath = resolve(repoRoot, baseRelPath);

  const hasExtension = extensions.some((ext) => baseRelPath.endsWith(ext));
  const candidates: string[] = [];

  if (hasExtension) {
    candidates.push(baseRelPath);
  } else {
    for (const ext of extensions) {
      candidates.push(`${baseRelPath}${ext}`);
    }
    for (const ext of extensions) {
      candidates.push(normalizePath(join(baseRelPath, `index${ext}`)));
    }
  }

  for (const relPath of candidates) {
    const absPath = resolve(repoRoot, relPath);
    if (await existsAsync(absPath)) {
      return normalizePath(relPath);
    }
  }

  if (hasExtension && (await existsAsync(baseAbsPath))) {
    return normalizePath(baseRelPath);
  }

  return null;
}

/**
 * Result of resolving a call target
 * 36-1.3: Now returns unresolved results with candidate info instead of null
 */
interface ResolvedCallTarget {
  symbolId: string | null;
  isResolved: boolean;
  confidence: number;
  strategy: "exact" | "heuristic" | "unresolved";
  candidateCount?: number;
  targetName?: string;
}

function finalizeCallResolution(input: {
  symbolId: string | null;
  isResolved: boolean;
  strategy?: "exact" | "heuristic" | "unresolved";
  confidence?: number;
  candidateCount?: number;
  targetName?: string;
}): ResolvedCallTarget {
  const calibrated = calibrateResolutionConfidence({
    isResolved: input.isResolved,
    strategy: input.strategy,
    candidateCount: input.candidateCount,
    baseConfidence: input.confidence,
  });
  return {
    symbolId: input.symbolId,
    isResolved: input.isResolved,
    confidence: calibrated.confidence,
    strategy: calibrated.strategy,
    candidateCount: input.candidateCount,
    targetName: input.targetName,
  };
}

function normalizeAdapterResolution(
  adapterResolved: AdapterResolvedCall,
): ResolvedCallTarget {
  return finalizeCallResolution({
    symbolId: adapterResolved.symbolId,
    isResolved: adapterResolved.isResolved,
    confidence: adapterResolved.confidence,
    strategy: adapterResolved.strategy,
    candidateCount: adapterResolved.candidateCount,
    targetName: adapterResolved.targetName,
  });
}

function resolveCallTarget(
  call: ExtractedCall,
  nodeIdToSymbolId: Map<string, string>,
  nameToSymbolIds: Map<string, string[]>,
  importedNameToSymbolIds: Map<string, string[]>,
  namespaceImports: Map<string, Map<string, string>>,
  adapter?: LanguageAdapter | null,
): ResolvedCallTarget | null {
  if (adapter?.resolveCall) {
    const adapterResolved = adapter.resolveCall({
      call,
      importedNameToSymbolIds,
      namespaceImports,
      nameToSymbolIds,
    });
    if (adapterResolved) {
      return normalizeAdapterResolution(adapterResolved);
    }
  }

  // Already resolved to a specific symbol
  if (call.calleeSymbolId && nodeIdToSymbolId.has(call.calleeSymbolId)) {
    return finalizeCallResolution({
      symbolId: nodeIdToSymbolId.get(call.calleeSymbolId) ?? null,
      isResolved: true,
      strategy: "exact",
      confidence: 0.85,
    });
  }

  const candidateId = call.calleeSymbolId ?? call.calleeIdentifier;
  if (!candidateId) {
    return null;
  }

  const cleaned = candidateId.replace(/^new\s+/, "");
  if (cleaned.includes(".")) {
    const parts = cleaned.split(".");
    const prefix = parts[0];
    const member = parts[parts.length - 1];
    const namespace = namespaceImports.get(prefix);
    if (namespace && namespace.has(member)) {
      return finalizeCallResolution({
        symbolId: namespace.get(member) ?? null,
        isResolved: true,
        strategy: "exact",
        confidence: 0.92,
      });
    }
  }

  const identifier = extractLastIdentifier(candidateId);
  if (!identifier) {
    return null;
  }

  // Check imported names first
  const importedCandidates = importedNameToSymbolIds.get(identifier);
  if (importedCandidates && importedCandidates.length === 1) {
    return finalizeCallResolution({
      symbolId: importedCandidates[0],
      isResolved: true,
      strategy: "exact",
      confidence: 0.9,
    });
  }

  // 36-1.3: Handle ambiguous imported names - create unresolved edge
  if (importedCandidates && importedCandidates.length > 1) {
    return finalizeCallResolution({
      symbolId: null,
      isResolved: false,
      strategy: "unresolved",
      candidateCount: importedCandidates.length,
      targetName: identifier,
    });
  }

  // Check local symbols
  const candidates = nameToSymbolIds.get(identifier);
  if (candidates && candidates.length === 1) {
    return finalizeCallResolution({
      symbolId: candidates[0],
      isResolved: true,
      strategy: "heuristic",
      confidence: cleaned.includes(".") ? 0.68 : 0.8,
    });
  }

  // 36-1.3: Handle ambiguous local names - create unresolved edge
  if (candidates && candidates.length > 1) {
    return finalizeCallResolution({
      symbolId: null,
      isResolved: false,
      strategy: "unresolved",
      candidateCount: candidates.length,
      targetName: identifier,
    });
  }

  // No candidates at all - still create an unresolved edge if we have a name
  // This helps with external calls that might be resolved later
  if (identifier && call.callType !== "dynamic") {
    return finalizeCallResolution({
      symbolId: null,
      isResolved: false,
      strategy: "unresolved",
      candidateCount: 0,
      targetName: identifier,
    });
  }

  return null;
}

function extractLastIdentifier(text: string): string | null {
  const cleaned = text.replace(/^new\s+/, "");
  const parts = cleaned.split(".");
  const last = parts[parts.length - 1]?.trim();
  return last || null;
}

function addToSymbolIndex(
  index: SymbolIndex,
  filePath: string,
  symbolId: string,
  name: string,
  kind: SymbolKind,
): void {
  const fileKey = normalizePath(filePath);
  let fileEntry = index.get(fileKey);
  if (!fileEntry) {
    fileEntry = new Map();
    index.set(fileKey, fileEntry);
  }

  let nameEntry = fileEntry.get(name);
  if (!nameEntry) {
    nameEntry = new Map();
    fileEntry.set(name, nameEntry);
  }

  const kindEntry = nameEntry.get(kind) ?? [];
  kindEntry.push(symbolId);
  nameEntry.set(kind, kindEntry);
}

function resolveSymbolIdFromIndex(
  index: SymbolIndex,
  repoId: string,
  filePath: string,
  name: string,
  kind: SymbolKind,
  callerLanguage?: string,
): string | null {
  const fileEntry = index.get(normalizePath(filePath));
  if (!fileEntry) return null;
  const nameEntry = fileEntry.get(name);
  if (!nameEntry) return null;
  const candidates = nameEntry.get(kind);
  if (!candidates || candidates.length !== 1) return null;

  // ML-D.1: Language-aware symbol resolution
  // If callerLanguage is provided, check if the target file is the same language
  if (callerLanguage) {
    const targetFile = getFileByRepoPath(repoId, filePath);
    if (targetFile && targetFile.language !== callerLanguage) {
      // Cross-language call - return null to mark as unresolved
      return null;
    }
  }

  return candidates[0];
}

function resolvePendingCallEdges(
  pending: PendingCallEdge[],
  index: SymbolIndex,
  created: Set<string>,
  repoId: string,
): void {
  for (const edge of pending) {
    const toSymbolId = resolveSymbolIdFromIndex(
      index,
      repoId,
      edge.toFile,
      edge.toName,
      edge.toKind,
      edge.callerLanguage,
    );
    if (!toSymbolId) {
      continue;
    }

    const edgeKey = `${edge.fromSymbolId}->${toSymbolId}`;
    if (created.has(edgeKey)) {
      continue;
    }

    createEdgeTransaction({
      repo_id: repoId,
      from_symbol_id: edge.fromSymbolId,
      to_symbol_id: toSymbolId,
      type: "call",
      weight: 1.0,
      confidence: edge.confidence ?? 1.0,
      resolution_strategy: edge.strategy ?? "heuristic",
      provenance: edge.provenance,
      created_at: new Date().toISOString(),
    });
    created.add(edgeKey);
  }
}

function resolvePass2Targets(params: {
  repoId: string;
  mode: "full" | "incremental";
  tsFiles: FileMetadata[];
  changedTsFilePaths: Set<string>;
}): FileMetadata[] {
  const { repoId, mode, tsFiles, changedTsFilePaths } = params;
  if (mode === "full") {
    return tsFiles;
  }
  if (changedTsFilePaths.size === 0) {
    return [];
  }

  const tsFilesByPath = new Map(tsFiles.map((file) => [file.path, file]));
  const targetPaths = new Set<string>(changedTsFilePaths);
  const changedSymbolIds = new Set<string>();

  for (const changedPath of changedTsFilePaths) {
    const file = getFileByRepoPath(repoId, changedPath);
    if (!file) continue;
    const symbols = getSymbolsByFile(file.file_id);
    for (const symbol of symbols) {
      changedSymbolIds.add(symbol.symbol_id);
    }
  }

  if (changedSymbolIds.size === 0) {
    return Array.from(targetPaths)
      .map((path) => tsFilesByPath.get(path))
      .filter((file): file is FileMetadata => Boolean(file));
  }

  const importEdges = getEdgesByRepo(repoId).filter((edge) => edge.type === "import");
  for (const edge of importEdges) {
    if (!changedSymbolIds.has(edge.to_symbol_id)) continue;
    const fromSymbol = getSymbol(edge.from_symbol_id);
    if (!fromSymbol) continue;
    const fromFile = getFile(fromSymbol.file_id);
    if (!fromFile) continue;
    if (!isTsCallResolutionFile(fromFile.rel_path)) continue;
    targetPaths.add(fromFile.rel_path);
  }

  return Array.from(targetPaths)
    .map((path) => tsFilesByPath.get(path))
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
}): Promise<number> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    symbolIndex,
    tsResolver,
    languages,
    createdCallEdges,
  } = params;
  if (!isTsCallResolutionFile(fileMeta.path)) {
    return 0;
  }

  try {
    const filePath = join(repoRoot, fileMeta.path);
    const content = await readFileAsync(filePath, "utf-8");
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
      symbolsWithNodeIds as any,
    );

    const fileRecord = getFileByRepoPath(repoId, fileMeta.path);
    if (!fileRecord) {
      return 0;
    }
    const existingSymbols = getSymbolsByFile(fileRecord.file_id);
    const toSymbolKey = (
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
    const symbolIdByKey = new Map<string, string>();
    for (const symbol of existingSymbols) {
      symbolIdByKey.set(
        toSymbolKey(symbol.kind, symbol.name, {
          startLine: symbol.range_start_line,
          startCol: symbol.range_start_col,
          endLine: symbol.range_end_line,
          endCol: symbol.range_end_col,
        }),
        symbol.symbol_id,
      );
    }

    const symbolDetails = symbolsWithNodeIds.map((extractedSymbol) => {
      const symbolId =
        symbolIdByKey.get(
          toSymbolKey(
            extractedSymbol.kind,
            extractedSymbol.name,
            extractedSymbol.range,
          ),
        ) ??
        generateSymbolId(
          repoId,
          fileMeta.path,
          extractedSymbol.kind,
          extractedSymbol.name,
          "",
        );
      return {
        extractedSymbol,
        symbolId,
      };
    });

    const existingSymbolIds = new Set(existingSymbols.map((symbol) => symbol.symbol_id));
    const filteredSymbolDetails = symbolDetails.filter((detail) =>
      existingSymbolIds.has(detail.symbolId),
    );

    if (filteredSymbolDetails.length === 0) {
      return 0;
    }

    for (const detail of filteredSymbolDetails) {
      deleteOutgoingCallEdgesBySymbol(detail.symbolId);
      for (const edgeKey of Array.from(createdCallEdges)) {
        if (edgeKey.startsWith(`${detail.symbolId}->`)) {
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

    let createdEdges = 0;
    for (const detail of filteredSymbolDetails) {
      for (const call of calls) {
        if (call.callerNodeId !== detail.extractedSymbol.nodeId) {
          continue;
        }
        const resolved = resolveCallTarget(
          call,
          nodeIdToSymbolId,
          nameToSymbolIds,
          importResolution.importedNameToSymbolIds,
          importResolution.namespaceImports,
          adapter,
        );
        if (!resolved) continue;

        if (resolved.isResolved && resolved.symbolId) {
          const edgeKey = `${detail.symbolId}->${resolved.symbolId}`;
          if (createdCallEdges.has(edgeKey)) continue;
          createEdgeTransaction({
            repo_id: repoId,
            from_symbol_id: detail.symbolId,
            to_symbol_id: resolved.symbolId,
            type: "call",
            weight: 1.0,
            confidence: resolved.confidence,
            resolution_strategy: resolved.strategy,
            provenance: `call:${call.calleeIdentifier}`,
            created_at: new Date().toISOString(),
          });
          createdCallEdges.add(edgeKey);
          createdEdges++;
        } else if (resolved.targetName) {
          const unresolvedTargetId = `unresolved:call:${resolved.targetName}`;
          const edgeKey = `${detail.symbolId}->${unresolvedTargetId}`;
          if (createdCallEdges.has(edgeKey)) continue;
          createEdgeTransaction({
            repo_id: repoId,
            from_symbol_id: detail.symbolId,
            to_symbol_id: unresolvedTargetId,
            type: "call",
            weight: 0.5,
            confidence: resolved.confidence,
            resolution_strategy: "unresolved",
            provenance: `unresolved-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
            created_at: new Date().toISOString(),
          });
          createdCallEdges.add(edgeKey);
          createdEdges++;
        }
      }
    }

    if (tsResolver) {
      const tsCalls = tsResolver.getResolvedCalls(fileMeta.path);
      for (const tsCall of tsCalls) {
        const callerNodeId = findEnclosingSymbolByRange(tsCall.caller, filteredSymbolDetails);
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
        if (!toSymbolId) continue;
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
        createdEdges++;
      }
    }

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

function cleanupUnresolvedEdges(repoId: string): void {
  const allEdges = getEdgesByRepo(repoId);
  const unresolvedEdges = allEdges.filter((edge: EdgeRow) =>
    edge.to_symbol_id.startsWith("unresolved:"),
  );

  const database = getDb();
  const deleteEdgeStmt = database.prepare(
    "DELETE FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ?",
  );

  // IE-K.3: Node.js built-ins to skip
  const nodeBuiltins = new Set([
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "crypto",
    "dgram",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "string_decoder",
    "sys",
    "timers",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "worker_threads",
    "zlib",
  ]);

  // IE-K.3: Check if unresolved edge points to external package
  const isExternalPackage = (target: string, edgeType: string): boolean => {
    // Import edges: unresolved:package:name (e.g., unresolved:tree-sitter:Parser)
    if (edgeType === "import") {
      const parts = target.split(":");
      if (parts.length >= 3) {
        const packagePath = parts[1];
        // Skip if not relative path (i.e., external package)
        if (
          !packagePath.startsWith("./") &&
          !packagePath.startsWith("../") &&
          !packagePath.startsWith("/")
        ) {
          return true;
        }
      }
    }

    // Call edges: unresolved:call:name or unresolved:call:package:name
    // Check if name matches known patterns (Node.js built-ins or external packages)
    if (target.startsWith("unresolved:call:")) {
      const namePart = target.slice("unresolved:call:".length);
      // Skip if name is a Node.js builtin
      if (nodeBuiltins.has(namePart)) {
        return true;
      }
      // Skip if name contains package-like pattern (e.g., "tree-sitter:Parser")
      if (
        namePart.includes(":") &&
        !namePart.startsWith("./") &&
        !namePart.startsWith("../")
      ) {
        return true;
      }
    }

    return false;
  };

  // Cache repo symbols for call edge resolution
  let repoSymbols: SymbolRow[] | null = null;
  const getRepoSymbolsCached = () => {
    if (!repoSymbols) {
      repoSymbols = getSymbolsByRepo(repoId);
    }
    return repoSymbols;
  };

  // Cache symbol-to-file mapping
  const symbolToFile = new Map<string, FileRow | null>();
  const getSymbolFile = (symbolId: string): FileRow | null => {
    if (symbolToFile.has(symbolId)) {
      return symbolToFile.get(symbolId) ?? null;
    }
    const symbol = getSymbol(symbolId);
    if (!symbol) {
      symbolToFile.set(symbolId, null);
      return null;
    }
    const file = getFile(symbol.file_id);
    symbolToFile.set(symbolId, file ?? null);
    return file ?? null;
  };

  for (const edge of unresolvedEdges) {
    const target = edge.to_symbol_id;

    // IE-K.3: Skip external package edges (don't try to resolve, don't warn)
    if (isExternalPackage(target, edge.type)) {
      continue;
    }

    let matchingSymbolId: string | undefined;

    // Format 1: unresolved:call:functionName - simple call edge
    const callMatch = target.match(/^unresolved:call:(.+)$/);
    if (callMatch) {
      const targetName = callMatch[1];
      const match = getRepoSymbolsCached().find((sym: SymbolRow) => {
        if (sym.name === targetName) return true;
        if (targetName.includes(":")) {
          const parts: string[] = targetName.split(":");
          return parts.some((part: string) => sym.name === part);
        }
        return false;
      });
      matchingSymbolId = match?.symbol_id;
    }

    // Format 2: unresolved:path/to/file.js:symbolName - import edge with file path
    // Skip namespace imports (* as X) and star imports (*)
    if (!callMatch && !target.includes(":*")) {
      // Parse: unresolved:path:symbolName (last colon separates path from symbol)
      const lastColon = target.lastIndexOf(":");
      if (lastColon > 11) {
        // "unresolved:".length = 11
        const pathPart = target.slice(11, lastColon);
        const symbolName = target.slice(lastColon + 1);

        // Get the source file to resolve relative paths
        const sourceFile = getSymbolFile(edge.from_symbol_id);

        if (
          sourceFile &&
          (pathPart.startsWith("./") || pathPart.startsWith("../"))
        ) {
          // Resolve relative path from source file's directory
          const sourceDir = dirname(sourceFile.rel_path);
          const joinedPath = join(sourceDir, pathPart);
          const normalizedJoined = normalizePath(joinedPath);

          // Try multiple path variants for better matching
          const pathVariants: string[] = [
            // Normalized path with original extension
            normalizedJoined,
            // .js -> .ts conversion
            normalizedJoined.replace(/\.js$/, ".ts"),
            // .jsx -> .tsx conversion
            normalizedJoined.replace(/\.jsx$/, ".tsx"),
            // Try with .ts extension if no extension
            !normalizedJoined.match(/\.(js|ts|jsx|tsx)$/)
              ? `${normalizedJoined}.ts`
              : normalizedJoined,
            // Try with .js extension if no extension
            !normalizedJoined.match(/\.(js|ts|jsx|tsx)$/)
              ? `${normalizedJoined}.js`
              : normalizedJoined,
            // Try index.ts (with and without trailing slash)
            normalizedJoined.replace(/\.(js|ts|jsx|tsx)$/, "") + "/index.ts",
            // Try index.js
            normalizedJoined.replace(/\.(js|ts|jsx|tsx)$/, "") + "/index.js",
            // Try removing any extension and keeping as directory
            normalizedJoined.replace(/\.(js|ts|jsx|tsx)$/, ""),
          ];

          // Remove duplicates from variants
          const uniqueVariants = [...new Set(pathVariants)];

          for (const variant of uniqueVariants) {
            const targetFile = getFileByRepoPath(repoId, variant);
            if (targetFile) {
              // Find exported symbol by name in that file
              const fileSymbols = getSymbolsByFileLite(
                targetFile.file_id,
              ).filter((s) => s.exported === 1);
              const match = fileSymbols.find((s) => s.name === symbolName);
              if (match) {
                matchingSymbolId = match.symbol_id;
                break;
              }

              // Fallback: if single export and looking for default
              if (!matchingSymbolId && fileSymbols.length === 1) {
                matchingSymbolId = fileSymbols[0].symbol_id;
                break;
              }
            }

            // IE-K.2: Try case-insensitive matching on Windows
            if (!matchingSymbolId && platform === "win32") {
              const allFiles = getFilesByRepo(repoId);
              const caseInsensitiveMatch = allFiles.find(
                (f) => f.rel_path.toLowerCase() === variant.toLowerCase(),
              );
              if (caseInsensitiveMatch) {
                const fileSymbols = getSymbolsByFileLite(
                  caseInsensitiveMatch.file_id,
                ).filter((s) => s.exported === 1);
                const match = fileSymbols.find((s) => s.name === symbolName);
                if (match) {
                  matchingSymbolId = match.symbol_id;
                  break;
                }

                // Fallback: if single export and looking for default
                if (!matchingSymbolId && fileSymbols.length === 1) {
                  matchingSymbolId = fileSymbols[0].symbol_id;
                  break;
                }
              }
            }
          }
        } else if (!pathPart.startsWith("./") && !pathPart.startsWith("../")) {
          // Non-relative import (node_modules, etc.) - skip
          continue;
        }
      }
    }

    if (matchingSymbolId) {
      deleteEdgeStmt.run(edge.from_symbol_id, edge.to_symbol_id);

      createEdgeTransaction({
        repo_id: edge.repo_id,
        from_symbol_id: edge.from_symbol_id,
        to_symbol_id: matchingSymbolId,
        type: edge.type,
        weight: edge.type === "import" ? 0.6 : 1.0,
        confidence: edge.confidence,
        resolution_strategy: edge.resolution_strategy,
        provenance: edge.provenance,
        created_at: new Date().toISOString(),
      });
    }
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
      range: {
        startLine: number;
        startCol: number;
        endLine: number;
        endCol: number;
      };
    };
  }>,
): string | null {
  let bestMatch: { nodeId: string; size: number } | null = null;

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
    if (!bestMatch || size < bestMatch.size) {
      bestMatch = { nodeId: detail.extractedSymbol.nodeId, size };
    }
  }

  return bestMatch?.nodeId ?? null;
}

export interface ResolveParserWorkerPoolSizeParams {
  configuredWorkerPoolSize?: number;
  concurrency: number;
  fileCount: number;
  cpuCount?: number;
}

export function resolveParserWorkerPoolSize(
  params: ResolveParserWorkerPoolSizeParams,
): number {
  const {
    configuredWorkerPoolSize,
    concurrency,
    fileCount,
    cpuCount = os.cpus().length,
  } = params;

  const boundedConcurrency = Math.max(1, concurrency);
  const boundedFileCount = Math.max(1, fileCount);
  const defaultPoolSize = Math.max(1, cpuCount - 1);
  const requestedPoolSize = configuredWorkerPoolSize ?? defaultPoolSize;

  return Math.max(
    1,
    Math.min(requestedPoolSize, boundedConcurrency, boundedFileCount),
  );
}

export async function indexRepo(
  repoId: string,
  mode: "full" | "incremental",
  onProgress?: (progress: IndexProgress) => void,
): Promise<IndexResult> {
  const startTime = Date.now();

  const repoRow = getRepo(repoId);
  if (!repoRow) {
    throw new Error(`Repository ${repoId} not found`);
  }

  const config: RepoConfig = JSON.parse(repoRow.config_json);

  onProgress?.({ stage: "scanning", current: 0, total: 0 });
  const files = await scanRepository(repoRow.root_path, config);

  onProgress?.({ stage: "parsing", current: 0, total: files.length });
  const appConfig = loadConfig();
  const concurrency = Math.max(
    1,
    Math.min(appConfig.indexing?.concurrency ?? 4, files.length || 1),
  );

  const useRustEngine =
    appConfig.indexing?.engine === "rust" && isRustEngineAvailable();

  // Only create worker pool for TypeScript engine
  let workerPool: ParserWorkerPool | null = null;
  if (!useRustEngine) {
    const workerPoolSize = resolveParserWorkerPoolSize({
      configuredWorkerPoolSize: appConfig.indexing?.workerPoolSize,
      concurrency,
      fileCount: files.length,
    });
    workerPool = new ParserWorkerPool(workerPoolSize);
  }

  if (useRustEngine) {
    logger.info("Using native Rust indexer engine for Pass 1");
  }

  const runIndex = async (): Promise<IndexResult> => {

  const existingFiles = getFilesByRepo(repoId);
  const existingByPath = new Map(
    existingFiles.map((file) => [file.rel_path, file]),
  );

  const scannedPaths = new Set(files.map((file) => file.path));
  let removedFiles = 0;

  for (const file of existingFiles) {
    if (!scannedPaths.has(file.rel_path)) {
      deleteFileTransaction(file.file_id);
      removedFiles++;
    }
  }

  const symbolIndex: SymbolIndex = new Map();
  const pendingCallEdges: PendingCallEdge[] = [];
  const createdCallEdges = new Set<string>();
  const tsResolver = createTsCallResolver(repoRow.root_path, files, {
    includeNodeModulesTypes: config.includeNodeModulesTypes,
  });

  const allSymbolsByName = new Map<string, SymbolRow[]>();
  const repoSymbols = getSymbolsByRepo(repoId);
  for (const symbol of repoSymbols) {
    const byName = allSymbolsByName.get(symbol.name) ?? [];
    byName.push(symbol);
    allSymbolsByName.set(symbol.name, byName);
  }

  let filesProcessed = 0;
  let changedFiles = 0;
  let totalSymbolsIndexed = 0;
  let totalEdgesCreated = 0;
  let configEdgesCreated = 0;
  const allConfigEdges: ConfigEdge[] = [];
  const changedFileIds = new Set<number>();
  const changedTsFilePaths = new Set<string>();
  const tsFiles = files.filter((file) => isTsCallResolutionFile(file.path));

  let nextIndex = 0;
  const updatePass1Progress = (currentFile?: string): void => {
    onProgress?.({
      stage: "pass1",
      current: Math.min(filesProcessed, files.length),
      total: files.length,
      currentFile,
    });
  };

  if (useRustEngine) {
    let rustFiles = files;
    let skippedRustFiles = 0;
    if (mode === "incremental") {
      rustFiles = files.filter((file) => {
        const existing = existingByPath.get(file.path);
        if (!existing?.last_indexed_at) {
          return true;
        }
        return file.mtime > new Date(existing.last_indexed_at).getTime();
      });
      skippedRustFiles = files.length - rustFiles.length;
    }

    // --- Rust engine: batch parse all files, then process results ---
    const rustResults = parseFilesRust(
      repoId,
      repoRow.root_path,
      rustFiles,
      concurrency,
    );

    if (rustResults) {
      filesProcessed += skippedRustFiles;

      const resultByPath = new Map<string, RustParseResult>();
      for (const result of rustResults) {
        resultByPath.set(result.relPath, result);
      }

      for (const file of rustFiles) {
        updatePass1Progress(file.path);
        const rustResult = resultByPath.get(file.path);
        if (!rustResult) {
          filesProcessed++;
          continue;
        }

        const skipCallResolution = isTsCallResolutionFile(file.path);

        try {
          const result = await processFileFromRustResult({
            repoId,
            repoRoot: repoRow.root_path,
            fileMeta: file,
            rustResult,
            languages: config.languages,
            mode,
            existingFile: existingByPath.get(file.path),
            symbolIndex,
            pendingCallEdges,
            createdCallEdges,
            tsResolver,
            config,
            allSymbolsByName,
            skipCallResolution,
          });
          filesProcessed++;
          if (result.changed) {
            changedFiles++;
            if (skipCallResolution) {
              changedTsFilePaths.add(file.path);
            }
            const fileRecord = getFileByRepoPath(repoId, file.path);
            if (fileRecord) {
              changedFileIds.add(fileRecord.file_id);
            }
          }
          totalSymbolsIndexed += result.symbolsIndexed;
          totalEdgesCreated += result.edgesCreated;
          allConfigEdges.push(...result.configEdges);
        } catch (error) {
          filesProcessed++;
          logger.error(`Error processing Rust result for ${file.path}: ${error}`);
        }
      }
    } else {
      // Rust engine returned null (addon not loadable) - fall through to TS
      logger.warn("Rust engine returned null, falling back to TypeScript engine");
    }
  }

  if (!useRustEngine || filesProcessed === 0) {
    // --- TypeScript engine: worker pool with concurrent processing ---
    const runWorker = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const index = nextIndex++;
        if (index >= files.length) {
          return;
        }

        const file = files[index];
        updatePass1Progress(file.path);
        const skipCallResolution = isTsCallResolutionFile(file.path);

        try {
          const result = await processFile({
            repoId,
            repoRoot: repoRow.root_path,
            fileMeta: file,
            languages: config.languages,
            mode,
            existingFile: existingByPath.get(file.path),
            symbolIndex,
            pendingCallEdges,
            createdCallEdges,
            tsResolver,
            config,
            allSymbolsByName,
            onProgress,
            workerPool,
            skipCallResolution,
          });
          filesProcessed++;
          if (result.changed) {
            changedFiles++;
            if (skipCallResolution) {
              changedTsFilePaths.add(file.path);
            }
            const fileRecord = getFileByRepoPath(repoId, file.path);
            if (fileRecord) {
              changedFileIds.add(fileRecord.file_id);
            }
          }
          totalSymbolsIndexed += result.symbolsIndexed;
          totalEdgesCreated += result.edgesCreated;
          allConfigEdges.push(...result.configEdges);
        } catch (error) {
          filesProcessed++;
          console.error(`Error processing file ${file.path}:`, error);
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, files.length || 1) },
      () => runWorker(),
    );
    await Promise.all(workers);
  }

  const refreshedSymbolIndex: SymbolIndex = new Map();
  const allFilesAfterPass1 = getFilesByRepo(repoId);
  const filePathById = new Map(allFilesAfterPass1.map((file) => [file.file_id, file.rel_path]));
  const symbolsAfterPass1 = getSymbolsByRepo(repoId);
  for (const symbol of symbolsAfterPass1) {
    const filePath = filePathById.get(symbol.file_id);
    if (!filePath) continue;
    addToSymbolIndex(
      refreshedSymbolIndex,
      filePath,
      symbol.symbol_id,
      symbol.name,
      symbol.kind,
    );
  }

  symbolIndex.clear();
  for (const [filePath, names] of refreshedSymbolIndex) {
    symbolIndex.set(filePath, names);
  }

  const pass2Targets = resolvePass2Targets({
    repoId,
    mode,
    tsFiles,
    changedTsFilePaths,
  });
  let pass2Processed = 0;
  for (const fileMeta of pass2Targets) {
    onProgress?.({
      stage: "pass2",
      current: pass2Processed,
      total: pass2Targets.length,
      currentFile: fileMeta.path,
    });
    const pass2Edges = await resolveTsCallEdgesPass2({
      repoId,
      repoRoot: repoRow.root_path,
      fileMeta,
      symbolIndex,
      tsResolver,
      languages: config.languages,
      createdCallEdges,
    });
    totalEdgesCreated += pass2Edges;
    pass2Processed++;
  }
  if (pass2Targets.length > 0) {
    onProgress?.({
      stage: "pass2",
      current: pass2Targets.length,
      total: pass2Targets.length,
    });
  }

  onProgress?.({
    stage: "finalizing",
    current: files.length,
    total: files.length,
  });

  changedFiles += removedFiles;

  resolvePendingCallEdges(
    pendingCallEdges,
    symbolIndex,
    createdCallEdges,
    repoId,
  );

  cleanupUnresolvedEdges(repoId);

  const configWeight =
    appConfig.slice?.edgeWeights?.config !== undefined
      ? appConfig.slice.edgeWeights.config
      : 0.8;

  for (const edge of allConfigEdges) {
    createEdgeTransaction({
      repo_id: repoId,
      from_symbol_id: edge.fromSymbolId,
      to_symbol_id: edge.toSymbolId,
      type: "config",
      weight: edge.weight ?? configWeight,
      provenance: edge.provenance ?? "config",
      created_at: new Date().toISOString(),
    });
    configEdgesCreated++;
  }

  const versionReason = mode === "full" ? "Full index" : "Incremental index";

  let versionId: string;
  if (changedFiles === 0 && mode === "incremental") {
    const latestVersion = getLatestVersion(repoId);
    versionId = latestVersion ? latestVersion.version_id : `v${Date.now()}`;

    if (!latestVersion) {
      const version = {
        version_id: versionId,
        repo_id: repoId,
        created_at: new Date().toISOString(),
        reason: versionReason,
        prev_version_hash: null,
        version_hash: null,
      };

      const symbols = getSymbolsByRepoForSnapshot(repoId);
      const snapshots = symbols.map((symbol) => ({
        version_id: versionId,
        symbol_id: symbol.symbol_id,
        ast_fingerprint: symbol.ast_fingerprint,
        signature_json: symbol.signature_json,
        summary: symbol.summary,
        invariants_json: symbol.invariants_json,
        side_effects_json: symbol.side_effects_json,
      }));

      createSnapshotTransaction(version, snapshots);
    }
  } else {
    versionId = `v${Date.now()}`;
    const version = {
      version_id: versionId,
      repo_id: repoId,
      created_at: new Date().toISOString(),
      reason: versionReason,
      prev_version_hash: null,
      version_hash: null,
    };

    const symbols = getSymbolsByRepoForSnapshot(repoId);
    const snapshots = symbols.map((symbol) => ({
      version_id: versionId,
      symbol_id: symbol.symbol_id,
      ast_fingerprint: symbol.ast_fingerprint,
      signature_json: symbol.signature_json,
      summary: symbol.summary,
      invariants_json: symbol.invariants_json,
      side_effects_json: symbol.side_effects_json,
    }));

    createSnapshotTransaction(version, snapshots);
  }

  const durationMs = Date.now() - startTime;

  const changedFileIdsParam = mode === "incremental" ? changedFileIds : undefined;
  await updateMetricsForRepo(repoId, changedFileIdsParam);

  if (appConfig.semantic?.enabled) {
    try {
      await refreshSymbolEmbeddings({
        repoId,
        provider: appConfig.semantic.provider ?? "mock",
        model: appConfig.semantic.model ?? "all-MiniLM-L6-v2",
      });
    } catch (error) {
      logger.warn(`Semantic embedding refresh skipped: ${String(error)}`);
    }
  }

  return {
    versionId,
    filesProcessed,
    changedFiles,
    removedFiles,
    symbolsIndexed: totalSymbolsIndexed,
    edgesCreated: totalEdgesCreated + configEdgesCreated,
    durationMs,
  };
  };

  try {
    return await runIndex();
  } finally {
    if (workerPool) {
      await workerPool.shutdown();
    }
  }
}

type SymbolIndex = Map<string, Map<string, Map<SymbolKind, string[]>>>;

interface PendingCallEdge {
  fromSymbolId: string;
  toFile: string;
  toName: string;
  toKind: SymbolKind;
  confidence?: number;
  strategy?: "exact" | "heuristic" | "unresolved";
  provenance: string;
  callerLanguage: string; // ML-D.1: Track caller's language for cross-language detection
}

interface TsCallResolver {
  getResolvedCalls: (relPath: string) => ResolvedCall[];
}

type ChokidarModule = { watch: (path: string, options?: unknown) => unknown };

function loadChokidar(): ChokidarModule | null {
  try {
    return require("chokidar");
  } catch {
    return null;
  }
}

const watcherErrors: string[] = [];
type MutableWatcherHealth = WatcherHealth & { pendingChanges: number };
type RuntimeWatcher = { close: () => Promise<void> };

const watcherHealthByRepo = new Map<string, MutableWatcherHealth>();

function cloneWatcherHealth(state: MutableWatcherHealth): WatcherHealth {
  return {
    enabled: state.enabled,
    running: state.running,
    filesWatched: state.filesWatched,
    eventsReceived: state.eventsReceived,
    eventsProcessed: state.eventsProcessed,
    errors: state.errors,
    queueDepth: state.queueDepth,
    restartCount: state.restartCount,
    stale: state.stale,
    lastEventAt: state.lastEventAt,
    lastSuccessfulReindexAt: state.lastSuccessfulReindexAt,
  };
}

export function getWatcherHealth(repoId: string): WatcherHealth | null {
  const state = watcherHealthByRepo.get(repoId);
  return state ? cloneWatcherHealth(state) : null;
}

export function getAllWatcherHealth(): Record<string, WatcherHealth> {
  const out: Record<string, WatcherHealth> = {};
  for (const [repoId, state] of watcherHealthByRepo.entries()) {
    out[repoId] = cloneWatcherHealth(state);
  }
  return out;
}

export function watchRepository(repoId: string): IndexWatchHandle {
  const repoRow = getRepo(repoId);
  if (!repoRow) {
    throw new Error(`Repository ${repoId} not found`);
  }

  const repoConfig: RepoConfig = JSON.parse(repoRow.config_json);
  const ignorePatterns = repoConfig.ignore ?? [];
  const extensions = repoConfig.languages.map((lang) => `.${lang}`);

  const appConfig = loadConfig();
  const maxWatchedFiles =
    appConfig.indexing?.maxWatchedFiles ?? WATCHER_DEFAULT_MAX_WATCHED_FILES;
  const estimatedFileCount = getFilesByRepo(repoId).length;
  if (estimatedFileCount > maxWatchedFiles) {
    throw new Error(
      `Watcher cap exceeded for ${repoId}: ${estimatedFileCount} files > maxWatchedFiles ${maxWatchedFiles}`,
    );
  }

  const health: MutableWatcherHealth = {
    enabled: true,
    running: true,
    filesWatched: estimatedFileCount,
    eventsReceived: 0,
    eventsProcessed: 0,
    errors: 0,
    queueDepth: 0,
    restartCount: 0,
    stale: false,
    lastEventAt: null,
    lastSuccessfulReindexAt: null,
    pendingChanges: 0,
  };
  watcherHealthByRepo.set(repoId, health);

  const pending = new Map<string, NodeJS.Timeout>();
  let activeWatcher: RuntimeWatcher | null = null;
  let closed = false;
  let restarting = false;
  let lastRestartMs = 0;
  const staleCheckIntervalMs = Math.max(
    5_000,
    Math.floor(WATCHER_STALE_THRESHOLD_MS / 4),
  );

  const updateQueueDepth = (): void => {
    health.queueDepth = pending.size;
  };

  const recordWatcherError = (message: string): void => {
    health.errors += 1;
    process.stderr.write(`${message}\n`);
    watcherErrors.push(`${new Date().toISOString()} - ${message}`);
    if (watcherErrors.length > WATCHER_ERROR_MAX_COUNT) {
      watcherErrors.shift();
    }
  };

  const markEventReceived = (): void => {
    health.eventsReceived += 1;
    health.lastEventAt = new Date().toISOString();
  };

  const reindexWithRetry = async (
    filePath: string,
    attempt = 0,
  ): Promise<void> => {
    try {
      process.stderr.write(`[sdl-mcp] File change detected: ${filePath}\n`);
      await indexRepo(repoId, "incremental");
      health.eventsProcessed += 1;
      health.pendingChanges = Math.max(0, health.pendingChanges - 1);
      health.lastSuccessfulReindexAt = new Date().toISOString();
      health.stale = false;
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : String(error);
      recordWatcherError(
        `[sdl-mcp] Failed incremental index for ${filePath}: ${msg}`,
      );
      if (attempt + 1 < WATCHER_REINDEX_MAX_ATTEMPTS && !closed) {
        const delay = Math.min(
          WATCHER_REINDEX_RETRY_MAX_MS,
          WATCHER_REINDEX_RETRY_BASE_MS * 2 ** attempt,
        );
        setTimeout(() => {
          void reindexWithRetry(filePath, attempt + 1);
        }, delay);
      }
    }
  };

  const schedule = (filePath: string): void => {
    const existing = pending.get(filePath);
    if (existing) {
      clearTimeout(existing);
    } else {
      health.pendingChanges += 1;
    }
    pending.set(
      filePath,
      setTimeout(() => {
        pending.delete(filePath);
        updateQueueDepth();
        void reindexWithRetry(filePath);
      }, WATCH_DEBOUNCE_MS),
    );
    updateQueueDepth();
  };

  const handler = (relativeFilePath: string): void => {
    if (shouldIgnorePath(relativeFilePath, ignorePatterns)) {
      return;
    }
    if (!matchesExtensions(relativeFilePath, extensions)) {
      return;
    }
    markEventReceived();
    schedule(relativeFilePath);
  };

  const startWatcher = (): RuntimeWatcher => {
    const chokidar = loadChokidar();
    if (chokidar) {
      const watcher = chokidar.watch(repoRow.root_path, {
        ignored: ignorePatterns,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: WATCH_STABILITY_THRESHOLD_MS,
          pollInterval: WATCH_POLL_INTERVAL_MS,
        },
      });

      (watcher as any).on("error", (error: Error) => {
        recordWatcherError(`[sdl-mcp] File watcher error: ${error}`);
      });

      (watcher as any).on("ready", () => {
        const watched = (watcher as any).getWatched?.();
        if (!watched || typeof watched !== "object") {
          return;
        }
        const count = Object.values(watched as Record<string, string[]>).reduce(
          (total, entries) => total + entries.length,
          0,
        );
        health.filesWatched = count;
      });

      const chokidarHandler = (filePath: string): void => {
        const relPath = normalizePath(relative(repoRow.root_path, filePath));
        handler(relPath);
      };

      (watcher as any).on("add", chokidarHandler);
      (watcher as any).on("change", chokidarHandler);
      (watcher as any).on("unlink", chokidarHandler);

      return {
        close: async () => {
          await (watcher as any).close();
        },
      };
    }

    const fsWatcher = watch(
      repoRow.root_path,
      { recursive: true },
      (_eventType, filename) => {
        if (!filename) return;
        handler(normalizePath(filename.toString()));
      },
    );

    return {
      close: async () => {
        fsWatcher.close();
      },
    };
  };

  const restartWatcher = async (reason: string): Promise<void> => {
    if (closed || restarting) {
      return;
    }
    const now = Date.now();
    if (now - lastRestartMs < WATCHER_STALE_THRESHOLD_MS / 2) {
      return;
    }
    restarting = true;
    lastRestartMs = now;
    health.restartCount += 1;
    process.stderr.write(`[sdl-mcp] Restarting watcher for ${repoId}: ${reason}\n`);
    try {
      if (activeWatcher) {
        await activeWatcher.close();
      }
      activeWatcher = startWatcher();
      health.running = true;
      health.stale = false;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      recordWatcherError(`[sdl-mcp] Failed to restart watcher for ${repoId}: ${msg}`);
    } finally {
      restarting = false;
    }
  };

  const staleTimer = setInterval(() => {
    if (closed) {
      return;
    }
    if (health.pendingChanges <= 0) {
      health.stale = false;
      return;
    }
    const lastSuccessMs = health.lastSuccessfulReindexAt
      ? Date.parse(health.lastSuccessfulReindexAt)
      : 0;
    const stale =
      lastSuccessMs === 0 || Date.now() - lastSuccessMs > WATCHER_STALE_THRESHOLD_MS;
    health.stale = stale;
    if (stale) {
      const staleMsg = `[sdl-mcp] Watcher stale detected for ${repoId}: pending=${health.pendingChanges}, queueDepth=${health.queueDepth}`;
      recordWatcherError(staleMsg);
      void restartWatcher("stale-index-detected");
    }
  }, staleCheckIntervalMs);

  activeWatcher = startWatcher();

  return {
    close: async () => {
      closed = true;
      clearInterval(staleTimer);
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
      updateQueueDepth();
      health.running = false;
      health.pendingChanges = 0;
      health.stale = false;
      if (activeWatcher) {
        await activeWatcher.close();
      }
    },
  };
}

function matchesExtensions(path: string, extensions: string[]): boolean {
  return extensions.some((ext) => path.endsWith(ext));
}

function shouldIgnorePath(path: string, ignorePatterns: string[]): boolean {
  const normalized = normalizePath(path);
  for (const pattern of ignorePatterns) {
    const token = pattern
      .replace(/\*\*\//g, "")
      .replace(/\/\*\*/g, "")
      .replace(/\*/g, "")
      .replace(/\/+/g, "/")
      .trim();
    if (!token) continue;
    if (normalized.includes(token)) {
      return true;
    }
  }
  return false;
}
