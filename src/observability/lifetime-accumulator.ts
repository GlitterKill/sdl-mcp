import { Buffer } from "node:buffer";
import {
  MAX_REPOSITORIES,
  MAX_STORE_BYTES,
  OVERFLOW_KEY,
  parseDurableLifetimeRoot,
  repositoryStorageKey,
  type Counter,
  type DurableLifetimeRepository,
  type DurableLifetimeRoot,
  type DurableLifetimeSections,
  type ProcessPeaks,
  type SampleTotal,
} from "./lifetime-types.js";

const CANONICAL_IDENTIFIER = /^[A-Za-z0-9._:-]{1,64}$/;
const CANONICAL_STORAGE_KEY = /^k:[A-Za-z0-9._:-]{1,64}$/;
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
// JSON numbers need at most 24 characters in this domain; quotes make this
// reservation-only string a deterministic, conservative 34-byte stand-in.
const MAXIMUM_NUMERIC_JSON_PLACEHOLDER = "0".repeat(32);
const VALIDATION_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const VALIDATION_REPOSITORY_KEY = repositoryStorageKey("lifetime-accumulator-validation");

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
export type NestedDynamicMapLocation =
  | "toolOutput.perTool.detailCounts"
  | "toolOutput.perTool.profileCounts";
export type FlatDynamicMapLocation = Exclude<DynamicMapLocation, NestedDynamicMapLocation>;
export type DynamicMapTarget = FlatDynamicMapLocation | {
  location: NestedDynamicMapLocation;
  parentStorageKey: string;
};

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
  reservedBytes: number | null;
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

type DynamicFieldAlgebra = "counter" | "sample" | "maximum" | "counterMap";

const COUNTER_VALUE_LOCATIONS = new Set<DynamicMapLocation>([
  "retrieval.byMode",
  "retrieval.byType",
  "retrieval.candidatesBySource",
  "indexing.phaseCounts",
  "indexing.engineDispatch",
  "packed.axisHits",
  "toolOutput.detailCounts",
  "toolOutput.profileCounts",
  "toolOutput.perTool.detailCounts",
  "toolOutput.perTool.profileCounts",
]);
const SAMPLE_VALUE_LOCATIONS = new Set<DynamicMapLocation>([
  "retrieval.phaseLatencyMs",
  "indexing.languageMs",
]);
const STRUCTURED_VALUE_FIELDS: Partial<
  Record<DynamicMapLocation, readonly (readonly [string, DynamicFieldAlgebra])[]>
> = {
  "cache.perSource": [
    ["hits", "counter"],
    ["misses", "counter"],
    ["lookupMs", "sample"],
  ],
  "tokenEfficiency.compressionBySource": [
    ["events", "counter"],
    ["realizedEvents", "counter"],
    ["estimatedTokensAvoided", "counter"],
    ["originalTokens", "counter"],
    ["returnedTokens", "counter"],
    ["savedTokens", "counter"],
    ["opportunities", "counter"],
    ["hits", "counter"],
    ["storedBytes", "counter"],
  ],
  "predictiveContext.byStrategy": [
    ["samples", "counter"],
    ["hits", "counter"],
    ["wasted", "counter"],
    ["accepted", "counter"],
    ["suppressed", "counter"],
    ["latencyReductionMs", "sample"],
  ],
  "latency.perTool": [
    ["calls", "counter"],
    ["errors", "counter"],
    ["durationMs", "sample"],
  ],
  "packed.byEncoder": [
    ["decisions", "counter"],
    ["packed", "counter"],
    ["fallback", "counter"],
    ["packedBytes", "counter"],
    ["baselineBytes", "counter"],
    ["packedTokens", "counter"],
    ["baselineTokens", "counter"],
  ],
  "toolOutput.perTool": [
    ["calls", "counter"],
    ["errors", "counter"],
    ["rawBytes", "counter"],
    ["projectedBytes", "counter"],
    ["rawTokens", "counter"],
    ["projectedTokens", "counter"],
    ["removedFields", "counter"],
    ["handled", "counter"],
    ["truncated", "counter"],
    ["recoveryEmitted", "counter"],
    ["invalidRecovery", "counter"],
    ["projectedBytesMax", "maximum"],
    ["projectedTokensMax", "maximum"],
    ["detailCounts", "counterMap"],
    ["profileCounts", "counterMap"],
  ],
};

