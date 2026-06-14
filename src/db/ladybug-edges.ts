/**
 * ladybug-edges.ts � Edge (Dependency) Operations
 * Extracted from ladybug-queries.ts as part of the god-object split.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type { Connection } from "kuzu";
import {
  exec,
  execDdl,
  queryAll,
  querySingle,
  toNumber,
  type TransactionPhaseName,
  withTransaction,
} from "./ladybug-core.js";
import { logger } from "../util/logger.js";
import { normalizePath } from "../util/paths.js";
import {
  classifyDependencyTarget,
  isSafeUnresolvedCallSymbolId,
  type SymbolPlaceholderMeta,
} from "./symbol-placeholders.js";
import {
  resolveLadybugWriteChunkSize,
  type LadybugWriteChunkOptions,
} from "./ladybug-batching.js";

const EDGE_COPY_COLUMNS = [
  "from",
  "to",
  "edgeType",
  "weight",
  "confidence",
  "resolution",
  "resolverId",
  "resolutionPhase",
  "provenance",
  "createdAt",
] as const;
// Keep this aligned with ladybug-symbols.ts SYMBOL_COPY_COLUMNS. The
// placeholder target path cannot import that private helper without coupling
// edge writes to file-backed symbol materialization.
const PLACEHOLDER_SYMBOL_COPY_COLUMNS = [
  "symbolId",
  "repoId",
  "kind",
  "name",
  "exported",
  "visibility",
  "language",
  "rangeStartLine",
  "rangeStartCol",
  "rangeEndLine",
  "rangeEndCol",
  "astFingerprint",
  "signatureJson",
  "summary",
  "summaryQuality",
  "summarySource",
  "invariantsJson",
  "sideEffectsJson",
  "roleTagsJson",
  "searchText",
  "updatedAt",
  "embeddingMiniLM",
  "embeddingMiniLMCardHash",
  "embeddingMiniLMUpdatedAt",
  "embeddingMiniLMVec",
  "embeddingNomic",
  "embeddingNomicCardHash",
  "embeddingNomicUpdatedAt",
  "embeddingJinaCode",
  "embeddingJinaCodeCardHash",
  "embeddingJinaCodeUpdatedAt",
  "embeddingNomicVec",
  "embeddingJinaCodeVec",
  "external",
  "scipSymbol",
  "source",
  "packageName",
  "packageVersion",
  "symbolStatus",
  "placeholderKind",
  "placeholderTarget",
] as const;
const SIMPLE_REL_COPY_COLUMNS = ["from", "to"] as const;
const CSV_NULL_SENTINEL = "__sdl_ladybug_csv_null__";
const SYMBOL_CSV_NULL_SENTINEL = "\\N";
const CSV_ARRAY_NULL = Symbol("edgeCsvArrayNull");

export type DependencyTargetEnsurePhaseName =
  | "symbolMetadata"
  | "symbolMetadata.probeExisting"
  | "symbolMetadata.copyMissing.csvMaterialize"
  | "symbolMetadata.copyMissing.copyFrom"
  | "symbolMetadata.matchExisting"
  | "symbolMetadata.mergeFallback"
  | "repoLink";
export type InsertEdgesPhaseName =
  | "dedupe"
  | "groupByRepo"
  | "prepareRows"
  | "sourceRepoLink.symbolMetadata"
  | "sourceRepoLink.repoLink"
  | "endpointMetadata"
  | "targetMetadata"
  | "targetRepoLink"
  | "relationshipCreate"
  | "relationshipUpdate";

export interface EnsureDependencyTargetsOptions
  extends LadybugWriteChunkOptions {
  measurePhase?: <T>(
    phaseName: DependencyTargetEnsurePhaseName,
    fn: () => Promise<T>,
  ) => Promise<T>;
}

export type KnownSymbolEdgesCopyPhaseName =
  | TransactionPhaseName
  | "csvMaterialize"
  | "copyFrom"
  | "tempCleanup";

export interface InsertKnownSymbolEdgesOptions
  extends LadybugWriteChunkOptions {
  measurePhase?: <T>(
    phaseName: KnownSymbolEdgesCopyPhaseName,
    fn: () => Promise<T>,
  ) => Promise<T>;
}

// Workaround for LadybugDB 0.16.0 binder bug: when an UNWIND struct mixes
// integer and fractional Number values for the same field, the binder
// picks ANY type and integer values round-trip as Number.MIN_VALUE
// (5e-324). Adding 1e-12 to integer values forces the binder to encode
// them as DOUBLE while losing precision only at the 13th decimal place
// — negligible for weight/confidence which round to 2-3 places.
function forceDoubleEncoding(value: number): number {
  return Number.isInteger(value) ? value + 1e-12 : value;
}

// Promise-based singleton for join hint support detection.
// Used by getEdgesToSymbols and getCallersOfSymbols to avoid
// re-probing on every call after the first success/failure.
// NOTE: This is a module-level singleton keyed to "any connection" rather than
// a specific database instance. resetJoinHintCache() is called in closeLadybugDb()
// to handle database switches. For single-DB usage (all known scenarios), this is safe.
let joinHintSupportedPromise: Promise<boolean> | null = null;

async function detectJoinHintSupport(conn: Connection): Promise<boolean> {
  try {
    await queryAll(
      conn,
      `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol) WITH a, d, b HINT (b JOIN (d JOIN a)) RETURN a.symbolId LIMIT 0`,
      {},
    );
    return true;
  } catch (err) {
    logger.warn("Join hint support detection failed", { error: String(err) });
    return false;
  }
}

function getJoinHintSupported(conn: Connection): Promise<boolean> {
  if (!joinHintSupportedPromise) {
    joinHintSupportedPromise = detectJoinHintSupport(conn);
  }
  return joinHintSupportedPromise;
}

/**
 * Reset the cached join-hint detection result.
 * Must be called when closing the database so that
 * a subsequent initLadybugDb() re-probes the new connection.
 */
export function resetJoinHintCache(): void {
  joinHintSupportedPromise = null;
}

export interface EdgeRow {
  repoId: string;
  fromSymbolId: string;
  toSymbolId: string;
  targetMeta?: SymbolPlaceholderMeta;
  edgeType: string;
  weight: number;
  confidence: number;
  resolution: string;
  resolverId?: string;
  resolutionPhase?: string;
  provenance: string | null;
  createdAt: string;
}

export interface EdgeForSlice {
  fromSymbolId: string;
  toSymbolId: string;
  edgeType: string;
  weight: number;
  confidence: number;
  resolution?: string;
  resolverId?: string;
  resolutionPhase?: string;
}

export interface EdgeLite {
  fromSymbolId: string;
  toSymbolId: string;
  edgeType: string;
}

export interface EdgeQueryOptions {
  minCallConfidence?: number;
}

function buildMinCallConfidenceClause(
  alias: string,
  minCallConfidence: number | undefined,
): string {
  if (minCallConfidence === undefined) {
    return "";
  }

  return ` AND (${alias}.edgeType <> 'call' OR ${alias}.confidence >= $minCallConfidence)`;
}

