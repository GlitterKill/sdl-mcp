import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import {
  freezeSafeRebuildCandidatePlan,
} from "../../dist/cli/commands/index-safe-rebuild.js";
import {
  readSafeRebuildSymbolPointLookupSample,
  SAFE_REBUILD_SYMBOL_STRING_FIELDS,
  validateSafeRebuildCanonicalStrings,
} from "../../dist/db/ladybug-safe-rebuild.js";
import { NODE_TABLES } from "../../dist/db/ladybug-schema.js";
import { resolveSymbolVectorPhysicalIdentity } from "../../dist/db/ladybug-symbol-embeddings.js";
import { evaluateRepositorySymbolVectorHealth } from "../../dist/retrieval/health.js";

class FakeQueryResult {
  private readonly rows: Record<string, unknown>[];

  constructor(rows: Record<string, unknown>[]) {
    this.rows = rows;
  }

  async getAll(): Promise<Record<string, unknown>[]> {
    return this.rows;
  }

  close(): void {}
}

function symbolProjection(
  overrides: Partial<Record<string, string | null>> = {},
): Record<string, string | null> {
  return {
    symbolId: "sym-1",
    repoId: "repo",
    kind: "function",
    name: "scan-name",
    visibility: "",
    language: "typescript",
    astFingerprint: "scan-fingerprint",
    signatureJson: "",
    summary: "",
    summarySource: "unknown",
    invariantsJson: "",
    sideEffectsJson: "",
    roleTagsJson: "",
    testCaseJson: null,
    searchText: "scan-name",
    updatedAt: "2026-07-23T00:00:00.000Z",
    embeddingMiniLM: null,
    embeddingMiniLMCardHash: null,
    embeddingMiniLMUpdatedAt: null,
    embeddingNomic: null,
    embeddingNomicCardHash: null,
    embeddingNomicUpdatedAt: null,
    embeddingJinaCode: null,
    embeddingJinaCodeCardHash: null,
    embeddingJinaCodeUpdatedAt: null,
    scipSymbol: "",
    source: "treesitter",
    packageName: "",
    packageVersion: "",
    symbolStatus: "real",
    placeholderKind: "",
    placeholderTarget: "",
    ...overrides,
  };
}

