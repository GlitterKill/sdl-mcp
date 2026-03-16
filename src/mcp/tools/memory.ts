/**
 * memory.ts - MCP tool handlers for the agent memory system.
 * Implements store, query, remove, and surface operations.
 */
import crypto from "crypto";
import {
  MemoryStoreRequestSchema,
  MemoryStoreResponse,
  MemoryQueryRequestSchema,
  MemoryQueryResponse,
  MemoryRemoveRequestSchema,
  MemoryRemoveResponse,
  MemorySurfaceRequestSchema,
  MemorySurfaceResponse,
} from "../tools.js";
import type { SurfacedMemory } from "../types.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { DatabaseError } from "../errors.js";
import {
  writeMemoryFile,
  deleteMemoryFile,
  updateMemoryFileFrontmatter,
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

function typeToDir(type: string): string {
  switch (type) {
    case "decision":
      return "decisions";
    case "bugfix":
      return "bugfixes";
    case "task_context":
      return "task_context";
    default:
      return type;
  }
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
    linkedSymbols: symbolIds ?? [],
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

  // Collect memories from both symbol edges and repo edges
  const symbolMemoryRows =
    symbolIds && symbolIds.length > 0
      ? await ladybugDb.getMemoriesForSymbols(conn, symbolIds, 100)
      : [];

  const repoMemoryRows = await ladybugDb.getRepoMemories(conn, repoId, 100);

  // Deduplicate by memoryId, track linked symbols per memory
  const memoryMap = new Map<
    string,
    { row: ladybugDb.MemoryRow; linkedSymbolIds: Set<string> }
  >();

  for (const row of symbolMemoryRows) {
    const existing = memoryMap.get(row.memoryId);
    if (existing) {
      existing.linkedSymbolIds.add(row.linkedSymbolId);
    } else {
      memoryMap.set(row.memoryId, {
        row,
        linkedSymbolIds: new Set([row.linkedSymbolId]),
      });
    }
  }

  for (const row of repoMemoryRows) {
    if (!memoryMap.has(row.memoryId)) {
      memoryMap.set(row.memoryId, {
        row,
        linkedSymbolIds: new Set(),
      });
    }
  }

  // Filter by taskType if provided
  let entries = Array.from(memoryMap.values());
  if (taskType) {
    entries = entries.filter((e) => e.row.type === taskType);
  }

  // Rank
  const now = Date.now();
  const querySymbolIds = symbolIds ?? [];
  const querySymbolCount = querySymbolIds.length;

  const scored = entries.map((entry) => {
    const daysSinceCreation =
      (now - new Date(entry.row.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const recencyFactor = 1.0 / (1 + daysSinceCreation / 30);

    let score: number;
    if (querySymbolCount > 0) {
      const overlap = entry.linkedSymbolIds.size;
      score =
        entry.row.confidence * recencyFactor * (overlap / querySymbolCount);
    } else {
      score = entry.row.confidence * recencyFactor;
    }

    return { ...entry, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const topN = scored.slice(0, limit);

  const memories: SurfacedMemory[] = topN.map((entry) => {
    // Compute overlap with query symbolIds
    const linkedSymbols = querySymbolIds.filter((sid) =>
      entry.linkedSymbolIds.has(sid),
    );

    return {
      memoryId: entry.row.memoryId,
      type: entry.row.type as SurfacedMemory["type"],
      title: entry.row.title,
      content: entry.row.content,
      confidence: entry.row.confidence,
      stale: entry.row.stale,
      linkedSymbols,
      tags: safeJsonParse(entry.row.tagsJson, StringArraySchema, []),
    };
  });

  return { repoId, memories };
}
