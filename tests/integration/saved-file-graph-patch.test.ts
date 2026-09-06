import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Connection } from "kuzu";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import {
  clearPreparedStatementCache,
  exec,
} from "../../dist/db/ladybug-core.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  getAdapterForExtension,
  loadPluginsSync,
} from "../../dist/indexer/adapter/registry.js";
import { getHostApiVersion } from "../../dist/indexer/adapter/plugin/loader.js";
import {
  capturePersistedGraphIntegrity,
  compareGraphIntegrityExpectations,
  createGraphIntegrityFilelessDelta,
  createGraphIntegrityFilelessEdgeReferences,
  createGraphIntegrityFilelessReferenceTuples,
  createGraphIntegrityFilelessSymbols,
  createGraphIntegrityExpectationFromManifest,
  createGraphIntegrityFileState,
  parseGraphIntegrityCanonicalSymbol,
} from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import { patchSavedFile } from "../../dist/live-index/file-patcher.js";
import * as filePatcher from "../../dist/live-index/file-patcher.js";
import { prepareReconcileFiles } from "../../dist/indexer/provider-first/reconcile-preparation.js";
import { AppConfigSchema, RepoConfigSchema } from "../../dist/config/types.js";
import { hashContent } from "../../dist/util/hashing.js";
import { runToolDispatch } from "../../dist/mcp/dispatch-limiter.js";
import { isIndexingActive } from "../../dist/mcp/indexing-gate.js";
import { withRepoWriteHeavyLock } from "../../dist/indexer/derived-refresh-queue.js";
import { ReconcileQueue } from "../../dist/live-index/reconcile-queue.js";
import {
  parseDraftFile,
  parserCoverageMatchesVerifiedGraph,
  preflightDraftParser,
} from "../../dist/live-index/draft-parser.js";
import { generateFileId } from "../../dist/util/hashing.js";
import {
  getDerivedState,
  markGraphIntegrityVerified,
} from "../../dist/db/ladybug-derived-state.js";
import { handleBufferPush } from "../../dist/mcp/tools/buffer.js";
import {
  resetDefaultLiveIndexCoordinator,
  waitForDefaultLiveIndexIdle,
} from "../../dist/live-index/coordinator.js";
import {
  cancelAndWaitForGraphIntegrityVerifier,
  notifyGraphIntegrityVerifier,
  waitForGraphIntegrityVerifier,
} from "../../dist/indexer/provider-first/background-graph-integrity-verifier.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function clearTestPreparedStatementCaches(): Promise<void> {
  // Driver interception needs fresh prepare calls on the write connection and
  // every round-robin reader used by the verifier assertions below.
  const connections = new Set<Connection>();
  for (let index = 0; index < 8; index += 1) {
    connections.add(await getLadybugConn());
  }
  await withWriteConn((conn) => {
    connections.add(conn);
  });
  for (const conn of connections) clearPreparedStatementCache(conn);
}

async function waitForVerifiedRevision(
  repoId: string,
  revision: number,
): Promise<NonNullable<Awaited<ReturnType<typeof getDerivedState>>>> {
  await waitForGraphIntegrityVerifier(repoId);
  const state = await getDerivedState(repoId);
  const parserState = await ladybugDb.getRepoParserState(
    await getLadybugConn(),
    repoId,
  );
  if (
    state?.graphIntegrityState === "verified" &&
    state.graphIntegrityVerifiedRevision === revision &&
    parserCoverageMatchesVerifiedGraph(
      state,
      state.graphIntegrityVersionId ?? "",
      parserState,
    )
  ) {
    return state;
  }
  throw new Error(`Graph integrity revision ${revision} was not fully published: state=${state?.graphIntegrityState}/${state?.graphIntegrityVersionId}/${state?.graphIntegrityRevision}/${state?.graphIntegrityVerifiedRevision}; parser=${parserState?.coverageState}/${parserState?.graphVersionId}/${parserState?.graphRevision}`);
}

async function restoreGraphIntegrityState(
  repoId: string,
  state: NonNullable<Awaited<ReturnType<typeof getDerivedState>>>,
): Promise<void> {
  await withWriteConn((conn) =>
    exec(
      conn,
      `MATCH (d:DerivedState {repoId: $repoId})
       SET d.graphIntegrityState = 'verified',
           d.graphIntegrityVersionId = $versionId,
           d.graphIntegrityDigest = $digest,
           d.graphIntegrityError = NULL,
           d.graphIntegrityRevision = $revision,
           d.graphIntegrityVerifiedRevision = $verifiedRevision,
           d.graphIntegrityFilelessPruningSupported = $filelessPruningSupported,
           d.updatedAt = $updatedAt`,
      {
        repoId,
        versionId: state.graphIntegrityVersionId,
        digest: state.graphIntegrityDigest,
        revision: state.graphIntegrityRevision,
        verifiedRevision: state.graphIntegrityVerifiedRevision,
        filelessPruningSupported:
          state.graphIntegrityFilelessPruningSupported,
        updatedAt: state.updatedAt,
      },
    ),
  );
}

