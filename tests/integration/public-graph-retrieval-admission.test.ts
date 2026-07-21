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
import { z } from "zod";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  closeLadybugDb,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import { withTransaction } from "../../dist/db/ladybug-core.js";
import * as derivedState from "../../dist/db/ladybug-derived-state.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  createGraphIntegrityExpectationFromManifest,
  createGraphIntegrityFileState,
} from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
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
    /Run sdl\.index\.refresh with mode:"full"/,
    label,
  );
  assert.doesNotMatch(
    response.structuredContent?.error?.message ?? "",
    /[A-Z]:\\|\.lbug|revision \d/i,
    label,
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
      assertUnavailable(response, "missing repoId");
      assert.equal(dispatched, false);
    } finally {
      await isolatedClient.close();
      await isolated.stop();
    }
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

  it("allows every public graph family for a verified current manifest", async () => {
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
        arguments: { repoId, action: "code.getSkeleton", symbolId },
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
          steps: [{ fn: "sliceBuild", args: { entrySymbols: [symbolId] } }],
        },
      },
    ];

    for (const call of calls) {
      const response = (await client.callTool(call)) as ErrorEnvelope;
      assert.notEqual(
        response.isError,
        true,
        `${call.name}:${String(call.arguments.action ?? call.arguments.op ?? "flat")} ${JSON.stringify(response.structuredContent)}`,
      );
    }
  });

  it("keeps verified symbol and slice payloads byte-stable", async () => {
    for (const call of [
      {
        name: "sdl.symbol.search",
        arguments: {
          repoId: "verified",
          query: "alpha",
          semantic: false,
          wireFormat: "json",
        },
      },
      {
        name: "sdl.slice.spillover.get",
        arguments: {
          repoId: "verified",
          spilloverHandle: "verified-refresh-handle",
        },
      },
    ]) {
      const first = await client.callTool(call);
      const second = await client.callTool(call);
      assert.equal(JSON.stringify(second), JSON.stringify(first), call.name);
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
    }
  });

  it("gates real file windows but leaves their preview mutation route available", async () => {
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
      const response = (await client.callTool({
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
      })) as ErrorEnvelope;
      assert.notEqual(response.isError, true, `${op}:${JSON.stringify(response.structuredContent)}`);
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
