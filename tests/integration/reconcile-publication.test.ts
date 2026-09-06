import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../../dist/db/ladybug-queries.js";
import {
  initLadybugDb,
  closeLadybugDb,
  getLadybugConn,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import {
  markGraphIntegrityVerified,
  getDerivedState,
} from "../../dist/db/ladybug-derived-state.js";
import {
  createGraphIntegrityExpectationFromManifest,
  capturePersistedGraphIntegrity,
} from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import { cancelAndWaitForGraphIntegrityVerifier } from "../../dist/indexer/provider-first/background-graph-integrity-verifier.js";
import { providerFactsToGraphRows } from "../../dist/indexer/provider-first/materializer.js";
import { ReconcileQueue } from "../../dist/live-index/reconcile-queue.js";
import { captureActiveRepoEpoch } from "../../dist/services/repo-lifecycle.js";
import { generateFileId, hashContent } from "../../dist/util/hashing.js";
import {
  getLatestSemanticProviderRuns,
  readReconcileFileAuthorities,
  writeReconcileFileAuthoritiesInTransaction,
} from "../../dist/db/ladybug-semantic.js";
import { getSymbolReferencesByFileIds } from "../../dist/db/ladybug-embeddings.js";
import { dropFtsIndex } from "../../dist/retrieval/index-lifecycle.js";
import type { ProviderFactSet } from "../../dist/indexer/provider-first/types.js";
import { queryAll, execStoredProc } from "../../dist/db/ladybug-core.js";
import { getGraphIntegrityFilelessStates } from "../../dist/db/ladybug-graph-integrity.js";
import { prepareReconcileFiles } from "../../dist/indexer/provider-first/reconcile-preparation.js";
import { AppConfigSchema, RepoConfigSchema } from "../../dist/config/types.js";
import { buildDependencyFrontier } from "../../dist/live-index/dependency-frontier.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const frontier = {
  touchedSymbolIds: [],
  dependentSymbolIds: [],
  dependentFilePaths: [],
  importedFilePaths: [],
  invalidations: [],
};

