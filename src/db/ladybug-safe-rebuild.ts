import type { Connection } from "kuzu";

import {
  assertSafeInt,
  queryAll,
  querySingle,
  toNumber,
} from "./ladybug-core.js";

export interface SafeRebuildRepoMembershipCounts {
  physicalTotal: number;
  distinctTotal: number;
}

export interface SafeRebuildSymbolPointLookupSample {
  symbolIds: string[];
  invalidSymbolIds: string[];
  scannedTotal: number;
  mismatchTotal: number;
  mismatches: Array<{
    symbolId: string;
    fields: string[];
  }>;
}

const SAFE_REBUILD_SYMBOL_POINT_LOOKUP_PAGE_SIZE = 2_048;
const SAFE_REBUILD_SYMBOL_POINT_LOOKUP_BATCH_SIZE = 64;
export const SAFE_REBUILD_SYMBOL_STRING_FIELDS = [
  "symbolId",
  "repoId",
  "kind",
  "name",
  "visibility",
  "language",
  "astFingerprint",
  "signatureJson",
  "summary",
  "summarySource",
  "invariantsJson",
  "sideEffectsJson",
  "roleTagsJson",
  "searchText",
  "updatedAt",
  "embeddingMiniLM",
  "embeddingMiniLMCardHash",
  "embeddingMiniLMUpdatedAt",
  "embeddingNomic",
  "embeddingNomicCardHash",
  "embeddingNomicUpdatedAt",
  "embeddingJinaCode",
  "embeddingJinaCodeCardHash",
  "embeddingJinaCodeUpdatedAt",
  "scipSymbol",
  "source",
  "packageName",
  "packageVersion",
  "symbolStatus",
  "placeholderKind",
  "placeholderTarget",
] as const;

type SafeRebuildSymbolStringField =
  (typeof SAFE_REBUILD_SYMBOL_STRING_FIELDS)[number];
type SafeRebuildSymbolStringProjection = Record<
  SafeRebuildSymbolStringField,
  string | null
>;
type SafeRebuildSymbolStringProjectionWithId =
  SafeRebuildSymbolStringProjection & { symbolId: string };

function hasSafeRebuildSymbolId(
  row: SafeRebuildSymbolStringProjection,
): row is SafeRebuildSymbolStringProjectionWithId {
  return typeof row.symbolId === "string" && row.symbolId.length > 0;
}

export async function readSafeRebuildRepoMembershipCounts(
  conn: Connection,
  repoId: string,
): Promise<SafeRebuildRepoMembershipCounts> {
  const row = await querySingle<{
    physicalTotal: unknown;
    distinctTotal: unknown;
  }>(
    conn,
    `MATCH (:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     RETURN count(s) AS physicalTotal,
            count(DISTINCT s.symbolId) AS distinctTotal`,
    { repoId },
  );
  return {
    physicalTotal: toNumber(row?.physicalTotal ?? 0),
    distinctTotal: toNumber(row?.distinctTotal ?? 0),
  };
}