export async function insertEdge(
  conn: Connection,
  edge: EdgeRow,
): Promise<void> {
  const targetMeta = edge.targetMeta ?? classifyDependencyTarget(edge.toSymbolId);
  // Note: MERGE on target symbol (b) may create "stub" nodes with only symbolId
  // and SYMBOL_IN_REPO edge when the target hasn't been indexed yet. This is
  // intentional — stubs are populated when the target file is indexed, and
  // queries that need full symbol data filter via SYMBOL_IN_FILE joins.
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (a:Symbol {symbolId: $fromSymbolId})
     MERGE (b:Symbol {symbolId: $toSymbolId})
     WITH r, a, b
     OPTIONAL MATCH (b)-[:SYMBOL_IN_FILE]->(bf:File)
     WITH r, a, b, count(bf) AS targetFileCount
     SET a.repoId = $repoId,
         a.external = CASE
           WHEN a.symbolId STARTS WITH 'unresolved:' THEN coalesce(a.external, false)
           ELSE false
         END,
         a.symbolStatus = CASE
           WHEN a.symbolId STARTS WITH 'unresolved:' THEN coalesce(a.symbolStatus, 'unresolved')
           ELSE 'real'
         END,
         a.placeholderKind = CASE
           WHEN a.symbolId STARTS WITH 'unresolved:' THEN coalesce(a.placeholderKind, '')
           ELSE ''
         END,
         a.placeholderTarget = CASE
           WHEN a.symbolId STARTS WITH 'unresolved:' THEN coalesce(a.placeholderTarget, '')
           ELSE ''
         END,
         b.repoId = $repoId,
         b.external = CASE
           WHEN $targetStatus = 'external' THEN true
           WHEN $targetStatus <> 'real' THEN false
           WHEN targetFileCount > 0 THEN false
           ELSE coalesce(b.external, false)
         END,
         b.symbolStatus = CASE
           WHEN $targetStatus <> 'real' THEN $targetStatus
           WHEN targetFileCount > 0 THEN 'real'
           WHEN coalesce(b.external, false) = true THEN 'external'
           ELSE 'real'
         END,
         b.placeholderKind = CASE
           WHEN $targetStatus <> 'real' THEN $targetPlaceholderKind
           WHEN targetFileCount > 0 THEN ''
           WHEN coalesce(b.external, false) = true THEN b.placeholderKind
           ELSE ''
         END,
         b.placeholderTarget = CASE
           WHEN $targetStatus <> 'real' THEN $targetPlaceholderTarget
           WHEN targetFileCount > 0 THEN ''
           WHEN coalesce(b.external, false) = true THEN b.placeholderTarget
           ELSE ''
         END
     MERGE (a)-[:SYMBOL_IN_REPO]->(r)
     MERGE (b)-[:SYMBOL_IN_REPO]->(r)
     MERGE (a)-[d:DEPENDS_ON {edgeType: $edgeType}]->(b)
     SET d.weight = $weight,
         d.confidence = $confidence,
         d.resolution = $resolution,
         d.resolverId = $resolverId,
         d.resolutionPhase = $resolutionPhase,
         d.provenance = $provenance,
         d.createdAt = CASE WHEN d.createdAt IS NOT NULL THEN d.createdAt ELSE $createdAt END`,
    {
      repoId: edge.repoId,
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      edgeType: edge.edgeType,
      weight: edge.weight,
      confidence: edge.confidence,
      resolution: edge.resolution,
      resolverId: edge.resolverId ?? "pass1-generic",
      resolutionPhase: edge.resolutionPhase ?? "pass1",
      provenance: edge.provenance,
      createdAt: edge.createdAt,
      targetStatus: targetMeta.symbolStatus,
      targetPlaceholderKind: targetMeta.placeholderKind ?? "",
      targetPlaceholderTarget: targetMeta.placeholderTarget ?? "",
    },
  );
}

/**
 * Batch-upsert edges via UNWIND-batched MERGE within a single transaction.
 * Side-effect mode (no RETURN) avoids LadybugDB issue #285.
 */
export interface InsertEdgesOptions extends LadybugWriteChunkOptions {
  /**
   * Skip the MERGE that ensures each source symbol has a SYMBOL_IN_REPO
   * relationship. Callers that already ran `upsertSymbolBatch` for the same
   * symbols in the same transaction should pass `true` — a second MERGE of
   * SYMBOL_IN_REPO after a DELETE-in-same-tx produces a duplicate
   * relationship in LadybugDB (MERGE's MATCH does not see prior MERGE
   * creations when the relationship was deleted earlier in the tx).
   */
  skipSourceRepoLink?: boolean;
  /**
   * Skip the final existing-DEPENDS_ON mutable-property refresh. This is safe
   * only for pass-1 fresh-edge writes where old source symbols were already
   * deleted, or for a fresh DB. General callers keep the default so SCIP/pass-2
   * writes can refresh pre-existing relationships.
   */
  skipExistingRelationshipUpdate?: boolean;
  /**
   * Source symbols were just materialized by the caller, so outgoing
   * relationships for the inserted edge type are known to be absent.
   */
  skipExistingRelationshipProbe?: boolean;
  /**
   * Edge endpoints were just materialized by the caller. Skip node metadata
   * repair so provider-owned unresolved metadata endpoints keep their status.
   */
  skipEndpointMetadata?: boolean;
  /**
   * Edge targets were just materialized by the caller. Skip target placeholder
   * repair and repo-link repair for the same reason as skipEndpointMetadata.
   */
  skipTargetMetadata?: boolean;
  /**
   * Caller already owns the write transaction. Used by provider-first active
   * materialization to avoid nested transactions while preserving parameter
   * binding for provenance-sensitive edge rows.
   */
  useExistingTransaction?: boolean;
  measurePhase?: <T>(
    phaseName: InsertEdgesPhaseName,
    fn: () => Promise<T> | T,
  ) => Promise<T>;
}

export async function insertEdges(
  conn: Connection,
  edges: EdgeRow[],
  options?: InsertEdgesOptions,
): Promise<void> {
  if (edges.length === 0) return;

  const measurePhase =
    options?.measurePhase ??
    (async <T>(
      _phaseName: InsertEdgesPhaseName,
      fn: () => Promise<T> | T,
    ): Promise<T> => await fn());

  edges = await measurePhase("dedupe", () => {
    // Dedup by (repoId, fromSymbolId, toSymbolId, edgeType) — W4 has no
    // within-batch idempotency, so duplicate triples would CREATE twice.
    const seenEdges = new Set<string>();
    return edges.filter((e) => {
      const key =
        `${e.repoId}\0${e.fromSymbolId}\0${e.toSymbolId}\0${e.edgeType}`;
      if (seenEdges.has(key)) return false;
      seenEdges.add(key);
      return true;
    });
  });

  // UNWIND-batched MERGE: chunked to keep param payload bounded. Side-effect
  // mode only (no RETURN) to avoid LadybugDB issue #285.
  const chunkSize = resolveLadybugWriteChunkSize("edges", options?.chunkSize);
  const writeEdges = async (txConn: Connection): Promise<void> => {
    const edgesByRepo = await measurePhase("groupByRepo", () => {
      const grouped = new Map<string, EdgeRow[]>();
      for (const edge of edges) {
        const bucket = grouped.get(edge.repoId);
        if (bucket) bucket.push(edge);
        else grouped.set(edge.repoId, [edge]);
      }
      return grouped;
    });

    for (const [repoId, repoEdges] of edgesByRepo) {
      // W3/W4 workaround for LadybugDB UNWIND+MERGE-rel runtime bug:
      // split MERGE-rel into MERGE-node and OPTIONAL-MATCH+CREATE for the rel.
      if (!options?.skipSourceRepoLink) {
        const fromSymbolIds = [
          ...new Set(repoEdges.map((e) => e.fromSymbolId)),
        ];
        for (let i = 0; i < fromSymbolIds.length; i += chunkSize) {
          const idChunk = fromSymbolIds.slice(i, i + chunkSize);
          const rows = idChunk.map((symbolId) => ({ symbolId }));
          await measurePhase("sourceRepoLink.symbolMetadata", async () =>
            exec(
              txConn,
              `UNWIND $rows AS row
               MERGE (s:Symbol {symbolId: row.symbolId})
               SET s.repoId = $repoId`,
              { repoId, rows },
            ),
          );
          await measurePhase("sourceRepoLink.repoLink", async () =>
            exec(
              txConn,
              `UNWIND $rows AS row
               MATCH (r:Repo {repoId: $repoId})
               MATCH (s:Symbol {symbolId: row.symbolId})
               OPTIONAL MATCH (s)-[existing:SYMBOL_IN_REPO]->(r)
               WITH s, r, existing
               WHERE existing IS NULL
               CREATE (s)-[:SYMBOL_IN_REPO]->(r)`,
              { repoId, rows },
            ),
          );
        }
      }

      for (let i = 0; i < repoEdges.length; i += chunkSize) {
        const edgeChunk = repoEdges.slice(i, i + chunkSize);
        const { rows, targetRows } = await measurePhase("prepareRows", () => {
          const rows = edgeChunk.map((edge) => {
            return {
              repoId,
              fromSymbolId: edge.fromSymbolId,
              toSymbolId: edge.toSymbolId,
              edgeType: edge.edgeType,
              weight: forceDoubleEncoding(edge.weight),
              confidence: forceDoubleEncoding(edge.confidence),
              resolution: edge.resolution,
              resolverId: edge.resolverId ?? "pass1-generic",
              resolutionPhase: edge.resolutionPhase ?? "pass1",
              // Coerce nullable STRING to '' — kuzu binder picks ANY type when
              // a struct field is uniformly null AND a sibling Number field
              // mixes integral (1.0 weight) with fractional (0.6/0.8 weight)
              // values. Upstream kuzudb/kuzu#5685, fixed in PR #5705 but not
              // backported to LadybugDB 0.16.0. Empty string is the workaround.
              provenance: edge.provenance ?? "",
              createdAt: edge.createdAt,
            };
          });
          // Keep placeholder metadata in a unique node-update batch. Updating it
          // from every edge row has previously allowed unrelated UNWIND rows to
          // smear placeholderTarget text across target nodes in LadybugDB.
          const targetRows = buildTargetMetadataRows(edgeChunk);
          return { rows, targetRows };
        });
        // 1: ensure both Symbol nodes exist. Real edge endpoints must repair
        // stale placeholder metadata; otherwise a previously unresolved stub
        // can stay excluded after the real file-backed symbol is indexed.
        if (!options?.skipEndpointMetadata) {
          await measurePhase("endpointMetadata", async () =>
            exec(
              txConn,
              `UNWIND $rows AS row
               MERGE (a:Symbol {symbolId: row.fromSymbolId})
               MERGE (b:Symbol {symbolId: row.toSymbolId})
               SET a.repoId = row.repoId,
                   a.external = CASE
                     WHEN a.symbolId STARTS WITH 'unresolved:' THEN coalesce(a.external, false)
                     ELSE false
                   END,
                   a.symbolStatus = CASE
                     WHEN a.symbolId STARTS WITH 'unresolved:' THEN coalesce(a.symbolStatus, 'unresolved')
                     ELSE 'real'
                   END,
                   a.placeholderKind = CASE
                     WHEN a.symbolId STARTS WITH 'unresolved:' THEN coalesce(a.placeholderKind, '')
                     ELSE ''
                   END,
                   a.placeholderTarget = CASE
                     WHEN a.symbolId STARTS WITH 'unresolved:' THEN coalesce(a.placeholderTarget, '')
                     ELSE ''
                   END,
                   b.repoId = row.repoId`,
              { rows },
            ),
          );
        }
        // Target metadata is node-only and one row per target. Placeholder
        // rows never consult file-backed state, so keep them off the slower
        // OPTIONAL MATCH path used to clean/preserve real target metadata.
        const placeholderRows = targetRows.filter(
          (row) => row.targetStatus !== "real",
        );
        const realTargetRows = targetRows.filter(
          (row) => row.targetStatus === "real",
        );
        if (!options?.skipTargetMetadata && placeholderRows.length > 0) {
          await measurePhase("targetMetadata", async () =>
            exec(
              txConn,
              `UNWIND $rows AS row
               MATCH (b:Symbol {symbolId: row.toSymbolId})
               SET b.repoId = row.repoId,
                   b.external = CASE
                     WHEN row.targetStatus = 'external' THEN true
                     ELSE false
                   END,
                   b.symbolStatus = row.targetStatus,
                   b.placeholderKind = row.targetPlaceholderKind,
                   b.placeholderTarget = row.targetPlaceholderTarget`,
              { rows: placeholderRows },
            ),
          );
        }
        if (!options?.skipTargetMetadata && realTargetRows.length > 0) {
          await measurePhase("targetMetadata", async () =>
            exec(
              txConn,
              `UNWIND $rows AS row
               MATCH (b:Symbol {symbolId: row.toSymbolId})
               OPTIONAL MATCH (b)-[:SYMBOL_IN_FILE]->(bf:File)
               WITH row, b, count(bf) AS targetFileCount
               SET b.repoId = row.repoId,
                   b.external = CASE
                     WHEN row.targetStatus = 'external' THEN true
                     WHEN row.targetStatus <> 'real' THEN false
                     WHEN targetFileCount > 0 THEN false
                     ELSE coalesce(b.external, false)
                   END,
                   b.symbolStatus = CASE
                     WHEN row.targetStatus <> 'real' THEN row.targetStatus
                     WHEN targetFileCount > 0 THEN 'real'
                     WHEN coalesce(b.external, false) = true THEN 'external'
                     ELSE 'real'
                   END,
                   b.placeholderKind = CASE
                     WHEN row.targetStatus <> 'real' THEN row.targetPlaceholderKind
                     WHEN targetFileCount > 0 THEN ''
                     WHEN coalesce(b.external, false) = true THEN b.placeholderKind
                     ELSE ''
                   END,
                   b.placeholderTarget = CASE
                     WHEN row.targetStatus <> 'real' THEN row.targetPlaceholderTarget
                     WHEN targetFileCount > 0 THEN ''
                     WHEN coalesce(b.external, false) = true THEN b.placeholderTarget
                     ELSE ''
                   END`,
              { rows: realTargetRows },
            ),
          );
        }
        if (!options?.skipTargetMetadata && placeholderRows.length > 0) {
          await measurePhase("targetRepoLink", async () =>
            ensureDependencyTargetRepoLinks(txConn, placeholderRows),
          );
        }
        // 2: create rel if missing — sets createdAt + all props.
        if (options?.skipExistingRelationshipProbe) {
          await measurePhase("relationshipCreate", async () =>
            exec(
              txConn,
              `UNWIND $rows AS row
               MATCH (a:Symbol {symbolId: row.fromSymbolId})
               MATCH (b:Symbol {symbolId: row.toSymbolId})
               CREATE (a)-[:DEPENDS_ON {
                 edgeType: row.edgeType,
                 weight: row.weight,
                 confidence: row.confidence,
                 resolution: row.resolution,
                 resolverId: row.resolverId,
                 resolutionPhase: row.resolutionPhase,
                 provenance: row.provenance,
                 createdAt: row.createdAt
               }]->(b)`,
              { rows },
            ),
          );
        } else {
          await measurePhase("relationshipCreate", async () =>
            exec(
              txConn,
              `UNWIND $rows AS row
               MATCH (a:Symbol {symbolId: row.fromSymbolId})
               MATCH (b:Symbol {symbolId: row.toSymbolId})
               OPTIONAL MATCH (a)-[existing:DEPENDS_ON {edgeType: row.edgeType}]->(b)
               WITH a, b, row, existing
               WHERE existing IS NULL
               CREATE (a)-[:DEPENDS_ON {
                 edgeType: row.edgeType,
                 weight: row.weight,
                 confidence: row.confidence,
                 resolution: row.resolution,
                 resolverId: row.resolverId,
                 resolutionPhase: row.resolutionPhase,
                 provenance: row.provenance,
                 createdAt: row.createdAt
               }]->(b)`,
              { rows },
            ),
          );
        }
        if (!options?.skipExistingRelationshipUpdate) {
          // 3: refresh mutable props on existing rels (preserves createdAt).
          // The WHERE guard prevents pass-2 (heuristic, confidence ~0.7-0.85)
          // from overwriting SCIP-written exact edges (resolution: "exact",
          // confidence: 0.95). Pass-2 now runs AFTER SCIP ingest, so without
          // the guard every pass-2 file would clobber SCIP exact edges on
          // shared (from, to, edgeType) triples. The OR clause keeps an
          // upgrade path open if a future row carries higher confidence
          // than the existing exact edge.
          await measurePhase("relationshipUpdate", async () =>
            exec(
              txConn,
              `UNWIND $rows AS row
               MATCH (a:Symbol {symbolId: row.fromSymbolId})
               MATCH (b:Symbol {symbolId: row.toSymbolId})
               MATCH (a)-[d:DEPENDS_ON {edgeType: row.edgeType}]->(b)
               WHERE d.resolution <> 'exact' OR d.confidence < row.confidence
               SET d.weight = row.weight,
                   d.confidence = row.confidence,
                   d.resolution = row.resolution,
                   d.resolverId = row.resolverId,
                   d.resolutionPhase = row.resolutionPhase,
                   d.provenance = row.provenance`,
              { rows },
            ),
          );
        }
      }
    }
  };

  if (options?.useExistingTransaction) {
    await writeEdges(conn);
  } else {
    await withTransaction(conn, writeEdges);
  }
}

export async function normalizeProviderFirstCallEdgeProvenance(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const rows = await queryAll<{
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    resolverId: string | null;
    provenance: string | null;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE d.edgeType = 'call'
       AND coalesce(d.resolverId, '') STARTS WITH 'provider-first:'
     RETURN a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.resolverId AS resolverId,
            d.provenance AS provenance`,
    { repoId },
  );
  const repairs = rows
    .filter((row) => !hasProviderFirstDedupeProvenance(row.provenance))
    .map((row) => {
      const providerId =
        row.resolverId?.replace(/^provider-first:/, "") || "unknown";
      return {
        fromSymbolId: row.fromSymbolId,
        toSymbolId: row.toSymbolId,
        edgeType: row.edgeType,
        provenance: JSON.stringify({
          providerId,
          providerType: providerId.includes("scip") ? "scip" : "unknown",
          repaired: true,
          previousProvenance: row.provenance ?? "",
          dedupeKey: [
            row.fromSymbolId,
            row.toSymbolId,
            row.edgeType,
            providerId,
          ].join("|"),
        }),
      };
    });
  if (repairs.length === 0) return 0;

  const chunkSize = resolveLadybugWriteChunkSize("edges");
  for (let i = 0; i < repairs.length; i += chunkSize) {
    const chunk = repairs.slice(i, i + chunkSize);
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (a:Symbol {symbolId: row.fromSymbolId})
       MATCH (b:Symbol {symbolId: row.toSymbolId})
       MATCH (a)-[d:DEPENDS_ON {edgeType: row.edgeType}]->(b)
       SET d.provenance = row.provenance`,
      { rows: chunk },
    );
  }
  return repairs.length;
}

function hasProviderFirstDedupeProvenance(provenance: string | null): boolean {
  if (!provenance) return false;
  try {
    const parsed = JSON.parse(provenance) as { dedupeKey?: unknown };
    return typeof parsed.dedupeKey === "string" && parsed.dedupeKey.length > 0;
  } catch {
    return false;
  }
}

/**
 * Insert edges when the caller has already validated every endpoint and
 * recreated source symbols in the same replacement materialization. The fresh
 * source symbols have no outgoing DEPENDS_ON rows, so provider-first can bulk
 * load relationships directly without endpoint repair or existence probes.
 */
export async function insertKnownSymbolEdges(
  conn: Connection,
  edges: EdgeRow[],
  options?: InsertKnownSymbolEdgesOptions,
): Promise<void> {
  if (edges.length === 0) return;

  const seenEdges = new Set<string>();
  edges = edges.filter((edge) => {
    const key =
      `${edge.repoId}\0${edge.fromSymbolId}\0${edge.toSymbolId}\0${edge.edgeType}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });

  // The old UNWIND writer needed chunks to bound parameter payloads. COPY
  // streams from a temporary artifact, so a single load is the intended fast
  // path for provider-first full rebuilds.
  await withTransaction(
    conn,
    async (txConn) => {
      await copyKnownSymbolEdges(txConn, edges, options);
    },
    options?.measurePhase ? { measurePhase: options.measurePhase } : undefined,
  );
}