describe("guarded reconciliation publication", { timeout: 30_000 }, () => {
  let root: string;
  let repoRoot: string;
  const repoId = "publication";
  const priorConfig = process.env.SDL_CONFIG;
  let publisher: typeof import("../../dist/live-index/reconcile-publisher.js");
  before(async () => {
    // Keep the RED failure at the missing publication boundary, before DB setup.
    publisher = await import("../../dist/live-index/reconcile-publisher.js");
    root = await mkdtemp(join(tmpdir(), "sdl-reconcile-publication-"));
    repoRoot = join(root, "repo");
    await mkdir(repoRoot);
    const config = join(root, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        repos: [],
        indexing: { engine: "typescript", enableFileWatching: false },
      }),
    );
    process.env.SDL_CONFIG = config;
    await initLadybugDb(join(root, "graph.lbug"));
    const conn = await getLadybugConn();
    await db.upsertRepo(conn, {
      repoId,
      rootPath: repoRoot,
      configJson: JSON.stringify(
        RepoConfigSchema.parse({
          repoId,
          rootPath: repoRoot,
          languages: ["ts"],
        }),
      ),
      createdAt: "2026-01-01",
    });
    await db.createVersion(conn, {
      repoId,
      versionId: "v1",
      createdAt: "2026-01-01",
      reason: "test",
      prevVersionHash: null,
      versionHash: null,
    });
    await db.replaceGraphIntegrityManifestInTransaction(conn, repoId, {
      files: [],
      fileless: [],
    });
    const coverage = await db.summarizeParserCoverageInTransaction(
      conn,
      repoId,
    );
    await db.upsertRepoParserStateInTransaction(conn, {
      repoId,
      graphVersionId: "v1",
      graphRevision: 0,
      ...coverage,
    });
    await markGraphIntegrityVerified(
      repoId,
      "v1",
      (await capturePersistedGraphIntegrity(conn, repoId)).digest,
    );
  });
  after(async () => {
    if (!root) return;
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    await closeLadybugDb();
    if (priorConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = priorConfig;
    assert.ok(root.startsWith(join(tmpdir(), "sdl-reconcile-publication-")));
    await rm(root, { recursive: true, force: true });
  });

  function preparation(content: string, generation: string) {
    const base = {
      repoId,
      generationId: generation,
      providerType: "scip" as const,
      providerId: "fixture",
      emittedAt: generation,
    };
    const fileId = generateFileId(repoId, "a.ts");
    const facts: ProviderFactSet = {
      files: [
        {
          ...base,
          kind: "file" as const,
          fileId,
          relPath: "a.ts",
          languageId: "typescript",
          contentHash: hashContent(content),
          byteSize: Buffer.byteLength(content),
        },
      ],
      symbols: [],
      edges: [],
      externalSymbols: [],
      occurrences: [],
      diagnostics: [],
      coverage: [],
      providerRuns: [
        {
          ...base,
          kind: "providerRun" as const,
          runId: generation,
          status: "succeeded" as const,
          startedAt: generation,
          fileCount: 1,
          symbolCount: 0,
          edgeCount: 0,
          diagnosticCount: 0,
        },
      ],
    };
    return {
      kind: "provider" as const,
      files: [
        {
          path: "a.ts",
          content,
          contentHash: hashContent(content),
          size: Buffer.byteLength(content),
        },
      ],
      dependencyInputs: [],
      configurationHash: "config",
      uncoveredPaths: [],
      result: { facts, rows: providerFactsToGraphRows({ facts }) },
    };
  }
  async function prepare(
    queue: ReconcileQueue,
    content: string,
    generation: string,
  ) {
    await writeFile(join(repoRoot, "a.ts"), content);
    queue.enqueue(repoId, frontier, generation, {
      "a.ts": { kind: "saved", content, sourceHash: hashContent(content) },
    });
    const claim = queue.claimNext()!;
    const prepared = await publisher.prepareReconcilePublication({
      repoId,
      repoRoot,
      epoch: captureActiveRepoEpoch(repoId)!,
      baseline: await publisher.captureReconcileGraphBaseline(repoId),
      queue,
      claim,
      preparation: preparation(content, generation),
      assertCurrent: () => true,
    });
    return { claim, prepared };
  }

  async function prepareRows(
    input: ReturnType<typeof preparation>,
    removedPaths: string[] = [],
  ) {
    const queue = new ReconcileQueue();
    for (const file of input.files) {
      await writeFile(join(repoRoot, file.path), file.content);
      queue.enqueue(repoId, frontier, "saved", {
        [file.path]: {
          kind: "saved",
          content: file.content,
          sourceHash: file.contentHash,
        },
      });
    }
    for (const path of removedPaths)
      queue.enqueue(repoId, frontier, "removed", {
        [path]: { kind: "removed" },
      });
    const claim = queue.claimNext()!;
    return publisher.prepareReconcilePublication({
      repoId,
      repoRoot,
      epoch: captureActiveRepoEpoch(repoId)!,
      baseline: await publisher.captureReconcileGraphBaseline(repoId),
      queue,
      claim,
      preparation: input.files.length ? input : undefined,
      removedPaths,
      assertCurrent: () => true,
    });
  }

  function symbols(
    generation: string,
    entries: Array<{ path: string; id: string; name: string; target?: string }>,
  ) {
    const result = preparation("", generation);
    result.files = entries.map((entry) => ({
      path: entry.path,
      content: entry.name,
      contentHash: hashContent(entry.name),
      size: Buffer.byteLength(entry.name),
    }));
    const base = {
      repoId,
      generationId: generation,
      providerType: "scip" as const,
      providerId: "fixture",
      emittedAt: generation,
    };
    result.result.facts.files = result.files.map((file) => ({
      ...base,
      kind: "file",
      fileId: generateFileId(repoId, file.path),
      relPath: file.path,
      languageId: "typescript",
      contentHash: file.contentHash,
      byteSize: file.size,
    }));
    result.result.facts.symbols = entries.map((entry) => ({
      ...base,
      kind: "symbol",
      symbolId: entry.id,
      providerSymbolId: entry.id,
      name: entry.name,
      symbolKind: "function",
      relPath: entry.path,
      range: { startLine: 1, startCol: 0, endLine: 1, endCol: 10 },
      documentation: [],
      external: false,
    }));
    result.result.rows = providerFactsToGraphRows({
      facts: result.result.facts,
    });
    result.result.rows.edges = entries
      .filter((entry) => entry.target)
      .map((entry) => ({
        repoId,
        fromSymbolId: entry.id,
        toSymbolId: entry.target!,
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "scip",
        resolverId: "scip",
        resolutionPhase: "pass1",
        provenance: JSON.stringify({
          providerId: "fixture",
          sourceIndexPath: `${repoRoot}/.sdl-mcp/provider-first-incremental/${generation}.scip`,
          relPath: entry.path,
        }),
        createdAt: generation,
      }));
    return result;
  }

  it("admits save 13 while prepared save 12 waits for writer; 12 mutates nothing", async () => {
    const queue = new ReconcileQueue();
    const old = await prepare(queue, "save12", "12");
    const entered = deferred();
    const release = deferred();
    const writer = withWriteConn(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const publication = publisher.publishReconcile(old.prepared);
    try {
      await queue.withPublicationFence(repoId, async () => {
        await writeFile(join(repoRoot, "a.ts"), "save13");
        queue.enqueue(repoId, frontier, "13", {
          "a.ts": {
            kind: "saved",
            content: "save13",
            sourceHash: hashContent("save13"),
          },
        });
      });
    } finally {
      release.resolve();
    }
    await writer;
    assert.equal((await publication).kind, "stale");
    assert.equal(
      await db.getFileByRepoPath(await getLadybugConn(), repoId, "a.ts"),
      null,
    );
    assert.equal((await getDerivedState(repoId))!.graphIntegrityRevision, 0);
    const conn = await getLadybugConn();
    assert.deepEqual(
      await getSymbolReferencesByFileIds(conn, repoId, [
        generateFileId(repoId, "a.ts"),
      ]),
      [],
    );
    assert.deepEqual(await getLatestSemanticProviderRuns(conn, repoId), []);
    assert.equal(
      (
        await readReconcileFileAuthorities(conn, repoId, [
          generateFileId(repoId, "a.ts"),
        ])
      ).size,
      0,
    );
  });

  it("publishes zero-symbol references and treats a fresh provider run as exact no-op", async () => {
    const first = await prepareRows(preparation("token", "15"));
    assert.equal((await publisher.publishReconcile(first)).kind, "published");
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    const before = await getDerivedState(repoId);
    const conn = await getLadybugConn();
    const runs = await getLatestSemanticProviderRuns(conn, repoId);
    assert.equal(
      runs.length,
      1,
      "internal authority snapshots must not leak as provider runs",
    );
    const again = await prepareRows(preparation("token", "16"));
    assert.equal(again.noOp, true);
    assert.equal((await publisher.publishReconcile(again)).kind, "noop");
    assert.deepEqual(
      await getDerivedState(repoId),
      before,
      "no-op preserves independent dirtiness and revision",
    );
    assert.equal((await getLatestSemanticProviderRuns(conn, repoId)).length, 1);
    const empty = await prepareRows(preparation("", "17"));
    assert.equal((await publisher.publishReconcile(empty)).kind, "published");
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    assert.deepEqual(
      await getSymbolReferencesByFileIds(conn, repoId, [
        generateFileId(repoId, "a.ts"),
      ]),
      [],
      "zero retired symbols still clears file references",
    );
  });

  it("rejects uncovered files, stale graph revisions and stale lifecycle epochs", async () => {
    const old = await prepareRows(preparation("", "18"));
    const changed = await prepareRows(preparation("changedSourceOnly", "19"));
    assert.equal((await publisher.publishReconcile(changed)).kind, "published");
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    assert.equal((await publisher.publishReconcile(old)).kind, "stale");
    const epoch = await prepareRows(preparation("changedSourceOnly", "20"));
    epoch.request.epoch = -1;
    assert.equal((await publisher.publishReconcile(epoch)).kind, "stale");
    const uncovered = preparation("uncovered", "21");
    uncovered.uncoveredPaths.push("a.ts");
    await assert.rejects(prepareRows(uncovered), /coverage is incomplete/);
  });

  it("removes manifest/references/authority and permits delete then recreate", async () => {
    await rm(join(repoRoot, "a.ts"));
    const removed = preparation("", "22");
    removed.files = [];
    const result = await publisher.publishReconcile(
      await prepareRows(removed, ["a.ts"]),
    );
    assert.equal(result.kind, "published");
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    const conn = await getLadybugConn();
    const id = generateFileId(repoId, "a.ts");
    assert.equal(await db.getFileByRepoPath(conn, repoId, "a.ts"), null);
    assert.equal(await db.getGraphIntegrityFileState(conn, repoId, id), null);
    assert.deepEqual(
      await getSymbolReferencesByFileIds(conn, repoId, [id]),
      [],
    );
    assert.equal(
      (await readReconcileFileAuthorities(conn, repoId, [id])).size,
      0,
    );
    const recreated = await prepareRows(preparation("recreated", "23"));
    assert.equal(
      (await publisher.publishReconcile(recreated)).kind,
      "published",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    assert.equal(
      (await db.getFileByRepoPath(conn, repoId, "a.ts"))!.contentHash,
      hashContent("recreated"),
    );
  });

  it("rolls back references, rows, manifest, provenance and revision together", async () => {
    const queue = new ReconcileQueue();
    const current = await prepare(queue, "rollbackToken", "14");
    const conn = await getLadybugConn();
    const before = await capturePersistedGraphIntegrity(conn, repoId);
    const fileBefore = await db.getFileByRepoPath(conn, repoId, "a.ts");
    const stateBefore = await getDerivedState(repoId);
    const refsBefore = await getSymbolReferencesByFileIds(conn, repoId, [
      generateFileId(repoId, "a.ts"),
    ]);
    const runsBefore = await queryAll(
      conn,
      "MATCH (r:SemanticProviderRun {repoId: $repoId}) RETURN r.runId AS id, r.metadataJson AS metadata ORDER BY id",
      { repoId },
    );
    await assert.rejects(
      publisher.publishReconcile(current.prepared, {
        afterRows: () => {
          throw new Error("injected publication failure");
        },
      }),
      /injected publication failure/,
    );
    assert.deepEqual(
      await capturePersistedGraphIntegrity(conn, repoId),
      before,
    );
    assert.deepEqual(
      await db.getFileByRepoPath(conn, repoId, "a.ts"),
      fileBefore,
    );
    assert.deepEqual(await getDerivedState(repoId), stateBefore);
    assert.deepEqual(
      await getSymbolReferencesByFileIds(conn, repoId, [
        generateFileId(repoId, "a.ts"),
      ]),
      refsBefore,
    );
    assert.deepEqual(
      await queryAll(
        conn,
        "MATCH (r:SemanticProviderRun {repoId: $repoId}) RETURN r.runId AS id, r.metadataJson AS metadata ORDER BY id",
        { repoId },
      ),
      runsBefore,
    );
  });

  it("preserves outside callers and updates real FTS after bounded Symbol replacement", async (t) => {
    const initial = symbols("30", [
      { path: "a.ts", id: "symbol-a", name: "oldneedle" },
      { path: "b.ts", id: "symbol-b", name: "caller", target: "symbol-a" },
    ]);
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(initial))).kind,
      "published",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    const conn = await getLadybugConn();
    const ftsEnabled = !(
      process.platform === "win32" &&
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON === "1"
    );
    if (ftsEnabled)
      await execStoredProc(
        conn,
        "CALL CREATE_FTS_INDEX('Symbol', 'reconcile_test_fts', ['searchText'])",
      );
    try {
      const updated = await prepareRows(
        symbols("31", [{ path: "a.ts", id: "symbol-a", name: "newneedle" }]),
      );
      assert.equal(
        (await publisher.publishReconcile(updated)).kind,
        "published",
      );
      await cancelAndWaitForGraphIntegrityVerifier(repoId);
      const incoming = await db.getEdgesToSymbolsInRepo(conn, repoId, [
        "symbol-a",
      ]);
      assert.equal(incoming.get("symbol-a")!.length, 1);
      assert.equal(incoming.get("symbol-a")![0].fromSymbolId, "symbol-b");
      await t.test(
        "FTS replacement search",
        {
          skip: ftsEnabled
            ? false
            : "Windows FTS preload disabled by SDL_MCP_DISABLE_NATIVE_ADDON=1",
        },
        async () => {
          const fresh = await queryAll(
            conn,
            "CALL QUERY_FTS_INDEX('Symbol', 'reconcile_test_fts', 'newneedle') RETURN node.symbolId AS id",
          );
          assert.deepEqual(
            fresh.map((row) => row.id),
            ["symbol-a"],
          );
          assert.deepEqual(
            await queryAll(
              conn,
              "CALL QUERY_FTS_INDEX('Symbol', 'reconcile_test_fts', 'oldneedle') RETURN node.symbolId AS id",
            ),
            [],
          );
        },
      );
    } finally {
      if (ftsEnabled) await dropFtsIndex(conn, "Symbol", "reconcile_test_fts");
    }
    const again = await prepareRows(
      symbols("32", [{ path: "a.ts", id: "symbol-a", name: "newneedle" }]),
    );
    assert.equal(again.noOp, true);
    assert.equal((await publisher.publishReconcile(again)).kind, "noop");
  });

  it("aggregates a shared fileless target once, and publishes edge/reference/hash-only changes", async () => {
    function shared(run: string, firstEdge: boolean) {
      const input = symbols(run, [
        {
          path: "c.ts",
          id: "symbol-c",
          name: "c",
          target: firstEdge ? "external" : undefined,
        },
        { path: "d.ts", id: "symbol-d", name: "d", target: "external" },
      ]);
      input.result.rows.externalSymbols = [
        {
          symbolId: "external",
          repoId,
          kind: "function",
          name: "external",
          exported: true,
          language: "external",
          external: true,
          scipSymbol: "external",
          source: "scip",
          updatedAt: run,
        },
      ];
      return input;
    }
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(shared("40", true))))
        .kind,
      "published",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    const conn = await getLadybugConn();
    assert.equal(
      (await getGraphIntegrityFilelessStates(conn, repoId, ["external"]))[0]
        .referenceCount,
      2,
    );
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(shared("41", false))))
        .kind,
      "published",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    assert.equal(
      (await getGraphIntegrityFilelessStates(conn, repoId, ["external"]))[0]
        .referenceCount,
      1,
    );
    const equal = await prepareRows(shared("42", false));
    assert.equal(
      equal.noOp,
      true,
      "fresh temporary provider output paths are not semantic changes",
    );
    assert.equal((await publisher.publishReconcile(equal)).kind, "noop");

    const edge = shared("43", false);
    edge.result.rows.edges[0].weight = 0.5;
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(edge))).kind,
      "published",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    const beforeReference = (await getDerivedState(repoId))!
      .graphIntegrityRevision!;
    await withWriteConn((tx) =>
      db.deleteSymbolReferencesByFileId(tx, generateFileId(repoId, "c.ts")),
    );
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(edge))).kind,
      "published",
      "reference equality is independent of symbol digest",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    assert.equal(
      (await getDerivedState(repoId))!.graphIntegrityRevision,
      beforeReference + 1,
    );
    const hashOnly = shared("44", false);
    hashOnly.result.rows.edges[0].weight = 0.5;
    hashOnly.files[0].content = "c ";
    hashOnly.files[0].size = 2;
    hashOnly.files[0].contentHash = hashContent("c ");
    hashOnly.result.rows.files[0].contentHash = hashContent("c ");
    hashOnly.result.rows.files[0].byteSize = 2;
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(hashOnly))).kind,
      "published",
      "source metadata changes even with equal symbol/reference facts",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
  });

  it("unchanged A can no-op after another file B publishes", async () => {
    const a = symbols("50", [
      { path: "a.ts", id: "symbol-a", name: "newneedle" },
    ]);
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(a))).kind,
      "noop",
    );
    const b = symbols("51", [
      {
        path: "b.ts",
        id: "symbol-b",
        name: "updatedcaller",
        target: "symbol-a",
      },
    ]);
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(b))).kind,
      "published",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(a))).kind,
      "noop",
    );
  });

  it("removes one file membership without deleting another repository's shared symbol", async () => {
    const conn = await getLadybugConn();
    const shared = (
      await db.getSymbolsByFile(conn, generateFileId(repoId, "d.ts"))
    )[0];
    await withWriteConn(async (tx) => {
      await db.upsertRepo(tx, {
        repoId: "other",
        rootPath: repoRoot,
        configJson: "{}",
        createdAt: "now",
      });
      await db.upsertFile(tx, {
        fileId: "other-file",
        repoId: "other",
        relPath: "other.ts",
        contentHash: "other",
        language: "typescript",
        byteSize: 1,
        lastIndexedAt: "now",
      });
      await db.upsertSymbolBatch(tx, [
        { ...shared, repoId: "other", fileId: "other-file" },
      ]);
    });
    await rm(join(repoRoot, "d.ts"));
    const input = preparation("", "60");
    input.files = [];
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(input, ["d.ts"])))
        .kind,
      "published",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    assert.equal(
      (await db.getSymbolsByFile(conn, "other-file"))[0].symbolId,
      "symbol-d",
    );
    assert.equal(await db.getFileByRepoPath(conn, repoId, "d.ts"), null);
  });

  it("publishes two actual parser preparations atomically and then recognizes no-op", async () => {
    const files = ["p.test.ts", "q.test.ts"].map((path) => ({
      path,
      content: `import { newneedle } from "./a.js"; export function ${path[0]}() { return newneedle(); }`,
      size: 35,
      contentHash: "",
    }));
    for (const file of files) {
      file.size = Buffer.byteLength(file.content);
      file.contentHash = hashContent(file.content);
      await writeFile(join(repoRoot, file.path), file.content);
    }
    const config = AppConfigSchema.parse({
      repos: [],
      policy: {},
      indexing: { engine: "typescript", enableFileWatching: false },
    });
    const repoConfig = RepoConfigSchema.parse({
      repoId,
      rootPath: repoRoot,
      languages: ["ts"],
    });
    async function prepareParser() {
      const queue = new ReconcileQueue();
      for (const file of files)
        queue.enqueue(repoId, frontier, "parser", {
          [file.path]: {
            kind: "saved",
            content: file.content,
            sourceHash: file.contentHash,
          },
        });
      const baseline = await publisher.captureReconcileGraphBaseline(repoId);
      const prepared = await prepareReconcileFiles({
        repoId,
        repoRoot,
        appConfig: config,
        repoConfig,
        files,
        dependencyInputs: [],
        assertCurrent() {},
      });
      assert.equal(prepared.kind, "parser");
      return publisher.prepareReconcilePublication({
        repoId,
        repoRoot,
        baseline,
        epoch: captureActiveRepoEpoch(repoId)!,
        queue,
        claim: queue.claimNext()!,
        preparation: prepared,
        assertCurrent: () => true,
      });
    }
    const before = (await getDerivedState(repoId))!.graphIntegrityRevision!;
    assert.equal(
      (await publisher.publishReconcile(await prepareParser())).kind,
      "published",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    assert.equal(
      (await getDerivedState(repoId))!.graphIntegrityRevision,
      before + 1,
      "two files commit one revision",
    );
    const conn = await getLadybugConn();
    for (const file of files) {
      const durable = await db.getFileByRepoPath(conn, repoId, file.path);
      assert.equal(
        (await db.getSymbolsByFile(conn, durable!.fileId)).length,
        1,
      );
      assert.ok(
        (await getSymbolReferencesByFileIds(conn, repoId, [durable!.fileId]))
          .length > 0,
      );
    }
    assert.equal(
      (await publisher.publishReconcile(await prepareParser())).kind,
      "noop",
    );
    const durable = (await db.getFileByRepoPath(conn, repoId, files[0].path))!;
    await writeReconcileFileAuthoritiesInTransaction(conn, [
      {
        repoId,
        fileId: durable.fileId,
        relPath: durable.relPath,
        graphVersionId: "v1",
        sourceHash: files[0].contentHash,
        configHash: "provider-config",
        authorityJson: "{}",
      },
    ]);
    const transition = await prepareParser();
    assert.equal(
      transition.noOp,
      false,
      "provider authority removal is a canonical change even when parser rows agree",
    );
    assert.equal(
      (await publisher.publishReconcile(transition)).kind,
      "published",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    assert.equal(
      (await readReconcileFileAuthorities(conn, repoId, [durable.fileId])).size,
      0,
    );
  });

  it("rejects only the stale graph revision when saved source remains unchanged", async () => {
    const a = await prepareRows(
      symbols("70", [{ path: "a.ts", id: "symbol-a", name: "newneedle" }]),
    );
    assert.equal(a.noOp, true);
    const b = await prepareRows(
      symbols("71", [
        {
          path: "b.ts",
          id: "symbol-b",
          name: "anothercaller",
          target: "symbol-a",
        },
      ]),
    );
    assert.equal((await publisher.publishReconcile(b)).kind, "published");
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    assert.equal((await publisher.publishReconcile(a)).kind, "stale");
  });

  it("rejects prepared content owned by a different saved hash", async () => {
    const queue = new ReconcileQueue();
    queue.enqueue(repoId, frontier, "old", {
      "a.ts": { kind: "saved", content: "old", sourceHash: hashContent("old") },
    });
    const input = symbols("80", [
      { path: "a.ts", id: "symbol-a", name: "newneedle" },
    ]);
    await assert.rejects(
      publisher.prepareReconcilePublication({
        repoId,
        repoRoot,
        epoch: captureActiveRepoEpoch(repoId)!,
        baseline: await publisher.captureReconcileGraphBaseline(repoId),
        queue,
        claim: queue.claimNext()!,
        preparation: input,
        assertCurrent: () => true,
      }),
      /saved generation/,
    );
  });

  it("revalidates dependency content and configured ownership after preparation", async () => {
    const a = symbols("82", [
      { path: "a.ts", id: "symbol-a", name: "newneedle" },
    ]);
    await writeFile(join(repoRoot, "project-input.json"), "old");
    a.dependencyInputs.push({
      path: "project-input.json",
      contentHash: hashContent("old"),
    });
    const dependency = await prepareRows(a);
    await writeFile(join(repoRoot, "project-input.json"), "new");
    assert.equal((await publisher.publishReconcile(dependency)).kind, "stale");
    const config = await prepareRows(
      symbols("83", [{ path: "a.ts", id: "symbol-a", name: "newneedle" }]),
    );
    config.request.assertCurrent = () => false;
    assert.equal((await publisher.publishReconcile(config)).kind, "stale");
    const binary = symbols("84", [{ path: "a.ts", id: "symbol-a", name: "newneedle" }]);
    const bytes = Buffer.from([0xff, 0x00, 0xfe]);
    await writeFile(join(repoRoot, "bun.lockb"), bytes);
    binary.dependencyInputs.push({ path: "bun.lockb", contentHash: hash("sha256", bytes, "hex") });
    const unchangedBinary = await prepareRows(binary);
    assert.equal((await publisher.publishReconcile(unchangedBinary)).kind, unchangedBinary.noOp ? "noop" : "published");
    const changedBinary = await prepareRows(binary);
    // Both byte sequences decode to the same replacement characters in UTF-8.
    await writeFile(join(repoRoot, "bun.lockb"), Buffer.from([0xfd, 0x00, 0xfe]));
    assert.equal((await publisher.publishReconcile(changedBinary)).kind, "stale");
  });

  it("keeps shared-symbol ownership and dependency frontier in the selected repository", async () => {
    const conn = await getLadybugConn();
    const a = (
      await db.getSymbolsByFile(conn, generateFileId(repoId, "a.ts"))
    )[0];
    const b = (
      await db.getSymbolsByFile(conn, generateFileId(repoId, "b.ts"))
    )[0];
    await withWriteConn(async (tx) => {
      await db.upsertFile(tx, {
        fileId: "foreign-a",
        repoId: "other",
        relPath: "foreign-only.ts",
        contentHash: "foreign",
        language: "typescript",
        byteSize: 1,
        lastIndexedAt: "now",
      });
      await db.upsertSymbolBatch(tx, [
        { ...a, repoId: "other", fileId: "foreign-a" },
        {
          ...b,
          symbolId: "foreign-caller",
          repoId: "other",
          fileId: "foreign-a",
        },
      ]);
      await db.insertEdges(tx, [
        {
          repoId: "other",
          fromSymbolId: "foreign-caller",
          toSymbolId: a.symbolId,
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "scip",
          provenance: null,
          createdAt: "now",
        },
      ]);
    });
    const scoped = await buildDependencyFrontier({
      conn,
      repoId,
      touchedSymbolIds: [a.symbolId],
      outgoingEdges: [{ edgeType: "import", toSymbolId: "foreign-caller" }],
      currentFilePath: "a.ts",
    });
    assert.deepEqual(scoped.dependentFilePaths, ["b.ts"]);
    assert.deepEqual(scoped.importedFilePaths, []);
    assert.ok(!scoped.dependentSymbolIds.includes("foreign-caller"));
    const owned = await prepareRows(
      symbols("81", [{ path: "a.ts", id: "symbol-a", name: "newneedle" }]),
    );
    assert.equal(
      owned.noOp,
      true,
      "another repository membership cannot reject the selected owning file",
    );
  });
  it("attaches a foreign definition as a fileless target without replacing its metadata", async () => {
    const conn = await getLadybugConn();
    const before = (await db.getSymbolsByIds(conn, ["foreign-caller"])).get(
      "foreign-caller",
    )!;
    function input(run: string, target = true) {
      const result = symbols(run, [
        {
          path: "foreign-user.ts",
          id: "foreign-user",
          name: "useForeign",
          target: target ? "foreign-caller" : undefined,
        },
      ]);
      result.result.rows.externalSymbols = target
        ? [
            {
              symbolId: "foreign-caller",
              repoId,
              kind: "function",
              name: "must-not-overwrite",
              exported: true,
              external: true,
              scipSymbol: "foreign-caller",
              source: "scip",
              updatedAt: run,
            },
          ]
        : [];
      return result;
    }
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(input("90")))).kind,
      "published",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    assert.ok(
      (
        await db.getProviderExternalSymbolsByIds(conn, repoId, [
          "foreign-caller",
        ])
      ).has("foreign-caller"),
    );
    const manifest = (
      await getGraphIntegrityFilelessStates(conn, repoId, ["foreign-caller"])
    )[0];
    assert.equal(manifest.referenceCount, 1);
    assert.equal(
      createGraphIntegrityExpectationFromManifest(
        await db.listGraphIntegrityFileStates(conn, repoId),
        await db.listGraphIntegrityFilelessStates(conn, repoId),
      ).digest,
      (await capturePersistedGraphIntegrity(conn, repoId)).digest,
      "shared target canonical contribution matches actual persisted graph",
    );
    const after = (await db.getSymbolsByIds(conn, ["foreign-caller"])).get(
      "foreign-caller",
    )!;
    assert.equal(after.name, before.name);
    assert.equal(after.signatureJson, before.signatureJson);
    assert.equal(after.external, before.external);
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(input("91")))).kind,
      "noop",
    );
    const staleShared = await prepareRows(input("91b"));
    const revisionBefore = (await getDerivedState(repoId))!
      .graphIntegrityRevision;
    await withWriteConn((tx) =>
      db.upsertSymbolBatch(tx, [{ ...before, name: "changed-by-other-repo" }]),
    );
    assert.equal((await publisher.publishReconcile(staleShared)).kind, "stale");
    assert.equal(
      (await getDerivedState(repoId))!.graphIntegrityRevision,
      revisionBefore,
    );
    await withWriteConn((tx) => db.upsertSymbolBatch(tx, [before]));
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(input("92", false))))
        .kind,
      "published",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
    assert.deepEqual(
      await getGraphIntegrityFilelessStates(conn, repoId, ["foreign-caller"]),
      [],
    );
    assert.equal(
      (
        await db.getProviderExternalSymbolsByIds(conn, repoId, [
          "foreign-caller",
        ])
      ).size,
      0,
    );
    assert.ok(
      (await db.getSymbolsByIds(conn, ["foreign-caller"])).has(
        "foreign-caller",
      ),
    );
  });

  it("rejects changed shared definitions and owned outgoing edges before any graph mutation", async () => {
    const conn = await getLadybugConn();
    const before = await capturePersistedGraphIntegrity(conn, repoId);
    const derived = await getDerivedState(repoId);
    for (const item of [
      { path: "a.ts", id: "symbol-a", name: "changedShared" },
      { path: "a.ts", id: "symbol-a", name: "newneedle", target: "symbol-b" },
    ]) {
      await assert.rejects(
        prepareRows(symbols("95", [item])),
        /changed shared Symbol definitions or outgoing edges/,
      );
      assert.deepEqual(
        await capturePersistedGraphIntegrity(conn, repoId),
        before,
      );
      assert.deepEqual(await getDerivedState(repoId), derived);
    }
  });
  it("rejects shared outgoing-edge races and incompatible globally shared fileless facts", async () => {
    const conn = await getLadybugConn();
    const unchanged = await prepareRows(
      symbols("96", [{ path: "a.ts", id: "symbol-a", name: "newneedle" }]),
    );
    const revision = (await getDerivedState(repoId))!.graphIntegrityRevision;
    const edge = {
      repoId: "other",
      fromSymbolId: "symbol-a",
      toSymbolId: "foreign-caller",
      edgeType: "call",
      weight: 1,
      confidence: 1,
      resolution: "scip",
      provenance: null,
      createdAt: "now",
    };
    await withWriteConn((tx) => db.insertEdges(tx, [edge]));
    assert.equal((await publisher.publishReconcile(unchanged)).kind, "stale");
    assert.equal(
      (await getDerivedState(repoId))!.graphIntegrityRevision,
      revision,
    );
    await withWriteConn((tx) => db.deleteEdges(tx, [edge]));
    const shared = {
      symbolId: "global-fileless",
      repoId: "other",
      kind: "function",
      name: "actualForeign",
      exported: true,
      external: true,
      scipSymbol: "global-fileless",
      source: "scip" as const,
      updatedAt: "now",
    };
    await withWriteConn((tx) =>
      db.batchMergeExternalSymbols(tx, "other", [shared]),
    );
    const input = symbols("97", [
      {
        path: "global-user.ts",
        id: "global-user",
        name: "useGlobal",
        target: shared.symbolId,
      },
    ]);
    input.result.rows.externalSymbols = [
      { ...shared, repoId, name: "incompatible" },
    ];
    await assert.rejects(prepareRows(input), /shared fileless Symbol facts/);
    assert.equal(
      (
        await db.getProviderExternalSymbolsByIds(conn, "other", [
          shared.symbolId,
        ])
      ).get(shared.symbolId)!.name,
      shared.name,
    );
    assert.equal(
      (await getDerivedState(repoId))!.graphIntegrityRevision,
      revision,
    );
    input.result.rows.externalSymbols[0].name = shared.name;
    const compatible = await prepareRows(input);
    await withWriteConn((tx) =>
      db.batchMergeExternalSymbols(tx, "other", [
        { ...shared, name: "changedWhilePreparing" },
      ]),
    );
    assert.equal((await publisher.publishReconcile(compatible)).kind, "stale");
    await withWriteConn((tx) =>
      db.batchMergeExternalSymbols(tx, "other", [shared]),
    );
    assert.equal(
      (await publisher.publishReconcile(await prepareRows(input))).kind,
      "published",
    );
    await cancelAndWaitForGraphIntegrityVerifier(repoId);
  });
});
