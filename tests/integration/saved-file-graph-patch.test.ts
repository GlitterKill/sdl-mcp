import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  capturePersistedGraphIntegrity,
  compareGraphIntegrityExpectations,
  createGraphIntegrityFilelessDelta,
  createGraphIntegrityFilelessEdgeReferences,
  createGraphIntegrityFilelessReferenceTuples,
  createGraphIntegrityFilelessSymbols,
  createGraphIntegrityExpectationFromManifest,
  createGraphIntegrityFileState,
  GraphIntegrityVerificationError,
  parseGraphIntegrityCanonicalSymbol,
} from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import { patchSavedFile } from "../../dist/live-index/file-patcher.js";
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
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await getDerivedState(repoId);
    if (
      state?.graphIntegrityState === "verified" &&
      state.graphIntegrityVerifiedRevision === revision
    ) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for graph integrity revision ${revision}`);
}

describe("saved file graph patch", () => {
  const repoId = "saved-file-graph-patch-repo";
  const durableFileId = generateFileId(repoId, "src/example.ts");
  const providerExternalId = "scip-typescript npm fixture 1.0.0 dep#external().";
  const dbPath = join(tmpdir(), ".lbug-saved-file-graph-patch-test-db.lbug");
  const configPath = join(tmpdir(), `sdl-saved-file-patch-${Date.now()}.json`);
  let repoDir = "";
  let baselineDigest = "";
  let providerCanonicalJson = "";
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
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
        scipSymbol: "scip-alpha",
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
    await markGraphIntegrityVerified(repoId, "v1", baselineDigest);
  });

  beforeEach(async () => {
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    resetDefaultLiveIndexCoordinator();
  });

  after(async () => {
    resetDefaultLiveIndexCoordinator();
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    await closeLadybugDb();
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    if (existsSync(configPath)) rmSync(configPath, { force: true });
    if (repoDir && existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = prevConfig;
    if (prevConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = prevConfigPath;
  });

  it("serializes concurrent saved-file integrity patches for the same repository", async () => {
    const startingState = await getDerivedState(repoId);
    assert.equal(startingState?.graphIntegrityState, "verified");
    const startingRevision = startingState!.graphIntegrityRevision!;
    const request = {
      repoId,
      filePath: "src/example.ts",
      content: [
        "export function alpha() {",
        "  return gamma() + missing();",
        "}",
        "",
        "export function gamma() {",
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
    assert.equal(alpha?.scipSymbol, "scip-alpha");

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
      },
    );
  });

  it("returns rapid edits independently while only the newest revision publishes", async (t) => {
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
    const observer = {
      onCommitted(revision: number) {
        committedRevisions.push(revision);
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

    await patchSavedFile(
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
    const secondState = await getDerivedState(repoId);
    assert.deepStrictEqual(committedRevisions, [firstRevision, secondRevision]);
    assert.equal(secondState?.graphIntegrityState, "verifying");
    assert.equal(secondState?.graphIntegrityRevision, secondRevision);
    assert.equal(
      secondState?.graphIntegrityVerifiedRevision,
      startingVerifiedRevision,
    );
    assert.deepStrictEqual(publishedRevisions, []);

    releaseFirstPage.resolve();
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

  it("rolls back graph, manifest, fileless, and revision mutations atomically", async (t) => {
    const conn = await getLadybugConn();
    const beforeGraph = await capturePersistedGraphIntegrity(conn, repoId);
    const beforeFiles = await ladybugDb.listGraphIntegrityFileStates(conn, repoId);
    const beforeFileless = await ladybugDb.listGraphIntegrityFilelessStates(
      conn,
      repoId,
    );
    const beforeState = await getDerivedState(repoId);
    const beforeFile = await ladybugDb.getFileByRepoPath(
      conn,
      repoId,
      "src/example.ts",
    );
    const beforeSymbols = await ladybugDb.getSymbolsByFile(conn, durableFileId);

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
    assert.deepStrictEqual(await getDerivedState(repoId), beforeState);
    assert.deepStrictEqual(
      await ladybugDb.getFileByRepoPath(conn, repoId, "src/example.ts"),
      beforeFile,
    );
    assert.deepStrictEqual(
      await ladybugDb.getSymbolsByFile(conn, durableFileId),
      beforeSymbols,
    );
  });

  it("reloads after a lost direct-failure CAS and fails only the newer revision", async (t) => {
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
        ladybugDb.withTransaction(writeConn, async () => {
          // Restore only the rows deliberately mutated by this destructive test.
          await ladybugDb.upsertSymbol(writeConn, originalSymbol);
          await exec(
            writeConn,
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
              versionId: beforeState!.graphIntegrityVersionId,
              digest: beforeState!.graphIntegrityDigest,
              revision: beforeState!.graphIntegrityRevision,
              verifiedRevision: beforeState!.graphIntegrityVerifiedRevision,
              filelessPruningSupported:
                beforeState!.graphIntegrityFilelessPruningSupported,
              updatedAt: beforeState!.updatedAt,
            },
          );
        }),
      );
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
    let stateBeforeLatestFailure: Awaited<ReturnType<typeof getDerivedState>> = null;
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
          } else if (failureCasAttempts === 2) {
            stateBeforeLatestFailure = await getDerivedState(repoId);
          }
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
      GraphIntegrityVerificationError,
    );
    assert.equal(committed, false);
    assert.equal(failureCasAttempts, 2);
    assert.equal(stateBeforeLatestFailure?.graphIntegrityState, "verifying");
    assert.equal(
      stateBeforeLatestFailure?.graphIntegrityRevision,
      beforeState!.graphIntegrityRevision! + 1,
    );

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
