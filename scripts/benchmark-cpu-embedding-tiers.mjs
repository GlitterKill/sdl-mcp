import { access, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-node";
import { Tokenizer } from "tokenizers";

import {
  resolveEmbeddingSessionOptions,
  runBatchInference,
} from "../dist/indexer/embeddings-local.js";
import {
  getModelInfo,
  resolveModelPath,
  resolveTokenizerPath,
} from "../dist/indexer/model-registry.js";
import { resolvePerformancePresets } from "../dist/util/cpu-presets.js";
import {
  aggregateShapeSamples,
  buildBenchmarkShapes,
  evaluateProductionGate,
  rankQualifyingCandidates,
  runBenchmarkChild,
} from "./cpu-embedding-benchmark-contract.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CORPUS_ROOTS = ["src/indexer", "src/db", "src/mcp"];
const CORPUS_SIZE = 192;
const QUICK_CORPUS_SIZE = 48;
const MIN_EXCERPT_LENGTH = 80;
const MAX_EXCERPT_LENGTH = 1_800;
const MODEL_NAME = "jina-embeddings-v2-base-code";
const WIDTH = 8;
const GIB = 1024 ** 3;
const FULL_SAMPLES = 3;
const QUICK_SAMPLES = 1;
// Fixed synthetic resources define the reproducible ample-memory width-8 profile.
const productionPresets = resolvePerformancePresets(
  "extreme",
  {},
  { logicalCores: 16, physicalCores: 8 },
  8 * GIB,
);
const { serializeRuns: _serializeRuns, ...productionSessionOptions } =
  resolveEmbeddingSessionOptions({
    requestedProviders: ["cpu"],
    onnxConfig: undefined,
    deterministic: false,
    autoThreads: WIDTH,
    platformOverride: ["cpu"],
  });
const SHAPES = buildBenchmarkShapes({
  batchSize: productionPresets.embeddingBatchSize,
  concurrency: productionPresets.embeddingConcurrency,
  ...productionSessionOptions,
});

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collectTypeScriptPaths(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptPaths(entryPath);
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );
  return paths.flat();
}

async function collectCorpus(size) {
  const sourcePaths = (
    await Promise.all(
      CORPUS_ROOTS.map((directory) => collectTypeScriptPaths(resolve(ROOT, directory))),
    )
  )
    .flat()
    .map((path) => relative(ROOT, path).split(sep).join("/"))
    .sort(compareText);

  const excerpts = [];
  for (const path of sourcePaths) {
    const source = (await readFile(resolve(ROOT, path), "utf8")).replace(/\r\n?/gu, "\n");
    // Fixed normalized boundaries make this an inference benchmark, not a corpus sampler.
    const text = source.slice(0, MAX_EXCERPT_LENGTH);
    if (text.length >= MIN_EXCERPT_LENGTH) {
      excerpts.push({ path, start: 0, length: text.length, text });
    }
  }

  excerpts.sort(
    (left, right) =>
      left.length - right.length ||
      compareText(left.path, right.path) ||
      left.start - right.start,
  );
  if (excerpts.length < size) {
    throw new Error(
      `Expected at least ${size} TypeScript excerpts from ${CORPUS_ROOTS.join(", ")}; found ${excerpts.length}`,
    );
  }
  return excerpts.slice(0, size).map(({ text }) => text);
}

function batches(texts, batchSize) {
  return Array.from(
    { length: Math.ceil(texts.length / batchSize) },
    (_, index) => texts.slice(index * batchSize, (index + 1) * batchSize),
  );
}

async function runShape({ session, tokenizer, dimension, texts, batchSize, concurrency }) {
  let completed = 0;
  const work = batches(texts, batchSize);
  for (let index = 0; index < work.length; index += concurrency) {
    const results = await Promise.all(
      work
        .slice(index, index + concurrency)
        .map((batch) => runBatchInference(session, tokenizer, batch, dimension, ort)),
    );
    completed += results.reduce((total, result) => total + result.length, 0);
  }
  if (completed !== texts.length) {
    throw new Error(`Inference completed ${completed} texts; expected ${texts.length}`);
  }
}

