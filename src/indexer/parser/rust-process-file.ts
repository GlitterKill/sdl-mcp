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
import { logger } from "../../util/logger.js";
import type { PendingCallEdge, SymbolIndex, TsCallResolver } from "../edge-builder.js";
import {
  addToSymbolIndex,
  isBuiltinCall,
  resolveCallTarget,
  resolveImportTargets,
} from "../edge-builder.js";
import { getAdapterForExtension } from "../adapter/registry.js";
import type { ConfigEdge } from "../configEdges.js";
import type { FileMetadata } from "../fileScanner.js";
import type { RustParseResult } from "../rustIndexer.js";
import { extractInvariants, extractSideEffects, generateSummary } from "../summaries.js";
import { extractSymbolReferences, isTestFile } from "./helpers.js";

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
  globalNameToSymbolIds?: Map<string, string[]>;
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
    createdCallEdges,
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
            globalNameToSymbolIds,
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
            // Skip built-in method/constructor calls that can never resolve
            if (isBuiltinCall(resolved.targetName)) {
              continue;
            }
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
