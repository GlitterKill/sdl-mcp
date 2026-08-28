import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

const SCRIPT_PATH = resolve("scripts/postinstall-models.mjs");

function isolatedModelEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    LOCALAPPDATA: root,
    SDL_MCP_SKIP_MODEL_DOWNLOAD: "1",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const FIXTURE_FILES = [
  "model_fp16.onnx",
  "model_quantized.onnx",
  "tokenizer.json",
  "config.json",
] as const;

const FIXTURE_CONTENTS = {
  "model_fp16.onnx": "fp16",
  "model_quantized.onnx": "quantized",
  "tokenizer.json": '{"tokenizer":true}',
  "config.json": '{"config":true}',
} as const;

function createFixtureModel() {
  return {
    name: "fixture-model",
    files: [...FIXTURE_FILES],
    maxBytes: 1024,
    sha256: Object.fromEntries(
      FIXTURE_FILES.map((fileName) => [
        fileName,
        sha256(FIXTURE_CONTENTS[fileName]),
      ]),
    ),
    primary: Object.fromEntries(
      FIXTURE_FILES.map((fileName) => [
        fileName,
        `https://primary.test/${fileName}`,
      ]),
    ),
    fallback: Object.fromEntries(
      FIXTURE_FILES.filter((fileName) => fileName !== "model_fp16.onnx").map(
        (fileName) => [fileName, `https://fallback.test/${fileName}`],
      ),
    ),
  };
}

function isolateModelCache(t: TestContext, root: string): void {
  const originalHome = process.env.HOME;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalFetch = globalThis.fetch;
  process.env.HOME = root;
  process.env.LOCALAPPDATA = root;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    globalThis.fetch = originalFetch;
  });
}

test("postinstall model setup stays soft by default", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sdl-model-soft-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    env: isolatedModelEnvironment(root),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /skipping model download/i);
});

test("strict postinstall model setup fails when required artifacts are absent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sdl-model-strict-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [SCRIPT_PATH, "--strict"], {
    env: isolatedModelEnvironment(root),
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /required model artifacts.*missing|unverified/i,
  );
});

