/**
 * ladybug-scip.ts — Graph queries for SCIP ingestion pipeline.
 *
 * Handles:
 *   - Merging SCIP metadata onto existing tree-sitter symbols
 *   - Inserting new symbols discovered only via SCIP
 *   - Creating/upgrading DEPENDS_ON edges with SCIP-level confidence
 *   - Contradiction resolution (replacing edge targets)
 *   - ScipIngestion record tracking
 *   - Batch operations for performance
 */

import type { Connection } from "kuzu";
import {
  exec,
  queryAll,
  querySingle,
  toNumber,
  withTransaction,
} from "./ladybug-core.js";
import { logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// 1. mergeScipSymbolProperties — update existing symbol with SCIP metadata
// ---------------------------------------------------------------------------

/**
 * Update an existing Symbol node with SCIP-specific properties.
 * Uses MATCH + SET (not MERGE) because we are updating a node that must
 * already exist.
 */
export async function mergeScipSymbolProperties(
  conn: Connection,
  symbolId: string,
  props: {
    scipSymbol: string;
    source: "both" | "scip";
    packageName?: string;
    packageVersion?: string;
  },
): Promise<void> {
  await exec(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})
     SET s.scipSymbol = $scipSymbol,
         s.source = $source,
         s.packageName = $packageName,
         s.packageVersion = $packageVersion`,
    {
      symbolId,
      scipSymbol: props.scipSymbol,
      source: props.source,
      packageName: props.packageName ?? null,
      packageVersion: props.packageVersion ?? null,
    },
  );
}

// ---------------------------------------------------------------------------
// 2. insertScipSymbol — insert a new symbol from SCIP (in-repo or external)
// ---------------------------------------------------------------------------

/**
 * Insert a new Symbol node discovered via SCIP.  Uses MERGE on symbolId for
 * idempotency — if the symbol already exists the SET clause overwrites its
 * properties with the SCIP-provided values.
 */
export async function insertScipSymbol(
  conn: Connection,
  symbol: {
    symbolId: string;
    kind: string;
    name: string;
    exported: boolean;
    language?: string;
    rangeStartLine?: number;
    rangeStartCol?: number;
    rangeEndLine?: number;
    rangeEndCol?: number;
    external: boolean;
    scipSymbol: string;
    source: "scip";
    packageName?: string;
    packageVersion?: string;
    updatedAt: string;
  },
): Promise<void> {
  await exec(
    conn,
    `MERGE (s:Symbol {symbolId: $symbolId})
     ON CREATE SET
         s.kind = $kind,
         s.name = $name,
         s.exported = $exported,
         s.language = $language,
         s.rangeStartLine = $rangeStartLine,
         s.rangeStartCol = $rangeStartCol,
         s.rangeEndLine = $rangeEndLine,
         s.rangeEndCol = $rangeEndCol,
         s.external = $external,
         s.scipSymbol = $scipSymbol,
         s.source = $source,
         s.packageName = $packageName,
         s.packageVersion = $packageVersion,
         s.updatedAt = $updatedAt
     ON MATCH SET
         s.kind = $kind,
         s.name = $name,
         s.exported = $exported,
         s.language = $language,
         s.rangeStartLine = $rangeStartLine,
         s.rangeStartCol = $rangeStartCol,
         s.rangeEndLine = $rangeEndLine,
         s.rangeEndCol = $rangeEndCol,
         s.external = $external,
         s.scipSymbol = $scipSymbol,
         s.source = $source,
         s.packageName = $packageName,
         s.packageVersion = $packageVersion,
         s.updatedAt = $updatedAt`,
    {
      symbolId: symbol.symbolId,
      kind: symbol.kind,
      name: symbol.name,
      exported: symbol.exported,
      language: symbol.language ?? null,
      rangeStartLine: symbol.rangeStartLine ?? null,
      rangeStartCol: symbol.rangeStartCol ?? null,
      rangeEndLine: symbol.rangeEndLine ?? null,
      rangeEndCol: symbol.rangeEndCol ?? null,
      external: symbol.external,
      scipSymbol: symbol.scipSymbol,
      source: symbol.source,
      packageName: symbol.packageName ?? null,
      packageVersion: symbol.packageVersion ?? null,
      updatedAt: symbol.updatedAt,
    },
  );
}

// ---------------------------------------------------------------------------
// 3. mergeScipEdge — create or upgrade a DEPENDS_ON edge
// ---------------------------------------------------------------------------

/**
 * Create a DEPENDS_ON edge between two Symbol nodes, or upgrade its
 * confidence if the new value is higher.  Both source and target must
 * already exist (or be created as stubs via MERGE).
 *
 * `resolutionPhase` is stored as STRING in the schema, so we convert from
 * the numeric input.
 */
export async function mergeScipEdge(
  conn: Connection,
  edge: {
    sourceSymbolId: string;
    targetSymbolId: string;
    edgeType: string;
    confidence: number;
    resolution: string;
    resolverId: string;
    resolutionPhase: number;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const phase = String(edge.resolutionPhase);

  await exec(
    conn,
    `MERGE (a:Symbol {symbolId: $sourceSymbolId})
     MERGE (b:Symbol {symbolId: $targetSymbolId})
     MERGE (a)-[d:DEPENDS_ON {edgeType: $edgeType}]->(b)
     ON CREATE SET
         d.confidence = $confidence,
         d.resolution = $resolution,
         d.resolverId = $resolverId,
         d.resolutionPhase = $resolutionPhase,
         d.createdAt = $createdAt
     ON MATCH SET
         d.confidence = CASE WHEN d.confidence < $confidence THEN $confidence ELSE d.confidence END,
         d.resolution = CASE WHEN d.confidence < $confidence THEN $resolution ELSE d.resolution END,
         d.resolverId = CASE WHEN d.confidence < $confidence THEN $resolverId ELSE d.resolverId END,
         d.resolutionPhase = CASE WHEN d.confidence < $confidence THEN $resolutionPhase ELSE d.resolutionPhase END`,
    {
      sourceSymbolId: edge.sourceSymbolId,
      targetSymbolId: edge.targetSymbolId,
      edgeType: edge.edgeType,
      confidence: edge.confidence,
      resolution: edge.resolution,
      resolverId: edge.resolverId,
      resolutionPhase: phase,
      createdAt: now,
    },
  );
}

// ---------------------------------------------------------------------------
// 4. replaceEdgeTarget — contradiction resolution
// ---------------------------------------------------------------------------

/**
 * Replace an existing DEPENDS_ON edge target with a new one.  Deletes the
 * old edge and creates a new one in a single transaction.
 */
export async function replaceEdgeTarget(
  conn: Connection,
  sourceId: string,
  oldTargetId: string,
  newTargetId: string,
  edgeType: string,
  confidence: number,
  resolution: string,
  resolverId: string,
  resolutionPhase: number,
): Promise<void> {
  const now = new Date().toISOString();
  const phase = String(resolutionPhase);

  await withTransaction(conn, async (txConn) => {
    // Delete the old edge
    await exec(
      txConn,
      `MATCH (a:Symbol {symbolId: $sourceId})-[d:DEPENDS_ON {edgeType: $edgeType}]->(b:Symbol {symbolId: $oldTargetId})
       DELETE d`,
      { sourceId, oldTargetId, edgeType },
    );

    // Create the new edge
    await exec(
      txConn,
      `MERGE (a:Symbol {symbolId: $sourceId})
       MERGE (b:Symbol {symbolId: $newTargetId})
       MERGE (a)-[d:DEPENDS_ON {edgeType: $edgeType}]->(b)
       ON CREATE SET
           d.confidence = $confidence,
           d.resolution = $resolution,
           d.resolverId = $resolverId,
           d.resolutionPhase = $resolutionPhase,
           d.createdAt = $createdAt
       ON MATCH SET
           d.confidence = CASE WHEN d.confidence < $confidence THEN $confidence ELSE d.confidence END,
           d.resolution = CASE WHEN d.confidence < $confidence THEN $resolution ELSE d.resolution END,
           d.resolverId = CASE WHEN d.confidence < $confidence THEN $resolverId ELSE d.resolverId END,
           d.resolutionPhase = CASE WHEN d.confidence < $confidence THEN $resolutionPhase ELSE d.resolutionPhase END`,
      {
        sourceId,
        newTargetId,
        edgeType,
        confidence,
        resolution,
        resolverId,
        resolutionPhase: phase,
        createdAt: now,
      },
    );
  });
}

// ---------------------------------------------------------------------------
// 5. getExistingEdge — check for an existing edge between two symbols
// ---------------------------------------------------------------------------

/**
 * Return the first DEPENDS_ON edge between source and target, or null.
 */
export async function getExistingEdge(
  conn: Connection,
  sourceId: string,
  targetId: string,
): Promise<{
  edgeType: string;
  confidence: number;
  resolution: string;
  resolverId: string;
} | null> {
  const row = await querySingle<{
    edgeType: string;
    confidence: unknown;
    resolution: string;
    resolverId: string;
  }>(
    conn,
    `MATCH (a:Symbol {symbolId: $sourceId})-[d:DEPENDS_ON]->(b:Symbol {symbolId: $targetId})
     RETURN d.edgeType AS edgeType,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId
     LIMIT 1`,
    { sourceId, targetId },
  );

  if (!row) return null;

  return {
    edgeType: row.edgeType,
    confidence: toNumber(row.confidence),
    resolution: row.resolution,
    resolverId: row.resolverId,
  };
}

/**
 * Batch-fetch all existing DEPENDS_ON edges for a set of (source, target) pairs.
 * Returns a Map keyed by `${sourceId}:${targetId}`.
 */
export async function batchGetExistingEdges(
  conn: Connection,
  pairs: ReadonlyArray<{ sourceId: string; targetId: string }>,
): Promise<
  Map<
    string,
    { edgeType: string; confidence: number; resolution: string; resolverId: string }
  >
> {
  if (pairs.length === 0) return new Map();

  const sourceIds = pairs.map((p) => p.sourceId);
  const targetIds = pairs.map((p) => p.targetId);

  const rows = await queryAll<{
    sourceId: string;
    targetId: string;
    edgeType: string;
    confidence: unknown;
    resolution: string;
    resolverId: string;
  }>(
    conn,
    `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE a.symbolId IN $sourceIds AND b.symbolId IN $targetIds
     RETURN a.symbolId AS sourceId,
            b.symbolId AS targetId,
            d.edgeType AS edgeType,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId`,
    { sourceIds, targetIds },
  );

  const result = new Map<
    string,
    { edgeType: string; confidence: number; resolution: string; resolverId: string }
  >();
  for (const row of rows) {
    const key = `${row.sourceId}:${row.targetId}`;
    if (!result.has(key)) {
      result.set(key, {
        edgeType: row.edgeType,
        confidence: toNumber(row.confidence),
        resolution: row.resolution,
        resolverId: row.resolverId,
      });
    }
  }

  return result;
}


// ---------------------------------------------------------------------------
// 6. getSymbolsForFile — load all symbols for a file (symbol matcher)
// ---------------------------------------------------------------------------

/**
 * Load all symbols belonging to a file identified by repoId + relPath.
 * Used by the SCIP symbol matcher to correlate SCIP occurrences with
 * existing tree-sitter symbols.
 */
export async function getSymbolsForFile(
  conn: Connection,
  repoId: string,
  relPath: string,
): Promise<
  Array<{
    symbolId: string;
    name: string;
    kind: string;
    rangeStartLine: number;
    rangeEndLine: number;
    source: string;
    external: boolean;
  }>
> {
  const rows = await queryAll<{
    symbolId: string;
    name: string;
    kind: string;
    rangeStartLine: unknown;
    rangeEndLine: unknown;
    source: string | null;
    external: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[:SYMBOL_IN_FILE]->(f:File {relPath: $relPath})
     RETURN s.symbolId AS symbolId,
            s.name AS name,
            s.kind AS kind,
            s.rangeStartLine AS rangeStartLine,
            s.rangeEndLine AS rangeEndLine,
            s.source AS source,
            s.external AS external`,
    { repoId, relPath },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    name: row.name,
    kind: row.kind,
    rangeStartLine: toNumber(row.rangeStartLine),
    rangeEndLine: toNumber(row.rangeEndLine),
    source: row.source ?? "treesitter",
    external: row.external === true || row.external === 1,
  }));
}

