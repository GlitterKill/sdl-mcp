import { Buffer } from "node:buffer";
import {
  MAX_REPOSITORIES,
  MAX_STORE_BYTES,
  OVERFLOW_KEY,
  repositoryStorageKey,
  type Counter,
  type DurableLifetimeRepository,
  type DurableLifetimeRoot,
  type DurableLifetimeSections,
  type ProcessPeaks,
  type SampleTotal,
} from "./lifetime-types.js";

const CANONICAL_IDENTIFIER = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_DYNAMIC_KEYS = 32;
const MAX_LARGE_DYNAMIC_KEYS = 128;
const MAXIMUM_FIELDS = new Set([
  "retainedHandlesPeak",
  "projectedBytesMax",
  "projectedTokensMax",
]);
const DYNAMIC_MAP_FIELDS = new Set([
  "perSource",
  "byMode",
  "byType",
  "candidatesBySource",
  "phaseLatencyMs",
  "phaseCounts",
  "languageMs",
  "engineDispatch",
  "compressionBySource",
  "byStrategy",
  "perTool",
  "axisHits",
  "byEncoder",
  "detailCounts",
  "profileCounts",
]);
const MAXIMUM_TIMESTAMP = "9999-12-31T23:59:59.999999999+23:59";

export const DYNAMIC_MAP_LOCATIONS = [
  "cache.perSource",
  "retrieval.byMode",
  "retrieval.byType",
  "retrieval.candidatesBySource",
  "retrieval.phaseLatencyMs",
  "indexing.phaseCounts",
  "indexing.languageMs",
  "indexing.engineDispatch",
  "tokenEfficiency.compressionBySource",
  "predictiveContext.byStrategy",
  "latency.perTool",
  "packed.axisHits",
  "packed.byEncoder",
  "toolOutput.detailCounts",
  "toolOutput.profileCounts",
  "toolOutput.perTool",
  "toolOutput.perTool.detailCounts",
  "toolOutput.perTool.profileCounts",
] as const;

export type DynamicMapLocation = (typeof DYNAMIC_MAP_LOCATIONS)[number];

export interface SaturatingResult<T> {
  value: T;
  saturated: boolean;
}

export interface DynamicMapAdmission<T> {
  root: DurableLifetimeRoot;
  map: Record<string, T>;
  storageKey: string;
  admitted: boolean;
  status: "admitted" | "overflow" | "capacityRejected";
  reason: "storeBytes" | null;
  reservedBytes: number;
  saturated: boolean;
}

export interface RepositoryAdmission {
  root: DurableLifetimeRoot;
  storageKey: string;
  admitted: boolean;
  reason: "repositoryLimit" | "storeBytes" | null;
  reservedBytes: number;
}

function validateSafeValue(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Lifetime totals must be finite non-negative safe values");
  }
}

function validateCounter(value: number): void {
  validateSafeValue(value);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("Lifetime counters must be non-negative safe integers");
  }
}

function addSafeValues(a: number, b: number): SaturatingResult<number> {
  validateSafeValue(a);
  validateSafeValue(b);
  if (a > Number.MAX_SAFE_INTEGER - b) {
    return { value: Number.MAX_SAFE_INTEGER, saturated: true };
  }
  return { value: a + b, saturated: false };
}

export function saturatingAddWithSaturation(a: number, b: number): SaturatingResult<number> {
  validateCounter(a);
  validateCounter(b);
  return addSafeValues(a, b);
}

export function saturatingAdd(a: number, b: number): number {
  return saturatingAddWithSaturation(a, b).value;
}

export function mergeCounter(a: Counter, b: Counter): SaturatingResult<Counter> {
  return saturatingAddWithSaturation(a, b);
}

export function mergeSampleWithSaturation(
  a: SampleTotal,
  b: SampleTotal,
): SaturatingResult<SampleTotal> {
  validateCounter(a.count);
  validateCounter(b.count);
  validateSafeValue(a.sum);
  validateSafeValue(b.sum);
  validateSafeValue(a.max);
  validateSafeValue(b.max);
  const count = saturatingAddWithSaturation(a.count, b.count);
  const sum = addSafeValues(a.sum, b.sum);
  return {
    value: { count: count.value, sum: sum.value, max: Math.max(a.max, b.max) },
    saturated: count.saturated || sum.saturated,
  };
}

