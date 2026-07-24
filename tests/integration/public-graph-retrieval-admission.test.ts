import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Connection } from "kuzu";
import { z } from "zod";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import {
  clearPreparedStatementCache,
  withTransaction,
} from "../../dist/db/ladybug-core.js";
import * as derivedState from "../../dist/db/ladybug-derived-state.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  createGraphIntegrityExpectationFromManifest,
  createGraphIntegrityFileState,
} from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import {
  _getIndexRefreshAdmissionStatsForTesting,
  resetToolDispatchLimiter,
  waitForToolDispatchIdle,
} from "../../dist/mcp/dispatch-limiter.js";
import { createMCPServer, MCPServer } from "../../dist/server.js";

const TEMP_BASE =
  process.platform === "win32" ? join(homedir(), ".codex", "tmp") : tmpdir();
mkdirSync(TEMP_BASE, { recursive: true });
const TEST_ROOT = mkdtempSync(join(TEMP_BASE, "sdl-public-admission-"));
const DB_DIR = join(TEST_ROOT, "db");
const DB_PATH = join(DB_DIR, "graph.lbug");
const CONFIG_PATH = join(TEST_ROOT, "sdl.config.json");
const NOW = "2026-07-21T00:00:00.000Z";

interface ErrorEnvelope {
  isError?: boolean;
  structuredContent?: {
    error?: { code?: string; message?: string };
  };
}

type PublicCall = {
  name: string;
  arguments: Record<string, unknown>;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function connect(server: MCPServer): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: `public-admission-${randomUUID()}`,
    version: "1.0.0",
  });
  await server.getServer().connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function assertUnavailable(response: ErrorEnvelope, label: string): void {
  assert.equal(response.isError, true, label);
  assert.equal(response.structuredContent?.error?.code, "INDEX_ERROR", label);
  assert.match(
    response.structuredContent?.error?.message ?? "",
    /--safe-rebuild <absolute-new-path>/,
    label,
  );
  assert.doesNotMatch(
    response.structuredContent?.error?.message ?? "",
    /[A-Z]:\\|\.lbug|revision \d/i,
    label,
  );
}

function assertRepositoryNotFound(
  response: ErrorEnvelope,
  repoId: string,
  label: string,
): void {
  assert.equal(response.isError, true, label);
  assert.equal(response.structuredContent?.error?.code, "NOT_FOUND", label);
  assert.equal(
    response.structuredContent?.error?.message,
    `Repository not found: ${repoId}`,
    label,
  );
  assert.doesNotMatch(
    response.structuredContent?.error?.message ?? "",
    /Graph retrieval|sdl\.index\.refresh|--safe-rebuild/,
    label,
  );
}

function assertWorkflowSucceeded(response: unknown, label: string): void {
  const envelope = response as {
    isError?: boolean;
    structuredContent?: {
      results?: Array<{
        fn?: string;
        status?: string;
        result?: unknown;
      }>;
    };
  };
  assert.notEqual(envelope.isError, true, label);
  assert.ok(envelope.structuredContent?.results?.length, label);
  for (const step of envelope.structuredContent.results) {
    // Compact workflow projection represents success as { fn, result } and
    // only emits status for failures (or when telemetry is requested).
    assert.deepEqual(Object.keys(step), ["fn", "result"], label);
    assert.equal(typeof step.fn, "string", label);
    assert.equal(step.status, undefined, label);
    assert.notEqual(step.result, undefined, label);
  }
}

function isSliceBuildCall(call: PublicCall): boolean {
  if (call.name === "sdl.slice.build") return true;
  if (call.name === "sdl.retrieve") return call.arguments.op === "sliceBuild";
  if (call.name === "sdl.query") return call.arguments.action === "slice.build";
  if (call.name !== "sdl.workflow") return false;
  const steps = call.arguments.steps;
  return Array.isArray(steps)
    && steps.some(
      (step) =>
        typeof step === "object"
        && step !== null
        && (step as { fn?: unknown }).fn === "sliceBuild",
    );
}

function findSliceHandles(
  value: unknown,
  handles = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) findSliceHandles(item, handles);
    return handles;
  }
  if (typeof value !== "object" || value === null) return handles;
  for (const [key, item] of Object.entries(value)) {
    if (key === "sliceHandle" && typeof item === "string") handles.add(item);
    findSliceHandles(item, handles);
  }
  return handles;
}

function serializeWithStableSliceHandle(response: unknown, label: string): string {
  const handles = [...findSliceHandles(response)];
  assert.equal(handles.length, 1, `${label}: one generated slice handle`);
  const [handle] = handles;
  assert.match(handle, /^[0-9a-f]{32}$/, `${label}: generated slice handle`);

  // slice.build intentionally uses crypto.randomBytes(16). Replace only that
  // exact handle and the formatter's exact eight-character display prefix.
  return JSON.stringify(response)
    .replaceAll(handle, "<generated-slice-handle>")
    .replaceAll(handle.slice(0, 8), "<generated-slice-handle-prefix>");
}