function exactRecord(
  value: unknown,
  fields: readonly (readonly [string, DynamicFieldAlgebra])[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Lifetime dynamic value must be an object");
  const expected = fields.map(([field]) => field);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((field) => !Object.hasOwn(value, field))) {
    throw new TypeError("Lifetime dynamic value has an invalid shape");
  }
  return value;
}

function validateSampleTotal(value: unknown): SampleTotal {
  if (!isSample(value)) throw new TypeError("Lifetime sample has an invalid shape");
  validateCounter(value.count);
  validateSafeValue(value.sum);
  validateSafeValue(value.max);
  return { count: value.count, sum: value.sum, max: value.max };
}

function validateCounterMap(value: unknown): Record<string, Counter> {
  if (!isRecord(value)) throw new TypeError("Lifetime counter map must be an object");
  const entries = Object.entries(value);
  const realKeys = entries.filter(([key]) => key !== OVERFLOW_KEY);
  if (
    realKeys.length > MAX_DYNAMIC_KEYS
    || entries.some(([key]) => key !== OVERFLOW_KEY && !CANONICAL_STORAGE_KEY.test(key))
  ) {
    throw new RangeError("Lifetime counter map exceeds its key contract");
  }
  const result: Record<string, Counter> = {};
  for (const key of Object.keys(value).sort()) {
    const counter = value[key];
    if (typeof counter !== "number") throw new TypeError("Lifetime counter must be numeric");
    validateCounter(counter);
    result[key] = counter;
  }
  return result;
}

function validateStructuredDynamicValue(
  value: unknown,
  fields: readonly (readonly [string, DynamicFieldAlgebra])[],
): Record<string, unknown> {
  const record = exactRecord(value, fields);
  const result: Record<string, unknown> = {};
  for (const [field, algebra] of fields) {
    const nested = record[field];
    if (algebra === "sample") {
      result[field] = validateSampleTotal(nested);
    } else if (algebra === "counterMap") {
      result[field] = validateCounterMap(nested);
    } else {
      if (typeof nested !== "number") throw new TypeError("Lifetime counter must be numeric");
      validateCounter(nested);
      result[field] = nested;
    }
  }
  return result;
}

function validateDynamicValue(location: DynamicMapLocation, value: unknown): unknown {
  if (COUNTER_VALUE_LOCATIONS.has(location)) {
    if (typeof value !== "number") throw new TypeError("Lifetime counter must be numeric");
    validateCounter(value);
    return value;
  }
  if (SAMPLE_VALUE_LOCATIONS.has(location)) return validateSampleTotal(value);
  const fields = STRUCTURED_VALUE_FIELDS[location];
  if (fields === undefined) throw new Error(`Missing dynamic algebra for ${location}`);
  return validateStructuredDynamicValue(value, fields);
}

function mergeStructuredDynamicValue(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  fields: readonly (readonly [string, DynamicFieldAlgebra])[],
): SaturatingResult<Record<string, unknown>> {
  const value: Record<string, unknown> = {};
  let saturated = false;
  for (const [field, algebra] of fields) {
    if (algebra === "sample") {
      const merged = mergeSampleWithSaturation(
        left[field] as SampleTotal,
        right[field] as SampleTotal,
      );
      value[field] = merged.value;
      saturated ||= merged.saturated;
    } else if (algebra === "counterMap") {
      const merged = mergeDynamicMaps(
        left[field] as Record<string, Counter>,
        right[field] as Record<string, Counter>,
        { location: "retrieval.byMode", merge: mergeCounter },
      );
      value[field] = merged.value;
      saturated ||= merged.saturated;
    } else if (algebra === "maximum") {
      value[field] = Math.max(left[field] as number, right[field] as number);
    } else {
      const merged = mergeCounter(left[field] as number, right[field] as number);
      value[field] = merged.value;
      saturated ||= merged.saturated;
    }
  }
  return { value, saturated };
}