export function mergeSample(a: SampleTotal, b: SampleTotal): SampleTotal {
  return mergeSampleWithSaturation(a, b).value;
}

export function canonicalDynamicKey(rawIdentifier: string): string {
  return rawIdentifier !== OVERFLOW_KEY && CANONICAL_IDENTIFIER.test(rawIdentifier)
    ? `k:${rawIdentifier}`
    : OVERFLOW_KEY;
}

export function dynamicMapLimit(location: DynamicMapLocation): number {
  return location === "latency.perTool"
      || location === "toolOutput.perTool"
      || location === "packed.byEncoder"
    ? MAX_LARGE_DYNAMIC_KEYS
    : MAX_DYNAMIC_KEYS;
}

function orderedRecord<T>(value: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
}

export function normalizeDynamicMap<T>(value: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, structuredClone(value[key])]),
  );
}

export function admitDynamicMapEntry<T>(
  root: DurableLifetimeRoot,
  current: Readonly<Record<string, T>>,
  rawIdentifier: string,
  incoming: T,
  options: {
    location: DynamicMapLocation;
    merge: (a: T, b: T) => SaturatingResult<T>;
    replaceMap: (
      candidateRoot: DurableLifetimeRoot,
      candidateMap: Readonly<Record<string, T>>,
    ) => DurableLifetimeRoot;
  },
): DynamicMapAdmission<T> {
  const requestedKey = canonicalDynamicKey(rawIdentifier);
  const realKeyCount = Object.keys(current).filter((key) => key !== OVERFLOW_KEY).length;
  const isNewRealKey = requestedKey !== OVERFLOW_KEY && !Object.hasOwn(current, requestedKey);
  const storageKey = isNewRealKey && realKeyCount >= dynamicMapLimit(options.location)
    ? OVERFLOW_KEY
    : requestedKey;

  const mergeAt = (key: string): SaturatingResult<Record<string, T>> => {
    const next = { ...current };
    const existing = next[key];
    let saturated = false;
    if (existing === undefined) {
      next[key] = structuredClone(incoming);
    } else {
      const merged = options.merge(existing, incoming);
      next[key] = merged.value;
      saturated = merged.saturated;
    }
    return { value: normalizeDynamicMap(next), saturated };
  };

  const merged = mergeAt(storageKey);
  const candidateRoot = options.replaceMap(structuredClone(root), merged.value);
  const reservedBytes = reservedSerializedBytes(candidateRoot);
  // Only a new storage key grows the durable shape, so reject it against the
  // prospective root before exposing either the candidate map or root.
  if (!Object.hasOwn(current, storageKey) && reservedBytes > MAX_STORE_BYTES) {
    return {
      root,
      map: normalizeDynamicMap(current),
      storageKey,
      admitted: false,
      status: "capacityRejected",
      reason: "storeBytes",
      reservedBytes,
      saturated: false,
    };
  }

  return {
    root: candidateRoot,
    map: merged.value,
    storageKey,
    admitted: storageKey !== OVERFLOW_KEY,
    status: storageKey === OVERFLOW_KEY ? "overflow" : "admitted",
    reason: null,
    reservedBytes,
    saturated: merged.saturated,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSample(value: unknown): value is SampleTotal {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3
    && Object.hasOwn(value, "count")
    && Object.hasOwn(value, "sum")
    && Object.hasOwn(value, "max")
    && typeof value.count === "number"
    && typeof value.sum === "number"
    && typeof value.max === "number";
}

function mergeUnknown(
  left: unknown,
  right: unknown,
  fieldName = "",
): SaturatingResult<unknown> {
  if (left === null) return { value: structuredClone(right), saturated: false };
  if (right === null) return { value: structuredClone(left), saturated: false };
  if (isSample(left) && isSample(right)) return mergeSampleWithSaturation(left, right);
  if (typeof left === "number" && typeof right === "number") {
    validateCounter(left);
    validateCounter(right);
    return MAXIMUM_FIELDS.has(fieldName)
      ? { value: Math.max(left, right), saturated: false }
      : mergeCounter(left, right);
  }
  if (!isRecord(left) || !isRecord(right)) {
    return { value: structuredClone(right), saturated: false };
  }
  if (DYNAMIC_MAP_FIELDS.has(fieldName)) {
    const location = fieldName === "perTool"
      ? "latency.perTool"
      : fieldName === "byEncoder"
        ? "packed.byEncoder"
        : "retrieval.byMode";
    return mergeDynamicMaps(left, right, {
      location,
      merge: (a, b) => mergeUnknown(a, b),
    });
  }

  const result: Record<string, unknown> = {};
  let saturated = false;
  for (const key of [...Object.keys(left), ...Object.keys(right).filter((key) => !Object.hasOwn(left, key))]) {
    if (!Object.hasOwn(left, key)) {
      result[key] = structuredClone(right[key]);
      continue;
    }
    if (!Object.hasOwn(right, key)) {
      result[key] = structuredClone(left[key]);
      continue;
    }
    const merged = mergeUnknown(left[key], right[key], key);
    result[key] = merged.value;
    saturated ||= merged.saturated;
  }
  return { value: result, saturated };
}

export function mergeDynamicMaps<T>(
  left: Readonly<Record<string, T>>,
  right: Readonly<Record<string, T>>,
  options: {
    location: DynamicMapLocation;
    merge: (a: T, b: T) => SaturatingResult<T>;
  },
): SaturatingResult<Record<string, T>> {
  const combined: Record<string, T> = {};
  let saturated = false;
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    if (Object.hasOwn(left, key) && Object.hasOwn(right, key)) {
      const merged = options.merge(left[key], right[key]);
      combined[key] = merged.value;
      saturated ||= merged.saturated;
    } else {
      combined[key] = structuredClone(Object.hasOwn(right, key) ? right[key] : left[key]);
    }
  }

  const excess = Object.keys(combined)
    .filter((key) => key !== OVERFLOW_KEY)
    .sort()
    .slice(dynamicMapLimit(options.location));
  for (const key of excess) {
    const value = combined[key];
    const existingOverflow = combined[OVERFLOW_KEY];
    if (existingOverflow === undefined) {
      combined[OVERFLOW_KEY] = value;
    } else {
      const merged = options.merge(existingOverflow, value);
      combined[OVERFLOW_KEY] = merged.value;
      saturated ||= merged.saturated;
    }
    delete combined[key];
  }
  return { value: normalizeDynamicMap(combined), saturated };
}

export function emptyLifetimeSections(): DurableLifetimeSections {
  return {
    cache: null,
    retrieval: null,
    beam: null,
    delta: null,
    indexing: null,
    tokenEfficiency: null,
    predictiveContext: null,
    health: null,
    latency: null,
    pool: null,
    scip: null,
    packed: null,
    ppr: null,
    auditBuffer: null,
    postIndex: null,
    toolOutput: null,
    resources: null,
  };
}

export function emptyRepositoryLifetime(): DurableLifetimeRepository {
  return {
    epoch: 0,
    resetAt: null,
    lastCheckpointAt: null,
    sessionCount: 0,
    saturated: false,
    sections: emptyLifetimeSections(),
  };
}

export function mergeRepositoryLifetime(
  baseline: DurableLifetimeRepository,
  epoch: DurableLifetimeRepository,
): DurableLifetimeRepository {
  const sessionCount = mergeCounter(baseline.sessionCount, epoch.sessionCount);
  const sections = mergeUnknown(baseline.sections, epoch.sections) as SaturatingResult<DurableLifetimeSections>;
  return {
    epoch: Math.max(baseline.epoch, epoch.epoch),
    resetAt: epoch.resetAt ?? baseline.resetAt,
    lastCheckpointAt: epoch.lastCheckpointAt ?? baseline.lastCheckpointAt,
    sessionCount: sessionCount.value,
    saturated: baseline.saturated || epoch.saturated || sessionCount.saturated || sections.saturated,
    sections: sections.value,
  };
}

export function lifetimeView(
  baseline: DurableLifetimeRepository,
  epoch: DurableLifetimeRepository,
): DurableLifetimeRepository {
  return mergeRepositoryLifetime(baseline, epoch);
}

export function incrementSessionCount(
  repository: DurableLifetimeRepository,
  alreadyCounted = false,
): SaturatingResult<DurableLifetimeRepository> {
  if (alreadyCounted) {
    return { value: structuredClone(repository), saturated: repository.saturated };
  }
  const incremented = mergeCounter(repository.sessionCount, 1);
  return {
    value: {
      ...structuredClone(repository),
      sessionCount: incremented.value,
      saturated: repository.saturated || incremented.saturated,
    },
    saturated: repository.saturated || incremented.saturated,
  };
}

export function resetRepositoryLifetime(
  repository: DurableLifetimeRepository,
  resetAt: string,
): DurableLifetimeRepository {
  const epoch = mergeCounter(repository.epoch, 1);
  return {
    epoch: epoch.value,
    resetAt,
    lastCheckpointAt: resetAt,
    sessionCount: 0,
    saturated: epoch.saturated,
    sections: emptyLifetimeSections(),
  };
}

export function mergeProcessPeaks(
  baseline: ProcessPeaks | null,
  current: ProcessPeaks | null,
): ProcessPeaks | null {
  for (const peaks of [baseline, current]) {
    if (peaks === null) continue;
    validateSafeValue(peaks.cpuPct);
    validateSafeValue(peaks.rssMb);
    validateSafeValue(peaks.heapUsedMb);
    validateSafeValue(peaks.heapTotalMb);
    validateSafeValue(peaks.eventLoopLagMs);
  }
  if (baseline === null) return current === null ? null : structuredClone(current);
  if (current === null) return structuredClone(baseline);
  return {
    cpuPct: Math.max(baseline.cpuPct, current.cpuPct),
    rssMb: Math.max(baseline.rssMb, current.rssMb),
    heapUsedMb: Math.max(baseline.heapUsedMb, current.heapUsedMb),
    heapTotalMb: Math.max(baseline.heapTotalMb, current.heapTotalMb),
    eventLoopLagMs: Math.max(baseline.eventLoopLagMs, current.eventLoopLagMs),
  };
}

function maximumDynamicKey(index: number): string {
  const prefix = index.toString(36).padStart(4, "0");
  return `k:${prefix}${"x".repeat(60)}`;
}

function maximizeForReservation(value: unknown): unknown {
  if (typeof value === "number") return Number.MAX_SAFE_INTEGER;
  if (typeof value === "string") return MAXIMUM_TIMESTAMP;
  if (typeof value === "boolean") return false;
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  let dynamicIndex = 0;
  for (const [key, nested] of Object.entries(value)) {
    const reservedKey = key.startsWith("k:") ? maximumDynamicKey(dynamicIndex++) : key;
    result[reservedKey] = maximizeForReservation(nested);
  }
  return result;
}

export function reservedSerializedBytes(value: DurableLifetimeRoot): number {
  return Buffer.byteLength(JSON.stringify(maximizeForReservation(value)), "utf8");
}

export function admitRepository(
  root: DurableLifetimeRoot,
  repoId: string,
  repository: DurableLifetimeRepository,
): RepositoryAdmission {
  const storageKey = repositoryStorageKey(repoId);
  const existing = root.repositories[storageKey];
  if (existing === undefined && Object.keys(root.repositories).length >= MAX_REPOSITORIES) {
    return {
      root,
      storageKey,
      admitted: false,
      reason: "repositoryLimit",
      reservedBytes: reservedSerializedBytes(root),
    };
  }

  const nextRepository = existing === undefined
    ? structuredClone(repository)
    : mergeRepositoryLifetime(existing, repository);
  const repositories = orderedRecord({ ...root.repositories, [storageKey]: nextRepository });
  const candidate: DurableLifetimeRoot = {
    schemaVersion: root.schemaVersion,
    generation: root.generation,
    updatedAt: root.updatedAt,
    processPeaks: root.processPeaks === null ? null : structuredClone(root.processPeaks),
    repositories,
  };
  const reservedBytes = reservedSerializedBytes(candidate);
  if (reservedBytes > MAX_STORE_BYTES) {
    return { root, storageKey, admitted: false, reason: "storeBytes", reservedBytes };
  }
  return { root: candidate, storageKey, admitted: true, reason: null, reservedBytes };
}
