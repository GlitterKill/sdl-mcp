import { withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { SymbolRow } from "../../db/ladybug-symbols.js";
import type { EdgeRow } from "../../db/ladybug-edges.js";
import type { SymbolReferenceRow } from "../../db/ladybug-embeddings.js";
import type { FileRow } from "../../db/ladybug-repos.js";
import { logger } from "../../util/logger.js";

export interface FileUpsertEntry {
  file: Omit<FileRow, "directory">;
  existingFileId: string | null;
}

export class BatchPersistAccumulator {
  private files: FileUpsertEntry[] = [];
  private symbols: SymbolRow[] = [];
  private edges: EdgeRow[] = [];
  private symbolReferences: SymbolReferenceRow[] = [];
  private pendingCount = 0;
  private readonly flushThreshold: number;

  constructor(flushThreshold = 50) {
    this.flushThreshold = flushThreshold;
  }

  get pending(): number {
    return this.pendingCount;
  }

  addFile(
    file: Omit<FileRow, "directory">,
    existingFileId: string | null,
  ): void {
    this.files.push({ file, existingFileId });
    this.pendingCount++;
  }

  addSymbols(rows: SymbolRow[]): void {
    this.symbols.push(...rows);
    this.pendingCount += rows.length;
  }

  addEdges(rows: EdgeRow[]): void {
    this.edges.push(...rows);
    this.pendingCount += rows.length;
  }

  addSymbolReferences(rows: SymbolReferenceRow[]): void {
    this.symbolReferences.push(...rows);
    this.pendingCount += rows.length;
  }

  shouldFlush(): boolean {
    return this.pendingCount >= this.flushThreshold;
  }

  async flush(): Promise<void> {
    if (this.pendingCount === 0) return;

    const filesToWrite = [...this.files];
    const symbolsToWrite = [...this.symbols];
    const edgesToWrite = [...this.edges];
    const refsToWrite = [...this.symbolReferences];
    const count = this.pendingCount;

    logger.debug("BatchPersistAccumulator flushing", {
      files: filesToWrite.length,
      symbols: symbolsToWrite.length,
      edges: edgesToWrite.length,
      refs: refsToWrite.length,
    });

    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        const existingFileIds = filesToWrite
          .map((e) => e.existingFileId)
          .filter((id): id is string => id !== null);

        if (existingFileIds.length > 0) {
          await ladybugDb.deleteSymbolsByFileIds(txConn, existingFileIds);
        }

        for (const entry of filesToWrite) {
          await ladybugDb.upsertFile(txConn, entry.file);
        }

        if (refsToWrite.length > 0) {
          await ladybugDb.insertSymbolReferences(txConn, refsToWrite);
        }

        if (symbolsToWrite.length > 0) {
          await ladybugDb.upsertSymbolBatch(txConn, symbolsToWrite);
        }

        if (edgesToWrite.length > 0) {
          await ladybugDb.insertEdges(txConn, edgesToWrite);
        }
      });
    });

    this.files.splice(0, filesToWrite.length);
    this.symbols.splice(0, symbolsToWrite.length);
    this.edges.splice(0, edgesToWrite.length);
    this.symbolReferences.splice(0, refsToWrite.length);
    this.pendingCount -= count;

    logger.debug("BatchPersistAccumulator flush complete", {
      filesWritten: count,
    });
  }
}