function mergeDynamicValue(
  location: DynamicMapLocation,
  left: unknown,
  right: unknown,
): SaturatingResult<unknown> {
  const validatedLeft = validateDynamicValue(location, left);
  const validatedRight = validateDynamicValue(location, right);
  if (COUNTER_VALUE_LOCATIONS.has(location)) {
    return mergeCounter(validatedLeft as number, validatedRight as number);
  }
  if (SAMPLE_VALUE_LOCATIONS.has(location)) {
    return mergeSampleWithSaturation(
      validatedLeft as SampleTotal,
      validatedRight as SampleTotal,
    );
  }
  const fields = STRUCTURED_VALUE_FIELDS[location];
  if (fields === undefined) throw new Error(`Missing dynamic algebra for ${location}`);
  return mergeStructuredDynamicValue(
    validatedLeft as Record<string, unknown>,
    validatedRight as Record<string, unknown>,
    fields,
  );
}

function rejectOuterToolNestedShapeGrowth(existing: unknown, incoming: unknown): void {
  if (!isRecord(existing) || !isRecord(incoming)) return;
  for (const field of ["detailCounts", "profileCounts"] as const) {
    const existingMap = existing[field];
    const incomingMap = incoming[field];
    if (!isRecord(existingMap) || !isRecord(incomingMap)) continue;
    if (Object.keys(incomingMap).some((key) => !Object.hasOwn(existingMap, key))) {
      throw new Error(
        "New tool-output counter keys require the explicit nested admission target",
      );
    }
  }
}

interface LocatedDynamicMap {
  current: Readonly<Record<string, unknown>>;
  replace: (
    replacement: Readonly<Record<string, unknown>>,
    saturated: boolean,
  ) => DurableLifetimeRoot;
}

interface ResolvedDynamicMapTarget {
  location: DynamicMapLocation;
  parentStorageKey: string | null;
}

function resolveDynamicMapTarget(target: DynamicMapTarget): ResolvedDynamicMapTarget {
  if (typeof target === "string") {
    return { location: target, parentStorageKey: null };
  }
  if (
    target.location !== "toolOutput.perTool.detailCounts"
    && target.location !== "toolOutput.perTool.profileCounts"
  ) {
    throw new Error("Nested lifetime parent target has an invalid location");
  }
  if (
    target.parentStorageKey !== OVERFLOW_KEY
    && !CANONICAL_STORAGE_KEY.test(target.parentStorageKey)
  ) {
    throw new Error("Nested lifetime parent storage key is invalid");
  }
  return target;
}