describe("safe rebuild Symbol point-lookup parity", () => {
  it("covers every STRING column in the current Symbol schema", () => {
    const symbolTable = NODE_TABLES.find((statement) =>
      statement.includes("CREATE NODE TABLE IF NOT EXISTS Symbol ("),
    );
    assert.ok(symbolTable, "Symbol table DDL must exist");
    const schemaStringFields = symbolTable
      .split(/\r?\n/u)
      .map(
        (line) =>
          line
            .trim()
            .match(/^([A-Za-z][A-Za-z0-9_]*)\s+STRING(?:\s|,|$)/u)?.[1],
      )
      .filter((field): field is string => field !== undefined);

    assert.deepStrictEqual(
      [...SAFE_REBUILD_SYMBOL_STRING_FIELDS],
      schemaStringFields,
    );
  });

  it("validates every canonical Symbol STRING field", async () => {
    let statement = "";
    const conn = {
      async prepare(query: string) {
        statement = query;
        return { statement: query };
      },
      async execute() {
        return new FakeQueryResult([{}]);
      },
    } as unknown as import("kuzu").Connection;

    await validateSafeRebuildCanonicalStrings(conn);

    for (const field of SAFE_REBUILD_SYMBOL_STRING_FIELDS) {
      assert.ok(
        statement.includes(`s.${field}`),
        `canonical validation must include ${field}`,
      );
    }
  });

  it("rejects coherent IDs whose scan-visible strings disagree with scalar PK lookup", async () => {
    const statements: string[] = [];
    const paramsLog: Record<string, unknown>[] = [];
    const scan = symbolProjection();
    const point = symbolProjection({
      name: "point-name",
      testCaseJson: '{"framework":"node:test","title":"point"}',
      scipSymbol: "scip . . sym-1().",
    });
    const conn = {
      async prepare(statement: string) {
        return { statement };
      },
      async execute(
        prepared: { statement: string },
        params: Record<string, unknown>,
      ) {
        statements.push(prepared.statement);
        paramsLog.push(params);
        if (
          prepared.statement.includes(
            "MATCH (s:Symbol {symbolId: $symbolId0})",
          )
        ) {
          return new FakeQueryResult([
            {
              ordinal: 0,
              requestedSymbolId: params.symbolId0,
              ...point,
            },
          ]);
        }
        if ("afterSymbolId" in params) {
          return new FakeQueryResult([]);
        }
        return new FakeQueryResult([scan]);
      },
    } as unknown as import("kuzu").Connection;

    const result = await readSafeRebuildSymbolPointLookupSample(conn);

    assert.deepStrictEqual(result.symbolIds, ["sym-1"]);
    assert.equal(result.scannedTotal, 1);
    assert.equal(result.mismatchTotal, 1);
    assert.deepStrictEqual(result.mismatches, [
      {
        symbolId: "sym-1",
        fields: ["name", "testCaseJson", "scipSymbol"],
      },
    ]);
    assert.ok(
      statements.some((statement) =>
        statement.includes("MATCH (s:Symbol {symbolId: $symbolId0})"),
      ),
      "parity must use scalar primary-key probes",
    );
    assert.ok(
      statements.every((statement) => !statement.includes("UNWIND")),
      "UNWIND-derived property lookup is not a reliable PK oracle",
    );
    assert.ok(
      paramsLog.some((params) => params.symbolId0 === "sym-1"),
      "the scan-visible ID must be passed as a scalar parameter",
    );
  });

  it("rejects a scalar PK branch that returns more than one physical row", async () => {
    const scan = symbolProjection();
    const conn = {
      async prepare(statement: string) {
        return { statement };
      },
      async execute(
        prepared: { statement: string },
        params: Record<string, unknown>,
      ) {
        if (
          prepared.statement.includes(
            "MATCH (s:Symbol {symbolId: $symbolId0})",
          )
        ) {
          const point = {
            ordinal: 0,
            requestedSymbolId: params.symbolId0,
            ...scan,
          };
          return new FakeQueryResult([point, point]);
        }
        return new FakeQueryResult([scan]);
      },
    } as unknown as import("kuzu").Connection;

    const result = await readSafeRebuildSymbolPointLookupSample(conn);

    assert.equal(result.mismatchTotal, 1);
    assert.deepStrictEqual(result.mismatches, [
      {
        symbolId: "sym-1",
        fields: ["pointLookupCopies"],
      },
    ]);
  });

  it("checks every row beyond the 2,048-row scan boundary", async () => {
    const scannedRows = Array.from({ length: 2_049 }, (_, index) => {
      const suffix = String(index).padStart(4, "0");
      return symbolProjection({
        symbolId: `sym-${suffix}`,
        name: `name-${suffix}`,
        astFingerprint: `fingerprint-${suffix}`,
        searchText: `name-${suffix}`,
        scipSymbol: `scip . . sym-${suffix}().`,
      });
    });
    const pointRows = new Map(
      scannedRows.map((row) => [row.symbolId, { ...row }]),
    );
    pointRows.set("sym-2048", {
      ...pointRows.get("sym-2048")!,
      embeddingJinaCodeCardHash: "point-only-card-hash",
    });
    const scanParams: Record<string, unknown>[] = [];
    const pointStatements: string[] = [];
    const conn = {
      async prepare(statement: string) {
        return { statement };
      },
      async execute(
        prepared: { statement: string },
        params: Record<string, unknown>,
      ) {
        if (
          prepared.statement.includes(
            "MATCH (s:Symbol {symbolId: $symbolId0})",
          )
        ) {
          pointStatements.push(prepared.statement);
          const rows = Object.entries(params)
            .filter(([name]) => /^symbolId\d+$/u.test(name))
            .map(([name, symbolId]) => {
              const ordinal = Number(name.slice("symbolId".length));
              const point = pointRows.get(String(symbolId));
              return point
                ? {
                    ordinal,
                    requestedSymbolId: symbolId,
                    ...point,
                  }
                : undefined;
            })
            .filter(
              (row): row is NonNullable<typeof row> => row !== undefined,
            );
          return new FakeQueryResult(rows);
        }
        scanParams.push(params);
        return new FakeQueryResult(
          "afterSymbolId" in params
            ? scannedRows.slice(2_048)
            : scannedRows.slice(0, 2_048),
        );
      },
    } as unknown as import("kuzu").Connection;

    const result = await readSafeRebuildSymbolPointLookupSample(conn);

    assert.equal(result.scannedTotal, 2_049);
    assert.equal(result.mismatchTotal, 1);
    assert.deepStrictEqual(result.mismatches, [
      {
        symbolId: "sym-2048",
        fields: ["embeddingJinaCodeCardHash"],
      },
    ]);
    assert.equal(scanParams.length, 2);
    assert.equal(scanParams[1]?.afterSymbolId, "sym-2047");
    assert.equal(pointStatements.length, 33);
    assert.equal(
      pointStatements[0]?.match(/MATCH \(s:Symbol/gu)?.length,
      64,
    );
    assert.equal(
      pointStatements[0]?.match(/UNION ALL/gu)?.length,
      63,
    );
    assert.ok(
      pointStatements.every((statement) => !statement.includes("UNWIND")),
      "every parity branch must retain a scalar PK parameter",
    );
  });

  it("includes parser provenance nodes in the safe-rebuild schema", () => {
    const schema = NODE_TABLES.join("\n");
    assert.match(schema, /CREATE NODE TABLE IF NOT EXISTS RepoParserState/);
    assert.match(schema, /CREATE NODE TABLE IF NOT EXISTS FileParserState/);
  });
});


describe("safe rebuild frozen candidate plan", () => {
  it("freezes the deterministic repository/model cross-product before build", () => {
    const sourceConfig = {
      repos: [
        {
          repoId: "repo-z",
          rootPath: "Z:/repo-z",
          ignore: [],
          languages: ["ts"],
        },
        {
          repoId: "repo-a",
          rootPath: "Z:/repo-a",
          ignore: [],
          languages: ["ts"],
        },
      ],
      semantic: {
        enabled: true,
        provider: "mock",
        symbolEmbeddingModels: [
          "nomic-embed-text-v1.5",
          "jina-embeddings-v2-base-code",
        ],
      },
    };
    const plan = freezeSafeRebuildCandidatePlan(
      sourceConfig as unknown as Parameters<
        typeof freezeSafeRebuildCandidatePlan
      >[0],
    );

    sourceConfig.repos.reverse();
    sourceConfig.repos[0]!.repoId = "mutated-after-freeze";
    sourceConfig.semantic.symbolEmbeddingModels.reverse();

    assert.deepStrictEqual(plan.repoIds, ["repo-a", "repo-z"]);
    assert.deepStrictEqual(plan.symbolEmbeddingModels, [
      "nomic-embed-text-v1.5",
      "jina-embeddings-v2-base-code",
    ]);
    assert.deepStrictEqual(plan.repositoryModels, [
      {
        repoId: "repo-a",
        models: [
          "nomic-embed-text-v1.5",
          "jina-embeddings-v2-base-code",
        ],
      },
      {
        repoId: "repo-z",
        models: [
          "nomic-embed-text-v1.5",
          "jina-embeddings-v2-base-code",
        ],
      },
    ]);
    assert.equal(plan.config.repos[0]?.repoId, "repo-z");
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.config), true);
    assert.equal(Object.isFrozen(plan.config.repos), true);
    assert.equal(Object.isFrozen(plan.repositoryModels[0]?.models), true);
  });

  it("rejects duplicate repository identities before candidate initialization", () => {
    const config = {
      repos: [
        { repoId: "duplicate", rootPath: "Z:/one" },
        { repoId: "duplicate", rootPath: "Z:/two" },
      ],
      semantic: { enabled: false },
    };
    assert.throws(
      () =>
        freezeSafeRebuildCandidatePlan(
          config as unknown as Parameters<
            typeof freezeSafeRebuildCandidatePlan
          >[0],
        ),
      /unique configured repository IDs/u,
    );
  });
});