// ---------------------------------------------------------------------------
// 7. mergeScipIngestionRecord — upsert ingestion metadata
// ---------------------------------------------------------------------------

/**
 * Upsert a ScipIngestion record.  Uses MERGE on the primary key `id` for
 * idempotent writes.
 */
export async function mergeScipIngestionRecord(
  conn: Connection,
  record: {
    id: string;
    repoId: string;
    indexPath: string;
    contentHash: string;
    ingestedAt: string;
    ledgerVersion: string;
    symbolCount: number;
    edgeCount: number;
    externalSymbolCount: number;
    truncated: boolean;
  },
): Promise<void> {
  await exec(
    conn,
    `MERGE (r:ScipIngestion {id: $id})
     ON CREATE SET
         r.repoId = $repoId,
         r.indexPath = $indexPath,
         r.contentHash = $contentHash,
         r.ingestedAt = $ingestedAt,
         r.ledgerVersion = $ledgerVersion,
         r.symbolCount = $symbolCount,
         r.edgeCount = $edgeCount,
         r.externalSymbolCount = $externalSymbolCount,
         r.truncated = $truncated
     ON MATCH SET
         r.repoId = $repoId,
         r.indexPath = $indexPath,
         r.contentHash = $contentHash,
         r.ingestedAt = $ingestedAt,
         r.ledgerVersion = $ledgerVersion,
         r.symbolCount = $symbolCount,
         r.edgeCount = $edgeCount,
         r.externalSymbolCount = $externalSymbolCount,
         r.truncated = $truncated`,
    {
      id: record.id,
      repoId: record.repoId,
      indexPath: record.indexPath,
      contentHash: record.contentHash,
      ingestedAt: record.ingestedAt,
      ledgerVersion: record.ledgerVersion,
      symbolCount: record.symbolCount,
      edgeCount: record.edgeCount,
      externalSymbolCount: record.externalSymbolCount,
      truncated: record.truncated,
    },
  );
}