function assertNoAdmissionFields(response: unknown, label: string): void {
  assert.doesNotMatch(
    JSON.stringify(response),
    /"(?:admission|graphRetrievalAvailable|graphIntegrityState|graphIntegrityRevision|graphIntegrityVerifiedRevision)"/,
    `${label}: admission remains response-transparent`,
  );
}

async function seedRepo(
  repoId: string,
  state: "verified" | "verifying" | "failed" | "unknown",
): Promise<void> {
  const fileId = `${repoId}:src/alpha.ts`;
  const versionId = `${repoId}:v1`;
  const symbol = {
    symbolId: `${repoId}:alpha`,
    repoId,
    fileId,
    kind: "function",
    name: "alpha",
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 1,
    rangeEndCol: 37,
    astFingerprint: `${repoId}:fingerprint`,
    signatureJson: '{"name":"alpha"}',
    summary: "Returns one",
    invariantsJson: null,
    sideEffectsJson: null,
    source: "scip",
    scipSymbol: `scip-typescript npm fixture 1.0.0 ${repoId}/alpha().`,
    updatedAt: NOW,
  };
  const manifestFile = createGraphIntegrityFileState(
    repoId,
    fileId,
    "src/alpha.ts",
    [symbol],
    [],
  );
  const expectation = createGraphIntegrityExpectationFromManifest(
    [manifestFile],
    [],
  );

  await withWriteConn((conn) =>
    withTransaction(conn, async () => {
      await ladybugDb.upsertRepo(conn, {
        repoId,
        rootPath: TEST_ROOT,
        configJson: JSON.stringify({ policy: {} }),
        createdAt: NOW,
      });
      await ladybugDb.upsertFile(conn, {
        fileId,
        repoId,
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 38,
        lastIndexedAt: NOW,
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [symbol]);
      await ladybugDb.createVersion(conn, {
        versionId: `${repoId}:v0`,
        repoId,
        createdAt: "2026-07-20T00:00:00.000Z",
        reason: "test-base",
        prevVersionHash: null,
        versionHash: null,
      });
      await ladybugDb.createVersion(conn, {
        versionId,
        repoId,
        createdAt: NOW,
        reason: "test",
        prevVersionHash: null,
        versionHash: null,
      });
      for (const snapshotVersionId of [`${repoId}:v0`, versionId]) {
        await ladybugDb.snapshotSymbolVersion(conn, {
          versionId: snapshotVersionId,
          symbolId: symbol.symbolId,
          astFingerprint: symbol.astFingerprint,
          signatureJson: symbol.signatureJson,
          summary: symbol.summary,
          invariantsJson: symbol.invariantsJson,
          sideEffectsJson: symbol.sideEffectsJson,
        });
      }
      await ladybugDb.upsertSliceHandle(conn, {
        handle: `${repoId}-refresh-handle`,
        repoId,
        createdAt: NOW,
        expiresAt: "2099-07-21T00:00:00.000Z",
        minVersion: versionId,
        maxVersion: versionId,
        sliceHash: `${repoId}-slice-hash`,
        spilloverRef: null,
        cardDetail: null,
      });
      if (state !== "unknown") {
        await ladybugDb.replaceGraphIntegrityManifestInTransaction(
          conn,
          repoId,
          { files: [manifestFile], fileless: [] },
        );
        await derivedState.beginGraphIntegrityVersion(
          conn,
          repoId,
          versionId,
          expectation.digest,
          true,
        );
        if (state !== "verified") {
          assert.equal(
            await derivedState.advanceGraphIntegrityRevisionInTransaction(
              conn,
              repoId,
              versionId,
              0,
            ),
            1,
          );
        }
      }
    }),
  );
  if (state === "failed") {
    await derivedState.markGraphIntegrityFailedIfVerifying(
      repoId,
      versionId,
      1,
      "test failure",
    );
  }
}

async function seedRepoWithoutVersion(repoId: string): Promise<void> {
  await withWriteConn((conn) =>
    ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: TEST_ROOT,
      configJson: JSON.stringify({ policy: {} }),
      createdAt: NOW,
    }),
  );
}

