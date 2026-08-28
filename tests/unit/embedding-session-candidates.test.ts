import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { logger } from "../../dist/util/logger.js";
import {
  OnnxSessionCreationError,
  createOnnxSession,
  resetLocalEmbeddingRuntime,
} from "../../dist/indexer/embeddings-local.js";

const JINA = "jina-embeddings-v2-base-code";

function sessionFor(candidate: {
  variantName: string;
  modelFile: string;
  requestedProviders: readonly string[];
  cacheCompatibilityKey?: string;
}) {
  return {
    embed: async (_texts: string[]) => [],
    dimension: 768,
    modelName: JINA,
    variantName: candidate.variantName,
    modelFile: candidate.modelFile,
    executionProviders: candidate.requestedProviders,
    cacheCompatibilityKey: candidate.cacheCompatibilityKey,
    dispose() {},
  };
}

afterEach(async () => {
  await resetLocalEmbeddingRuntime();
});

describe("createOnnxSession candidate selection", () => {
  it("falls back from automatic DML FP16 to quantized CPU and reports the selected identity", async () => {
    const attempts: string[] = [];
    const warnings: string[] = [];
    const infos: string[] = [];
    const originalWarn = logger.warn;
    const originalInfo = logger.info;
    logger.warn = (message) => warnings.push(message);
    logger.info = (message) => infos.push(message);

    try {
      const session = await createOnnxSession(
        JINA,
        { modelVariant: "default", executionProviders: ["dml", "cpu"] },
        async (_modelName, candidate) => {
          attempts.push(candidate.variantName);
          if (candidate.variantName === "fp16") {
            throw new OnnxSessionCreationError("fp16 unavailable");
          }
          return sessionFor(candidate);
        },
      );

      assert.deepStrictEqual(attempts, ["fp16", "default"]);
      assert.strictEqual(session.variantName, "default");
      assert.strictEqual(session.modelFile, "model_quantized.onnx");
      assert.deepStrictEqual(session.executionProviders, ["cpu"]);
      assert.strictEqual(
        session.cacheCompatibilityKey,
        "jina-embeddings-v2-base-code:model_quantized.onnx",
      );
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0] ?? "", /fp16/);
      assert.match(warnings[0] ?? "", /default/);
      assert.ok(
        infos.some(
          (message) =>
            message.includes(JINA) &&
            message.includes('variant="default"') &&
            message.includes("model_quantized.onnx") &&
            message.includes("providers=[cpu]"),
        ),
      );
    } finally {
      logger.warn = originalWarn;
      logger.info = originalInfo;
    }
  });

  it("does not retry explicit FP16 or automatic requests without adjacent CPU fallback", async () => {
    const cases = [
      { options: { modelVariant: "fp16", executionProviders: ["dml", "cpu"] } },
      { options: { modelVariant: "default", executionProviders: ["dml"] } },
      { options: { modelVariant: "default", executionProviders: ["dml", "cuda", "cpu"] } },
    ];

    for (const { options } of cases) {
      const attempts: string[] = [];
      await assert.rejects(
        createOnnxSession(JINA, options, async (_modelName, candidate) => {
          attempts.push(candidate.variantName);
          throw new OnnxSessionCreationError("unavailable");
        }),
        OnnxSessionCreationError,
      );
      assert.deepStrictEqual(attempts, ["fp16"]);
      await resetLocalEmbeddingRuntime();
    }
  });

  it("uses quantized CPU only for deterministic automatic requests", async () => {
    const attempts: Array<[string, readonly string[]]> = [];
    const session = await createOnnxSession(
      JINA,
      {
        deterministic: true,
        modelVariant: "default",
        executionProviders: ["dml", "cpu"],
      },
      async (_modelName, candidate) => {
        attempts.push([candidate.variantName, candidate.requestedProviders]);
        return sessionFor(candidate);
      },
    );

    assert.deepStrictEqual(attempts, [["default", ["cpu"]]]);
    assert.deepStrictEqual(session.executionProviders, ["cpu"]);
  });

  it("separates cache entries by explicit variant and provider order while sharing automatic default", async () => {
    let calls = 0;
    const loader = async (_modelName: string, candidate: Parameters<typeof sessionFor>[0]) => {
      calls++;
      return sessionFor(candidate);
    };
    const defaultOptions = { executionProviders: ["cpu", "dml"] };

    const omitted = await createOnnxSession(JINA, defaultOptions, loader);
    const literal = await createOnnxSession(
      JINA,
      { ...defaultOptions, modelVariant: "default" },
      loader,
    );
    const explicitFp16 = await createOnnxSession(
      JINA,
      { modelVariant: "fp16", executionProviders: ["cpu", "dml"] },
      loader,
    );
    const reordered = await createOnnxSession(
      JINA,
      { modelVariant: "default", executionProviders: ["dml", "cpu"] },
      loader,
    );

    assert.strictEqual(omitted, literal);
    assert.notStrictEqual(omitted, explicitFp16);
    assert.notStrictEqual(omitted, reordered);
    assert.strictEqual(calls, 3);

    omitted.dispose();
    const retainedFp16 = await createOnnxSession(
      JINA,
      { modelVariant: "fp16", executionProviders: ["cpu", "dml"] },
      loader,
    );
    const retainedReordered = await createOnnxSession(
      JINA,
      { modelVariant: "default", executionProviders: ["dml", "cpu"] },
      loader,
    );
    assert.strictEqual(retainedFp16, explicitFp16);
    assert.strictEqual(retainedReordered, reordered);
    assert.strictEqual(calls, 3);

    const reloadedDefault = await createOnnxSession(JINA, defaultOptions, loader);
    assert.notStrictEqual(reloadedDefault, omitted);
    assert.strictEqual(calls, 4);
  });

  it("does not reuse deterministic requests with different configured provider order", async () => {
    let calls = 0;
    const loader = async (_modelName: string, candidate: Parameters<typeof sessionFor>[0]) => {
      calls++;
      return sessionFor(candidate);
    };

    const dmlThenCpu = await createOnnxSession(
      JINA,
      { deterministic: true, modelVariant: "default", executionProviders: ["dml", "cpu"] },
      loader,
    );
    const cpuThenDml = await createOnnxSession(
      JINA,
      { deterministic: true, modelVariant: "default", executionProviders: ["cpu", "dml"] },
      loader,
    );

    assert.notStrictEqual(dmlThenCpu, cpuThenDml);
    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(dmlThenCpu.executionProviders, ["cpu"]);
    assert.deepStrictEqual(cpuThenDml.executionProviders, ["cpu"]);
  });

  it("does not collide provider requests whose comma-joined forms match", async () => {
    const candidates: string[] = [];
    const loader = async (_modelName: string, candidate: Parameters<typeof sessionFor>[0]) => {
      candidates.push(`${candidate.variantName}/${candidate.modelFile}`);
      return sessionFor(candidate);
    };

    const commaProvider = await createOnnxSession(
      JINA,
      { modelVariant: "default", executionProviders: ["dml,cpu"] },
      loader,
    );
    const separateProviders = await createOnnxSession(
      JINA,
      { modelVariant: "default", executionProviders: ["dml", "cpu"] },
      loader,
    );

    assert.notStrictEqual(commaProvider, separateProviders);
    assert.deepStrictEqual(candidates, [
      "default/model_quantized.onnx",
      "fp16/model_fp16.onnx",
    ]);
  });

  it("keeps a replacement cached when a stale shared session is disposed again", async () => {
    let calls = 0;
    let releases = 0;
    const loader = async (_modelName: string, candidate: Parameters<typeof sessionFor>[0]) => {
      calls++;
      return {
        ...sessionFor(candidate),
        dispose() {
          releases++;
        },
      };
    };
    const options = { modelVariant: "default", executionProviders: ["cpu"] };

    const original = await createOnnxSession(JINA, options, loader);
    const sharedReference = await createOnnxSession(JINA, options, loader);
    assert.strictEqual(original, sharedReference);

    original.dispose();
    const replacement = await createOnnxSession(JINA, options, loader);
    sharedReference.dispose();
    const retainedReplacement = await createOnnxSession(JINA, options, loader);

    assert.strictEqual(retainedReplacement, replacement);
    assert.strictEqual(calls, 2);
    assert.strictEqual(releases, 1);
  });

  for (const [kind, message] of [
    ["artifact availability", "artifact unavailable"],
    ["model path", "model path unavailable"],
    ["dynamic import or configuration", "runtime import unavailable"],
    ["tokenizer", "tokenizer unavailable"],
    ["other loader", "unexpected loader failure"],
  ]) {
    it(`returns the original ${kind} error without fallback`, async () => {
      let attempts = 0;
      const expected = new Error(message);
      const options = { modelVariant: "default", executionProviders: ["dml", "cpu"] };

      await assert.rejects(
        createOnnxSession(JINA, options, async (_modelName, candidate) => {
          attempts++;
          assert.strictEqual(candidate.variantName, "fp16");
          throw expected;
        }),
        (error) => error === expected,
      );
      assert.strictEqual(attempts, 1);
    });
  }

  it("clears rejected typed candidates from cache", async () => {
    let attempts = 0;
    const typedLoader = async (_modelName: string, candidate: Parameters<typeof sessionFor>[0]) => {
      attempts++;
      throw new OnnxSessionCreationError(`${candidate.variantName} unavailable`);
    };
    const options = { modelVariant: "default", executionProviders: ["dml", "cpu"] };

    await assert.rejects(createOnnxSession(JINA, options, typedLoader), /default unavailable/);
    assert.strictEqual(attempts, 2);
    await assert.rejects(createOnnxSession(JINA, options, typedLoader), /default unavailable/);
    assert.strictEqual(attempts, 4);
  });
});
