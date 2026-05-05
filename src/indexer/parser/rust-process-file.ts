import { join } from "path";

import type { RepoConfig } from "../../config/types.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { prefetchFileExports } from "../../graph/prefetch.js";
import { readFileAsync } from "../../util/asyncFs.js";
import { logger } from "../../util/logger.js";
import { normalizePath } from "../../util/paths.js";
import {
  isTsCallResolutionFile,
  resolveImportTargets,
} from "../edge-builder.js";
import type {
  PendingCallEdge,
  SymbolIndex,
  TsCallResolver,
} from "../edge-builder.js";
import { getAdapterForExtension } from "../adapter/registry.js";
import type { FileMetadata } from "../fileScanner.js";
import type { RustParseResult } from "../rustIndexer.js";
import { buildSymbolAndEdgeRows } from "./build-rows.js";
import {
  buildSymbolIndexMaps,
  computePass2HintPaths,
  loadExistingSymbols,
} from "./symbol-mapping.js";
import type { ProcessFileResult, SymbolDetail } from "./types.js";
import type { BatchPersistAccumulator } from "./batch-persist.js";
import type { Pass1ExtractionCache } from "../pass2/types.js";

/**
 * Process a file using pre-parsed results from the Rust native engine.
 *
 * Handles DB writes, import edge resolution, and call edge resolution
 * using extraction data already computed by the Rust engine (symbols,
 * imports, calls, fingerprints, summaries, invariants, side effects).
 */
