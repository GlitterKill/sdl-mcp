import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  invalidateConfigCache,
  loadConfig,
} from "../../dist/config/loadConfig.js";
import { SemanticConfigSchema } from "../../dist/config/types.js";
import {
  getLadybugDbPath,
  getLadybugConn,
  closeLadybugDb,
  closeSafeRebuildBeforeReopen,
  initLadybugDb,
  initValidatedLadybugClone,
  registerDbCloseHook,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import {
  initSafeRebuildGraphDb,
  reopenSafeRebuildGraphDb,
} from "../../dist/db/initGraphDb.js";
import {
  exec,
  execCheckpoint,
  execDdl,
  querySingle,
} from "../../dist/db/ladybug-core.js";
import { withExclusiveLadybugOperation } from "../../dist/db/ladybug-operation-gate.js";
import { copyLadybugFamilyForValidatedClone } from "../../dist/db/ladybug-family-files.js";
import { getEligibleRepoSymbolIds } from "../../dist/db/ladybug-retrieval-health.js";
import { setRepoSymbolVectorEmbeddingBatch } from "../../dist/db/ladybug-symbol-embeddings.js";
import { getLadybugLineageMarkerPath } from "../../dist/db/ladybug-lineage.js";
import {
  freezeSafeRebuildCandidatePlan,
  runSafeRebuild,
  validateSafeRebuildCandidate,
} from "../../dist/cli/commands/index-safe-rebuild.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { showIndexesStrict } from "../../dist/retrieval/index-lifecycle.js";
import {
  getDerivedState,
  markCurrentGraphIntegrityRevisionFailed,
} from "../../dist/db/ladybug-derived-state.js";

describe("safe rebuild candidate lifecycle", { concurrency: 1 }, () => {
  const previousEnv = {
    SDL_CONFIG: process.env.SDL_CONFIG,
    SDL_CONFIG_PATH: process.env.SDL_CONFIG_PATH,
    SDL_GRAPH_DB_DIR: process.env.SDL_GRAPH_DB_DIR,
    SDL_GRAPH_DB_PATH: process.env.SDL_GRAPH_DB_PATH,
    SDL_DB_PATH: process.env.SDL_DB_PATH,
  };
  let testRoot = "";

  afterEach(async () => {
    await closeLadybugDb().catch(() => {});
    invalidateConfigCache();
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (testRoot && existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
    testRoot = "";
  });

  function createFixture(): {
    activePath: string;
    candidatePath: string;
    configPath: string;
    sentinel: string;
  } {
    testRoot = mkdtempSync(join(tmpdir(), "sdl-safe-rebuild-"));
    const sourceRepo = join(testRoot, "source-repo");
    const emptyRepo = join(testRoot, "empty-repo");
    mkdirSync(join(sourceRepo, "src"), { recursive: true });
    mkdirSync(emptyRepo, { recursive: true });
    writeFileSync(
      join(sourceRepo, "src", "index.ts"),
      "export function safeRebuildValue(): number { return 42; }\n",
      "utf8",
    );

    const activePath = join(testRoot, "active-graph.lbug");
    const candidatePath = join(testRoot, "candidate-graph.lbug");
    const configPath = join(testRoot, "sdlmcp.config.json");
    const sentinel = "forensic-active-sentinel\n";
    writeFileSync(activePath, sentinel, "utf8");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [
          {
            repoId: "safe-rebuild-source",
            rootPath: sourceRepo,
            ignore: [],
            languages: ["ts"],
          },
          {
            repoId: "safe-rebuild-empty",
            rootPath: emptyRepo,
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
        semantic: { enabled: false },
        semanticEnrichment: { enabled: false },
        scip: { enabled: false },
      }),
      "utf8",
    );

    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;
    delete process.env.SDL_GRAPH_DB_DIR;
    process.env.SDL_GRAPH_DB_PATH = activePath;
    delete process.env.SDL_DB_PATH;
    invalidateConfigCache();
    return { activePath, candidatePath, configPath, sentinel };
  }

  function snapshotDatabaseFamily(graphPath: string): Record<string, string> {
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

  it("builds every configured repo and validates before close and after reopen", async () => {
    const fixture = createFixture();
    const events: string[] = [];
    const markerStates: boolean[] = [];
    const repoValidationOrder: string[] = [];
    const indexOptions: Array<Record<string, unknown> | undefined> = [];
    let candidateValidationCalls = 0;
    const config = loadConfig(fixture.configPath);
    const result = await runSafeRebuild({
      options: {
        config: fixture.configPath,
        force: true,
        safeRebuildPath: fixture.candidatePath,
      },
      config,
      configPath: fixture.configPath,
      activeGraphDbPath: fixture.activePath,
      onLifecycleEvent: (event) => {
        events.push(event);
        markerStates.push(
          existsSync(getLadybugLineageMarkerPath(fixture.candidatePath)),
        );
      },
      _afterRepoStorageValidationForTesting: (repoId) => {
        repoValidationOrder.push(`validated:${repoId}`);
      },
      _indexRepoForTesting: async (...args) => {
        indexOptions.push(args[4]);
        return indexRepo(...args);
      },
      _validateCandidateForTesting: async (plan) => {
        candidateValidationCalls += 1;
        return validateSafeRebuildCandidate(plan);
      },
      onRepoComplete: (repoId) => {
        repoValidationOrder.push(`complete:${repoId}`);
      },
    });

    assert.equal(readFileSync(fixture.activePath, "utf8"), fixture.sentinel);
    assert.equal(process.env.SDL_GRAPH_DB_PATH, fixture.activePath);
    assert.equal(getLadybugDbPath(), null);
    assert.equal(existsSync(fixture.candidatePath), true);
    assert.deepEqual(result.validation.repoIds, [
      "safe-rebuild-empty",
      "safe-rebuild-source",
    ]);
    assert.ok(result.validation.physicalSymbolTotal > 0);
    assert.equal(candidateValidationCalls, 2);
    assert.deepEqual(result.validation.repositoryVectorTables, []);
    assert.deepEqual(result.validation.repositoryVectors, []);
    assert.ok(
      events.indexOf("candidate:closed-before-reopen") <
        events.indexOf("candidate:reopened"),
    );
    assert.ok(
      events.indexOf("candidate:reopened") <
        events.indexOf("candidate:validated"),
    );
    assert.equal(events.at(-1), "candidate:closed-after-validation");
    assert.equal(
      markerStates.slice(0, -1).every((markerPresent) => !markerPresent),
      true,
      "the candidate must remain unmarked through validation and final strict close",
    );
    assert.equal(
      markerStates.at(-1),
      true,
      "the closed-family receipt is published before completion is reported",
    );
    assert.equal(
      existsSync(getLadybugLineageMarkerPath(fixture.candidatePath)),
      true,
    );
    assert.deepEqual(repoValidationOrder, [
      "validated:safe-rebuild-source",
      "complete:safe-rebuild-source",
      "validated:safe-rebuild-empty",
      "complete:safe-rebuild-empty",
    ]);
    assert.ok(indexOptions.length > 0);
    assert.ok(
      indexOptions.every(
        (options) =>
          !Object.hasOwn(options ?? {}, "deferJinaVectorIndexCreate"),
      ),
      "safe rebuild must use the normal Jina HNSW lifecycle",
    );

    await initLadybugDb(fixture.candidatePath);
    await assert.rejects(
      validateSafeRebuildCandidate({
        ...config,
        semantic: {
          enabled: true,
          provider: "mock",
          alpha: 0.6,
          retrieval: {
            extensionsOptional: true,
            candidateLimit: 100,
            fts: {
              enabled: true,
              indexName: "required_but_missing_fts",
              topK: 10,
              conjunctive: false,
            },
            vector: {
              enabled: false,
              topK: 10,
              efc: 20,
              efs: 20,
              indexes: {},
            },
            fusion: { strategy: "rrf", rrfK: 60 },
          },
        },
      }),
      /required Symbol FTS index required_but_missing_fts is absent/,
    );

    const conn = await getLadybugConn();
    const symbol = await querySingle<{ symbolId: string; name: string }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       RETURN s.symbolId AS symbolId, s.name AS name
       ORDER BY s.symbolId
       LIMIT 1`,
      { repoId: "safe-rebuild-source" },
    );
    assert.ok(symbol);
    await withWriteConn((writeConn) =>
      exec(
        writeConn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         SET s.name = $name`,
        { symbolId: symbol.symbolId, name: "injected-reopen-corruption" },
      ),
    );
    await assert.rejects(
      validateSafeRebuildCandidate(config),
      /persisted graph does not match its integrity manifest/,
    );
    await withWriteConn((writeConn) =>
      exec(
        writeConn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         SET s.name = $name`,
        { symbolId: symbol.symbolId, name: symbol.name },
      ),
    );

    const state = await getDerivedState("safe-rebuild-source");
    assert.ok(state?.graphIntegrityVersionId);
    assert.equal(typeof state.graphIntegrityRevision, "number");
    assert.equal(
      await markCurrentGraphIntegrityRevisionFailed(
        "safe-rebuild-source",
        state.graphIntegrityVersionId!,
        state.graphIntegrityRevision!,
        "injected post-reopen integrity failure",
      ),
      true,
    );
    await assert.rejects(
      validateSafeRebuildCandidate(config),
      /does not have verified graph integrity/,
    );
    await closeLadybugDb();
    assert.equal(getLadybugDbPath(), null);
  });

  it("uses the frozen configuration after the caller reorders repositories", async () => {
    const fixture = createFixture();
    const config = loadConfig(fixture.configPath);
    const activeFamilyBefore = snapshotDatabaseFamily(fixture.activePath);
    const startedRepoIds: string[] = [];

    const result = await runSafeRebuild({
      options: {
        config: fixture.configPath,
        force: true,
        safeRebuildPath: fixture.candidatePath,
      },
      config,
      configPath: fixture.configPath,
      activeGraphDbPath: fixture.activePath,
      _beforeCandidateInitForTesting: () => {
        config.repos.reverse();
      },
      onRepoStart: (repoId) => startedRepoIds.push(repoId),
    });

    assert.deepEqual(startedRepoIds, [
      "safe-rebuild-source",
      "safe-rebuild-empty",
    ]);
    assert.deepEqual(result.validation.repoIds, [
      "safe-rebuild-empty",
      "safe-rebuild-source",
    ]);
    assert.deepEqual(
      snapshotDatabaseFamily(fixture.activePath),
      activeFamilyBefore,
    );
    assert.equal(process.env.SDL_GRAPH_DB_PATH, fixture.activePath);
  });

  it("reopens a safe-rebuild candidate without bootstrapping retrieval indexes", async () => {
    const fixture = createFixture();
    const rawConfig = JSON.parse(
      readFileSync(fixture.configPath, "utf8"),
    ) as Record<string, unknown>;
    rawConfig.semantic = {
      enabled: true,
      provider: "mock",
      generateSummaries: false,
      retrieval: {
        extensionsOptional: false,
        candidateLimit: 100,
        fts: { enabled: false, indexName: "unused_fts", topK: 10 },
        vector: { enabled: true, topK: 10, efc: 20, efs: 20 },
        fusion: { strategy: "rrf", rrfK: 60 },
      },
    };
    writeFileSync(fixture.configPath, JSON.stringify(rawConfig), "utf8");
    invalidateConfigCache();
    process.env.SDL_GRAPH_DB_PATH = fixture.candidatePath;
    const config = loadConfig(fixture.configPath);
    const handle = await initSafeRebuildGraphDb(config, fixture.configPath);

    await closeSafeRebuildBeforeReopen(handle.session);
    await reopenSafeRebuildGraphDb(config, fixture.configPath, handle.session);

    const indexes = await showIndexesStrict(await getLadybugConn());
    assert.equal(
      indexes.some((index) => index.type === "vector"),
      false,
      "validation reopen must not create retrieval indexes after checkpoint",
    );
  });

  it("revalidates earlier repository manifests after each later repository checkpoint", async () => {
    const fixture = createFixture();

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config: loadConfig(fixture.configPath),
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        _afterRepoStorageValidationForTesting: async (repoId) => {
          if (repoId !== "safe-rebuild-source") return;
          const conn = await getLadybugConn();
          const symbol = await querySingle<{ symbolId: string }>(
            conn,
            `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
             RETURN s.symbolId AS symbolId
             ORDER BY s.symbolId
             LIMIT 1`,
            { repoId },
          );
          assert.ok(symbol);
          await withWriteConn((writeConn) =>
            exec(
              writeConn,
              `MATCH (s:Symbol {symbolId: $symbolId})
               SET s.name = $name`,
              {
                symbolId: symbol.symbolId,
                name: "injected-between-repositories-corruption",
              },
            ),
          );
        },
      }),
      /after repository safe-rebuild-empty:.*repository safe-rebuild-source persisted graph does not match its integrity manifest/,
    );

    assert.equal(readFileSync(fixture.activePath, "utf8"), fixture.sentinel);
    assert.equal(existsSync(fixture.candidatePath), true);
    assert.equal(getLadybugDbPath(), null);
  });

  it("scans the incident-sensitive Symbol strings during reopen validation", () => {
    const source = readFileSync("src/db/ladybug-safe-rebuild.ts", "utf8");
    for (const field of [
      "name",
      "summary",
      "searchText",
      "signatureJson",
      "embeddingMiniLM",
      "embeddingMiniLMCardHash",
      "embeddingMiniLMUpdatedAt",
      "embeddingNomic",
      "embeddingNomicCardHash",
      "embeddingNomicUpdatedAt",
      "embeddingJinaCode",
      "embeddingJinaCodeCardHash",
      "embeddingJinaCodeUpdatedAt",
      "scipSymbol",
    ]) {
      assert.match(
        source,
        new RegExp(`LOWER\\(coalesce\\(s\\.${field}, ''\\)\\)`),
        `safe rebuild validation must force a full LOWER scan of Symbol.${field}`,
      );
    }
  });

  it("stops before repository completion when the per-repo storage gate fails", async () => {
    const fixture = createFixture();
    const startedRepoIds: string[] = [];
    const completedRepoIds: string[] = [];

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config: loadConfig(fixture.configPath),
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        onRepoStart: (repoId) => startedRepoIds.push(repoId),
        onRepoComplete: (repoId) => completedRepoIds.push(repoId),
        _validateStorageAfterRepoForTesting: async (repoId) => {
          throw new Error(
            `injected physical Symbol incoherence after ${repoId}`,
          );
        },
      }),
      /injected physical Symbol incoherence after safe-rebuild-source/,
    );

    assert.deepEqual(startedRepoIds, ["safe-rebuild-source"]);
    assert.deepEqual(completedRepoIds, []);
    assert.equal(readFileSync(fixture.activePath, "utf8"), fixture.sentinel);
    assert.equal(existsSync(fixture.candidatePath), true);
    assert.equal(getLadybugDbPath(), null);
    assert.equal(
      existsSync(getLadybugLineageMarkerPath(fixture.candidatePath)),
      false,
    );
  });

  it("closes and retains a failed candidate without touching the active sentinel", async () => {
    const fixture = createFixture();

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config: loadConfig(fixture.configPath),
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        _indexRepoForTesting: async () => {
          throw new Error("injected candidate build failure");
        },
      }),
      /injected candidate build failure/,
    );

    assert.equal(getLadybugDbPath(), null);
    assert.equal(existsSync(fixture.candidatePath), true);
    assert.equal(readFileSync(fixture.activePath, "utf8"), fixture.sentinel);
    assert.equal(process.env.SDL_GRAPH_DB_PATH, fixture.activePath);
    assert.equal(
      existsSync(getLadybugLineageMarkerPath(fixture.candidatePath)),
      false,
    );
  });

  it("closes a candidate whose initial database initialization opens then fails", async () => {
    const fixture = createFixture();
    const events: string[] = [];

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config: loadConfig(fixture.configPath),
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        onLifecycleEvent: (event) => events.push(event),
        _afterCandidateOpenForTesting: async (phase) => {
          if (phase === "initial") {
            throw new Error("injected initial candidate initialization failure");
          }
        },
      }),
      /injected initial candidate initialization failure/,
    );

    assert.equal(getLadybugDbPath(), null);
    assert.equal(existsSync(fixture.candidatePath), true);
    assert.equal(readFileSync(fixture.activePath, "utf8"), fixture.sentinel);
    assert.equal(process.env.SDL_GRAPH_DB_PATH, fixture.activePath);
    assert.equal(events.at(-1), "candidate:closed-after-failure");
    assert.equal(
      existsSync(getLadybugLineageMarkerPath(fixture.candidatePath)),
      false,
    );
  });

  it("validates a byte-verified clone of the retained candidate after reopen failure", async () => {
    const fixture = createFixture();
    const events: string[] = [];
    const config = loadConfig(fixture.configPath);
    const candidatePlan = freezeSafeRebuildCandidatePlan(config);
    const activeFamilyBefore = snapshotDatabaseFamily(fixture.activePath);
    let initCalls = 0;

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config,
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        onLifecycleEvent: (event) => events.push(event),
        _afterCandidateOpenForTesting: async (phase) => {
          initCalls += 1;
          if (phase === "reopen") {
            throw new Error("injected candidate reopen initialization failure");
          }
        },
      }),
      /injected candidate reopen initialization failure/,
    );

    assert.equal(initCalls, 2);
    assert.equal(getLadybugDbPath(), null);
    assert.equal(existsSync(fixture.candidatePath), true);
    assert.equal(process.env.SDL_GRAPH_DB_PATH, fixture.activePath);
    assert.equal(events.at(-1), "candidate:closed-after-failure");
    assert.equal(events.includes("candidate:validated"), false);
    assert.equal(
      existsSync(getLadybugLineageMarkerPath(fixture.candidatePath)),
      false,
    );

    const retainedFamilyBefore = snapshotDatabaseFamily(fixture.candidatePath);
    const validationClonePath = join(
      dirname(fixture.candidatePath),
      "retained-validation-clone.lbug",
    );
    const capability = copyLadybugFamilyForValidatedClone(
      fixture.candidatePath,
      validationClonePath,
    );
    await initValidatedLadybugClone(validationClonePath, capability);
    const firstValidation = await validateSafeRebuildCandidate(candidatePlan);
    const firstValidationBytes = JSON.stringify(firstValidation);
    const secondValidation = await validateSafeRebuildCandidate(candidatePlan);
    assert.equal(JSON.stringify(secondValidation), firstValidationBytes);
    await closeLadybugDb({ strict: true });

    assert.deepEqual(
      snapshotDatabaseFamily(fixture.candidatePath),
      retainedFamilyBefore,
      "validated-clone inspection must not mutate the retained candidate",
    );
    assert.equal(
      existsSync(getLadybugLineageMarkerPath(fixture.candidatePath)),
      false,
      "validated-clone inspection must not publish the retained candidate",
    );
    assert.deepEqual(
      snapshotDatabaseFamily(fixture.activePath),
      activeFamilyBefore,
    );
  });

  it("closes and retains a candidate that fails post-reopen validation", async () => {
    const fixture = createFixture();

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config: loadConfig(fixture.configPath),
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        _validateCandidateForTesting: (() => {
          let calls = 0;
          return async (plan) => {
            calls += 1;
            if (calls === 2) {
              throw new Error("injected post-reopen validation failure");
            }
            return validateSafeRebuildCandidate(plan);
          };
        })(),
      }),
      /injected post-reopen validation failure/,
    );

    assert.equal(getLadybugDbPath(), null);
    assert.equal(existsSync(fixture.candidatePath), true);
    assert.equal(readFileSync(fixture.activePath, "utf8"), fixture.sentinel);
    assert.equal(process.env.SDL_GRAPH_DB_PATH, fixture.activePath);
    assert.equal(
      existsSync(getLadybugLineageMarkerPath(fixture.candidatePath)),
      false,
    );
  });

  it("accepts repository exact mode below the HNSW threshold", async () => {
    const fixture = createFixture();
    const activeFamilyBefore = snapshotDatabaseFamily(fixture.activePath);
    const disabledConfig = loadConfig(fixture.configPath);

    // Build and reopen a structurally verified candidate without relying on a
    // test embedding provider. The validator fixture adds real disk-backed
    // vectors only after the normal safe-rebuild lifecycle has completed.
    await runSafeRebuild({
      options: {
        config: fixture.configPath,
        force: true,
        safeRebuildPath: fixture.candidatePath,
      },
      config: disabledConfig,
      configPath: fixture.configPath,
      activeGraphDbPath: fixture.activePath,
    });

    const model = "jina-embeddings-v2-base-code";
    const enabledPlan = freezeSafeRebuildCandidatePlan({
      ...disabledConfig,
      semantic: SemanticConfigSchema.parse({
        enabled: true,
        provider: "local",
        generateSummaries: false,
        embeddingProfile: "specialized",
        symbolEmbeddingModels: [model],
        fileSummaryEmbeddingModels: [],
        retrieval: {
          extensionsOptional: true,
          candidateLimit: 100,
          fts: { enabled: false, indexName: "unused_fts", topK: 10 },
          vector: { enabled: true, topK: 10, efc: 20, efs: 20 },
          fusion: { strategy: "rrf", rrfK: 60 },
        },
      }),
    });

    await initLadybugDb(fixture.candidatePath);
    let eligibleSymbolIds: string[] = [];
    const vectorArray = [1, ...Array<number>(767).fill(0)];
    await withExclusiveLadybugOperation(() =>
      withWriteConn(async (conn) => {
        eligibleSymbolIds = await getEligibleRepoSymbolIds(
          conn,
          "safe-rebuild-source",
        );
        await setRepoSymbolVectorEmbeddingBatch(
          conn,
          "safe-rebuild-source",
          model,
          eligibleSymbolIds.map((symbolId) => ({
            symbolId,
            vector: JSON.stringify(vectorArray),
            cardHash: `hash-${symbolId}`,
            vectorArray,
          })),
        );
        await execCheckpoint(conn);
      }),
    );
    assert.ok(eligibleSymbolIds.length > 0);

    const validationBeforeReopen =
      await validateSafeRebuildCandidate(enabledPlan);
    await closeLadybugDb({ strict: true });
    await initLadybugDb(fixture.candidatePath);
    const validation = await validateSafeRebuildCandidate(enabledPlan);
    assert.deepEqual(validation, validationBeforeReopen);

    const sourceVector = validation.repositoryVectors.find(
      (entry) => entry.repoId === "safe-rebuild-source",
    );
    const emptyVector = validation.repositoryVectors.find(
      (entry) => entry.repoId === "safe-rebuild-empty",
    );
    assert.equal(sourceVector?.mode, "exact");
    assert.equal(sourceVector?.completeVectorCount, eligibleSymbolIds.length);
    assert.equal(sourceVector?.indexName, undefined);
    assert.equal(emptyVector?.mode, "none");
    assert.deepEqual(validation.repositoryVectorTables, [
      sourceVector?.tableName,
    ]);
    assert.deepEqual(
      snapshotDatabaseFamily(fixture.activePath),
      activeFamilyBefore,
    );
    assert.equal(
      existsSync(getLadybugLineageMarkerPath(fixture.candidatePath)),
      true,
    );
  });

  it("rejects an unexpected repository-vector table introduced after pre-close validation", async () => {
    const fixture = createFixture();
    const activeFamilyBefore = snapshotDatabaseFamily(fixture.activePath);
    let validationCalls = 0;

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config: loadConfig(fixture.configPath),
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        _validateCandidateForTesting: async (plan) => {
          const validation = await validateSafeRebuildCandidate(plan);
          validationCalls += 1;
          if (validationCalls === 1) {
            await withWriteConn((conn) =>
              execDdl(
                conn,
                "CREATE NODE TABLE SymbolVectorEmbedding_r_unexpected (embeddingId STRING PRIMARY KEY)",
              ),
            );
          }
          return validation;
        },
      }),
      /repository vector tables.*SymbolVectorEmbedding_r_unexpected/iu,
    );

    assert.equal(validationCalls, 1);
    assert.deepEqual(
      snapshotDatabaseFamily(fixture.activePath),
      activeFamilyBefore,
    );
    assert.equal(process.env.SDL_GRAPH_DB_PATH, fixture.activePath);
    assert.equal(getLadybugDbPath(), null);
    assert.equal(existsSync(fixture.candidatePath), true);
    assert.equal(
      existsSync(getLadybugLineageMarkerPath(fixture.candidatePath)),
      false,
    );
  });

  it("rejects a safe-rebuild target that appears after preflight", async () => {
    const fixture = createFixture();

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config: loadConfig(fixture.configPath),
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        _beforeCandidateInitForTesting: () => {
          writeFileSync(fixture.candidatePath, "appeared-after-preflight", "utf8");
        },
      }),
      /database family is not fresh[\s\S]*--safe-rebuild/iu,
    );

    assert.equal(
      existsSync(getLadybugLineageMarkerPath(fixture.candidatePath)),
      false,
    );
  });

  it("refuses publication when the validated target is replaced", async () => {
    const fixture = createFixture();

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config: loadConfig(fixture.configPath),
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        _beforeLineagePublicationForTesting: () => {
          renameSync(
            fixture.candidatePath,
            fixture.candidatePath + ".validated",
          );
          writeFileSync(
            fixture.candidatePath,
            "replacement-after-validation",
            "utf8",
          );
        },
      }),
      /changed after validation/iu,
    );

    assert.equal(getLadybugDbPath(), null);
    assert.equal(
      existsSync(getLadybugLineageMarkerPath(fixture.candidatePath)),
      false,
    );
  });

  it("returns no result or marker when final strict close fails", async () => {
    const fixture = createFixture();

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config: loadConfig(fixture.configPath),
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        _validateCandidateForTesting: (() => {
          let calls = 0;
          return async (plan) => {
            const validation = await validateSafeRebuildCandidate(plan);
            calls += 1;
            if (calls !== 2) return validation;
            registerDbCloseHook(() => {
            throw new Error("injected final candidate close failure");
            });
            return validation;
          };
        })(),
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /strict close failed/iu);
        assert.ok(
          error.errors.some(
            (cause) =>
              cause instanceof Error &&
              /injected final candidate close failure/iu.test(cause.message),
          ),
        );
        return true;
      },
    );

    assert.equal(getLadybugDbPath(), null);
    assert.equal(
      existsSync(getLadybugLineageMarkerPath(fixture.candidatePath)),
      false,
    );
  });
});
