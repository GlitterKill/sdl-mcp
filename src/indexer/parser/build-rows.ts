import type { EdgeRow, SymbolRow } from "../../db/ladybug-queries.js";
import type { SymbolKind } from "../../db/schema.js";
import {
  addToSymbolIndex,
  isBuiltinCall,
  resolveCallTarget,
} from "../edge-builder.js";
import { resolveSymbolEnrichment } from "../symbol-enrichment.js";
import {
  classifySummarySource,
  extractInvariants,
  extractSideEffects,
  generateSummary,
  getSummaryQuality,
  hasJSDoc,
  isNameOnlySummary,
} from "../summaries.js";
import { buildSymbolReferences, isTestFile, resolveTsCallEdges } from "./helpers.js";
import type { BuildRowsParams, BuildRowsResult } from "./types.js";

/**
 * Phase 7: Build symbol rows and edge rows from symbol details.
 *
 * Shared by both the TypeScript parse path (`processFile`) and the
 * Rust native parse path (`processFileFromRustResult`).
 *
 * For each symbol: generates/reuses summary, extracts invariants and
 * side effects, computes enrichment (role tags, search text), builds
 * the SymbolRow, then creates import edges and call edges.
 */
export async function buildSymbolAndEdgeRows(
  params: BuildRowsParams,
): Promise<BuildRowsResult> {
  const {
    repoId,
    relPath,
    fileId,
    filePath,
    content,
    languages,
    symbolDetails,
    nodeIdToSymbolId,
    nameToSymbolIds,
    existingSymbolsById,
    importResolution,
    calls,
    edgeSourceNodeIds,
    languageId,
    symbolIndex,
    pendingCallEdges,
    createdCallEdges,
    tsResolver,
    skipCallResolution,
    globalNameToSymbolIds,
    globalPreferredSymbolId,
    adapter,
  } = params;

  const { targets: importTargets } = importResolution;

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
  let edgesCreated = 0;

  for (const detail of symbolDetails) {
    const extractedSymbol = detail.extractedSymbol;
    const symbolId = detail.symbolId;

    const existingSymbol = existingSymbolsById.get(symbolId);

    // ── Summary ──────────────────────────────────────────────────
    const nativeSummary =
      typeof detail.nativeSummary === "string"
        ? detail.nativeSummary.trim()
        : "";
    const nativeInvariantsJson =
      typeof detail.nativeInvariantsJson === "string"
        ? detail.nativeInvariantsJson.trim()
        : "";
    const nativeSideEffectsJson =
      typeof detail.nativeSideEffectsJson === "string"
        ? detail.nativeSideEffectsJson.trim()
        : "";
    const nativeRoleTagsJson =
      typeof detail.nativeRoleTagsJson === "string"
        ? detail.nativeRoleTagsJson.trim()
        : "";
    const nativeSearchText =
      typeof detail.nativeSearchText === "string"
        ? detail.nativeSearchText.trim()
        : "";

    // Prefer existing values, then Rust-native metadata, then TS fallback.
    // Filter out stale name-only summaries so they get regenerated.
    const nativeSummaryValue =
      nativeSummary.length > 0 &&
      !isNameOnlySummary(nativeSummary, extractedSymbol.name)
        ? nativeSummary
        : null;
    let summary = existingSymbol?.summary ?? null;
    if (
      summary !== null &&
      isNameOnlySummary(summary, extractedSymbol.name)
    ) {
      summary = null;
    }
    summary = summary ?? nativeSummaryValue;
    if (summary === null) {
      summary = generateSummary(extractedSymbol, content);
    }

    // Summary quality/source metadata
    const hadJSDoc = hasJSDoc(extractedSymbol, content);
    const summarySource = classifySummarySource(
      summary,
      hadJSDoc,
      extractedSymbol.kind,
    );
    const summaryQuality = getSummaryQuality(summary, summarySource);

    // ── Invariants ───────────────────────────────────────────────
    let invariantsJson =
      existingSymbol?.invariantsJson ??
      (nativeInvariantsJson.length > 0 && nativeInvariantsJson !== "[]"
        ? nativeInvariantsJson
        : null);
    if (invariantsJson === null) {
      const invariants = extractInvariants(extractedSymbol, content);
      invariantsJson =
        invariants.length > 0 ? JSON.stringify(invariants) : null;
    }

    // ── Side effects ─────────────────────────────────────────────
    let sideEffectsJson =
      existingSymbol?.sideEffectsJson ??
      (nativeSideEffectsJson.length > 0 && nativeSideEffectsJson !== "[]"
        ? nativeSideEffectsJson
        : null);
    if (sideEffectsJson === null) {
      const sideEffects = extractSideEffects(extractedSymbol, content);
      sideEffectsJson =
        sideEffects.length > 0 ? JSON.stringify(sideEffects) : null;
    }

    // ── Enrichment ───────────────────────────────────────────────
    const { roleTagsJson, searchText } = resolveSymbolEnrichment({
      kind: extractedSymbol.kind,
      name: extractedSymbol.name,
      relPath,
      summary,
      signature: extractedSymbol.signature,
      nativeRoleTagsJson: nativeRoleTagsJson || undefined,
      nativeSearchText: nativeSearchText || undefined,
    });

    // ── SymbolRow ────────────────────────────────────────────────
    const symbol: SymbolRow = {
      symbolId,
      repoId,
      fileId,
      kind: extractedSymbol.kind,
      name: extractedSymbol.name,
      exported: extractedSymbol.exported,
      visibility: extractedSymbol.visibility || null,
      language: languageId,
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
      sideEffectsJson,
      summaryQuality,
      summarySource,
      roleTagsJson,
      searchText,
      updatedAt: now,
    };

    symbolsToUpsert.push(symbol);
    fileSymbols.push(symbol);
    if (symbolIndex) {
      addToSymbolIndex(
        symbolIndex,
        filePath,
        symbol.symbolId,
        symbol.name,
        symbol.kind as SymbolKind,
      );
    }

    // ── Import edges ─────────────────────────────────────────────
    if (edgeSourceNodeIds.has(extractedSymbol.nodeId)) {
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

    // ── Call edges ───────────────────────────────────────────────
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
          globalPreferredSymbolId,
        );

        if (!resolved) continue;

        if (resolved.isResolved && resolved.symbolId) {
          const edgeKey = `${symbolId}->${resolved.symbolId}`;
          if (createdCallEdges && createdCallEdges.has(edgeKey)) continue;

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
          if (isBuiltinCall(resolved.targetName)) continue;

          const unresolvedTargetId = `unresolved:call:${resolved.targetName}`;
          const edgeKey = `${symbolId}->${unresolvedTargetId}`;
          if (createdCallEdges && createdCallEdges.has(edgeKey)) continue;

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
            createdAt: now,
          };
          edgesToInsert.push(edge);
          createdCallEdges?.add(edgeKey);
          edgesCreated++;
        }
      }
    }
  }

  // ── TS call resolution ─────────────────────────────────────────
  if (
    !skipCallResolution &&
    tsResolver &&
    symbolIndex &&
    pendingCallEdges &&
    createdCallEdges
  ) {
    edgesCreated += await resolveTsCallEdges({
      tsResolver,
      filePath,
      symbolDetails,
      nodeIdToSymbolId,
      symbolIndex,
      repoId,
      languageId,
      createdCallEdges,
      pendingCallEdges,
      edgesToInsert,
    });
  }

  return {
    symbolsToUpsert,
    fileSymbols,
    edgesToInsert,
    symbolReferences,
    edgesCreated,
  };
}
