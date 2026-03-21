import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { FileMetadata } from "../fileScanner.js";
import { isTsCallResolutionFile } from "./telemetry.js";

async function resolvePass2Targets(params: {
  repoId: string;
  mode: "full" | "incremental";
  pass2Files: FileMetadata[];
  changedPass2FilePaths: Set<string>;
  supportsPass2FilePath?: (relPath: string) => boolean;
}): Promise<FileMetadata[]> {
  const {
    repoId,
    mode,
    pass2Files,
    changedPass2FilePaths,
    supportsPass2FilePath = isTsCallResolutionFile,
  } = params;
  if (mode === "full") {
    return pass2Files;
  }
  if (changedPass2FilePaths.size === 0) {
    return [];
  }

  const conn = await getLadybugConn();

  const pass2FilesByPath = new Map(pass2Files.map((file) => [file.path, file]));
  const targetPaths = new Set<string>(changedPass2FilePaths);
  const changedSymbolIds = new Set<string>();

  for (const changedPath of changedPass2FilePaths) {
    const file = await ladybugDb.getFileByRepoPath(conn, repoId, changedPath);
    if (!file) continue;
    const symbolIds = await ladybugDb.getSymbolIdsByFile(conn, file.fileId);
    for (const symbolId of symbolIds) {
      changedSymbolIds.add(symbolId);
    }
  }

  if (changedSymbolIds.size === 0) {
    return Array.from(targetPaths)
      .map((path) => pass2FilesByPath.get(path))
      .filter((file): file is FileMetadata => Boolean(file));
  }

  const incomingByToSymbol = await ladybugDb.getEdgesToSymbols(
    conn,
    Array.from(changedSymbolIds),
  );

  const importerSymbolIds = new Set<string>();
  for (const edges of incomingByToSymbol.values()) {
    for (const edge of edges) {
      if (edge.edgeType !== "import") continue;
      importerSymbolIds.add(edge.fromSymbolId);
    }
  }

  if (importerSymbolIds.size === 0) {
    return Array.from(targetPaths)
      .map((path) => pass2FilesByPath.get(path))
      .filter((file): file is FileMetadata => Boolean(file));
  }

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
  for (const symbol of importerSymbols.values()) {
    const file = importerFiles.get(symbol.fileId);
    if (!file) continue;
    if (!supportsPass2FilePath(file.relPath)) continue;
    targetPaths.add(file.relPath);
  }

  return Array.from(targetPaths)
    .map((path) => pass2FilesByPath.get(path))
    .filter((file): file is FileMetadata => Boolean(file));
}

export { resolvePass2Targets };
