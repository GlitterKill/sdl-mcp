import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  evaluateJinaProbe,
  runJinaProbeChild,
} from "./jina-gpu-aware-probe-contract.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT_PATH = resolve(import.meta.filename);
const MODEL = "jina-embeddings-v2-base-code";
const FIXTURES = [
  "tests/fixtures/semantic-test-cases/test_sample.py",
  "tests/fixtures/semantic-test-cases/sample.test.ts",
];
const QUERIES = [
  "helper_target python function",
  "nestedHelper typescript function",
];

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required ${name} argument`);
  }
  return value;
}

async function loadRuntime(moduleRoot) {
  const moduleUrl = pathToFileURL(
    resolve(moduleRoot, "dist/indexer/embeddings-local.js"),
  ).href;
  return import(moduleUrl);
}

async function orderedBatch() {
  const corpus = await Promise.all(
    FIXTURES.map((path) => readFile(resolve(ROOT, path), "utf8")),
  );
  return [...corpus, ...QUERIES];
}

function identity(session) {
  return {
    modelName: session.modelName,
    variantName: session.variantName,
    modelFile: session.modelFile,
    executionProviders: [...session.executionProviders],
  };
}

async function runEmbeddingChild(mode, moduleRoot) {
  const { createOnnxSession } = await loadRuntime(moduleRoot);
  const texts = await orderedBatch();
  const options =
    mode === "dml"
      ? {
          deterministic: false,
          modelVariant: "default",
          executionProviders: ["dml", "cpu"],
        }
      : {
          deterministic: true,
          modelVariant: "default",
          executionProviders: ["cpu"],
        };
  const session = await createOnnxSession(MODEL, options);
  try {
    // Session construction is intentionally outside the comparable inference timer.
    const firstStarted = performance.now();
    const vectors = await session.embed(texts);
    const firstPassMs = performance.now() - firstStarted;
    if (mode === "dml") {
      return { mode, identity: identity(session), vectors, firstPassMs };
    }

    // Determinism cost is reported separately and never included in CPU/DML timing.
    const repeatStarted = performance.now();
    const repeatVectors = await session.embed(texts);
    return {
      mode,
      identity: identity(session),
      vectors,
      repeatVectors,
      firstPassMs,
      determinismRepeatMs: performance.now() - repeatStarted,
    };
  } finally {
    session.dispose();
  }
}

async function runFallbackChild(moduleRoot) {
  const { createOnnxSession, OnnxSessionCreationError } =
    await loadRuntime(moduleRoot);
  const texts = await orderedBatch();
  const attempts = [];
  const forcedLoader = async (modelName, candidate, options) => {
    attempts.push(candidate.variantName);
    if (candidate.variantName === "fp16") {
      throw new OnnxSessionCreationError("forced FP16 session-creation failure");
    }
    if (candidate.variantName !== "default") {
      throw new Error(`Unexpected automatic fallback candidate ${candidate.variantName}`);
    }
    return createOnnxSession(modelName, {
      deterministic: options.deterministic,
      modelVariant: "int8",
      executionProviders: ["cpu"],
    });
  };

  const automaticSession = await createOnnxSession(
    MODEL,
    {
      deterministic: false,
      modelVariant: "default",
      executionProviders: ["dml", "cpu"],
    },
    forcedLoader,
  );
  let automatic;
  try {
    automatic = {
      attempts,
      identity: identity(automaticSession),
      vectors: await automaticSession.embed(texts),
    };
  } finally {
    automaticSession.dispose();
  }

  let explicitAttempts = 0;
  let rejected = false;
  try {
    await createOnnxSession(
      MODEL,
      {
        deterministic: false,
        modelVariant: "fp16",
        executionProviders: ["dml", "cpu"],
      },
      async () => {
        explicitAttempts++;
        throw new OnnxSessionCreationError("forced explicit FP16 failure");
      },
    );
  } catch (error) {
    if (!(error instanceof OnnxSessionCreationError)) throw error;
    rejected = true;
  }

  return {
    mode: "fallback",
    automatic,
    explicitFp16: { attempts: explicitAttempts, rejected },
  };
}

async function runParent(moduleRoot) {
  // Sequential isolated children keep each first-pass timing uncontended.
  const dml = await runJinaProbeChild({
    scriptPath: SCRIPT_PATH,
    moduleRoot,
    cwd: ROOT,
    mode: "dml",
  });
  const cpu = await runJinaProbeChild({
    scriptPath: SCRIPT_PATH,
    moduleRoot,
    cwd: ROOT,
    mode: "cpu",
  });
  const fallback = await runJinaProbeChild({
    scriptPath: SCRIPT_PATH,
    moduleRoot,
    cwd: ROOT,
    mode: "fallback",
  });
  const result = evaluateJinaProbe({ dml, cpu, fallback });
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}

const childIndex = process.argv.indexOf("--child");
const childMode = childIndex < 0 ? undefined : process.argv[childIndex + 1];

async function main() {
  const moduleRoot = resolve(argument("--module-root"));
  if (childMode === "dml" || childMode === "cpu") {
    console.log(JSON.stringify(await runEmbeddingChild(childMode, moduleRoot)));
    return;
  }
  if (childMode === "fallback") {
    console.log(JSON.stringify(await runFallbackChild(moduleRoot)));
    return;
  }
  if (childMode !== undefined) {
    throw new Error(`Unknown child mode ${childMode}`);
  }
  await runParent(moduleRoot);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (childMode === undefined) {
    console.log(JSON.stringify({ passed: false, error: message }));
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});