test("model artifact verification checks content hashes and JSON syntax", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sdl-model-verify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelDir = join(root, "fixture-model");
  mkdirSync(modelDir, { recursive: true });

  const modelBytes = "fixture-onnx";
  const tokenizer = '{"model":{"type":"WordPiece"}}';
  const config = '{"hidden_size":768}';
  writeFileSync(join(modelDir, "model_quantized.onnx"), modelBytes);
  writeFileSync(join(modelDir, "tokenizer.json"), tokenizer);
  writeFileSync(join(modelDir, "config.json"), config);

  const model = {
    name: "fixture-model",
    files: ["model_quantized.onnx", "tokenizer.json", "config.json"],
    maxBytes: 1024,
    sha256: {
      "model_quantized.onnx": sha256(modelBytes),
      "tokenizer.json": sha256(tokenizer),
      "config.json": sha256(config),
    },
  };
  const scriptUrl = pathToFileURL(SCRIPT_PATH).href;
  const verify = (): { ok: boolean; errors: string[] } => {
    const verifyCode = `
      const { verifyModelArtifacts } = await import(${JSON.stringify(scriptUrl)});
      const result = verifyModelArtifacts(
        ${JSON.stringify(model)},
        ${JSON.stringify(modelDir)}
      );
      process.stdout.write(JSON.stringify(result));
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", verifyCode],
      {
        env: isolatedModelEnvironment(root),
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0);
    return JSON.parse(result.stdout) as { ok: boolean; errors: string[] };
  };

  assert.deepEqual(verify(), { ok: true, errors: [] });

  writeFileSync(join(modelDir, "model_quantized.onnx"), "corrupt-onnx");
  assert.match(
    verify().errors.join("\n"),
    /model_quantized\.onnx.*SHA-256 verification/i,
  );

  writeFileSync(join(modelDir, "model_quantized.onnx"), modelBytes);
  const oversizedModel = "x".repeat(model.maxBytes + 1);
  writeFileSync(join(modelDir, "model_quantized.onnx"), oversizedModel);
  model.sha256["model_quantized.onnx"] = sha256(oversizedModel);
  assert.match(
    verify().errors.join("\n"),
    /model_quantized\.onnx.*no larger than 1024 bytes/i,
  );

  writeFileSync(join(modelDir, "model_quantized.onnx"), modelBytes);
  model.sha256["model_quantized.onnx"] = sha256(modelBytes);

  const invalidTokenizer = "{";
  writeFileSync(join(modelDir, "tokenizer.json"), invalidTokenizer);
  model.sha256["tokenizer.json"] = sha256(invalidTokenizer);
  const invalid = verify();
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("\n"), /tokenizer\.json.*valid JSON/i);

  writeFileSync(join(modelDir, "tokenizer.json"), tokenizer);
  model.sha256["tokenizer.json"] = sha256(tokenizer);
  assert.deepEqual(verify(), { ok: true, errors: [] });
});

test("strict refresh preserves valid cached files when FP16 download fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sdl-model-preserve-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  isolateModelCache(t, root);

  const module = await import(pathToFileURL(SCRIPT_PATH).href);
  const ensureModel = Reflect.get(module, "ensureModel") as
    | ((
        model: ReturnType<typeof createFixtureModel>,
        strict: boolean,
      ) => Promise<void>)
    | undefined;
  const getModelCacheDir = Reflect.get(
    module,
    "getModelCacheDir",
  ) as () => string;
  assert.equal(typeof ensureModel, "function");
  if (typeof ensureModel !== "function") return;

  const contents = FIXTURE_CONTENTS;
  const model = createFixtureModel();
  const modelDir = join(getModelCacheDir(), model.name);
  mkdirSync(modelDir, { recursive: true });
  for (const fileName of FIXTURE_FILES.slice(1)) {
    writeFileSync(join(modelDir, fileName), contents[fileName]);
  }
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;

  await assert.rejects(ensureModel(model, true));
  for (const fileName of FIXTURE_FILES.slice(1)) {
    assert.equal(
      readFileSync(join(modelDir, fileName), "utf8"),
      contents[fileName],
    );
  }
  assert.deepEqual(
    readdirSync(modelDir).filter((fileName) => fileName.endsWith(".tmp")),
    [],
  );

  writeFileSync(join(modelDir, "config.json"), "invalid");
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/config.json")) {
      return new Response(contents["config.json"]);
    }
    throw new Error("offline");
  }) as typeof fetch;
  await assert.rejects(ensureModel(model, true));
  assert.equal(
    readFileSync(join(modelDir, "config.json"), "utf8"),
    contents["config.json"],
  );
});

test("best-effort refresh continues after failures and reports every failed file", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sdl-model-continue-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  isolateModelCache(t, root);

  const module = await import(pathToFileURL(SCRIPT_PATH).href);
  const ensureModel = Reflect.get(module, "ensureModel") as
    | ((
        model: ReturnType<typeof createFixtureModel>,
        strict: boolean,
      ) => Promise<void>)
    | undefined;
  const getModelCacheDir = Reflect.get(
    module,
    "getModelCacheDir",
  ) as () => string;
  assert.equal(typeof ensureModel, "function");
  if (typeof ensureModel !== "function") return;

  const contents = FIXTURE_CONTENTS;
  const model = createFixtureModel();
  globalThis.fetch = (async (input) => {
    const url = String(input);
    const fileName = url.slice(url.lastIndexOf("/") + 1) as keyof typeof contents;
    if (fileName === "model_fp16.onnx" || fileName === "tokenizer.json") {
      throw new Error("offline");
    }
    return new Response(contents[fileName]);
  }) as typeof fetch;

  await assert.rejects(
    ensureModel(model, false),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /model_fp16\.onnx/);
      assert.match(error.message, /tokenizer\.json/);
      return true;
    },
  );

  const modelDir = join(getModelCacheDir(), model.name);
  assert.equal(
    readFileSync(join(modelDir, "model_quantized.onnx"), "utf8"),
    contents["model_quantized.onnx"],
  );
  assert.equal(
    readFileSync(join(modelDir, "config.json"), "utf8"),
    contents["config.json"],
  );
  assert.equal(existsSync(join(modelDir, "model_fp16.onnx")), false);
  assert.equal(existsSync(join(modelDir, "tokenizer.json")), false);
  assert.deepEqual(
    readdirSync(modelDir).filter((fileName) => fileName.endsWith(".tmp")),
    [],
  );
});

test("download aborts and removes partial files when streamed bytes exceed the cap", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sdl-model-stream-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const module = await import(pathToFileURL(SCRIPT_PATH).href);
  const downloadTo = Reflect.get(module, "downloadTo") as
    | ((url: string, destPath: string, maxBytes: number) => Promise<void>)
    | undefined;
  assert.equal(typeof downloadTo, "function");
  if (typeof downloadTo !== "function") return;

  for (const [label, contentLength] of [
    ["absent", undefined],
    ["incorrect", "1"],
  ] as const) {
    let pulls = 0;
    const totalChunks = 64;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(17));
            if (pulls === totalChunks) controller.close();
          },
        }),
        {
          headers:
            contentLength === undefined
              ? undefined
              : { "content-length": contentLength },
        },
      )) as typeof fetch;
    const destPath = join(root, `${label}.onnx`);

    await assert.rejects(
      downloadTo(`https://fixture.test/${label}`, destPath, 16),
      /Downloaded file exceeds cap/i,
    );
    assert.ok(pulls < totalChunks, `consumed the complete ${label} response`);
    assert.equal(existsSync(destPath), false);
  }
});