async function seedVerifiedEmptyManifestRepo(repoId: string): Promise<void> {
  const versionId = `${repoId}:v1`;
  const expectation = createGraphIntegrityExpectationFromManifest([], []);
  await withWriteConn((conn) =>
    withTransaction(conn, async () => {
      await ladybugDb.upsertRepo(conn, {
        repoId,
        rootPath: TEST_ROOT,
        configJson: JSON.stringify({ policy: {} }),
        createdAt: NOW,
      });
      await ladybugDb.createVersion(conn, {
        versionId,
        repoId,
        createdAt: NOW,
        reason: "valid empty manifest",
        prevVersionHash: null,
        versionHash: null,
      });
      await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, repoId, {
        files: [],
        fileless: [],
      });
      await derivedState.beginGraphIntegrityVersion(
        conn,
        repoId,
        versionId,
        expectation.digest,
        true,
      );
    }),
  );
  await derivedState.markGraphIntegrityVerified(
    repoId,
    versionId,
    expectation.digest,
  );
}

function centralCalls(repoId: string): PublicCall[] {
  const symbolId = `${repoId}:alpha`;
  const fromVersion = `${repoId}:v0`;
  const toVersion = `${repoId}:v1`;
  const codeWindowArgs = {
    repoId,
    symbolId,
    reason: "Inspect alpha",
    expectedLines: 20,
    identifiersToFind: ["alpha"],
  };
  const retrieveArgs: Record<string, Record<string, unknown>> = {
    symbolSearch: { query: "alpha", semantic: false },
    symbolGetCard: { symbolId },
    sliceBuild: { entrySymbols: [symbolId] },
    codeSkeleton: { symbolId },
    codeHotPath: { symbolId, identifiersToFind: ["alpha"] },
    codeNeedWindow: {
      symbolId,
      reason: "Inspect alpha",
      expectedLines: 20,
      identifiersToFind: ["alpha"],
    },
  };

  return [
    {
      name: "sdl.symbol.search",
      arguments: { repoId, query: "alpha", semantic: false },
    },
    { name: "sdl.symbol.getCard", arguments: { repoId, symbolId } },
    {
      name: "sdl.slice.build",
      arguments: { repoId, entrySymbols: [symbolId] },
    },
    {
      name: "sdl.slice.spillover.get",
      arguments: { repoId, spilloverHandle: "missing-handle" },
    },
    { name: "sdl.delta.get", arguments: { repoId } },
    {
      name: "sdl.pr.risk.analyze",
      arguments: { repoId, fromVersion, toVersion },
    },
    { name: "sdl.code.needWindow", arguments: codeWindowArgs },
    {
      name: "sdl.code.getSkeleton",
      arguments: { repoId, symbolId },
    },
    {
      name: "sdl.code.getHotPath",
      arguments: { repoId, symbolId, identifiersToFind: ["alpha"] },
    },
    {
      name: "sdl.repo.overview",
      arguments: { repoId, level: "stats" },
    },
    {
      name: "sdl.context",
      arguments: {
        repoId,
        taskType: "explain",
        taskText: "Explain alpha",
      },
    },
    ...Object.entries(retrieveArgs).map(([op, args]) => ({
      name: "sdl.retrieve",
      arguments: { repoId, op, args },
    })),
    {
      name: "sdl.file",
      arguments: {
        op: "previewWindow",
        planHandle: "missing-plan",
        ...codeWindowArgs,
      },
    },
    {
      name: "sdl.file",
      arguments: {
        op: "sourceWindow",
        planHandle: "missing-plan",
        ...codeWindowArgs,
      },
    },
    {
      name: "sdl.query",
      arguments: { repoId, action: "symbol.search", query: "alpha" },
    },
    {
      name: "sdl.query",
      arguments: { repoId, action: "slice.build", entrySymbols: [symbolId] },
    },
    {
      name: "sdl.query",
      arguments: { repoId, action: "delta.get", fromVersion, toVersion },
    },
    {
      name: "sdl.query",
      arguments: {
        repoId,
        action: "pr.risk.analyze",
        fromVersion,
        toVersion,
      },
    },
    {
      name: "sdl.code",
      arguments: { action: "code.needWindow", ...codeWindowArgs },
    },
    {
      name: "sdl.code",
      arguments: { repoId, action: "code.getSkeleton", symbolId },
    },
    {
      name: "sdl.code",
      arguments: {
        repoId,
        action: "code.getHotPath",
        symbolId,
        identifiersToFind: ["alpha"],
      },
    },
    {
      name: "sdl.repo",
      arguments: { repoId, action: "repo.overview", level: "stats" },
    },
    {
      name: "sdl.workflow",
      arguments: {
        repoId,
        steps: [{ fn: "symbolSearch", args: { query: "alpha" } }],
      },
    },
    {
      name: "sdl.workflow",
      arguments: {
        repoId,
        steps: [
          { fn: "sliceBuild", args: { entrySymbols: [symbolId] } },
        ],
      },
    },
  ];
}

