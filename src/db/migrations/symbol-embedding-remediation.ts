import type { Connection } from "kuzu";

import {
  exec,
  isConnectionPoisoned,
  queryAll,
  withTransaction,
} from "../ladybug-core.js";
import { DatabaseError } from "../../domain/errors.js";
import { logger } from "../../util/logger.js";
import { resolveLadybugWriteChunkSize } from "../ladybug-batching.js";

export type LegacyEmbeddingModel =
  | "all-MiniLM-L6-v2"
  | "nomic-embed-text-v1.5";

interface EmbeddingLane {
  model: LegacyEmbeddingModel;
  dimension: number;
  vectorProperty: "embeddingMiniLM" | "embeddingNomic";
  hashProperty: "embeddingMiniLMCardHash" | "embeddingNomicCardHash";
  updatedAtProperty: "embeddingMiniLMUpdatedAt" | "embeddingNomicUpdatedAt";
}

const LANES: Readonly<Record<LegacyEmbeddingModel, EmbeddingLane>> = {
  "all-MiniLM-L6-v2": {
    model: "all-MiniLM-L6-v2",
    dimension: 384,
    vectorProperty: "embeddingMiniLM",
    hashProperty: "embeddingMiniLMCardHash",
    updatedAtProperty: "embeddingMiniLMUpdatedAt",
  },
  "nomic-embed-text-v1.5": {
    model: "nomic-embed-text-v1.5",
    dimension: 768,
    vectorProperty: "embeddingNomic",
    hashProperty: "embeddingNomicCardHash",
    updatedAtProperty: "embeddingNomicUpdatedAt",
  },
};

export interface LegacyEmbeddingRow {
  symbolId: string | null;
  model: string | null;
  embeddingVector: string | null;
  version: string | null;
  cardHash: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface LegacyEmbeddingFingerprint {
  symbolId: string;
  model: LegacyEmbeddingModel;
  embeddingVector: string;
  version: string | null;
  cardHash: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DestinationEmbeddingFingerprint {
  symbolId: string;
  vector: string | null;
  cardHash: string | null;
  updatedAt: string | null;
}

export type RemediationDecision =
  | {
      kind: "copy";
      source: LegacyEmbeddingFingerprint;
      destination: DestinationEmbeddingFingerprint;
    }
  | {
      kind: "alreadyCurrent";
      source: LegacyEmbeddingFingerprint;
      destination: DestinationEmbeddingFingerprint;
    }
  | {
      kind: "retain";
      reason:
        | "conflict"
        | "orphan"
        | "malformed"
        | "mock"
        | "unknownModel"
        | "duplicateQueryResult";
    };

function isLegacyEmbeddingModel(
  model: string | null,
): model is LegacyEmbeddingModel {
  return model === "all-MiniLM-L6-v2" || model === "nomic-embed-text-v1.5";
}

export function decodeStoredEmbeddingVector(
  raw: string | null,
  model: LegacyEmbeddingModel,
): number[] | null {
  if (typeof raw !== "string") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const dimension = LANES[model].dimension;
  if (
    !Array.isArray(parsed) ||
    parsed.length !== dimension ||
    !parsed.every(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    )
  ) {
    return null;
  }

  return parsed;
}

export function storedEmbeddingVectorsEqual(
  left: string | null,
  right: string | null,
  model: LegacyEmbeddingModel,
): boolean {
  const decodedLeft = decodeStoredEmbeddingVector(left, model);
  const decodedRight = decodeStoredEmbeddingVector(right, model);

  return (
    decodedLeft !== null &&
    decodedRight !== null &&
    decodedLeft.every((value, index) => Object.is(value, decodedRight[index]))
  );
}

export function findDuplicateSymbolIds(
  rows: readonly { symbolId: string | null }[],
): ReadonlySet<string> {
  // Count first so no duplicate query row is classified safely in isolation.
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.symbolId) {
      counts.set(row.symbolId, (counts.get(row.symbolId) ?? 0) + 1);
    }
  }

  return new Set(
    [...counts]
      .filter(([, count]) => count > 1)
      .map(([symbolId]) => symbolId),
  );
}

