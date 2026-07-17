import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { NotFoundError } from "../../dist/domain/errors.js";
import { clearAllCaches } from "../../dist/graph/cache.js";
import { clearSnapshotCache } from "../../dist/live-index/overlay-reader.js";
import { handleSymbolGetCard } from "../../dist/mcp/tools/symbol.js";
import { createMCPServer, type MCPServer } from "../../dist/server.js";

const TEST_ROOT = join(
  tmpdir(),
  `sdl-card-error-envelope-${process.pid}-${randomUUID()}`,
);
const TEST_DB_PATH = join(TEST_ROOT, "graph.lbug");
const CONFIG_PATH = join(TEST_ROOT, "sdl.config.json");
const REPO_ID = "card-error-envelope-repo";

interface ErrorEnvelope {
  isError?: boolean;
  structuredContent?: {
    error?: {
      message?: string;
      code?: string;
      classification?: string;
      retryable?: boolean;
      fallbackTools?: string[];
      fallbackRationale?: string;
    };
  };
}

async function connect(server: MCPServer): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "symbol-card-error-envelope-test",
    version: "1.0.0",
  });
  await server.getServer().connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("missing symbol-card MCP error envelope", () => {
  let server: MCPServer;
  let client: Client;
  const previousEnv = {
    config: process.env.SDL_CONFIG,
    graphDb: process.env.SDL_GRAPH_DB_PATH,
    db: process.env.SDL_DB_PATH,
    native: process.env.SDL_MCP_DISABLE_NATIVE_ADDON,
  };

  before(async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        repos: [],
        policy: {},
        graphDatabase: { path: TEST_DB_PATH },
        liveIndex: { enabled: false },
        prefetch: { enabled: false },
        memory: { enabled: false },
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = CONFIG_PATH;
    process.env.SDL_GRAPH_DB_PATH = TEST_DB_PATH;
    process.env.SDL_DB_PATH = TEST_DB_PATH;
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    invalidateConfigCache();

    clearAllCaches();
    clearSnapshotCache();
    await closeLadybugDb();
    await initLadybugDb(TEST_DB_PATH);
    const conn = await getLadybugConn();
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: TEST_ROOT,
      configJson: JSON.stringify({ policy: {} }),
      createdAt: "2026-07-17T12:00:00.000Z",
    });

    server = await createMCPServer({
      gatewayConfig: { enabled: false, emitLegacyTools: true },
    });
    client = await connect(server);
  });

  after(async () => {
    await client?.close();
    await server?.stop();
    clearAllCaches();
    clearSnapshotCache();
    await closeLadybugDb();
    invalidateConfigCache();
    if (previousEnv.config === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousEnv.config;
    if (previousEnv.graphDb === undefined) delete process.env.SDL_GRAPH_DB_PATH;
    else process.env.SDL_GRAPH_DB_PATH = previousEnv.graphDb;
    if (previousEnv.db === undefined) delete process.env.SDL_DB_PATH;
    else process.env.SDL_DB_PATH = previousEnv.db;
    if (previousEnv.native === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = previousEnv.native;
    }
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  it("preserves NotFoundError through the handler without rewrapping", async () => {
    await assert.rejects(
      () =>
        handleSymbolGetCard({
          repoId: REPO_ID,
          symbolId: "missing-symbol",
        }),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError);
        assert.equal(error.code, "NOT_FOUND");
        return true;
      },
    );
  });

  it("returns the classified search-guided error from the real MCP server", async () => {
    const response = (await client.callTool({
      name: "sdl.symbol.getCard",
      arguments: {
        repoId: REPO_ID,
        symbolId: "missing-symbol",
      },
    })) as ErrorEnvelope;

    assert.equal(response.isError, true);
    const error = response.structuredContent?.error;
    assert.equal(error?.message, "Symbol not found: missing-symbol");
    assert.equal(error?.code, "NOT_FOUND");
    assert.equal(error?.classification, "not_found");
    assert.equal(error?.retryable, false);
    assert.deepEqual(error?.fallbackTools, [
      "sdl.symbol.search",
      "sdl.action.search",
    ]);
    assert.equal(
      error?.fallbackRationale,
      "Use sdl.symbol.search to discover the canonical symbol identifier.",
    );
  });
});
