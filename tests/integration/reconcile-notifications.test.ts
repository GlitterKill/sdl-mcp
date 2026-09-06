import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
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
import { capturePersistedGraphIntegrity } from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import { cancelAndWaitForAllGraphIntegrityVerifiers } from "../../dist/indexer/provider-first/background-graph-integrity-verifier.js";
import { AppConfigSchema, RepoConfigSchema } from "../../dist/config/types.js";
import { hashContent } from "../../dist/util/hashing.js";
import { captureActiveRepoEpoch } from "../../dist/services/repo-lifecycle.js";
import { ReconcileQueue } from "../../dist/live-index/reconcile-queue.js";
import { prepareReconcileFiles } from "../../dist/indexer/provider-first/reconcile-preparation.js";
import * as publisher from "../../dist/live-index/reconcile-publisher.js";
import { MCPServer } from "../../dist/server.js";
import { symbolCardCache } from "../../dist/graph/cache.js";
import { handleBufferStatus } from "../../dist/mcp/tools/buffer.js";
import {
  BufferStatusRequestSchema,
  BufferStatusResponseSchema,
} from "../../dist/mcp/tools.js";

const frontier = {
  touchedSymbolIds: [],
  dependentSymbolIds: [],
  dependentFilePaths: [],
  importedFilePaths: [],
  invalidations: [],
};
const appConfig = AppConfigSchema.parse({
  repos: [],
  policy: {},
  indexing: { engine: "typescript", enableFileWatching: false },
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// Flush transport microtasks without making notification absence depend on a timer.
const flush = () => new Promise<void>((done) => setImmediate(done));

describe("connected reconciliation notifications", { timeout: 30_000 }, () => {
  let root: string;
  const previousConfig = process.env.SDL_CONFIG;
  const repos = new Map<string, string>();
  const clients: Array<{ client: Client; server: MCPServer }> = [];
  async function initializeRepo(repoId: string) {
    const repoRoot = join(root, repoId);
    repos.set(repoId, repoRoot);
    await mkdir(repoRoot);
    await withWriteConn(async (conn) => {
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
        versionId: `v-${repoId}`,
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
        graphVersionId: `v-${repoId}`,
        graphRevision: 0,
        ...(await db.summarizeParserCoverageInTransaction(conn, repoId)),
      });
    });
    await markGraphIntegrityVerified(
      repoId,
      `v-${repoId}`,
      (await capturePersistedGraphIntegrity(await getLadybugConn(), repoId))
        .digest,
    );
  }
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "sdl-reconcile-notifications-"));
    process.env.SDL_CONFIG = join(root, "config.json");
    await writeFile(process.env.SDL_CONFIG, JSON.stringify(appConfig));
    await initLadybugDb(join(root, "graph.lbug"));
    for (const repoId of ["notice-a", "notice-b"]) {
      await initializeRepo(repoId);
    }
  });
  after(async () => {
    for (const { client, server } of clients) {
      await client.close();
      await server.stop();
    }
    await cancelAndWaitForAllGraphIntegrityVerifiers();
    await closeLadybugDb({ strict: true });
    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("sdl-reconcile-notifications-"));
    await rm(root, { recursive: true, force: true });
  });

  async function connect() {
    const messages: Array<{ type: string; repoId: string; phase: string }> = [];
    const server = new MCPServer();
    let closeCalls = 0;
    server.getServer().onclose = () => {
      closeCalls++;
    };
    server.registerTool(
      "sdl.repo.status",
      "status",
      z.object({ repoId: z.string().min(1).max(128) }),
      async ({ repoId }) => {
        if (!(await db.getRepo(await getLadybugConn(), repoId)))
          throw new Error("Unknown repository");
        return { repoId, status: "ok" };
      },
    );
    server.registerTool(
      "sdl.buffer.status",
      "buffer status",
      BufferStatusRequestSchema,
      (args, context) =>
        handleBufferStatus(args, context, {
          async getLiveStatus(repoId) {
            return {
              repoId,
              enabled: false,
              pendingBuffers: 0,
              dirtyBuffers: 0,
              parseQueueDepth: 0,
              checkpointPending: false,
              lastBufferEventAt: null,
              lastCheckpointAt: null,
              reconcileQueueDepth: 0,
              reconcileInflight: false,
            };
          },
        }),
      undefined,
      undefined,
      BufferStatusResponseSchema,
    );
    const client = new Client({
      name: "reconcile-notification-test",
      version: "1.0.0",
    });
    client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      (notification) => {
        const data = notification.params.data;
        if (typeof data === "object" && data?.type === "graph-update")
          messages.push(data);
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.getServer().connect(serverTransport);
    await client.connect(clientTransport);
    clients.push({ client, server });
    await client.setLoggingLevel("info");
    return { client, server, messages, closeCalls: () => closeCalls };
  }
  async function prepare(
    repoId: string,
    name: string,
    queue = new ReconcileQueue(),
  ) {
    const repoRoot = repos.get(repoId)!;
    const content = `export function ${name}() { return 1; }`;
    const path = "notice.test.ts";
    await writeFile(join(repoRoot, path), content);
    queue.enqueue(repoId, frontier, "save", {
      [path]: { kind: "saved", content, sourceHash: hashContent(content) },
    });
    const claim = queue.claimNext()!;
    const baseline = await publisher.captureReconcileGraphBaseline(repoId);
    const preparation = await prepareReconcileFiles({
      repoId,
      repoRoot,
      appConfig,
      repoConfig: RepoConfigSchema.parse({
        repoId,
        rootPath: repoRoot,
        languages: ["ts"],
      }),
      files: [
        {
          path,
          content,
          size: Buffer.byteLength(content),
          contentHash: hashContent(content),
        },
      ],
      dependencyInputs: [],
      assertCurrent: () => assert.ok(queue.isCurrent(claim)),
    });
    return publisher.prepareReconcilePublication({
      repoId,
      repoRoot,
      epoch: captureActiveRepoEpoch(repoId)!,
      baseline,
      queue,
      claim,
      preparation,
      assertCurrent: () => queue.isCurrent(claim),
    });
  }

  it("delivers only actual publication phases to interested clients and cleans disconnects", async (t) => {
    const a = await connect();
    const b = await connect();
    const uninterested = await connect();
    let cacheInvalidated = false;
    const completedCacheStates: boolean[] = [];
    const invalidateRepo = symbolCardCache.invalidateRepo;
    t.mock.method(symbolCardCache, "invalidateRepo", function (repoId) {
      if (repoId === "notice-a") cacheInvalidated = true;
      invalidateRepo.call(this, repoId);
    });
    const sendLoggingMessage = a.server.getServer().sendLoggingMessage;
    t.mock.method(
      a.server.getServer(),
      "sendLoggingMessage",
      function (params, sessionId) {
        if (
          params.data?.type === "graph-update" &&
          params.data.phase === "completed"
        )
          completedCacheStates.push(cacheInvalidated);
        return sendLoggingMessage.call(this, params, sessionId);
      },
    );
    const catalog = JSON.stringify(await a.client.listTools());
    await a.client.callTool({
      name: "sdl.repo.status",
      arguments: { repoId: "notice-a" },
    });
    await b.client.callTool({
      name: "sdl.repo.status",
      arguments: { repoId: "notice-b" },
    });
    // A nonexistent ID cannot become an interest just because it is well-shaped.
    await uninterested.client.callTool({
      name: "sdl.repo.status",
      arguments: { repoId: "not-registered" },
    });
    const prepared = await prepare("notice-a", "saved13");
    assert.deepEqual(a.messages, [], "preparation is not a graph update");
    const entered = deferred();
    const release = deferred();
    const pending = publisher.publishReconcile(prepared, {
      afterRows: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    try {
      await entered.promise;
      await flush();
      assert.deepEqual(a.messages, [
        { type: "graph-update", repoId: "notice-a", phase: "started" },
      ]);
      assert.equal(publisher.isReconcilePublishing("notice-a"), true);
      assert.equal(
        (
          await a.client.callTool({
            name: "sdl.buffer.status",
            arguments: { repoId: "notice-a" },
          })
        ).structuredContent?.reconciliationState,
        "publishing",
      );
      assert.deepEqual(b.messages, []);
      assert.deepEqual(uninterested.messages, []);
    } finally {
      release.resolve();
      await pending;
    }
    await flush();
    assert.equal(publisher.isReconcilePublishing("notice-a"), false);
    assert.equal(
      (
        await a.client.callTool({
          name: "sdl.buffer.status",
          arguments: { repoId: "notice-a" },
        })
      ).structuredContent?.reconciliationState,
      "idle",
    );
    assert.deepEqual(
      a.messages.map((message) => message.phase),
      ["started", "completed"],
    );
    assert.deepEqual(
      completedCacheStates,
      [true],
      "a client reacting to completion cannot reuse old symbol cards",
    );
    assert.equal(
      (
        await db.getSymbolsByFile(
          await getLadybugConn(),
          prepared.rows.files[0].fileId,
        )
      )[0].name,
      "saved13",
    );
    const same = await prepare("notice-a", "saved13");
    assert.equal((await publisher.publishReconcile(same)).kind, "noop");
    await flush();
    assert.equal(a.messages.length, 2, "no-op emits nothing");
    assert.equal(JSON.stringify(await a.client.listTools()), catalog);
    const sends = t.mock.method(
      a.server.getServer(),
      "sendLoggingMessage",
      async () => {},
    );
    await a.client.close();
    assert.equal(
      a.closeCalls(),
      1,
      "notification cleanup preserves the entrypoint's disconnect callback",
    );
    assert.equal(
      (
        await publisher.publishReconcile(
          await prepare("notice-a", "afterDisconnect"),
        )
      ).kind,
      "published",
    );
    await flush();
    assert.equal(
      sends.mock.callCount(),
      0,
      "disconnect removes the listener, not merely its transport",
    );
    await initializeRepo("not-registered");
    assert.equal(
      (
        await publisher.publishReconcile(
          await prepare("not-registered", "registeredLater"),
        )
      ).kind,
      "published",
    );
    await flush();
    assert.deepEqual(
      uninterested.messages,
      [],
      "invalid registration cannot pre-subscribe a future repository",
    );
  });

  it("discards save 12 notifications and reports rollback or filtered/failed delivery truthfully", async (t) => {
    const a = await connect();
    await a.client.callTool({
      name: "sdl.repo.status",
      arguments: { repoId: "notice-a" },
    });
    const queue = new ReconcileQueue();
    const twelve = await prepare("notice-a", "save12", queue);
    const content = "export function save13() { return 1; }";
    await queue.withPublicationFence("notice-a", async () => {
      await writeFile(join(repos.get("notice-a")!, "notice.test.ts"), content);
      queue.enqueue("notice-a", frontier, "save13", {
        "notice.test.ts": {
          kind: "saved",
          content,
          sourceHash: hashContent(content),
        },
      });
    });
    assert.equal((await publisher.publishReconcile(twelve)).kind, "stale");
    await flush();
    assert.deepEqual(a.messages, []);
    const thirteen = await prepare("notice-a", "save13");
    assert.equal(
      (await publisher.publishReconcile(thirteen)).kind,
      "published",
    );
    await flush();
    assert.deepEqual(
      a.messages.map((message) => message.phase),
      ["started", "completed"],
    );
    a.messages.length = 0;
    const failing = await prepare("notice-a", "rolledBack");
    const before = await getDerivedState("notice-a");
    await assert.rejects(
      publisher.publishReconcile(failing, {
        afterRows: () => {
          throw new Error("injected row failure at secret absolute path");
        },
      }),
      /injected row failure/,
    );
    await flush();
    assert.deepEqual(a.messages, [
      { type: "graph-update", repoId: "notice-a", phase: "started" },
      { type: "graph-update", repoId: "notice-a", phase: "failed" },
    ]);
    assert.equal(publisher.isReconcilePublishing("notice-a"), false);
    assert.equal(
      (await getDerivedState("notice-a"))!.graphIntegrityRevision,
      before!.graphIntegrityRevision,
    );
    a.messages.length = 0;
    await a.client.setLoggingLevel("error");
    assert.equal(
      (await publisher.publishReconcile(await prepare("notice-a", "filtered")))
        .kind,
      "published",
    );
    await flush();
    assert.deepEqual(
      a.messages,
      [],
      "SDK log-level filtering remains respected",
    );
    t.mock.method(a.server.getServer(), "sendLoggingMessage", async () => {
      throw new Error("disconnected transport");
    });
    assert.equal(
      (
        await publisher.publishReconcile(
          await prepare("notice-a", "deliveryFailure"),
        )
      ).kind,
      "published",
    );
    assert.equal(publisher.isReconcilePublishing("notice-a"), false);
  });

  it("bounds repository interest without retaining an evicted repository", async () => {
    const a = await connect();
    await a.client.callTool({
      name: "sdl.repo.status",
      arguments: { repoId: "notice-a" },
    });
    for (let i = 0; i < 64; i++) {
      const repoId = `interest-${i}`;
      await withWriteConn((conn) =>
        db.upsertRepo(conn, {
          repoId,
          rootPath: root,
          configJson: "{}",
          createdAt: "2026-01-01",
        }),
      );
      await a.client.callTool({
        name: "sdl.repo.status",
        arguments: { repoId },
      });
    }
    assert.equal(
      (await publisher.publishReconcile(await prepare("notice-a", "evicted")))
        .kind,
      "published",
    );
    await flush();
    assert.deepEqual(a.messages, []);
    await a.client.callTool({
      name: "sdl.repo.status",
      arguments: { repoId: "notice-a" },
    });
    assert.equal(
      (
        await publisher.publishReconcile(
          await prepare("notice-a", "interestedAgain"),
        )
      ).kind,
      "published",
    );
    await flush();
    assert.deepEqual(
      a.messages.map((message) => message.phase),
      ["started", "completed"],
    );
  });

  it("settles a failed publication before the next owner starts", async () => {
    const b = await connect();
    await b.client.callTool({
      name: "sdl.repo.status",
      arguments: { repoId: "notice-b" },
    });
    const first = await prepare("notice-b", "queuedPublication");
    const second = await prepare("notice-b", "queuedPublication");
    const firstEntered = deferred();
    const firstRelease = deferred();
    const secondEntered = deferred();
    const secondRelease = deferred();
    const failed = assert.rejects(
      publisher.publishReconcile(first, {
        afterRows: async () => {
          firstEntered.resolve();
          await firstRelease.promise;
          throw new Error("first publisher rolls back");
        },
      }),
      /first publisher rolls back/,
    );
    await firstEntered.promise;
    const next = publisher.publishReconcile(second, {
      afterRows: async () => {
        secondEntered.resolve();
        await secondRelease.promise;
      },
    });
    try {
      firstRelease.resolve();
      await secondEntered.promise;
      await flush();
      assert.equal(publisher.isReconcilePublishing("notice-b"), true);
      assert.deepEqual(
        b.messages.map((message) => message.phase),
        ["started", "failed", "started"],
      );
    } finally {
      firstRelease.resolve();
      secondRelease.resolve();
      await failed;
      assert.equal((await next).kind, "published");
    }
    await flush();
    assert.equal(publisher.isReconcilePublishing("notice-b"), false);
    assert.deepEqual(
      b.messages.map((message) => message.phase),
      ["started", "failed", "started", "completed"],
    );
  });
});