async function readSafeRebuildSymbolScanPage(
  conn: Connection,
  afterSymbolId: string | undefined,
): Promise<SafeRebuildSymbolStringProjection[]> {
  const projection = `s.symbolId AS symbolId,
            s.repoId AS repoId,
            s.kind AS kind,
            s.name AS name,
            s.visibility AS visibility,
            s.language AS language,
            s.astFingerprint AS astFingerprint,
            s.signatureJson AS signatureJson,
            s.summary AS summary,
            s.summarySource AS summarySource,
            s.invariantsJson AS invariantsJson,
            s.sideEffectsJson AS sideEffectsJson,
            s.roleTagsJson AS roleTagsJson,
            s.searchText AS searchText,
            s.updatedAt AS updatedAt,
            s.embeddingMiniLM AS embeddingMiniLM,
            s.embeddingMiniLMCardHash AS embeddingMiniLMCardHash,
            s.embeddingMiniLMUpdatedAt AS embeddingMiniLMUpdatedAt,
            s.embeddingNomic AS embeddingNomic,
            s.embeddingNomicCardHash AS embeddingNomicCardHash,
            s.embeddingNomicUpdatedAt AS embeddingNomicUpdatedAt,
            s.embeddingJinaCode AS embeddingJinaCode,
            s.embeddingJinaCodeCardHash AS embeddingJinaCodeCardHash,
            s.embeddingJinaCodeUpdatedAt AS embeddingJinaCodeUpdatedAt,
            s.scipSymbol AS scipSymbol,
            s.source AS source,
            s.packageName AS packageName,
            s.packageVersion AS packageVersion,
            s.symbolStatus AS symbolStatus,
            s.placeholderKind AS placeholderKind,
            s.placeholderTarget AS placeholderTarget`;
  if (afterSymbolId === undefined) {
    return queryAll<SafeRebuildSymbolStringProjection>(
      conn,
      `MATCH (s:Symbol)
       RETURN ${projection}
       ORDER BY s.symbolId
       LIMIT $limit`,
      { limit: SAFE_REBUILD_SYMBOL_POINT_LOOKUP_PAGE_SIZE },
    );
  }
  return queryAll<SafeRebuildSymbolStringProjection>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolId > $afterSymbolId
     RETURN ${projection}
     ORDER BY s.symbolId
     LIMIT $limit`,
    {
      afterSymbolId,
      limit: SAFE_REBUILD_SYMBOL_POINT_LOOKUP_PAGE_SIZE,
    },
  );
}

type SafeRebuildSymbolPointProjection =
  SafeRebuildSymbolStringProjection & {
    ordinal: unknown;
    requestedSymbolId: string;
  };
interface SafeRebuildSymbolPointBatch {
  rowsByOrdinal: Map<number, SafeRebuildSymbolPointProjection>;
  copiesByOrdinal: Map<number, number>;
}

async function readSafeRebuildSymbolsByPrimaryKey(
  conn: Connection,
  symbolIds: readonly string[],
): Promise<SafeRebuildSymbolPointBatch> {
  const statement = symbolIds
    .map(
      (_symbolId, ordinal) =>
        `MATCH (s:Symbol {symbolId: $symbolId${ordinal}})
         RETURN ${ordinal} AS ordinal,
                $symbolId${ordinal} AS requestedSymbolId,
                s.symbolId AS symbolId,
                s.repoId AS repoId,
                s.kind AS kind,
                s.name AS name,
                s.visibility AS visibility,
                s.language AS language,
                s.astFingerprint AS astFingerprint,
                s.signatureJson AS signatureJson,
                s.summary AS summary,
                s.summarySource AS summarySource,
                s.invariantsJson AS invariantsJson,
                s.sideEffectsJson AS sideEffectsJson,
                s.roleTagsJson AS roleTagsJson,
                s.searchText AS searchText,
                s.updatedAt AS updatedAt,
                s.embeddingMiniLM AS embeddingMiniLM,
                s.embeddingMiniLMCardHash AS embeddingMiniLMCardHash,
                s.embeddingMiniLMUpdatedAt AS embeddingMiniLMUpdatedAt,
                s.embeddingNomic AS embeddingNomic,
                s.embeddingNomicCardHash AS embeddingNomicCardHash,
                s.embeddingNomicUpdatedAt AS embeddingNomicUpdatedAt,
                s.embeddingJinaCode AS embeddingJinaCode,
                s.embeddingJinaCodeCardHash AS embeddingJinaCodeCardHash,
                s.embeddingJinaCodeUpdatedAt AS embeddingJinaCodeUpdatedAt,
                s.scipSymbol AS scipSymbol,
                s.source AS source,
                s.packageName AS packageName,
                s.packageVersion AS packageVersion,
                s.symbolStatus AS symbolStatus,
                s.placeholderKind AS placeholderKind,
                s.placeholderTarget AS placeholderTarget`,
    )
    .join("\nUNION ALL\n");
  const params = Object.fromEntries(
    symbolIds.map((symbolId, ordinal) => [`symbolId${ordinal}`, symbolId]),
  );
  const rows = await queryAll<SafeRebuildSymbolPointProjection>(
    conn,
    statement,
    params,
  );
  const rowsByOrdinal = new Map<number, SafeRebuildSymbolPointProjection>();
  const copiesByOrdinal = new Map<number, number>();
  for (const row of rows) {
    const ordinal = toNumber(row.ordinal);
    copiesByOrdinal.set(ordinal, (copiesByOrdinal.get(ordinal) ?? 0) + 1);
    if (!rowsByOrdinal.has(ordinal)) rowsByOrdinal.set(ordinal, row);
  }
  return { rowsByOrdinal, copiesByOrdinal };
}

export async function readSafeRebuildSymbolPointLookupSample(
  conn: Connection,
  limit = 20,
): Promise<SafeRebuildSymbolPointLookupSample> {
  assertSafeInt(limit, "safe rebuild Symbol sample limit");
  const boundedLimit = Math.max(1, Math.min(100, limit));
  const symbolIds: string[] = [];
  const mismatches: SafeRebuildSymbolPointLookupSample["mismatches"] = [];
  let scannedTotal = 0;
  let mismatchTotal = 0;
  let afterSymbolId: string | undefined;

  while (true) {
    const page = await readSafeRebuildSymbolScanPage(conn, afterSymbolId);
    if (page.length === 0) break;

    const validRows: SafeRebuildSymbolStringProjectionWithId[] = [];
    for (const scanned of page) {
      scannedTotal += 1;
      if (!hasSafeRebuildSymbolId(scanned)) {
        mismatchTotal += 1;
        if (mismatches.length < boundedLimit) {
          mismatches.push({
            symbolId: `<invalid-scan-row-${scannedTotal}>`,
            fields: ["symbolId", "pointLookup"],
          });
        }
        continue;
      }
      const symbolId = scanned.symbolId;
      if (symbolIds.length < boundedLimit) symbolIds.push(symbolId);
      validRows.push(scanned);
    }

    // Each UNION branch retains its own scalar primary-key parameter. On
    // LadybugDB 0.18.1, UNWIND/list-derived matches use a table scan and can
    // falsely agree with the corrupt scan vector this gate is meant to catch.
    for (
      let offset = 0;
      offset < validRows.length;
      offset += SAFE_REBUILD_SYMBOL_POINT_LOOKUP_BATCH_SIZE
    ) {
      const batch = validRows.slice(
        offset,
        offset + SAFE_REBUILD_SYMBOL_POINT_LOOKUP_BATCH_SIZE,
      );
      const points = await readSafeRebuildSymbolsByPrimaryKey(
        conn,
        batch.map((row) => row.symbolId),
      );
      for (const [ordinal, scanned] of batch.entries()) {
        const point = points.rowsByOrdinal.get(ordinal);
        const copies = points.copiesByOrdinal.get(ordinal) ?? 0;
        const fields: string[] = [];
        if (copies !== 1) {
          fields.push("pointLookupCopies");
        }
        if (!point) {
          fields.push("pointLookup");
        } else {
          if (point.requestedSymbolId !== scanned.symbolId) {
            fields.push("requestedSymbolId");
          }
          fields.push(
            ...SAFE_REBUILD_SYMBOL_STRING_FIELDS.filter(
              (field) => !Object.is(scanned[field], point[field]),
            ),
          );
        }
        if (fields.length > 0) {
          mismatchTotal += 1;
          if (mismatches.length < boundedLimit) {
            mismatches.push({
              symbolId: scanned.symbolId,
              fields,
            });
          }
        }
      }
    }

    // One mismatch is enough to reject the candidate. Finish the current page
    // so the diagnostic names related corrupt rows, then stop expensive probes.
    if (mismatchTotal > 0) break;
    if (page.length < SAFE_REBUILD_SYMBOL_POINT_LOOKUP_PAGE_SIZE) break;
    const nextAfter = page.at(-1)?.symbolId;
    if (
      typeof nextAfter !== "string" ||
      nextAfter.length === 0 ||
      nextAfter === afterSymbolId
    ) {
      mismatchTotal += 1;
      if (mismatches.length < boundedLimit) {
        mismatches.push({
          symbolId: `<invalid-page-boundary-${scannedTotal}>`,
          fields: ["symbolId", "pagination"],
        });
      }
      break;
    }
    afterSymbolId = nextAfter;
  }

  return {
    symbolIds,
    invalidSymbolIds: mismatches.map((mismatch) => mismatch.symbolId),
    scannedTotal,
    mismatchTotal,
    mismatches,
  };
}

/**
 * Force LadybugDB to evaluate LOWER() over every canonical Symbol string
 * column. A corrupt string dictionary/column fails the scan instead of being
 * discovered later by an agent-facing search.
 */
export async function validateSafeRebuildCanonicalStrings(
  conn: Connection,
): Promise<void> {
  await querySingle<Record<string, unknown>>(
    conn,
    `MATCH (s:Symbol)
     RETURN sum(size(LOWER(coalesce(s.symbolId, '')))) AS symbolIdBytes,
            sum(size(LOWER(coalesce(s.repoId, '')))) AS repoIdBytes,
            sum(size(LOWER(coalesce(s.kind, '')))) AS kindBytes,
            sum(size(LOWER(coalesce(s.name, '')))) AS nameBytes,
            sum(size(LOWER(coalesce(s.visibility, '')))) AS visibilityBytes,
            sum(size(LOWER(coalesce(s.language, '')))) AS languageBytes,
            sum(size(LOWER(coalesce(s.astFingerprint, '')))) AS fingerprintBytes,
            sum(size(LOWER(coalesce(s.signatureJson, '')))) AS signatureBytes,
            sum(size(LOWER(coalesce(s.summary, '')))) AS summaryBytes,
            sum(size(LOWER(coalesce(s.summarySource, '')))) AS summarySourceBytes,
            sum(size(LOWER(coalesce(s.invariantsJson, '')))) AS invariantsBytes,
            sum(size(LOWER(coalesce(s.sideEffectsJson, '')))) AS sideEffectsBytes,
            sum(size(LOWER(coalesce(s.roleTagsJson, '')))) AS roleTagsBytes,
            sum(size(LOWER(coalesce(s.searchText, '')))) AS searchTextBytes,
            sum(size(LOWER(coalesce(s.updatedAt, '')))) AS updatedAtBytes,
            sum(size(LOWER(coalesce(s.embeddingMiniLM, '')))) AS embeddingMiniLMBytes,
            sum(size(LOWER(coalesce(s.embeddingMiniLMCardHash, '')))) AS embeddingMiniLMCardHashBytes,
            sum(size(LOWER(coalesce(s.embeddingMiniLMUpdatedAt, '')))) AS embeddingMiniLMUpdatedAtBytes,
            sum(size(LOWER(coalesce(s.embeddingNomic, '')))) AS embeddingNomicBytes,
            sum(size(LOWER(coalesce(s.embeddingNomicCardHash, '')))) AS embeddingNomicCardHashBytes,
            sum(size(LOWER(coalesce(s.embeddingNomicUpdatedAt, '')))) AS embeddingNomicUpdatedAtBytes,
            sum(size(LOWER(coalesce(s.embeddingJinaCode, '')))) AS embeddingJinaCodeBytes,
            sum(size(LOWER(coalesce(s.embeddingJinaCodeCardHash, '')))) AS embeddingJinaCodeCardHashBytes,
            sum(size(LOWER(coalesce(s.embeddingJinaCodeUpdatedAt, '')))) AS embeddingJinaCodeUpdatedAtBytes,
            sum(size(LOWER(coalesce(s.scipSymbol, '')))) AS scipSymbolBytes,
            sum(size(LOWER(coalesce(s.source, '')))) AS sourceBytes,
            sum(size(LOWER(coalesce(s.packageName, '')))) AS packageNameBytes,
            sum(size(LOWER(coalesce(s.packageVersion, '')))) AS packageVersionBytes,
            sum(size(LOWER(coalesce(s.symbolStatus, '')))) AS statusBytes,
            sum(size(LOWER(coalesce(s.placeholderKind, '')))) AS placeholderKindBytes,
            sum(size(LOWER(coalesce(s.placeholderTarget, '')))) AS placeholderTargetBytes`,
  );
}

export async function countInvalidSafeRebuildDependencyEndpoints(
  conn: Connection,
): Promise<number> {
  const row = await querySingle<{ invalidEndpoints: unknown }>(
    conn,
    `MATCH (a:Symbol)-[:DEPENDS_ON]->(b:Symbol)
     WHERE size(coalesce(a.symbolId, '')) = 0
        OR size(coalesce(b.symbolId, '')) = 0
     RETURN count(*) AS invalidEndpoints`,
  );
  return toNumber(row?.invalidEndpoints ?? 0);
}
