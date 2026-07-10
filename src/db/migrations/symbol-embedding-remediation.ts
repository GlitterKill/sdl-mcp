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
