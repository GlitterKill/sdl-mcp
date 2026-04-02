import path from "node:path";
import crypto from "node:crypto";
import { withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";
import { normalizePath } from "../util/paths.js";
import { scanMemoryFiles, readMemoryFile } from "../memory/file-sync.js";
import type { LadybugConn } from "./indexer-init.js";
import { loadConfig } from "../config/loadConfig.js";
import { getMemoryCapabilities } from "../config/memory-config.js";

/** Flag memories linked to symbols in changed files as stale. Failures are swallowed. */
export async function flagStaleMemoriesForChangedFiles(
  conn: LadybugConn,
  repoId: string,
  changedFileIds: Set<string>,
  versionId: string,
): Promise<void> {
  const caps = getMemoryCapabilities(loadConfig(), repoId);
  if (!caps.enabled) return;
  if (changedFileIds.size === 0) return;
  try {
    const changedSymbolIds: string[] = [];
    for (const symbol of await ladybugDb.getSymbolsByRepo(conn, repoId)) {
      if (changedFileIds.has(symbol.fileId))
        changedSymbolIds.push(symbol.symbolId);
    }
    if (changedSymbolIds.length > 0) {
      await withWriteConn(async (wConn) => {
        const flagged = await ladybugDb.flagMemoriesStale(
          wConn,
          changedSymbolIds,
          versionId,
        );
        if (flagged > 0) {
          logger.info("Flagged stale memories", {
            repoId,
            memoriesFlagged: flagged,
            changedSymbols: changedSymbolIds.length,
          });
        }
      });
    }
  } catch (error) {
    logger.warn("Memory staleness flagging failed; continuing", {
      repoId,
      error,
    });
  }
}

/** Read `.sdl-memory/` files from disk and upsert them into the graph. Failures are swallowed. */
export async function importMemoryFilesFromDisk(
  repoRoot: string,
  repoId: string,
  versionId: string,
): Promise<void> {
  const caps = getMemoryCapabilities(loadConfig(), repoId);
  if (!caps.fileSyncEnabled) return;
  try {
    const memoryFiles = await scanMemoryFiles(repoRoot);
    if (memoryFiles.length === 0) return;
    let imported = 0;
    await withWriteConn(async (wConn) => {
      for (const filePath of memoryFiles) {
        const data = await readMemoryFile(filePath);
        if (!data || data.deleted) continue;
        const contentHash = crypto
          .createHash("sha256")
          .update(repoId + data.type + data.title + data.content)
          .digest("hex");
        const relPath = normalizePath(path.relative(repoRoot, filePath));
        await ladybugDb.upsertMemory(wConn, {
          memoryId: data.memoryId,
          repoId,
          type: data.type,
          title: data.title,
          content: data.content,
          contentHash,
          searchText: data.title + " " + data.content,
          tagsJson: JSON.stringify(data.tags),
          confidence: data.confidence,
          createdAt: data.createdAt,
          updatedAt: new Date().toISOString(),
          createdByVersion: versionId,
          stale: false,
          staleVersion: null,
          sourceFile: relPath,
          deleted: false,
        });
        await ladybugDb.deleteMemoryEdges(wConn, data.memoryId);
        await ladybugDb.createHasMemoryEdge(wConn, repoId, data.memoryId);
        for (const symbolId of data.symbols) {
          await ladybugDb.createMemoryOfEdge(wConn, data.memoryId, symbolId);
        }
        for (const fileRelPath of data.files) {
          const file = await ladybugDb.getFileByRepoPath(
            wConn,
            repoId,
            fileRelPath,
          );
          if (file)
            await ladybugDb.createMemoryOfFileEdge(
              wConn,
              data.memoryId,
              file.fileId,
            );
        }
        imported++;
      }
    });
    if (imported > 0) {
      logger.info("Imported memory files", {
        repoId,
        imported,
        total: memoryFiles.length,
      });
    }
  } catch (error) {
    logger.warn("Memory file import failed; continuing", { repoId, error });
  }
}