export function classifyLegacyEmbeddingRow(
  row: LegacyEmbeddingRow,
  destination: DestinationEmbeddingFingerprint | null,
  duplicateSymbolIds: ReadonlySet<string>,
): RemediationDecision {
  if (!row.symbolId) {
    return { kind: "retain", reason: "malformed" };
  }
  if (duplicateSymbolIds.has(row.symbolId)) {
    return { kind: "retain", reason: "duplicateQueryResult" };
  }
  if (row.model === "mock-fallback") {
    return { kind: "retain", reason: "mock" };
  }
  if (!isLegacyEmbeddingModel(row.model)) {
    return { kind: "retain", reason: "unknownModel" };
  }
  if (
    row.embeddingVector === null ||
    decodeStoredEmbeddingVector(row.embeddingVector, row.model) === null
  ) {
    return { kind: "retain", reason: "malformed" };
  }
  if (destination === null) {
    return { kind: "retain", reason: "orphan" };
  }
  if (destination.symbolId !== row.symbolId) {
    return { kind: "retain", reason: "orphan" };
  }

  const source: LegacyEmbeddingFingerprint = {
    symbolId: row.symbolId,
    model: row.model,
    embeddingVector: row.embeddingVector,
    version: row.version,
    cardHash: row.cardHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  const laneIsEmpty =
    destination.vector === null &&
    destination.cardHash === null &&
    destination.updatedAt === null;
  if (laneIsEmpty) {
    return { kind: "copy", source, destination };
  }

  const laneIsCurrent =
    storedEmbeddingVectorsEqual(
      source.embeddingVector,
      destination.vector,
      source.model,
    ) &&
    (source.cardHash ?? null) === (destination.cardHash ?? null) &&
    (source.updatedAt ?? null) === (destination.updatedAt ?? null);
  if (laneIsCurrent) {
    return { kind: "alreadyCurrent", source, destination };
  }

  return { kind: "retain", reason: "conflict" };
}


type RetainReason = Extract<
  RemediationDecision,
  { kind: "retain" }
>["reason"];

export interface SymbolEmbeddingRemediationSummary {
  scanned: number;
  copied: number;
  alreadyCurrent: number;
  deleted: number;
  retained: Record<RetainReason, number>;
}

interface DestinationLaneRow {
  symbolId: string;
  embeddingMiniLM: string | null;
  embeddingMiniLMCardHash: string | null;
  embeddingMiniLMUpdatedAt: string | null;
  embeddingNomic: string | null;
  embeddingNomicCardHash: string | null;
  embeddingNomicUpdatedAt: string | null;
}

interface DeletionCandidate {
  source: LegacyEmbeddingFingerprint;
  destination: DestinationEmbeddingFingerprint;
}

interface DeletionFingerprintRow extends LegacyEmbeddingFingerprint {
  destinationVector: string;
  destinationCardHash: string | null;
  destinationUpdatedAt: string | null;
}

const LANE_ORDER = [
  LANES["all-MiniLM-L6-v2"],
  LANES["nomic-embed-text-v1.5"],
] as const;

function createRemediationSummary(): SymbolEmbeddingRemediationSummary {
  return {
    scanned: 0,
    copied: 0,
    alreadyCurrent: 0,
    deleted: 0,
    retained: {
      conflict: 0,
      duplicateQueryResult: 0,
      malformed: 0,
      mock: 0,
      orphan: 0,
      unknownModel: 0,
    },
  };
}

function logRemediationSummary(
  migrationLabel: string,
  summary: SymbolEmbeddingRemediationSummary,
): void {
  logger.info(`${migrationLabel}: SymbolEmbedding remediation complete`, {
    migrationLabel,
    scanned: summary.scanned,
    copied: summary.copied,
    alreadyCurrent: summary.alreadyCurrent,
    deleted: summary.deleted,
    retained: Object.entries(summary.retained).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  });
}

function isMissingSymbolEmbeddingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Table SymbolEmbedding does not exist") ||
    message.includes("Node table SymbolEmbedding does not exist")
  );
}

function destinationFingerprintFor(
  row: LegacyEmbeddingRow,
  destinations: ReadonlyMap<string, DestinationLaneRow>,
): DestinationEmbeddingFingerprint | null {
  if (!row.symbolId || !isLegacyEmbeddingModel(row.model)) return null;

  const destination = destinations.get(row.symbolId);
  if (!destination) return null;

  const lane = LANES[row.model];
  return {
    symbolId: destination.symbolId,
    vector: destination[lane.vectorProperty],
    cardHash: destination[lane.hashProperty],
    updatedAt: destination[lane.updatedAtProperty],
  };
}

function deletionFingerprint(
  candidate: DeletionCandidate,
): DeletionFingerprintRow {
  const destinationVector = candidate.destination.vector;
  if (destinationVector === null) {
    throw new DatabaseError(
      "Cannot delete SymbolEmbedding row without a verified destination vector",
    );
  }

  return {
    ...candidate.source,
    destinationVector,
    destinationCardHash: candidate.destination.cardHash,
    destinationUpdatedAt: candidate.destination.updatedAt,
  };
}