describe("safe rebuild repository-vector boundary facts", () => {
  const model = "jina-embeddings-v2-base-code";
  const repoId = "safe-rebuild-boundary";

  function rows(count: number) {
    return Array.from({ length: count }, (_, index) => {
      const symbolId = `symbol-${String(index).padStart(4, "0")}`;
      return {
        embeddingId: `${model}:${symbolId}`,
        repoId,
        symbolId,
        model,
        embeddingVectorPresent: true,
        cardHashPresent: true,
        embeddingJinaCodeVecPresent: true,
        embeddingNomicVecPresent: false,
      };
    });
  }

  it("uses exact mode at 1,999 and the exact healthy HNSW tuple at 2,000", () => {
    const identity = resolveSymbolVectorPhysicalIdentity(repoId, model);
    const semanticConfig = {
      enabled: true,
      provider: "mock",
      symbolEmbeddingModels: [model],
    } as unknown as Parameters<
      typeof evaluateRepositorySymbolVectorHealth
    >[0]["semanticConfig"];
    const exactRows = rows(1_999);
    const exact = evaluateRepositorySymbolVectorHealth({
      repoId,
      versionId: "version-1",
      generation: 0,
      lifecycleState: "steady",
      semanticConfig,
      tableState: "present",
      eligibleSymbolIds: exactRows.map((row) => row.symbolId),
      vectorRows: exactRows,
      indexes: [],
    });
    assert.equal(exact[0]?.mode, "exact");
    assert.equal(exact[0]?.observedIndexIdentity, null);

    const hnswRows = rows(2_000);
    const hnsw = evaluateRepositorySymbolVectorHealth({
      repoId,
      versionId: "version-1",
      generation: 0,
      lifecycleState: "steady",
      semanticConfig,
      tableState: "present",
      eligibleSymbolIds: hnswRows.map((row) => row.symbolId),
      vectorRows: hnswRows,
      indexes: [
        {
          tableName: identity.tableName,
          name: identity.indexName,
          type: "vector",
          property: identity.propertyName,
          status: "healthy",
          extensionLoaded: true,
        },
      ],
    });
    assert.equal(hnsw[0]?.mode, "hnsw");
    assert.equal(hnsw[0]?.observedIndexIdentity?.name, identity.indexName);

    const ambiguous = evaluateRepositorySymbolVectorHealth({
      repoId,
      versionId: "version-1",
      generation: 0,
      lifecycleState: "steady",
      semanticConfig,
      tableState: "present",
      eligibleSymbolIds: hnswRows.map((row) => row.symbolId),
      vectorRows: hnswRows,
      indexes: [
        {
          tableName: identity.tableName,
          name: identity.indexName,
          type: "vector",
          property: identity.propertyName,
          status: "healthy",
          extensionLoaded: true,
        },
        {
          tableName: identity.tableName,
          name: identity.indexName,
          type: "vector",
          property: identity.propertyName,
          status: "healthy",
          extensionLoaded: true,
        },
      ],
    });
    assert.equal(ambiguous[0]?.mode, "degraded");
    assert.match(
      ambiguous[0]?.reason ?? "",
      /missing or ambiguous/u,
    );
  });
});