export async function processFileFromRustResult(params: {
  repoId: string;
  repoRoot: string;
  fileMeta: FileMetadata;
  rustResult: RustParseResult;
  languages: string[];
  mode: "full" | "incremental";
  existingFile?: {
    fileId: string;
    contentHash: string;
    lastIndexedAt: string | null;
  };
  symbolIndex: SymbolIndex;
  pendingCallEdges: PendingCallEdge[];
  createdCallEdges: Set<string>;
  tsResolver: TsCallResolver | null;
  config: RepoConfig;
  allSymbolsByName: Map<string, ladybugDb.SymbolLiteRow[]>;
  skipCallResolution: boolean;
  globalNameToSymbolIds?: Map<string, string[]>;
  globalPreferredSymbolId?: Map<string, string>;
  supportsPass2FilePath?: (relPath: string) => boolean;
  batchAccumulator?: BatchPersistAccumulator;
  pass1Extractions?: Pass1ExtractionCache;
}): Promise<ProcessFileResult> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    rustResult,
    languages,
    mode,
    existingFile,
    symbolIndex,
    createdCallEdges,
    skipCallResolution,
    globalNameToSymbolIds,
    globalPreferredSymbolId,
    supportsPass2FilePath = isTsCallResolutionFile,
  } = params;

  try {
    // ── Incremental mtime check ──────────────────────────────────
    if (mode === "incremental" && existingFile?.lastIndexedAt) {
      const lastIndexedMs = new Date(existingFile.lastIndexedAt).getTime();
      if (fileMeta.mtime <= lastIndexedMs) {
        logger.debug("Skipping file (mtime not newer than lastIndexedAt)", {
          file: fileMeta.path,
          fileMtime: fileMeta.mtime,
          lastIndexedMs,
        });
        return {
          symbolsIndexed: 0,
          edgesCreated: 0,
          changed: false,
          configEdges: [],
          pass2HintPaths: [],
        };
      }
    }

    const ext = fileMeta.path.split(".").pop() || "";
    const contentHash = rustResult.contentHash;
    const relPath = normalizePath(fileMeta.path);
    const fileId = existingFile?.fileId ?? `${repoId}:${relPath}`;

    if (rustResult.parseError) {
      logger.warn(
        `Rust parse error for ${fileMeta.path}: ${rustResult.parseError}`,
      );
    }

    // ── Content hash unchanged ───────────────────────────────────
    if (
      mode === "incremental" &&
      existingFile &&
      existingFile.contentHash === contentHash
    ) {
      logger.debug("Skipping file (content hash unchanged)", {
        file: fileMeta.path,
        contentHash,
      });
      return {
        symbolsIndexed: 0,
        edgesCreated: 0,
        changed: false,
        configEdges: [],
        pass2HintPaths: [],
      };
    }

    const conn = await getLadybugConn();

    // ── Language check ───────────────────────────────────────────
    if (!languages.includes(ext)) {
      await withWriteConn(async (wConn) => {
        await ladybugDb.withTransaction(wConn, async (txConn) => {
          if (existingFile) {
            await ladybugDb.deleteSymbolsByFileId(txConn, existingFile.fileId);
          }
          await ladybugDb.upsertFile(txConn, {
            fileId,
            repoId,
            relPath,
            contentHash,
            language: ext,
            byteSize: fileMeta.size,
            lastIndexedAt: new Date().toISOString(),
          });
        });
      });
      return {
        symbolsIndexed: 0,
        edgesCreated: 0,
        changed: true,
        configEdges: [],
        pass2HintPaths: [],
        symbolMapFileUpdate: {
          fileId,
          relPath,
          symbols: [],
        },
      };
    }

    const extWithDot = `.${ext}`;
    const adapter = getAdapterForExtension(extWithDot);
    const filePath = join(repoRoot, fileMeta.path);
    // Fix 1: Use content from Rust result to avoid double file read.
    // Falls back to async read for older addon versions without content.
    let content: string;
    if (rustResult.content != null) {
      content = rustResult.content;
    } else {
      try {
        content = await readFileAsync(filePath, "utf-8");
      } catch (readError: unknown) {
        const code = (readError as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EPERM") {
          logger.warn(
            `File disappeared before Rust post-processing: ${fileMeta.path}`,
            { code },
          );
          return {
            symbolsIndexed: 0,
            edgesCreated: 0,
            changed: false,
            configEdges: [],
            pass2HintPaths: [],
          };
        }
        throw readError;
      }
    }

    // C1: cache pass-1's extraction outputs so the TS pass-2 resolver can
    // skip a redundant tree-sitter parse + three `extract*` calls. Mirrors
    // the JS-engine path in process-file.ts; only TS-resolvable files are
    // captured because non-TS resolvers consume the live tree handle.
    if (
      params.pass1Extractions &&
      isTsCallResolutionFile(fileMeta.path) &&
      skipCallResolution
    ) {
      params.pass1Extractions.set(relPath, {
        symbolsWithNodeIds: rustResult.symbols.map((extracted) => ({
          nodeId: extracted.nodeId,
          kind: extracted.kind as import("./types.js").SymbolKindLiteral,
          name: extracted.name,
          exported: extracted.exported,
          range: extracted.range,
          signature: extracted.signature,
          visibility: extracted.visibility,
        })),
        imports: rustResult.imports,
        calls: rustResult.calls,
        content,
      });
    }

    // ── Phase 4: Load existing symbols ───────────────────────────
    const { existingSymbols, existingSymbolsById } = await loadExistingSymbols(
      conn,
      existingFile,
    );

    // ── Phase 5: Pass2 hint paths ────────────────────────────────
    const pass2HintPaths = await computePass2HintPaths({
      conn,
      mode,
      skipCallResolution,
      existingFile,
      existingSymbols,
      repoId,
      filePath: fileMeta.path,
      supportsPass2FilePath,
    });

    // ── Symbol details from Rust-native metadata ─────────────────
    const symbolDetails: SymbolDetail[] = rustResult.symbols.map(
      (extracted) => ({
        extractedSymbol: {
          nodeId: extracted.nodeId,
          kind: extracted.kind as import("./types.js").SymbolKindLiteral,
          name: extracted.name,
          exported: extracted.exported,
          range: extracted.range,
          signature: extracted.signature,
          visibility: extracted.visibility,
        },
        astFingerprint: extracted.astFingerprint,
        symbolId: extracted.symbolId,
        nativeSummary: extracted.summary,
        nativeInvariantsJson: extracted.invariantsJson,
        nativeSideEffectsJson: extracted.sideEffectsJson,
        nativeRoleTagsJson: extracted.roleTagsJson,
        nativeSearchText: extracted.searchText,
      }),
    );

    const { nodeIdToSymbolId, nameToSymbolIds } =
      buildSymbolIndexMaps(symbolDetails);

    // Phase 1 Task 1.6: Same-file resolution hints.
    // The TS Pass-1 extractor stamps isResolved / calleeSymbolId inline
    // when a call target name matches a same-file symbol. The Rust
    // extractor only produces raw calls, so we reproduce that lightweight
    // lookup here using the nameToSymbolIds map buildSymbolIndexMaps just
    // returned. Unique-match writes calleeSymbolId + isResolved; ambiguous
    // name writes candidateCount only.
    for (const call of rustResult.calls) {
      if (call.isResolved) continue;
      if (!call.calleeIdentifier) continue;
      const dotIdx = call.calleeIdentifier.lastIndexOf(".");
      const bareName =
        dotIdx >= 0
          ? call.calleeIdentifier.slice(dotIdx + 1)
          : call.calleeIdentifier;
      if (!bareName) continue;
      const candidates = nameToSymbolIds.get(bareName);
      if (!candidates || candidates.length === 0) continue;
      if (candidates.length === 1) {
        call.isResolved = true;
        call.calleeSymbolId = candidates[0];
      } else {
        call.candidateCount = candidates.length;
      }
    }

    // ── Import resolution ────────────────────────────────────────
    const extensions = languages.map((lang) => `.${lang}`);
    const importResolution = await resolveImportTargets(
      repoId,
      repoRoot,
      fileMeta.path,
      rustResult.imports,
      extensions,
      adapter?.languageId ?? ext,
      content,
    );

    // Determine edge source symbols
    const exportSymbols = symbolDetails.filter(
      (d) => d.extractedSymbol.exported,
    );
    const edgeSourceDetails =
      exportSymbols.length > 0 ? exportSymbols : symbolDetails;
    const edgeSourceNodeIds = new Set(
      edgeSourceDetails.map((d) => d.extractedSymbol.nodeId),
    );

    // ── Phase 7: Build symbol rows + edges (shared) ──────────────
    const {
      symbolsToUpsert,
      fileSymbols,
      edgesToInsert,
      symbolReferences,
      edgesCreated,
    } = await buildSymbolAndEdgeRows({
      repoId,
      relPath,
      fileId,
      filePath: fileMeta.path,
      content,
      ext,
      languages,
      symbolDetails,
      nodeIdToSymbolId,
      nameToSymbolIds,
      existingSymbolsById,
      importResolution,
      calls: rustResult.calls,
      edgeSourceNodeIds,
      languageId: adapter?.languageId ?? ext,
      symbolIndex,
      pendingCallEdges: params.pendingCallEdges,
      createdCallEdges,
      tsResolver: params.tsResolver,
      skipCallResolution,
      globalNameToSymbolIds,
      globalPreferredSymbolId,
      adapter,
    });

    // ── Persist ──────────────────────────────────────────────────────────
    if (params.batchAccumulator) {
      params.batchAccumulator.addFile(
        {
          fileId,
          repoId,
          relPath,
          contentHash,
          language: ext,
          byteSize: fileMeta.size,
          lastIndexedAt: new Date().toISOString(),
        },
        existingFile?.fileId ?? null,
      );
      params.batchAccumulator.addSymbolReferences(symbolReferences);
      params.batchAccumulator.addSymbols(symbolsToUpsert);
      params.batchAccumulator.addEdges(edgesToInsert);
    } else {
      await withWriteConn(async (wConn) => {
        await ladybugDb.withTransaction(wConn, async (txConn) => {
          await ladybugDb.upsertFile(txConn, {
            fileId,
            repoId,
            relPath,
            contentHash,
            language: ext,
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
          await ladybugDb.upsertSymbolBatch(txConn, symbolsToUpsert);
          await ladybugDb.insertEdges(txConn, edgesToInsert);
        });
      });
    }

    prefetchFileExports(repoId, fileMeta.path);

    return {
      symbolsIndexed: symbolDetails.length,
      edgesCreated,
      changed: true,
      configEdges: [],
      pass2HintPaths,
      symbolMapFileUpdate: {
        fileId,
        relPath,
        symbols: fileSymbols.map((symbol) => ({
          symbolId: symbol.symbolId,
          repoId: symbol.repoId,
          fileId: symbol.fileId,
          name: symbol.name,
          kind: symbol.kind,
          exported: symbol.exported,
        })),
      },
    };
  } catch (error) {
    logger.error(`Error processing Rust result for ${fileMeta.path}: ${error}`);
    return {
      symbolsIndexed: 0,
      edgesCreated: 0,
      changed: false,
      configEdges: [],
      pass2HintPaths: [],
    };
  }
}