function copyQuery(lane: EmbeddingLane): string {
  return `UNWIND $rows AS r
MATCH (se:SymbolEmbedding {symbolId: r.symbolId})
MATCH (s:Symbol {symbolId: r.symbolId})
WHERE se.model = r.model
  AND se.embeddingVector = r.embeddingVector
  AND ((se.version = r.version) OR (se.version IS NULL AND r.version IS NULL))
  AND ((se.cardHash = r.cardHash) OR (se.cardHash IS NULL AND r.cardHash IS NULL))
  AND ((se.createdAt = r.createdAt) OR (se.createdAt IS NULL AND r.createdAt IS NULL))
  AND ((se.updatedAt = r.updatedAt) OR (se.updatedAt IS NULL AND r.updatedAt IS NULL))
  AND s.${lane.vectorProperty} IS NULL
  AND s.${lane.hashProperty} IS NULL
  AND s.${lane.updatedAtProperty} IS NULL
SET s.${lane.vectorProperty} = r.embeddingVector,
    s.${lane.hashProperty} = r.cardHash,
    s.${lane.updatedAtProperty} = r.updatedAt
RETURN r.symbolId AS symbolId,
       s.${lane.vectorProperty} AS vector,
       s.${lane.hashProperty} AS cardHash,
       s.${lane.updatedAtProperty} AS updatedAt
ORDER BY symbolId`;
}

function deletionVerifyQuery(lane: EmbeddingLane): string {
  return `UNWIND $rows AS r
MATCH (se:SymbolEmbedding {symbolId: r.symbolId})
MATCH (s:Symbol {symbolId: r.symbolId})
WHERE se.model = r.model
  AND se.embeddingVector = r.embeddingVector
  AND ((se.version = r.version) OR (se.version IS NULL AND r.version IS NULL))
  AND ((se.cardHash = r.cardHash) OR (se.cardHash IS NULL AND r.cardHash IS NULL))
  AND ((se.createdAt = r.createdAt) OR (se.createdAt IS NULL AND r.createdAt IS NULL))
  AND ((se.updatedAt = r.updatedAt) OR (se.updatedAt IS NULL AND r.updatedAt IS NULL))
  AND s.${lane.vectorProperty} = r.destinationVector
  AND ((s.${lane.hashProperty} = r.destinationCardHash)
       OR (s.${lane.hashProperty} IS NULL AND r.destinationCardHash IS NULL))
  AND ((s.${lane.updatedAtProperty} = r.destinationUpdatedAt)
       OR (s.${lane.updatedAtProperty} IS NULL AND r.destinationUpdatedAt IS NULL))
RETURN se.symbolId AS symbolId,
       se.model AS model,
       se.embeddingVector AS embeddingVector,
       se.version AS version,
       se.cardHash AS cardHash,
       se.createdAt AS createdAt,
       se.updatedAt AS updatedAt,
       s.${lane.vectorProperty} AS destinationVector,
       s.${lane.hashProperty} AS destinationCardHash,
       s.${lane.updatedAtProperty} AS destinationUpdatedAt
ORDER BY symbolId`;
}

function deletionQuery(lane: EmbeddingLane): string {
  return `UNWIND $rows AS r
MATCH (se:SymbolEmbedding {symbolId: r.symbolId})
MATCH (s:Symbol {symbolId: r.symbolId})
WHERE se.model = r.model
  AND se.embeddingVector = r.embeddingVector
  AND ((se.version = r.version) OR (se.version IS NULL AND r.version IS NULL))
  AND ((se.cardHash = r.cardHash) OR (se.cardHash IS NULL AND r.cardHash IS NULL))
  AND ((se.createdAt = r.createdAt) OR (se.createdAt IS NULL AND r.createdAt IS NULL))
  AND ((se.updatedAt = r.updatedAt) OR (se.updatedAt IS NULL AND r.updatedAt IS NULL))
  AND s.${lane.vectorProperty} = r.destinationVector
  AND ((s.${lane.hashProperty} = r.destinationCardHash)
       OR (s.${lane.hashProperty} IS NULL AND r.destinationCardHash IS NULL))
  AND ((s.${lane.updatedAtProperty} = r.destinationUpdatedAt)
       OR (s.${lane.updatedAtProperty} IS NULL AND r.destinationUpdatedAt IS NULL))
DELETE se`;
}

