import { spawn } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-node";
import { Tokenizer } from "tokenizers";

import { runBatchInference } from "../dist/indexer/embeddings-local.js";
import {
  getModelInfo,
  resolveModelPath,
  resolveTokenizerPath,
} from "../dist/indexer/model-registry.js";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CORPUS_ROOTS = ["src/indexer", "src/db", "src/mcp"];
const CORPUS_SIZE = 192;
const QUICK_CORPUS_SIZE = 48;
const MIN_EXCERPT_LENGTH = 80;
const MAX_EXCERPT_LENGTH = 1_800;
const MODEL_NAME = "jina-embeddings-v2-base-code";
const WIDTH = 8;
const FULL_MEASURED_RUNS = 3;
const QUICK_MEASURED_RUNS = 1;
const SHAPES = [
  { id: "baseline", batchSize: 32, concurrency: 1, enableCpuMemArena: true },
  { id: "concurrency-8", batchSize: 32, concurrency: 8, enableCpuMemArena: true },
  { id: "batch-16", batchSize: 16, concurrency: 8, enableCpuMemArena: true },
  { id: "arena-off", batchSize: 16, concurrency: 8, enableCpuMemArena: false },
];

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

function median(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
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

async function measureShape(shape, quick) {
  const [modelPath, tokenizerPath] = [
    resolveModelPath(MODEL_NAME),
    resolveTokenizerPath(MODEL_NAME),
  ];
  await Promise.all([access(modelPath), access(tokenizerPath)]);

  const texts = await collectCorpus(quick ? QUICK_CORPUS_SIZE : CORPUS_SIZE);
  const model = getModelInfo(MODEL_NAME);
  const tokenizer = Tokenizer.fromFile(tokenizerPath);
  tokenizer.setPadding({ padId: 0, padToken: "[PAD]" });
  tokenizer.setTruncation(model.maxSequenceLength);

  let session;
  try {
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      intraOpNumThreads: WIDTH,
      interOpNumThreads: 1,
      executionMode: "sequential",
      enableMemPattern: true,
      enableCpuMemArena: shape.enableCpuMemArena,
      graphOptimizationLevel: "all",
      logSeverityLevel: 3,
    });

    await runShape({ session, tokenizer, dimension: model.dimension, texts, ...shape });
    const samples = [];
    for (let run = 0; run < (quick ? QUICK_MEASURED_RUNS : FULL_MEASURED_RUNS); run++) {
      const started = performance.now();
      await runShape({ session, tokenizer, dimension: model.dimension, texts, ...shape });
      samples.push(performance.now() - started);
    }
    const milliseconds = median(samples);
    return {
      ...shape,
      texts: texts.length,
      milliseconds,
      textsPerSecond: (texts.length * 1_000) / milliseconds,
    };
  } finally {
    if (session) await session.release();
  }
}

async function runChild(shape, quick) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [SCRIPT_PATH, "--child", JSON.stringify(shape), ...(quick ? ["--quick"] : [])],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Child ${shape.id} exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Child ${shape.id} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function formatMilliseconds(value) {
  return `${value.toFixed(2)} ms`;
}

function formatRate(value) {
  return `${value.toFixed(2)} texts/s`;
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function runParent(quick) {
  const results = [];
  for (const shape of SHAPES) {
    results.push(await runChild(shape, quick));
  }
  const baseline = results[0];
  const baselineRssBytes = baseline.maxRssKiB * 1_024;
  const memoryLimitBytes = baselineRssBytes + Math.max(baselineRssBytes * 0.1, 128 * 1024 * 1024);

  console.log(
    `CPU embedding tier benchmark (${quick ? "quick" : "full"}): width=${WIDTH}, inference path only (not persistence, HNSW, or total index time).`,
  );
  for (const result of results) {
    const uplift = ((result.textsPerSecond / baseline.textsPerSecond) - 1) * 100;
    console.log(
      `${result.id}: batch=${result.batchSize}, concurrency=${result.concurrency}, arena=${result.enableCpuMemArena ? "on" : "off"}; median=${formatMilliseconds(result.milliseconds)} (${formatRate(result.textsPerSecond)}); peakRSS=${formatMiB(result.maxRssKiB * 1_024)}; uplift=${uplift.toFixed(2)}%`,
    );
  }

  const qualifying = results.slice(1).filter((result) => result.maxRssKiB * 1_024 <= memoryLimitBytes);
  const selected = qualifying.sort(
    (left, right) => right.textsPerSecond - left.textsPerSecond || compareText(left.id, right.id),
  )[0];
  if (!selected) {
    console.log(`FAIL: no candidate stayed within the peak RSS limit of ${formatMiB(memoryLimitBytes)}.`);
    process.exitCode = 1;
    return;
  }

  const uplift = ((selected.textsPerSecond / baseline.textsPerSecond) - 1) * 100;
  console.log(`selected=${selected.id}; peakRSS limit=${formatMiB(memoryLimitBytes)}; uplift=${uplift.toFixed(2)}%`);
  if (uplift < 15) {
    console.log("FAIL: selected width-8 throughput uplift is below 15%.");
    process.exitCode = 1;
    return;
  }
  console.log("PASS: selected width-8 candidate meets throughput and peak RSS gates.");
}

async function main() {
  const quick = process.argv.includes("--quick");
  const childIndex = process.argv.indexOf("--child");
  if (childIndex !== -1) {
    const shape = JSON.parse(process.argv[childIndex + 1]);
    const result = await measureShape(shape, quick);
    console.log(JSON.stringify({ ...result, maxRssKiB: process.resourceUsage().maxRSS }));
    return;
  }
  await runParent(quick);
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