const TASK8_MODEL = "jina-embeddings-v2-base-code";
const TASK8_EXACT_REPO = "repo-exact";
const TASK8_HNSW_REPO = "repo-hnsw";

interface Task8CandidateIndex {
  tableName: string;
  name: string;
  type: "vector";
  property: string;
  status: "healthy";
  extensionLoaded: true;
}

interface Task8CandidateState {
  storedRepoIds: string[];
  eligibleCounts: Record<string, number>;
  completeCounts: Record<string, number>;
  vectorOwners: Record<string, string>;
  tableNames: string[];
  indexes: Task8CandidateIndex[];
  exactProbeFailures: Set<string>;
  annProbeFailures: Set<string>;
}

function snapshotTask8DatabaseFamily(graphPath: string): Record<string, string> {
  const directory = dirname(graphPath);
  const prefix = basename(graphPath);
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => name.startsWith(prefix))
      .sort((left, right) => left.localeCompare(right))
      .map((name) => [
        name,
        readFileSync(join(directory, name)).toString("base64"),
      ]),
  );
}

function task8SymbolIds(repoId: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => repoId + "-symbol-" + String(index).padStart(4, "0"),
  );
}

async function createTask8CandidateHarness(t: TestContext) {
  const [
    ladybug,
    initGraphDb,
    ladybugCore,
    operationGate,
    derivedState,
    queries,
    safeRebuildDb,
    derivedQueue,
    graphVerifier,
    persistedIntegrity,
    indexLifecycle,
    retrievalHealth,
    symbolEmbeddings,
    plugins,
    pidfile,
  ] = await Promise.all([
    import("../../dist/db/ladybug.js"),
    import("../../dist/db/initGraphDb.js"),
    import("../../dist/db/ladybug-core.js"),
    import("../../dist/db/ladybug-operation-gate.js"),
    import("../../dist/db/ladybug-derived-state.js"),
    import("../../dist/db/ladybug-queries.js"),
    import("../../dist/db/ladybug-safe-rebuild.js"),
    import("../../dist/indexer/derived-refresh-queue.js"),
    import("../../dist/indexer/provider-first/background-graph-integrity-verifier.js"),
    import("../../dist/indexer/provider-first/persisted-graph-integrity.js"),
    import("../../dist/retrieval/index-lifecycle.js"),
    import("../../dist/retrieval/health.js"),
    import("../../dist/db/ladybug-symbol-embeddings.js"),
    import("../../dist/startup/plugins.js"),
    import("../../dist/util/pidfile.js"),
  ]);

  const root = mkdtempSync(join(tmpdir(), "sdl-task8-candidate-"));
  const activePath = join(root, "active.lbug");
  writeFileSync(activePath, "active-main", "utf8");
  writeFileSync(activePath + ".wal", "active-wal", "utf8");
  const sourceFamily = snapshotTask8DatabaseFamily(activePath);
  const fakeConn = {};
  const probeVector = [1, ...Array<number>(767).fill(0)];
  const exactIdentity = resolveSymbolVectorPhysicalIdentity(
    TASK8_EXACT_REPO,
    TASK8_MODEL,
  );
  const hnswIdentity = resolveSymbolVectorPhysicalIdentity(
    TASK8_HNSW_REPO,
    TASK8_MODEL,
  );
  const state: Task8CandidateState = {
    storedRepoIds: [],
    eligibleCounts: {},
    completeCounts: {},
    vectorOwners: {},
    tableNames: [],
    indexes: [],
    exactProbeFailures: new Set(),
    annProbeFailures: new Set(),
  };
  const operations: string[] = [];
  const startedRepoIds: string[] = [];
  let publicationCount = 0;
  let candidateNumber = 0;
  let exactProbeCount = 0;
  let annProbeCount = 0;
  let lastCandidatePath = "";

  function reset(): void {
    state.storedRepoIds = [TASK8_EXACT_REPO, TASK8_HNSW_REPO];
    state.eligibleCounts = {
      [TASK8_EXACT_REPO]: 1_999,
      [TASK8_HNSW_REPO]: 2_000,
    };
    state.completeCounts = { ...state.eligibleCounts };
    state.vectorOwners = {
      [TASK8_EXACT_REPO]: TASK8_EXACT_REPO,
      [TASK8_HNSW_REPO]: TASK8_HNSW_REPO,
    };
    state.tableNames = [exactIdentity.tableName, hnswIdentity.tableName].sort(
      (left, right) => left.localeCompare(right),
    );
    state.indexes = [
      {
        tableName: hnswIdentity.tableName,
        name: hnswIdentity.indexName,
        type: "vector",
        property: hnswIdentity.propertyName,
        status: "healthy",
        extensionLoaded: true,
      },
    ];
    state.exactProbeFailures = new Set();
    state.annProbeFailures = new Set();
    operations.length = 0;
    startedRepoIds.length = 0;
    publicationCount = 0;
    exactProbeCount = 0;
    annProbeCount = 0;
    lastCandidatePath = "";
  }

  function makeConfig() {
    return {
      repos: [
        {
          repoId: TASK8_HNSW_REPO,
          rootPath: join(root, TASK8_HNSW_REPO),
          ignore: [],
          languages: ["ts"],
        },
        {
          repoId: TASK8_EXACT_REPO,
          rootPath: join(root, TASK8_EXACT_REPO),
          ignore: [],
          languages: ["ts"],
        },
      ],
      graphDatabase: { path: activePath },
      policy: {},
      indexing: {
        pipeline: "legacy",
        engine: "typescript",
        enableFileWatching: false,
      },
      semantic: {
        enabled: true,
        provider: "mock",
        generateSummaries: false,
        embeddingProfile: "specialized",
        symbolEmbeddingModels: [TASK8_MODEL],
        fileSummaryEmbeddingModels: [],
        retrieval: {
          extensionsOptional: true,
          candidateLimit: 100,
          fts: { enabled: false, indexName: "unused_fts", topK: 10 },
          vector: { enabled: true, topK: 10, efc: 20, efs: 20 },
          fusion: { strategy: "rrf", rrfK: 60 },
        },
      },
      semanticEnrichment: { enabled: false },
      scip: { enabled: false },
    };
  }

  t.mock.module("../../dist/db/ladybug.js", {
    namedExports: {
      ...ladybug,
      getLadybugConn: async () => fakeConn,
      getLadybugDbPath: () => null,
      withWriteConn: async (
        fn: (conn: object) => unknown,
      ) => fn(fakeConn),
      closeLadybugDb: async () => {
        operations.push("failure-close");
      },
      closeSafeRebuildBeforeReopen: async () => {
        operations.push("closed-before-reopen");
      },
      closeAndPublishSafeRebuildLadybugDb: async () => {
        operations.push("published");
        publicationCount += 1;
      },
    },
  });
  t.mock.module("../../dist/db/initGraphDb.js", {
    namedExports: {
      ...initGraphDb,
      initSafeRebuildGraphDb: async () => ({
        session: { fixture: "task8" },
      }),
      reopenSafeRebuildGraphDb: async () => {
        operations.push("reopened");
      },
    },
  });
  t.mock.module("../../dist/db/ladybug-core.js", {
    namedExports: {
      ...ladybugCore,
      execCheckpoint: async () => {
        operations.push("checkpointed");
      },
      queryStoredProcAll: async () => [],
    },
  });
  t.mock.module("../../dist/db/ladybug-operation-gate.js", {
    namedExports: {
      ...operationGate,
      withExclusiveLadybugOperation: async (
        fn: () => unknown,
      ) => fn(),
    },
  });
  t.mock.module("../../dist/db/ladybug-derived-state.js", {
    namedExports: {
      ...derivedState,
      getDerivedStateFromConnection: async (_conn: object, repoId: string) => ({
        repoId,
        embeddingLifecycleState: "steady",
        graphIntegrityState: "verified",
        graphIntegrityVersionId: "version-" + repoId,
        graphIntegrityRevision: 1,
      }),
      graphIntegrityIsVerifiedForVersion: () => true,
    },
  });
  t.mock.module("../../dist/db/ladybug-queries.js", {
    namedExports: {
      ...queries,
      assertPhysicalSymbolUniqueness: async () => ({
        physicalTotal: 3_999,
        distinctTotal: 3_999,
      }),
      listRepos: async () =>
        state.storedRepoIds.map((repoId) => ({ repoId })),
      getFileCount: async () => 1,
      getEdgeCount: async () => 0,
      getLatestVersion: async (_conn: object, repoId: string) => ({
        versionId: "version-" + repoId,
      }),
      listGraphIntegrityFileStates: async () => [],
      listGraphIntegrityFilelessStates: async () => [],
      upsertRepo: async () => {},
    },
  });
  t.mock.module("../../dist/db/ladybug-safe-rebuild.js", {
    namedExports: {
      ...safeRebuildDb,
      readSafeRebuildRepoMembershipCounts: async () => ({
        physicalTotal: 1,
        distinctTotal: 1,
      }),
      readSafeRebuildSymbolPointLookupSample: async () => ({
        symbolIds: [],
        invalidSymbolIds: [],
        scannedTotal: 0,
        mismatchTotal: 0,
        mismatches: [],
      }),
      validateSafeRebuildCanonicalStrings: async () => {},
      countInvalidSafeRebuildDependencyEndpoints: async () => 0,
    },
  });
  t.mock.module("../../dist/indexer/derived-refresh-queue.js", {
    namedExports: {
      ...derivedQueue,
      disableDerivedRefreshQueue: () => {},
      enableDerivedRefreshQueue: () => {},
      shutdownDerivedRefreshQueue: async () => {},
    },
  });
  t.mock.module(
    "../../dist/indexer/provider-first/background-graph-integrity-verifier.js",
    {
      namedExports: {
        ...graphVerifier,
        waitForGraphIntegrityVerifier: async () => {},
      },
    },
  );
  t.mock.module(
    "../../dist/indexer/provider-first/persisted-graph-integrity.js",
    {
      namedExports: {
        ...persistedIntegrity,
        createGraphIntegrityExpectationFromManifest: () => ({}),
        capturePersistedGraphIntegrity: async () => ({}),
        compareGraphIntegrityExpectations: () => null,
      },
    },
  );
  t.mock.module("../../dist/retrieval/index-lifecycle.js", {
    namedExports: {
      ...indexLifecycle,
      showIndexesStrict: async () => structuredClone(state.indexes),
      queryVectorIndexProbe: async (
        _conn: object,
        _identity: object,
        repoId: string,
      ) => {
        annProbeCount += 1;
        if (state.annProbeFailures.has(repoId)) {
          throw new Error("injected ANN probe failure");
        }
        return 1;
      },
    },
  });
  t.mock.module("../../dist/retrieval/health.js", {
    namedExports: {
      ...retrievalHealth,
      listRepositorySymbolVectorTableNames: async () => {
        operations.push(
          "validated-inventory-" +
            String(
              operations.filter((entry) =>
                entry.startsWith("validated-inventory-"),
              ).length + 1,
            ),
        );
        return [...state.tableNames].sort((left, right) =>
          left.localeCompare(right),
        );
      },
      assessRepositorySymbolVectorHealth: async (
        _conn: object,
        input: {
          repoId: string;
          versionId: string | null;
          generation: number;
          lifecycleState: "steady";
          semanticConfig: Parameters<
            typeof evaluateRepositorySymbolVectorHealth
          >[0]["semanticConfig"];
          indexes: Task8CandidateIndex[];
        },
      ) => {
        const eligibleSymbolIds = task8SymbolIds(
          input.repoId,
          state.eligibleCounts[input.repoId] ?? 0,
        );
        const completeSymbolIds = task8SymbolIds(
          input.repoId,
          state.completeCounts[input.repoId] ?? 0,
        );
        const identity = resolveSymbolVectorPhysicalIdentity(
          input.repoId,
          TASK8_MODEL,
          input.semanticConfig,
        );
        return evaluateRepositorySymbolVectorHealth({
          repoId: input.repoId,
          versionId: input.versionId,
          generation: input.generation,
          lifecycleState: input.lifecycleState,
          semanticConfig: input.semanticConfig,
          tableState: state.tableNames.includes(identity.tableName)
            ? "present"
            : "absent",
          eligibleSymbolIds,
          vectorRows: completeSymbolIds.map((symbolId) => ({
            embeddingId: TASK8_MODEL + ":" + symbolId,
            repoId: state.vectorOwners[input.repoId] ?? input.repoId,
            symbolId,
            model: TASK8_MODEL,
            embeddingVectorPresent: true,
            cardHashPresent: true,
            embeddingJinaCodeVecPresent: true,
            embeddingNomicVecPresent: false,
          })),
          indexes: input.indexes,
        });
      },
    },
  });
  t.mock.module("../../dist/db/ladybug-symbol-embeddings.js", {
    namedExports: {
      ...symbolEmbeddings,
      getRepoSymbolVectorProbe: async (
        _conn: object,
        _identity: object,
        repoId: string,
        model: string,
      ) => {
        exactProbeCount += 1;
        if (state.exactProbeFailures.has(repoId)) {
          throw new Error("injected exact probe failure");
        }
        const symbolId = repoId + "-symbol-0000";
        return {
          embeddingId: model + ":" + symbolId,
          repoId,
          symbolId,
          model,
          vectorArray: probeVector,
        };
      },
    },
  });
  t.mock.module("../../dist/startup/plugins.js", {
    namedExports: {
      ...plugins,
      loadConfiguredAdapterPlugins: async () => {},
    },
  });
  t.mock.module("../../dist/util/pidfile.js", {
    namedExports: {
      ...pidfile,
      findExistingProcess: () => null,
    },
  });

  const safeRebuild = await import(
    "../../dist/cli/commands/index-safe-rebuild.js?task8-candidate-fixture"
  );

  async function run(options: {
    afterFreeze?: (config: ReturnType<typeof makeConfig>) => void;
    afterFirstValidation?: () => void;
  } = {}) {
    const config = makeConfig();
    candidateNumber += 1;
    lastCandidatePath = join(root, "candidate-" + String(candidateNumber) + ".lbug");
    return safeRebuild.runSafeRebuild({
      options: {
        force: true,
        safeRebuildPath: lastCandidatePath,
      },
      config: config as never,
      configPath: join(root, "config.json"),
      activeGraphDbPath: activePath,
      onRepoStart: (repoId: string) => startedRepoIds.push(repoId),
      _beforeCandidateInitForTesting: () => options.afterFreeze?.(config),
      _afterCandidateOpenForTesting: (phase: "initial" | "reopen") => {
        if (phase === "reopen") options.afterFirstValidation?.();
      },
      _indexRepoForTesting: async () => ({}) as never,
      _validateStorageAfterRepoForTesting: async () => {},
    });
  }

  reset();
  return {
    root,
    activePath,
    sourceFamily,
    exactIdentity,
    hnswIdentity,
    state,
    operations,
    startedRepoIds,
    reset,
    run,
    publicationCount: () => publicationCount,
    exactProbeCount: () => exactProbeCount,
    annProbeCount: () => annProbeCount,
    lastCandidatePath: () => lastCandidatePath,
  };
}