describe("saved file graph patch", () => {
  const repoId = "saved-file-graph-patch-repo";
  const durableFileId = generateFileId(repoId, "src/example.ts");
  const providerExternalId = "scip-typescript npm fixture 1.0.0 dep#external().";
  let testDir = "";
  let dbPath = "";
  let configPath = "";
  let repoDir = "";
  let baselineDigest = "";
  let providerCanonicalJson = "";
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    testDir = mkdtempSync(join(tmpdir(), "sdl-saved-file-patch-test-"));
    dbPath = join(testDir, "graph.lbug");
    configPath = join(testDir, "config.json");
    repoDir = mkdtempSync(join(tmpdir(), "sdl-saved-file-patch-repo-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "example.ts"),
      [
        "export function alpha() {",
        "  return beta();",
        "}",
        "",
        "export function beta() {",
        "  return 1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify(
        { repos: [], policy: {}, indexing: { engine: "typescript", enableFileWatching: false } },
        null,
        2,
      ),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    await closeLadybugDb();
    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const now = "2026-03-07T12:00:00.000Z";
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
      }),
      createdAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: durableFileId,
      repoId,
      relPath: "src/example.ts",
      contentHash: "baseline-content-hash",
      language: "typescript",
      byteSize: 108,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertSymbolBatch(conn, [
      {
        symbolId: "scip-alpha",
        repoId,
        fileId: durableFileId,
        kind: "function",
        name: "alpha",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 3,
        rangeEndCol: 1,
        astFingerprint: "baseline-alpha",
        signatureJson: JSON.stringify({ name: "alpha" }),
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        source: "scip",
        packageName: "fixture",
        packageVersion: "1.0.0",
        scipSymbol: "scip-alpha",
        updatedAt: now,
      },
      {
        symbolId: "stable-beta",
        repoId,
        fileId: durableFileId,
        kind: "function",
        name: "beta",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 5,
        rangeStartCol: 0,
        rangeEndLine: 7,
        rangeEndCol: 1,
        astFingerprint: "baseline-beta",
        signatureJson: JSON.stringify({ name: "beta" }),
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      },
    ]);
    const providerExternal = {
      symbolId: providerExternalId,
      kind: "function",
      name: "external",
      exported: true,
      language: "typescript",
      rangeStartLine: 0,
      rangeStartCol: 0,
      rangeEndLine: 0,
      rangeEndCol: 0,
      external: true,
      scipSymbol: providerExternalId,
      source: "scip" as const,
      updatedAt: now,
    };
    const providerEdge = {
      repoId,
      fromSymbolId: "scip-alpha",
      toSymbolId: providerExternalId,
      edgeType: "call",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      provenance: null,
      resolverId: "scip",
      createdAt: now,
    };
    await ladybugDb.batchMergeExternalSymbols(conn, repoId, [providerExternal]);
    await ladybugDb.insertEdges(conn, [providerEdge]);

    await ladybugDb.createVersion(conn, {
      versionId: "v1",
      repoId,
      createdAt: now,
      reason: "verified live-edit baseline",
      prevVersionHash: null,
      versionHash: null,
    });
    const baseline = await capturePersistedGraphIntegrity(conn, repoId);
    baselineDigest = baseline.digest;
    const baselineSymbols = await ladybugDb.getSymbolsByFile(conn, durableFileId);
    const baselineFilelessSymbols = createGraphIntegrityFilelessSymbols({
      symbols: baselineSymbols,
      externalSymbols: [providerExternal],
      edges: [providerEdge],
    });
    const baselineReferences = createGraphIntegrityFilelessReferenceTuples(
      createGraphIntegrityFilelessEdgeReferences(
        [providerEdge],
        baselineFilelessSymbols.map((symbol) => symbol.symbolId),
        { trackSources: true },
      ),
      baselineFilelessSymbols,
      new Map(),
    );
    const baselineFileless = createGraphIntegrityFilelessDelta(
      repoId,
      new Map(),
      [],
      baselineReferences,
      true,
    ).upserts;
    providerCanonicalJson = baselineFileless.find(
      (state) => state.symbolId === providerExternalId,
    )!.canonicalSymbolJson;
    await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, repoId, {
      files: [
        createGraphIntegrityFileState(
          repoId,
          durableFileId,
          "src/example.ts",
          baselineSymbols,
          baselineReferences,
        ),
      ],
      fileless: baselineFileless,
    });
    await ladybugDb.upsertFileParserStatesInTransaction(conn, [
      {
        stateId: JSON.stringify([repoId, durableFileId]),
        repoId,
        fileId: durableFileId,
        engine: "typescript",
        engineContract: "typescript:1",
        adapterKey: "builtin:typescript:typescript:1",
        language: "typescript",
      },
    ]);
    const coverageDigest =
      await ladybugDb.verifyExactParserCoverageInTransaction(conn, repoId);
    await ladybugDb.upsertRepoParserStateInTransaction(conn, {
      repoId,
      coverageState: "complete",
      graphVersionId: "v1",
      graphRevision: 0,
      coverageDigest,
    });
    await markGraphIntegrityVerified(repoId, "v1", baselineDigest);
    const seededDerivedState = await getDerivedState(repoId);
    const seededRepoParserState = await ladybugDb.getRepoParserState(
      conn,
      repoId,
    );
    assert.equal(seededDerivedState?.graphIntegrityState, "verified");
    assert.equal(seededDerivedState?.graphIntegrityManifestEstablished, true);
    assert.equal(seededDerivedState?.graphIntegrityRevision, 0);
    assert.equal(seededDerivedState?.graphIntegrityVerifiedRevision, 0);
    assert.match(seededDerivedState?.graphIntegrityDigest ?? "", /^[a-f0-9]{64}$/);
    assert.equal(
      seededDerivedState?.graphIntegrityFilelessPruningSupported,
      true,
    );
    assert.equal(seededRepoParserState?.coverageState, "complete");
    assert.equal(seededRepoParserState?.graphVersionId, "v1");
    assert.equal(seededRepoParserState?.graphRevision, 0);
    assert.equal(
      parserCoverageMatchesVerifiedGraph(
        seededDerivedState,
        "v1",
        seededRepoParserState,
      ),
      true,
    );
    const seededPreflight = await preflightDraftParser({
      repoId,
      filePath: "src/example.ts",
    });
    assert.equal(seededPreflight.contract.engine, "typescript");
    const normalizedPreflight = await preflightDraftParser({
      repoId,
      filePath: "src\\example.ts",
    });
    assert.equal(normalizedPreflight.relPath, "src/example.ts");
    assert.equal(normalizedPreflight.durableFile?.fileId, durableFileId);
  });

  beforeEach(async () => {
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    resetDefaultLiveIndexCoordinator();
  });

  it("prepares parser rows without publication and leaves a corrupt baseline unmodified", async () => {
    assert.equal(typeof filePatcher.prepareSavedFilePatch, "function", "read-only parser preparation is required");
    const conn = await getLadybugConn();
    const beforeState = await getDerivedState(repoId);
    const beforeGraph = await capturePersistedGraphIntegrity(conn, repoId);
    const manifest = {
      files: await ladybugDb.listGraphIntegrityFileStates(conn, repoId),
      fileless: await ladybugDb.listGraphIntegrityFilelessStates(conn, repoId),
    };
    const request = { repoId, filePath: "src/example.ts", content: "export function fresh() { return 2; }", version: 2 };
    const prepared = await filePatcher.prepareSavedFilePatch(request);
    assert.equal(prepared.contentHash, prepared.parseResult.file.contentHash);
    assert.equal(prepared.graphRevision, beforeState!.graphIntegrityRevision);
    assert.equal(prepared.parserContract.engine, "typescript");
    assert.equal(typeof prepared.commit, "function");
    assert.deepEqual(await capturePersistedGraphIntegrity(conn, repoId), beforeGraph);
    assert.deepEqual(await getDerivedState(repoId), beforeState);
    await withWriteConn((writeConn) => ladybugDb.replaceGraphIntegrityManifestInTransaction(writeConn, repoId, { files: [], fileless: manifest.fileless }));
    try {
      await assert.rejects(filePatcher.prepareSavedFilePatch(request), /integrity/i);
      assert.deepEqual(await getDerivedState(repoId), beforeState);
    } finally {
      await withWriteConn((writeConn) => ladybugDb.replaceGraphIntegrityManifestInTransaction(writeConn, repoId, manifest));
    }
  });

  it("keeps dispatch, writer, write-heavy lock and new saves available during parser-selected preparation", { timeout: 15_000 }, async (t) => {
    const content = readFileSync(join(repoDir, "src/example.ts"), "utf8");
    const repoConfig = RepoConfigSchema.parse({ repoId, rootPath: repoDir, languages: ["ts"] });
    const entered = deferred();
    const release = deferred();
    let held = false;
    await clearTestPreparedStatementCaches();
    const originalPrepare = Connection.prototype.prepare;
    t.mock.method(Connection.prototype, "prepare", async function (statement) {
      if (!held && statement.includes("MATCH (f:GraphIntegrityFileState")) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return originalPrepare.call(this, statement);
    });
    const beforeState = await getDerivedState(repoId);
    const pending = prepareReconcileFiles({ repoId, repoRoot: repoDir, repoConfig,
      appConfig: AppConfigSchema.parse({ repos: [repoConfig], policy: {}, indexing: { pipeline: "legacy" } }),
      files: [{ path: "src/example.ts", content, contentHash: hashContent(content), size: Buffer.byteLength(content) }],
      dependencyInputs: [], assertCurrent: () => {},
    });
    try {
      await entered.promise;
      assert.equal(isIndexingActive(), false);
      await runToolDispatch(async () => {});
      await withWriteConn(async () => {});
      await withRepoWriteHeavyLock(repoId, async () => {});
      const queue = new ReconcileQueue();
      const frontier = { touchedSymbolIds: [], dependentSymbolIds: [], dependentFilePaths: [], importedFilePaths: [], invalidations: [] };
      queue.enqueue(repoId, frontier, "1", { "src/example.ts": { kind: "saved", content, sourceHash: hashContent(content) } });
      const claim = queue.claimNext()!;
      assert.equal(queue.enqueue(repoId, frontier, "2", { "src/example.ts": { kind: "saved", content: "newer", sourceHash: hashContent("newer") } }), true);
      assert.equal(queue.isCurrent(claim), false);
      release.resolve();
      const prepared = await pending;
      assert.equal(prepared.kind, "parser");
      assert.equal(prepared.patches[0].parserContract.engine, "typescript");
      assert.deepEqual(await getDerivedState(repoId), beforeState);
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });

  it("accepts current partial repository coverage for a durable file with a valid parser contract", async () => {
    const conn = await getLadybugConn();
    const baseline = await ladybugDb.getRepoParserState(conn, repoId);
    assert.ok(baseline);
    await withWriteConn((writeConn) =>
      ladybugDb.upsertRepoParserStateInTransaction(writeConn, {
        ...baseline,
        coverageState: "partial",
      }),
    );
    try {
      const preflight = await preflightDraftParser({
        repoId,
        filePath: "src/example.ts",
      });
      assert.equal(preflight.repoParserState.coverageState, "partial");
      assert.equal(preflight.durableFile?.fileId, durableFileId);
      assert.equal(preflight.contract.engine, "typescript");
      assert.equal(preflight.contract.engineContract, "typescript:1");
    } finally {
      await withWriteConn((writeConn) =>
        ladybugDb.upsertRepoParserStateInTransaction(writeConn, baseline),
      );
    }
  });

  after(async () => {
    resetDefaultLiveIndexCoordinator();
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    await closeLadybugDb();
    if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (repoDir && existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = prevConfig;
    if (prevConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = prevConfigPath;
  });

  it("rejects every invalid provenance predicate before parsing or writing", async (t) => {
    const conn = await getLadybugConn();
    const baselineDerived = await getDerivedState(repoId);
    const baselineRepoState = await ladybugDb.getRepoParserState(conn, repoId);
    const baselineFileState = await ladybugDb.getFileParserState(
      conn,
      repoId,
      durableFileId,
    );
    assert.ok(baselineDerived && baselineRepoState && baselineFileState);

    const otherRepoId = repoId + "-wrong-owner";
    await withWriteConn((writeConn) =>
      ladybugDb.upsertRepo(writeConn, {
        repoId: otherRepoId,
        rootPath: repoDir,
        configJson: "{}",
        createdAt: "2026-03-07T12:00:00.000Z",
      }),
    );

    const statements = new WeakMap<object, string>();
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    let armed = false;
    let writeAttempts = 0;
    t.mock.method(Connection.prototype, "prepare", async function (statement) {
      const prepared = await originalPrepare.call(this, statement);
      statements.set(prepared, statement);
      return prepared;
    });
    t.mock.method(
      Connection.prototype,
      "execute",
      async function (prepared, params, progressCallback) {
        const statement = statements.get(prepared) ?? "";
        if (
          armed &&
          /\b(?:MERGE|CREATE|SET|DELETE|DETACH)\b/.test(statement)
        ) {
          writeAttempts += 1;
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    const adapter = getAdapterForExtension(".ts");
    assert.ok(adapter);
    const originalParse = adapter.parse;
    let parseAttempts = 0;
    adapter.parse = (...args) => {
      if (armed) parseAttempts += 1;
      return originalParse.call(adapter, ...args);
    };

    const cases: Array<{
      name: string;
      expectedCode: string;
      corrupt: () => Promise<void>;
    }> = [
      {
        name: "graph state",
        expectedCode: "PARSER_PROVENANCE_INCOMPLETE",
        corrupt: () =>
          withWriteConn((writeConn) =>
            exec(
              writeConn,
              `MATCH (d:DerivedState {repoId: $repoId})
               SET d.graphIntegrityState = 'failed'`,
              { repoId },
            ),
          ),
      },
      {
        name: "verified revision",
        expectedCode: "PARSER_PROVENANCE_INCOMPLETE",
        corrupt: () =>
          withWriteConn((writeConn) =>
            exec(
              writeConn,
              `MATCH (d:DerivedState {repoId: $repoId})
               SET d.graphIntegrityRevision = d.graphIntegrityRevision + 1`,
              { repoId },
            ),
          ),
      },
      {
        name: "coverage state",
        expectedCode: "DATABASE_ERROR",
        corrupt: () =>
          withWriteConn((writeConn) =>
            exec(
              writeConn,
              `MATCH (s:RepoParserState {repoId: $repoId})
               SET s.coverageState = 'incomplete'`,
              { repoId },
            ),
          ),
      },
      {
        name: "coverage version",
        expectedCode: "PARSER_PROVENANCE_INCOMPLETE",
        corrupt: () =>
          withWriteConn((writeConn) =>
            exec(
              writeConn,
              `MATCH (s:RepoParserState {repoId: $repoId})
               SET s.graphVersionId = 'wrong-version'`,
              { repoId },
            ),
          ),
      },
      {
        name: "coverage revision",
        expectedCode: "PARSER_PROVENANCE_INCOMPLETE",
        corrupt: () =>
          withWriteConn((writeConn) =>
            exec(
              writeConn,
              `MATCH (s:RepoParserState {repoId: $repoId})
               SET s.graphRevision = s.graphRevision + 1`,
              { repoId },
            ),
          ),
      },
      {
        name: "missing file state",
        expectedCode: "PARSER_FILE_STATE_MISSING",
        corrupt: () =>
          withWriteConn((writeConn) =>
            ladybugDb.deleteFileParserStatesByFileIdsInTransaction(
              writeConn,
              [durableFileId],
            ),
          ),
      },
      {
        name: "duplicate file state",
        expectedCode: "DATABASE_ERROR",
        corrupt: () =>
          withWriteConn((writeConn) =>
            exec(
              writeConn,
              `MATCH (r:Repo {repoId: $repoId})
               CREATE (s:FileParserState {
                 stateId: $stateId, repoId: $repoId, fileId: $fileId,
                 engine: 'typescript', engineContract: 'typescript:1',
                 adapterKey: 'builtin:typescript:typescript:1',
                 language: 'typescript'
               })
               CREATE (s)-[:FILE_PARSER_STATE_IN_REPO]->(r)`,
              {
                repoId,
                fileId: durableFileId,
                stateId: JSON.stringify([repoId, durableFileId, "duplicate"]),
              },
            ),
          ),
      },
      {
        name: "wrong file-state owner",
        expectedCode: "DATABASE_ERROR",
        corrupt: () =>
          withWriteConn((writeConn) =>
            exec(
              writeConn,
              `MATCH (s:FileParserState {stateId: $stateId})
               MATCH (r:Repo {repoId: $otherRepoId})
               CREATE (s)-[:FILE_PARSER_STATE_IN_REPO]->(r)`,
              { stateId: baselineFileState.stateId, otherRepoId },
            ),
          ),
      },
      {
        name: "parser contract",
        expectedCode: "PARSER_CONTRACT_MISMATCH",
        corrupt: () =>
          withWriteConn((writeConn) =>
            exec(
              writeConn,
              `MATCH (s:FileParserState {stateId: $stateId})
               SET s.engineContract = 'typescript:2'`,
              { stateId: baselineFileState.stateId },
            ),
          ),
      },
    ];

    try {
      for (const [index, candidate] of cases.entries()) {
        await candidate.corrupt();
        await clearTestPreparedStatementCaches();
        parseAttempts = 0;
        writeAttempts = 0;
        armed = true;
        try {
          await assert.rejects(
            patchSavedFile({
              repoId,
              filePath: "src/example.ts",
              content: "export function rejected() { return 0; }",
              language: "typescript",
              version: 100 + index,
            }),
            (error: unknown) => {
              assert.equal(
                (error as { code?: unknown }).code,
                candidate.expectedCode,
                candidate.name,
              );
              return true;
            },
          );
          assert.equal(parseAttempts, 0, candidate.name + " parsed");
          assert.equal(writeAttempts, 0, candidate.name + " wrote");
        } finally {
          armed = false;
          await restoreGraphIntegrityState(repoId, baselineDerived);
          await withWriteConn(async (writeConn) => {
            await ladybugDb.deleteFileParserStatesByFileIdsInTransaction(
              writeConn,
              [durableFileId],
            );
            await ladybugDb.upsertFileParserStatesInTransaction(writeConn, [
              baselineFileState,
            ]);
            await ladybugDb.upsertRepoParserStateInTransaction(
              writeConn,
              baselineRepoState,
            );
          });
        }
      }
    } finally {
      armed = false;
      adapter.parse = originalParse;
    }
  });

  it("keeps a provider-backed declaration range stable across edit and restore", async () => {
    const baselineContent = [
      "export function alpha() {",
      "  return beta();",
      "}",
      "",
      "export function beta() {",
      "  return 1;",
      "}",
    ].join("\n");
    const editedContent = baselineContent.replace(
      "return beta();",
      "return beta() + 1;",
    );
    assert.notEqual(editedContent, baselineContent);

    const conn = await getLadybugConn();
    const baselineSymbols = await ladybugDb.getSymbolsByFile(conn, durableFileId);
    const baselineAlpha = baselineSymbols.find((symbol) => symbol.name === "alpha");
    assert.ok(baselineAlpha);
    assert.equal(baselineAlpha.symbolId, "scip-alpha");

    const completeRange = (
      symbol: (typeof baselineSymbols)[number],
    ) => ({
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
      endLine: symbol.rangeEndLine,
      endCol: symbol.rangeEndCol,
    });
    const baselineRange = completeRange(baselineAlpha);

    const patchAndReadAlpha = async (content: string, version: number) => {
      let committedRevision: number | undefined;
      await patchSavedFile(
        {
          repoId,
          filePath: "src/example.ts",
          content,
          language: "typescript",
          version,
        },
        {
          onCommitted(revision: number) {
            committedRevision = revision;
          },
        },
      );
      assert.ok(committedRevision !== undefined);
      await waitForVerifiedRevision(repoId, committedRevision);

      const symbols = await ladybugDb.getSymbolsByFile(conn, durableFileId);
      const alpha = symbols.find((symbol) => symbol.name === "alpha");
      assert.ok(alpha);
      assert.equal(alpha.symbolId, "scip-alpha");
      return alpha;
    };

    const editedAlpha = await patchAndReadAlpha(editedContent, 2);
    assert.deepStrictEqual(completeRange(editedAlpha), baselineRange);

    const restoredAlpha = await patchAndReadAlpha(baselineContent, 3);
    assert.deepStrictEqual(completeRange(restoredAlpha), baselineRange);
  });

  it("serializes concurrent saved-file integrity patches for the same repository", async (t) => {
    const startingState = await getDerivedState(repoId);
    assert.equal(startingState?.graphIntegrityState, "verified");
    const startingRevision = startingState!.graphIntegrityRevision!;
    await clearTestPreparedStatementCaches();
    const statements = new WeakMap<object, string>();
    const matchedBatchRowCounts: number[] = [];
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    t.mock.method(Connection.prototype, "prepare", async function (statement) {
      const prepared = await originalPrepare.call(this, statement);
      statements.set(prepared, statement);
      return prepared;
    });
    t.mock.method(
      Connection.prototype,
      "execute",
      async function (prepared, params, progressCallback) {
        const statement = statements.get(prepared);
        if (
          statement?.includes("UNWIND $rows AS row") &&
          statement.includes("MERGE (s:Symbol {symbolId: row.symbolId})")
        ) {
          const rows = (
            params as { rows?: Array<{ name?: unknown }> } | undefined
          )?.rows;
          if (
            rows?.length === 2 &&
            rows.every((row) => row.name === "alpha" || row.name === "beta")
          ) {
            matchedBatchRowCounts.push(rows.length);
          }
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );
    const request = {
      repoId,
      filePath: "src/example.ts",
      content: [
        "export function alpha() {",
        "  return beta() + missing();",
        "}",
        "",
        "export function beta() {",
        "  return 2;",
        "}",
      ].join("\n"),
      language: "typescript",
      version: 2,
    };

    const revisions: number[] = [];
    let foregroundCaptures = 0;
    const observer = {
      onCommitted(revision: number) {
        revisions.push(revision);
      },
      onForegroundFullGraphCapture() {
        foregroundCaptures += 1;
      },
    };
    const patched = await Promise.all([
      patchSavedFile(request, observer),
      patchSavedFile(request, observer),
    ]);
    assert.equal(patched.length, 2);
    assert.ok(patched.every((result) => result.fileId === durableFileId));
    assert.deepStrictEqual(revisions, [startingRevision + 1, startingRevision + 2]);
    assert.equal(foregroundCaptures, 0);
    assert.deepStrictEqual(matchedBatchRowCounts, [2, 2]);

    const conn = await getLadybugConn();
    const file = await ladybugDb.getFileByRepoPath(conn, repoId, "src/example.ts");
    assert.equal(file?.fileId, durableFileId);
    const duplicateFiles = await ladybugDb.getFilesByIds(conn, [
      `${repoId}:src/example.ts`,
    ]);
    assert.equal(duplicateFiles.has(`${repoId}:src/example.ts`), false);

    const symbols = await ladybugDb.getSymbolsByFile(conn, durableFileId);
    const alpha = symbols.find((symbol) => symbol.name === "alpha");
    assert.equal(alpha?.source, "scip");
    assert.equal(alpha?.packageName, "fixture");
    assert.equal(alpha?.packageVersion, "1.0.0");
    assert.equal(alpha?.scipSymbol, "scip-alpha");
    const membershipCounts = await ladybugDb.querySingle<{
      fileCount: unknown;
      repoCount: unknown;
    }>(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})
       OPTIONAL MATCH (s)-[fileRel:SYMBOL_IN_FILE]->(:File {fileId: $fileId})
       OPTIONAL MATCH (s)-[repoRel:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       RETURN count(DISTINCT fileRel) AS fileCount,
              count(DISTINCT repoRel) AS repoCount`,
      { symbolId: "scip-alpha", fileId: durableFileId, repoId },
    );
    assert.equal(ladybugDb.toNumber(membershipCounts?.fileCount ?? 0), 1);
    assert.equal(ladybugDb.toNumber(membershipCounts?.repoCount ?? 0), 1);

    const state = await getDerivedState(repoId);
    assert.equal(state?.graphIntegrityVersionId, "v1");
    assert.equal(state?.graphIntegrityRevision, startingRevision + 2);
    const filelessStates = await ladybugDb.listGraphIntegrityFilelessStates(
      conn,
      repoId,
    );
    const manifestExpectation = createGraphIntegrityExpectationFromManifest(
      await ladybugDb.listGraphIntegrityFileStates(conn, repoId),
      filelessStates,
    );
    const committedGraph = await capturePersistedGraphIntegrity(conn, repoId);
    assert.equal(
      committedGraph.digest,
      manifestExpectation.digest,
      JSON.stringify(
        compareGraphIntegrityExpectations(manifestExpectation, committedGraph),
      ),
    );
    await waitForVerifiedRevision(repoId, startingRevision + 2);
    const verifiedFileless = await ladybugDb.listGraphIntegrityFilelessStates(
      conn,
      repoId,
    );
    assert.ok(verifiedFileless.length > 1);
    const providerState = verifiedFileless.find(
      (state) => state.symbolId === providerExternalId,
    );
    assert.ok(providerState);
    assert.equal(providerState.canonicalSymbolJson, providerCanonicalJson);
    assert.deepStrictEqual(
      parseGraphIntegrityCanonicalSymbol(providerState.canonicalSymbolJson),
      {
        symbolId: providerExternalId,
        fileId: "",
        name: "external",
        signatureJson: "",
        kind: "function",
        language: "typescript",
        rangeStartLine: 0,
        rangeStartCol: 0,
        rangeEndLine: 0,
        rangeEndCol: 0,
        source: "scip",
        scipSymbol: providerExternalId,
        astFingerprint: providerExternalId,
        symbolStatus: "external",
        external: true,
        placeholderKind: "scip",
        placeholderTarget: providerExternalId,
        roleTagsJson: null,
        testCaseJson: null,
      },
    );
  });

  it("supersedes current verification when accepting a rapid edit", async (t) => {
    const startingState = await getDerivedState(repoId);
    assert.equal(startingState?.graphIntegrityState, "verified");
    const startingRevision = startingState!.graphIntegrityRevision!;
    const startingVerifiedRevision =
      startingState!.graphIntegrityVerifiedRevision!;
    const firstRevision = startingRevision + 1;
    const secondRevision = startingRevision + 2;
    await clearTestPreparedStatementCaches();
    const statements = new WeakMap<object, string>();
    const firstPageStarted = deferred();
    const releaseFirstPage = deferred();
    t.after(() => releaseFirstPage.resolve());
    let pageQueries = 0;
    const publishedRevisions: number[] = [];
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    t.mock.method(Connection.prototype, "prepare", async function (statement) {
      const prepared = await originalPrepare.call(this, statement);
      statements.set(prepared, statement);
      return prepared;
    });
    t.mock.method(
      Connection.prototype,
      "execute",
      async function (prepared, params, progressCallback) {
        const statement = statements.get(prepared);
        if (statement?.includes("OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]")) {
          pageQueries += 1;
          if (pageQueries === 1) {
            firstPageStarted.resolve();
            await releaseFirstPage.promise;
          }
        }
        if (
          statement?.includes("SET d.graphIntegrityState = 'verified'") &&
          statement.includes(
            "d.graphIntegrityVerifiedRevision = d.graphIntegrityRevision",
          )
        ) {
          publishedRevisions.push(
            Number((params as Record<string, unknown> | undefined)?.revision),
          );
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    const committedRevisions: number[] = [];
    const secondCommitted = deferred();
    const observer = {
      onCommitted(revision: number) {
        committedRevisions.push(revision);
        if (revision === secondRevision) secondCommitted.resolve();
      },
      onForegroundFullGraphCapture() {
        assert.fail("rapid saved edits must not capture the full graph");
      },
    };
    const firstPatch = patchSavedFile(
      {
        repoId,
        filePath: "src/example.ts",
        content: [
          "export function alpha() {",
          "  return gamma() + firstPending();",
          "}",
          "",
          "export function gamma() {",
          "  return 3;",
          "}",
        ].join("\n"),
        language: "typescript",
        version: 3,
      },
      observer,
    );
    await firstPageStarted.promise;
    await firstPatch;
    const firstState = await getDerivedState(repoId);
    assert.equal(firstState?.graphIntegrityState, "verifying");
    assert.equal(firstState?.graphIntegrityRevision, firstRevision);
    assert.equal(
      firstState?.graphIntegrityVerifiedRevision,
      startingVerifiedRevision,
    );

    const secondPatch = patchSavedFile(
      {
        repoId,
        filePath: "src/example.ts",
        content: [
          "export function alpha() {",
          "  return gamma() + secondPending();",
          "}",
          "",
          "export function gamma() {",
          "  return 4;",
          "}",
        ].join("\n"),
        language: "typescript",
        version: 4,
      },
      observer,
    );
    const committedBeforeRelease = await Promise.race([
      secondCommitted.promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    releaseFirstPage.resolve();
    await secondPatch;
    assert.equal(committedBeforeRelease, true);
    const secondState = await getDerivedState(repoId);
    assert.deepStrictEqual(committedRevisions, [firstRevision, secondRevision]);
    assert.equal(secondState?.graphIntegrityState, "verifying");
    assert.equal(secondState?.graphIntegrityRevision, secondRevision);
    assert.equal(
      secondState?.graphIntegrityVerifiedRevision,
      startingVerifiedRevision,
    );
    assert.deepStrictEqual(publishedRevisions, []);

    await waitForVerifiedRevision(repoId, secondRevision);
    assert.deepStrictEqual(publishedRevisions, [secondRevision]);
    assert.ok(pageQueries >= 2);
  });

  it("prunes only the current repo when a fileless symbol is file-backed elsewhere", async () => {
    let seededRevision = 0;
    await patchSavedFile(
      {
        repoId,
        filePath: "src/example.ts",
        content: [
          "export function alpha() {",
          "  return gamma() + sharedAcrossRepos();",
          "}",
          "",
          "export function gamma() {",
          "  return 5;",
          "}",
        ].join("\n"),
        language: "typescript",
        version: 5,
      },
      {
        onCommitted(revision) {
          seededRevision = revision;
        },
        onForegroundFullGraphCapture() {
          assert.fail("cross-repo setup must remain background verified");
        },
      },
    );
    assert.ok(seededRevision > 0);
    await waitForVerifiedRevision(repoId, seededRevision);

    const conn = await getLadybugConn();
    const filelessBefore = await ladybugDb.listGraphIntegrityFilelessStates(
      conn,
      repoId,
    );
    const sharedStates = filelessBefore.filter(
      (state) => state.symbolId !== providerExternalId,
    );
    assert.equal(sharedStates.length, 1);
    const sharedState = sharedStates[0]!;
    const sharedCanonical = parseGraphIntegrityCanonicalSymbol(
      sharedState.canonicalSymbolJson,
    );

    const otherRepoId = "saved-file-graph-patch-repo-b";
    const otherFileId = generateFileId(otherRepoId, "src/shared.ts");
    const now = "2026-07-21T12:15:00.000Z";
    await ladybugDb.upsertRepo(conn, {
      repoId: otherRepoId,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId: otherRepoId,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
      }),
      createdAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: otherFileId,
      repoId: otherRepoId,
      relPath: "src/shared.ts",
      contentHash: "shared-content-hash",
      language: "typescript",
      byteSize: 40,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertSymbol(conn, {
      symbolId: sharedState.symbolId,
      repoId: otherRepoId,
      fileId: otherFileId,
      kind: sharedCanonical.kind,
      name: "sharedFromRepoB",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 40,
      astFingerprint: "repo-b-shared-symbol",
      signatureJson: JSON.stringify({ name: "sharedFromRepoB" }),
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      source: "treesitter",
      scipSymbol: null,
      updatedAt: now,
    });

    let committedRevision = 0;
    await patchSavedFile(
      {
        repoId,
        filePath: "src/example.ts",
        content: [
          "export function alpha() {",
          "  return gamma();",
          "}",
          "",
          "export function gamma() {",
          "  return 5;",
          "}",
        ].join("\n"),
        language: "typescript",
        version: 6,
      },
      {
        onCommitted(revision) {
          committedRevision = revision;
        },
        onForegroundFullGraphCapture() {
          assert.fail("cross-repo pruning must remain background verified");
        },
      },
    );
    assert.ok(committedRevision > 0);

    const repoASymbols = await ladybugDb.getPersistedGraphIntegritySymbolPage(
      conn,
      { repoId, limit: 100 },
    );
    assert.equal(
      repoASymbols.some((symbol) => symbol.symbolId === sharedState.symbolId),
      false,
    );
    assert.equal(
      (
        await ladybugDb.listGraphIntegrityFilelessStates(conn, repoId)
      ).some((state) => state.symbolId === sharedState.symbolId),
      false,
    );

    const verified = await waitForVerifiedRevision(repoId, committedRevision);
    assert.equal(verified.graphIntegrityVersionId, "v1");

    const repoBSymbols = await ladybugDb.getPersistedGraphIntegritySymbolPage(
      conn,
      { repoId: otherRepoId, limit: 100 },
    );
    assert.ok(
      repoBSymbols.some(
        (symbol) =>
          symbol.symbolId === sharedState.symbolId &&
          symbol.fileId === otherFileId,
      ),
    );
    assert.ok(
      (await ladybugDb.getSymbolsByFile(conn, otherFileId)).some(
        (symbol) => symbol.symbolId === sharedState.symbolId,
      ),
    );
  });

  it("preserves the durable provider file identity across saved-file patches", async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const writeStartedPromise = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let heldWrite: Promise<void> | undefined;
    let committedRevision = 0;
    const patched = await patchSavedFile({
      repoId,
      filePath: "src/example.ts",
      content: [
        "export function alpha() {",
        "  return gamma();",
        "}",
        "",
        "export function gamma() {",
        "  return 2;",
        "}",
      ].join("\n"),
      language: "typescript",
      version: 2,
    }, {
      onCommitted(revision) {
        committedRevision = revision;
        heldWrite = withWriteConn((conn) =>
          ladybugDb.withTransaction(conn, async () => {
            writeStarted();
            await writeGate;
          }),
        );
      },
      onForegroundFullGraphCapture() {
        assert.fail("saved-file foreground must not capture the full graph");
      },
    });
    await writeStartedPromise;
    assert.equal(patched.fileId, durableFileId);
    assert.equal(patched.parseResult.file.fileId, durableFileId);
    assert.ok(patched.parseResult.symbols.length > 0);
    assert.ok(
      patched.parseResult.symbols.every(
        (symbol) => symbol.fileId === durableFileId,
      ),
    );

    const conn = await getLadybugConn();
    const file = await ladybugDb.getFileByRepoPath(conn, repoId, "src/example.ts");
    assert.ok(file);
    assert.equal(file.fileId, durableFileId);
    const symbols = await ladybugDb.getSymbolsByFile(conn, file.fileId);
    assert.ok(symbols.every((symbol) => symbol.fileId === durableFileId));
    const duplicateFiles = await ladybugDb.getFilesByIds(conn, [
      `${repoId}:src/example.ts`,
    ]);
    assert.equal(duplicateFiles.has(`${repoId}:src/example.ts`), false);
    const names = symbols.map((symbol) => symbol.name).sort();
    assert.deepStrictEqual(names, ["alpha", "gamma"]);
    const alpha = symbols.find((symbol) => symbol.name === "alpha");
    assert.equal(alpha?.symbolId, "scip-alpha");
    assert.equal(alpha?.source, "scip");
    assert.equal(alpha?.packageName, "fixture");
    assert.equal(alpha?.packageVersion, "1.0.0");
    assert.equal(alpha?.scipSymbol, "scip-alpha");

    const committedState = await getDerivedState(repoId);
    assert.equal(committedState?.graphIntegrityState, "verifying");
    assert.equal(committedState.graphIntegrityRevision, committedRevision);
    releaseWrite();
    await heldWrite;
    const state = await waitForVerifiedRevision(
      repoId,
      committedRevision,
    );
    const captured = await capturePersistedGraphIntegrity(conn, repoId);
    assert.equal(state?.graphIntegrityState, "verified");
    assert.equal(state?.graphIntegrityVersionId, "v1");
    assert.equal(state?.graphIntegrityDigest, captured.digest);
    assert.notEqual(captured.digest, baselineDigest);
    const filelessAfterPrune = await ladybugDb.listGraphIntegrityFilelessStates(
      conn,
      repoId,
    );
    assert.equal(filelessAfterPrune.length, 1);
    assert.deepStrictEqual(
      parseGraphIntegrityCanonicalSymbol(
        filelessAfterPrune[0]!.canonicalSymbolJson,
      ),
      parseGraphIntegrityCanonicalSymbol(providerCanonicalJson),
    );

    await handleBufferPush({
      repoId,
      eventType: "save",
      filePath: "src/example.ts",
      content: [
        "export function alpha() {",
        "  return gamma();",
        "}",
        "",
        "export function gamma() {",
        "  return 3;",
        "}",
      ].join("\n"),
      language: "typescript",
      version: 3,
      dirty: false,
      timestamp: "2026-03-07T12:20:00.000Z",
    });
    await waitForDefaultLiveIndexIdle();

    const pendingMatchedState = await getDerivedState(repoId);
    assert.equal(typeof pendingMatchedState?.graphIntegrityRevision, "number");
    const matchedState = await waitForVerifiedRevision(
      repoId,
      pendingMatchedState!.graphIntegrityRevision!,
    );
    const matchedCapture = await capturePersistedGraphIntegrity(conn, repoId);
    assert.equal(matchedState?.graphIntegrityState, "verified");
    assert.equal(matchedState?.graphIntegrityVersionId, "v1");
    assert.equal(matchedState?.graphIntegrityDigest, matchedCapture.digest);
    assert.notEqual(matchedCapture.digest, captured.digest);
  });

  it("reparses when a cached parse result is stale", async () => {
    const beforeState = await getDerivedState(repoId);
    assert.equal(beforeState?.graphIntegrityState, "verified");
    const staleContent = "export function stale() { return 1; }";
    const preflight = await preflightDraftParser({
      repoId,
      filePath: "src/example.ts",
    });
    const staleResult = await parseDraftFile(
      {
        repoId,
        repoRoot: repoDir,
        filePath: "src/example.ts",
        content: staleContent,
        languages: ["ts"],
        language: "typescript",
        version: 7,
      },
      preflight,
    );

    let committedRevision: number | undefined;
    const result = await patchSavedFile(
      {
        repoId,
        filePath: "src/example.ts",
        content: "export function fresh() { return 2; }",
        language: "typescript",
        version: 7,
        parseResult: staleResult,
      },
      {
        onCommitted(revision) {
          committedRevision = revision;
        },
      },
    );
    assert.equal(result.parseResult.symbols.some((symbol) => symbol.name === "stale"), false);
    assert.equal(result.parseResult.symbols.some((symbol) => symbol.name === "fresh"), true);
    assert.ok(committedRevision !== undefined);
    await waitForVerifiedRevision(repoId, committedRevision);
  });

  it("rolls back every foreground mutation phase and refuses the next save", async (t) => {
    const conn = await getLadybugConn();
    const baselineGraph = await capturePersistedGraphIntegrity(conn, repoId);
    const baselineState = await getDerivedState(repoId);
    assert.equal(baselineState?.graphIntegrityState, "verified");
    assert.ok(baselineState);
    const baselineParserState = await ladybugDb.getRepoParserState(conn, repoId);
    await clearTestPreparedStatementCaches();
    const statements = new WeakMap<object, string>();
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    let activePhase = "";
    let injected = false;
    const phaseMatches: Record<string, (statement: string) => boolean> = {
      file: (statement) => statement.includes("MERGE (f:File {fileId: $fileId})"),
      symbol: (statement) =>
        statement.includes("MERGE (s:Symbol {symbolId: row.symbolId})"),
      edge: (statement) => statement.includes("CREATE (a)-[:DEPENDS_ON"),
      provenance: (statement) => statement.includes("MERGE (s:FileParserState"),
      manifest: (statement) => statement.includes("MERGE (f:GraphIntegrityFileState"),
      verification: (statement) =>
        statement.includes("d.graphIntegrityRevision = $nextRevision"),
    };
    t.mock.method(Connection.prototype, "prepare", async function (statement) {
      const prepared = await originalPrepare.call(this, statement);
      statements.set(prepared, statement);
      return prepared;
    });
    t.mock.method(
      Connection.prototype,
      "execute",
      async function (prepared, params, progressCallback) {
        const statement = statements.get(prepared) ?? "";
        if (!injected && phaseMatches[activePhase]?.(statement)) {
          injected = true;
          throw new Error(`injected ${activePhase} phase failure`);
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    for (const [index, phase] of Object.keys(phaseMatches).entries()) {
      activePhase = phase;
      injected = false;
      try {
        await assert.rejects(
          patchSavedFile({
            repoId,
            filePath: "src/example.ts",
            content: [
              "export function alpha() {",
              "  return gamma();",
              "}",
              "",
              "export function gamma() {",
              "  return 3;",
              "}",
            ].join("\n"),
            language: "typescript",
            version: 20 + index,
          }),
          new RegExp(`injected ${phase} phase failure`),
        );
        assert.equal(injected, true, `${phase} injection did not execute`);
        assert.deepStrictEqual(
          await capturePersistedGraphIntegrity(conn, repoId),
          baselineGraph,
        );
        const failed = await getDerivedState(repoId);
        assert.equal(failed?.graphIntegrityState, "failed");
        assert.equal(failed?.graphIntegrityRevision, baselineState.graphIntegrityRevision);
        assert.equal(
          failed?.graphIntegrityVerifiedRevision,
          baselineState.graphIntegrityVerifiedRevision,
        );
        assert.deepStrictEqual(
          await ladybugDb.getRepoParserState(conn, repoId),
          baselineParserState,
        );
        await assert.rejects(
          patchSavedFile({
            repoId,
            filePath: "src/example.ts",
            content: "export function refused() { return 0; }",
            language: "typescript",
            version: 40 + index,
          }),
          (error: unknown) => {
            assert.equal(
              (error as { code?: unknown }).code,
              "PARSER_PROVENANCE_INCOMPLETE",
            );
            return true;
          },
        );
      } finally {
        await restoreGraphIntegrityState(repoId, baselineState);
      }
    }
  });

  it("rolls back graph, manifest, fileless, and revision mutations atomically", async (t) => {
    const conn = await getLadybugConn();
    const beforeGraph = await capturePersistedGraphIntegrity(conn, repoId);
    const beforeFiles = await ladybugDb.listGraphIntegrityFileStates(conn, repoId);
    const beforeFileless = await ladybugDb.listGraphIntegrityFilelessStates(
      conn,
      repoId,
    );
    const beforeState = await getDerivedState(repoId);
    assert.equal(beforeState?.graphIntegrityState, "verified");
    assert.ok(beforeState);
    const beforeParserState = await ladybugDb.getRepoParserState(conn, repoId);
    assert.equal(beforeParserState?.graphRevision, beforeState.graphIntegrityRevision);
    const beforeFile = await ladybugDb.getFileByRepoPath(
      conn,
      repoId,
      "src/example.ts",
    );
    const beforeSymbols = await ladybugDb.getSymbolsByFile(conn, durableFileId);
    t.after(() => restoreGraphIntegrityState(repoId, beforeState));

    await clearTestPreparedStatementCaches();
    const statements = new WeakMap<object, string>();
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    let manifestMutationStarted = false;
    let revisionFailureInjected = false;
    let pendingRevisionReads = 0;
    t.mock.method(Connection.prototype, "prepare", async function (statement) {
      const prepared = await originalPrepare.call(this, statement);
      statements.set(prepared, statement);
      return prepared;
    });
    t.mock.method(
      Connection.prototype,
      "execute",
      async function (prepared, params, progressCallback) {
        const statement = statements.get(prepared);
        if (statement?.includes("MERGE (f:GraphIntegrityFileState")) {
          manifestMutationStarted = true;
        }
        if (
          statement?.includes("WHERE d.graphIntegrityState = 'verifying'") &&
          statement.includes("ORDER BY d.repoId")
        ) {
          pendingRevisionReads += 1;
        }
        if (
          !revisionFailureInjected &&
          statement?.includes("d.graphIntegrityRevision = $nextRevision")
        ) {
          revisionFailureInjected = true;
          assert.equal(manifestMutationStarted, true);
          throw new Error("injected saved-file revision CAS failure");
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    let committed = false;
    await assert.rejects(
      patchSavedFile(
        {
          repoId,
          filePath: "src/example.ts",
          content: "export function rolledBack() { return neverCommitted(); }",
          language: "typescript",
          version: 7,
        },
        {
          onCommitted() {
            committed = true;
          },
          onForegroundFullGraphCapture() {
            assert.fail("failed saved edits must not capture the full graph");
          },
        },
      ),
      /injected saved-file revision CAS failure/,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(manifestMutationStarted, true);
    assert.equal(revisionFailureInjected, true);
    assert.equal(committed, false);
    assert.equal(pendingRevisionReads, 0, "rollback must not notify the verifier");
    assert.deepStrictEqual(
      await capturePersistedGraphIntegrity(conn, repoId),
      beforeGraph,
    );
    assert.deepStrictEqual(
      await ladybugDb.listGraphIntegrityFileStates(conn, repoId),
      beforeFiles,
    );
    assert.deepStrictEqual(
      await ladybugDb.listGraphIntegrityFilelessStates(conn, repoId),
      beforeFileless,
    );
    const failedState = await getDerivedState(repoId);
    assert.equal(failedState?.graphIntegrityState, "failed");
    assert.equal(failedState?.graphIntegrityRevision, beforeState.graphIntegrityRevision);
    assert.equal(
      failedState?.graphIntegrityVerifiedRevision,
      beforeState.graphIntegrityVerifiedRevision,
    );
    assert.deepStrictEqual(
      await ladybugDb.getRepoParserState(conn, repoId),
      beforeParserState,
    );
    await assert.rejects(
      patchSavedFile({
        repoId,
        filePath: "src/example.ts",
        content: "export function refused() { return 0; }",
        language: "typescript",
        version: 8,
      }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: unknown }).code,
          "PARSER_PROVENANCE_INCOMPLETE",
        );
        return true;
      },
    );
    assert.deepStrictEqual(
      await ladybugDb.getFileByRepoPath(conn, repoId, "src/example.ts"),
      beforeFile,
    );
    assert.deepStrictEqual(
      await ladybugDb.getSymbolsByFile(conn, durableFileId),
      beforeSymbols,
    );
  });

  it("fails closed after a lost failure CAS advances to a newer revision", async (t) => {
    const conn = await getLadybugConn();
    const beforeState = await getDerivedState(repoId);
    assert.equal(beforeState?.graphIntegrityState, "verified");
    const beforeManifest = await ladybugDb.getGraphIntegrityFileState(
      conn,
      repoId,
      durableFileId,
    );
    assert.ok(beforeManifest);
    const symbols = await ladybugDb.getSymbolsByFile(conn, durableFileId);
    assert.ok(symbols.length > 0);
    const originalSymbol = symbols[0]!;
    t.after(async () => {
      await withWriteConn((writeConn) =>
        ladybugDb.upsertSymbol(writeConn, originalSymbol),
      );
      await restoreGraphIntegrityState(repoId, beforeState!);
    });
    await ladybugDb.upsertSymbol(conn, {
      ...originalSymbol,
      name: "corrupt-before-edit",
    });

    await clearTestPreparedStatementCaches();
    const statements = new WeakMap<object, string>();
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    let failureCasAttempts = 0;
    t.mock.method(Connection.prototype, "prepare", async function (statement) {
      const prepared = await originalPrepare.call(this, statement);
      statements.set(prepared, statement);
      return prepared;
    });
    t.mock.method(
      Connection.prototype,
      "execute",
      async function (prepared, params, progressCallback) {
        const statement = statements.get(prepared);
        if (
          statement?.includes("SET d.graphIntegrityState = 'failed'") &&
          statement.includes("WHERE d.graphIntegrityVersionId = $versionId")
        ) {
          failureCasAttempts += 1;
          if (failureCasAttempts === 1) {
            const values = params as Record<string, unknown>;
            const staleRevision = Number(values.revision);
            const bumpStatement = `MATCH (d:DerivedState {repoId: $repoId})
              WHERE d.graphIntegrityVersionId = $versionId
                AND d.graphIntegrityRevision = $expectedRevision
              SET d.graphIntegrityState = 'verifying',
                  d.graphIntegrityRevision = $nextRevision,
                  d.graphIntegrityError = NULL,
                  d.updatedAt = $updatedAt
              RETURN d.graphIntegrityRevision AS revision`;
            const bumpPrepared = await originalPrepare.call(this, bumpStatement);
            const bumpResult = await originalExecute.call(this, bumpPrepared, {
              repoId,
              versionId: values.versionId,
              expectedRevision: staleRevision,
              nextRevision: staleRevision + 1,
              updatedAt: "2026-07-21T12:30:00.000Z",
            });
            try {
              const bumpRows = (await bumpResult.getAll()) as Array<{
                revision: unknown;
              }>;
              assert.equal(Number(bumpRows[0]?.revision), staleRevision + 1);
            } finally {
              bumpResult.close();
            }
            notifyGraphIntegrityVerifier(repoId);
          }
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    const prePatchState = await getDerivedState(repoId);
    const prePatchParserState = await ladybugDb.getRepoParserState(conn, repoId);
    assert.equal(
      parserCoverageMatchesVerifiedGraph(prePatchState, "v1", prePatchParserState),
      true,
    );
    let committed = false;
    await assert.rejects(
      patchSavedFile(
        {
          repoId,
          filePath: "src/example.ts",
          content: "export function repaired() { return 1; }",
          language: "typescript",
          version: 8,
        },
        {
          onCommitted() {
            committed = true;
          },
          onForegroundFullGraphCapture() {
            assert.fail("mismatch handling must not capture the full graph");
          },
        },
      ),
      (error: unknown) => {
        assert.equal(
          (error as { code?: unknown }).code,
          "PARSER_PROVENANCE_INCOMPLETE",
        );
        return true;
      },
    );
    assert.equal(committed, false);
    assert.equal(failureCasAttempts, 1);

    const afterState = await getDerivedState(repoId);
    assert.equal(afterState?.graphIntegrityState, "failed");
    assert.equal(
      afterState?.graphIntegrityRevision,
      beforeState!.graphIntegrityRevision! + 1,
    );
    assert.equal(
      afterState?.graphIntegrityVerifiedRevision,
      beforeState?.graphIntegrityVerifiedRevision,
    );
    assert.deepStrictEqual(
      await ladybugDb.getGraphIntegrityFileState(
        conn,
        repoId,
        durableFileId,
      ),
      beforeManifest,
    );
    const afterSymbols = await ladybugDb.getSymbolsByFile(conn, durableFileId);
    assert.ok(afterSymbols.some((symbol) => symbol.name === "corrupt-before-edit"));
    assert.equal(afterSymbols.some((symbol) => symbol.name === "repaired"), false);
  });

  it("selects and persists a declared plugin contract for a new file", async () => {
    const pluginPath = join(testDir, "live-parser-plugin.mjs");
    writeFileSync(
      pluginPath,
      [
        "export const manifest = {",
        "  name: 'live-parser-plugin',",
        "  version: '1.0.0',",
        "  apiVersion: '" + getHostApiVersion() + "',",
        "  adapters: [{ extension: '.pluglive', languageId: 'plugin-live', adapterIdentity: 'live-parser-adapter', adapterContractVersion: 'plugin-live:1' }],",
        "};",
        "export async function createAdapters() {",
        "  return [{",
        "    extension: '.pluglive',",
        "    languageId: 'plugin-live',",
        "    adapterIdentity: 'live-parser-adapter',",
        "    adapterContractVersion: 'plugin-live:1',",
        "    factory: () => ({",
        "      languageId: 'plugin-live',",
        "      fileExtensions: ['.pluglive'],",
        "      getParser: () => null,",
        "      parse: (content, filePath) => ({ content, filePath }),",
        "      extractSymbols: () => [],",
        "      extractImports: () => [],",
        "      extractCalls: () => [],",
        "    }),",
        "  }];",
        "}",
      ].join("\n"),
      "utf8",
    );
    await loadPluginsSync([pluginPath], testDir);

    let committedRevision: number | undefined;
    const result = await patchSavedFile(
      {
        repoId,
        filePath: "src/new.pluglive",
        content: "fn plugged() {}\n",
        language: "plugin-live",
        version: 77,
      },
      {
        onCommitted(revision) {
          committedRevision = revision;
        },
      },
    );
    assert.ok(committedRevision !== undefined);
    await waitForVerifiedRevision(repoId, committedRevision);

    const conn = await getLadybugConn();
    const file = await ladybugDb.getFileByRepoPath(
      conn,
      repoId,
      "src/new.pluglive",
    );
    assert.ok(file);
    const state = await ladybugDb.getFileParserState(conn, repoId, file.fileId);
    assert.ok(state);
    assert.equal(state.engine, "typescript");
    assert.equal(state.engineContract, "plugin-live:1");
    assert.equal(state.language, "plugin-live");
    assert.equal(state.adapterKey, result.parseResult.parserContract.adapterKey);
    assert.match(state.adapterKey, /live-parser-plugin/);
  });

  it("commits prepared parser rows through an already-admitted writer", { timeout: 15_000 }, async () => {
    const beforeState = await getDerivedState(repoId);
    const prepared = await filePatcher.prepareSavedFilePatch({
      repoId, filePath: "src/example.ts", content: "export function owned() { return 1; }", version: 80,
    });
    const result = await withRepoWriteHeavyLock(repoId, () =>
      withWriteConn((conn) => prepared.commit(conn)),
    );
    assert.notEqual(result, filePatcher.RETRY_SAVED_FILE_PATCH);
    const state = await waitForVerifiedRevision(repoId, beforeState!.graphIntegrityRevision + 1);
    assert.equal(state.graphIntegrityState, "verified");
  });

  it("leaves the shared fixture verified after destructive failure coverage", async () => {
    const conn = await getLadybugConn();
    const state = await getDerivedState(repoId);
    assert.equal(state?.graphIntegrityState, "verified");
    assert.equal(
      state?.graphIntegrityRevision,
      state?.graphIntegrityVerifiedRevision,
    );

    const manifestExpectation = createGraphIntegrityExpectationFromManifest(
      await ladybugDb.listGraphIntegrityFileStates(conn, repoId),
      await ladybugDb.listGraphIntegrityFilelessStates(conn, repoId),
    );
    const graph = await capturePersistedGraphIntegrity(conn, repoId);
    assert.equal(graph.digest, manifestExpectation.digest);
    assert.equal(state?.graphIntegrityDigest, graph.digest);
  });
});
