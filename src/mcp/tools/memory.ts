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
import { DatabaseError, ValidationError, ConfigError } from "../errors.js";
import { loadConfig } from "../../config/loadConfig.js";
import { getMemoryCapabilities } from "../../config/memory-config.js";
import {
  loadCentralitySignals,
  surfaceRelevantMemories,
} from "../../memory/surface.js";
import {
  writeMemoryFile,
  deleteMemoryFile,
  updateMemoryFileFrontmatter,
  typeToDir,
} from "../../memory/file-sync.js";
import { safeJsonParse, StringArraySchema } from "../../util/safeJson.js";
import path from "node:path";
import { logger } from "../../util/logger.js";

function computeContentHash(
  repoId: string,
  type: string,
  title: string,
  content: string,
): string {
  return crypto
    .createHash("sha256")
    .update([repoId, type, title, content].join("\0"))
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

  const caps = getMemoryCapabilities(loadConfig(), repoId);
  if (!caps.toolsEnabled) {
    throw new ConfigError(`Memory tools are disabled for repository "${repoId}". Enable memory in config: { "memory": { "enabled": true } }`);
  }

  const now = new Date().toISOString();

  // Upsert: update if exists, fall through to create with provided ID if not
  if (providedMemoryId) {
    const existing = await ladybugDb.getMemory(conn, providedMemoryId);
    if (existing && existing.repoId !== repoId) {
      throw new ValidationError(
        `Memory ${providedMemoryId} belongs to a different repository`,
      );
    }
    if (existing) {

    const contentHash = computeContentHash(repoId, type, title, content);
    const searchText = title + " " + content;

    await withWriteConn(async (wConn) => {
      // Re-read inside transaction to avoid TOCTOU race with stale `existing`
      const freshExisting = await ladybugDb.getMemory(wConn, providedMemoryId);
      if (!freshExisting) {
        throw new ValidationError(
          `Memory ${providedMemoryId} was deleted concurrently`,
        );
      }
      await ladybugDb.upsertMemory(wConn, {
        ...freshExisting,
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

    // Write backing file (only if file sync is enabled)
    if (caps.fileSyncEnabled) {
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
      }).catch((err) => {
        logger.warn("Failed to write memory file", { error: String(err) });
      });
    }

    return {
      ok: true,
      memoryId: providedMemoryId,
      created: false,
      deduplicated: false,
    };
    } // end if (existing) — when !existing, fall through to create path
  }

  // Create mode — check dedup first (skip when caller provided explicit ID)
  const contentHash = computeContentHash(repoId, type, title, content);
  if (!providedMemoryId) {
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
  }

  // Generate or reuse provided ID
  const memoryId = providedMemoryId ?? generateMemoryId();
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

  // Write backing file (non-critical, only if file sync is enabled)
  if (caps.fileSyncEnabled) {
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
    }).catch((err) => { logger.debug("Failed to write memory file for sourceFile update", { error: String(err) }); return null; });

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
    limit = 10,
    offset = 0,
    sortBy = "recency",
  } = request;

  const conn = await getLadybugConn();

  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const caps = getMemoryCapabilities(loadConfig(), repoId);
  if (!caps.toolsEnabled) {
    throw new ConfigError(`Memory tools are disabled for repository "${repoId}". Enable memory in config: { "memory": { "enabled": true } }`);
  }

  let rows;
  try {
    rows = await ladybugDb.queryMemories(conn, {
      repoId,
      query,
      types,
      tags,
      symbolIds,
      staleOnly,
      limit: limit + 1,  // Fetch one extra to detect hasMore
      offset,
      sortBy,
    });
  } catch (err) {
    throw new DatabaseError(
      `Failed to query memories: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const hasMore = rows.length > limit;
  const memoryRows = hasMore ? rows.slice(0, limit) : rows;

  const memories: SurfacedMemory[] = memoryRows.map((row) => ({
    memoryId: row.memoryId,
    type: row.type as SurfacedMemory["type"],
    title: row.title,
    content: row.content,
    confidence: row.confidence,
    stale: row.stale,
    linkedSymbols: [], // Per-memory linked symbols resolved separately via sdl.memory.surface
    tags: safeJsonParse(row.tagsJson, StringArraySchema, []),
  }));

  // hasMore already computed above
  return {
    repoId,
    memories,
    total: memories.length,
    hasMore,
    // Continuation offset for the next page, or null when there is no more.
    // Previously hasMore was signaled but no cursor was provided, leaving
    // callers unable to actually advance.
    nextOffset: hasMore ? offset + limit : null,
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

  const caps = getMemoryCapabilities(loadConfig(), repoId);
  if (!caps.toolsEnabled) {
    throw new ConfigError(`Memory tools are disabled for repository "${repoId}". Enable memory in config: { "memory": { "enabled": true } }`);
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

  if (caps.fileSyncEnabled) {
    if (shouldDeleteFile) {
      await deleteMemoryFile(repo.rootPath, memory.type, memoryId).catch(
        (err) => logger.warn("Failed to sync memory file", { error: String(err) }),
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
        (err) => logger.warn("Failed to sync memory file", { error: String(err) }),
      );
    }
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

  const caps = getMemoryCapabilities(loadConfig(), repoId);
  if (!caps.toolsEnabled) {
    throw new ConfigError(`Memory tools are disabled for repository "${repoId}". Enable memory in config: { "memory": { "enabled": true } }`);
  }

  const centralitySignals = symbolIds && symbolIds.length > 0
    ? await loadCentralitySignals(conn, symbolIds)
    : undefined;

  const memories = await surfaceRelevantMemories(conn, {
    repoId,
    symbolIds,
    taskType,
    limit,
    centralitySignals,
  });

  return { repoId, memories };
}