export async function remediateSymbolEmbeddings(
  conn: Connection,
  migrationLabel: string,
): Promise<SymbolEmbeddingRemediationSummary> {
  const chunkSize = resolveLadybugWriteChunkSize("embeddingMigrations");
  const summary = createRemediationSummary();
  let deletionCandidates: DeletionCandidate[];

  try {
    deletionCandidates = await withTransaction(conn, async (txConn) => {
      const rows = await queryAll<LegacyEmbeddingRow>(
        txConn,
        `MATCH (se:SymbolEmbedding)
         RETURN se.symbolId AS symbolId,
                se.model AS model,
                se.embeddingVector AS embeddingVector,
                se.version AS version,
                se.cardHash AS cardHash,
                se.createdAt AS createdAt,
                se.updatedAt AS updatedAt
         ORDER BY se.symbolId, se.model`,
      );
      summary.scanned = rows.length;

      const symbolIds = [
        ...new Set(
          rows
            .map(({ symbolId }) => symbolId)
            .filter((symbolId): symbolId is string => Boolean(symbolId)),
        ),
      ].sort();
      const destinationRows: DestinationLaneRow[] = [];
      for (let offset = 0; offset < symbolIds.length; offset += chunkSize) {
        destinationRows.push(
          ...(await queryAll<DestinationLaneRow>(
            txConn,
            `UNWIND $symbolIds AS symbolId
             MATCH (s:Symbol)
             WHERE s.symbolId = symbolId
             RETURN s.symbolId AS symbolId,
                    s.embeddingMiniLM AS embeddingMiniLM,
                    s.embeddingMiniLMCardHash AS embeddingMiniLMCardHash,
                    s.embeddingMiniLMUpdatedAt AS embeddingMiniLMUpdatedAt,
                    s.embeddingNomic AS embeddingNomic,
                    s.embeddingNomicCardHash AS embeddingNomicCardHash,
                    s.embeddingNomicUpdatedAt AS embeddingNomicUpdatedAt
             ORDER BY symbolId`,
            { symbolIds: symbolIds.slice(offset, offset + chunkSize) },
          )),
        );
      }

      const destinations = new Map(
        destinationRows.map((destination) => [
          destination.symbolId,
          destination,
        ]),
      );
      const duplicateIds = findDuplicateSymbolIds(rows);
      const copyCandidates = new Map<LegacyEmbeddingModel, LegacyEmbeddingFingerprint[]>(
        LANE_ORDER.map(({ model }) => [model, []]),
      );
      const candidates: DeletionCandidate[] = [];

      for (const row of rows) {
        const decision = classifyLegacyEmbeddingRow(
          row,
          destinationFingerprintFor(row, destinations),
          duplicateIds,
        );
        if (decision.kind === "retain") {
          summary.retained[decision.reason]++;
        } else if (decision.kind === "alreadyCurrent") {
          summary.alreadyCurrent++;
          candidates.push(decision);
        } else {
          copyCandidates.get(decision.source.model)?.push(decision.source);
        }
      }

      for (const lane of LANE_ORDER) {
        const laneCandidates = copyCandidates.get(lane.model) ?? [];
        for (
          let offset = 0;
          offset < laneCandidates.length;
          offset += chunkSize
        ) {
          const batch = laneCandidates.slice(offset, offset + chunkSize);
          const copiedRows = await queryAll<DestinationEmbeddingFingerprint>(
            txConn,
            copyQuery(lane),
            { rows: batch },
          );
          const sourceById = new Map(
            batch.map((source) => [source.symbolId, source]),
          );
          for (const destination of copiedRows) {
            const source = sourceById.get(destination.symbolId);
            if (source) candidates.push({ source, destination });
          }
          summary.copied += copiedRows.length;
        }
      }

      return candidates;
    });
  } catch (error) {
    if (
      isConnectionPoisoned(conn) ||
      !isMissingSymbolEmbeddingTable(error)
    ) {
      throw error;
    }
    logRemediationSummary(migrationLabel, summary);
    return summary;
  }

  if (deletionCandidates.length > 0) {
    await withTransaction(conn, async (txConn) => {
      for (const lane of LANE_ORDER) {
        const laneCandidates = deletionCandidates
          .filter(({ source }) => source.model === lane.model)
          .sort((left, right) =>
            left.source.symbolId.localeCompare(right.source.symbolId),
          )
          .map(deletionFingerprint);

        for (
          let offset = 0;
          offset < laneCandidates.length;
          offset += chunkSize
        ) {
          const batch = laneCandidates.slice(offset, offset + chunkSize);
          const verified = await queryAll<DeletionFingerprintRow>(
            txConn,
            deletionVerifyQuery(lane),
            { rows: batch },
          );
          if (verified.length === 0) continue;

          await exec(txConn, deletionQuery(lane), { rows: verified });
          summary.deleted += verified.length;
        }
      }
    });
  }

  logRemediationSummary(migrationLabel, summary);
  return summary;
}
