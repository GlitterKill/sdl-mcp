#!/usr/bin/env node
/**
 * download-models.mjs — Dev script to fetch bundled ONNX model files from HuggingFace.
 *
 * Usage:
 *   node scripts/download-models.mjs                     # Download all-MiniLM-L6-v2
 *   node scripts/download-models.mjs nomic-embed-text-v1.5 # Download nomic text model
 */
import { existsSync, mkdirSync, createWriteStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { pipeline } from "stream/promises";
import { homedir } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

function getModelCacheDir() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      return join(localAppData, "sdl-mcp", "models");
    }
  }
  return join(homedir(), ".cache", "sdl-mcp", "models");
}

const MODELS = {
  "all-MiniLM-L6-v2": {
    dir: join(ROOT, "models", "all-MiniLM-L6-v2"),
    files: [
      {
        name: "model_quantized.onnx",
        url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx",
      },
      {
        name: "tokenizer.json",
        url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
      },
      {
        name: "config.json",
        url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/config.json",
      },
    ],
  },
  "nomic-embed-text-v1.5": {
    dir: join(getModelCacheDir(), "nomic-embed-text-v1.5"),
    files: [
      {
        name: "model_quantized.onnx",
        url: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model_quantized.onnx",
      },
      {
        name: "tokenizer.json",
        url: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/tokenizer.json",
      },
      {
        name: "config.json",
        url: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/config.json",
      },
    ],
  },
};

async function downloadFile(url, destPath) {
  if (existsSync(destPath)) {
    console.log(`  [skip] ${destPath} already exists`);
    return;
  }

  console.log(`  [downloading] ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const fileStream = createWriteStream(destPath);
  // @ts-ignore — Node 20+ fetch returns a web ReadableStream
  await pipeline(response.body, fileStream);

  const stats = await import("fs").then((fs) => fs.statSync(destPath));
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
  console.log(`  [done] ${destPath} (${sizeMB} MB)`);
}

async function downloadModel(modelName) {
  const model = MODELS[modelName];
  if (!model) {
    console.error(`Unknown model: ${modelName}`);
    console.error(`Available models: ${Object.keys(MODELS).join(", ")}`);
    process.exit(1);
  }

  console.log(`\nDownloading model: ${modelName}`);
  mkdirSync(model.dir, { recursive: true });

  for (const file of model.files) {
    await downloadFile(file.url, join(model.dir, file.name));
  }

  console.log(`Model ${modelName} ready at ${model.dir}\n`);
}

// Main
const requestedModel = process.argv[2] ?? "all-MiniLM-L6-v2";

if (requestedModel === "--all") {
  for (const modelName of Object.keys(MODELS)) {
    await downloadModel(modelName);
  }
} else {
  await downloadModel(requestedModel);
}
