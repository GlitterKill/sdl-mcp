import childProcess from "node:child_process";

export const NORMALIZATION_TOLERANCE = 1e-5;
export const MINIMUM_PAIRED_COSINE = 0.985;
export const STDOUT_LIMIT_BYTES = 512 * 1024;

const STDERR_LIMIT_BYTES = 16 * 1024;
const CHILD_TIMEOUT_MS = 300_000;
const DIMENSION = 768;
const BATCH_SIZE = 4;
const MODEL = "jina-embeddings-v2-base-code";
const EXPECTED_TARGETS = [0, 1];

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function requireFiniteTiming(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
}

function validateIdentity(value, label) {
  requireObject(value, label);
  requireString(value.modelName, `${label}.modelName`);
  requireString(value.variantName, `${label}.variantName`);
  requireString(value.modelFile, `${label}.modelFile`);
  if (
    !Array.isArray(value.executionProviders) ||
    value.executionProviders.length === 0 ||
    value.executionProviders.some(
      (provider) => typeof provider !== "string" || provider.length === 0,
    )
  ) {
    throw new TypeError(`${label}.executionProviders must be a non-empty string array`);
  }
}

function requireVectors(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
}

function validateChildRecord(value, mode) {
  requireObject(value, `${mode} child record`);
  if (value.mode !== mode) {
    throw new TypeError(`${mode} child record mode must equal "${mode}"`);
  }

  if (mode === "fallback") {
    requireObject(value.automatic, "fallback.automatic");
    if (
      !Array.isArray(value.automatic.attempts) ||
      value.automatic.attempts.some(
        (attempt) => typeof attempt !== "string" || attempt.length === 0,
      )
    ) {
      throw new TypeError("fallback.automatic.attempts must be a string array");
    }
    validateIdentity(value.automatic.identity, "fallback.automatic.identity");
    requireVectors(value.automatic.vectors, "fallback.automatic.vectors");
    requireObject(value.explicitFp16, "fallback.explicitFp16");
    if (
      !Number.isInteger(value.explicitFp16.attempts) ||
      value.explicitFp16.attempts < 0
    ) {
      throw new TypeError("fallback.explicitFp16.attempts must be a non-negative integer");
    }
    if (typeof value.explicitFp16.rejected !== "boolean") {
      throw new TypeError("fallback.explicitFp16.rejected must be a boolean");
    }
    return value;
  }

  validateIdentity(value.identity, `${mode}.identity`);
  requireVectors(value.vectors, `${mode}.vectors`);
  requireFiniteTiming(value.firstPassMs, `${mode}.firstPassMs`);
  if (mode === "cpu") {
    requireVectors(value.repeatVectors, "cpu.repeatVectors");
    requireFiniteTiming(value.determinismRepeatMs, "cpu.determinismRepeatMs");
  }
  return value;
}

function boundedCapture(limit) {
  const chunks = [];
  let retainedBytes = 0;
  let totalBytes = 0;
  return {
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += bytes.length;
      const remaining = limit - retainedBytes;
      if (remaining > 0) {
        const retained = bytes.subarray(0, remaining);
        chunks.push(retained);
        retainedBytes += retained.length;
      }
    },
    get overflowed() {
      return totalBytes > limit;
    },
    text() {
      return Buffer.concat(chunks, retainedBytes).toString("utf8");
    },
  };
}

