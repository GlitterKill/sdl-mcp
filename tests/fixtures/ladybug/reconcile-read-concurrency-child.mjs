import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";

const [mode, root] = process.argv.slice(2);
assert.ok(mode === "ordinary" || mode === "fts");
assert.equal(dirname(resolve(root)), resolve(tmpdir()));
assert.ok(basename(root).startsWith("sdl-reconcile-read-"));
process.env.SDL_CONFIG = join(root, "config.json");
process.env.SDL_GRAPH_DB_PATH = join(root, "graph.lbug");
await writeFile(
  process.env.SDL_CONFIG,
  JSON.stringify({
    repos: [],
    indexing: { engine: "typescript", enableFileWatching: false },
  }),
);

const { initLadybugDb, closeLadybugDb, getLadybugConn } =
  await import("../../../dist/db/ladybug.js");
const { execStoredProc, queryAll } =
  await import("../../../dist/db/ladybug-core.js");
const { withExclusiveLadybugOperation, withSharedLadybugOperation } =
  await import("../../../dist/db/ladybug-operation-gate.js");
const { assertGraphRetrievalAvailable } =
  await import("../../../dist/services/graph-retrieval-availability.js");
const db = await import("../../../dist/db/ladybug-queries.js");
const { markGraphIntegrityVerified } =
  await import("../../../dist/db/ladybug-derived-state.js");
const { capturePersistedGraphIntegrity } =
  await import("../../../dist/indexer/provider-first/persisted-graph-integrity.js");
const { cancelAndWaitForGraphIntegrityVerifier } =
  await import("../../../dist/indexer/provider-first/background-graph-integrity-verifier.js");
const { AppConfigSchema, RepoConfigSchema } =
  await import("../../../dist/config/types.js");
const { hashContent } = await import("../../../dist/util/hashing.js");
const { captureActiveRepoEpoch } =
  await import("../../../dist/services/repo-lifecycle.js");
const { ReconcileQueue } =
  await import("../../../dist/live-index/reconcile-queue.js");
const { prepareReconcileFiles } =
  await import("../../../dist/indexer/provider-first/reconcile-preparation.js");
const {
  captureReconcileGraphBaseline,
  prepareReconcilePublication,
  publishReconcile,
} = await import("../../../dist/live-index/reconcile-publisher.js");
const repoId = "read-probe";
const repoRoot = join(root, "repo");
await mkdir(repoRoot);
const repoConfig = RepoConfigSchema.parse({
  repoId,
  rootPath: repoRoot,
  languages: ["ts"],
});
const appConfig = AppConfigSchema.parse({
  repos: [],
  policy: {},
  indexing: { engine: "typescript", enableFileWatching: false },
});
const queue = new ReconcileQueue();

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

