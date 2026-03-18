/**
 * surface.ts - Shared memory surfacing and ranking logic.
 * Used by slice.build, repo.status, and memory.surface tools.
 */
import type { Connection } from "kuzu";

import * as ladybugDb from "../db/ladybug-queries.js";
import type { SurfacedMemory, MemoryType } from "../domain/types.js";
import { safeJsonParse, StringArraySchema } from "../util/safeJson.js";

export interface SurfaceMemoriesOptions {
  repoId: string;
  symbolIds?: string[];
  limit?: number;
  taskType?: MemoryType;
}

/**
 * Surface and rank relevant memories for a given repo and optional symbol context.
 * Scoring formula: confidence * recency * overlapFactor
 * where recency = 1/(1 + days/30) and overlapFactor = linkedCount/queryCount (or 1.0 if no symbols).
 */
export async function surfaceRelevantMemories(
  conn: Connection,
  options: SurfaceMemoriesOptions,
): Promise<SurfacedMemory[]> {
  const { repoId, symbolIds, limit = 5, taskType } = options;
  const querySymbolIds = symbolIds ?? [];

  // Collect memories from symbol edges and repo-level
  const symbolMemoryRows =
    querySymbolIds.length > 0
      ? await ladybugDb.getMemoriesForSymbols(conn, querySymbolIds, 100)
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

  // Rank by confidence * recency * overlap
  const nowMs = Date.now();
  const queryCount = querySymbolIds.length;

  const scored = entries.map((entry) => {
    const days =
      (nowMs - new Date(entry.row.createdAt).getTime()) /
      (1000 * 60 * 60 * 24);
    const recency = 1.0 / (1 + days / 30);
    const overlap =
      queryCount > 0 ? entry.linkedSymbolIds.size / queryCount : 1.0;

    return {
      ...entry,
      score: entry.row.confidence * recency * overlap,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const topN = scored.slice(0, limit);

  return topN.map((entry) => {
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
}