// ---------------------------------------------------------------------------
// 8. getScipIngestionRecord — lookup previous ingestion
// ---------------------------------------------------------------------------

/**
 * Find a previous ScipIngestion record for the given repo + index path.
 * Returns null if no previous ingestion exists.
 */
export async function getScipIngestionRecord(
  conn: Connection,
  repoId: string,
  indexPath: string,
): Promise<{ id: string; contentHash: string; ingestedAt: string } | null> {
  return querySingle<{ id: string; contentHash: string; ingestedAt: string }>(
    conn,
    `MATCH (r:ScipIngestion {repoId: $repoId, indexPath: $indexPath})
     RETURN r.id AS id,
            r.contentHash AS contentHash,
            r.ingestedAt AS ingestedAt`,
    { repoId, indexPath },
  );
}

// ---------------------------------------------------------------------------
// 9. batchMergeScipEdges — batched edge writes for performance
// ---------------------------------------------------------------------------

const EDGE_BATCH_SIZE = 100;

/**
 * Insert or upgrade a batch of DEPENDS_ON edges.  Wrapped in a single
 * transaction for performance.  Each edge is individually MERGEd because
 * LadybugDB does not support UNWIND for relationship MERGE.
 */
export async function batchMergeScipEdges(
  conn: Connection,
  edges: Array<{
    sourceSymbolId: string;
    targetSymbolId: string;
    edgeType: string;
    confidence: number;
    resolution: string;
    resolverId: string;
    resolutionPhase: number;
  }>,
): Promise<void> {
  if (edges.length === 0) return;

  const now = new Date().toISOString();

  await withTransaction(conn, async (txConn) => {
    for (let i = 0; i < edges.length; i += EDGE_BATCH_SIZE) {
      const batch = edges.slice(i, i + EDGE_BATCH_SIZE);

      for (const edge of batch) {
        const phase = String(edge.resolutionPhase);

        await exec(
          txConn,
          `MERGE (a:Symbol {symbolId: $sourceSymbolId})
           MERGE (b:Symbol {symbolId: $targetSymbolId})
           MERGE (a)-[d:DEPENDS_ON {edgeType: $edgeType}]->(b)
           ON CREATE SET
               d.confidence = $confidence,
               d.resolution = $resolution,
               d.resolverId = $resolverId,
               d.resolutionPhase = $resolutionPhase,
               d.createdAt = $createdAt
           ON MATCH SET
               d.confidence = CASE WHEN d.confidence < $confidence THEN $confidence ELSE d.confidence END,
               d.resolution = CASE WHEN d.confidence < $confidence THEN $resolution ELSE d.resolution END,
               d.resolverId = CASE WHEN d.confidence < $confidence THEN $resolverId ELSE d.resolverId END,
               d.resolutionPhase = CASE WHEN d.confidence < $confidence THEN $resolutionPhase ELSE d.resolutionPhase END`,
          {
            sourceSymbolId: edge.sourceSymbolId,
            targetSymbolId: edge.targetSymbolId,
            edgeType: edge.edgeType,
            confidence: edge.confidence,
            resolution: edge.resolution,
            resolverId: edge.resolverId,
            resolutionPhase: phase,
            createdAt: now,
          },
        );
      }
    }
  });

  if (edges.length > 50) {
    logger.debug("batchMergeScipEdges completed", { count: edges.length });
  }
}

