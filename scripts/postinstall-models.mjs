#!/usr/bin/env node
/**
 * postinstall-models.mjs
 *
 * Fetches the ONNX embedding models used by semantic retrieval into the
 * user-level cache directory so the first semantic query doesn't pay the
 * download cost. Runs on `npm install` via scripts/postinstall.mjs.
 *
 * Tries the primary URL (HuggingFace) first, falls back to the project's
 * GitHub Releases mirror on any failure. Never aborts npm install.
 *
 * Keep this script dependency-free (plain Node 20+ fetch) so it works
 * before the dist/ tree is imported at runtime.
 */
import { existsSync, mkdirSync, statSync, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

// ---------------------------------------------------------------------------
// Model metadata (kept in sync with src/indexer/model-registry.ts)
// ---------------------------------------------------------------------------

const MODELS = [
  {
    name: "jina-embeddings-v2-base-code",
    files: ["model_quantized.onnx", "tokenizer.json", "config.json"],
    maxBytes: 200_000_000,
    primary: {
      "model_quantized.onnx":
        "https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/main/onnx/model_quantized.onnx",
      "tokenizer.json":
        "https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/main/tokenizer.json",
      "config.json":
        "https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/main/config.json",
    },
    fallback: {
      "model_quantized.onnx":
        "https://github.com/GlitterKill/sdl-mcp/releases/download/models-v1/jina-embeddings-v2-base-code-model_quantized.onnx",
      "tokenizer.json":
        "https://github.com/GlitterKill/sdl-mcp/releases/download/models-v1/jina-embeddings-v2-base-code-tokenizer.json",
      "config.json":
        "https://github.com/GlitterKill/sdl-mcp/releases/download/models-v1/jina-embeddings-v2-base-code-config.json",
    },
  },
  {
    name: "nomic-embed-text-v1.5",
    files: ["model_quantized.onnx", "tokenizer.json", "config.json"],
    maxBytes: 200_000_000,
    primary: {
      "model_quantized.onnx":
        "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model_quantized.onnx",
      "tokenizer.json":
        "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/tokenizer.json",
      "config.json":
        "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/config.json",
    },
    fallback: {
      "model_quantized.onnx":
        "https://github.com/GlitterKill/sdl-mcp/releases/download/models-v1/nomic-embed-text-v1.5-model_quantized.onnx",
      "tokenizer.json":
        "https://github.com/GlitterKill/sdl-mcp/releases/download/models-v1/nomic-embed-text-v1.5-tokenizer.json",
      "config.json":
        "https://github.com/GlitterKill/sdl-mcp/releases/download/models-v1/nomic-embed-text-v1.5-config.json",
    },
  },
];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getModelCacheDir() {
  if (platform() === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) return join(localAppData, "sdl-mcp", "models");
  }
  return join(homedir(), ".cache", "sdl-mcp", "models");
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

async function downloadTo(url, destPath, maxBytes) {
  const controller = new AbortController();
  const response = await fetch(url, {
    redirect: "follow",
    signal: controller.signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (maxBytes && declared && declared > maxBytes) {
    controller.abort();
    throw new Error(
      `Refusing to download ${declared} bytes (> ${maxBytes} cap)`,
    );
  }
  if (!response.body) throw new Error("Empty response body");
  const out = createWriteStream(destPath);
  try {
    await pipeline(response.body, out);
  } catch (err) {
    try {
      await rm(destPath, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
  if (maxBytes) {
    const { size } = statSync(destPath);
    if (size > maxBytes) {
      await rm(destPath, { force: true });
      throw new Error(`Downloaded file exceeds cap: ${size} > ${maxBytes}`);
    }
  }
}

async function fetchFile(model, fileName, destPath) {
  const primary = model.primary[fileName];
  const fallback = model.fallback?.[fileName];
  try {
    await downloadTo(primary, destPath, model.maxBytes);
    return { source: "primary" };
  } catch (primaryErr) {
    if (!fallback) throw primaryErr;
    console.log(`  primary failed (${primaryErr.message}); trying fallback...`);
    try {
      await downloadTo(fallback, destPath, model.maxBytes);
      return { source: "fallback" };
    } catch (fallbackErr) {
      throw new Error(
        `both primary and fallback failed. primary=${primaryErr.message}; fallback=${fallbackErr.message}`,
      );
    }
  }
}

async function ensureModel(model) {
  const dir = join(getModelCacheDir(), model.name);
  const allPresent = model.files.every((f) => existsSync(join(dir, f)));
  if (allPresent) {
    console.log(`sdl-mcp: model "${model.name}" already cached at ${dir}`);
    return;
  }
  console.log(`sdl-mcp: fetching model "${model.name}" → ${dir}`);
  mkdirSync(dir, { recursive: true });
  for (const fileName of model.files) {
    const destPath = join(dir, fileName);
    if (existsSync(destPath)) {
      console.log(`  [skip] ${fileName}`);
      continue;
    }
    process.stdout.write(`  downloading ${fileName}... `);
    const { source } = await fetchFile(model, fileName, destPath);
    const sizeMB = (statSync(destPath).size / (1024 * 1024)).toFixed(1);
    console.log(`${sizeMB} MB (${source})`);
  }
  console.log(`sdl-mcp: model "${model.name}" ready`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (process.env.SDL_MCP_SKIP_MODEL_DOWNLOAD === "1") {
  console.log(
    "sdl-mcp: SDL_MCP_SKIP_MODEL_DOWNLOAD=1 set; skipping model download",
  );
  process.exit(0);
}

let failed = 0;
for (const model of MODELS) {
  try {
    await ensureModel(model);
  } catch (err) {
    failed += 1;
    console.warn(
      `sdl-mcp: failed to fetch model "${model.name}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

if (failed > 0) {
  console.warn(
    `sdl-mcp: ${failed} model download(s) failed. Semantic retrieval will lazily retry on first use. ` +
      `Set SDL_MCP_SKIP_MODEL_DOWNLOAD=1 to silence this step.`,
  );
}

// Never exit non-zero — npm install must not fail because a model download did.
process.exit(0);