await initLadybugDb(process.env.SDL_GRAPH_DB_PATH);
try {
  const conn = await getLadybugConn();
  await db.upsertRepo(conn, {
    repoId,
    rootPath: repoRoot,
    configJson: JSON.stringify(repoConfig),
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
  await db.upsertRepoParserStateInTransaction(conn, {
    repoId,
    graphVersionId: "v1",
    graphRevision: 0,
    ...(await db.summarizeParserCoverageInTransaction(conn, repoId)),
  });
  await markGraphIntegrityVerified(
    repoId,
    "v1",
    (await capturePersistedGraphIntegrity(conn, repoId)).digest,
  );

  async function prepare(name) {
    const content = `export function ${name}() { return 1; }`;
    await writeFile(join(repoRoot, "probe.test.ts"), content);
    queue.enqueue(
      repoId,
      {
        touchedSymbolIds: [],
        dependentSymbolIds: [],
        dependentFilePaths: [],
        importedFilePaths: [],
        invalidations: [],
      },
      "saved",
      {
        "probe.test.ts": {
          kind: "saved",
          content,
          sourceHash: hashContent(content),
        },
      },
    );
    const claim = queue.claimNext();
    assert.ok(claim);
    const baseline = await captureReconcileGraphBaseline(repoId);
    const preparation = await prepareReconcileFiles({
      repoId,
      repoRoot,
      repoConfig,
      appConfig,
      files: [
        {
          path: "probe.test.ts",
          content,
          size: Buffer.byteLength(content),
          contentHash: hashContent(content),
        },
      ],
      dependencyInputs: [],
      assertCurrent: () => assert.ok(queue.isCurrent(claim)),
    });
    return prepareReconcilePublication({
      repoId,
      repoRoot,
      epoch: captureActiveRepoEpoch(repoId),
      baseline,
      queue,
      claim,
      preparation,
      assertCurrent: () => queue.isCurrent(claim),
    });
  }
  const initial = await prepare("oldneedle");
  assert.equal((await publishReconcile(initial)).kind, "published");
  queue.complete(initial.request.claim, "initial");
  await cancelAndWaitForGraphIntegrityVerifier(repoId);
  if (mode === "fts") {
    await withExclusiveLadybugOperation(async () => {
      const conn = await getLadybugConn();
      await execStoredProc(
        conn,
        "CALL CREATE_FTS_INDEX('Symbol', 'reconcile_read_probe', ['searchText'])",
      );
    });
  }
  const entered = deferred();
  const release = deferred();
  const prepared = await prepare("newneedle");
  // Hold actual replacement rows before manifest/revision commit, not a mock writer.
  const writer = publishReconcile(prepared, {
    afterRows: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  const started = performance.now();
  let readMs;
  try {
    const conn = await getLadybugConn();
    await assertGraphRetrievalAvailable(conn, repoId);
    const rows = await queryAll(
      conn,
      "MATCH (s:Symbol {repoId: $repoId}) RETURN s.name AS name",
      { repoId },
    );
    assert.deepEqual(
      rows.map((row) => row.name),
      ["oldneedle"],
      "uncommitted replacement is invisible",
    );
    if (mode === "fts") {
      const hits = await queryAll(
        conn,
        "CALL QUERY_FTS_INDEX('Symbol', 'reconcile_read_probe', 'oldneedle') RETURN node.name AS name",
      );
      assert.deepEqual(
        hits.map((hit) => hit.name),
        ["oldneedle"],
      );
    }
    readMs = performance.now() - started;
  } finally {
    release.resolve();
    assert.equal((await writer).kind, "published");
  }
  await cancelAndWaitForGraphIntegrityVerifier(repoId);
  await assertGraphRetrievalAvailable(await getLadybugConn(), repoId);
  assert.equal(
    (
      await queryAll(
        await getLadybugConn(),
        "MATCH (s:Symbol {repoId: $repoId}) RETURN s.name AS name",
        { repoId },
      )
    )[0]?.name,
    "newneedle",
  );

  const exclusiveEntered = deferred();
  const releaseExclusive = deferred();
  const exclusive = withExclusiveLadybugOperation(async () => {
    await queryAll(await getLadybugConn(), "RETURN 1 AS value");
    exclusiveEntered.resolve();
    await releaseExclusive.promise;
  });
  await exclusiveEntered.promise;
  // A foreground timeout must not release another operation's native ownership.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        withSharedLadybugOperation(async () => {
          assert.fail("reader entered before the exclusive owner settled");
        }, 20),
        /Timed out/,
      );
    }
  } finally {
    releaseExclusive.resolve();
    await exclusive;
    clearInterval(keepAlive);
  }
  await withSharedLadybugOperation(async () =>
    queryAll(await getLadybugConn(), "RETURN 1 AS value"),
  );
  console.log(
    JSON.stringify({
      mode,
      platform: process.platform,
      node: process.version,
      readsBeforeCommit: true,
      readMs,
      exclusiveAdmissionRetained: true,
    }),
  );
} finally {
  await cancelAndWaitForGraphIntegrityVerifier(repoId);
  await closeLadybugDb({ strict: true });
}
