#!/usr/bin/env node
/**
 * postinstall-models.mjs
 *
 * Fetches the ONNX embedding models used by semantic retrieval into the
 * user-level cache directory so the first semantic query doesn't pay the
 * download cost. Runs on `npm install` via scripts/postinstall.mjs.
 *
 * Tries the primary URL (HuggingFace) first, then any configured GitHub
 * Releases mirror. Never aborts npm install.
 *
 * Keep this script dependency-free (plain Node 20+ fetch) so it works
 * before the dist/ tree is imported at runtime.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Model metadata (kept in sync with src/indexer/model-registry.ts)
// ---------------------------------------------------------------------------

const JINA_REVISION = "516f4baf13dec4ddddda8631e019b5737c8bc250";
const NOMIC_REVISION = "e5cf08aadaa33385f5990def41f7a23405aec398";
const GITHUB_RELEASE_ASSET =
  "https://api.github.com/repos/GlitterKill/sdl-mcp/releases/assets";

const MODELS = [
  {
    name: "jina-embeddings-v2-base-code",
    revision: JINA_REVISION,
    files: [
      "model_fp16.onnx",
      "model_quantized.onnx",
      "tokenizer.json",
      "config.json",
    ],
    maxBytes: 400_000_000,
    sha256: {
      "model_fp16.onnx":
        "1aafc4fcd63d2e6899e88402ff731e7c646c2e435048294a3cbc908a40d45d7c",
      "model_quantized.onnx":
        "ed45870251c9f0cf656e78aab0d37a23489066df8a222bb1c8caf8a45f2cb16d",
      "tokenizer.json":
        "b01c78a902aa4facb2f47f95449f48e2f7bbfea5d2472ee2f6ce92323c6f86e5",
      "config.json":
        "e426aa684c7f9a95c5f020aa855faf93a24f065f5fad0c9e17b124670cabdea6",
    },
    primary: {
      "model_fp16.onnx":
        `https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/${JINA_REVISION}/onnx/model_fp16.onnx`,
      "model_quantized.onnx":
        `https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/${JINA_REVISION}/onnx/model_quantized.onnx`,
      "tokenizer.json":
        `https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/${JINA_REVISION}/tokenizer.json`,
      "config.json":
        `https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/${JINA_REVISION}/config.json`,
    },
    fallback: {
      "model_quantized.onnx":
        `${GITHUB_RELEASE_ASSET}/400166875`,
      "tokenizer.json":
        `${GITHUB_RELEASE_ASSET}/400166865`,
      "config.json":
        `${GITHUB_RELEASE_ASSET}/400166863`,
    },
  },
  {
    name: "nomic-embed-text-v1.5",
    revision: NOMIC_REVISION,
    files: ["model_quantized.onnx", "tokenizer.json", "config.json"],
    maxBytes: 200_000_000,
    sha256: {
      "model_quantized.onnx":
        "b4342336debaea79de872370664b0aaeb67dea4605513d00ee236ea871a81f27",
      "tokenizer.json":
        "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
      "config.json":
        "0168e0883705b0bf8f2b381e10f45a9f3e1ef4b13869b43c160e4c8a70ddf442",
    },
    primary: {
      "model_quantized.onnx":
        `https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/${NOMIC_REVISION}/onnx/model_quantized.onnx`,
      "tokenizer.json":
        `https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/${NOMIC_REVISION}/tokenizer.json`,
      "config.json":
        `https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/${NOMIC_REVISION}/config.json`,
    },
    fallback: {
      "model_quantized.onnx":
        `${GITHUB_RELEASE_ASSET}/400166907`,
      "tokenizer.json":
        `${GITHUB_RELEASE_ASSET}/400166864`,
      "config.json":
        `${GITHUB_RELEASE_ASSET}/400166862`,
    },
  },
];

export function getRequiredModelProvenance() {
  return MODELS.map((model) => ({
    name: model.name,
    revision: model.revision,
    files: model.files.map((name) => ({
      name,
      primary: model.primary[name],
      fallback: model.fallback[name],
      sha256: model.sha256[name],
    })),
  }));
}

export function getRequiredModelSetDigest() {
  return createHash("sha256")
    .update(JSON.stringify(getRequiredModelProvenance()), "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getModelCacheDir() {
  if (platform() === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) return join(localAppData, "sdl-mcp", "models");
  }
  return join(homedir(), ".cache", "sdl-mcp", "models");
}

// ---------------------------------------------------------------------------
// Verification + download helpers
// ---------------------------------------------------------------------------

function sha256File(filePath) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(filePath, "r");
  try {
    let bytesRead;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function verifyModelArtifact(model, fileName, filePath) {
  const errors = [];
  if (!existsSync(filePath)) {
    return [`${fileName} is missing`];
  }

  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size === 0 || stats.size > model.maxBytes) {
    return [
      `${fileName} must be a non-empty regular file no larger than ${model.maxBytes} bytes`,
    ];
  }

  const expectedHash = model.sha256[fileName];
  if (!expectedHash || sha256File(filePath) !== expectedHash) {
    return [`${fileName} failed SHA-256 verification`];
  }

  if (fileName.endsWith(".json")) {
    try {
      JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      errors.push(`${fileName} must contain valid JSON`);
    }
  }
  return errors;
}

export function verifyModelArtifacts(model, modelDir) {
  const errors = [];
  for (const fileName of model.files) {
    errors.push(
      ...verifyModelArtifact(model, fileName, join(modelDir, fileName)),
    );
  }
  return { ok: errors.length === 0, errors };
}

export async function downloadTo(url, destPath, maxBytes) {
  const controller = new AbortController();
  const response = await fetch(url, {
    redirect: "follow",
    signal: controller.signal,
    ...(url.startsWith(GITHUB_RELEASE_ASSET)
      ? {
          headers: {
            Accept: "application/octet-stream",
            "User-Agent": "sdl-mcp-model-installer",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      : {}),
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
  let streamedBytes = 0;
  const byteLimiter = new Transform({
    transform(chunk, _encoding, callback) {
      streamedBytes += chunk.length;
      if (maxBytes && streamedBytes > maxBytes) {
        controller.abort();
        callback(
          new Error(
            `Downloaded file exceeds cap: ${streamedBytes} > ${maxBytes}`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(response.body, byteLimiter, out);
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
  const downloadAndVerify = async (url, source) => {
    await rm(destPath, { force: true });
    await downloadTo(url, destPath, model.maxBytes);
    const errors = verifyModelArtifact(model, fileName, destPath);
    if (errors.length > 0) throw new Error(errors.join("; "));
    return { source };
  };
  try {
    return await downloadAndVerify(primary, "primary");
  } catch (primaryErr) {
    if (!fallback) throw primaryErr;
    const primaryMessage =
      primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    console.log(`  primary failed (${primaryMessage}); trying fallback...`);
    try {
      return await downloadAndVerify(fallback, "fallback");
    } catch (fallbackErr) {
      const fallbackMessage =
        fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(
        `both primary and fallback failed. primary=${primaryMessage}; fallback=${fallbackMessage}`,
      );
    }
  }
}

export async function ensureModel(model, strict) {
  const dir = join(getModelCacheDir(), model.name);
  const filesToFetch = model.files.filter((fileName) =>
    strict
      ? verifyModelArtifact(model, fileName, join(dir, fileName)).length > 0
      : !existsSync(join(dir, fileName)),
  );
  if (filesToFetch.length === 0) {
    console.log(`sdl-mcp: model "${model.name}" already cached at ${dir}`);
    return;
  }

  if (strict && model.files.some((fileName) => existsSync(join(dir, fileName)))) {
    console.log(
      `sdl-mcp: model "${model.name}" cache failed verification; refreshing invalid artifacts`,
    );
  }

  console.log(`sdl-mcp: fetching model "${model.name}" → ${dir}`);
  mkdirSync(dir, { recursive: true });
  const failures = [];
  for (const fileName of filesToFetch) {
    const destPath = join(dir, fileName);
    // Stage beside the destination so failed downloads never disturb a valid cache.
    const stagedPath = `${destPath}.${process.pid}-${randomUUID()}.tmp`;
    process.stdout.write(`  downloading ${fileName}... `);
    try {
      const { source } = await fetchFile(model, fileName, stagedPath);
      renameSync(stagedPath, destPath);
      const sizeMB = (statSync(destPath).size / (1024 * 1024)).toFixed(1);
      console.log(`${sizeMB} MB (${source})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${fileName}: ${message}`);
      console.log(`failed (${message})`);
    } finally {
      await rm(stagedPath, { force: true });
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
  console.log(`sdl-mcp: model "${model.name}" ready`);

  if (strict) {
    const refreshed = verifyModelArtifacts(model, dir);
    if (!refreshed.ok) {
      throw new Error(refreshed.errors.join("; "));
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runPostinstallModels({
  strict = false,
  skipDownload = process.env.SDL_MCP_SKIP_MODEL_DOWNLOAD === "1",
} = {}) {
  if (skipDownload && !strict) {
    console.log(
      "sdl-mcp: SDL_MCP_SKIP_MODEL_DOWNLOAD=1 set; skipping model download",
    );
    return 0;
  }

  let failed = 0;
  for (const model of MODELS) {
    try {
      if (!skipDownload) {
        await ensureModel(model, strict);
      }
      if (strict) {
        const verification = verifyModelArtifacts(
          model,
          join(getModelCacheDir(), model.name),
        );
        if (!verification.ok) {
          throw new Error(verification.errors.join("; "));
        }
      }
    } catch (err) {
      failed += 1;
      console.warn(
        `sdl-mcp: failed to fetch model "${model.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (failed > 0) {
    if (strict) {
      console.error(
        `sdl-mcp: required model artifacts are missing or unverified (${failed} model(s))`,
      );
      return 1;
    }
    console.warn(
      `sdl-mcp: ${failed} model download(s) failed. Semantic retrieval will lazily retry on first use. ` +
        `Set SDL_MCP_SKIP_MODEL_DOWNLOAD=1 to silence this step.`,
    );
  }

  // Default postinstall remains best-effort so model availability never
  // prevents npm from installing the package.
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.exitCode = await runPostinstallModels({
    strict: process.argv.includes("--strict"),
  });
}
