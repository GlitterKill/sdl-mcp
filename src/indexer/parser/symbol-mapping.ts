import type { Connection } from "kuzu";

import * as ladybugDb from "../../db/ladybug-queries.js";
import type { SymbolRow } from "../../db/ladybug-queries.js";
import { logger } from "../../util/logger.js";
import type { FileMetadata } from "../fileScanner.js";
import {
  generateAstFingerprint,
  generateMetadataFingerprint,
  generateSymbolId,
} from "../fingerprints.js";
import type { SymbolWithNodeId } from "../worker.js";
import type { SymbolDetail } from "./types.js";

// ── Phase 4: Load existing symbols from DB ──────────────────────────

export async function loadExistingSymbols(
  conn: Connection,
  existingFile?: { fileId: string },
): Promise<{ existingSymbols: SymbolRow[]; existingSymbolsById: Map<string, SymbolRow> }> {
  const existingSymbols: SymbolRow[] = [];
  const existingSymbolsById = new Map<string, SymbolRow>();

  if (existingFile) {
    const rows = await ladybugDb.getSymbolsByFile(conn, existingFile.fileId);
    for (const symbol of rows) {
      existingSymbols.push(symbol);
      existingSymbolsById.set(symbol.symbolId, symbol);
    }
  }

  return { existingSymbols, existingSymbolsById };
}

// ── Phase 5: Compute pass2 hint paths ───────────────────────────────

export async function computePass2HintPaths(params: {
  conn: Connection;
  mode: string;
  skipCallResolution?: boolean;
  existingFile?: { fileId: string };
  existingSymbols: SymbolRow[];
  repoId: string;
  filePath: string;
  supportsPass2FilePath: (relPath: string) => boolean;
}): Promise<string[]> {
  const {
    conn,
    mode,
    skipCallResolution,
    existingFile,
    existingSymbols,
    repoId,
    filePath,
    supportsPass2FilePath,
  } = params;

  if (
    !(
      mode === "incremental" &&
      skipCallResolution &&
      existingFile &&
      existingSymbols.length > 0
    )
  ) {
    return [];
  }

  try {
    const incomingByToSymbol = await ladybugDb.getEdgesToSymbols(
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

    if (importerSymbolIds.size === 0) return [];

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
    return Array.from(hinted).sort();
  } catch (error) {
    logger.warn(
      "Failed to compute pass2 hint paths for incremental call resolution",
      {
        repoId,
        file: filePath,
        error: String(error),
      },
    );
    return [];
  }
}

// ── Phase 6: Build symbol details (fingerprints + IDs) ──────────────

export function buildSymbolDetails(params: {
  symbolsWithNodeIds: SymbolWithNodeId[];
  tree: import("tree-sitter").Tree | null;
  repoId: string;
  fileMeta: FileMetadata;
}): SymbolDetail[] {
  const { symbolsWithNodeIds, tree, repoId, fileMeta } = params;

  return symbolsWithNodeIds.map((extractedSymbol) => {
    let astFingerprint = extractedSymbol.astFingerprint ?? "";

    if (tree) {
      const nodeType =
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
                    : "ambient_statement";

      const astNode = tree.rootNode
        .descendantsOfType(nodeType)
        .find((node) => {
          const nameNode = node.childForFieldName("name");
          return nameNode?.text === extractedSymbol.name;
        });

      astFingerprint = astNode
        ? generateAstFingerprint(astNode)
        : astFingerprint;
    }

    // When tree is unavailable (worker pool path) and no fingerprint was
    // provided, compute a deterministic fingerprint from symbol metadata
    // so that symbol IDs remain stable across runs.
    if (!astFingerprint && extractedSymbol.range) {
      astFingerprint = generateMetadataFingerprint({
        kind: extractedSymbol.kind,
        name: extractedSymbol.name,
        range: extractedSymbol.range,
        signature: extractedSymbol.signature,
      });
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
}

// ── Build index maps from symbol details ────────────────────────────

export function buildSymbolIndexMaps(symbolDetails: SymbolDetail[]): {
  nodeIdToSymbolId: Map<string, string>;
  nameToSymbolIds: Map<string, string[]>;
} {
  const nodeIdToSymbolId = new Map<string, string>();
  const nameToSymbolIds = new Map<string, string[]>();

  for (const detail of symbolDetails) {
    nodeIdToSymbolId.set(detail.extractedSymbol.nodeId, detail.symbolId);
    const existing = nameToSymbolIds.get(detail.extractedSymbol.name) ?? [];
    existing.push(detail.symbolId);
    nameToSymbolIds.set(detail.extractedSymbol.name, existing);
  }

  return { nodeIdToSymbolId, nameToSymbolIds };
}
