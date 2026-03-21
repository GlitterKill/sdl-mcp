import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";

async function resolveUnresolvedImportEdges(
  repoId: string,
): Promise<{ resolved: number; total: number }> {
  const conn = await getLadybugConn();
  const allEdges = await ladybugDb.getEdgesByRepo(conn, repoId);
  const unresolvedImports = allEdges.filter(
    (edge) =>
      edge.edgeType === "import" &&
      edge.toSymbolId.startsWith("unresolved:"),
  );

  if (unresolvedImports.length === 0) {
    return { resolved: 0, total: 0 };
  }

  let resolved = 0;

  for (const edge of unresolvedImports) {
    // Parse "unresolved:<filePath|specifier>:<symbolName>" format
    const raw = edge.toSymbolId;
    const withoutPrefix = raw.slice("unresolved:".length);
    const lastColon = withoutPrefix.lastIndexOf(":");
    if (lastColon === -1) continue;

    const filePath = withoutPrefix.substring(0, lastColon);
    const symbolName = withoutPrefix.substring(lastColon + 1);
    if (!filePath || !symbolName) continue;

    // Skip namespace imports (e.g. "* as foo") — they cannot resolve to a single symbol
    if (symbolName.startsWith("* as ")) continue;

    // Look up the target file in the DB
    const file = await ladybugDb.getFileByRepoPath(conn, repoId, filePath);
    if (!file) continue;

    // Look up exported symbols in that file
    const symbols = await ladybugDb.getSymbolsByFile(conn, file.fileId);
    const target = symbols.find(
      (s) => s.name === symbolName && s.exported,
    );
    if (!target) {
      // For default imports (symbolName === "default"), try the first default-exported symbol
      if (symbolName === "default" || symbolName === "*") continue;
      // Also try without export filter for wildcard re-exports
      const anyMatch = symbols.find((s) => s.name === symbolName);
      if (!anyMatch) continue;
      // If the symbol exists but isn't exported, skip — it's likely an internal symbol
      continue;
    }

    // Update: delete old edge pointing to unresolved stub, create new edge to real symbol
    await withWriteConn(async (wConn) => {
      await ladybugDb.deleteEdge(wConn, {
        fromSymbolId: edge.fromSymbolId,
        toSymbolId: edge.toSymbolId,
        edgeType: "import",
      });

      await ladybugDb.insertEdge(wConn, {
        repoId,
        fromSymbolId: edge.fromSymbolId,
        toSymbolId: target.symbolId,
        edgeType: "import",
        weight: 0.6,
        confidence: 1.0,
        resolution: "re-resolved",
        resolverId: "import-reresolution",
        resolutionPhase: "pass2",
        provenance: edge.provenance ?? `import:${symbolName}`,
        createdAt: new Date().toISOString(),
      });
    });

    resolved++;
  }

  return { resolved, total: unresolvedImports.length };
}

export { resolveUnresolvedImportEdges };