test("required model provenance pins immutable revisions and checksums", async () => {
  const module = await import(pathToFileURL(SCRIPT_PATH).href);
  const getProvenance = Reflect.get(module, "getRequiredModelProvenance");
  const getDigest = Reflect.get(module, "getRequiredModelSetDigest");

  assert.equal(typeof getProvenance, "function");
  assert.equal(typeof getDigest, "function");
  if (typeof getProvenance !== "function" || typeof getDigest !== "function") {
    return;
  }

  const provenance = getProvenance() as Array<{
    name: string;
    revision: string;
    files: Array<{
      name: string;
      primary: string;
      fallback?: string;
      sha256: string;
    }>;
  }>;
  assert.equal(provenance.length, 2);
  const jina = provenance.find(
    ({ name }) => name === "jina-embeddings-v2-base-code",
  );
  assert.deepEqual(
    jina?.files.map(({ name }) => name),
    [
      "model_fp16.onnx",
      "model_quantized.onnx",
      "tokenizer.json",
      "config.json",
    ],
  );
  assert.equal(
    jina?.files.find(({ name }) => name === "model_fp16.onnx")?.sha256,
    "1aafc4fcd63d2e6899e88402ff731e7c646c2e435048294a3cbc908a40d45d7c",
  );
  assert.equal(
    jina?.files.find(({ name }) => name === "model_quantized.onnx")?.sha256,
    "ed45870251c9f0cf656e78aab0d37a23489066df8a222bb1c8caf8a45f2cb16d",
  );
  assert.equal(
    jina?.files.find(({ name }) => name === "model_fp16.onnx")?.primary,
    "https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/516f4baf13dec4ddddda8631e019b5737c8bc250/onnx/model_fp16.onnx",
  );
  assert.equal(
    jina?.files.find(({ name }) => name === "model_quantized.onnx")?.primary,
    "https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/516f4baf13dec4ddddda8631e019b5737c8bc250/onnx/model_quantized.onnx",
  );
  assert.equal(
    jina?.files.find(({ name }) => name === "model_fp16.onnx")?.fallback,
    undefined,
  );

  const nomic = provenance.find(({ name }) => name === "nomic-embed-text-v1.5");
  assert.deepEqual(
    nomic?.files.map(({ name }) => name),
    ["model_quantized.onnx", "tokenizer.json", "config.json"],
  );
  for (const model of provenance) {
    assert.match(model.revision, /^[a-f0-9]{40}$/);
    for (const file of model.files) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.match(file.primary, new RegExp(`/resolve/${model.revision}/`));
      assert.doesNotMatch(file.primary, /\/resolve\/main\//);
      if (file.name !== "model_fp16.onnx") {
        assert.match(file.fallback ?? "", /\/releases\/assets\/\d+$/);
      }
    }
  }
  assert.match(getDigest(), /^[a-f0-9]{64}$/);
  assert.equal(getDigest(), getDigest());
});