async function measureShape(shape) {
  const [modelPath, tokenizerPath] = [
    resolveModelPath(MODEL_NAME),
    resolveTokenizerPath(MODEL_NAME),
  ];
  await Promise.all([access(modelPath), access(tokenizerPath)]);

  const texts = await collectCorpus(shape.texts);
  const model = getModelInfo(MODEL_NAME);
  const tokenizer = Tokenizer.fromFile(tokenizerPath);
  tokenizer.setPadding({ padId: 0, padToken: "[PAD]" });
  tokenizer.setTruncation(model.maxSequenceLength);

  let session;
  try {
    const {
      id: _id,
      batchSize,
      concurrency,
      texts: _texts,
      ...sessionOptions
    } = shape;
    session = await ort.InferenceSession.create(modelPath, sessionOptions);

    await runShape({
      session,
      tokenizer,
      dimension: model.dimension,
      texts,
      batchSize,
      concurrency,
    });
    const started = performance.now();
    await runShape({
      session,
      tokenizer,
      dimension: model.dimension,
      texts,
      batchSize,
      concurrency,
    });
    const milliseconds = performance.now() - started;
    return {
      ...shape,
      milliseconds,
      textsPerSecond: (texts.length * 1_000) / milliseconds,
    };
  } finally {
    if (session) await session.release();
  }
}

function formatMilliseconds(value) {
  return `${value.toFixed(2)} ms`;
}

function formatRate(value) {
  return `${value.toFixed(2)} texts/s`;
}

function formatMiB(kibibytes) {
  return `${(kibibytes / 1_024).toFixed(1)} MiB`;
}

async function runParent(quick) {
  const sampleCount = quick ? QUICK_SAMPLES : FULL_SAMPLES;
  const textCount = quick ? QUICK_CORPUS_SIZE : CORPUS_SIZE;
  const results = [];
  for (const shape of SHAPES) {
    const measuredShape = { ...shape, texts: textCount };
    const samples = [];
    // Await each child so every sample starts with a fresh, uncontended process.
    for (let sample = 0; sample < sampleCount; sample++) {
      samples.push(
        await runBenchmarkChild({
          scriptPath: SCRIPT_PATH,
          cwd: ROOT,
          shape: measuredShape,
        }),
      );
    }
    results.push(aggregateShapeSamples(measuredShape, samples, sampleCount));
  }
  const baseline = results.find(({ id }) => id === "baseline");
  const production = results.find(({ id }) => id === "production");
  if (!baseline || !production) {
    throw new Error("Benchmark shape construction omitted baseline or production");
  }

  console.log(
    `CPU embedding tier benchmark (${quick ? "quick" : "full"}): width=${WIDTH}, samples=${sampleCount}, inference path only (not persistence, HNSW, or total index time).`,
  );
  for (const result of results) {
    const uplift = ((result.medianTextsPerSecond / baseline.medianTextsPerSecond) - 1) * 100;
    console.log(
      `${result.id}: batch=${result.batchSize}, concurrency=${result.concurrency}, arena=${result.enableCpuMemArena ? "on" : "off"}; median=${formatMilliseconds(result.medianMilliseconds)} (${formatRate(result.medianTextsPerSecond)}); worstPeakRSS=${formatMiB(result.worstMaxRssKiB)}; uplift=${uplift.toFixed(2)}%`,
    );
  }

  if (quick) {
    // Quick mode validates the process boundary, never the performance gate.
    console.log("NOT GATED: quick mode validates process and record plumbing only.");
    return;
  }

  const rankedCandidates = rankQualifyingCandidates({
    baseline,
    candidates: results.filter(({ id }) => id.startsWith("batch-")),
  });
  console.log(
    rankedCandidates.length > 0
      ? `experimental recommendation evidence=${rankedCandidates.map(({ id }) => id).join(",")}`
      : "experimental recommendation evidence=none qualified",
  );

  const gate = evaluateProductionGate({ baseline, production });
  console.log(
    `production gate: peakRSS limit=${formatMiB(gate.memoryLimitKiB)}; uplift=${gate.upliftPercent.toFixed(2)}%`,
  );
  if (!gate.passed) {
    console.log(
      `FAIL: built production tuple missed ${[
        !gate.throughputPassed && "throughput",
        !gate.memoryPassed && "peak RSS",
      ].filter(Boolean).join(" and ")} gate.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("PASS: built production tuple meets throughput and peak RSS gates.");
}

async function main() {
  const quick = process.argv.includes("--quick");
  const childIndex = process.argv.indexOf("--child");
  if (childIndex !== -1) {
    const shape = JSON.parse(process.argv[childIndex + 1]);
    const result = await measureShape(shape);
    console.log(JSON.stringify({ ...result, maxRssKiB: process.resourceUsage().maxRSS }));
    return;
  }
  await runParent(quick);
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