/**
 * Prepare non-real dependency targets before a fresh-source relationship COPY.
 * The caller must already have inserted every source Symbol. This preserves
 * unresolved/external placeholder metadata without running the generic
 * endpoint-repair writer for each edge batch.
 */
export async function ensureDependencyTargetsForKnownSourceEdges(
  conn: Connection,
  edges: readonly EdgeRow[],
  options?: EnsureDependencyTargetsOptions,
): Promise<void> {
  if (edges.length === 0) return;

  const targetRows = buildTargetMetadataRows([...edges]).filter(
    (row) => row.targetStatus !== "real",
  );
  if (targetRows.length === 0) return;

  const chunkSize = resolveLadybugWriteChunkSize("edges", options?.chunkSize);
  const measurePhase =
    options?.measurePhase ??
    (async <T>(
      _phaseName: DependencyTargetEnsurePhaseName,
      fn: () => Promise<T>,
    ): Promise<T> => await fn());
  await withTransaction(conn, async (txConn) => {
    const copyMissingRows: DependencyTargetMetadataRow[] = [];
    const mergeRows: DependencyTargetMetadataRow[] = [];
    for (const row of targetRows) {
      if (isCopyMissingPlaceholderTarget(row)) {
        copyMissingRows.push(row);
      } else {
        mergeRows.push(row);
      }
    }

    for (let i = 0; i < copyMissingRows.length; i += chunkSize) {
      const rows = copyMissingRows.slice(i, i + chunkSize);
      await ensureCopyMissingPlaceholderTargets(txConn, rows, measurePhase);
    }

    for (let i = 0; i < mergeRows.length; i += chunkSize) {
      const rows = mergeRows.slice(i, i + chunkSize);
      await measurePhase("symbolMetadata.mergeFallback", async () =>
        exec(
          txConn,
          `UNWIND $rows AS row
           MERGE (b:Symbol {symbolId: row.toSymbolId})
           SET b.repoId = row.repoId,
               b.external = CASE
                 WHEN row.targetStatus = 'external' THEN true
                 ELSE false
               END,
               b.symbolStatus = row.targetStatus,
               b.placeholderKind = row.targetPlaceholderKind,
               b.placeholderTarget = row.targetPlaceholderTarget`,
          { rows },
        ),
      );
      await measurePhase("repoLink", async () =>
        ensureDependencyTargetRepoLinks(txConn, rows),
      );
    }
  });
}