describe("public graph retrieval admission", { concurrency: 1 }, () => {
  let server: MCPServer;
  let client: Client;
  const previousEnv = {
    config: process.env.SDL_CONFIG,
    graphDb: process.env.SDL_GRAPH_DB_PATH,
    graphDir: process.env.SDL_GRAPH_DB_DIR,
    db: process.env.SDL_DB_PATH,
    native: process.env.SDL_MCP_DISABLE_NATIVE_ADDON,
  };

  before(async () => {
    mkdirSync(DB_DIR, { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "alpha.ts"),
      "export function alpha() { return 1; }\n",
      "utf8",
    );
    writeFileSync(join(TEST_ROOT, "notes.txt"), "fixture notes\n", "utf8");
    mkdirSync(join(TEST_ROOT, "src"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "src", "alpha.ts"),
      "export function alpha() { return 1; }\n",
      "utf8",
    );
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        repos: [],
        policy: {},
        graphDatabase: { path: DB_PATH },
        liveIndex: { enabled: false },
        prefetch: { enabled: false },
        memory: { enabled: false },
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = CONFIG_PATH;
    process.env.SDL_GRAPH_DB_PATH = DB_PATH;
    process.env.SDL_GRAPH_DB_DIR = DB_DIR;
    process.env.SDL_DB_PATH = DB_PATH;
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    invalidateConfigCache();
    await closeLadybugDb();
    await initLadybugDb(DB_PATH);
    await seedRepo("verified", "verified");
    await seedRepo("verifying", "verifying");
    await seedRepo("failed", "failed");
    await seedRepo("unknown", "unknown");
    await seedRepo("missing-manifest", "verified");
    await withWriteConn((conn) =>
      ladybugDb.deleteGraphIntegrityManifestInTransaction(
        conn,
        "missing-manifest",
      ),
    );
    await seedVerifiedEmptyManifestRepo("empty-manifest");
    await seedRepoWithoutVersion("empty");

    server = await createMCPServer({
      gatewayConfig: {
        enabled: true,
        emitLegacyTools: true,
        toolNameFormat: "canonical",
      },
      codeModeConfig: {
        enabled: true,
        exclusive: false,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 60_000,
        ladderValidation: "warn",
        etagCaching: false,
      },
    });
    client = await connect(server);
  });

  after(async () => {
    await client?.close();
    await server?.stop();
    await closeLadybugDb();
    if (previousEnv.config === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousEnv.config;
    if (previousEnv.graphDb === undefined) delete process.env.SDL_GRAPH_DB_PATH;
    else process.env.SDL_GRAPH_DB_PATH = previousEnv.graphDb;
    if (previousEnv.graphDir === undefined) delete process.env.SDL_GRAPH_DB_DIR;
    else process.env.SDL_GRAPH_DB_DIR = previousEnv.graphDir;
    if (previousEnv.db === undefined) delete process.env.SDL_DB_PATH;
    else process.env.SDL_DB_PATH = previousEnv.db;
    if (previousEnv.native === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = previousEnv.native;
    }
    invalidateConfigCache();
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  it("fails every central public graph route closed before handler dispatch", async () => {
    for (const call of centralCalls("unknown")) {
      const response = (await client.callTool(call)) as ErrorEnvelope;
      assertUnavailable(response, `${call.name}:${String(call.arguments.action ?? call.arguments.op ?? "flat")}`);
    }
  });

  it("preserves handler-owned NOT_FOUND responses for unregistered repositories", async () => {
    const repoId = "unregistered";
    for (const call of [
      {
        name: "sdl.symbol.search",
        arguments: { repoId, query: "alpha", semantic: false },
      },
      {
        name: "sdl.query",
        arguments: { repoId, action: "symbol.search", query: "alpha" },
      },
    ]) {
      const response = (await client.callTool(call)) as ErrorEnvelope;
      assertRepositoryNotFound(response, repoId, call.name);
    }
  });

  it("keeps a registered repository without a Version failed closed", async () => {
    const response = (await client.callTool({
      name: "sdl.symbol.search",
      arguments: { repoId: "empty", query: "alpha", semantic: false },
    })) as ErrorEnvelope;
    assertUnavailable(response, "registered repository without Version");
  });

  it("fails a revisioned legacy graph without manifest ownership closed", async () => {
    const response = (await client.callTool({
      name: "sdl.symbol.search",
      arguments: {
        repoId: "missing-manifest",
        query: "alpha",
        semantic: false,
      },
    })) as ErrorEnvelope;
    assertUnavailable(response, "missing manifest marker");

    const { handleRepoStatus } = await import("../../dist/mcp/tools/repo.js");
    const status = await handleRepoStatus({
      repoId: "missing-manifest",
      detail: "minimal",
    });
    assert.match(
      status.derivedState?.nextBestAction ?? "",
      /--safe-rebuild <absolute-new-path>/i,
    );
    assert.match(status.derivedState?.nextBestAction ?? "", /unverified/i);
    assert.doesNotMatch(
      status.derivedState?.nextBestAction ?? "",
      /another graph version/i,
    );
  });

  it("admits a verified graph with a valid empty manifest", async () => {
    const response = (await client.callTool({
      name: "sdl.symbol.search",
      arguments: {
        repoId: "empty-manifest",
        query: "alpha",
        semantic: false,
      },
    })) as ErrorEnvelope;
    assert.notEqual(response.isError, true);
    assertNoAdmissionFields(response, "valid empty manifest");
  });

  it("dry-runs graph and refresh workflows without DB or refresh admission", async (t) => {
    const originalExecute = Connection.prototype.execute;
    let dbExecutions = 0;
    const observedDryRuns: Array<{
      results?: unknown[];
      dryRun?: {
        valid?: boolean;
        validation?: Array<{
          fn?: string;
          action?: string;
          valid?: boolean;
          issues?: string[];
          pendingSchemaValidation?: boolean;
        }>;
      };
    }> = [];
    server.registerPostDispatchHook(async (toolName, args, result) => {
      if (
        toolName === "sdl.workflow" &&
        typeof args === "object" &&
        args !== null &&
        (args as { dryRun?: unknown }).dryRun === true
      ) {
        observedDryRuns.push(result as (typeof observedDryRuns)[number]);
      }
    });
    t.mock.method(
      Connection.prototype,
      "execute",
      async function (prepared, params, progressCallback) {
        dbExecutions += 1;
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );
    const refreshRunsBefore =
      _getIndexRefreshAdmissionStatsForTesting().totalRuns;

    for (const repoId of ["empty", "unregistered"]) {
      const validResponse = (await client.callTool({
        name: "sdl.workflow",
        arguments: {
          repoId,
          dryRun: true,
          steps: [
            {
              fn: "symbolSearch",
              args: { repoId, query: "alpha", semantic: false },
            },
          ],
        },
      })) as { isError?: boolean; structuredContent?: { results?: unknown[] } };
      assert.notEqual(validResponse.isError, true, repoId);
      assert.deepEqual(validResponse.structuredContent?.results, [], repoId);
      const validDryRun = observedDryRuns.at(-1)?.dryRun;
      assert.equal(validDryRun?.valid, true, repoId);

      const invalidResponse = (await client.callTool({
        name: "sdl.workflow",
        arguments: {
          repoId,
          dryRun: true,
          onError: "continue",
          steps: [
            { fn: "symbolSearch", args: {} },
            {
              fn: "symbolGetCard",
              args: { symbolId: "$0.results.0.symbolId" },
            },
            { fn: "index.refresh", args: { mode: "full" } },
          ],
        },
      })) as { isError?: boolean; structuredContent?: { results?: unknown[] } };
      assert.notEqual(invalidResponse.isError, true, repoId);
      assert.deepEqual(invalidResponse.structuredContent?.results, [], repoId);
      const invalidDryRun = observedDryRuns.at(-1)?.dryRun;
      assert.equal(invalidDryRun?.valid, false, repoId);
      const validation = invalidDryRun?.validation;
      assert.equal(validation?.length, 3, repoId);
      assert.equal(validation?.[0]?.valid, false, repoId);
      assert.ok(validation?.[0]?.issues?.length, repoId);
      assert.equal(validation?.[1]?.pendingSchemaValidation, true, repoId);
      assert.equal(validation?.[2]?.action, "index.refresh", repoId);
    }

    assert.equal(observedDryRuns.length, 4);
    assert.equal(
      JSON.stringify(observedDryRuns[1]?.dryRun?.validation),
      JSON.stringify(observedDryRuns[3]?.dryRun?.validation),
      "dry-run schema and reference validation depends on repository state",
    );
    assert.equal(dbExecutions, 0, "dry-run workflow executed a DB-backed handler");
    assert.equal(
      _getIndexRefreshAdmissionStatsForTesting().totalRuns,
      refreshRunsBefore,
      "dry-run index refresh acquired public refresh admission",
    );
  });

  it("keeps handle-only slice refresh conditionally gated", async () => {
    for (const call of [
      {
        name: "sdl.slice.refresh",
        arguments: { sliceHandle: "unknown-refresh-handle" },
      },
      {
        name: "sdl.query",
        arguments: {
          repoId: "unknown",
          action: "slice.refresh",
          sliceHandle: "unknown-refresh-handle",
          knownVersion: "unknown:v1",
        },
      },
      {
        name: "sdl.workflow",
        arguments: {
          repoId: "unknown",
          steps: [
            {
              fn: "sliceRefresh",
              args: { sliceHandle: "unknown-refresh-handle" },
            },
          ],
        },
      },
    ]) {
      const response = (await client.callTool(call)) as ErrorEnvelope;
      if (call.name === "sdl.workflow") {
        assert.match(JSON.stringify(response), /INDEX_ERROR|Graph retrieval is unavailable/);
      } else {
        assertUnavailable(response, call.name);
      }
    }
  });

  it("rejects a centrally classified request without repoId before its handler", async () => {
    const isolated = new MCPServer();
    let dispatched = false;
    isolated.registerTool(
      "sdl.context",
      "Admission missing repo test",
      z.object({ taskText: z.string() }),
      async () => {
        dispatched = true;
        return { reached: true };
      },
    );
    const isolatedClient = await connect(isolated);
    try {
      const response = (await isolatedClient.callTool({
        name: "sdl.context",
        arguments: { taskText: "graph" },
      })) as ErrorEnvelope;
      assert.equal(response.isError, true, "missing repoId");
      assert.equal(response.structuredContent?.error?.code, "INDEX_ERROR", "missing repoId");
      assert.equal(
        response.structuredContent?.error?.message,
        "Graph retrieval requires an explicit repoId. Provide repoId.",
      );
      assert.equal(dispatched, false);
    } finally {
      await isolatedClient.close();
      await isolated.stop();
    }
  });

  it("holds one dispatch lease from central admission through handler completion", async (t) => {
    resetToolDispatchLimiter();
    for (let index = 0; index < 8; index += 1) {
      clearPreparedStatementCache(await getLadybugConn());
    }
    const statements = new WeakMap<object, string>();
    const admissionStarted = deferred();
    const releaseAdmission = deferred();
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    let blocked = false;
    let repoLookups = 0;

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
          statement?.includes("MATCH (r:Repo {repoId: $repoId})") &&
          statement.includes("RETURN r.repoId AS repoId")
        ) {
          repoLookups += 1;
        }
        if (
          !blocked &&
          statement?.includes("MATCH (v:Version)") &&
          statement.includes("VERSION_OF_REPO")
        ) {
          blocked = true;
          admissionStarted.resolve();
          await releaseAdmission.promise;
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    const call = client.callTool({
      name: "sdl.symbol.search",
      arguments: { repoId: "verified", query: "alpha", semantic: false },
    });
    await admissionStarted.promise;
    try {
      assert.equal(
        await waitForToolDispatchIdle({
          activeAllowance: 0,
          timeoutMs: 20,
          pollMs: 1,
          label: "public-admission-race-test",
        }),
        false,
      );
    } finally {
      releaseAdmission.resolve();
    }
    const response = (await call) as ErrorEnvelope;
    assert.notEqual(response.isError, true);
    assert.equal(repoLookups, 1, "normal admission added a Repo lookup");
  });

  it("keeps current verified, verifying, and failed manifests readable", async () => {
    for (const repoId of ["verified", "verifying", "failed"]) {
      const response = (await client.callTool({
        name: "sdl.symbol.search",
        arguments: { repoId, query: "alpha", semantic: false },
      })) as ErrorEnvelope;
      assert.notEqual(response.isError, true, repoId);
      assert.match(JSON.stringify(response), /alpha/, repoId);
    }
  });

  it("preserves successful handler payload serialization at the central boundary", async () => {
    const isolated = new MCPServer();
    const payload = {
      repoId: "verified",
      sentinel: ["unchanged", 1, true],
    };
    isolated.registerTool(
      "sdl.repo.overview",
      "Admission payload test",
      z.object({ repoId: z.string() }),
      async () => payload,
    );
    const isolatedClient = await connect(isolated);
    try {
      const response = (await isolatedClient.callTool({
        name: "sdl.repo.overview",
        arguments: { repoId: "verified" },
      })) as { structuredContent?: unknown };
      assert.equal(JSON.stringify(response.structuredContent), JSON.stringify(payload));
    } finally {
      await isolatedClient.close();
      await isolated.stop();
    }
  });

  it("keeps every centrally gated verified graph route byte-stable", async (t) => {
    t.mock.timers.enable({
      apis: ["Date"],
      now: new Date("2026-07-21T12:00:00.000Z"),
    });
    const repoId = "verified";
    const symbolId = `${repoId}:alpha`;
    const fromVersion = `${repoId}:v0`;
    const toVersion = `${repoId}:v1`;
    const calls: PublicCall[] = [
      {
        name: "sdl.symbol.search",
        arguments: { repoId, query: "alpha", semantic: false },
      },
      { name: "sdl.symbol.getCard", arguments: { repoId, symbolId, refsMode: "off" } },
      { name: "sdl.slice.build", arguments: { repoId, entrySymbols: [symbolId] } },
      {
        name: "sdl.slice.spillover.get",
        arguments: { repoId, spilloverHandle: `${repoId}-refresh-handle` },
      },
      { name: "sdl.delta.get", arguments: { repoId, fromVersion, toVersion } },
      {
        name: "sdl.pr.risk.analyze",
        arguments: { repoId, fromVersion, toVersion, preflight: true },
      },
      {
        name: "sdl.code.getSkeleton",
        arguments: { repoId, symbolId, refsMode: "off" },
      },
      {
        name: "sdl.code.getHotPath",
        arguments: { repoId, symbolId, identifiersToFind: ["alpha"] },
      },
      {
        name: "sdl.code.needWindow",
        arguments: {
          repoId,
          symbolId,
          reason: "Inspect alpha",
          expectedLines: 20,
          identifiersToFind: ["alpha"],
        },
      },
      { name: "sdl.repo.overview", arguments: { repoId, level: "stats" } },
      {
        name: "sdl.context",
        arguments: {
          repoId,
          taskType: "explain",
          taskText: "Explain alpha",
          refsMode: "off",
          responseMode: "inline",
          options: { contextMode: "precise" },
        },
      },
      ...[
        ["symbolSearch", { query: "alpha", semantic: false }],
        ["symbolGetCard", { symbolId, refsMode: "off" }],
        ["sliceBuild", { entrySymbols: [symbolId] }],
        ["codeSkeleton", { symbolId, refsMode: "off" }],
        ["codeHotPath", { symbolId, identifiersToFind: ["alpha"] }],
        [
          "codeNeedWindow",
          {
            symbolId,
            reason: "Inspect alpha",
            expectedLines: 20,
            identifiersToFind: ["alpha"],
          },
        ],
      ].map(([op, args]) => ({
        name: "sdl.retrieve",
        arguments: { repoId, op, args },
      })) as PublicCall[],
      {
        name: "sdl.query",
        arguments: { repoId, action: "symbol.search", query: "alpha" },
      },
      {
        name: "sdl.query",
        arguments: { repoId, action: "symbol.getCard", symbolId },
      },
      {
        name: "sdl.query",
        arguments: { repoId, action: "slice.build", entrySymbols: [symbolId] },
      },
      {
        name: "sdl.query",
        arguments: {
          repoId,
          action: "slice.spillover.get",
          spilloverHandle: `${repoId}-refresh-handle`,
        },
      },
      {
        name: "sdl.query",
        arguments: { repoId, action: "delta.get", fromVersion, toVersion },
      },
      {
        name: "sdl.query",
        arguments: {
          repoId,
          action: "pr.risk.analyze",
          fromVersion,
          toVersion,
        },
      },
      {
        name: "sdl.code",
        arguments: { repoId, action: "code.getSkeleton", symbolId },
      },
      {
        name: "sdl.code",
        arguments: {
          repoId,
          action: "code.getHotPath",
          symbolId,
          identifiersToFind: ["alpha"],
        },
      },
      {
        name: "sdl.code",
        arguments: {
          repoId,
          action: "code.needWindow",
          symbolId,
          reason: "Inspect alpha",
          expectedLines: 20,
          identifiersToFind: ["alpha"],
        },
      },
      {
        name: "sdl.repo",
        arguments: { repoId, action: "repo.overview", level: "stats" },
      },
      {
        name: "sdl.workflow",
        arguments: {
          repoId,
          steps: [{ fn: "symbolSearch", args: { query: "alpha" } }],
        },
      },
      {
        name: "sdl.workflow",
        arguments: {
          repoId,
          steps: [{ fn: "symbolGetCard", args: { symbolId } }],
        },
      },
      {
        name: "sdl.workflow",
        arguments: {
          repoId,
          steps: [{ fn: "sliceBuild", args: { entrySymbols: [symbolId] } }],
        },
      },
      {
        name: "sdl.workflow",
        arguments: {
          repoId,
          steps: [
            {
              fn: "sliceSpilloverGet",
              args: { spilloverHandle: `${repoId}-refresh-handle` },
            },
          ],
        },
      },
      {
        name: "sdl.workflow",
        arguments: {
          repoId,
          steps: [{ fn: "deltaGet", args: { fromVersion, toVersion } }],
        },
      },
      {
        name: "sdl.workflow",
        arguments: {
          repoId,
          steps: [
            { fn: "prRiskAnalyze", args: { fromVersion, toVersion } },
          ],
        },
      },
      {
        name: "sdl.workflow",
        arguments: {
          repoId,
          steps: [{ fn: "codeSkeleton", args: { symbolId } }],
        },
      },
      {
        name: "sdl.workflow",
        arguments: {
          repoId,
          steps: [
            {
              fn: "codeHotPath",
              args: { symbolId, identifiersToFind: ["alpha"] },
            },
          ],
        },
      },
      {
        name: "sdl.workflow",
        arguments: {
          repoId,
          steps: [
            {
              fn: "codeNeedWindow",
              args: {
                symbolId,
                reason: "Inspect alpha",
                expectedLines: 20,
                identifiersToFind: ["alpha"],
              },
            },
          ],
        },
      },
      {
        name: "sdl.workflow",
        arguments: {
          repoId,
          steps: [{ fn: "repoOverview", args: { level: "stats" } }],
        },
      },
    ];

    for (const call of calls) {
      const first = (await client.callTool(call)) as ErrorEnvelope;
      const second = (await client.callTool(call)) as ErrorEnvelope;
      const label = `${call.name}:${String(
        call.arguments.action
          ?? call.arguments.op
          ?? (Array.isArray(call.arguments.steps)
            ? (call.arguments.steps[0] as { fn?: unknown } | undefined)?.fn
            : "flat"),
      )}`;
      assert.notEqual(
        first.isError,
        true,
        `${label} ${JSON.stringify(first.structuredContent)}`,
      );
      assertNoAdmissionFields(first, label);
      assertNoAdmissionFields(second, label);
      if (isSliceBuildCall(call)) {
        assert.notEqual(
          [...findSliceHandles(second)][0],
          [...findSliceHandles(first)][0],
          `${label}: random handle exception remains explicit`,
        );
        assert.equal(
          serializeWithStableSliceHandle(second, label),
          serializeWithStableSliceHandle(first, label),
          label,
        );
      } else {
        assert.equal(JSON.stringify(second), JSON.stringify(first), label);
      }
      if (call.name === "sdl.workflow") {
        assertWorkflowSucceeded(first, label);
        assertWorkflowSucceeded(second, label);
      }
    }
  });

  it("allows handle-only slice refresh for a verified current manifest", async (t) => {
    t.mock.timers.enable({
      apis: ["Date"],
      now: new Date("2026-07-21T12:00:00.000Z"),
    });
    for (const call of [
      {
        name: "sdl.slice.refresh",
        arguments: { sliceHandle: "verified-refresh-handle" },
      },
      {
        name: "sdl.query",
        arguments: {
          repoId: "verified",
          action: "slice.refresh",
          sliceHandle: "verified-refresh-handle",
          knownVersion: "verified:v1",
        },
      },
      {
        name: "sdl.workflow",
        arguments: {
          repoId: "verified",
          steps: [
            {
              fn: "sliceRefresh",
              args: { sliceHandle: "verified-refresh-handle" },
            },
          ],
        },
      },
    ]) {
      const first = await client.callTool(call);
      const second = await client.callTool(call);
      assert.equal(JSON.stringify(second), JSON.stringify(first), call.name);
      if (call.name === "sdl.workflow") {
        assertWorkflowSucceeded(first, call.name);
        assertWorkflowSucceeded(second, call.name);
      }
    }
  });

  it("keeps real file-window envelopes byte-stable", async (t) => {
    t.mock.timers.enable({
      apis: ["Date"],
      now: new Date("2026-07-21T12:00:00.000Z"),
    });
    const preview = (await client.callTool({
      name: "sdl.file",
      arguments: {
        op: "searchEditPreview",
        repoId: "verified",
        targeting: "text",
        query: { literal: "return 1", replacement: "return 2" },
        editMode: "replacePattern",
        filters: { include: ["src/alpha.ts"] },
      },
    })) as {
      isError?: boolean;
      structuredContent?: { planHandle?: string };
    };
    assert.notEqual(preview.isError, true, JSON.stringify(preview.structuredContent));
    const planHandle = preview.structuredContent?.planHandle;
    assert.ok(planHandle);

    for (const op of ["previewWindow", "sourceWindow"]) {
      const call = {
        name: "sdl.file",
        arguments: {
          op,
          repoId: "verified",
          planHandle,
          symbolId: "verified:alpha",
          reason: "Inspect planned alpha edit",
          expectedLines: 20,
          identifiersToFind: ["alpha"],
        },
      };
      const first = (await client.callTool(call)) as ErrorEnvelope;
      const second = (await client.callTool(call)) as ErrorEnvelope;
      assert.notEqual(
        first.isError,
        true,
        `${op}:${JSON.stringify(first.structuredContent)}`,
      );
      assert.equal(JSON.stringify(second), JSON.stringify(first), op);
    }
  });

  it("does not gate an excluded raw file read", async () => {
    const response = (await client.callTool({
      name: "sdl.file",
      arguments: { op: "read", repoId: "unknown", filePath: "notes.txt" },
    })) as ErrorEnvelope;
    assert.notEqual(response.structuredContent?.error?.code, "INDEX_ERROR");
    assert.equal(response.isError, undefined);
  });
});