describe("safe rebuild repository-vector candidate gate", { concurrency: 1 }, () => {
  it("validates the frozen exact/HNSW plan and rejects every unsafe fact", async (t) => {
    const harness = await createTask8CandidateHarness(t);
    try {
      harness.reset();
      const validResult = await harness.run({
        afterFreeze: (sourceConfig) => {
          sourceConfig.repos.reverse();
        },
      });

      assert.deepStrictEqual(harness.startedRepoIds, [
        TASK8_HNSW_REPO,
        TASK8_EXACT_REPO,
      ]);
      assert.deepStrictEqual(
        validResult.validation.repositoryVectors.map(
          (entry: { repoId: string; mode: string }) => [
            entry.repoId,
            entry.mode,
          ],
        ),
        [
          [TASK8_EXACT_REPO, "exact"],
          [TASK8_HNSW_REPO, "hnsw"],
        ],
      );
      assert.deepStrictEqual(validResult.validation.repositoryVectorTables, [
        harness.exactIdentity.tableName,
        harness.hnswIdentity.tableName,
      ].sort((left, right) => left.localeCompare(right)));
      assert.deepStrictEqual(harness.operations, [
        "validated-inventory-1",
        "checkpointed",
        "closed-before-reopen",
        "reopened",
        "validated-inventory-2",
        "published",
      ]);
      assert.equal(harness.exactProbeCount(), 4);
      assert.equal(harness.annProbeCount(), 2);
      assert.equal(harness.publicationCount(), 1);
      assert.deepStrictEqual(
        snapshotTask8DatabaseFamily(harness.activePath),
        harness.sourceFamily,
      );

      async function expectCandidateFailure(
        name: string,
        setup: () => void,
        expected: RegExp,
        afterFirstValidation?: () => void,
      ): Promise<void> {
        await t.test(name, async () => {
          harness.reset();
          setup();
          const sourceBefore = snapshotTask8DatabaseFamily(
            harness.activePath,
          );
          await assert.rejects(
            () => harness.run({ afterFirstValidation }),
            expected,
          );
          assert.equal(
            harness.publicationCount(),
            0,
            "a rejected candidate must not publish",
          );
          assert.deepStrictEqual(
            snapshotTask8DatabaseFamily(harness.activePath),
            sourceBefore,
            "candidate failure must not mutate the active database family",
          );
          assert.equal(
            existsSync(harness.lastCandidatePath()),
            false,
            "the mocked candidate lifecycle must not alias the source family",
          );
        });
      }

      await expectCandidateFailure(
        "rejects a missing frozen repository",
        () => {
          harness.state.storedRepoIds = [TASK8_EXACT_REPO];
        },
        /configured repositories.*do not match stored repositories/u,
      );
      await expectCandidateFailure(
        "rejects an extra stored repository",
        () => {
          harness.state.storedRepoIds.push("repo-extra");
        },
        /configured repositories.*do not match stored repositories/u,
      );
      await expectCandidateFailure(
        "rejects missing eligible vectors",
        () => {
          harness.state.completeCounts[TASK8_EXACT_REPO] = 1_998;
        },
        /coverage is not bidirectional/u,
      );
      await expectCandidateFailure(
        "rejects foreign vector ownership",
        () => {
          harness.state.vectorOwners[TASK8_EXACT_REPO] = TASK8_HNSW_REPO;
        },
        /ownership mismatch/u,
      );
      await expectCandidateFailure(
        "rejects an unexpected repository-vector table before close",
        () => {
          harness.state.tableNames.push(
            "SymbolVectorEmbedding_r_unexpected",
          );
        },
        /repository vector tables.*unexpected/u,
      );
      await expectCandidateFailure(
        "rejects a table owned by a no-vector repository before close",
        () => {
          harness.state.eligibleCounts[TASK8_EXACT_REPO] = 0;
          harness.state.completeCounts[TASK8_EXACT_REPO] = 0;
        },
        /repository vector tables.*do not match expected tables/u,
      );
      await expectCandidateFailure(
        "rejects a missing expected repository-vector table",
        () => {
          harness.state.tableNames = harness.state.tableNames.filter(
            (tableName) => tableName !== harness.exactIdentity.tableName,
          );
        },
        /repository vector table is absent/u,
      );
      await expectCandidateFailure(
        "rejects a wrong HNSW catalog tuple",
        () => {
          harness.state.indexes[0] = {
            ...harness.state.indexes[0]!,
            tableName: harness.exactIdentity.tableName,
          };
        },
        /index identity is missing or ambiguous/u,
      );
      await expectCandidateFailure(
        "rejects an ambiguous HNSW catalog tuple",
        () => {
          harness.state.indexes.push({
            ...harness.state.indexes[0]!,
          });
        },
        /index identity is missing or ambiguous/u,
      );
      await expectCandidateFailure(
        "rejects a missing threshold-required HNSW",
        () => {
          harness.state.indexes = [];
        },
        /index identity is missing or ambiguous/u,
      );
      await expectCandidateFailure(
        "rejects a failed exact probe",
        () => {
          harness.state.exactProbeFailures.add(TASK8_EXACT_REPO);
        },
        /exact probe failed: injected exact probe failure/u,
      );
      await expectCandidateFailure(
        "rejects a failed ANN probe",
        () => {
          harness.state.annProbeFailures.add(TASK8_HNSW_REPO);
        },
        /ANN probe failed: injected ANN probe failure/u,
      );
      await expectCandidateFailure(
        "rechecks strict table inventory after reopen",
        () => {},
        /repository vector tables.*unexpected_after_reopen/u,
        () => {
          harness.state.tableNames.push(
            "SymbolVectorEmbedding_r_unexpected_after_reopen",
          );
        },
      );
      await expectCandidateFailure(
        "rechecks a no-vector repository table after reopen",
        () => {},
        /repository vector tables.*do not match expected tables/u,
        () => {
          harness.state.eligibleCounts[TASK8_EXACT_REPO] = 0;
          harness.state.completeCounts[TASK8_EXACT_REPO] = 0;
        },
      );

    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
