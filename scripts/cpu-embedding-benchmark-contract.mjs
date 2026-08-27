const STRING_FIELDS = ["id", "executionMode", "graphOptimizationLevel"];
const INTEGER_FIELDS = [
  "batchSize",
  "concurrency",
  "texts",
  "intraOpNumThreads",
  "interOpNumThreads",
];
const BOOLEAN_FIELDS = [
  "enableCpuMemArena",
  "enableMemPattern",
];

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function requirePositiveNumber(value, label, integer = false) {
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${label} must be a finite positive${integer ? " integer" : " number"}`);
  }
}

function validateShape(shape, label) {
  requireObject(shape, label);
  for (const field of STRING_FIELDS) {
    if (typeof shape[field] !== "string" || shape[field].length === 0) {
      throw new TypeError(`${label} ${field} must be a non-empty string`);
    }
  }
  for (const field of INTEGER_FIELDS) {
    requirePositiveNumber(shape[field], `${label} ${field}`, true);
  }
  if (
    !Array.isArray(shape.executionProviders) ||
    shape.executionProviders.length === 0 ||
    shape.executionProviders.some(
      (provider) => typeof provider !== "string" || provider.length === 0,
    )
  ) {
    throw new TypeError(`${label} executionProviders must be a non-empty string array`);
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof shape[field] !== "boolean") {
      throw new TypeError(`${label} ${field} must be a boolean`);
    }
  }
}

function sameProviders(left, right) {
  return (
    left.length === right.length &&
    left.every((provider, index) => provider === right[index])
  );
}

function validateSample(shape, sample, index) {
  const label = `sample ${index + 1}`;
  requireObject(sample, label);
  validateShape(sample, label);

  for (const field of [...STRING_FIELDS, ...INTEGER_FIELDS, ...BOOLEAN_FIELDS]) {
    if (sample[field] !== shape[field]) {
      throw new TypeError(`${label} ${field} does not match the requested shape`);
    }
  }
  if (!sameProviders(sample.executionProviders, shape.executionProviders)) {
    throw new TypeError(`${label} executionProviders does not match the requested shape`);
  }

  requirePositiveNumber(sample.milliseconds, `${label} milliseconds`);
  requirePositiveNumber(sample.textsPerSecond, `${label} textsPerSecond`);
  requirePositiveNumber(sample.maxRssKiB, `${label} maxRssKiB`, true);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function copyShape(shape) {
  return {
    id: shape.id,
    batchSize: shape.batchSize,
    concurrency: shape.concurrency,
    texts: shape.texts,
    executionProviders: [...shape.executionProviders],
    intraOpNumThreads: shape.intraOpNumThreads,
    interOpNumThreads: shape.interOpNumThreads,
    executionMode: shape.executionMode,
    enableCpuMemArena: shape.enableCpuMemArena,
    enableMemPattern: shape.enableMemPattern,
    graphOptimizationLevel: shape.graphOptimizationLevel,
  };
}

export function aggregateShapeSamples(shape, samples, expectedSamples) {
  validateShape(shape, "shape");
  requirePositiveNumber(expectedSamples, "expectedSamples", true);
  if (!Array.isArray(samples) || samples.length !== expectedSamples) {
    throw new TypeError(`Expected exactly ${expectedSamples} sample${expectedSamples === 1 ? "" : "s"}`);
  }
  samples.forEach((sample, index) => validateSample(shape, sample, index));

  // Aggregate independent measurements without allowing a partial run to pass.
  return {
    ...copyShape(shape),
    medianMilliseconds: median(samples.map(({ milliseconds }) => milliseconds)),
    medianTextsPerSecond: median(samples.map(({ textsPerSecond }) => textsPerSecond)),
    medianMaxRssKiB: median(samples.map(({ maxRssKiB }) => maxRssKiB)),
    worstMaxRssKiB: Math.max(...samples.map(({ maxRssKiB }) => maxRssKiB)),
  };
}

function validateAggregate(aggregate, label) {
  validateShape(aggregate, label);
  requirePositiveNumber(
    aggregate.medianTextsPerSecond,
    `${label} medianTextsPerSecond`,
  );
  requirePositiveNumber(aggregate.medianMaxRssKiB, `${label} medianMaxRssKiB`, true);
  requirePositiveNumber(aggregate.worstMaxRssKiB, `${label} worstMaxRssKiB`, true);
}

export function evaluateProductionGate({
  baseline,
  production,
  minimumUpliftPercent = 15,
}) {
  validateAggregate(baseline, "baseline");
  validateAggregate(production, "production");
  if (!Number.isFinite(minimumUpliftPercent) || minimumUpliftPercent < 0) {
    throw new TypeError("minimumUpliftPercent must be a finite non-negative number");
  }

  const upliftPercent =
    ((production.medianTextsPerSecond - baseline.medianTextsPerSecond) /
      baseline.medianTextsPerSecond) * 100;
  const memoryLimitKiB =
    baseline.medianMaxRssKiB +
    Math.max(baseline.medianMaxRssKiB * 0.1, 128 * 1_024);
  const throughputPassed = upliftPercent >= minimumUpliftPercent;
  const memoryPassed = production.worstMaxRssKiB <= memoryLimitKiB;

  return {
    passed: throughputPassed && memoryPassed,
    upliftPercent,
    memoryLimitKiB,
    throughputPassed,
    memoryPassed,
  };
}

export function rankQualifyingCandidates({
  baseline,
  candidates,
  minimumUpliftPercent = 15,
}) {
  if (!Array.isArray(candidates)) {
    throw new TypeError("candidates must be an array");
  }

  // Candidate ranking is evidence only; the production gate receives one shape.
  return candidates
    .filter((candidate) =>
      evaluateProductionGate({
        baseline,
        production: candidate,
        minimumUpliftPercent,
      }).passed,
    )
    .toSorted(
      (left, right) =>
        right.medianTextsPerSecond - left.medianTextsPerSecond ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
}