// ---------------------------------------------------------------------------
// 10. batchMergeExternalSymbols — batched external symbol writes
// ---------------------------------------------------------------------------

const SYMBOL_BATCH_SIZE = 100;

/**
 * Insert or update a batch of external Symbol nodes discovered via SCIP.
 * Wrapped in a single transaction for performance.
 */
export async function batchMergeExternalSymbols(
  conn: Connection,
  symbols: Array<{
    symbolId: string;
    kind: string;
    name: string;
    exported: boolean;
    language?: string;
    rangeStartLine?: number;
    rangeStartCol?: number;
    rangeEndLine?: number;
    rangeEndCol?: number;
    external: boolean;
    scipSymbol: string;
    source: "scip";
    packageName?: string;
    packageVersion?: string;
    updatedAt: string;
  }>,
): Promise<void> {
  if (symbols.length === 0) return;

  await withTransaction(conn, async (txConn) => {
    for (let i = 0; i < symbols.length; i += SYMBOL_BATCH_SIZE) {
      const batch = symbols.slice(i, i + SYMBOL_BATCH_SIZE);

      for (const symbol of batch) {
        await exec(
          txConn,
          `MERGE (s:Symbol {symbolId: $symbolId})
           ON CREATE SET
               s.kind = $kind,
               s.name = $name,
               s.exported = $exported,
               s.language = $language,
               s.rangeStartLine = $rangeStartLine,
               s.rangeStartCol = $rangeStartCol,
               s.rangeEndLine = $rangeEndLine,
               s.rangeEndCol = $rangeEndCol,
               s.external = $external,
               s.scipSymbol = $scipSymbol,
               s.source = $source,
               s.packageName = $packageName,
               s.packageVersion = $packageVersion,
               s.updatedAt = $updatedAt
           ON MATCH SET
               s.kind = $kind,
               s.name = $name,
               s.exported = $exported,
               s.language = $language,
               s.rangeStartLine = $rangeStartLine,
               s.rangeStartCol = $rangeStartCol,
               s.rangeEndLine = $rangeEndLine,
               s.rangeEndCol = $rangeEndCol,
               s.external = $external,
               s.scipSymbol = $scipSymbol,
               s.source = $source,
               s.packageName = $packageName,
               s.packageVersion = $packageVersion,
               s.updatedAt = $updatedAt`,
          {
            symbolId: symbol.symbolId,
            kind: symbol.kind,
            name: symbol.name,
            exported: symbol.exported,
            language: symbol.language ?? null,
            rangeStartLine: symbol.rangeStartLine ?? null,
            rangeStartCol: symbol.rangeStartCol ?? null,
            rangeEndLine: symbol.rangeEndLine ?? null,
            rangeEndCol: symbol.rangeEndCol ?? null,
            external: symbol.external,
            scipSymbol: symbol.scipSymbol,
            source: symbol.source,
            packageName: symbol.packageName ?? null,
            packageVersion: symbol.packageVersion ?? null,
            updatedAt: symbol.updatedAt,
          },
        );
      }
    }
  });

  if (symbols.length > 50) {
    logger.debug("batchMergeExternalSymbols completed", {
      count: symbols.length,
    });
  }
}