function locateDynamicMap(
  root: DurableLifetimeRoot,
  repositoryKey: string,
  target: ResolvedDynamicMapTarget,
): LocatedDynamicMap {
  const { location, parentStorageKey } = target;
  const repository = root.repositories[repositoryKey];
  if (repository === undefined) throw new Error("Lifetime repository is missing");
  const [sectionName, field, nestedField] = location.split(".");
  const sections = repository.sections as unknown as Record<string, unknown>;
  const section = sections[sectionName];
  if (!isRecord(section)) throw new Error(`Lifetime section is unavailable for ${location}`);

  const replaceSection = (
    replacementSection: Record<string, unknown>,
    saturated: boolean,
  ): DurableLifetimeRoot => ({
    ...root,
    repositories: {
      ...root.repositories,
      [repositoryKey]: {
        ...repository,
        saturated: repository.saturated || saturated,
        sections: {
          ...sections,
          [sectionName]: replacementSection,
        } as unknown as DurableLifetimeSections,
      },
    },
  });

  if (nestedField === undefined) {
    if (parentStorageKey !== null) {
      throw new Error(`Lifetime parent is invalid for flat location ${location}`);
    }
    const current = section[field];
    if (!isRecord(current)) throw new Error(`Lifetime map is unavailable for ${location}`);
    return {
      current,
      replace: (replacement, saturated) => replaceSection(
        { ...section, [field]: replacement },
        saturated,
      ),
    };
  }

  const perTool = section[field];
  if (!isRecord(perTool)) throw new Error(`Lifetime map is unavailable for ${location}`);
  if (parentStorageKey === null || !Object.hasOwn(perTool, parentStorageKey)) {
    throw new Error(`Lifetime parent is unavailable for ${location}`);
  }
  const toolKey = parentStorageKey;
  const tool = perTool[toolKey];
  if (!isRecord(tool)) throw new Error(`Lifetime tool is invalid for ${location}`);
  const current = tool[nestedField];
  if (!isRecord(current)) throw new Error(`Lifetime map is unavailable for ${location}`);
  return {
    current,
    replace: (replacement, saturated) => replaceSection(
      {
        ...section,
        [field]: {
          ...perTool,
          [toolKey]: { ...tool, [nestedField]: replacement },
        },
      },
      saturated,
    ),
  };
}

