import { join } from "path";

import type { RepoConfig } from "../../config/types.js";
import { getKuzuConn } from "../../db/kuzu.js";
import * as kuzuDb from "../../db/kuzu-queries.js";
import type { EdgeRow, SymbolRow } from "../../db/kuzu-queries.js";
import type { SymbolKind } from "../../db/schema.js";
import { prefetchFileExports } from "../../graph/prefetch.js";
import { readFileAsync } from "../../util/asyncFs.js";
import { logger } from "../../util/logger.js";
import { normalizePath } from "../../util/paths.js";
import type { PendingCallEdge, SymbolIndex, TsCallResolver } from "../edge-builder.js";
import {
  addToSymbolIndex,
  isTsCallResolutionFile,
  isBuiltinCall,
  resolveCallTarget,
  resolveImportTargets,
} from "../edge-builder.js";
import { getAdapterForExtension } from "../adapter/registry.js";
import type { ConfigEdge } from "../configEdges.js";
import type { FileMetadata } from "../fileScanner.js";
import type { RustParseResult } from "../rustIndexer.js";
import { extractInvariants, extractSideEffects, generateSummary } from "../summaries.js";
import { buildSymbolReferences, isTestFile } from "./helpers.js";

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
  allSymbolsByName: Map<string, SymbolRow[]>;
  skipCallResolution: boolean;
  globalNameToSymbolIds?: Map<string, string[]>;
  supportsPass2FilePath?: (relPath: string) => boolean;
}): Promise<{
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
    rustResult,
    languages,
    mode,
    existingFile,
    symbolIndex,
    createdCallEdges,
    skipCallResolution,
    globalNameToSymbolIds,
    supportsPass2FilePath = isTsCallResolutionFile,
  } = params;

  try {
    if (mode === "incremental" && existingFile?.lastIndexedAt) {
      const lastIndexedMs = new Date(existingFile.lastIndexedAt).getTime();
      if (fileMeta.mtime <= lastIndexedMs) {
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

    if (
      mode === "incremental" &&
      existingFile &&
      existingFile.contentHash === contentHash
    ) {
      return {
        symbolsIndexed: 0,
        edgesCreated: 0,
        changed: false,
        configEdges: [],
        pass2HintPaths: [],
      };
    }

    const conn = await getKuzuConn();

    if (!languages.includes(ext)) {
      await kuzuDb.withTransaction(conn, async (txConn) => {
        if (existingFile) {
          await kuzuDb.deleteSymbolsByFileId(txConn, existingFile.fileId);
        }
        await kuzuDb.upsertFile(txConn, {
          fileId,
          repoId,
          relPath,
          contentHash,
          language: ext,
          byteSize: fileMeta.size,
          lastIndexedAt: new Date().toISOString(),
        });
      });
      return {
        symbolsIndexed: 0,
        edgesCreated: 0,
        changed: true,
        configEdges: [],
        pass2HintPaths: [],
      };
    }

    const extWithDot = `.${ext}`;
    const adapter = getAdapterForExtension(extWithDot);
    const filePath = join(repoRoot, fileMeta.path);
    const content = await readFileAsync(filePath, "utf-8");

    let pass2HintPaths: string[] = [];

    // Preserve previous symbol metadata before deleting rows for this file.
    let existingSymbols: SymbolRow[] = [];
    const existingSymbolsById = new Map<string, SymbolRow>();
    if (existingFile) {
      existingSymbols = await kuzuDb.getSymbolsByFile(
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
        const incomingByToSymbol = await kuzuDb.getEdgesToSymbols(
          conn,
          existingSymbols.map((s) => s.symbolId),
        );

        const importerSymbolIds = new Set<string>();
        for (const edges of incomingByToSymbol.values()) {
          for (const edge of edges) {
            if (edge.edgeType !== "import" && edge.edgeType !== "call") continue;
            importerSymbolIds.add(edge.fromSymbolId);
          }
        }

        if (importerSymbolIds.size > 0) {
          const importerSymbols = await kuzuDb.getSymbolsByIds(
            conn,
            Array.from(importerSymbolIds),
          );

          const fileIds = new Set<string>();
          for (const symbol of importerSymbols.values()) {
            fileIds.add(symbol.fileId);
          }

          const importerFiles = await kuzuDb.getFilesByIds(
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

    const symbolsWithIds = rustResult.symbols;
    const imports = rustResult.imports;
    const calls = rustResult.calls;
    const symbolsIndexed = symbolsWithIds.length;
    let edgesCreated = 0;
    const symbolReferences = isTestFile(relPath, languages)
      ? buildSymbolReferences(content, repoId, fileId)
      : [];

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

    const edgesToInsert: EdgeRow[] = [];
    const symbolsToUpsert: SymbolRow[] = [];

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
        existingSymbol?.invariantsJson ??
        (nativeInvariantsJson.length > 0 && nativeInvariantsJson !== "[]"
          ? nativeInvariantsJson
          : null);
      if (invariantsJson === null) {
        const invariants = extractInvariants(extracted as any, content);
        invariantsJson =
          invariants.length > 0 ? JSON.stringify(invariants) : null;
      }

      let sideEffectsJson =
        existingSymbol?.sideEffectsJson ??
        (nativeSideEffectsJson.length > 0 && nativeSideEffectsJson !== "[]"
          ? nativeSideEffectsJson
          : null);
      if (sideEffectsJson === null) {
        const sideEffects = extractSideEffects(extracted as any, content);
        sideEffectsJson =
          sideEffects.length > 0 ? JSON.stringify(sideEffects) : null;
      }

      const symbol: SymbolRow = {
        symbolId,
        repoId,
        fileId,
        kind: extracted.kind,
        name: extracted.name,
        exported: extracted.exported,
        visibility: extracted.visibility || null,
        language: adapter?.languageId ?? ext,
        rangeStartLine: extracted.range.startLine,
        rangeStartCol: extracted.range.startCol,
        rangeEndLine: extracted.range.endLine,
        rangeEndCol: extracted.range.endCol,
        astFingerprint: detail.astFingerprint,
        signatureJson: extracted.signature
          ? JSON.stringify(extracted.signature)
          : null,
        summary,
        invariantsJson,
        sideEffectsJson,
        updatedAt: new Date().toISOString(),
      };

      symbolsToUpsert.push(symbol);
      addToSymbolIndex(
        symbolIndex,
        fileMeta.path,
        symbol.symbolId,
        symbol.name,
        symbol.kind as SymbolKind,
      );

      if (
        edgeSourceDetails.some(
          (s) => s.extractedSymbol.nodeId === extracted.nodeId,
        )
      ) {
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
            createdAt: new Date().toISOString(),
          };
          edgesToInsert.push(edge);
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
              createdAt: new Date().toISOString(),
            };
            edgesToInsert.push(edge);
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
              repoId,
              fromSymbolId: symbolId,
              toSymbolId: unresolvedTargetId,
              edgeType: "call",
              weight: 0.5,
              confidence: resolved.confidence,
              resolution: "unresolved",
              resolverId: "pass1-generic",
              resolutionPhase: "pass1",
              provenance: `unresolved-call:${call.calleeIdentifier}${resolved.candidateCount ? `:candidates=${resolved.candidateCount}` : ""}`,
              createdAt: new Date().toISOString(),
            };
            edgesToInsert.push(edge);
            createdCallEdges.add(edgeKey);
            edgesCreated++;
          }
        }
      }
    }

    await kuzuDb.withTransaction(conn, async (txConn) => {
      await kuzuDb.upsertFile(txConn, {
        fileId,
        repoId,
        relPath,
        contentHash,
        language: ext,
        byteSize: fileMeta.size,
        lastIndexedAt: new Date().toISOString(),
      });

      if (existingFile) {
        await kuzuDb.deleteSymbolsByFileId(txConn, existingFile.fileId);
        await kuzuDb.deleteSymbolReferencesByFileId(txConn, existingFile.fileId);
      }

      await kuzuDb.insertSymbolReferences(txConn, symbolReferences);

      for (const symbol of symbolsToUpsert) {
        await kuzuDb.upsertSymbol(txConn, symbol);
      }

      await kuzuDb.insertEdges(txConn, edgesToInsert);
    });

    prefetchFileExports(repoId, fileMeta.path);

    return { symbolsIndexed, edgesCreated, changed: true, configEdges: [], pass2HintPaths };
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
