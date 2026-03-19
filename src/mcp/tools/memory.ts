/**
 * memory.ts - MCP tool handlers for the agent memory system.
 * Implements store, query, remove, and surface operations.
 */
import crypto from "crypto";
import {
  MemoryStoreRequestSchema,
  type MemoryStoreResponse,
  MemoryQueryRequestSchema,
  type MemoryQueryResponse,
  MemoryRemoveRequestSchema,
  type MemoryRemoveResponse,
  MemorySurfaceRequestSchema,
  type MemorySurfaceResponse,
} from "../tools.js";
import type { SurfacedMemory } from "../types.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { DatabaseError, ValidationError } from "../errors.js";
import { surfaceRelevantMemories } from "../../memory/surface.js";
import {
  writeMemoryFile,
  deleteMemoryFile,
  updateMemoryFileFrontmatter,
  typeToDir,
} from "../../memory/file-sync.js";
import { safeJsonParse, StringArraySchema } from "../../util/safeJson.js";
import path from "node:path";

function computeContentHash(
  repoId: string,
  type: string,
  title: string,
  content: string,
): string {
  return crypto
    .createHash("sha256")
    .update(repoId + type + title + content)
    .digest("hex");
}

function generateMemoryId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export async function handleMemoryStore(
  args: unknown,
): Promise<MemoryStoreResponse> {
  const request = MemoryStoreRequestSchema.parse(args);
  const {
    repoId,
    type,
    title,
    content,
    tags,
    confidence = 0.8,
    symbolIds,
    fileRelPaths,
    memoryId: providedMemoryId,
  } = request;

  const conn = await getLadybugConn();

  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const now = new Date().toISOString();

  // Update mode
  if (providedMemoryId) {
    const existing = await ladybugDb.getMemory(conn, providedMemoryId);
    if (!existing) {
      throw new DatabaseError(`Memory ${providedMemoryId} not found`);
    }
    if (existing.repoId !== repoId) {
      throw new ValidationError(
        `Memory ${providedMemoryId} belongs to a different repository`,
      );
    }

    const contentHash = computeContentHash(repoId, type, title, content);
    const searchText = title + " " + content;

    await withWriteConn(async (wConn) => {
      await ladybugDb.upsertMemory(wConn, {
        ...existing,
        type,
        title,
        content,
        contentHash,
        searchText,
        tagsJson: JSON.stringify(tags ?? []),
        confidence,
        updatedAt: now,
        stale: false,
        deleted: false,
      });

      // Rebuild edges
      await ladybugDb.deleteMemoryEdges(wConn, providedMemoryId);
      await ladybugDb.createHasMemoryEdge(wConn, repoId, providedMemoryId);

      if (symbolIds) {
        for (const symId of symbolIds) {
          await ladybugDb.createMemoryOfEdge(wConn, providedMemoryId, symId);
        }
      }

      if (fileRelPaths) {
        for (const relPath of fileRelPaths) {
          const file = await ladybugDb.getFileByRepoPath(
            wConn,
            repoId,
            relPath,
          );
          if (file) {
            await ladybugDb.createMemoryOfFileEdge(
              wConn,
              providedMemoryId,
              file.fileId,
            );
          }
        }
      }
    });

    // Write backing file
    await writeMemoryFile(repo.rootPath, {
      memoryId: providedMemoryId,
      type,
      title,
      content,
      tags: tags ?? [],
      confidence,
      symbols: symbolIds ?? [],
      files: fileRelPaths ?? [],
      createdAt: existing.createdAt,
      deleted: false,
    }).catch(() => {
      // Non-critical: file write failure shouldn't fail the operation
    });

    return {
      ok: true,
      memoryId: providedMemoryId,
      created: false,
      deduplicated: false,
    };
  }

  // Create mode — check dedup first
  const contentHash = computeContentHash(repoId, type, title, content);
  const existingByHash = await ladybugDb.getMemoryByContentHash(
    conn,
    contentHash,
  );
  if (existingByHash) {
    return {
      ok: true,
      memoryId: existingByHash.memoryId,
      created: false,
      deduplicated: true,
    };
  }

  // Generate new memory
  const memoryId = generateMemoryId();
  const searchText = title + " " + content;

  const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
  const createdByVersion = latestVersion?.versionId ?? "unknown";

  await withWriteConn(async (wConn) => {
    await ladybugDb.upsertMemory(wConn, {
      memoryId,
      repoId,
      type,
      title,
      content,
      contentHash,
      searchText,
      tagsJson: JSON.stringify(tags ?? []),
      confidence,
      createdAt: now,
      updatedAt: now,
      createdByVersion,
      stale: false,
      staleVersion: null,
      sourceFile: null,
      deleted: false,
    });

    await ladybugDb.createHasMemoryEdge(wConn, repoId, memoryId);

    if (symbolIds) {
      for (const symId of symbolIds) {
        await ladybugDb.createMemoryOfEdge(wConn, memoryId, symId);
      }
    }

    if (fileRelPaths) {
      for (const relPath of fileRelPaths) {
        const file = await ladybugDb.getFileByRepoPath(wConn, repoId, relPath);
        if (file) {
          await ladybugDb.createMemoryOfFileEdge(wConn, memoryId, file.fileId);
        }
      }
    }
  });

  // Write backing file (non-critical)
  const sourceFile = await writeMemoryFile(repo.rootPath, {
    memoryId,
    type,
    title,
    content,
    tags: tags ?? [],
    confidence,
    symbols: symbolIds ?? [],
    files: fileRelPaths ?? [],
    createdAt: now,
    deleted: false,
  }).catch(() => null);

  // Update sourceFile in DB if write succeeded
  if (sourceFile) {
    await withWriteConn(async (wConn) => {
      const existing = await ladybugDb.getMemory(wConn, memoryId);
      if (existing) {
        await ladybugDb.upsertMemory(wConn, {
          ...existing,
          sourceFile,
        });
      }
    });
  }

  return {
    ok: true,
    memoryId,
    created: true,
    deduplicated: false,
  };
}