export function admitDynamicMapEntry<T>(
  root: DurableLifetimeRoot,
  repositoryKey: string,
  target: DynamicMapTarget,
  rawIdentifier: string,
  incoming: T,
): DynamicMapAdmission<T> {
  const resolvedTarget = resolveDynamicMapTarget(target);
  const { location } = resolvedTarget;
  const located = locateDynamicMap(root, repositoryKey, resolvedTarget);
  const current = located.current as Readonly<Record<string, T>>;
  const validatedIncoming = validateDynamicValue(location, incoming) as T;
  const requestedKey = canonicalDynamicKey(rawIdentifier);
  const realKeyCount = Object.keys(current).filter((key) => key !== OVERFLOW_KEY).length;
  const isNewRealKey = requestedKey !== OVERFLOW_KEY && !Object.hasOwn(current, requestedKey);
  const storageKey = isNewRealKey && realKeyCount >= dynamicMapLimit(location)
    ? OVERFLOW_KEY
    : requestedKey;

  const mergeAt = (key: string): SaturatingResult<Record<string, T>> => {
    const next = { ...current };
    const existing = next[key];
    let saturated = false;
    if (existing === undefined) {
      next[key] = structuredClone(validatedIncoming);
    } else {
      if (location === "toolOutput.perTool") {
        rejectOuterToolNestedShapeGrowth(existing, validatedIncoming);
      }
      const merged = mergeDynamicValue(location, existing, validatedIncoming);
      next[key] = merged.value as T;
      saturated = merged.saturated;
    }
    return { value: normalizeDynamicMap(next), saturated };
  };

  const candidateFor = (key: string, reserveNewKey: boolean) => {
    const merged = mergeAt(key);
    const candidateRoot = located.replace(merged.value, merged.saturated);
    const reservedBytes = reserveNewKey ? reservedSerializedBytes(candidateRoot) : null;
    return {
      root: candidateRoot,
      map: merged.value,
      reservedBytes,
      saturated: merged.saturated,
    };
  };
  const rejection = (key: string, reservedBytes: number): DynamicMapAdmission<T> => ({
    root,
    map: normalizeDynamicMap(current),
    storageKey: key,
    admitted: false,
    status: "capacityRejected",
    reason: "storeBytes",
    reservedBytes,
    saturated: false,
  });
  const accepted = (
    key: string,
    candidate: ReturnType<typeof candidateFor>,
  ): DynamicMapAdmission<T> => ({
    root: candidate.root,
    map: candidate.map,
    storageKey: key,
    admitted: key !== OVERFLOW_KEY,
    status: key === OVERFLOW_KEY ? "overflow" : "admitted",
    reason: null,
    reservedBytes: candidate.reservedBytes,
    saturated: candidate.saturated,
  });

  const isNewStorageKey = !Object.hasOwn(current, storageKey);
  const candidate = candidateFor(storageKey, isNewStorageKey);
  if (candidate.reservedBytes === null || candidate.reservedBytes <= MAX_STORE_BYTES) {
    return accepted(storageKey, candidate);
  }

  if (storageKey !== OVERFLOW_KEY) {
    // A real-key miss is never dropped: retry against the reserved overflow shape.
    const isNewOverflow = !Object.hasOwn(current, OVERFLOW_KEY);
    const overflow = candidateFor(OVERFLOW_KEY, isNewOverflow);
    if (overflow.reservedBytes === null || overflow.reservedBytes <= MAX_STORE_BYTES) {
      return accepted(OVERFLOW_KEY, overflow);
    }
    return rejection(OVERFLOW_KEY, overflow.reservedBytes);
  }

  // An empty map has no overflow reservation until its first event supplies the value shape.
  return rejection(storageKey, candidate.reservedBytes);
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

function validateRepositoryLifetime(
  repository: DurableLifetimeRepository,
): DurableLifetimeRepository {
  const parsed = parseDurableLifetimeRoot({
    schemaVersion: 1,
    generation: 0,
    updatedAt: VALIDATION_TIMESTAMP,
    processPeaks: null,
    repositories: { [VALIDATION_REPOSITORY_KEY]: repository },
  });
  const validated = parsed.repositories[VALIDATION_REPOSITORY_KEY];
  if (validated === undefined) throw new Error("Validated lifetime repository is missing");
  return validated;
}

export function mergeRepositoryLifetime(
  baseline: DurableLifetimeRepository,
  epoch: DurableLifetimeRepository,
): DurableLifetimeRepository {
  const validatedBaseline = validateRepositoryLifetime(baseline);
  const validatedEpoch = validateRepositoryLifetime(epoch);
  const sessionCount = mergeCounter(validatedBaseline.sessionCount, validatedEpoch.sessionCount);
  const sections = mergeUnknown(
    validatedBaseline.sections,
    validatedEpoch.sections,
  ) as SaturatingResult<DurableLifetimeSections>;
  return {
    epoch: Math.max(validatedBaseline.epoch, validatedEpoch.epoch),
    resetAt: validatedEpoch.resetAt ?? validatedBaseline.resetAt,
    lastCheckpointAt: validatedEpoch.lastCheckpointAt ?? validatedBaseline.lastCheckpointAt,
    sessionCount: sessionCount.value,
    saturated: validatedBaseline.saturated
      || validatedEpoch.saturated
      || sessionCount.saturated
      || sections.saturated,
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

function maximizeForReservation(value: unknown, fieldName = ""): unknown {
  if (typeof value === "number") return MAXIMUM_NUMERIC_JSON_PLACEHOLDER;
  if (typeof value === "string") return MAXIMUM_TIMESTAMP;
  if (typeof value === "boolean") return false;
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  let dynamicIndex = 0;
  for (const [key, nested] of Object.entries(value)) {
    const reservedKey = key.startsWith("k:") ? maximumDynamicKey(dynamicIndex++) : key;
    result[reservedKey] = maximizeForReservation(nested, key);
  }
  if (
    DYNAMIC_MAP_FIELDS.has(fieldName)
    && !Object.hasOwn(value, OVERFLOW_KEY)
    && Object.keys(value).length > 0
  ) {
    const largest = Object.values(result).reduce((selected, candidate) =>
      Buffer.byteLength(JSON.stringify(candidate), "utf8")
        > Buffer.byteLength(JSON.stringify(selected), "utf8")
        ? candidate
        : selected);
    result[OVERFLOW_KEY] = structuredClone(largest);
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
  const validatedRepository = validateRepositoryLifetime(repository);
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
    ? validatedRepository
    : mergeRepositoryLifetime(existing, validatedRepository);
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
