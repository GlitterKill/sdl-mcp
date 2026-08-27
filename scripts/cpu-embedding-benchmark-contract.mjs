import childProcess from "node:child_process";

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
const CANDIDATE_BATCH_SIZES = [8, 12, 16, 20, 24];
const CANDIDATE_CONCURRENCY = 8;
const STDOUT_LIMIT = 4_096;
const STDERR_LIMIT = 4_096;

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

function copySessionTuple(shape) {
  return {
    executionProviders: [...shape.executionProviders],
    intraOpNumThreads: shape.intraOpNumThreads,
    interOpNumThreads: shape.interOpNumThreads,
    executionMode: shape.executionMode,
    enableCpuMemArena: shape.enableCpuMemArena,
    enableMemPattern: shape.enableMemPattern,
    graphOptimizationLevel: shape.graphOptimizationLevel,
  };
}

export function buildBenchmarkShapes(productionShape) {
  requireObject(productionShape, "productionShape");
  const production = {
    id: "production",
    batchSize: productionShape.batchSize,
    concurrency: productionShape.concurrency,
    ...copySessionTuple(productionShape),
  };
  validateShape({ ...production, texts: 1 }, "productionShape");
  if (!production.enableCpuMemArena) {
    throw new TypeError("productionShape enableCpuMemArena must be true");
  }

  const sessionTuple = copySessionTuple(production);
  return [
    { id: "baseline", batchSize: 32, concurrency: 1, ...sessionTuple },
    production,
    ...CANDIDATE_BATCH_SIZES
      .filter(
        (batchSize) =>
          batchSize !== production.batchSize ||
          production.concurrency !== CANDIDATE_CONCURRENCY,
      )
      .map((batchSize) => ({
        id: `batch-${batchSize}`,
        batchSize,
        concurrency: CANDIDATE_CONCURRENCY,
        ...sessionTuple,
      })),
    {
      id: "arena-off",
      batchSize: production.batchSize,
      concurrency: production.concurrency,
      ...sessionTuple,
      enableCpuMemArena: false,
    },
  ];
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

function appendBounded(current, chunk, limit) {
  if (current.length >= limit) return current;
  return current + String(chunk).slice(0, limit - current.length);
}

export function runBenchmarkChild({ scriptPath, cwd, shape }) {
  if (typeof scriptPath !== "string" || scriptPath.length === 0) {
    throw new TypeError("scriptPath must be a non-empty string");
  }
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new TypeError("cwd must be a non-empty string");
  }
  validateShape(shape, "shape");

  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stdoutOverflow = false;
    let stderr = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const child = childProcess.spawn(
      process.execPath,
      [scriptPath, "--child", JSON.stringify(shape)],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdoutOverflow ||= stdout.length + text.length > STDOUT_LIMIT;
      stdout = appendBounded(stdout, text, STDOUT_LIMIT);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk, STDERR_LIMIT);
    });
    child.on("error", (error) => {
      fail(
        new Error(
          `Child ${shape.id} failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (signal) {
        fail(new Error(`Child ${shape.id} exited on signal ${signal}: ${stderr.trim()}`));
        return;
      }
      if (code !== 0) {
        fail(new Error(`Child ${shape.id} exited ${String(code)}: ${stderr.trim()}`));
        return;
      }
      if (stdoutOverflow) {
        fail(new Error(`Child ${shape.id} stdout exceeded ${STDOUT_LIMIT} characters`));
        return;
      }

      const recordText = stdout.trim();
      if (recordText.length === 0) {
        fail(new Error(`Child ${shape.id} returned empty stdout`));
        return;
      }
      let record;
      try {
        record = JSON.parse(recordText);
      } catch (error) {
        fail(
          new Error(
            `Child ${shape.id} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      try {
        validateSample(shape, record, 0);
      } catch (error) {
        fail(error);
        return;
      }
      settled = true;
      resolvePromise(record);
    });
  });
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
  requirePositiveNumber(aggregate.medianMaxRssKiB, `${label} medianMaxRssKiB`);
  requirePositiveNumber(aggregate.worstMaxRssKiB, `${label} worstMaxRssKiB`, true);
}

function evaluateAggregateGate({
  baseline,
  candidate,
  minimumUpliftPercent = 15,
}) {
  validateAggregate(baseline, "baseline");
  validateAggregate(candidate, "candidate");
  if (!Number.isFinite(minimumUpliftPercent) || minimumUpliftPercent < 0) {
    throw new TypeError("minimumUpliftPercent must be a finite non-negative number");
  }

  const upliftPercent =
    ((candidate.medianTextsPerSecond - baseline.medianTextsPerSecond) /
      baseline.medianTextsPerSecond) * 100;
  const memoryLimitKiB =
    baseline.medianMaxRssKiB +
    Math.max(baseline.medianMaxRssKiB * 0.1, 128 * 1_024);
  const throughputPassed = upliftPercent >= minimumUpliftPercent;
  const memoryPassed = candidate.worstMaxRssKiB <= memoryLimitKiB;

  return {
    passed: throughputPassed && memoryPassed,
    upliftPercent,
    memoryLimitKiB,
    throughputPassed,
    memoryPassed,
  };
}

export function evaluateProductionGate({
  baseline,
  production,
  minimumUpliftPercent = 15,
}) {
  requireObject(baseline, "baseline");
  requireObject(production, "production");
  if (baseline.id !== "baseline") {
    throw new TypeError('baseline id must be "baseline"');
  }
  if (production.id !== "production") {
    throw new TypeError('production id must be "production"');
  }
  return evaluateAggregateGate({
    baseline,
    candidate: production,
    minimumUpliftPercent,
  });
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
      evaluateAggregateGate({
        baseline,
        candidate,
        minimumUpliftPercent,
      }).passed,
    )
    .toSorted(
      (left, right) =>
        right.medianTextsPerSecond - left.medianTextsPerSecond ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
}