export async function handleMemoryQuery(
  args: unknown,
): Promise<MemoryQueryResponse> {
  const request = MemoryQueryRequestSchema.parse(args);
  const {
    repoId,
    query,
    types,
    tags,
    symbolIds,
    staleOnly,
    limit = 20,
    sortBy = "recency",
  } = request;

  const conn = await getLadybugConn();

  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const rows = await ladybugDb.queryMemories(conn, {
    repoId,
    query,
    types,
    tags,
    symbolIds,
    staleOnly,
    limit,
    sortBy,
  });

  const memories: SurfacedMemory[] = rows.map((row) => ({
    memoryId: row.memoryId,
    type: row.type as SurfacedMemory["type"],
    title: row.title,
    content: row.content,
    confidence: row.confidence,
    stale: row.stale,
    linkedSymbols: [], // Per-memory linked symbols resolved separately via sdl.memory.surface
    tags: safeJsonParse(row.tagsJson, StringArraySchema, []),
  }));

  return {
    repoId,
    memories,
    total: memories.length,
  };
}

export async function handleMemoryRemove(
  args: unknown,
): Promise<MemoryRemoveResponse> {
  const request = MemoryRemoveRequestSchema.parse(args);
  const { repoId, memoryId, deleteFile: shouldDeleteFile = true } = request;

  const conn = await getLadybugConn();

  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const memory = await ladybugDb.getMemory(conn, memoryId);
  if (!memory) {
    throw new DatabaseError(`Memory ${memoryId} not found`);
  }
  if (memory.repoId !== repoId) {
    throw new ValidationError(
      `Memory ${memoryId} belongs to a different repository`,
    );
  }

  await withWriteConn(async (wConn) => {
    await ladybugDb.deleteMemoryEdges(wConn, memoryId);
    await ladybugDb.softDeleteMemory(wConn, memoryId);
  });

  if (shouldDeleteFile) {
    await deleteMemoryFile(repo.rootPath, memory.type, memoryId).catch(
      () => {},
    );
  } else {
    // Update frontmatter to mark deleted without removing file
    const subDir = typeToDir(memory.type);
    const filePath = path.join(
      repo.rootPath,
      ".sdl-memory",
      subDir,
      `${memoryId}.md`,
    );
    await updateMemoryFileFrontmatter(filePath, { deleted: true }).catch(
      () => {},
    );
  }

  return { ok: true, memoryId };
}

export async function handleMemorySurface(
  args: unknown,
): Promise<MemorySurfaceResponse> {
  const request = MemorySurfaceRequestSchema.parse(args);
  const { repoId, symbolIds, taskType, limit = 10 } = request;

  const conn = await getLadybugConn();

  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const memories = await surfaceRelevantMemories(conn, {
    repoId,
    symbolIds,
    taskType,
    limit,
  });

  return { repoId, memories };
}
