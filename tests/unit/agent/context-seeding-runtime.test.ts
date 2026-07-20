import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { AgentTask, ContextSeedResult } from "../../../dist/agent/types.js";

const REPO_ID = "context-seeding-runtime-repo";
const INGRESS_TASK_TEXT =
  "Review the current SDL-MCP tool surface for contracts, output noise, deterministic responses, and safe errors.";
const INGRESS_TARGET_IDS = [
  "ingress-server-contract",
  "ingress-server-error",
  "ingress-descriptor-contract",
  "ingress-descriptor-output",
  "ingress-runtime-determinism",
] as const;
const PROBE_A_PROHIBITED_IDS = [
  "ingress-render-meta",
  "ingress-render-grid",
  "ingress-evaluate-seed",
  "ingress-evaluate-case",
] as const;
const DB_PATH = join(
  tmpdir(),
  `.lbug-context-seeding-runtime-${process.pid}.lbug`,
);
const CONFIG_PATH = join(
  tmpdir(),
  `sdl-context-seeding-runtime-${process.pid}.json`,
);

let buildSeedContext: (task: AgentTask) => Promise<ContextSeedResult>;
let seedResultToContext: (result: ContextSeedResult) => string[];
let ExecutorClass: typeof import("../../../dist/agent/executor.js").Executor;
let closeLadybugDb: () => Promise<void>;

const previousConfig = process.env.SDL_CONFIG;
const previousConfigPath = process.env.SDL_CONFIG_PATH;
const previousNativeDisabled = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;

function removeTestFile(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
}

function task(semantic: boolean | undefined): AgentTask {
  return {
    repoId: REPO_ID,
    taskType: "explain",
    taskText: "Explain quasar theta propagation",
    options: {
      contextMode: "broad",
      includeRetrievalEvidence: true,
      ...(semantic === undefined ? {} : { semantic }),
    },
  };
}

function ingressTask(
  taskText = INGRESS_TASK_TEXT,
  focusPaths?: string[],
): AgentTask {
  return {
    repoId: REPO_ID,
    taskType: "review",
    taskText,
    options: {
      contextMode: "broad",
      semantic: true,
      includeRetrievalEvidence: true,
      ...(focusPaths ? { focusPaths } : {}),
    },
  };
}

