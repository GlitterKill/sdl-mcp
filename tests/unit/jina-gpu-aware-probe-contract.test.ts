import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, type TestContext } from "node:test";

import {
  NORMALIZATION_TOLERANCE,
  STDOUT_LIMIT_BYTES,
  evaluateJinaProbe,
  runJinaProbeChild,
} from "../../scripts/jina-gpu-aware-probe-contract.mjs";

const DIMENSION = 768;
const MODEL = "jina-embeddings-v2-base-code";

function vector(index: number, magnitude = 1): number[] {
  return Array.from(
    { length: DIMENSION },
    (_value, candidate) => (candidate === index ? magnitude : 0),
  );
}

function vectors(): number[][] {
  return [vector(0), vector(1), vector(0), vector(1)];
}

function identity(
  variantName: string,
  modelFile: string,
  executionProviders: string[],
) {
  return { modelName: MODEL, variantName, modelFile, executionProviders };
}

function probe() {
  const batch = vectors();
  return {
    dml: {
      mode: "dml",
      identity: identity("fp16", "model_fp16.onnx", ["dml", "cpu"]),
      vectors: structuredClone(batch),
      firstPassMs: 8,
    },
    cpu: {
      mode: "cpu",
      identity: identity("default", "model_quantized.onnx", ["cpu"]),
      vectors: structuredClone(batch),
      repeatVectors: structuredClone(batch),
      firstPassMs: 12,
      determinismRepeatMs: 11,
    },
    fallback: {
      mode: "fallback",
      automatic: {
        attempts: ["fp16", "default"],
        identity: identity("int8", "model_quantized.onnx", ["cpu"]),
        vectors: structuredClone(batch),
      },
      explicitFp16: { attempts: 1, rejected: true },
    },
  };
}

function childRecord(mode: "dml" | "cpu" | "fallback") {
  return structuredClone(probe()[mode]);
}

function nextUp(value: number): number {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value, false);
  view.setBigUint64(0, view.getBigUint64(0, false) + 1n, false);
  return view.getFloat64(0, false);
}

function mockSpawn(
  t: TestContext,
  {
    stdout = "",
    stderr = "",
    code = 0,
    signal = null,
    error,
    neverSettles = false,
    killError,
  }: {
    stdout?: string;
    stderr?: string;
    code?: number | null;
    signal?: NodeJS.Signals | null;
    error?: Error;
    neverSettles?: boolean;
    killError?: Error;
  },
) {
  const killSignals: NodeJS.Signals[] = [];
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal: NodeJS.Signals) => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    killSignals.push(signal);
    if (killError) throw killError;
    return true;
  };
  t.mock.method(childProcess, "spawn", () => {
    queueMicrotask(() => {
      if (neverSettles) return;
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setImmediate(() => {
        if (error) child.emit("error", error);
        else child.emit("close", code, signal);
      });
    });
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  });
  return { killSignals };
}