function isCopyMissingPlaceholderTarget(
  row: DependencyTargetMetadataRow,
): boolean {
  return (
    row.targetStatus === "unresolved" &&
    row.targetPlaceholderKind === "call" &&
    isSafeUnresolvedCallSymbolId(row.toSymbolId)
  );
}

async function ensureCopyMissingPlaceholderTargets(
  conn: Connection,
  rows: readonly DependencyTargetMetadataRow[],
  measurePhase: EnsureDependencyTargetsOptions["measurePhase"],
): Promise<void> {
  if (!measurePhase || rows.length === 0) return;

  const existingSymbolIds = await measurePhase(
    "symbolMetadata.probeExisting",
    async () => await queryExistingSymbolIds(conn, rows),
  );
  const existingRows: DependencyTargetMetadataRow[] = [];
  const missingRows: DependencyTargetMetadataRow[] = [];
  for (const row of rows) {
    if (existingSymbolIds.has(row.toSymbolId)) {
      existingRows.push(row);
    } else {
      missingRows.push(row);
    }
  }

  if (missingRows.length > 0) {
    await copyMissingPlaceholderTargets(conn, missingRows, measurePhase);
  }
  if (existingRows.length > 0) {
    await measurePhase("symbolMetadata.matchExisting", async () =>
      updateExistingPlaceholderTargets(conn, existingRows),
    );
    await measurePhase("repoLink", async () =>
      ensureDependencyTargetRepoLinks(conn, existingRows),
    );
  }
}