describe("context seeding runtime lanes", () => {
  before(async () => {
    removeTestFile(DB_PATH);
    removeTestFile(`${DB_PATH}.wal`);
    removeTestFile(CONFIG_PATH);

    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        repos: [],
        policy: {},
        semantic: {
          enabled: false,
          retrieval: {
            mode: "hybrid",
            fts: {
              enabled: true,
              indexName: "symbol_search_text_v1",
              topK: 75,
              conjunctive: false,
            },
            vector: { enabled: false },
          },
        },
        liveIndex: { enabled: false },
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = CONFIG_PATH;
    delete process.env.SDL_CONFIG_PATH;
    // Windows FTS runtime loading uses the native addon's verified DLL
    // preloader even though retrieval itself remains TypeScript.
    if (process.platform === "win32") {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    }

    const [ladybug, queries, lifecycle, seeding, executor] =
      await Promise.all([
        import("../../../dist/db/ladybug.js"),
        import("../../../dist/db/ladybug-queries.js"),
        import("../../../dist/retrieval/index-lifecycle.js"),
        import("../../../dist/agent/context-seeding.js"),
        import("../../../dist/agent/executor.js"),
      ]);
    closeLadybugDb = ladybug.closeLadybugDb;
    buildSeedContext = seeding.buildSeedContext;
    seedResultToContext = seeding.seedResultToContext;
    ExecutorClass = executor.Executor;

    await closeLadybugDb();
    await ladybug.initLadybugDb(DB_PATH);
    const conn = await ladybug.getLadybugConn();
    const now = "2026-07-16T00:00:00.000Z";

    await queries.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: "C:/tmp/context-seeding-runtime-repo",
      configJson: "{}",
      createdAt: now,
    });
    await queries.upsertFile(conn, {
      fileId: "file-quasar",
      repoId: REPO_ID,
      relPath: "src/quasar.ts",
      contentHash: "quasar-hash",
      language: "ts",
      byteSize: 1,
      lastIndexedAt: now,
    });

    for (let index = 0; index < 4; index++) {
      await queries.upsertSymbol(conn, {
        symbolId: `symbol-quasar-${index}`,
        repoId: REPO_ID,
        fileId: "file-quasar",
        kind: "function",
        name: `quasarThetaPropagation${index}`,
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: index + 1,
        rangeStartCol: 0,
        rangeEndLine: index + 1,
        rangeEndCol: 1,
        astFingerprint: `quasar-${index}`,
        signatureJson: null,
        summary: `Quasar theta propagation candidate ${index}`,
        searchText: `quasar theta propagation candidate ${index}`,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }

    const ingressFiles = [
      ["file-ingress-server", "src/server.ts"],
      ["file-ingress-descriptors", "src/mcp/tools/tool-descriptors.ts"],
      ["file-ingress-runtime", "src/mcp/tools/runtime-query.ts"],
      ["file-ingress-projection", "src/mcp/context-response-projection.ts"],
      [
        "file-ingress-projection-registry",
        "src/mcp/context-response-projection-registry.ts",
      ],
      ["file-ingress-tools", "src/mcp/tools.ts"],
      [
        "file-ingress-output",
        "outputs/logos/sdl-mcp-minimal-symbols/explorer/app.js",
      ],
      ["file-ingress-script", "scripts/evaluate-seed-resolution.ts"],
      ["file-ingress-explicit", "src/explicit-focus.ts"],
      ["file-ingress-global", "src/global-distractors.ts"],
    ] as const;
    for (const [fileId, relPath] of ingressFiles) {
      await queries.upsertFile(conn, {
        fileId,
        repoId: REPO_ID,
        relPath,
        contentHash: `${fileId}-hash`,
        language: "ts",
        byteSize: 1,
        lastIndexedAt: now,
      });
    }

    const ingressTargets = [
      [
        "ingress-server-contract",
        "file-ingress-server",
        "method",
        "registerTool",
        "Register an MCP tool with validated schemas and stable contracts.",
      ],
      [
        "ingress-server-error",
        "file-ingress-server",
        "function",
        "buildToolResponseEnvelope",
        "Build deterministic safe MCP response envelopes and structured errors.",
      ],
      [
        "ingress-descriptor-contract",
        "file-ingress-descriptors",
        "function",
        "buildFlatToolDescriptors",
        "Build stable descriptors for the registered MCP tool surface.",
      ],
      [
        "ingress-descriptor-output",
        "file-ingress-server",
        "function",
        "asStructuredContent",
        "Normalize deterministic structured MCP tool responses.",
      ],
      [
        "ingress-runtime-determinism",
        "file-ingress-runtime",
        "function",
        "handleRuntimeQueryOutput",
        "Return bounded deterministic runtime output without machine noise.",
      ],
      [
        "ingress-late-output",
        "file-ingress-runtime",
        "function",
        "processOutputArtifact",
        "Tool errors errors errors errors output artifact.",
      ],
      [
        "ingress-module-distractor",
        "file-ingress-server",
        "module",
        "server.ts",
        "Server module for the MCP tool surface.",
      ],
      [
        "ingress-variable-distractor",
        "file-ingress-descriptors",
        "variable",
        "sendNotification",
        "Send a server notification for a tool call.",
      ],
      ["ingress-render-meta", "file-ingress-output", "function", "renderMeta", "Render explorer metadata output."],
      ["ingress-render-grid", "file-ingress-output", "function", "renderGrid", "Render explorer grid output."],
      ["ingress-evaluate-seed", "file-ingress-script", "function", "evaluateSeedResolution", "Evaluate seed resolution benchmark output."],
      ["ingress-evaluate-case", "file-ingress-script", "function", "evaluateCase", "Evaluate one seed benchmark case."],
      ["ingress-projection-rule", "file-ingress-projection-registry", "class", "ResponseProjectionRule", "Model response projection rule for output contracts."],
      ["ingress-projection-action", "file-ingress-projection-registry", "class", "ResponseProjectionAction", "Model response projection action definition."],
      ["ingress-copy-present", "file-ingress-projection", "function", "copyIfPresent", "Copy present fields into model response output."],
      ["ingress-compact-schema", "file-ingress-projection", "function", "compactSchemaSummary", "Build compact deterministic schema output."],
      ["ingress-memory-response", "file-ingress-tools", "class", "MemorySurfaceResponse", "Structured response contract for memory tools."],
      ["ingress-tool-context", "file-ingress-server", "class", "ToolContext", "Execution context for safe MCP tool calls."],
      ["ingress-signal", "file-ingress-server", "variable", "signal", "Abort signal for safe tool execution."],
      ["ingress-tool-handler", "file-ingress-descriptors", "class", "ToolHandler", "Handler contract for registered MCP tools."],
      ["ingress-tool-descriptor", "file-ingress-descriptors", "class", "ToolDescriptor", "Descriptor contract for registered MCP tools."],
    ] as const;
    for (let index = 0; index < ingressTargets.length; index++) {
      const [symbolId, fileId, kind, name, summary] = ingressTargets[index];
      await queries.upsertSymbol(conn, {
        symbolId,
        repoId: REPO_ID,
        fileId,
        kind,
        name,
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: index + 1,
        rangeStartCol: 0,
        rangeEndLine: index + 1,
        rangeEndCol: 1,
        astFingerprint: `${symbolId}-fingerprint`,
        signatureJson: null,
        summary,
        searchText: `${name} ${summary}`,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }

    // Keep the relevant output-only symbol below the old compound/entity and
    // eight-row per-term discovery caps while still inside the configured 75.
    for (let index = 0; index < 60; index++) {
      await queries.upsertSymbol(conn, {
        symbolId: `ingress-lexical-noise-${index}`,
        repoId: REPO_ID,
        fileId: "file-ingress-global",
        kind: "function",
        name: `toolSurfaceOutputNoise${index}`,
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: index + 1,
        rangeStartCol: 0,
        rangeEndLine: index + 1,
        rangeEndCol: 1,
        astFingerprint: `ingress-lexical-noise-${index}-fingerprint`,
        signatureJson: null,
        summary:
          "SDL MCP tool tool tool tool surface contracts output output output output noise deterministic responses safe errors.",
        searchText:
          "SDL MCP tool tool tool tool surface contracts output output output output noise deterministic responses safe errors.",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }

    await queries.upsertSymbol(conn, {
      symbolId: "ingress-explicit-focus",
      repoId: REPO_ID,
      fileId: "file-ingress-explicit",
      kind: "function",
      name: "explicitFocusOnly",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 1,
      astFingerprint: "ingress-explicit-focus-fingerprint",
      signatureJson: null,
      summary: "Explicit focus candidate",
      searchText: "explicit focus candidate",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });

    for (let index = 0; index < 8; index++) {
      await queries.upsertSymbol(conn, {
        symbolId: `ingress-global-distractor-${index.toString().padStart(2, "0")}`,
        repoId: REPO_ID,
        fileId: "file-ingress-global",
        kind: "function",
        name: `toolSurfaceReviewCandidate${index}`,
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: index + 1,
        rangeStartCol: 0,
        rangeEndLine: index + 1,
        rangeEndCol: 1,
        astFingerprint: `ingress-global-${index}`,
        signatureJson: null,
        summary: `Plausible tool-surface competitor ${index}`,
        searchText: `review current SDL MCP tool surface contract competitor ${index}`,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }

    let ftsReady = false;
    // The full suite creates FTS fixtures in parallel worker processes. Retry
    // the extension/index bootstrap so a transient native-loader race does not
    // turn this lane contract test into a setup failure.
    for (let attempt = 0; attempt < 5; attempt++) {
      const ensured = await lifecycle.ensureFtsIndexForNonEmptyTable(
        conn,
        "Symbol",
        "symbol_search_text_v1",
      );
      if (ensured.status === "created" || ensured.status === "exists") {
        ftsReady = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
    assert.equal(
      ftsReady,
      true,
      "runtime lane fixture requires a healthy symbol FTS index",
    );
  });

  after(async () => {
    await closeLadybugDb?.();
    removeTestFile(DB_PATH);
    removeTestFile(`${DB_PATH}.wal`);
    removeTestFile(CONFIG_PATH);

    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    if (previousConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = previousConfigPath;
    if (previousNativeDisabled === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = previousNativeDisabled;
    }
  });

  it("keeps bounded lexical fallback in forced semantic mode", async () => {
    const result = await buildSeedContext(task(true));

    assert.ok(
      result.sources.semantic >= 4,
      `fixture must fill semantic diversity reserve: ${JSON.stringify({ sources: result.sources, evidence: result.evidence })}`,
    );
    assert.ok(result.diagnosticTimings?.["seed.semanticEntitySearch"] !== undefined);
    assert.ok(result.diagnosticTimings?.["seed.lexicalFallback"] !== undefined);
  });

  it("preserves broad default semantic and lexical lanes", async () => {
    const result = await buildSeedContext(task(undefined));

    assert.ok(result.diagnosticTimings?.["seed.semanticEntitySearch"] !== undefined);
    assert.ok(result.diagnosticTimings?.["seed.lexicalFallback"] !== undefined);
  });

  it("preserves semantic false as lexical-only", async () => {
    const result = await buildSeedContext(task(false));

    assert.equal(result.diagnosticTimings?.["seed.semanticEntitySearch"], undefined);
    assert.ok(result.diagnosticTimings?.["seed.lexicalFallback"] !== undefined);
  });



  it("preserves Probe A candidates through seeding, expansion, and final selection", async () => {
    const probeTask = ingressTask();
    const first = await buildSeedContext(probeTask);
    const firstIds = first.candidates.map(({ contextRef }) => contextRef);
    const lateOutput = first.candidates.find(
      ({ contextRef }) => contextRef === "symbol:ingress-late-output",
    );
    const lateOutputSources = new Set(
      lateOutput?.provenance?.map(({ source }) => source) ??
        (lateOutput ? [lateOutput.source] : []),
    );
    assert.ok(
      lateOutputSources.has("lexical"),
      `expected late output hit to retain lexical provenance: ${JSON.stringify(lateOutput)}`,
    );

    const targetRefs = INGRESS_TARGET_IDS.map((id) => `symbol:${id}`);
    const prohibitedRefs = new Set(
      PROBE_A_PROHIBITED_IDS.map((id) => `symbol:${id}`),
    );

    assert.ok(
      targetRefs.filter((ref) => firstIds.includes(ref)).length >= 4,
      `expected at least 4/5 targets after seeding, got ${JSON.stringify({ count: firstIds.length, accepted: targetRefs.filter((ref) => firstIds.includes(ref)), candidates: firstIds })}`,
    );

    const mergedTargetCandidate = first.candidates.find((candidate) => {
      if (!targetRefs.includes(candidate.contextRef)) return false;
      const sources = new Set(
        candidate.provenance?.map(({ source }) => source) ?? [candidate.source],
      );
      return sources.has("semantic") && sources.has("lexical");
    });
    assert.ok(
      mergedTargetCandidate,
      `expected merged semantic and lexical provenance, got ${JSON.stringify(
        first.candidates
          .filter(({ contextRef }) => targetRefs.includes(contextRef))
          .map((candidate) => ({
            contextRef: candidate.contextRef,
            sources:
              candidate.provenance?.map(({ source }) => source) ?? [candidate.source],
          })),
      )}`,
    );

    const firstExecution = await new ExecutorClass().execute(
      probeTask,
      ["card"],
      seedResultToContext(first),
      first.candidates,
    );
    const firstEvidenceRefs = firstExecution.evidence
      .filter(({ type }) => type === "symbolCard")
      .map(({ reference }) => reference)
      .slice(0, 10);

    assert.ok(
      targetRefs.filter((ref) => firstEvidenceRefs.includes(ref)).length >= 4,
      `expected at least 4/5 targets in first ten, got ${JSON.stringify(firstEvidenceRefs)}`,
    );
    assert.equal(
      firstEvidenceRefs.some((ref) => prohibitedRefs.has(ref)),
      false,
      `prohibited evidence survived: ${JSON.stringify(firstEvidenceRefs)}`,
    );

    const repeated = await buildSeedContext(probeTask);
    const repeatedExecution = await new ExecutorClass().execute(
      probeTask,
      ["card"],
      seedResultToContext(repeated),
      repeated.candidates,
    );
    assert.deepStrictEqual(
      repeated.candidates.map(({ contextRef }) => contextRef),
      firstIds,
    );
    assert.deepStrictEqual(
      repeatedExecution.evidence
        .filter(({ type }) => type === "symbolCard")
        .map(({ reference }) => reference)
        .slice(0, 10),
      firstEvidenceRefs,
    );
  });



  it("keeps explicit focus authoritative during scoped seeding", async () => {
    const result = await buildSeedContext(
      ingressTask("Review explicitFocusOnly", ["src/explicit-focus.ts"]),
    );
    const ids = result.candidates.map(({ contextRef }) => contextRef);

    assert.ok(ids.includes("symbol:ingress-explicit-focus"));
    for (const id of INGRESS_TARGET_IDS) {
      assert.equal(ids.includes(`symbol:${id}`), false, id);
    }
  });
});