export function runJinaProbeChild({
  scriptPath,
  moduleRoot,
  cwd,
  mode,
  timeoutMs = CHILD_TIMEOUT_MS,
}) {
  requireString(scriptPath, "scriptPath");
  requireString(moduleRoot, "moduleRoot");
  requireString(cwd, "cwd");
  if (!new Set(["dml", "cpu", "fallback"]).has(mode)) {
    throw new TypeError('mode must be "dml", "cpu", or "fallback"');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a finite positive number");
  }

  return new Promise((resolve, reject) => {
    const stdout = boundedCapture(STDOUT_LIMIT_BYTES);
    const stderr = boundedCapture(STDERR_LIMIT_BYTES);
    let settled = false;
    let watchdog;
    const settle = () => {
      if (settled) return false;
      settled = true;
      if (watchdog !== undefined) clearTimeout(watchdog);
      return true;
    };
    const fail = (error) => {
      if (!settle()) return;
      reject(error);
    };
    const child = childProcess.spawn(
      process.execPath,
      [scriptPath, "--child", mode, "--module-root", moduleRoot],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.on("error", (error) => {
      fail(
        new Error(
          `Jina ${mode} child failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (signal) {
        fail(new Error(`Jina ${mode} child exited on signal ${signal}: ${stderr.text().trim()}`));
        return;
      }
      if (code !== 0) {
        fail(new Error(`Jina ${mode} child exited ${String(code)}: ${stderr.text().trim()}`));
        return;
      }
      if (stdout.overflowed) {
        fail(new Error(`Jina ${mode} child stdout exceeded ${STDOUT_LIMIT_BYTES} bytes`));
        return;
      }

      const recordText = stdout.text().trim();
      if (recordText.length === 0) {
        fail(new Error(`Jina ${mode} child returned empty stdout`));
        return;
      }
      let record;
      try {
        record = JSON.parse(recordText);
      } catch (error) {
        fail(
          new Error(
            `Jina ${mode} child returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      try {
        validateChildRecord(record, mode);
      } catch (error) {
        fail(error);
        return;
      }
      if (!settle()) return;
      resolve(record);
    });
    watchdog = setTimeout(() => {
      if (!settle()) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Timeout remains authoritative even when the process rejects the kill.
      }
      reject(new Error(`Jina ${mode} child timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
}

function sameStrings(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function identityMatches(actual, variantName, modelFile, providers) {
  return (
    actual.modelName === MODEL &&
    actual.variantName === variantName &&
    actual.modelFile === modelFile &&
    sameStrings(actual.executionProviders, providers)
  );
}

function copyIdentity(value) {
  return {
    modelName: value.modelName,
    variantName: value.variantName,
    modelFile: value.modelFile,
    executionProviders: [...value.executionProviders],
  };
}

function vectorBatches(dml, cpu, fallback) {
  return [
    dml.vectors,
    cpu.vectors,
    cpu.repeatVectors,
    fallback.automatic.vectors,
  ];
}

function dimensionsPass(batches) {
  return batches.every(
    (batch) =>
      batch.length === BATCH_SIZE &&
      batch.every((value) => Array.isArray(value) && value.length === DIMENSION),
  );
}

function finitePass(batches) {
  return batches.every((batch) =>
    batch.every(
      (value) =>
        Array.isArray(value) &&
        value.every((component) => Number.isFinite(component)),
    ),
  );
}

function vectorNorm(value) {
  return Math.sqrt(value.reduce((sum, component) => sum + component * component, 0));
}

function normalizedPass(batches, dimensionsPassed, finitePassed) {
  if (!dimensionsPassed || !finitePassed) return false;
  const lower = 1 - NORMALIZATION_TOLERANCE;
  const upper = 1 + NORMALIZATION_TOLERANCE;
  return batches.every((batch) =>
    batch.every((value) => {
      const norm = vectorNorm(value);
      return norm >= lower && norm <= upper;
    }),
  );
}

function cosine(left, right) {
  let dot = 0;
  let leftNormSquared = 0;
  let rightNormSquared = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNormSquared += left[index] * left[index];
    rightNormSquared += right[index] * right[index];
  }
  return dot / Math.sqrt(leftNormSquared * rightNormSquared);
}

function rank(query, corpus) {
  return corpus
    .map((value, index) => ({ index, score: cosine(query, value) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
}

function topTargets(queryVectors, corpusVectors) {
  return [
    rank(queryVectors[2], corpusVectors.slice(0, 2))[0].index,
    rank(queryVectors[3], corpusVectors.slice(0, 2))[0].index,
  ];
}

function sameTargets(actual) {
  return sameStrings(actual, EXPECTED_TARGETS);
}

export function evaluateJinaProbe({ dml, cpu, fallback }) {
  validateChildRecord(dml, "dml");
  validateChildRecord(cpu, "cpu");
  validateChildRecord(fallback, "fallback");

  const batches = vectorBatches(dml, cpu, fallback);
  const dimensionsPassed = dimensionsPass(batches);
  const finitePassed = finitePass(batches);
  const normalizedPassed = normalizedPass(
    batches,
    dimensionsPassed,
    finitePassed,
  );
  const comparableVectors = dimensionsPassed && finitePassed && normalizedPassed;
  const pairedCosines = comparableVectors
    ? dml.vectors.map((value, index) => cosine(value, cpu.vectors[index]))
    : [];
  const minimumPairedCosine =
    pairedCosines.length === BATCH_SIZE ? Math.min(...pairedCosines) : null;
  const crossVariantTop1 = comparableVectors
    ? topTargets(cpu.vectors, dml.vectors)
    : [];
  const controlTop1 = comparableVectors
    ? topTargets(cpu.vectors, cpu.vectors)
    : [];
  const quality = {
    dmlIdentityPassed: identityMatches(
      dml.identity,
      "fp16",
      "model_fp16.onnx",
      ["dml", "cpu"],
    ),
    cpuIdentityPassed: identityMatches(
      cpu.identity,
      "default",
      "model_quantized.onnx",
      ["cpu"],
    ),
    fallbackIdentityPassed: identityMatches(
      fallback.automatic.identity,
      "int8",
      "model_quantized.onnx",
      ["cpu"],
    ),
    dimensionsPassed,
    finitePassed,
    normalizedPassed,
    cpuRepeatExact:
      JSON.stringify(cpu.vectors) === JSON.stringify(cpu.repeatVectors),
    minimumPairedCosine,
    pairedCosinePassed:
      minimumPairedCosine !== null &&
      minimumPairedCosine >= MINIMUM_PAIRED_COSINE,
    crossVariantTop1,
    crossVariantTop1Passed: sameTargets(crossVariantTop1),
    controlTop1,
    controlTop1Passed: sameTargets(controlTop1),
    fallbackAutomaticPassed: sameStrings(
      fallback.automatic.attempts,
      ["fp16", "default"],
    ),
    fallbackExplicitFp16Passed:
      fallback.explicitFp16.attempts === 1 &&
      fallback.explicitFp16.rejected === true,
  };

  return {
    passed: Object.entries(quality).every(
      ([name, value]) =>
        name === "minimumPairedCosine" ||
        name === "crossVariantTop1" ||
        name === "controlTop1" ||
        value === true,
    ),
    identities: {
      dml: copyIdentity(dml.identity),
      cpu: copyIdentity(cpu.identity),
      fallback: copyIdentity(fallback.automatic.identity),
    },
    quality,
    firstPassMs: { dml: dml.firstPassMs, cpu: cpu.firstPassMs },
    cpuDeterminismRepeatMs: cpu.determinismRepeatMs,
  };
}
