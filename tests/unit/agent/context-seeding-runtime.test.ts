import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type {
  AgentTask,
  ContextSeedCandidate,
  ContextSeedResult,
} from "../../../dist/agent/types.js";

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
const CANONICAL_WORKFLOW_TASK_TEXT =
  "Explain how the canonical server workflow catalog injects SDL_MCP_SERVER_INSTRUCTIONS exactly once.";
const INDEXED_SOURCE_TASK_TEXT =
  "Explain why file.read refuses indexed TypeScript source and routes the request through the indexed source file gateway.";
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

function broadDefaultTask(taskText: string): AgentTask {
  return {
    repoId: REPO_ID,
    taskType: "explain",
    taskText,
    options: {
      contextMode: "broad",
      includeRetrievalEvidence: true,
    },
  };
}

function runtimeSeedCandidates(
  symbolIds: readonly string[],
): ContextSeedCandidate[] {
  return symbolIds.map((symbolId, sourceRank) => ({
    contextRef: `symbol:${symbolId}`,
    source: "lexical",
    score: sourceRank === 0 ? 1 : 0.2,
    sourceRank,
  }));
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
      ["file-live-instructions", "src/mcp/server-instructions.ts"],
      ["file-live-file-read", "src/mcp/tools/file-read.ts"],
      ["file-live-indexer", "src/indexer/index.ts"],
      ["file-live-scip", "src/indexer/scip/provider.ts"],
      ["file-live-native", "native/src/lib.rs"],
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
        "Register a named handler with validated input and output shapes.",
      ],
      [
        "ingress-server-error",
        "file-ingress-server",
        "function",
        "buildToolResponseEnvelope",
        "Combine text blocks with an optional structured value.",
      ],
      [
        "ingress-descriptor-contract",
        "file-ingress-descriptors",
        "function",
        "buildFlatToolDescriptors",
        "Flatten registered descriptor groups in declaration order.",
      ],
      [
        "ingress-descriptor-output",
        "file-ingress-server",
        "function",
        "asStructuredContent",
        "Return a JSON object when the supplied value supports it.",
      ],
      [
        "ingress-runtime-determinism",
        "file-ingress-runtime",
        "function",
        "handleRuntimeQueryOutput",
        "Read a bounded persisted command artifact.",
      ],
      [
        "ingress-late-output",
        "file-ingress-runtime",
        "function",
        "output",
        "Read one artifact segment.",
      ],
      [
        "ingress-module-distractor",
        "file-ingress-server",
        "module",
        "server.ts",
        "Server module declaration.",
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
      ["live-workflow-anchor", "file-live-instructions", "function", "buildCanonicalServerWorkflowCatalog", "Build the canonical server workflow catalog."],
      ["live-workflow-instructions", "file-live-instructions", "variable", "SDL_MCP_SERVER_INSTRUCTIONS", "Canonical server workflow instructions exposed exactly once."],
      ["live-workflow-feedback-noise", "file-ingress-global", "class", "AgentFeedbackQueryResponse", "Unrelated feedback response."],
      ["live-workflow-validation-noise", "file-ingress-global", "function", "validateExactlyOneMode", "Unrelated mode validator."],
      ["live-workflow-forward-noise", "file-ingress-global", "class", "ForwardDefinition", "Unrelated native definition."],
      ["live-indexed-check", "file-live-file-read", "function", "isIndexedSource", "Check whether a requested source file is indexed."],
      ["live-indexed-gateway", "file-live-file-read", "function", "handleFileGateway", "Handle guarded file gateway requests."],
      ["live-indexed-fit", "file-live-file-read", "function", "assertFullFileSourceFitsExtractionLimit", "Reject oversized full source extraction."],
      ["live-indexed-indexer-noise", "file-live-indexer", "function", "readSourceFileList", "Read indexer source file candidates."],
      ["live-indexed-scip-noise", "file-live-scip", "class", "TypeScriptScipProvider", "Provide TypeScript SCIP symbols."],
      ["live-indexed-native-noise", "file-live-native", "class", "NativeTypeScriptIndexer", "Index TypeScript through the native provider."],
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
        name: `serializeOutputCandidate${index}`,
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: index + 1,
        rangeStartCol: 0,
        rangeEndLine: index + 1,
        rangeEndCol: 1,
        astFingerprint: `ingress-lexical-noise-${index}-fingerprint`,
        signatureJson: null,
        summary: `Serialize output candidate ${index}.`,
        searchText: `serialize output candidate ${index}`,
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
        name: `genericReviewCandidate${index}`,
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: index + 1,
        rangeStartCol: 0,
        rangeEndLine: index + 1,
        rangeEndCol: 1,
        astFingerprint: `ingress-global-${index}`,
        signatureJson: null,
        summary: `Plausible review competitor ${index}`,
        searchText: `review response error competitor ${index}`,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }

    for (const [symbolId, fanIn, fanOut, kCore, pageRank] of [
      ["ingress-server-contract", 6, 3, 5, 0.000078],
      ["ingress-server-error", 10, 8, 6, 0.0001],
      ["ingress-descriptor-contract", 1, 6, 5, 0.000031],
      ["ingress-descriptor-output", 0, 2, 2, 0.000034],
      ["ingress-runtime-determinism", 0, 6, 4, 0.000029],
    ] as const) {
      await queries.upsertMetrics(conn, {
        symbolId,
        fanIn,
        fanOut,
        churn30d: 0,
        testRefsJson: "[]",
        canonicalTestJson: null,
        pageRank,
        kCore,
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

  it("keeps a stronger later lexical batch contribution", async () => {
    const result = await buildSeedContext(ingressTask());
    const candidate = result.candidates.find(
      ({ contextRef }) => contextRef === "symbol:ingress-late-output",
    );
    const lexicalContribution = candidate?.provenance?.find(
      ({ source }) => source === "lexical",
    );

    assert.ok(lexicalContribution, `expected lexical contribution: ${JSON.stringify(candidate)}`);
    assert.equal(lexicalContribution.score, 1);
  });



  it("keeps broad seeded candidates and final evidence deterministic", async () => {
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
    const prohibitedRefs = new Set(PROBE_A_PROHIBITED_IDS.map((id) => `symbol:${id}`));

    const targetCandidates = first.candidates.filter(({ contextRef }) =>
      targetRefs.includes(contextRef),
    );
    assert.ok(targetCandidates.length >= 4);
    assert.ok(
      targetCandidates.every((candidate) =>
        new Set(
          candidate.provenance?.map(({ source }) => source) ?? [candidate.source],
        ).has("lexical"),
      ),
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

    assert.ok(firstEvidenceRefs.length > 0);
    assert.ok(
      firstEvidenceRefs.filter((ref) => targetRefs.includes(ref)).length >= 4,
      `expected at least four target declarations: ${JSON.stringify(firstEvidenceRefs)}`,
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



  it("keeps the canonical workflow constant in the top broad-default evidence", async () => {
    const probeTask = broadDefaultTask(CANONICAL_WORKFLOW_TASK_TEXT);
    const candidates = runtimeSeedCandidates([
      "live-workflow-anchor",
      "live-workflow-feedback-noise",
      "live-workflow-validation-noise",
      "live-workflow-forward-noise",
    ]);
    const execute = async () =>
      new ExecutorClass().execute(
        probeTask,
        ["card"],
        candidates.map(({ contextRef }) => contextRef),
        candidates,
      );

    const first = (await execute()).evidence
      .filter(({ type }) => type === "symbolCard")
      .map(({ reference, summary }) => ({ reference, summary }));
    const targetIndex = first.findIndex(
      ({ reference }) => reference === "symbol:live-workflow-instructions",
    );

    assert.ok(targetIndex >= 0 && targetIndex < 3, JSON.stringify(first));
    assert.match(
      first[targetIndex].summary,
      /\bsrc\/mcp\/server-instructions\.ts\b/,
    );
    const repeated = (await execute()).evidence
      .filter(({ type }) => type === "symbolCard")
      .map(({ reference, summary }) => ({ reference, summary }));
    assert.deepStrictEqual(repeated, first);
  });

  it("keeps indexed-source guards ahead of broad-default provider noise", async () => {
    const probeTask = broadDefaultTask(INDEXED_SOURCE_TASK_TEXT);
    const noiseIds = [
      "live-indexed-indexer-noise",
      "live-indexed-scip-noise",
      "live-indexed-native-noise",
    ] as const;
    // The live probe found both guards behind stronger provider/indexer seeds;
    // inferred file focus must promote them without prompt-specific vocabulary.
    const candidates: ContextSeedCandidate[] = [
      ...runtimeSeedCandidates(noiseIds).map((candidate) => ({
        ...candidate,
        score: 0.6,
      })),
      {
        contextRef: "symbol:live-indexed-check",
        source: "lexical",
        score: 0.3,
        sourceRank: 4,
      },
      {
        contextRef: "symbol:live-indexed-gateway",
        source: "lexical",
        score: 0.3,
        sourceRank: 5,
      },
    ];
    const execute = async () =>
      new ExecutorClass().execute(
        probeTask,
        ["card"],
        candidates.map(({ contextRef }) => contextRef),
        candidates,
      );

    const first = (await execute()).evidence
      .filter(({ type }) => type === "symbolCard")
      .map(({ reference, summary }) => ({ reference, summary }));
    const firstNoiseIndex = first.findIndex(({ reference }) =>
      noiseIds.some((symbolId) => reference === `symbol:${symbolId}`),
    );
    const checkIndex = first.findIndex(
      ({ reference }) => reference === "symbol:live-indexed-check",
    );
    const gatewayIndex = first.findIndex(
      ({ reference }) => reference === "symbol:live-indexed-gateway",
    );
    const fileReadIndex = first.findIndex(({ summary }) =>
      summary.includes("src/mcp/tools/file-read.ts"),
    );

    assert.ok(firstNoiseIndex >= 0, JSON.stringify(first));
    assert.ok(checkIndex >= 0 && checkIndex < firstNoiseIndex, JSON.stringify(first));
    assert.ok(
      gatewayIndex >= 0 && gatewayIndex < firstNoiseIndex,
      JSON.stringify(first),
    );
    assert.ok(fileReadIndex >= 0 && fileReadIndex < firstNoiseIndex);
    assert.ok(checkIndex < 8 && gatewayIndex < 8, JSON.stringify(first));
    const repeated = (await execute()).evidence
      .filter(({ type }) => type === "symbolCard")
      .map(({ reference, summary }) => ({ reference, summary }));
    assert.deepStrictEqual(repeated, first);
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