function runMockedChild(
  mode: "dml" | "cpu" | "fallback" = "dml",
  timeoutMs?: number,
) {
  return runJinaProbeChild({
    scriptPath: "probe.mjs",
    moduleRoot: "installed-sdl-mcp",
    cwd: "probe-root",
    mode,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

async function withTestGuard<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("test guard elapsed")), 100);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("evaluateJinaProbe", () => {
  it("accepts exact identities, deterministic vectors, and both retrieval topologies", () => {
    assert.deepStrictEqual(evaluateJinaProbe(probe()), {
      passed: true,
      identities: {
        dml: identity("fp16", "model_fp16.onnx", ["dml", "cpu"]),
        cpu: identity("default", "model_quantized.onnx", ["cpu"]),
        fallback: identity("int8", "model_quantized.onnx", ["cpu"]),
      },
      quality: {
        dmlIdentityPassed: true,
        cpuIdentityPassed: true,
        fallbackIdentityPassed: true,
        dimensionsPassed: true,
        finitePassed: true,
        normalizedPassed: true,
        cpuRepeatExact: true,
        minimumPairedCosine: 1,
        pairedCosinePassed: true,
        crossVariantTop1: [0, 1],
        crossVariantTop1Passed: true,
        controlTop1: [0, 1],
        controlTop1Passed: true,
        fallbackAutomaticPassed: true,
        fallbackExplicitFp16Passed: true,
      },
      firstPassMs: { dml: 8, cpu: 12 },
      cpuDeterminismRepeatMs: 11,
    });
  });

  it("uses deterministic corpus-order tie breaking", () => {
    const tied = probe();
    const tiedQuery = vector(0, 2 ** -0.5);
    tiedQuery[1] = 2 ** -0.5;
    tied.dml.vectors[2] = tiedQuery;
    tied.cpu.vectors[2] = structuredClone(tiedQuery);
    tied.cpu.repeatVectors[2] = structuredClone(tiedQuery);

    assert.deepStrictEqual(
      evaluateJinaProbe(tied).quality.crossVariantTop1,
      [0, 1],
    );
  });

  it("treats the exact normalization tolerance as inclusive", () => {
    const boundary = probe();
    boundary.dml.vectors[0] = vector(0, 1 + NORMALIZATION_TOLERANCE);

    assert.equal(evaluateJinaProbe(boundary).quality.normalizedPassed, true);
  });

  it("rejects the next representable norm above the tolerance", () => {
    const above = probe();
    above.dml.vectors[0] = vector(
      0,
      nextUp(1 + NORMALIZATION_TOLERANCE),
    );

    assert.equal(evaluateJinaProbe(above).quality.normalizedPassed, false);
  });

  it("fails every identity gate independently", async (t) => {
    for (const [name, mutate, gate] of [
      [
        "dml",
        (value: ReturnType<typeof probe>) => {
          value.dml.identity.variantName = "default";
        },
        "dmlIdentityPassed",
      ],
      [
        "cpu",
        (value: ReturnType<typeof probe>) => {
          value.cpu.identity.executionProviders = ["dml", "cpu"];
        },
        "cpuIdentityPassed",
      ],
      [
        "fallback",
        (value: ReturnType<typeof probe>) => {
          value.fallback.automatic.identity.modelFile = "model_fp16.onnx";
        },
        "fallbackIdentityPassed",
      ],
    ] as const) {
      await t.test(name, () => {
        const value = probe();
        mutate(value);
        const result = evaluateJinaProbe(value);
        assert.equal(result.passed, false);
        assert.equal(result.quality[gate], false);
      });
    }
  });

  it("fails dimension, finite-value, and normalization gates", async (t) => {
    for (const [name, mutate, gate] of [
      [
        "dimension",
        (value: ReturnType<typeof probe>) => value.dml.vectors[0].pop(),
        "dimensionsPassed",
      ],
      [
        "finite",
        (value: ReturnType<typeof probe>) => {
          value.cpu.vectors[0][0] = Number.NaN;
        },
        "finitePassed",
      ],
      [
        "normalized",
        (value: ReturnType<typeof probe>) => {
          value.fallback.automatic.vectors[0] = vector(0, 0.5);
        },
        "normalizedPassed",
      ],
    ] as const) {
      await t.test(name, () => {
        const value = probe();
        mutate(value);
        const result = evaluateJinaProbe(value);
        assert.equal(result.passed, false);
        assert.equal(result.quality[gate], false);
      });
    }
  });

  it("fails CPU repeat, paired-cosine, cross-variant, and control gates", async (t) => {
    for (const [name, mutate, gate] of [
      [
        "CPU repeat",
        (value: ReturnType<typeof probe>) => {
          value.cpu.repeatVectors[0] = vector(2);
        },
        "cpuRepeatExact",
      ],
      [
        "paired cosine",
        (value: ReturnType<typeof probe>) => {
          value.dml.vectors[2] = vector(2);
        },
        "pairedCosinePassed",
      ],
      [
        "cross variant",
        (value: ReturnType<typeof probe>) => {
          value.dml.vectors[0] = vector(1);
        },
        "crossVariantTop1Passed",
      ],
      [
        "control",
        (value: ReturnType<typeof probe>) => {
          value.cpu.vectors[0] = vector(1);
        },
        "controlTop1Passed",
      ],
    ] as const) {
      await t.test(name, () => {
        const value = probe();
        mutate(value);
        const result = evaluateJinaProbe(value);
        assert.equal(result.passed, false);
        assert.equal(result.quality[gate], false);
      });
    }
  });

  it("requires automatic quantized fallback and one rejected explicit FP16 attempt", () => {
    const skippedAutomatic = probe();
    skippedAutomatic.fallback.automatic.attempts = ["default"];
    assert.equal(
      evaluateJinaProbe(skippedAutomatic).quality.fallbackAutomaticPassed,
      false,
    );

    const wrongAutomatic = probe();
    wrongAutomatic.fallback.automatic.identity.variantName = "fp16";
    assert.equal(
      evaluateJinaProbe(wrongAutomatic).quality.fallbackIdentityPassed,
      false,
    );

    const retriedExplicit = probe();
    retriedExplicit.fallback.explicitFp16.attempts = 2;
    assert.equal(
      evaluateJinaProbe(retriedExplicit).quality.fallbackExplicitFp16Passed,
      false,
    );

    const resolvedExplicit = probe();
    resolvedExplicit.fallback.explicitFp16.rejected = false;
    assert.equal(
      evaluateJinaProbe(resolvedExplicit).quality.fallbackExplicitFp16Passed,
      false,
    );
  });
});

describe("runJinaProbeChild", () => {
  it("uses a 300000 ms default watchdog and clears it after normal close", async (t) => {
    const delays: number[] = [];
    const cleared: unknown[] = [];
    const timerHandle = { id: "probe-watchdog" };
    t.mock.method(globalThis, "setTimeout", (_callback, delay) => {
      delays.push(Number(delay));
      return timerHandle as unknown as NodeJS.Timeout;
    });
    t.mock.method(globalThis, "clearTimeout", (handle) => {
      cleared.push(handle);
    });
    const state = mockSpawn(t, {
      stdout: JSON.stringify(childRecord("dml")),
    });

    await runMockedChild();

    assert.deepStrictEqual(delays, [300_000]);
    assert.deepStrictEqual(cleared, [timerHandle]);
    assert.deepStrictEqual(state.killSignals, []);
  });

  it("force-kills and rejects a child that never settles", async (t) => {
    const state = mockSpawn(t, { neverSettles: true });

    await assert.rejects(
      withTestGuard(runMockedChild("cpu", 5)),
      /Jina cpu child timed out after 5 ms/u,
    );
    assert.deepStrictEqual(state.killSignals, ["SIGKILL"]);
  });

  it("still rejects the timeout when SIGKILL throws", async (t) => {
    const state = mockSpawn(t, {
      neverSettles: true,
      killError: new Error("kill failed"),
    });

    await assert.rejects(
      withTestGuard(runMockedChild("fallback", 5)),
      /Jina fallback child timed out after 5 ms/u,
    );
    assert.deepStrictEqual(state.killSignals, ["SIGKILL"]);
  });

  it("rejects non-positive or non-finite timeouts before spawning", (t) => {
    mockSpawn(t, { neverSettles: true });
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => runMockedChild("dml", timeoutMs), /timeoutMs/u);
    }
  });

  it("returns one strictly parsed child record", async (t) => {
    const record = childRecord("dml");
    mockSpawn(t, { stdout: JSON.stringify(record) });

    assert.deepStrictEqual(await runMockedChild(), record);
  });

  it("rejects a spawn error", async (t) => {
    const state = mockSpawn(t, { error: new Error("spawn EPERM") });
    await assert.rejects(runMockedChild("dml", 5), /spawn EPERM/u);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepStrictEqual(state.killSignals, []);
  });

  it("rejects a signal exit", async (t) => {
    mockSpawn(t, { signal: "SIGTERM" });
    await assert.rejects(runMockedChild(), /signal SIGTERM/u);
  });

  it("rejects a nonzero exit", async (t) => {
    mockSpawn(t, { code: 7, stderr: "native provider failure" });
    await assert.rejects(runMockedChild(), /exited 7.*native provider failure/u);
  });

  it("accepts exactly 512 KiB and rejects the next byte", async (t) => {
    const record = JSON.stringify(childRecord("dml"));
    const atLimit = record + " ".repeat(STDOUT_LIMIT_BYTES - Buffer.byteLength(record));
    mockSpawn(t, { stdout: atLimit });
    await runMockedChild();

    await t.test("overflow", async (t) => {
      mockSpawn(t, { stdout: `${atLimit} ` });
      await assert.rejects(runMockedChild(), /stdout exceeded 524288 bytes/u);
    });
  });

  it("rejects empty output", async (t) => {
    mockSpawn(t, { stdout: " \r\n" });
    await assert.rejects(runMockedChild(), /empty stdout/u);
  });

  it("rejects partial JSON", async (t) => {
    mockSpawn(t, { stdout: '{"mode":"dml"' });
    await assert.rejects(runMockedChild(), /invalid JSON/u);
  });

  it("rejects malformed JSON", async (t) => {
    mockSpawn(t, { stdout: "not-json" });
    await assert.rejects(runMockedChild(), /invalid JSON/u);
  });

  it("rejects missing fields", async (t) => {
    mockSpawn(t, { stdout: JSON.stringify({ mode: "dml" }) });
    await assert.rejects(runMockedChild(), /identity/u);
  });

  it("rejects a non-finite first-pass timing", async (t) => {
    const output = JSON.stringify(childRecord("dml")).replace(
      '"firstPassMs":8',
      '"firstPassMs":1e309',
    );
    mockSpawn(t, { stdout: output });
    await assert.rejects(runMockedChild(), /firstPassMs/u);
  });

  it("rejects a non-finite repeat timing", async (t) => {
    const output = JSON.stringify(childRecord("cpu")).replace(
      '"determinismRepeatMs":11',
      '"determinismRepeatMs":1e309',
    );
    mockSpawn(t, { stdout: output });
    await assert.rejects(runMockedChild("cpu"), /determinismRepeatMs/u);
  });
});