async function queryExistingSymbolIds(
  conn: Connection,
  rows: readonly DependencyTargetMetadataRow[],
): Promise<Set<string>> {
  const symbolIds = rows.map((row) => row.toSymbolId);
  const result = await queryAll<{ symbolId: unknown }>(
    conn,
    `UNWIND $symbolIds AS symbolId
     MATCH (s:Symbol {symbolId: symbolId})
     RETURN s.symbolId AS symbolId`,
    { symbolIds },
  );
  return new Set(
    result
      .map((row) => (typeof row.symbolId === "string" ? row.symbolId : null))
      .filter((symbolId): symbolId is string => symbolId !== null),
  );
}

async function copyMissingPlaceholderTargets(
  conn: Connection,
  rows: readonly DependencyTargetMetadataRow[],
  measurePhase: NonNullable<EnsureDependencyTargetsOptions["measurePhase"]>,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "sdl-placeholder-targets-"));
  const symbolPath = join(tempDir, "symbols.csv");
  const symbolInRepoPath = join(tempDir, "symbol-in-repo.csv");
  try {
    await measurePhase("symbolMetadata.copyMissing.csvMaterialize", async () => {
      await writePlaceholderSymbolsCsv(symbolPath, rows);
      await writeSimpleRelCsv(
        symbolInRepoPath,
        rows.map((row) => [row.toSymbolId, row.repoId] as const),
      );
    });
    await measurePhase("symbolMetadata.copyMissing.copyFrom", async () =>
      copyPlaceholderSymbolCsvArtifact(conn, symbolPath),
    );
    await measurePhase("repoLink", async () =>
      copyCsvArtifact(conn, "SYMBOL_IN_REPO", symbolInRepoPath),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function updateExistingPlaceholderTargets(
  conn: Connection,
  rows: readonly DependencyTargetMetadataRow[],
): Promise<void> {
  await exec(
    conn,
    `UNWIND $rows AS row
     MATCH (b:Symbol {symbolId: row.toSymbolId})
     OPTIONAL MATCH (b)-[:SYMBOL_IN_FILE]->(:File)
     WITH b, row, count(*) AS fileBackedCount
     WHERE fileBackedCount = 0
     SET b.repoId = row.repoId,
         b.external = CASE
           WHEN row.targetStatus = 'external' THEN true
           ELSE false
         END,
         b.symbolStatus = row.targetStatus,
         b.placeholderKind = row.targetPlaceholderKind,
         b.placeholderTarget = row.targetPlaceholderTarget`,
    { rows },
  );
}

async function ensureDependencyTargetRepoLinks(
  conn: Connection,
  rows: readonly DependencyTargetMetadataRow[],
): Promise<void> {
  for (const [repoId, symbolIds] of groupTargetSymbolIdsByRepo(rows)) {
    await exec(
      conn,
      `MATCH (r:Repo {repoId: $repoId})
       UNWIND $symbolIds AS symbolId
       MATCH (b:Symbol {symbolId: symbolId})
       OPTIONAL MATCH (b)-[existing:SYMBOL_IN_REPO]->(r)
       WITH b, r, existing
       WHERE existing IS NULL
       CREATE (b)-[:SYMBOL_IN_REPO]->(r)`,
      { repoId, symbolIds },
    );
  }
}

function groupTargetSymbolIdsByRepo(
  rows: readonly DependencyTargetMetadataRow[],
): Map<string, string[]> {
  const byRepo = new Map<string, string[]>();
  for (const row of rows) {
    const symbolIds = byRepo.get(row.repoId);
    if (symbolIds) {
      symbolIds.push(row.toSymbolId);
    } else {
      byRepo.set(row.repoId, [row.toSymbolId]);
    }
  }
  return byRepo;
}

async function writePlaceholderSymbolsCsv(
  filePath: string,
  rows: readonly DependencyTargetMetadataRow[],
): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  try {
    await writeCsvLine(stream, PLACEHOLDER_SYMBOL_COPY_COLUMNS);
    for (const row of rows) {
      await writePlaceholderSymbolCsvLine(
        stream,
        placeholderSymbolRowToCopyCells(row),
      );
    }
    stream.end();
    await finished(stream);
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

function placeholderSymbolRowToCopyCells(
  row: DependencyTargetMetadataRow,
): unknown[] {
  return [
    row.toSymbolId,
    row.repoId,
    "placeholder",
    row.targetPlaceholderTarget || row.toSymbolId,
    false,
    "",
    "",
    0,
    0,
    0,
    0,
    "",
    "",
    "",
    0.0,
    "unknown",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    CSV_ARRAY_NULL,
    "",
    "",
    "",
    "",
    "",
    "",
    CSV_ARRAY_NULL,
    CSV_ARRAY_NULL,
    row.targetStatus === "external",
    "",
    "treesitter",
    "",
    "",
    row.targetStatus,
    row.targetPlaceholderKind,
    row.targetPlaceholderTarget,
  ];
}

async function writeSimpleRelCsv(
  filePath: string,
  rows: readonly (readonly [string, string])[],
): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  try {
    await writeCsvLine(stream, SIMPLE_REL_COPY_COLUMNS);
    for (const row of rows) {
      await writeCsvLine(stream, row);
    }
    stream.end();
    await finished(stream);
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

async function copyCsvArtifact(
  conn: Connection,
  tableName: string,
  filePath: string,
): Promise<void> {
  await execDdl(
    conn,
    `COPY ${tableName} FROM '${escapeCopyPath(filePath)}' ` +
      `(HEADER=true, PARALLEL=FALSE, NULL_STRINGS=['${escapeCopyOptionString(CSV_NULL_SENTINEL)}'])`,
  );
}

async function copyPlaceholderSymbolCsvArtifact(
  conn: Connection,
  filePath: string,
): Promise<void> {
  await execDdl(
    conn,
    `COPY Symbol FROM '${escapeCopyPath(filePath)}' ` +
      `(HEADER=true, PARALLEL=FALSE, NULL_STRINGS=['${escapeCopyOptionString(SYMBOL_CSV_NULL_SENTINEL)}'])`,
  );
}

async function copyKnownSymbolEdges(
  conn: Connection,
  edges: readonly EdgeRow[],
  options?: InsertKnownSymbolEdgesOptions,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "sdl-known-edges-"));
  const filePath = join(tempDir, "depends-on.csv");
  const measurePhase =
    options?.measurePhase ??
    (async <T>(
      _phaseName: KnownSymbolEdgesCopyPhaseName,
      fn: () => Promise<T>,
    ): Promise<T> => await fn());
  try {
    await measurePhase("csvMaterialize", async () =>
      writeKnownSymbolEdgesCsv(filePath, edges),
    );
    await measurePhase("copyFrom", async () =>
      execDdl(
        conn,
        `COPY DEPENDS_ON FROM '${escapeCopyPath(filePath)}' ` +
          `(HEADER=true, PARALLEL=FALSE, NULL_STRINGS=['${escapeCopyOptionString(CSV_NULL_SENTINEL)}'])`,
      ),
    );
  } finally {
    await measurePhase("tempCleanup", async () => {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    });
  }
}

async function writeKnownSymbolEdgesCsv(
  filePath: string,
  edges: readonly EdgeRow[],
): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  try {
    await writeCsvLine(stream, EDGE_COPY_COLUMNS);
    for (const edge of edges) {
      await writeCsvLine(stream, [
        edge.fromSymbolId,
        edge.toSymbolId,
        edge.edgeType,
        edge.weight,
        edge.confidence,
        edge.resolution,
        edge.resolverId ?? "pass1-generic",
        edge.resolutionPhase ?? "pass1",
        edge.provenance ?? "",
        edge.createdAt,
      ]);
    }
    stream.end();
    await finished(stream);
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

async function writeCsvLine(
  stream: NodeJS.WritableStream,
  cells: readonly unknown[],
): Promise<void> {
  const line = `${cells.map(csvCell).join(",")}\n`;
  if (!stream.write(line)) {
    await waitForDrain(stream);
  }
}

async function writePlaceholderSymbolCsvLine(
  stream: NodeJS.WritableStream,
  cells: readonly unknown[],
): Promise<void> {
  const line = `${cells.map(placeholderSymbolCsvCell).join(",")}\n`;
  if (!stream.write(line)) {
    await waitForDrain(stream);
  }
}

function waitForDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stream.removeListener("drain", onDrain);
      stream.removeListener("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function csvCell(value: unknown): string {
  if (value === CSV_ARRAY_NULL) return "";
  if (value === null || value === undefined) return CSV_NULL_SENTINEL;
  const text = String(value);
  if (text === "") return '""';
  const escaped = text.replaceAll('"', '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function placeholderSymbolCsvCell(value: unknown): string {
  if (value === CSV_ARRAY_NULL) return "";
  if (value === null || value === undefined) return SYMBOL_CSV_NULL_SENTINEL;
  const text = String(value);
  if (text === "") return '""';
  const escaped = text.replaceAll('"', '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function escapeCopyPath(path: string): string {
  return normalizePath(path).replace(/'/g, "''");
}

function escapeCopyOptionString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

interface DependencyTargetMetadataRow {
  repoId: string;
  toSymbolId: string;
  targetStatus: SymbolPlaceholderMeta["symbolStatus"];
  targetPlaceholderKind: string;
  targetPlaceholderTarget: string;
}

function buildTargetMetadataRows(edges: EdgeRow[]): DependencyTargetMetadataRow[] {
  const rowsBySymbolId = new Map<string, DependencyTargetMetadataRow>();

  for (const edge of edges) {
    if (rowsBySymbolId.has(edge.toSymbolId)) {
      continue;
    }
    const targetMeta =
      edge.targetMeta ?? classifyDependencyTarget(edge.toSymbolId);
    rowsBySymbolId.set(edge.toSymbolId, {
      repoId: edge.repoId,
      toSymbolId: edge.toSymbolId,
      targetStatus: targetMeta.symbolStatus,
      targetPlaceholderKind: targetMeta.placeholderKind ?? "",
      targetPlaceholderTarget: targetMeta.placeholderTarget ?? "",
    });
  }

  return [...rowsBySymbolId.values()];
}

export async function deleteEdge(
  conn: Connection,
  edge: { fromSymbolId: string; toSymbolId: string; edgeType: string },
): Promise<void> {
  await exec(
    conn,
    `MATCH (a:Symbol {symbolId: $fromSymbolId})-[d:DEPENDS_ON]->(b:Symbol {symbolId: $toSymbolId})
     WHERE d.edgeType = $edgeType
     DELETE d`,
    {
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      edgeType: edge.edgeType,
    },
  );
}

export async function deleteEdges(
  conn: Connection,
  edges: Array<{ fromSymbolId: string; toSymbolId: string; edgeType: string }>,
): Promise<void> {
  if (edges.length === 0) {
    return;
  }

  await exec(
    conn,
    `UNWIND $edges AS edge
     MATCH (a:Symbol {symbolId: edge.fromSymbolId})-[d:DEPENDS_ON {edgeType: edge.edgeType}]->(b:Symbol {symbolId: edge.toSymbolId})
     DELETE d`,
    { edges },
  );
}

export async function deleteCallEdgesToTargetsByRepo(
  conn: Connection,
  repoId: string,
  targetSymbolIds: string[],
): Promise<void> {
  const uniqueTargetSymbolIds = Array.from(
    new Set(targetSymbolIds.filter((symbolId) => symbolId.length > 0)),
  );
  if (uniqueTargetSymbolIds.length === 0) {
    return;
  }

  await exec(
    conn,
    `MATCH (b:Symbol)
     WHERE b.symbolId IN $targetSymbolIds
       AND b.symbolId STARTS WITH 'unresolved:call:'
     MATCH (a:Symbol)-[d:DEPENDS_ON]->(b)
     MATCH (a)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
     WHERE d.edgeType = 'call'
     WITH DISTINCT d
     DELETE d`,
    { repoId, targetSymbolIds: uniqueTargetSymbolIds },
  );
}

export async function getEdgesFrom(
  conn: Connection,
  symbolId: string,
  options?: EdgeQueryOptions,
): Promise<EdgeRow[]> {
  const minCallConfidenceClause = buildMinCallConfidenceClause(
    "d",
    options?.minCallConfidence,
  );
  const rows = await queryAll<{
    repoId: string;
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string;
    resolverId: string | null;
    resolutionPhase: string | null;
    provenance: string | null;
    createdAt: string;
  }>(
    conn,
    `MATCH (a:Symbol {symbolId: $symbolId})-[d:DEPENDS_ON]->(b:Symbol)
     WHERE 1 = 1${minCallConfidenceClause}
     MATCH (a)-[:SYMBOL_IN_REPO]->(r:Repo)
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId,
            d.resolutionPhase AS resolutionPhase,
            d.provenance AS provenance,
            d.createdAt AS createdAt`,
    {
      symbolId,
      ...(options?.minCallConfidence !== undefined
        ? { minCallConfidence: options.minCallConfidence }
        : {}),
    },
  );

  return rows.map((row) => ({
    repoId: row.repoId,
    fromSymbolId: row.fromSymbolId,
    toSymbolId: row.toSymbolId,
    edgeType: row.edgeType,
    weight: toNumber(row.weight),
    confidence: toNumber(row.confidence),
    resolution: row.resolution,
    resolverId: row.resolverId ?? undefined,
    resolutionPhase: row.resolutionPhase ?? undefined,
    provenance: row.provenance,
    createdAt: row.createdAt,
  }));
}

export async function getEdgesFromSymbols(
  conn: Connection,
  symbolIds: string[],
  options?: EdgeQueryOptions,
): Promise<Map<string, EdgeRow[]>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, EdgeRow[]>();
  for (const id of symbolIds) result.set(id, []);

  const minCallConfidenceClause = buildMinCallConfidenceClause(
    "d",
    options?.minCallConfidence,
  );

  const rows = await queryAll<{
    repoId: string;
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string;
    resolverId: string | null;
    resolutionPhase: string | null;
    provenance: string | null;
    createdAt: string;
  }>(
    conn,
    `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE a.symbolId IN $symbolIds${minCallConfidenceClause}
     MATCH (a)-[:SYMBOL_IN_REPO]->(r:Repo)
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId,
            d.resolutionPhase AS resolutionPhase,
            d.provenance AS provenance,
            d.createdAt AS createdAt`,
    {
      symbolIds,
      ...(options?.minCallConfidence !== undefined
        ? { minCallConfidence: options.minCallConfidence }
        : {}),
    },
  );

  for (const row of rows) {
    const bucket = result.get(row.fromSymbolId);
    if (!bucket) continue;
    bucket.push({
      repoId: row.repoId,
      fromSymbolId: row.fromSymbolId,
      toSymbolId: row.toSymbolId,
      edgeType: row.edgeType,
      weight: toNumber(row.weight),
      confidence: toNumber(row.confidence),
      resolution: row.resolution,
      resolverId: row.resolverId ?? undefined,
      resolutionPhase: row.resolutionPhase ?? undefined,
      provenance: row.provenance,
      createdAt: row.createdAt,
    });
  }

  return result;
}

export async function getEdgesFromSymbolsForSlice(
  conn: Connection,
  symbolIds: string[],
  options?: EdgeQueryOptions,
): Promise<Map<string, EdgeForSlice[]>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, EdgeForSlice[]>();
  for (const id of symbolIds) result.set(id, []);

  const minCallConfidenceClause = buildMinCallConfidenceClause(
    "d",
    options?.minCallConfidence,
  );

  const rows = await queryAll<{
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string | null;
    resolverId: string | null;
    resolutionPhase: string | null;
  }>(
    conn,
    `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE a.symbolId IN $symbolIds${minCallConfidenceClause}
     RETURN a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId,
            d.resolutionPhase AS resolutionPhase`,
    {
      symbolIds,
      ...(options?.minCallConfidence !== undefined
        ? { minCallConfidence: options.minCallConfidence }
        : {}),
    },
  );

  for (const row of rows) {
    const bucket = result.get(row.fromSymbolId);
    if (!bucket) continue;
    bucket.push({
      fromSymbolId: row.fromSymbolId,
      toSymbolId: row.toSymbolId,
      edgeType: row.edgeType,
      weight: toNumber(row.weight),
      confidence: toNumber(row.confidence),
      resolution: row.resolution ?? undefined,
      resolverId: row.resolverId ?? undefined,
      resolutionPhase: row.resolutionPhase ?? undefined,
    });
  }

  return result;
}

export async function getEdgesFromSymbolsLite(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, EdgeLite[]>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, EdgeLite[]>();
  for (const id of symbolIds) result.set(id, []);

  const rows = await queryAll<{
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
  }>(
    conn,
    `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE a.symbolId IN $symbolIds
     RETURN a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType`,
    { symbolIds },
  );

  for (const row of rows) {
    const bucket = result.get(row.fromSymbolId);
    if (!bucket) continue;
    bucket.push({
      fromSymbolId: row.fromSymbolId,
      toSymbolId: row.toSymbolId,
      edgeType: row.edgeType,
    });
  }

  return result;
}

export async function getEdgesToSymbols(
  conn: Connection,
  symbolIds: string[],
  options?: EdgeQueryOptions,
): Promise<Map<string, EdgeRow[]>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, EdgeRow[]>();
  for (const id of symbolIds) result.set(id, []);

  const minCallConfidenceClause = buildMinCallConfidenceClause(
    "d",
    options?.minCallConfidence,
  );

  const queryWithHint = `MATCH (b:Symbol)
     WHERE b.symbolId IN $symbolIds
     MATCH (a:Symbol)-[d:DEPENDS_ON]->(b)
     WHERE 1 = 1${minCallConfidenceClause}
     MATCH (a)-[:SYMBOL_IN_REPO]->(r:Repo)
     WITH b, d, a, r
     HINT (b JOIN (d JOIN a))
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId,
            d.resolutionPhase AS resolutionPhase,
            d.provenance AS provenance,
            d.createdAt AS createdAt
     ORDER BY a.symbolId`;

  const queryWithoutHint = `MATCH (b:Symbol)
     WHERE b.symbolId IN $symbolIds
     MATCH (a:Symbol)-[d:DEPENDS_ON]->(b)
     WHERE 1 = 1${minCallConfidenceClause}
     MATCH (a)-[:SYMBOL_IN_REPO]->(r:Repo)
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId,
            d.resolutionPhase AS resolutionPhase,
            d.provenance AS provenance,
            d.createdAt AS createdAt
     ORDER BY a.symbolId`;

  const useJoinHint = await getJoinHintSupported(conn);
  const rows = await queryAll<{
    repoId: string;
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string;
    resolverId: string | null;
    resolutionPhase: string | null;
    provenance: string | null;
    createdAt: string;
  }>(conn, useJoinHint ? queryWithHint : queryWithoutHint, {
    symbolIds,
    ...(options?.minCallConfidence !== undefined
      ? { minCallConfidence: options.minCallConfidence }
      : {}),
  });

  for (const row of rows) {
    const bucket = result.get(row.toSymbolId);
    if (!bucket) continue;
    bucket.push({
      repoId: row.repoId,
      fromSymbolId: row.fromSymbolId,
      toSymbolId: row.toSymbolId,
      edgeType: row.edgeType,
      weight: toNumber(row.weight),
      confidence: toNumber(row.confidence),
      resolution: row.resolution,
      resolverId: row.resolverId ?? undefined,
      resolutionPhase: row.resolutionPhase ?? undefined,
      provenance: row.provenance,
      createdAt: row.createdAt,
    });
  }

  return result;
}

export async function getEdgesByRepo(
  conn: Connection,
  repoId: string,
): Promise<EdgeRow[]> {
  const rows = await queryAll<{
    repoId: string;
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string;
    resolverId: string | null;
    resolutionPhase: string | null;
    provenance: string | null;
    createdAt: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId,
            d.resolutionPhase AS resolutionPhase,
            d.provenance AS provenance,
            d.createdAt AS createdAt`,
    { repoId },
  );

  return rows.map((row) => ({
    repoId: row.repoId,
    fromSymbolId: row.fromSymbolId,
    toSymbolId: row.toSymbolId,
    edgeType: row.edgeType,
    weight: toNumber(row.weight),
    confidence: toNumber(row.confidence),
    resolution: row.resolution,
    resolverId: row.resolverId ?? undefined,
    resolutionPhase: row.resolutionPhase ?? undefined,
    provenance: row.provenance,
    createdAt: row.createdAt,
  }));
}

export async function getEdgesByRepoLite(
  conn: Connection,
  repoId: string,
): Promise<EdgeLite[]> {
  return await queryAll<EdgeLite>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     RETURN a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType`,
    { repoId },
  );
}

export interface UnresolvedImportEdgeCandidate {
  fromSymbolId: string;
  toSymbolId: string;
  provenance: string | null;
}

export interface UnresolvedImportEdgeQueryOptions {
  affectedPaths?: string[];
}

export interface UnresolvedCallEdgeCandidate {
  fromSymbolId: string;
  toSymbolId: string;
}

export async function getUnresolvedImportEdgesByRepo(
  conn: Connection,
  repoId: string,
  options?: UnresolvedImportEdgeQueryOptions,
): Promise<UnresolvedImportEdgeCandidate[]> {
  const affectedPaths = Array.from(
    new Set((options?.affectedPaths ?? []).map((path) => normalizePath(path))),
  ).filter((path) => path.length > 0);
  const params: Record<string, unknown> = { repoId };
  const targetPrefixClauses: string[] = [];
  for (const [index, relPath] of affectedPaths.entries()) {
    const paramName = `targetPrefix${index}`;
    params[paramName] = `unresolved:${relPath}:`;
    targetPrefixClauses.push(`b.symbolId STARTS WITH $${paramName}`);
  }

  const affectedPathsMatchClause =
    affectedPaths.length > 0
      ? `
     MATCH (a)-[:SYMBOL_IN_FILE]->(f:File)`
      : "";
  const affectedPathsFilterClause =
    affectedPaths.length > 0
      ? `
       AND (f.relPath IN $affectedPaths OR ${targetPrefixClauses.join(" OR ")})`
      : "";
  if (affectedPaths.length > 0) {
    params.affectedPaths = affectedPaths;
  }

  const rows = await queryAll<{
    fromSymbolId: string;
    toSymbolId: string;
    provenance: string | null;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     ${affectedPathsMatchClause}
     WHERE d.edgeType = 'import'
       AND b.symbolId STARTS WITH 'unresolved:'
       AND coalesce(b.symbolStatus, '') = 'unresolved'${
       affectedPaths.length > 0
         ? `
       ${affectedPathsFilterClause}`
         : ""
     }
     RETURN a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.provenance AS provenance`,
    params,
  );

  return rows.map((row) => ({
    fromSymbolId: row.fromSymbolId,
    toSymbolId: row.toSymbolId,
    provenance: row.provenance,
  }));
}

export async function getUnresolvedCallEdgesByRepo(
  conn: Connection,
  repoId: string,
): Promise<UnresolvedCallEdgeCandidate[]> {
  const rows = await queryAll<{
    fromSymbolId: string;
    toSymbolId: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE d.edgeType = 'call' AND b.symbolId STARTS WITH 'unresolved:call:'
     RETURN DISTINCT a.symbolId AS fromSymbolId,
                     b.symbolId AS toSymbolId`,
    { repoId },
  );

  return rows.map((row) => ({
    fromSymbolId: row.fromSymbolId,
    toSymbolId: row.toSymbolId,
  }));
}

export async function getUnresolvedCallTargetIdsByRepo(
  conn: Connection,
  repoId: string,
): Promise<string[]> {
  const rows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE d.edgeType = 'call' AND b.symbolId STARTS WITH 'unresolved:call:'
     RETURN DISTINCT b.symbolId AS symbolId`,
    { repoId },
  );

  return rows.map((row) => row.symbolId);
}

export async function getCallersOfSymbols(
  conn: Connection,
  repoId: string,
  symbolIds: string[],
): Promise<string[]> {
  if (symbolIds.length === 0) return [];

  const queryWithHint = `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(to:Symbol)
     WHERE to.symbolId IN $symbolIds
     MATCH (from:Symbol)-[d:DEPENDS_ON]->(to)
     MATCH (from)-[:SYMBOL_IN_REPO]->(r)
     WHERE d.edgeType IN ['call', 'import']
     WITH r, to, d, from
     HINT (to JOIN (d JOIN from))
     RETURN DISTINCT from.symbolId AS symbolId
     ORDER BY symbolId`;

  const queryWithoutHint = `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(to:Symbol)
     WHERE to.symbolId IN $symbolIds
     MATCH (from:Symbol)-[d:DEPENDS_ON]->(to)
     MATCH (from)-[:SYMBOL_IN_REPO]->(r)
     WHERE d.edgeType IN ['call', 'import']
     RETURN DISTINCT from.symbolId AS symbolId
     ORDER BY symbolId`;

  const useJoinHint = await getJoinHintSupported(conn);
  const rows = await queryAll<{ symbolId: string }>(
    conn,
    useJoinHint ? queryWithHint : queryWithoutHint,
    { repoId, symbolIds },
  );

  return rows.map((row) => row.symbolId);
}

export async function deleteEdgesByFileId(
  conn: Connection,
  fileId: string,
): Promise<void> {
  await withTransaction(conn, async (txConn) => {
    const symbolRows = await queryAll<{ symbolId: string }>(
      txConn,
      `MATCH (f:File {fileId: $fileId})<-[:SYMBOL_IN_FILE]-(s:Symbol)
       RETURN s.symbolId AS symbolId`,
      { fileId },
    );

    const symbolIds = symbolRows.map((r) => r.symbolId);
    if (symbolIds.length === 0) return;

    await exec(
      txConn,
      `MATCH (s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    );

    await exec(
      txConn,
      `MATCH (:Symbol)-[d:DEPENDS_ON]->(s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    );
  });
}

/**
 * Deletes outgoing DEPENDS_ON edges of a specific type for given symbols.
 * NOTE: Callers should wrap this in a transaction if followed by edge insertions
 * to ensure atomic delete+insert behavior.
 */
export async function deleteOutgoingEdgesByTypeForSymbols(
  conn: Connection,
  symbolIds: string[],
  edgeType: string,
): Promise<void> {
  if (symbolIds.length === 0) return;

  await exec(
    conn,
    `MATCH (s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     WHERE s.symbolId IN $symbolIds AND d.edgeType = $edgeType
     DELETE d`,
    { symbolIds, edgeType },
  );
}

export async function getEdgeCountsByType(
  conn: Connection,
  repoId: string,
): Promise<Record<string, number>> {
  const rows = await queryAll<{ edgeType: string; count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     RETURN d.edgeType AS edgeType, count(d) AS count`,
    { repoId },
  );

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.edgeType] = toNumber(row.count);
  }
  return result;
}

export async function getEdgeCount(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     RETURN count(d) AS count`,
    { repoId },
  );
  return row ? toNumber(row.count) : 0;
}

export async function getCallEdgeResolutionCounts(
  conn: Connection,
  repoId: string,
): Promise<{
  totalCallEdges: number;
  resolvedCallEdges: number;
  exactCallEdges: number;
  resolvableCallEdges: number;
}> {
  const total = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     WHERE d.edgeType = 'call'
     RETURN count(d) AS count`,
    { repoId },
  );

  const resolved = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(t:Symbol)
     WHERE d.edgeType = 'call' AND NOT (t.symbolId STARTS WITH 'unresolved:')
     RETURN count(d) AS count`,
    { repoId },
  );

  const exact = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     WHERE d.edgeType = 'call' AND (d.resolution = 'exact' OR d.confidence >= 0.9)
     RETURN count(d) AS count`,
    { repoId },
  );

  // Count of call edges that target repo-internal symbols (resolvable)
  // Excludes edges targeting 'unresolved:call:' stubs (external/builtin calls)
  const resolvable = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(t:Symbol)
     WHERE d.edgeType = 'call' AND NOT (t.symbolId STARTS WITH 'unresolved:call:')
     RETURN count(d) AS count`,
    { repoId },
  );

  return {
    totalCallEdges: total ? toNumber(total.count) : 0,
    resolvedCallEdges: resolved ? toNumber(resolved.count) : 0,
    exactCallEdges: exact ? toNumber(exact.count) : 0,
    resolvableCallEdges: resolvable ? toNumber(resolvable.count) : 0,
  };
}
