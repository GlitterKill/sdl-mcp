import type { Connection } from "kuzu";

import * as kuzuDb from "../db/kuzu-queries.js";

export interface DependencyFrontier {
  touchedSymbolIds: string[];
  dependentSymbolIds: string[];
  dependentFilePaths: string[];
  importedFilePaths: string[];
  invalidations: Array<"metrics" | "clusters" | "processes">;
}

export async function buildDependencyFrontier(params: {
  conn: Connection;
  touchedSymbolIds: string[];
  outgoingEdges: Array<{ toSymbolId: string; edgeType: string }>;
  currentFilePath: string;
}): Promise<DependencyFrontier> {
  const { conn, touchedSymbolIds, outgoingEdges, currentFilePath } = params;

  const touchedSet = new Set(touchedSymbolIds);
  const dependentSymbolIds = new Set<string>();
  const dependentFilePaths = new Set<string>();
  const importedFilePaths = new Set<string>();

  if (touchedSymbolIds.length > 0) {
    const inboundBySymbol = await kuzuDb.getEdgesToSymbols(conn, touchedSymbolIds);
    for (const edges of inboundBySymbol.values()) {
      for (const edge of edges) {
        if (touchedSet.has(edge.fromSymbolId)) {
          continue;
        }
        dependentSymbolIds.add(edge.fromSymbolId);
      }
    }
  }

  if (dependentSymbolIds.size > 0) {
    const dependentSymbols = await kuzuDb.getSymbolsByIds(
      conn,
      Array.from(dependentSymbolIds),
    );
    const fileIds = new Set<string>();
    for (const symbol of dependentSymbols.values()) {
      fileIds.add(symbol.fileId);
    }
    const filesById = await kuzuDb.getFilesByIds(conn, Array.from(fileIds));
    for (const file of filesById.values()) {
      if (file.relPath !== currentFilePath) {
        dependentFilePaths.add(file.relPath);
      }
    }
  }

  const importedTargetIds = outgoingEdges
    .filter((edge) => edge.edgeType === "import" && !edge.toSymbolId.startsWith("unresolved:"))
    .map((edge) => edge.toSymbolId);
  if (importedTargetIds.length > 0) {
    const importedSymbols = await kuzuDb.getSymbolsByIds(conn, importedTargetIds);
    const fileIds = new Set<string>();
    for (const symbol of importedSymbols.values()) {
      fileIds.add(symbol.fileId);
    }
    const filesById = await kuzuDb.getFilesByIds(conn, Array.from(fileIds));
    for (const file of filesById.values()) {
      if (file.relPath !== currentFilePath) {
        importedFilePaths.add(file.relPath);
      }
    }
  }

  const invalidations: Array<"metrics" | "clusters" | "processes"> = ["metrics"];
  if (dependentSymbolIds.size > 0) {
    invalidations.push("clusters", "processes");
  }

  return {
    touchedSymbolIds: Array.from(touchedSet).sort(),
    dependentSymbolIds: Array.from(dependentSymbolIds).sort(),
    dependentFilePaths: Array.from(dependentFilePaths).sort(),
    importedFilePaths: Array.from(importedFilePaths).sort(),
    invalidations,
  };
}
